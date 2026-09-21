/**
 * Port of `websocket.py`: Twitch pubsub sockets with reconnect backoff,
 * PING/PONG heartbeats, topic LISTEN/UNLISTEN sync and pool distribution.
 *
 * Transport uses the standard `WebSocket` API (Bun-native, no dependency).
 * A `SocketFactory` + injectable timeouts keep the timing-sensitive paths
 * testable against a local server; defaults mirror the Python constants.
 *
 * Deviations from Python:
 * - No `asyncio.Lock` around start/stop: flag changes are synchronous, and
 *   Bun runs a single thread, so the races the lock guarded cannot occur.
 * - `session.ws_connect(proxy=...)` has no equivalent in the client
 *   `WebSocket` API: `WsEngine.settings.proxy` is accepted for future use
 *   but currently unused. Direct connections are unaffected.
 * - `stop()` during a pending connect aborts the attempt (Python would
 *   connect once more before noticing); strictly cleaner shutdown.
 */

import { AwaitableValue, AsyncEvent, CHARS_ASCII, chunk, createNonce, formatTraceback, taskWrapper, TaskAbort } from "./async.ts";
import { ExponentialBackoff } from "./backoff.ts";
import { INTERVALS, LIMITS } from "./twitchProtocol.ts";
import { MinerException, WebsocketClosed } from "./errors.ts";

export const PUBSUB_URL = "wss://pubsub-edge.twitch.tv/v1";
const MAX_BACKOFF_SECONDS = 3 * 60;
const TOPIC_CHUNK = 20;

export interface WsTopic {
  readonly id: string;
  readonly targetId: number;
  process(message: unknown): void | Promise<void>;
}

export interface WsGui {
  update(idx: number, status?: string | null, topics?: number | null): void;
  remove(idx: number): void;
}

export interface WsEngine {
  settings: { proxy: string };
  gui: { websockets: WsGui };
  translate(section: string, key: string, subkey?: string): string;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  waitUntilLogin(): Promise<void>;
  getAuthToken(): Promise<string>;
  close(): void;
}

export interface WsMessageEvent {
  data: unknown;
}

export interface WsSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: WsMessageEvent) => void): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: WsMessageEvent) => void): void;
}

export type SocketFactory = (url: string) => WsSocket;

export interface SocketOptions {
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  recvTimeoutMs?: number;
  connectTimeoutMs?: number;
}

class StopRequested extends Error {}

/**
 * One live connection: inbound queue plus timed receive.
 * Close/error frames surface as `WebsocketClosed` with the same
 * received/not-received distinction as the Python message types.
 */
export class LiveConnection {
  private readonly queue: string[] = [];
  private waiter: { resolve: (message: string) => void; reject: (error: unknown) => void } | null = null;
  private terminal: WebsocketClosed | null = null;
  private opened = false;
  private usClosed = false;
  private errorSeen: unknown = null;
  onOpen: (() => void) | null = null;
  onEarlyClose: ((error: unknown) => void) | null = null;

  constructor(readonly socket: WsSocket) {
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", () => this.handleClose());
    socket.addEventListener("error", (event) => this.handleError(event));
    socket.addEventListener("open", () => {
      this.opened = true;
      this.onOpen?.();
    });
  }

  private handleMessage(event: WsMessageEvent): void {
    const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve(text);
    } else {
      this.queue.push(text);
    }
  }

  private handleClose(): void {
    if (!this.opened) {
      this.onEarlyClose?.(this.errorSeen ?? new MinerException("Websocket connection failed"));
      return;
    }
    // Server-initiated close counts as received (like a CLOSE frame);
    // our own dispose or a preceding error counts as not received.
    const error = new WebsocketClosed("Websocket closed", !this.usClosed && this.errorSeen === null);
    this.terminal = error;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(error);
    }
  }

  private handleError(event: WsMessageEvent): void {
    this.errorSeen = event.data ?? new MinerException("Websocket error");
  }

  /** Next text message, `null` on timeout. Throws `WebsocketClosed`. */
  async receive(timeoutMs: number): Promise<string | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    if (this.terminal) throw this.terminal;
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = {
        resolve: (message) => {
          clearTimeout(timer);
          this.waiter = null;
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.waiter = null;
          reject(error);
        },
      };
    });
  }

  dispose(): void {
    if (this.usClosed) return;
    this.usClosed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(new WebsocketClosed("Websocket closed", false));
    }
    try {
      this.socket.close();
    } catch {
      // Already gone; terminal state was recorded above.
    }
  }
}

const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as WsSocket;

