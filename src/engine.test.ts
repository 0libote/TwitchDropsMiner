/**
 * Tests for `src/engine.ts` (+ `auth.ts`, `cookies.ts`, `http.ts`) with a
 * scripted fetch transport and a fake dashboard. No live Twitch involved.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar } from "./cookies.ts";
import { Twitch, type TwitchGui } from "./engine.ts";
import { CaptchaRequired, ExitRequest, LoginException } from "./errors.ts";
import type { FetchImpl } from "./http.ts";
import { Settings } from "./settings.ts";
import { CLIENT_TYPES, EngineState } from "./twitchProtocol.ts";
import { Channel, DropsCampaign } from "./models.ts";
import { Game } from "./utils.ts";

const ANDROID_ID = CLIENT_TYPES.ANDROID_APP.clientId;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

interface Route {
  method: string;
  url: string;
  status: number;
  body: unknown;
  setCookies?: string[];
}

class FakeTransport {
  routes: Route[] = [];
  calls: Array<{ method: string; url: string; body?: string }> = [];
  failures = 0;

  on(method: string, url: string, status: number, body: unknown, setCookies?: string[]): this {
    this.routes.push({ method, url, status, body, setCookies });
    return this;
  }

  failWith(method: string, url: string): this {
    this.routes.push({ method, url, status: -1, body: null });
    return this;
  }

  fetch: FetchImpl = async (url, init) => (this.handler ?? this.baseFetch)(url, init);

  baseFetch: FetchImpl = async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const bodyText = typeof init.body === "string" ? init.body : undefined;
    this.calls.push({ method, url, body: bodyText });
    const route = this.routes.find((r) => r.method === method && r.url === url);
    if (!route) throw new Error(`Unexpected fetch: ${method} ${url}`);
    if (route.status === -1) {
      this.failures += 1;
      throw new TypeError("fetch failed");
    }
    const headers = new Headers({ "content-type": "application/json" });
    for (const cookie of route.setCookies ?? []) headers.append("set-cookie", cookie);
    const text = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(text, { status: route.status, headers });
  };

  handler: FetchImpl | null = null;
}

interface GuiState {
  status: string[];
  printed: string[];
  issues: string[];
  recoveries: string[];
  loginUpdates: Array<{ status: string; userId: number | null }>;
  codes: Array<{ url: string; code: string }>;
  logins: Array<{ username: string; password: string; token: string }>;
  helpStates: string[];
  closed: boolean;
}

function makeGui(loginAnswers: Array<{ username: string; password: string; token: string }> = []): TwitchGui & { state: GuiState } {
  const state: GuiState = { status: [], printed: [], issues: [], recoveries: [], loginUpdates: [], codes: [], logins: [], helpStates: [], closed: false };
  const gui = {
    state,
    status: { update: (t: string) => void state.status.push(t), clear: () => {} },
    login: {
      askEnterCode: async (url: string, code: string) => void state.codes.push({ url, code }),
      askLogin: async () => {
        if (loginAnswers.length === 0) throw new Error("No scripted login left");
        return loginAnswers.shift()!;
      },
      clear: () => {},
      update: (status: string, userId: number | null) => void state.loginUpdates.push({ status, userId }),
    },
    helpButton: (s: "normal" | "disabled") => void state.helpStates.push(s),
    websockets: { update: () => {}, remove: () => {} },
    progress: { minuteAlmostDone: () => false, stopTimer: () => {} },
    channels: {
      display: () => {},
      remove: () => {},
      getSelection: () => null,
      clearWatching: () => {},
      setWatching: () => {},
      clear: () => {},
    },
    inv: { updateDrop: () => {}, clear: () => {}, addCampaign: async () => {} },
    setGames: () => {},
    displayDrop: () => {},
    notifier: { notify: () => {}, set_activity: () => {} },
    clearDrop: () => {},
    print: (m: string) => void state.printed.push(m),
    reportNetworkIssue: (u: string) => void state.issues.push(u),
    reportNetworkRecovery: (u: string) => void state.recoveries.push(u),
    preventClose: () => {},
    close: () => void (state.closed = true),
    save: () => {},
    start: () => {},
  };
  return gui;
}

function makeEngine(
  loginAnswers: Array<{ username: string; password: string; token: string }> = [],
  opts: { seedCookies?: Array<{ name: string; value: string; host: string }> } = {},
): { dir: string; settings: Settings; gui: ReturnType<typeof makeGui>; transport: FakeTransport; engine: Twitch } {
  const dir = mkdtempSync(join(tmpdir(), "tdm-engine-"));
  if (opts.seedCookies?.length) {
    const jar = new CookieJar();
    for (const cookie of opts.seedCookies) jar.set(cookie.name, cookie.value, cookie.host);
    jar.saveFile(join(dir, "cookies.json"));
  }
  // CLI defaults mirror argparse: dump/log off unless main.ts says otherwise.
  const settings = new Settings(join(dir, "settings.json"), { dump: false, log: false });
  const gui = makeGui(loginAnswers);
  const transport = new FakeTransport();
  const engine = new Twitch({ dataDir: dir, settings, gui, transport: transport.fetch });
  return { dir, settings, gui, transport, engine };
}

function validateRoutes(transport: FakeTransport, userId: number, clientId = ANDROID_ID): void {
  transport.on("GET", "https://id.twitch.tv/oauth2/validate", 200, { user_id: String(userId), client_id: clientId });
}

describe("auth validation", () => {
  test("restores a saved session from the cookie jar", async () => {
    const { gui, transport, engine } = makeEngine([], {
      seedCookies: [{ name: "auth-token", value: "saved-token", host: "www.twitch.tv" }],
    });
    transport.on("GET", "https://www.twitch.tv", 200, "<html></html>", ["unique_id=dev1; Path=/; Domain=twitch.tv"]);
    validateRoutes(transport, 123);
    await engine.getAuth();
    expect(engine.auth.userId).toBe(123);
    expect(gui.state.loginUpdates.at(-1)).toEqual({ status: "Logged in", userId: 123 });
    expect(gui.state.helpStates.at(-1)).toBe("normal");
    // Second call reuses the validated session without new requests.
    const calls = transport.calls.length;
    await engine.getAuth();
    expect(transport.calls.length).toBe(calls);
  });

  test("device flow polls until the user approves", async () => {
    const { gui, transport, engine } = makeEngine();
    transport.on("GET", "https://www.twitch.tv", 200, "<html></html>", ["unique_id=dev9; Path=/; Domain=twitch.tv"]);
    transport.on("POST", "https://id.twitch.tv/oauth2/device", 200, {
      device_code: "dev-code",
      user_code: "ABCD1234",
      interval: 0,
      verification_uri: "https://www.twitch.tv/activate?device-code=ABCD1234",
      expires_in: 1800,
    });
    let polls = 0;
    transport.handler = (async (url: string, init: RequestInit) => {
      if (url === "https://id.twitch.tv/oauth2/token") {
        polls += 1;
        if (polls === 1) {
          return new Response(JSON.stringify({ message: "authorization_pending" }), { status: 400 });
        }
        return new Response(JSON.stringify({ access_token: "fresh-token" }), { status: 200 });
      }
      return transport.baseFetch(url, init);
    }) as FetchImpl;
    validateRoutes(transport, 7);
    await engine.getAuth();
    expect(gui.state.codes).toEqual([{ url: "https://www.twitch.tv/activate?device-code=ABCD1234", code: "ABCD1234" }]);
    expect(engine.auth.accessToken).toBe("fresh-token");
    expect(engine.auth.userId).toBe(7);
  });

  test("denied authorization raises LoginException", async () => {
    const { transport, engine } = makeEngine();
    transport.on("GET", "https://www.twitch.tv", 200, "", ["unique_id=d1; Path=/"]);
    transport.on("POST", "https://id.twitch.tv/oauth2/device", 200, {
      device_code: "c",
      user_code: "U",
      interval: 0,
      verification_uri: "https://www.twitch.tv/activate",
      expires_in: 1800,
    });
    transport.on("POST", "https://id.twitch.tv/oauth2/token", 400, { message: "access_denied" });
    await expect(engine.getAuth()).rejects.toThrow(LoginException);
  });

  test("expired device code requests a fresh one", async () => {
    const { transport, engine } = makeEngine();
    transport.on("GET", "https://www.twitch.tv", 200, "", ["unique_id=d2; Path=/"]);
    let deviceCalls = 0;
    let tokenCalls = 0;
    transport.handler = (async (url: string, init: RequestInit) => {
      if (url === "https://id.twitch.tv/oauth2/device") {
        deviceCalls += 1;
        return new Response(
          JSON.stringify({ device_code: `c${deviceCalls}`, user_code: "U", interval: 0, verification_uri: "https://www.twitch.tv/activate", expires_in: 1800 }),
          { status: 200 },
        );
      }
      if (url === "https://id.twitch.tv/oauth2/token") {
        tokenCalls += 1;
        if (tokenCalls === 1) return new Response(JSON.stringify({ message: "expired_token" }), { status: 400 });
        return new Response(JSON.stringify({ access_token: "second-code-token" }), { status: 200 });
      }
      return transport.baseFetch(url, init);
    }) as FetchImpl;
    validateRoutes(transport, 9);
    await engine.getAuth();
    expect(deviceCalls).toBe(2);
    expect(engine.auth.accessToken).toBe("second-code-token");
  });

  test("401 clears the cookie and reauthorizes", async () => {
    const { transport, engine } = makeEngine([], {
      seedCookies: [{ name: "auth-token", value: "stale-token", host: "www.twitch.tv" }],
    });
    transport.on("GET", "https://www.twitch.tv", 200, "", ["unique_id=d3; Path=/"]);
    let validates = 0;
    transport.handler = (async (url: string, init: RequestInit) => {
      if (url === "https://id.twitch.tv/oauth2/validate") {
        validates += 1;
        if (validates === 1) return new Response("{}", { status: 401 });
        return new Response(JSON.stringify({ user_id: "11", client_id: ANDROID_ID }), { status: 200 });
      }
      return transport.baseFetch(url, init);
    }) as FetchImpl;
    transport.on("POST", "https://id.twitch.tv/oauth2/device", 200, {
      device_code: "c",
      user_code: "U",
      interval: 0,
      verification_uri: "https://www.twitch.tv/activate",
      expires_in: 1800,
    });
    transport.on("POST", "https://id.twitch.tv/oauth2/token", 200, { access_token: "rotated" });
    await engine.getAuth();
    expect(engine.auth.accessToken).toBe("rotated");
    expect(engine.auth.userId).toBe(11);
  });
});

describe("password login", () => {
  test("CAPTCHA requirement surfaces as CaptchaRequired", async () => {
    const { transport, engine } = makeEngine([{ username: "u", password: "p", token: "" }]);
    transport.on("POST", "https://passport.twitch.tv/login", 200, { error_code: 1000 });
    await expect(engine.auth.passwordLogin()).rejects.toThrow(CaptchaRequired);
  });

  test("wrong password retries, then succeeds", async () => {
    const logins = [
      { username: "u", password: "wrong", token: "" },
      { username: "u", password: "right", token: "" },
    ];
    const { gui, transport, engine } = makeEngine(logins);
    let calls = 0;
    transport.handler = (async (url: string, init: RequestInit) => {
      if (url === "https://passport.twitch.tv/login") {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify({ error_code: 3001 }), { status: 200 });
        return new Response(JSON.stringify({ access_token: "pass-token" }), { status: 200 });
      }
      return transport.baseFetch(url, init);
    }) as FetchImpl;
    expect(await engine.auth.passwordLogin()).toBe("pass-token");
    expect(gui.state.printed.join(" ")).toContain("Incorrect username or password");
  });
});

describe("request and GQL", () => {
  test("5xx retries with a site-down message, then succeeds", async () => {
    const { gui, transport, engine } = makeEngine();
    let calls = 0;
    transport.handler = (async (url: string, init: RequestInit) => {
      calls += 1;
      if (calls < 3) return new Response("bad gateway", { status: 502 });
      return transport.baseFetch(url, init);
    }) as FetchImpl;
    transport.on("GET", "https://example.test/x", 200, { ok: true });
    const response = await engine.request("GET", "https://example.test/x");
    expect(response.status).toBe(200);
    expect(gui.state.printed.join(" ")).toContain("Twitch is down");
  });

  test("connection failures report, print after the first, then recover", async () => {
    const { gui, transport, engine } = makeEngine();
    transport.on("GET", "https://example.test/y", 200, { ok: true });
    let failures = 0;
    transport.handler = (async (url: string, init: RequestInit) => {
      if (url === "https://example.test/y" && failures < 2) {
        failures += 1;
        throw new TypeError("fetch failed");
      }
      return transport.baseFetch(url, init);
    }) as FetchImpl;
    const response = await engine.request("GET", "https://example.test/y");
    expect(response.status).toBe(200);
    expect(gui.state.issues).toEqual(["https://example.test/y", "https://example.test/y"]);
    expect(gui.state.printed.join(" ")).toContain("Cannot connect to Twitch");
    expect(gui.state.recoveries).toEqual(["https://example.test/y"]);
  });

  test("shutdown aborts requests with ExitRequest", async () => {
    const { engine } = makeEngine();
    engine.closeEvent.set();
    await expect(engine.request("GET", "https://example.test/z")).rejects.toThrow(ExitRequest);
  });

  test("transient GQL errors retry once, then succeed", async () => {
    const { transport, engine } = makeEngine();
    seedAuthFor(engine);
    let calls = 0;
    transport.handler = (async (url: string, init: RequestInit) => {
      if (url === "https://gql.twitch.tv/gql") {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({ errors: [{ message: "service timeout" }], extensions: { operationName: "X" } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      }
      return transport.baseFetch(url, init);
    }) as FetchImpl;
    const result = (await engine.gqlRequest({ operationName: "X", extensions: {}, variables: {} })) as Record<string, unknown>;
    expect(calls).toBe(2);
    expect(result).toEqual({ data: { ok: true } });
  });

  test("server errors null the pointed path", async () => {
    const { transport, engine } = makeEngine();
    seedAuthFor(engine);
    transport.on("POST", "https://gql.twitch.tv/gql", 200, {
      data: { x: { nested: 1 }, y: 2 },
      errors: [{ message: "server error", path: ["x"] }],
    });
    const result = (await engine.gqlRequest({ operationName: "X", extensions: {}, variables: {} })) as Record<string, unknown>;
    expect((result["data"] as Record<string, unknown>)["x"]).toBeNull();
  });

  test("hard GQL errors raise GQLException", async () => {
    const { transport, engine } = makeEngine();
    seedAuthFor(engine);
    transport.on("POST", "https://gql.twitch.tv/gql", 200, { errors: [{ message: "nope" }] });
    const { GQLException } = await import("./errors.ts");
    await expect(engine.gqlRequest({ operationName: "X", extensions: {}, variables: {} })).rejects.toThrow(GQLException);
  });
});

function seedAuthFor(engine: { auth: { accessToken?: string; userId?: number; deviceId?: string } }): void {
  engine.auth.accessToken = "tok";
  engine.auth.userId = 5;
  engine.auth.deviceId = "dev";
}

function campaignFixture(id: string, gameId: string, gameName: string): Record<string, unknown> {
  return {
    id,
    name: `Campaign ${id}`,
    game: { id: gameId, displayName: gameName, name: gameName, boxArtURL: "https://cdn.test/g-285x380.jpg" },
    self: { isAccountConnected: true },
    accountLinkURL: "https://twitch.tv/settings/connections",
    startAt: iso(-HOUR),
    endAt: iso(DAY),
    status: "ACTIVE",
    allow: { channels: null, isEnabled: true },
    timeBasedDrops: [
      {
        id: `${id}-d1`,
        name: "Watch",
        benefitEdges: [{ benefit: { id: `${id}-b1`, name: `Reward ${id}`, distributionType: "DIRECT_ENTITLEMENT", imageAssetURL: "https://img.test/a.png" } }],
        startAt: iso(-HOUR),
        endAt: iso(DAY),
        requiredMinutesWatched: 60,
        preconditionDrops: [],
      },
    ],
  };
}

describe("fetchInventory", () => {
  test("builds campaigns, history and triggers end to end", async () => {
    const { transport, engine } = makeEngine();
    seedAuthFor(engine);
    transport.handler = (async (url: string, init: RequestInit) => {
      if (url === "https://gql.twitch.tv/gql") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
        const op = (Array.isArray(body) ? body[0] : body) as Record<string, unknown>;
        const name = op["operationName"];
        if (name === "Inventory") {
          return new Response(
            JSON.stringify({
              data: {
                currentUser: {
                  inventory: {
                    gameEventDrops: [{ id: "c1-b1", name: "Reward c1", lastAwardedAt: iso(-HOUR), game: { id: "10", displayName: "Game" } }],
                    dropCampaignsInProgress: [{ id: "c1", game: { id: "10" } }],
                  },
                },
              },
            }),
            { status: 200 },
          );
        }
        if (name === "ViewerDropsDashboard") {
          return new Response(JSON.stringify({ data: { currentUser: { dropCampaigns: [{ id: "c1", status: "ACTIVE" }] } } }), { status: 200 });
        }
        if (typeof name === "string" && !["Inventory", "ViewerDropsDashboard", "DropCampaignDetails"].includes(name)) {
          return new Response(JSON.stringify({ data: {} }), { status: 200 });
        }
        if (name === "DropCampaignDetails") {
          const requested = Array.isArray(body) ? body : [body];
          return new Response(
            JSON.stringify(
              requested.map(() => ({ data: { user: { dropCampaign: campaignFixture("c1", "10", "Game") } } })),
            ),
            { status: 200 },
          );
        }
      }
      return transport.baseFetch(url, init);
    }) as FetchImpl;
    await engine.fetchInventory();
    expect(engine.inventory).toHaveLength(1);
    expect(engine.inventory[0]!.id).toBe("c1");
    expect(engine.inventory[0]!.getDrop("c1-d1")).toBeDefined();
    expect(engine.history!.query("5").total).toBe(1);
    expect(engine.history!.query("5").items[0]!.source).toBe("inventory");
  });
});

async function stockedEngine(): Promise<ReturnType<typeof makeEngine>> {
  const built = makeEngine();
  const { transport, engine } = built;
  seedAuthFor(engine);
  const origFetch = transport.baseFetch.bind(transport);
  transport.handler = (async (url: string, init: RequestInit) => {
    if (url === "https://gql.twitch.tv/gql") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      const op = (Array.isArray(body) ? body[0] : body) as Record<string, unknown>;
      const name = op["operationName"];
      if (name === "Inventory") {
        return new Response(
          JSON.stringify({
            data: {
              currentUser: {
                inventory: {
                  gameEventDrops: [{ id: "c1-b1", name: "Reward c1", lastAwardedAt: iso(-HOUR), game: { id: "10", displayName: "Game" } }],
                  dropCampaignsInProgress: [{ id: "c1", game: { id: "10" } }],
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      if (name === "ViewerDropsDashboard") {
        return new Response(JSON.stringify({ data: { currentUser: { dropCampaigns: [{ id: "c1", status: "ACTIVE" }] } } }), { status: 200 });
      }
      if (typeof name === "string" && !["Inventory", "ViewerDropsDashboard", "DropCampaignDetails"].includes(name)) {
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
      if (name === "DropCampaignDetails") {
        const requested = Array.isArray(body) ? body : [body];
        return new Response(
          JSON.stringify(requested.map(() => ({ data: { user: { dropCampaign: campaignFixture("c1", "10", "Game") } } }))),
          { status: 200 },
        );
      }
    }
    return transport.baseFetch(url, init);
  }) as FetchImpl;
  await engine.fetchInventory();
  return built;
}

describe("drop events", () => {
  test("progress messages confirm minutes on the watched drop", async () => {
    const { engine } = await stockedEngine();
    const channel = Channel.fromDirectory(engine, {
      broadcaster: { id: 1, login: "one" },
      id: "b1",
      game: { id: "10", displayName: "Game" },
      viewersCount: 10,
      title: "T",
    });
    engine.wantedGames.push(engine.inventory[0]!.game);
    engine.watch(channel);
    await engine.processDrops(5, {
      type: "drop-progress",
      data: { drop_id: "c1-d1", current_progress_min: 12, required_progress_min: 60 },
    });
    expect(engine.stats.snapshot().lifetime["mining_minutes"]).toBe(12);
    // Unknown drops are tolerated like Python's "<Unknown>" path.
    await engine.processDrops(5, {
      type: "drop-progress",
      data: { drop_id: "missing", current_progress_min: 3, required_progress_min: 10 },
    });
    expect(engine.stats.snapshot().lifetime["mining_minutes"]).toBe(12);
  });

  test("reward reminders refresh inventory and clear the notification", async () => {
    const { transport, engine } = await stockedEngine();
    const seenOps: string[] = [];
    const prev = transport.handler;
    transport.handler = (async (url: string, init: RequestInit) => {
      if (url === "https://gql.twitch.tv/gql") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
        for (const op of Array.isArray(body) ? body : [body]) seenOps.push(op["operationName"] as string);
      }
      return prev!(url, init);
    }) as FetchImpl;
    await engine.processNotifications(5, {
      type: "create-notification",
      data: { notification: { type: "user_drop_reward_reminder_notification", id: "n1" } },
    });
    expect(seenOps).toContain("OnsiteNotifications_DeleteNotification");
    // Unrelated notification types are ignored.
    const countBefore = seenOps.length;
    await engine.processNotifications(5, { type: "create-notification", data: { notification: { type: "other", id: "n2" } } });
    expect(seenOps.length).toBe(countBefore);
  });
});

describe("selection", () => {
  function liveChannel(engine: ReturnType<typeof makeEngine>["engine"], id: number, login: string, gameId: string, gameName: string): Channel {
    return Channel.fromDirectory(
      engine,
      {
        broadcaster: { id, login },
        id: `b${id}`,
        game: { id: gameId, displayName: gameName },
        viewersCount: 10,
        title: "T",
      },
      true,
    );
  }

  function campaignFor(engine: ReturnType<typeof makeEngine>["engine"], gameId: string, gameName: string): DropsCampaign {
    return new DropsCampaign(engine, campaignFixture("c1", gameId, gameName) as never, new Map());
  }

  test("priority, watching and switching follow the Python rules", () => {
    const { engine } = makeEngine();
    const campaign = campaignFor(engine, "10", "Game");
    engine.inventory.push(campaign);
    engine.wantedGames.push(campaign.game);
    const ch = liveChannel(engine, 1, "one", "10", "Game");
    expect(engine.canWatch(ch)).toBe(true);
    expect(engine.getPriority(ch)).toBe(0);
    expect(engine.shouldSwitch(ch)).toBe(true);
    engine.watch(ch);
    expect(engine.watchingChannel.getWithDefault(null)).toBe(ch);
    expect(engine.shouldSwitch(ch)).toBe(false);
    const other = liveChannel(engine, 2, "two", "10", "Game");
    expect(engine.shouldSwitch(other)).toBe(false);
    expect(engine.getActiveCampaign(ch)).toBe(campaign);
    engine.pause();
    expect(engine.paused).toBe(true);
    expect(engine.shouldSwitch(other)).toBe(false);
    engine.resume();
    expect(engine.paused).toBe(false);
    engine.watch(other);
    expect(engine.secondsWithoutProgress()).not.toBeNull();
  });

  test("paused change_state only allows IDLE/RESTART/EXIT", () => {
    const { engine } = makeEngine();
    engine.pause();
    engine.changeState(EngineState.CHANNEL_SWITCH);
    engine.changeState(EngineState.IDLE);
  });

  test("mergeData is strict and primary-wins", () => {
    const { engine } = makeEngine();
    expect(engine.mergeData({ a: 1, n: { x: 1, y: 2 } }, { n: { y: 3, z: 4 }, b: 2 })).toEqual({ a: 1, n: { x: 1, y: 2, z: 4 }, b: 2 });
    expect(() => engine.mergeData({ a: 1 }, { a: "s" })).toThrow("Inconsistent merge data");
  });

  test("directory skips null broadcasters", async () => {
    const { transport, engine } = makeEngine();
    seedAuthFor(engine);
    transport.on("POST", "https://gql.twitch.tv/gql", 200, {
      data: { game: { streams: { edges: [{ node: { broadcaster: null } }, { node: { broadcaster: { id: 3, login: "ok" }, id: "b3", game: { id: "10", displayName: "Game" }, viewersCount: 1, title: "T" } }] } } },
    });
    const channels = await engine.getLiveStreams(new Game({ id: "10", name: "Game" }));
    expect(channels.map((c) => c.id)).toEqual([3]);
  });
});

describe("shutdown", () => {
  test("clears state and saves cookies only with an auth token", async () => {
    const { dir, engine } = makeEngine();
    seedAuthFor(engine);
    engine.cookies.set("auth-token", "tok", "www.twitch.tv");
    await engine.shutdown();
    expect(engine.history).toBeNull();
    expect(engine.inventory).toHaveLength(0);
    expect(engine.auth.userId).toBeUndefined();
    expect(CookieJar.loadFile(`${dir}/cookies.json`).has("auth-token", "www.twitch.tv")).toBe(true);
  });
});
