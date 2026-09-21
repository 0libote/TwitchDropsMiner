/**
 * Tests for `src/websocket.ts` against a real local WebSocket server
 * (`Bun.serve`), plus pool distribution without any network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { MinerException } from "./errors.ts";
import { WebsocketPool, type WsEngine, type WsTopic } from "./websocket.ts";

function makeTopic(id: string, onMessage?: (message: unknown) => void): WsTopic {
  return { id, targetId: 1, process: (m) => void onMessage?.(m) };
}

interface GuiCall {
  method: string;
  args: unknown[];
}

function makeEngine(): WsEngine & {
  guiCalls: GuiCall[];
  logs: string[];
  tokens: string[];
} {
  const guiCalls: GuiCall[] = [];
  const logs: string[] = [];
  const engine = {
    guiCalls,
    logs,
    tokens: [] as string[],
    settings: { proxy: "" },
    gui: {
      websockets: {
        update: (idx: number, status?: string | null, topics?: number | null) =>
          void guiCalls.push({ method: "update", args: [idx, status, topics] }),
        remove: (idx: number) => void guiCalls.push({ method: "remove", args: [idx] }),
      },
    },
    translate: (_s: string, _k: string, sub?: string) => sub ?? _k,
    debug: (m: string) => void logs.push(`debug:${m}`),
    info: (m: string) => void logs.push(`info:${m}`),
    warn: (m: string) => void logs.push(`warn:${m}`),
    error: (m: string) => void logs.push(`error:${m}`),
    waitUntilLogin: async (): Promise<true> => true,
    getAuthToken: async () => {
      engine.tokens.push("tok");
      return "tok";
    },
    close: () => {},
  };
  return engine;
}

interface FixtureServer {
  url: string;
  received: Array<Record<string, unknown>>;
  connections: number;
  autoPong: boolean;
  send(text: string): void;
  closeClients(): void;
  stop(): void;
}

function startFixtureServer(): FixtureServer {
  const received: Array<Record<string, unknown>> = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  let connections = 0;
  const fixture: FixtureServer = {
    url: "",
    received,
    connections: 0,
    autoPong: false,
    send: (text) => {
      for (const socket of sockets) socket.send(text);
    },
    closeClients: () => {
      for (const socket of [...sockets]) socket.close();
    },
    stop: () => server.stop(),
  };
  const server: Server<undefined> = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined as unknown as Response;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        connections += 1;
        fixture.connections = connections;
        sockets.add(ws);
      },
      message(ws, raw) {
        const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
        received.push(parsed);
        if (fixture.autoPong && parsed["type"] === "PING") {
          ws.send(JSON.stringify({ type: "PONG" }));
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  fixture.url = `ws://127.0.0.1:${server.port}`;
  return fixture;
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function listenFrames(server: FixtureServer, type: string): Array<Record<string, unknown>> {
  return server.received.filter((frame) => frame["type"] === type);
}

describe("WebsocketPool distribution", () => {
  test("fills sockets to the topic limit and dedupes", () => {
    const pool = new WebsocketPool(makeEngine());
    pool.addTopics(Array.from({ length: 55 }, (_, i) => makeTopic(`t.${i}`)));
    expect(pool.websockets).toHaveLength(2);
    expect(pool.websockets[0]!.topics.size).toBe(50);
    expect(pool.websockets[1]!.topics.size).toBe(5);
    // Adding the same topics again changes nothing.
    pool.addTopics(Array.from({ length: 55 }, (_, i) => makeTopic(`t.${i}`)));
    expect(pool.websockets[0]!.topics.size).toBe(50);
    expect(pool.websockets[1]!.topics.size).toBe(5);
  });

  test("removal recycles surplus sockets", async () => {
    const pool = new WebsocketPool(makeEngine());
    pool.addTopics(Array.from({ length: 55 }, (_, i) => makeTopic(`t.${i}`)));
    pool.removeTopics(new Set(Array.from({ length: 10 }, (_, i) => `t.${i}`)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pool.websockets).toHaveLength(1);
    expect(pool.websockets[0]!.topics.size).toBe(45);
  });

  test("more than 400 topics throws like Python", () => {
    const pool = new WebsocketPool(makeEngine());
    expect(() => pool.addTopics(Array.from({ length: 401 }, (_, i) => makeTopic(`t.${i}`)))).toThrow(MinerException);
  });
});

describe("live pubsub behavior", () => {
  let server: FixtureServer | null = null;
  let pools: WebsocketPool[] = [];

  afterEach(async () => {
    for (const pool of pools) await pool.stop();
    pools = [];
    server?.stop();
    server = null;
  });

  function livePool(fastPing = false): { engine: ReturnType<typeof makeEngine>; pool: WebsocketPool } {
    server = startFixtureServer();
    const engine = makeEngine();
    const pool = new WebsocketPool(engine, {
      url: server.url,
      socketOptions: fastPing
        ? { recvTimeoutMs: 10, connectTimeoutMs: 2000, pingIntervalMs: 100, pongTimeoutMs: 30 }
        : { recvTimeoutMs: 10, connectTimeoutMs: 2000 },
    });
    pools.push(pool);
    return { engine, pool };
  }

  test("LISTEN carries topics, token and nonce; MESSAGE routes to topics", async () => {
    const { pool } = livePool();
    const fixture = server!;
    const seen: unknown[] = [];
    await pool.start();
    pool.addTopics([makeTopic("user-drop-events.1", (m) => void seen.push(m)), makeTopic("onsite-notifications.2")]);
    await waitFor(() => listenFrames(fixture, "LISTEN").length >= 1);
    const listen = listenFrames(fixture, "LISTEN")[0]!;
    const data = listen["data"] as { topics: string[]; auth_token: string };
    expect(new Set(data.topics)).toEqual(new Set(["user-drop-events.1", "onsite-notifications.2"]));
    expect(data.auth_token).toBe("tok");
    expect(typeof listen["nonce"]).toBe("string");
    expect((listen["nonce"] as string)).toHaveLength(30);
    fixture.send(JSON.stringify({ type: "MESSAGE", data: { topic: "user-drop-events.1", message: JSON.stringify({ hello: 1 }) } }));
    await waitFor(() => seen.length >= 1);
    expect(seen).toEqual([{ hello: 1 }]);
  });

  test("removal sends UNLISTEN", async () => {
    const { pool } = livePool();
    const fixture = server!;
    await pool.start();
    pool.addTopics([makeTopic("user-drop-events.1"), makeTopic("onsite-notifications.2")]);
    await waitFor(() => listenFrames(fixture, "LISTEN").length >= 1);
    pool.removeTopics(new Set(["user-drop-events.1"]));
    await waitFor(() => listenFrames(fixture, "UNLISTEN").length >= 1);
    const unlisten = listenFrames(fixture, "UNLISTEN")[0]!;
    expect((unlisten["data"] as { topics: string[] }).topics).toEqual(["user-drop-events.1"]);
  });

  test("missing PONG reconnects and resubscribes; PONGs keep it alive", async () => {
    const { pool } = livePool(true);
    const fixture = server!;
    await pool.start();
    pool.addTopics([makeTopic("user-drop-events.1")]);
    await waitFor(() => listenFrames(fixture, "LISTEN").length >= 1);
    // No PONGs served: the socket must reconnect on its own.
    await waitFor(() => fixture.connections >= 2, 5000);
    await waitFor(() => listenFrames(fixture, "LISTEN").length >= 2, 5000);
    // Answer PINGs from here on. Any in-flight pong window may still fire
    // once, so let it expire before asserting the connection count settles.
    fixture.autoPong = true;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const settled = fixture.connections;
    expect(settled).toBeGreaterThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fixture.connections).toBe(settled);
  });

  test("RECONNECT and server close both reconnect", async () => {
    const { pool } = livePool();
    const fixture = server!;
    await pool.start();
    pool.addTopics([makeTopic("user-drop-events.1")]);
    await waitFor(() => listenFrames(fixture, "LISTEN").length >= 1);
    fixture.send(JSON.stringify({ type: "RECONNECT" }));
    await waitFor(() => fixture.connections >= 2, 5000);
    await waitFor(() => listenFrames(fixture, "LISTEN").length >= 2, 5000);
    fixture.closeClients();
    await waitFor(() => fixture.connections >= 3, 5000);
    await waitFor(() => listenFrames(fixture, "LISTEN").length >= 3, 5000);
  });
});