export class Websocket {
  readonly topics = new Map<string, WsTopic>();
  private readonly submitted = new Set<string>();
  private readonly ws = new AwaitableValue<LiveConnection>();
  private readonly closed = new AsyncEvent();
  private readonly reconnectRequested = new AsyncEvent();
  private readonly topicsChanged = new AsyncEvent();
  private nextPing = Date.now();
  private maxPong = Date.now() + INTERVALS.pingTimeout;
  private handleTask: Promise<void> | null = null;
  private taskCancelled = false;

  constructor(
    private readonly engine: WsEngine,
    private readonly pool: WebsocketPool,
    private readonly idx: number,
    private readonly url: string = PUBSUB_URL,
    private readonly factory: SocketFactory = defaultSocketFactory,
    private readonly options: SocketOptions = {},
  ) {
    this.setStatus(this.engine.translate("gui", "websocket", "disconnected"));
  }

  get connected(): boolean {
    return this.ws.hasValue();
  }

  waitUntilConnected(): Promise<true> {
    return this.ws.wait();
  }

  private get pingIntervalMs(): number {
    return this.options.pingIntervalMs ?? INTERVALS.ping;
  }

  private get pongTimeoutMs(): number {
    return this.options.pongTimeoutMs ?? INTERVALS.pingTimeout;
  }

  private get recvTimeoutMs(): number {
    return this.options.recvTimeoutMs ?? 500;
  }

  private get connectTimeoutMs(): number {
    return this.options.connectTimeoutMs ?? 15000;
  }

  private logPrefix(): string {
    return `Websocket[${this.idx}]`;
  }

  setStatus(status?: string | null, refreshTopics = false): void {
    this.engine.gui.websockets.update(this.idx, status ?? null, refreshTopics ? this.topics.size : null);
  }

  requestReconnect(): void {
    // Reset the ping clock so a PING goes out right after reconnecting.
    this.nextPing = Date.now();
    this.reconnectRequested.set();
  }

  async start(): Promise<void> {
    this.startNowait();
    await this.waitUntilConnected();
  }

  startNowait(): void {
    if (this.handleTask === null) {
      this.taskCancelled = false;
      this.handleTask = taskWrapper(() => this.handle(), {
        critical: true,
        onCritical: () => this.engine.close(),
        onError: (error) => this.engine.error(`${this.logPrefix()} task died: ${formatTraceback(error)}`),
        name: `websocket-${this.idx}`,
      }).finally(() => {
        this.handleTask = null;
      });
    }
  }

  async stop(remove = false): Promise<void> {
    if (this.closed.isSet()) return;
    this.closed.set();
    this.taskCancelled = true;
    const live = this.ws.getWithDefault(null);
    if (live !== null) {
      this.setStatus(this.engine.translate("gui", "websocket", "disconnecting"));
      live.dispose();
    }
    if (this.handleTask !== null) {
      await Promise.race([this.handleTask, new Promise((resolve) => setTimeout(resolve, 2000))]);
      this.handleTask = null;
    }
    if (remove) {
      this.topics.clear();
      this.topicsChanged.set();
      this.engine.gui.websockets.remove(this.idx);
    }
  }

  stopNowait(remove = false): void {
    void taskWrapper(() => this.stop(remove), {
      onError: (error) => this.engine.error(`${this.logPrefix()} stop failed: ${formatTraceback(error)}`),
      name: `websocket-${this.idx}-stop`,
    }).catch(() => {});
  }

  private async openSocket(): Promise<LiveConnection> {
    let settled = false;
    const opened = new Promise<LiveConnection>((resolve, reject) => {
      const live = new LiveConnection(this.factory(this.url));
      const timer = setTimeout(() => {
        settled = true;
        live.dispose();
        reject(new MinerException("Websocket connect timeout"));
      }, this.connectTimeoutMs);
      live.onOpen = () => {
        if (settled) {
          live.dispose();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(live);
      };
      live.onEarlyClose = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        live.dispose();
        reject(error);
      };
    });
    const stopped = this.closed.wait().then((): LiveConnection => {
      settled = true;
      throw new StopRequested();
    });
    try {
      return await Promise.race([opened, stopped]);
    } finally {
      // A late-opening socket after shutdown still gets disposed.
      void opened.then(
        (live) => {
          if (settled && this.closed.isSet()) live.dispose();
        },
        () => {},
      );
    }
  }

  private async *backoffConnect(): AsyncGenerator<LiveConnection, void, void> {
    // NOTE: proxy tunneling is not supported by the client WebSocket API;
    // `settings.proxy` is accepted for future use (see module docs).
    void this.engine.settings.proxy;
    const backoff = new ExponentialBackoff({ maximum: MAX_BACKOFF_SECONDS });
    for (;;) {
      const delay = backoff.delay();
      let live: LiveConnection;
      try {
        live = await this.openSocket();
      } catch (error) {
        if (error instanceof StopRequested) return;
        this.engine.debug(`${this.logPrefix()} connection problem (sleep: ${Math.round(delay)}s)`);
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
        continue;
      }
      if (this.closed.isSet()) {
        live.dispose();
        return;
      }
      try {
        yield live;
      } finally {
        live.dispose();
      }
      backoff.reset();
    }
  }

