/**
 * Tests for `src/server.ts`: snapshot shape, auth/CSRF/host rules, settings
 * validation, actions, history, login flow and SSE — mostly through direct
 * `handleRequest` calls, plus one live-server pass for SSE and static files.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwaitableValue } from "./async.ts";
import { History } from "./history.ts";
import { Channel, DropsCampaign } from "./models.ts";
import { DashboardServer, campaignJson, channelJson, dropJson, isBlockedUrl, shouldRecoverFromStall, type ServerEngine } from "./server.ts";
import { Settings } from "./settings.ts";
import { Stats } from "./stats.ts";
import { EngineState } from "./twitchProtocol.ts";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

const MODEL_ENGINE = {
  settings: { available_drops_check: false, enable_badges_emotes: false },
  gui: {
    channels: { display: () => {}, remove: () => {} },
    inv: { updateDrop: () => {} },
    displayDrop: () => {},
    notifier: { notify: () => {}, set_activity: () => {} },
    clearDrop: () => {},
  },
} as never;

function dropData(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Drop ${id}`,
    benefitEdges: [{ benefit: { id: `${id}-b`, name: `Reward ${id}`, distributionType: "DIRECT_ENTITLEMENT", imageAssetURL: "https://img.test/a.png" } }],
    startAt: iso(-HOUR),
    endAt: iso(DAY),
    requiredMinutesWatched: 60,
    preconditionDrops: [],
    self: { dropInstanceID: `${id}-claim`, isClaimed: false, currentMinutesWatched: 38 },
    ...overrides,
  };
}

function campaignData(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Campaign ${id}`,
    game: { id: "10", displayName: "Game", name: "Game", boxArtURL: "https://cdn.test/g-285x380.jpg" },
    self: { isAccountConnected: true },
    accountLinkURL: "https://twitch.tv/settings/connections",
    startAt: iso(-HOUR),
    endAt: iso(DAY),
    status: "ACTIVE",
    allow: { channels: null, isEnabled: true },
    timeBasedDrops: [dropData(`${id}-d1`)],
    ...overrides,
  };
}

function makeCampaign(id = "c1"): DropsCampaign {
  return new DropsCampaign(MODEL_ENGINE, campaignData(id) as never, new Map());
}

function makeChannel(id = 1, login = "streamer"): Channel {
  return Channel.fromDirectory(MODEL_ENGINE, {
    broadcaster: { id, login },
    id: `b${id}`,
    game: { id: "10", displayName: "Game" },
    viewersCount: 12,
    title: "Live",
  }, true);
}

interface Harness {
  server: DashboardServer;
  engine: ServerEngine & {
    states: EngineState[];
    paused: boolean;
    authUser: number | undefined;
    invalidated: boolean;
  };
  settings: Settings;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "tdm-server-"));
  const settings = new Settings(join(dir, "settings.json"), { dump: false, log: false });
  const server = new DashboardServer({ dataDir: dir, settings, host: "127.0.0.1", port: 0, openBrowser: false });
  const states: EngineState[] = [];
  const watching = new AwaitableValue<Channel>();
  let authUser: number | undefined;
  let invalidated = false;
  const engine = {
    states,
    paused: false,
    get authUser() {
      return authUser;
    },
    set authUser(value: number | undefined) {
      authUser = value;
    },
    get invalidated() {
      return invalidated;
    },
    wantedGames: [],
    inventory: [] as DropsCampaign[],
    channels: new Map<number, Channel>(),
    watchingChannel: watching,
    getActiveCampaign: () => null,
    canWatch: () => false,
    settings,
    stats: new Stats(join(dir, "stats.json")),
    lastConfirmedProgressAt: null as number | null,
    secondsWithoutProgress: () => null as number | null,
    history: null as History | null,
    auth: {
      get userId() {
        return authUser;
      },
      invalidate: (deleteCookies: boolean) => {
        void deleteCookies;
        invalidated = true;
        authUser = undefined;
      },
    },
    changeState: (state: EngineState) => void states.push(state),
    pause: () => {},
    resume: () => {},
    websocketSockets: [] as Array<{ connected: boolean }>,
  };
  server.attachEngine(engine);
  return { server, engine: engine as Harness["engine"], settings };
}

const get = (server: DashboardServer, path: string, headers: Record<string, string> = {}): Promise<Response> =>
  server.handleRequest(new Request(`http://127.0.0.1${path}`, { headers }));

async function csrfToken(server: DashboardServer): Promise<string> {
  const response = await get(server, "/api/csrf");
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

const write = (server: DashboardServer, path: string, method: string, body: unknown, token: string): Promise<Response> =>
  server.handleRequest(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

describe("snapshot builders", () => {
  test("drop/campaign/channel JSON mirrors webui.py shapes", () => {
    const campaign = makeCampaign();
    const drop = campaign.getDrop("c1-d1")!;
    drop.realCurrentMinutes = 38;
    const dropPayload = dropJson(drop);
    expect(dropPayload).toMatchObject({
      id: "c1-d1",
      rewards: "Reward c1-d1",
      claimed: false,
      claimable: true,
      currentMinutes: 38,
      requiredMinutes: 60,
      remainingMinutes: 22,
      benefits: [{ name: "Reward c1-d1", type: "DIRECT_ENTITLEMENT", image: "https://img.test/a.png" }],
    });
    expect(dropPayload.progress).toBeCloseTo(0.6333, 4);
    const campaignPayload = campaignJson(campaign);
    expect(campaignPayload).toMatchObject({ id: "c1", game: "Game", gameId: "10", status: "active", linked: true, eligible: true, finished: false });
    const channel = makeChannel();
    const channelPayload = channelJson(channel, 1, true);
    expect(channelPayload).toMatchObject({ id: 1, name: "streamer", login: "streamer", online: true, watching: true, watchable: true, game: "Game", viewers: 12 });
  });

  test("campaign status mapping covers all states", () => {
    expect(campaignJson(makeCampaign()).status).toBe("active");
    const upcoming = new DropsCampaign(MODEL_ENGINE, campaignData("u", { startAt: iso(HOUR), endAt: iso(DAY) }) as never, new Map());
    expect(campaignJson(upcoming).status).toBe("upcoming");
    const expired = new DropsCampaign(MODEL_ENGINE, campaignData("e", { startAt: iso(-2 * DAY), endAt: iso(-HOUR) }) as never, new Map());
    expect(campaignJson(expired).status).toBe("expired");
  });
});

describe("isBlockedUrl", () => {
  test("blocks private/loopback/link-local/metadata for webhooks, allows loopback proxies", () => {
    expect(isBlockedUrl(new URL("https://hooks.example/x"))).toBe(false);
    for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.9.9", "169.254.169.254", "0.0.0.0", "224.0.0.1", "svc.internal", "box.local", "::1", "fe80::1", "fc00::7", "ff02::1"]) {
      const authority = host.includes(":") ? `[${host}]` : host;
      expect(isBlockedUrl(new URL(`https://${authority}/x`))).toBe(true);
    }
    expect(isBlockedUrl(new URL("http://127.0.0.1:3128"), true)).toBe(false);
    expect(isBlockedUrl(new URL("http://localhost:3128"), true)).toBe(false);
    expect(isBlockedUrl(new URL("http://localhost:3128"), false)).toBe(true);
    expect(isBlockedUrl(new URL("https://8.8.8.8/x"))).toBe(false);
  });
});

describe("shouldRecoverFromStall", () => {
  test("fires only after 15 stalled minutes outside cooldown", () => {
    expect(shouldRecoverFromStall(null, 9999)).toBe(false);
    expect(shouldRecoverFromStall(899, 9999)).toBe(false);
    expect(shouldRecoverFromStall(901, 100)).toBe(false);
    expect(shouldRecoverFromStall(901, 901)).toBe(true);
  });
});

describe("dashboard snapshot", () => {
  test("empty engine produces the full contract", () => {
    const { server } = makeHarness();
    const snapshot = server.snapshot();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.campaigns).toEqual([]);
    expect(snapshot.channels).toEqual([]);
    expect(snapshot.networkIssues).toEqual([]);
    expect(snapshot.summary).toEqual({ campaigns: 0, activeCampaigns: 0, completedCampaigns: 0, onlineChannels: 0 });
    expect(snapshot.system.authenticationEnabled).toBe(false);
    expect(snapshot.settings.priority).toEqual([]);
  });

  test("campaigns, channels and summary reflect engine state", () => {
    const { server, engine } = makeHarness();
    const campaign = makeCampaign();
    engine.inventory.push(campaign);
    const channel = makeChannel();
    engine.channels.set(channel.id, channel);
    engine.canWatch = () => true;
    const snapshot = server.snapshot();
    expect(snapshot.campaigns).toHaveLength(1);
    expect(snapshot.channels).toHaveLength(1);
    expect(snapshot.summary).toMatchObject({ campaigns: 1, activeCampaigns: 1, onlineChannels: 1 });
    server.displayDrop(campaign.getDrop("c1-d1") ?? null);
    expect(server.snapshot().activeDrop?.id).toBe("c1-d1");
  });
});

describe("auth, CSRF and host rules", () => {
  test("unknown hosts are rejected everywhere", async () => {
    const { server } = makeHarness();
    const response = await server.handleRequest(new Request("http://evil.example/"));
    expect(response.status).toBe(403);
  });

  test("writes require a CSRF token", async () => {
    const { server, engine } = makeHarness();
    expect((await write(server, "/api/actions/pause", "POST", {}, "")).status).toBe(403);
    const token = await csrfToken(server);
    expect((await write(server, "/api/actions/pause", "POST", {}, token)).status).toBe(200);
  });

  test("foreign origins are rejected on writes", async () => {
    const { server } = makeHarness();
    const token = await csrfToken(server);
    const response = await server.handleRequest(
      new Request("http://127.0.0.1/api/actions/pause", {
        method: "POST",
        headers: { "X-CSRF-Token": token, Origin: "https://other.example" },
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe("actions and settings", () => {
  test("unknown actions 404, known actions dispatch", async () => {
    const { server, engine } = makeHarness();
    const token = await csrfToken(server);
    expect((await write(server, "/api/actions/nope", "POST", {}, token)).status).toBe(404);
    for (const [action, state] of [["reload", EngineState.INVENTORY_FETCH], ["restart", EngineState.RESTART]] as const) {
      expect((await write(server, `/api/actions/${action}`, "POST", {}, token)).status).toBe(200);
      expect(engine.states.at(-1)).toBe(state);
    }
  });

  test("logout resets login, rotates CSRF and restarts", async () => {
    const { server, engine } = makeHarness();
    engine.authUser = 42;
    const oldToken = await csrfToken(server);
    expect((await write(server, "/api/actions/logout", "POST", {}, oldToken)).status).toBe(200);
    expect(engine.invalidated).toBe(true);
    expect(server.snapshot().login.userId).toBeNull();
    expect((await write(server, "/api/actions/pause", "POST", {}, oldToken)).status).toBe(403);
    expect(engine.states.at(-1)).toBe(EngineState.RESTART);
  });

  test("settings validation mirrors webui.py", async () => {
    const { server, settings } = makeHarness();
    const token = await csrfToken(server);
    expect((await write(server, "/api/settings", "PUT", { priorityMode: "NOPE" }, token)).status).toBe(400);
    expect((await write(server, "/api/settings", "PUT", { connectionQuality: 99 }, token)).status).toBe(400);
    expect((await write(server, "/api/settings", "PUT", { proxy: "http://localhost" }, token)).status).toBe(400);
    expect((await write(server, "/api/settings", "PUT", { webhookUrl: "http://169.254.169.254/hook" }, token)).status).toBe(400);
    expect((await write(server, "/api/settings", "PUT", { proxy: "http://127.0.0.1:3128", priority: ["Game"] }, token)).status).toBe(200);
    expect(settings.proxy).toBe("http://127.0.0.1:3128");
    expect(settings.priority).toEqual(["Game"]);
    expect((await write(server, "/api/settings", "PUT", "nope", token)).status).toBe(400);
  });

  test("channel switching validates eligibility", async () => {
    const { server, engine } = makeHarness();
    const token = await csrfToken(server);
    expect((await write(server, "/api/channels/abc", "POST", {}, token)).status).toBe(400);
    expect((await write(server, "/api/channels/9", "POST", {}, token)).status).toBe(404);
    engine.channels.set(1, makeChannel());
    expect((await write(server, "/api/channels/1", "POST", {}, token)).status).toBe(409);
    engine.canWatch = () => true;
    expect((await write(server, "/api/channels/1", "POST", {}, token)).status).toBe(200);
    expect(engine.states.at(-1)).toBe(EngineState.CHANNEL_SWITCH);
  });
});

describe("operational endpoints", () => {
  test("health, readiness, metrics and diagnostics", async () => {
    const { server, engine } = makeHarness();
    expect(((await (await get(server, "/healthz")).json()) as { status: string }).status).toBe("ok");
    expect((await get(server, "/readyz")).status).toBe(503);
    engine.authUser = 5;
    engine.websocketSockets.push({ connected: true });
    expect((await get(server, "/readyz")).status).toBe(200);
    const metrics = await (await get(server, "/metrics")).text();
    expect(metrics).toContain("tdm_uptime_seconds");
    const diagnostics = (await (await get(server, "/api/diagnostics")).json()) as Record<string, unknown>;
    expect(Object.keys(diagnostics).sort()).toEqual(["activity", "networkIssues", "stats", "status", "system", "websockets"]);
  });

  test("export redacts secrets, import round-trips", async () => {
    const { server } = makeHarness();
    const token = await csrfToken(server);
    await write(server, "/api/settings", "PUT", { proxy: "http://127.0.0.1:3128", webhookUrl: "https://hooks.example/x" }, token);
    const exported = (await (await get(server, "/api/export?stats=1")).json()) as { settings: Record<string, unknown>; stats: unknown };
    expect(exported.settings["proxy"]).toBe("");
    expect(exported.settings["webhookUrl"]).toBe("");
    expect(exported.stats).toBeDefined();
    expect((await write(server, "/api/import", "POST", { settings: { priority: ["Game"] } }, token)).status).toBe(200);
    expect(server.snapshot().settings.priority).toEqual(["Game"]);
  });

  test("history scoping and errors match webui.py", async () => {
    const { server, engine } = makeHarness();
    expect((await get(server, "/api/history")).status).toBe(409);
    engine.authUser = 5;
    expect((await get(server, "/api/history")).status).toBe(503);
    const dir = mkdtempSync(join(tmpdir(), "tdm-hist-"));
    const history = new History(join(dir, "history.sqlite3"));
    engine.history = history;
    history.ingestInventory("5", [{ id: "r1", name: "Hat" }]);
    const result = (await (await get(server, "/api/history")).json()) as { total: number; summary: { rewardCount: number } };
    expect(result.total).toBe(1);
    expect(result.summary.rewardCount).toBe(1);
    expect((await get(server, "/api/history?offset=nope")).status).toBe(400);
    history.close();
  });

  test("login submit resolves the pending dashboard login", async () => {
    const { server } = makeHarness();
    const token = await csrfToken(server);
    expect((await write(server, "/api/login", "POST", { username: "u" }, token)).status).toBe(409);
    const pending = server.login.askLogin();
    expect((await write(server, "/api/login", "POST", { username: "u", password: "p", token: "t" }, token)).status).toBe(200);
    await expect(pending).resolves.toEqual({ username: "u", password: "p", token: "t" });
  });
});

describe("live server", () => {
  test("serves static files and streams SSE snapshots", async () => {
    const { server } = makeHarness();
    server.start();
    try {
      const port = server.boundPort!;
      const app = await (await fetch(`http://127.0.0.1:${port}/assets/app.js`)).text();
      expect(app).toContain("renderRoute");
      const index = await (await fetch(`http://127.0.0.1:${port}/campaigns/abc`)).text();
      expect(index).toContain('id="app-shell"');
      const events = await fetch(`http://127.0.0.1:${port}/api/events`);
      const reader = events.body!.getReader();
      const first = await reader.read();
      const text = new TextDecoder().decode(first.value);
      expect(text.startsWith("data:")).toBe(true);
      expect((JSON.parse(text.slice("data:".length)) as { revision: number }).revision).toBe(0);
      await reader.cancel();
    } finally {
      server.stop();
    }
  });
});
