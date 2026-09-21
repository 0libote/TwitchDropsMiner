/**
 * Full-stack test: real `Twitch` engine + real `DashboardServer` against a
 * scripted Twitch transport, asserting over real dashboard HTTP that the
 * miner authenticates, builds inventory, selects a channel and watches it.
 * Pubsub points at a local accept-only socket (default 180s ping interval
 * never fires inside the test window).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { AsyncEvent } from "./async.ts";
import { CookieJar } from "./cookies.ts";
import { Twitch } from "./engine.ts";
import type { FetchImpl } from "./http.ts";
import { DashboardServer } from "./server.ts";
import { Settings } from "./settings.ts";
import type { DashboardState } from "../web/api-types.ts";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const ANDROID_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";

function campaignFixture() {
  return {
    id: "c1",
    name: "September Adventure Drops",
    game: { id: "10", displayName: "Game", name: "Game", boxArtURL: "https://cdn.test/g-285x380.jpg" },
    self: { isAccountConnected: true },
    accountLinkURL: "https://twitch.tv/settings/connections",
    startAt: iso(-HOUR),
    endAt: iso(DAY),
    status: "ACTIVE",
    allow: { channels: null, isEnabled: true },
    timeBasedDrops: [
      {
        id: "c1-d1",
        name: "Watch for 60 minutes",
        benefitEdges: [{ benefit: { id: "c1-b1", name: "Moonlit Pickaxe", distributionType: "DIRECT_ENTITLEMENT", imageAssetURL: "https://img.test/a.png" } }],
        startAt: iso(-HOUR),
        endAt: iso(DAY),
        requiredMinutesWatched: 60,
        preconditionDrops: [],
      },
    ],
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for stack condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("full stack", () => {
  test(
    "authenticates, mines and serves the dashboard",
    async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdm-stack-"));
    const jar = new CookieJar();
    jar.set("auth-token", "stack-token", "www.twitch.tv");
    jar.saveFile(join(dir, "cookies.json"));
    const settings = new Settings(join(dir, "settings.json"), { dump: false, log: false });
    const closeEvent = new AsyncEvent();

    // Local accept-only pubsub stand-in.
    const pubsub = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined as unknown as Response;
        return new Response("no", { status: 400 });
      },
      websocket: {
        open(_ws: ServerWebSocket<unknown>) {},
        message(_ws: ServerWebSocket<unknown>, _msg: unknown) {},
        close(_ws: ServerWebSocket<unknown>) {},
      },
    });

    const watchedPosts: string[] = [];
    const transport: FetchImpl = (async (url: string, init: RequestInit) => {
      const method = (init.method ?? "GET").toUpperCase();
      const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
      if (url === "https://www.twitch.tv") {
        const headers = new Headers();
        headers.append("set-cookie", "unique_id=stackdev; Path=/; Domain=twitch.tv");
        return new Response("<html></html>", { status: 200, headers });
      }
      if (url === "https://id.twitch.tv/oauth2/validate") {
        return json({ user_id: "42", client_id: ANDROID_ID });
      }
      if (url === "https://gql.twitch.tv/gql") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
        const op = ((Array.isArray(body) ? body[0] : body) as Record<string, unknown>)["operationName"];
        if (op === "Inventory") {
          return json({
            data: {
              currentUser: {
                inventory: {
                  gameEventDrops: [],
                  dropCampaignsInProgress: [{ id: "c1", game: { id: "10" } }],
                },
              },
            },
          });
        }
        if (op === "ViewerDropsDashboard") {
          return json({ data: { currentUser: { dropCampaigns: [{ id: "c1", status: "ACTIVE" }] } } });
        }
        if (op === "DropCampaignDetails") {
          const requested = (Array.isArray(body) ? body : [body]) as Array<Record<string, unknown>>;
          return json(requested.map(() => ({ data: { user: { dropCampaign: campaignFixture() } } })));
        }
        if (op === "DirectoryPage_Game") {
          return json({
            data: {
              game: {
                streams: {
                  edges: [
                    {
                      node: {
                        broadcaster: { id: 501, login: "auroraplays", displayName: "AuroraPlays" },
                        id: "b501",
                        game: { id: "10", displayName: "Game" },
                        viewersCount: 1284,
                        title: "Adventure drops",
                      },
                    },
                  ],
                },
              },
            },
          });
        }
        return json({ data: {} });
      }
      if (url === "https://www.twitch.tv/auroraplays") {
        return new Response('<html>{"spade_url": "https://spade.test/"}</html>', { status: 200 });
      }
      if (url === "https://spade.test/") {
        watchedPosts.push(`${method} ${url}`);
        return new Response("", { status: 204 });
      }
      throw new Error(`Unexpected fetch in stack test: ${method} ${url}`);
    }) as FetchImpl;

    const server = new DashboardServer({ dataDir: dir, settings, host: "127.0.0.1", port: 0, openBrowser: false, closeEvent });
    const engine = new Twitch({
      dataDir: dir,
      settings,
      gui: server,
      transport,
      pubsubUrl: `ws://127.0.0.1:${pubsub.port}`,
      closeEvent,
    });
    server.attachEngine(engine);
    const runPromise = engine.run();
    try {
      await waitFor(() => engine.watchingChannel.getWithDefault(null) !== null);
      const watching = engine.watchingChannel.getWithDefault(null)!;
      expect(watching.name).toBe("AuroraPlays");
      expect(engine.inventory).toHaveLength(1);

      const port = server.boundPort!;
      const state = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as DashboardState;
      expect(state.campaigns).toHaveLength(1);
      expect(state.campaigns[0]!.name).toBe("September Adventure Drops");
      expect(state.channels).toHaveLength(1);
      expect(state.watchingChannelId).toBe(501);
      expect(state.login.userId).toBe(42);
      expect((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { status: string }).toEqual({ status: "ok" });
      expect((await (await fetch(`http://127.0.0.1:${port}/readyz`)).json()) as { status: string }).toEqual({ status: "ready" });

      // The watch loop reports minutes to the (fake) spade endpoint.
      await waitFor(() => watchedPosts.length > 0);
      expect(engine.stats.snapshot().lifetime["watch_heartbeats"]).toBeGreaterThan(0);
    } finally {
      server.close();
      await runPromise;
      await engine.shutdown();
      server.stop();
      pubsub.stop();
    }
    },
    { timeout: 30000 },
  );
});