  private async handle(): Promise<void> {
    // Ensure we're logged in before connecting.
    this.setStatus(this.engine.translate("gui", "websocket", "initializing"));
    await this.engine.waitUntilLogin();
    if (this.taskCancelled) return;
    this.setStatus(this.engine.translate("gui", "websocket", "connecting"));
    this.engine.info(`${this.logPrefix()} connecting...`);
    this.closed.clear();
    // Connect/reconnect loop.
    for await (const live of this.backoffConnect()) {
      this.ws.set(live);
      this.reconnectRequested.clear();
      // NOTE: topicsChanged intentionally starts unset: there is nothing to
      // subscribe to before the first topic arrives.
      this.setStatus(this.engine.translate("gui", "websocket", "connected"));
      this.engine.info(`${this.logPrefix()} connected.`);
      try {
        try {
          while (!this.reconnectRequested.isSet()) {
            await this.handlePing(live);
            await this.handleTopics(live);
            await this.handleRecv(live);
          }
        } finally {
          this.ws.clear();
          this.submitted.clear();
          // Let the next connection resubscribe to the topics.
          this.topicsChanged.set();
        }
        // A reconnect was requested.
      } catch (error) {
        if (error instanceof WebsocketClosed) {
          if (error.received) {
            this.engine.warn(`${this.logPrefix()} closed unexpectedly`);
          } else if (this.closed.isSet()) {
            this.engine.info(`${this.logPrefix()} stopped.`);
            this.setStatus(this.engine.translate("gui", "websocket", "disconnected"));
            return;
          }
        } else if (error instanceof TaskAbort) {
          return;
        } else {
          this.engine.error(`${this.logPrefix()} exception: ${formatTraceback(error)}`);
        }
      }
      this.setStatus(this.engine.translate("gui", "websocket", "reconnecting"));
      this.engine.warn(`${this.logPrefix()} reconnecting...`);
    }
  }

  private async handlePing(live: LiveConnection): Promise<void> {
    const now = Date.now();
    if (now >= this.nextPing) {
      this.nextPing = now + this.pingIntervalMs;
      this.maxPong = now + this.pongTimeoutMs;
      await this.send(live, { type: "PING" });
    } else if (now >= this.maxPong) {
      // No PONG within the window: force a reconnect.
      this.engine.warn(`${this.logPrefix()} didn't receive a PONG, reconnecting...`);
      this.requestReconnect();
    }
  }

  private async handleTopics(live: LiveConnection): Promise<void> {
    if (!this.topicsChanged.isSet()) return;
    this.topicsChanged.clear();
    this.setStatus(undefined, true);
    const authToken = await this.engine.getAuthToken();
    const current = new Set(this.topics.keys());
    const removed = [...this.submitted].filter((id) => !current.has(id));
    if (removed.length > 0) {
      this.engine.debug(`${this.logPrefix()}: Removing topics: ${removed.join(", ")}`);
      for (const group of chunk(removed, TOPIC_CHUNK)) {
        await this.send(live, { type: "UNLISTEN", data: { topics: group, auth_token: authToken } });
      }
      for (const id of removed) this.submitted.delete(id);
    }
    const added = [...current].filter((id) => !this.submitted.has(id));
    if (added.length > 0) {
      this.engine.debug(`${this.logPrefix()}: Adding topics: ${added.join(", ")}`);
      for (const group of chunk(added, TOPIC_CHUNK)) {
        await this.send(live, { type: "LISTEN", data: { topics: group, auth_token: authToken } });
      }
      for (const id of added) this.submitted.add(id);
    }
  }

  private handleMessage(message: { data?: { topic?: string; message?: string } }): void {
    const topicId = message.data?.topic;
    if (typeof topicId !== "string") return;
    const topic = this.topics.get(topicId);
    if (topic) {
      // Run detached so a slow handler never blocks the socket.
      void Promise.resolve()
        .then(() => topic.process(JSON.parse(message.data?.message ?? "null")))
        .catch((error: unknown) => this.engine.error(`${this.logPrefix()} topic failed: ${formatTraceback(error)}`));
    }
  }

