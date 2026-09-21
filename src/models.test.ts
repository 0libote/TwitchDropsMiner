/**
 * Tests for `src/models.ts` (+ `utils.ts` game/helpers, `errors.ts`).
 * Engine access is faked; GQL payloads use the same shapes as
 * `channel.py`/`inventory.py` consume. Time windows are relative to now
 * so time-dependent rules (active, claim window) behave deterministically.
 */
import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { GQLException, MinerException, RequestException } from "./errors.ts";
import { Benefit, BenefitType, Channel, DropsCampaign, Stream, removeDimensions, type EngineLike } from "./models.ts";
import { Game, isonow, jsonMinify, timestamp } from "./utils.ts";

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

interface Call {
  method: string;
  args: unknown[];
}

function makeEngine(): EngineLike & {
  calls: Call[];
  gqlHandler: (query: unknown) => Promise<Record<string, unknown>>;
  requestHandler: (method: string, url: string) => Promise<{ status: number; body: string }>;
  notified: Array<{ message: string; title: string }>;
  printed: string[];
  warned: string[];
  states: string[];
} {
  const calls: Call[] = [];
  const notified: Array<{ message: string; title: string }> = [];
  const printed: string[] = [];
  const warned: string[] = [];
  const states: string[] = [];
  const engine = {
    calls,
    notified,
    printed,
    warned,
    states,
    settings: { available_drops_check: false, enable_badges_emotes: false },
    authUserId: 999,
    clientUrl: "https://www.twitch.tv",
    campaigns: new Map(),
    gui: {
      channels: {
        display: (c: unknown, o: unknown) => void calls.push({ method: "display", args: [c, o] }),
        remove: (c: unknown) => void calls.push({ method: "remove", args: [c] }),
      },
      inv: {
        updateDrop: (d: unknown) => void calls.push({ method: "updateDrop", args: [d] }),
      },
      displayDrop: (d: unknown, o: unknown) => void calls.push({ method: "displayDrop", args: [d, o] }),
      notifier: {
        notify: (message: string, title: string) => void (notified.push({ message, title }), calls.push({ method: "notify", args: [message, title] })),
      },
    },
    translate: (section: string, key: string, sub?: string) => (sub ? `${section}.${key}.${sub}` : `${section}.${key}`),
    print: (m: string) => void printed.push(m),
    warn: (m: string) => void warned.push(m),
    changeState: (s: string) => void states.push(s),
    stats: {
      progress: (n: number) => void calls.push({ method: "stats.progress", args: [n] }),
      claim: () => void calls.push({ method: "stats.claim", args: [] }),
    },
    recordClaimHistory: (d: unknown) => void calls.push({ method: "recordClaimHistory", args: [d] }),
    getAuth: async () => ({ user_id: 999 }),
    request: async (method: string, url: string) => {
      const res = await engine.requestHandler(method, url);
      return { status: res.status, text: async () => res.body };
    },
    gqlRequest: async (query: unknown) => engine.gqlHandler(query),
    onChannelUpdate: (c: unknown, o: unknown, n: unknown) => void calls.push({ method: "onChannelUpdate", args: [c, o, n] }),
    gqlHandler: async (_query: unknown): Promise<Record<string, unknown>> => ({}),
    requestHandler: async (_method: string, _url: string): Promise<{ status: number; body: string }> => ({ status: 404, body: "" }),
  };
  return engine;
}

function benefitData(id: string, type = "DIRECT_ENTITLEMENT") {
  return { benefit: { id, name: `Reward ${id}`, distributionType: type, imageAssetURL: "https://img.test/a.png" } };
}