  private async handleRecv(live: LiveConnection): Promise<void> {
    // Listen briefly for incoming messages, then process the batch.
    const raw = await live.receive(this.recvTimeoutMs);
    if (raw === null) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.engine.warn(`${this.logPrefix()} received unknown payload: ${raw}`);
      return;
    }
    const type = message["type"];
    if (type === "MESSAGE") {
      this.handleMessage(message as { data?: { topic?: string; message?: string } });
    } else if (type === "PONG") {
      // Push the deadline far out; the next PING sets a fresh one.
      this.maxPong = this.nextPing;
    } else if (type === "RESPONSE") {
      // No special handling (for now).
    } else if (type === "RECONNECT") {
      this.engine.warn(`${this.logPrefix()} requested reconnect.`);
      this.requestReconnect();
    } else {
      this.engine.warn(`${this.logPrefix()} received unknown payload: ${raw}`);
    }
  }

  addTopics(topics: Set<WsTopic>): void {
    let changed = false;
    while (topics.size > 0 && this.topics.size < LIMITS.wsTopicsLimit) {
      const first = topics.values().next();
      if (first.done) break;
      const topic = first.value;
      topics.delete(topic);
      this.topics.set(topic.id, topic);
      changed = true;
    }
    if (changed) this.topicsChanged.set();
  }

  removeTopics(topicIds: Set<string>): void {
    let changed = false;
    for (const id of [...topicIds]) {
      if (this.topics.delete(id)) {
        topicIds.delete(id);
        changed = true;
      }
    }
    if (changed) this.topicsChanged.set();
  }

  async send(live: LiveConnection, message: Record<string, unknown>): Promise<void> {
    if (message["type"] !== "PING") {
      message["nonce"] = createNonce(CHARS_ASCII, 30);
    }
    try {
      live.socket.send(jsonMinify(message));
    } catch {
      throw new WebsocketClosed("Websocket closed", false);
    }
    this.engine.debug(`${this.logPrefix()} sent: ${jsonMinify(message)}`);
  }

  /** Send on the current connection (throws if not connected). */
  async sendNow(message: Record<string, unknown>): Promise<void> {
    const live = this.ws.getWithDefault(null);
    if (live === null) throw new WebsocketClosed("Websocket closed", false);
    await this.send(live, message);
  }
}

function jsonMinify(data: unknown): string {
  return JSON.stringify(data);
}

export interface PoolOptions {
  url?: string;
  factory?: SocketFactory;
  socketOptions?: SocketOptions;
}

export class WebsocketPool {
  readonly websockets: Websocket[] = [];
  private running = false;

  constructor(
    private readonly engine: WsEngine,
    private readonly options: PoolOptions = {},
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    this.running = true;
    await Promise.all(this.websockets.map((ws) => ws.start()));
  }

  async stop(clearTopics = false): Promise<void> {
    this.running = false;
    await Promise.all(this.websockets.map((ws) => ws.stop(clearTopics)));
  }

  addTopics(topics: Iterable<WsTopic>): void {
    // De-duplicate first, mirroring the Python set semantics.
    const pending = new Map<string, WsTopic>();
    for (const topic of topics) pending.set(topic.id, topic);
    for (const ws of this.websockets) {
      for (const id of [...pending.keys()]) {
        if (ws.topics.has(id)) pending.delete(id);
      }
    }
    if (pending.size === 0) return;
    for (let idx = 0; idx < LIMITS.maxWebsockets; idx++) {
      let ws = this.websockets[idx];
      if (ws === undefined) {
        ws = new Websocket(this.engine, this, idx, this.options.url, this.options.factory, this.options.socketOptions);
        if (this.running) ws.startNowait();
        this.websockets.push(ws);
      }
      // addTopics consumes what the socket takes; leftovers stay in `take`.
      const take = new Set(pending.values());
      ws.addTopics(take);
      pending.clear();
      for (const topic of take) pending.set(topic.id, topic);
      if (pending.size === 0) return;
    }
    throw new MinerException("Maximum topics limit has been reached");
  }

  removeTopics(topicIds: Iterable<string>): void {
    const pending = new Set(topicIds);
    if (pending.size === 0) return;
    for (const ws of this.websockets) ws.removeTopics(pending);
    // Recycle surplus sockets: while the remaining topics fit in one fewer
    // socket, pop the last one and re-add its topics.
    const recycled: WsTopic[] = [];
    for (;;) {
      const count = this.websockets.reduce((sum, ws) => sum + ws.topics.size, 0);
      if (this.websockets.length > 0 && count <= (this.websockets.length - 1) * LIMITS.wsTopicsLimit) {
        const ws = this.websockets.pop()!;
        recycled.push(...ws.topics.values());
        ws.stopNowait(true);
      } else {
        break;
      }
    }
    if (recycled.length > 0) this.addTopics(recycled);
  }
}