function dropData(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Drop ${id}`,
    benefitEdges: [benefitData(`${id}-b`)],
    startAt: iso(-HOUR),
    endAt: iso(DAY),
    requiredMinutesWatched: 60,
    preconditionDrops: [],
    ...overrides,
  };
}

function campaignData(overrides: Record<string, unknown> = {}) {
  return {
    id: "camp-1",
    name: "Campaign",
    game: { id: "1", displayName: "Game", name: "Game", boxArtURL: "https://cdn.test/game-285x380.jpg" },
    self: { isAccountConnected: true },
    accountLinkURL: "https://twitch.tv/settings/connections",
    startAt: iso(-HOUR),
    endAt: iso(DAY),
    status: "ACTIVE",
    allow: { channels: null },
    timeBasedDrops: [dropData("d1"), dropData("d2", { requiredMinutesWatched: 30 })],
    ...overrides,
  };
}

describe("Game and helpers", () => {
  test("name prefers displayName, slug matches Python", () => {
    expect(new Game({ id: "1", displayName: "ARC Raiders", name: "arc" }).name).toBe("ARC Raiders");
    expect(new Game({ id: 1, name: "ARC Raiders" }).slug).toBe("arc-raiders");
    expect(new Game({ id: 1, name: "Pokémon GO" }).slug).toBe("pokémon-go");
    expect(new Game({ id: 1, name: "It's--A  Test!" }).slug).toBe("its-a-test");
    expect(new Game({ id: 509663, name: "Special" }).isSpecial()).toBe(true);
    expect(new Game({ id: 1, name: "x" }).isSpecial()).toBe(false);
    expect(new Game({ id: "7", name: "a" }).equals(new Game({ id: 7, name: "b" }))).toBe(true);
  });

  test("timestamp parses Twitch formats and rejects junk", () => {
    expect(timestamp("2024-01-02T03:04:05.123Z").toISOString()).toBe("2024-01-02T03:04:05.123Z");
    expect(timestamp("2024-01-02T03:04:05Z").toISOString()).toBe("2024-01-02T03:04:05.000Z");
    expect(() => timestamp("2024-01-02")).toThrow(MinerException);
    expect(isonow().endsWith("Z")).toBe(true);
    expect(jsonMinify({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
    expect(removeDimensions("https://cdn.test/game-285x380.jpg")).toBe("https://cdn.test/game.jpg");
    expect(removeDimensions("https://cdn.test/game.jpg")).toBe("https://cdn.test/game.jpg");
  });

  test("benefit types fall back to UNKNOWN", () => {
    expect(new Benefit(benefitData("x", "EMOTE")).isBadgeOrEmote()).toBe(true);
    expect(new Benefit(benefitData("x", "BADGE")).isBadgeOrEmote()).toBe(true);
    expect(new Benefit(benefitData("x", "DIRECT_ENTITLEMENT")).isBadgeOrEmote()).toBe(false);
    expect(new Benefit(benefitData("x", "FUTURE_TYPE")).type).toBe(BenefitType.UNKNOWN);
  });
});

describe("DropsCampaign", () => {
  test("eligibility follows link and badge settings", () => {
    const engine = makeEngine();
    expect(new DropsCampaign(engine, campaignData() as never, new Map()).eligible).toBe(true);
    expect(new DropsCampaign(engine, campaignData({ self: { isAccountConnected: false } }) as never, new Map()).eligible).toBe(false);
    const badge = campaignData({ timeBasedDrops: [{ ...dropData("b1"), benefitEdges: [benefitData("bb", "EMOTE")] }] });
    expect(new DropsCampaign(engine, badge as never, new Map()).eligible).toBe(false);
    engine.settings.enable_badges_emotes = true;
    expect(new DropsCampaign(engine, badge as never, new Map()).eligible).toBe(true);
  });

  test("active/upcoming/expired windows", () => {
    const engine = makeEngine();
    const active = new DropsCampaign(engine, campaignData() as never, new Map());
    expect([active.active, active.upcoming, active.expired]).toEqual([true, false, false]);
    const upcoming = new DropsCampaign(engine, campaignData({ startAt: iso(HOUR), endAt: iso(DAY) }) as never, new Map());
    expect([upcoming.active, upcoming.upcoming, upcoming.expired]).toEqual([false, true, false]);
    const expired = new DropsCampaign(engine, campaignData({ startAt: iso(-2 * DAY), endAt: iso(-HOUR) }) as never, new Map());
    expect([expired.active, expired.upcoming, expired.expired]).toEqual([false, false, true]);
    const flagged = new DropsCampaign(engine, campaignData({ status: "EXPIRED" }) as never, new Map());
    expect(flagged.expired).toBe(true);
  });

  test("progress and minute math across drops", () => {
    const engine = makeEngine();
    const campaign = new DropsCampaign(engine, campaignData() as never, new Map());
    const d1 = campaign.getDrop("d1")!;
    d1.realCurrentMinutes = 30;
    expect(d1.progress).toBe(0.5);
    expect(d1.remainingMinutes).toBe(30);
    expect(campaign.claimedDrops).toBe(0);
    expect(campaign.totalDrops).toBe(2);
    expect(campaign.requiredMinutes).toBe(60);
    expect(campaign.remainingMinutes).toBe(30);
    expect(campaign.finished).toBe(false);
    expect(campaign.progress).toBe(0.25);
    d1.isClaimed = true;
    campaign.getDrop("d2")!.isClaimed = true;
    expect(campaign.finished).toBe(true);
    expect(campaign.progress).toBe(0.25); // progress follows minutes, not claimed flags
  });

  test("preconditions gate earning until claimed", () => {
    const engine = makeEngine();
    const campaign = new DropsCampaign(
      engine,
      campaignData({ timeBasedDrops: [dropData("d1"), { ...dropData("d2"), preconditionDrops: [{ id: "d1" }] }] }) as never,
      new Map(),
    );
    const d2 = campaign.getDrop("d2")!;
    expect(d2.preconditionsMet).toBe(false);
    expect(d2.canEarn(null)).toBe(false);
    campaign.getDrop("d1")!.isClaimed = true;
    expect(d2.preconditionsMet).toBe(true);
    expect(d2.canEarn(null)).toBe(true);
    expect(campaign.preconditionsChain()).toEqual(new Set(["d1"]));
  });

  test("claimed benefits infer claimed drops inside the window", () => {
    const engine = makeEngine();
    const inWindow = new Map([["d1-b", new Date(Date.now())]]);
    const c1 = new DropsCampaign(engine, campaignData({ timeBasedDrops: [{ ...dropData("d1"), self: undefined }] }) as never, inWindow);
    expect(c1.getDrop("d1")!.isClaimed).toBe(true);
    const outWindow = new Map([["d1-b", new Date(Date.now() - 30 * DAY)]]);
    const c2 = new DropsCampaign(engine, campaignData({ timeBasedDrops: [{ ...dropData("d1"), self: undefined }] }) as never, outWindow);
    expect(c2.getDrop("d1")!.isClaimed).toBe(false);
  });

  test("can_earn respects ACL and special games", () => {
    const engine = makeEngine();
    const live = (id: number, login: string) =>
      Channel.fromDirectory(engine, {
        broadcaster: { id, login },
        id: `b${id}`,
        game: { id: "1", displayName: "Game" },
        viewersCount: 5,
        title: "T",
      });
    const campaign = new DropsCampaign(
      engine,
      campaignData({ allow: { channels: [{ id: 5, name: "allowed" }], isEnabled: true } }) as never,
      new Map(),
    );
    expect(campaign.canEarn(live(5, "allowed"))).toBe(true);
    expect(campaign.canEarn(live(6, "outsider"))).toBe(false);
    expect(campaign.canEarn(null)).toBe(true);
    // ACL-unlisted channel playing a special game still earns.
    const special = new DropsCampaign(
      engine,
      campaignData({ game: { id: "509663", displayName: "Special", name: "Special", boxArtURL: "https://cdn.test/s.jpg" } }) as never,
      new Map(),
    );
    expect(special.canEarn(live(6, "outsider"))).toBe(true);
  });

  test("claim window ends 24h after the campaign", () => {
    const engine = makeEngine();
    const campaign = new DropsCampaign(engine, campaignData() as never, new Map());
    const drop = campaign.getDrop("d1")!;
    expect(drop.canClaim).toBe(false);
    drop.updateClaim("cid");
    expect(drop.canClaim).toBe(true);
    const old = new DropsCampaign(engine, campaignData({ startAt: iso(-3 * DAY), endAt: iso(-2 * DAY) }) as never, new Map());
    const oldDrop = old.getDrop("d1")!;
    oldDrop.updateClaim("cid");
    expect(oldDrop.canClaim).toBe(false);
  });

  test("claim() succeeds, notifies and records once", async () => {
    const engine = makeEngine();
    engine.gqlHandler = async () => ({ data: { claimDropRewards: { status: "ELIGIBLE_FOR_ALL" } } });
    const campaign = new DropsCampaign(engine, campaignData() as never, new Map());
    const drop = campaign.getDrop("d1")!;
    drop.updateClaim("cid");
    expect(await drop.claim()).toBe(true);
    expect(drop.isClaimed).toBe(true);
    expect(drop.realCurrentMinutes).toBe(drop.requiredMinutes);
    expect(engine.notified).toHaveLength(1);
    // Template key passes through; the claim text keeps its newline form.
    expect(engine.printed).toEqual(["status.claimed_drop"]);
    expect(engine.notified[0]!.message).toContain("Game\n");
    expect(engine.notified[0]!.title).toBe("gui.tray.notification_title");
    expect(engine.calls.some((c) => c.method === "recordClaimHistory")).toBe(true);
    expect(engine.calls.some((c) => c.method === "stats.claim")).toBe(true);
    // Second claim short-circuits the transport but still reports: no re-record.
    const historyCalls = engine.calls.filter((c) => c.method === "recordClaimHistory").length;
    const claimCalls = engine.calls.filter((c) => c.method === "stats.claim").length;
    expect(await drop.claim()).toBe(true);
    expect(engine.calls.filter((c) => c.method === "recordClaimHistory")).toHaveLength(historyCalls);
    expect(engine.calls.filter((c) => c.method === "stats.claim")).toHaveLength(claimCalls);
    expect(engine.notified).toHaveLength(2);
  });

  test("claim() fails closed on errors", async () => {
    const engine = makeEngine();
    engine.gqlHandler = async () => ({ data: {}, errors: [{ message: "bad" }] });
    const campaign = new DropsCampaign(engine, campaignData() as never, new Map());
    const drop = campaign.getDrop("d1")!;
    drop.updateClaim("cid");
    expect(await drop.claim()).toBe(false);
    expect(drop.isClaimed).toBe(false);
    expect(engine.warned.join(" ")).toContain(drop.id);
  });

  test("claim() treats GQL transport errors as failure", async () => {
    const engine = makeEngine();
    engine.gqlHandler = async () => {
      throw new GQLException("boom");
    };
    const campaign = new DropsCampaign(engine, campaignData() as never, new Map());
    const drop = campaign.getDrop("d1")!;
    drop.updateClaim("cid");
    expect(await drop.claim()).toBe(false);
  });

  test("update_minutes clamps and reports progress", () => {
    const engine = makeEngine();
    const campaign = new DropsCampaign(engine, campaignData() as never, new Map());
    const drop = campaign.getDrop("d1")!;
    drop.realCurrentMinutes = 10;
    drop.updateMinutes(20);
    expect(drop.realCurrentMinutes).toBe(20);
    expect(engine.calls.some((c) => c.method === "stats.progress" && c.args[0] === 10)).toBe(true);
    drop.updateMinutes(1000);
    expect(drop.realCurrentMinutes).toBe(60);
  });

  test("bumpMinutes caps and escalates once", () => {
    const engine = makeEngine();
    const campaign = new DropsCampaign(engine, campaignData() as never, new Map());
    const channel = Channel.fromDirectory(engine, {
      broadcaster: { id: 1, login: "live" },
      id: "b1",
      game: { id: "1", displayName: "Game" },
      viewersCount: 5,
      title: "T",
    });
    for (let i = 0; i < 15; i++) campaign.bumpMinutes(channel);
    const drop = campaign.getDrop("d1")!;
    expect(drop.extraCurrentMinutes).toBe(15);
    expect(engine.warned).toHaveLength(1);
    expect(engine.states).toEqual(["CHANNEL_SWITCH"]);
  });

  test("availability is finite while earnable, infinite otherwise", () => {
    const engine = makeEngine();
    const campaign = new DropsCampaign(engine, campaignData() as never, new Map());
    expect(Number.isFinite(campaign.getDrop("d1")!.availability)).toBe(true);
    expect(campaign.getDrop("d1")!.availability).toBeGreaterThan(0);
    const expired = new DropsCampaign(
      engine,
      campaignData({
        startAt: iso(-3 * DAY),
        endAt: iso(-2 * DAY),
        timeBasedDrops: [
          { ...dropData("d1"), startAt: iso(-3 * DAY), endAt: iso(-2 * DAY) },
          { ...dropData("d2"), startAt: iso(-3 * DAY), endAt: iso(-2 * DAY) },
        ],
      }) as never,
      new Map(),
    );
    expect(expired.getDrop("d1")!.availability).toBe(Infinity);
  });
});

describe("Stream payloads", () => {
  function makeStream() {
    const engine = makeEngine();
    const channel = new Channel(engine, { id: 1, login: "someone" });
    return { engine, channel, stream: new Stream(channel, { id: 42, game: { id: "2", displayName: "Game" }, viewers: 10, title: "Hi" }) };
  }

  test("spade payload is base64 minute-watched JSON", () => {
    const { stream } = makeStream();
    const decoded = JSON.parse(Buffer.from(stream.spadePayload["data"] as string, "base64").toString("utf8"));
    expect(decoded).toHaveLength(1);
    expect(decoded[0].event).toBe("minute-watched");
    expect(decoded[0].properties).toMatchObject({ broadcast_id: "42", channel_id: "1", channel: "someone", game: "Game", game_id: "2", user_id: 999 });
  });

  test("gql payload gzip round-trips to the same events", () => {
    const { stream } = makeStream();
    const payload = stream.gqlPayload as { query: string; variables: { input: { data: string; repository: string; encoding: string } } };
    expect(payload.query).toContain("sendSpadeEvents");
    expect(payload.variables.input.repository).toBe("twilight");
    const inflated = JSON.parse(gunzipSync(Buffer.from(payload.variables.input.data, "base64")).toString("utf8"));
    expect(inflated).toEqual(JSON.parse(Buffer.from(stream.spadePayload["data"] as string, "base64").toString("utf8")));
  });

  test("stream URL prefers the last playlist line", async () => {
    const { engine, stream } = makeStream();
    engine.gqlHandler = async () => ({ data: { streamPlaybackAccessToken: { value: "tok", signature: "sig" } } });
    engine.requestHandler = async () => ({ status: 200, body: "#EXTM3U\nhttps://cdn.test/high.m3u8\nhttps://cdn.test/low.m3u8\n" });
    expect(await stream.getStreamUrl()).toBe("https://cdn.test/low.m3u8");
    // Cached on the second call.
    expect(await stream.getStreamUrl()).toBe("https://cdn.test/low.m3u8");
  });

  test("stream URL JSON errors go offline", async () => {
    const { engine, channel, stream } = makeStream();
    engine.gqlHandler = async () => ({ data: { streamPlaybackAccessToken: { value: "tok", signature: "sig" } } });
    engine.requestHandler = async () => ({ status: 200, body: '[{"error": "geo"}]' });
    expect(await stream.getStreamUrl()).toBeNull();
    expect(channel.offline).toBe(true);
    expect(engine.warned.join(" ")).toContain("geo");
  });
});

describe("Channel", () => {
  test("identity, presence and drops flags", () => {
    const engine = makeEngine();
    const named = new Channel(engine, { id: 7, login: "login", displayName: "Pretty" });
    expect(named.name).toBe("Pretty");
    expect(named.url).toBe("https://www.twitch.tv/login");
    expect(named.toString()).toBe("Channel(Pretty(login), 7)");
    expect(named.offline).toBe(true);
    expect(named.dropsEnabled).toBe(false);
    const bare = Channel.fromAcl(engine, { id: 8, name: "bare" });
    expect(bare.name).toBe("bare");
    expect(bare.aclBased).toBe(true);
    expect(named.equals(new Channel(engine, { id: 7, login: "other" }))).toBe(true);
    expect(named.streamGql.variables).toEqual({ channel: "login" });
  });

  test("from_directory attaches a live stream", () => {
    const engine = makeEngine();
    const channel = Channel.fromDirectory(engine, {
      broadcaster: { id: 9, login: "live", displayName: "Live" },
      id: "b1",
      game: { id: "3", displayName: "Chess" },
      viewersCount: 42,
      title: "Ranked",
    }, true);
    expect(channel.online).toBe(true);
    expect(channel.game!.name).toBe("Chess");
    expect(channel.viewers).toBe(42);
    expect(channel.dropsEnabled).toBe(true);
    channel.viewers = 43;
    expect(channel.viewers).toBe(43);
  });

  test("getStream fills display name and checks drops when needed", async () => {
    const engine = makeEngine();
    engine.settings.available_drops_check = true;
    engine.gqlHandler = async (query: unknown) => {
      const q = query as { operationName: string };
      if (q.operationName === "VideoPlayerStreamInfoOverlayChannel") {
        return { data: { user: { displayName: "Filled", stream: { id: "5", viewersCount: 3 }, broadcastSettings: { game: null, title: "T" } } } };
      }
      return { data: { channel: { viewerDropCampaigns: [{ id: "nope" }] } } };
    };
    const channel = new Channel(engine, { id: 1, login: "who" });
    const stream = await channel.getStream();
    expect(stream).not.toBeNull();
    expect(channel.name).toBe("Filled");
    expect(stream!.dropsEnabled).toBe(false);
  });

  test("getStream returns null when offline or unknown", async () => {
    const engine = makeEngine();
    engine.gqlHandler = async () => ({ data: { user: null } });
    expect(await new Channel(engine, { id: 1, login: "ghost" }).getStream()).toBeNull();
    engine.gqlHandler = async () => ({ data: { user: { displayName: "X", stream: null } } });
    expect(await new Channel(engine, { id: 1, login: "off" }).getStream()).toBeNull();
  });

  test("getStream wraps transport errors with the channel login", async () => {
    const engine = makeEngine();
    engine.gqlHandler = async () => {
      throw new RequestException("net down");
    };
    await expect(new Channel(engine, { id: 1, login: "who" }).getStream()).rejects.toThrow("Channel: who");
  });

  test("offline/pending transitions notify the engine", async () => {
    const engine = makeEngine();
    engine.gqlHandler = async () => ({ data: { user: null } });
    const channel = Channel.fromDirectory(engine, {
      broadcaster: { id: 1, login: "live" },
      id: "b1",
      game: { id: "3", displayName: "Chess" },
      viewersCount: 1,
      title: "T",
    });
    channel.setOffline();
    expect(channel.offline).toBe(true);
    expect(engine.calls.some((c) => c.method === "onChannelUpdate")).toBe(true);
    expect(await channel.updateStream()).toBe(false);
  });

  test("spade URL extraction follows both pages", async () => {
    const engine = makeEngine();
    engine.requestHandler = async (method, url) => {
      if (url === "https://www.twitch.tv/someone") {
        return { status: 200, body: '<script src="https://assets.test/config/settings.0123456789abcdef0123456789abcdef.js"></script>' };
      }
      return { status: 200, body: '{"spade_url": "https://spade.test/"}' };
    };
    const channel = new Channel(engine, { id: 1, login: "someone" });
    expect(await channel.getSpadeUrl()).toBe("https://spade.test/");
    engine.requestHandler = async () => ({ status: 200, body: "<html>nothing here</html>" });
    await expect(new Channel(engine, { id: 2, login: "nope" }).getSpadeUrl()).rejects.toThrow(MinerException);
  });

  test("sendWatch posts the spade payload and handles failure", async () => {
    const engine = makeEngine();
    const seen: Array<{ method: string; url: string }> = [];
    engine.requestHandler = async (method, url) => {
      seen.push({ method, url });
      if (method === "GET") return { status: 200, body: '{"spade_url": "https://spade.test/"}' };
      return { status: 204, body: "" };
    };
    const channel = Channel.fromDirectory(engine, {
      broadcaster: { id: 1, login: "live" },
      id: "b1",
      game: { id: "3", displayName: "Chess" },
      viewersCount: 1,
      title: "T",
    });
    expect(await channel.sendWatch()).toBe(true);
    expect(seen.map((s) => s.method)).toEqual(["GET", "POST"]);
    expect(seen[1]!.url).toBe("https://spade.test/");
    engine.requestHandler = async (method) => (method === "GET" ? { status: 200, body: "{}" } : { status: 500, body: "" });
    const channel2 = Channel.fromDirectory(engine, {
      broadcaster: { id: 2, login: "live2" },
      id: "b2",
      game: { id: "3", displayName: "Chess" },
      viewersCount: 1,
      title: "T",
    });
    // No spade URL on the page and no settings script: raises like Python.
    await expect(channel2.sendWatch()).rejects.toThrow(MinerException);
  });

  test("sendWatch swallows request errors as false", async () => {
    const engine = makeEngine();
    engine.requestHandler = async (method) => {
      if (method === "GET") return { status: 200, body: '{"spade_url": "https://spade.test/"}' };
      throw new RequestException("reset");
    };
    const channel = Channel.fromDirectory(engine, {
      broadcaster: { id: 1, login: "live" },
      id: "b1",
      game: { id: "3", displayName: "Chess" },
      viewersCount: 1,
      title: "T",
    });
    expect(await channel.sendWatch()).toBe(false);
  });
});
