/**
 * Port of `twitch.py`: the mining engine (auth-driven GQL client, inventory,
 * channel selection, watch loop, maintenance) without any UI.
 *
 * The dashboard implements `TwitchGui`; tests use fakes. Transport is an
 * injected `fetch` so the whole engine runs offline in tests.
 *
 * Deviations from Python:
 * - No `aiohttp` session: cookies live in `CookieJar` (`cookies.json`, not
 *   the pickle jar — one re-login on runtime switch) and every request is
 *   an independent `fetch` with `Cookie`/`Set-Cookie` handling.
 * - `request()` returns a buffered response instead of a context manager;
 *   bodies are pre-read like `response.read()`.
 * - Concurrent fan-out uses `Promise.all` (siblings finish instead of being
 *   cancelled on a peer error; GQL calls are idempotent).
 * - `asyncio.Event` loops become `AsyncEvent`; task handles are promises
 *   with a shutdown flag instead of cancellable tasks.
 * - `in` membership on games/channels uses id equality explicitly
 *   (`Game.equals`/`Channel.equals`), matching Python `__eq__`/`__hash__`.
 * - `MAX_INT` is `Number.MAX_SAFE_INTEGER`; trigger sets hold epoch millis.
 */

import { AsyncEvent, RateLimiter, chunk, sleep } from "./async.ts";
import { AuthState } from "./auth.ts";
import { CookieJar } from "./cookies.ts";
import { CaptchaRequired, ExitRequest, GQLException, LoginException, MinerException, ReloadRequest, RequestException } from "./errors.ts";
import { History } from "./history.ts";
import { ExponentialBackoff } from "./backoff.ts";
import { HttpClient, type FetchImpl, type HttpResponse, type RequestOptions } from "./http.ts";
import { format, translate } from "./i18n.ts";
import { Channel, DropsCampaign, type EngineGui, type TimedDrop } from "./models.ts";
import { Settings } from "./settings.ts";
import { Stats } from "./stats.ts";
import { CLIENT_TYPES, EngineState, GQL_QUERIES, LIMITS, INTERVALS, PriorityMode, topicString, type ClientInfo, GqlQuery } from "./twitchProtocol.ts";
import { Game } from "./utils.ts";
import { WebsocketPool, type WsTopic } from "./websocket.ts";

export const MAX_INT = Number.MAX_SAFE_INTEGER;

export interface EngineLoginView {
  askEnterCode(pageUrl: string, userCode: string): Promise<void>;
  askLogin(): Promise<{ username: string; password: string; token: string }>;
  clear(options?: { login?: boolean; password?: boolean; token?: boolean }): void;
  update(status: string, userId: number | null): void;
}

export interface TwitchGui extends EngineGui {
  status: { update(text: string): void; clear(): void };
  login: EngineLoginView;
  helpButton(state: "normal" | "disabled"): void;
  websockets: { update(idx: number, status?: string | null, topics?: number | null): void; remove(idx: number): void };
  progress: { minuteAlmostDone(): boolean; stopTimer(): void };
  channels: EngineGui["channels"] & {
    getSelection(): Channel | null;
    clearWatching(): void;
    setWatching(channel: Channel): void;
    clear(): void;
  };
  inv: EngineGui["inv"] & {
    clear(): void;
    addCampaign(campaign: DropsCampaign): Promise<void>;
  };
  setGames(games: Set<Game>): void;
  print(message: string): void;
  reportNetworkIssue?(url: string): void;
  reportNetworkRecovery?(url: string): void;
  preventClose(): void;
  close(): void;
  save(force?: boolean): void;
  start(): void;
}

export interface EngineOptions {
  dataDir: string;
  settings: Settings;
  gui: TwitchGui;
  clientType?: ClientInfo;
  transport?: FetchImpl;
  pubsubUrl?: string;
  logger?: (level: string, message: string) => void;
}

interface GqlDocument {
  operationName: string;
  variables?: Record<string, unknown>;
}

export class Twitch {
  readonly settings: Settings;
  readonly gui: TwitchGui;
  readonly stats: Stats;
  history: History | null = null;
  historyError: string | null = null;
  paused = false;
  watchingStartedAt: number | null = null;
  lastConfirmedProgressAt: number | null = null;
  wantedGames: Game[] = [];
  inventory: DropsCampaign[] = [];
  readonly watchingChannel = new AwaitableValueImpl<Channel>();
  readonly closeEvent = new AsyncEvent();
  readonly clientInfo: ClientInfo & { userAgent: string };
  readonly cookies: CookieJar;
  readonly cookiesPath: string;
  readonly auth: AuthState;
  readonly websocket: WebsocketPool;
  private readonly http: HttpClient;
  private readonly gqlLimiter = new RateLimiter(5, 1);
  private readonly dataDir: string;
  private readonly logger: (level: string, message: string) => void;
  private state: EngineState = EngineState.IDLE;
  private readonly stateChange = new AsyncEvent();
  private readonly drops = new Map<string, TimedDrop>();
  readonly campaigns = new Map<string, DropsCampaign>();
  private readonly channels = new Map<number, Channel>();
  private readonly mntTriggers: number[] = [];
  private watchingTask: Promise<void> | null = null;
  private mntTask: Promise<void> | null = null;
  private shutdownRequested = false;
  private readonly watchingRestart = new AsyncEvent();

  constructor(options: EngineOptions) {
    const { dataDir, settings, gui } = options;
    this.dataDir = dataDir;
    this.settings = settings;
    this.gui = gui;
    this.logger = options.logger ?? ((level, message) => console.log(`[${level}] ${message}`));
    const clientType = options.clientType ?? CLIENT_TYPES.ANDROID_APP;
    const agents = clientType.userAgents;
    this.clientInfo = { ...clientType, userAgent: agents[Math.floor(Math.random() * agents.length)]! };
    this.stats = new Stats(`${dataDir}/stats.json`);
    try {
      this.history = new History(`${dataDir}/history.sqlite3`);
    } catch (error) {
      this.historyError = String(error);
      this.warn(`Reward history is unavailable: ${error}`);
    }
    this.cookiesPath = `${dataDir}/cookies.json`;
    this.cookies = CookieJar.loadFile(this.cookiesPath);
    this.http = new HttpClient(
      {
        closeEvent: this.closeEvent,
        connectionQuality: () => this.clampedQuality(),
        reportIssue: (url) => this.gui.reportNetworkIssue?.(url),
        reportRecovery: (url) => this.gui.reportNetworkRecovery?.(url),
        print: (message) => this.print(message),
      },
      options.transport,
    );
    this.auth = new AuthState({
      gui: { login: gui.login, helpButton: (state) => gui.helpButton(state) },
      cookies: this.cookies,
      cookiesPath: this.cookiesPath,
      clientInfo: this.clientInfo,
      print: (message) => this.print(message),
      request: (method, url, opts) => this.request(method, url, opts as RequestOptions),
    });
    this.websocket = new WebsocketPool(
      {
        settings: { proxy: settings.proxy },
        gui: { websockets: gui.websockets },
        translate: (section, key, sub) => translate(section, key, sub),
        debug: (m) => this.log("debug", m),
        info: (m) => this.log("info", m),
        warn: (m) => this.log("warn", m),
        error: (m) => this.log("error", m),
        waitUntilLogin: () => this.auth.waitUntilLogin(),
        getAuthToken: async () => {
          await this.auth.validate();
          if (!this.auth.accessToken) throw new MinerException("Not authenticated");
          return this.auth.accessToken;
        },
        close: () => this.close(),
      },
      { url: options.pubsubUrl },
    );
  }

  // -- models.EngineLike -------------------------------------------------

  get authUserId(): string | number | null {
    return this.auth.userId ?? null;
  }

  get clientUrl(): string {
    return this.clientInfo.clientUrl;
  }

  get campaignMap(): Map<string, DropsCampaign> {
    return this.campaigns;
  }

  translate(section: string, key: string, subkey?: string): string {
    return translate(section, key, subkey);
  }

  print(message: string): void {
    this.gui.print(message);
  }

  warn(message: string): void {
    this.log("warn", message);
  }

  changeState(state: EngineState, force = false): void {
    // Background work must preserve the user's pause; explicit actions
    // bypass with force=True.
    if (this.paused && !force && state !== EngineState.IDLE && state !== EngineState.RESTART && state !== EngineState.EXIT) {
      return;
    }
    if (this.state !== EngineState.EXIT) {
      // No state changes once EXIT is entered.
      this.state = state;
    }
    this.stateChange.set();
  }

  stateChangeFn(state: EngineState): () => void {
    return () => this.changeState(state);
  }

  close(): void {
    this.changeState(EngineState.EXIT);
  }

  preventClose(): void {
    this.gui.preventClose();
  }

  save(force = false): void {
    this.gui.save(force);
    this.settings.save(force);
  }

  recordClaimHistory(drop: TimedDrop): void {
    this.recordHistory("record_claim", drop);
  }

  async getAuth(): Promise<{ user_id: string | number }> {
    await this.auth.validate();
    if (this.auth.userId === undefined) throw new MinerException("Not authenticated");
    return { user_id: this.auth.userId };
  }

  async request(
    method: string,
    url: string,
    options: { headers?: Record<string, string>; data?: Record<string, string>; json?: unknown; invalidateAfter?: Date } = {},
  ): Promise<HttpResponse> {
    const cookie = this.cookies.headerFor(String(url));
    const response = await this.http.request(method, String(url), {
      headers: options.headers,
      data: options.data,
      json: options.json,
      invalidateAfter: options.invalidateAfter,
      ...(this.settings.proxy ? { proxy: this.settings.proxy } : {}),
      ...(cookie ? { cookie } : {}),
    });
    this.cookies.storeFromHeaders(String(url), response.headers);
    return response;
  }

  // -- internal helpers --------------------------------------------------

  private log(level: string, message: string): void {
    this.logger(level, message);
  }

  private clampedQuality(): number {
    const quality = Math.round(this.settings.connection_quality);
    const clamped = Math.min(6, Math.max(1, quality));
    if (clamped !== this.settings.connection_quality) this.settings.set("connection_quality", clamped);
    return clamped;
  }

  waitUntilLogin(): Promise<true> {
    return this.auth.waitUntilLogin();
  }

  getAuthState(): AuthState {
    return this.auth;
  }

  secondsWithoutProgress(): number | null {
    if (this.paused || this.watchingStartedAt === null) return null;
    let baseline = this.watchingStartedAt;
    if (this.lastConfirmedProgressAt !== null) baseline = Math.max(baseline, this.lastConfirmedProgressAt);
    return (performance.now() - baseline) / 1000;
  }

  updateConfirmedMinutes(drop: TimedDrop, minutes: number): void {
    const previous = drop.realCurrentMinutes;
    drop.updateMinutes(minutes);
    if (drop.realCurrentMinutes > previous) this.lastConfirmedProgressAt = performance.now();
  }

  private recordHistory(operation: "ingest_inventory" | "record_claim" | "record_campaigns", value: unknown): void {
    const accountId = this.auth.userId;
    if (!this.history || accountId === undefined) return;
    try {
      const history = this.history;
      if (operation === "ingest_inventory") history.ingestInventory(String(accountId), value);
      else if (operation === "record_claim") history.recordClaim(String(accountId), value as Parameters<History["recordClaim"]>[1]);
      else history.recordCampaigns(String(accountId), value as Parameters<History["recordCampaigns"]>[1]);
      this.historyError = null;
    } catch (error) {
      // Optional local history must never interrupt mining or a claim.
      this.historyError = String(error);
      this.warn(`Could not update reward history: ${error}`);
    }
  }

  getPriority(channel: Channel): number {
    const game = channel.game;
    if (game === null || !this.wantedGames.some((wanted) => wanted.equals(game))) return MAX_INT;
    return this.wantedGames.findIndex((wanted) => wanted.equals(game));
  }

  static viewersKey(channel: Channel): number {
    return channel.viewers ?? -1;
  }

  // -- main loop ----------------------------------------------------------

  async run(): Promise<void> {
    if (this.settings.get("dump")) {
      await Bun.write(`${this.dataDir}/dump.dat`, "");
    }
    for (;;) {
      try {
        await this.runOnce();
        return;
      } catch (error) {
        if (error instanceof ReloadRequest) {
          await this.shutdown(true);
        } else if (error instanceof ExitRequest) {
          return;
        } else if (error instanceof SyntaxError) {
          throw new RequestException(translate("login", "unexpected_content"));
        } else {
          throw error;
        }
      }
    }
  }

  private async runOnce(): Promise<void> {
    this.gui.start();
    const auth = await this.getAuth();
    await this.websocket.start();
    // The watch task restarts on each new run.
    this.watchingTask = this.watchLoopGuarded();
    this.websocket.addTopics([
      { id: topicString("User", "Drops", Number(auth.user_id)), targetId: Number(auth.user_id), process: (m) => void this.processDrops(Number(auth.user_id), m as Record<string, unknown>) },
      { id: topicString("User", "Notifications", Number(auth.user_id)), targetId: Number(auth.user_id), process: (m) => void this.processNotifications(Number(auth.user_id), m as Record<string, unknown>) },
    ]);
    let fullCleanup = false;
    const channels = this.channels;
    this.changeState(this.paused ? EngineState.IDLE : EngineState.INVENTORY_FETCH);
    for (;;) {
      if (this.state === EngineState.IDLE) {
        if (this.settings.get("dump")) {
          this.gui.close();
          continue;
        }
        this.gui.notifier.set_activity("idle");
        this.gui.status.update(translate("gui", "status", "idle"));
        this.stopWatching();
        this.stateChange.clear();
      } else if (this.state === EngineState.INVENTORY_FETCH) {
        this.gui.notifier.set_activity("maint");
        await this.websocket.start();
        await this.fetchInventory();
        this.gui.setGames(new Set([...this.inventory].map((c) => c.game)));
        this.save();
        this.changeState(EngineState.GAMES_UPDATE);
      } else if (this.state === EngineState.GAMES_UPDATE) {
        for (const campaign of this.inventory) {
          if (!campaign.upcoming) {
            for (const drop of campaign.drops) {
              if (drop.canClaim) await drop.claim();
            }
          }
        }
        this.wantedGames.length = 0;
        const exclude = this.settings.exclude;
        const priority = this.settings.priority;
        const priorityMode = this.settings.priority_mode;
        const priorityOnly = priorityMode === PriorityMode.PRIORITY_ONLY;
        const nextHour = new Date(Date.now() + 3600 * 1000);
        const sorted = [...this.inventory];
        if (!priorityOnly) {
          if (priorityMode === PriorityMode.ENDING_SOONEST) sorted.sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime());
          else if (priorityMode === PriorityMode.LOW_AVBL_FIRST) sorted.sort((a, b) => a.availability - b.availability);
        }
        // Stable: priority names first, everything else keeps its order.
        sorted.sort((a, b) => {
          const ai = priority.includes(a.game.name) ? priority.indexOf(a.game.name) : MAX_INT;
          const bi = priority.includes(b.game.name) ? priority.indexOf(b.game.name) : MAX_INT;
          return ai - bi;
        });
        for (const campaign of sorted) {
          const game = campaign.game;
          if (
            !this.wantedGames.some((w) => w.equals(game)) &&
            !exclude.has(game.name) &&
            (!priorityOnly || priority.includes(game.name)) &&
            campaign.canEarnWithin(nextHour)
          ) {
            this.wantedGames.push(game);
          }
        }
        fullCleanup = true;
        this.restartWatching();
        this.changeState(EngineState.CHANNELS_CLEANUP);
      } else if (this.state === EngineState.CHANNELS_CLEANUP) {
        this.gui.status.update(translate("gui", "status", "cleanup"));
        let toRemove: Channel[];
        if (this.wantedGames.length === 0 || fullCleanup) {
          toRemove = [...channels.values()];
        } else {
          toRemove = [...channels.values()].filter(
            (channel) =>
              !channel.aclBased &&
              (channel.offline || channel.game === null || !this.wantedGames.some((w) => w.equals(channel.game!))),
          );
        }
        fullCleanup = false;
        if (toRemove.length > 0) {
          const topics: string[] = [];
          for (const channel of toRemove) {
            topics.push(topicString("Channel", "StreamState", channel.id), topicString("Channel", "StreamUpdate", channel.id));
          }
          this.websocket.removeTopics(topics);
          for (const channel of toRemove) {
            channels.delete(channel.id);
            channel.remove();
          }
        }
        if (this.wantedGames.length > 0) {
          this.changeState(EngineState.CHANNELS_FETCH);
        } else {
          this.print(translate("status", "no_campaign"));
          this.changeState(EngineState.IDLE);
        }
      } else if (this.state === EngineState.CHANNELS_FETCH) {
        this.gui.status.update(translate("gui", "status", "gathering"));
        const fresh = new Map<number, Channel>(channels);
        channels.clear();
        this.gui.channels.clear();
        const noAcl = new Map<number, Game>();
        const aclChannels = new Map<number, Channel>();
        const nextHour = new Date(Date.now() + 3600 * 1000);
        for (const campaign of this.inventory) {
          if (this.wantedGames.some((w) => w.equals(campaign.game)) && campaign.canEarnWithin(nextHour)) {
            if (campaign.allowedChannels.length > 0) {
              for (const channel of campaign.allowedChannels) aclChannels.set(channel.id, channel);
            } else {
              noAcl.set(campaign.game.id, campaign.game);
            }
          }
        }
        for (const id of fresh.keys()) aclChannels.delete(id);
        await this.bulkCheckOnline([...aclChannels.values()]);
        for (const [id, channel] of aclChannels) fresh.set(id, channel);
        if (noAcl.size > 0) {
          const fetched = await Promise.all([...noAcl.values()].map((game) => this.getLiveStreams(game, 20, true)));
          for (const list of fetched) for (const channel of list) fresh.set(channel.id, channel);
        }
        // Viewers desc, ACL first, game priority — stable sorts in order.
        const ordered = [...fresh.values()].sort((a, b) => Twitch.viewersKey(b) - Twitch.viewersKey(a));
        ordered.sort((a, b) => Number(b.aclBased) - Number(a.aclBased));
        ordered.sort((a, b) => this.getPriority(a) - this.getPriority(b));
        const trimmed = ordered.slice(0, LIMITS.maxChannels);
        if (ordered.length > trimmed.length) {
          const topics: string[] = [];
          for (const channel of ordered.slice(trimmed.length)) {
            topics.push(topicString("Channel", "StreamState", channel.id), topicString("Channel", "StreamUpdate", channel.id));
          }
          this.websocket.removeTopics(topics);
        }
        for (const channel of trimmed) {
          channels.set(channel.id, channel);
          channel.display({ add: true });
        }
        const topics: WsTopic[] = [];
        for (const id of channels.keys()) {
          topics.push(
            { id: topicString("Channel", "StreamState", id), targetId: id, process: (m) => void this.processStreamState(id, m as Record<string, unknown>) },
            { id: topicString("Channel", "StreamUpdate", id), targetId: id, process: (m) => void this.processStreamUpdate(id, m as Record<string, unknown>) },
          );
        }
        this.websocket.addTopics(topics);
        const watching = this.watchingChannel.getWithDefault(null);
        if (watching !== null) {
          const replacement = channels.get(watching.id) ?? null;
          if (replacement !== null && this.canWatch(replacement)) {
            this.watch(replacement, false);
          } else {
            this.stopWatching();
          }
        }
        for (const channel of channels.values()) {
          if (!this.canWatch(channel)) continue;
          const active = this.getActiveCampaign(channel);
          const first = active?.firstDrop ?? null;
          if (active && first) {
            first.display({ countdown: false, subone: true });
          }
          break;
        }
        this.changeState(EngineState.CHANNEL_SWITCH);
      } else if (this.state === EngineState.CHANNEL_SWITCH) {
        if (this.settings.get("dump")) {
          this.gui.close();
          continue;
        }
        this.gui.status.update(translate("gui", "status", "switching"));
        let next: Channel | null = null;
        const selected = this.gui.channels.getSelection();
        if (selected !== null && this.canWatch(selected)) {
          next = selected;
        } else {
          const ranked = [...channels.values()].sort((a, b) => this.getPriority(a) - this.getPriority(b));
          for (const channel of ranked) {
            if (this.shouldSwitch(channel)) {
              next = channel;
              break;
            }
          }
        }
        const watching = this.watchingChannel.getWithDefault(null);
        if (next !== null) {
          this.watch(next);
          this.stateChange.clear();
        } else if (watching !== null && this.canWatch(watching)) {
          this.gui.status.update(format(translate("status", "watching"), { channel: watching.name }));
          this.stateChange.clear();
        } else {
          this.print(translate("status", "no_channel"));
          this.changeState(EngineState.IDLE);
        }
      } else if (this.state === EngineState.RESTART) {
        throw new ReloadRequest();
      } else if (this.state === EngineState.EXIT) {
        this.gui.notifier.set_activity("pickaxe");
        this.gui.status.update(translate("gui", "status", "exiting"));
        return;
      }
      await this.stateChange.wait();
    }
  }

  // -- watch loop ---------------------------------------------------------

  private async watchSleep(delaySeconds: number): Promise<void> {
    this.watchingRestart.clear();
    const handle = this.watchingRestart.waitHandle();
    try {
      await Promise.race([sleep(delaySeconds * 1000), handle.promise]);
    } finally {
      handle.cancel();
    }
  }

  private watchLoopGuarded(): Promise<void> {
    const task = (async () => {
      try {
        await this.watchLoop();
      } catch (error) {
        this.log("error", `Watch loop died: ${error instanceof Error ? error.stack ?? error : error}`);
        this.close();
        throw error;
      }
    })();
    task.catch(() => {});
    return task;
  }

  private async watchLoop(): Promise<void> {
    const interval = INTERVALS.watch / 1000;
    for (;;) {
      if (this.shutdownRequested) return;
      const channel = await this.watchingChannel.get();
      if (this.shutdownRequested) return;
      if (!channel.online) {
        this.stopWatching();
        continue;
      }
      const succeeded = await channel.sendWatch();
      this.stats.heartbeat(succeeded);
      if (this.paused || this.watchingChannel.getWithDefault(null) !== channel) continue;
      const lastSent = Date.now();
      await sleep(20 * 1000);
      if (this.shutdownRequested) return;
      if (this.paused || this.watchingChannel.getWithDefault(null) !== channel) continue;
      if (this.gui.progress.minuteAlmostDone()) {
        let handled = false;
        let dropData: Record<string, unknown> | null = null;
        try {
          const context = await this.gqlRequest(GQL_QUERIES["CurrentDrop"]!.withVariables({ channelID: String(channel.id) }));
          dropData = ((context["data"] as Record<string, unknown>)["currentUser"] as Record<string, unknown>)["dropCurrentSession"] as Record<string, unknown> | null;
        } catch (error) {
          if (!(error instanceof GQLException)) throw error;
        }
        if (this.paused || this.watchingChannel.getWithDefault(null) !== channel) continue;
        if (dropData !== null) {
          const gqlDrop = this.drops.get(dropData["dropID"] as string) ?? null;
          if (gqlDrop !== null && gqlDrop.canEarn(channel)) {
            this.updateConfirmedMinutes(gqlDrop, dropData["currentMinutesWatched"] as number);
            handled = true;
          }
        }
        if (!handled) {
          const active = this.getActiveCampaign(channel);
          if (active) {
            active.bumpMinutes(channel);
            active.firstDrop?.display();
            handled = true;
          }
        }
        void handled;
      }
      await this.watchSleep(interval - Math.min((Date.now() - lastSent) / 1000, interval));
    }
  }

  private maintenanceGuarded(): Promise<void> {
    const task = (async () => {
      try {
        await this.maintenanceTask();
      } catch (error) {
        this.log("error", `Maintenance task died: ${error instanceof Error ? error.stack ?? error : error}`);
        this.close();
        throw error;
      }
    })();
    task.catch(() => {});
    return task;
  }

  private async maintenanceTask(): Promise<void> {
    const start = Date.now();
    const periodEnd = start + 3600 * 1000;
    for (;;) {
      const now = Date.now();
      if (now >= periodEnd) break;
      let nextTrigger = periodEnd;
      while (this.mntTriggers.length > 0 && this.mntTriggers[0]! <= nextTrigger) {
        nextTrigger = this.mntTriggers.shift()!;
      }
      await sleep(Math.max(0, nextTrigger - Date.now()));
      if (this.shutdownRequested) return;
      if (Date.now() >= periodEnd) break;
      if (nextTrigger !== periodEnd) {
        this.changeState(EngineState.CHANNELS_CLEANUP);
      }
    }
    this.changeState(EngineState.INVENTORY_FETCH);
  }

  // -- selection -----------------------------------------------------------

  canWatch(channel: Channel): boolean {
    if (!channel.online) return false;
    for (const campaign of this.inventory) {
      if (
        campaign.canEarn(channel) &&
        (channel.game !== null && channel.dropsEnabled && this.wantedGames.some((w) => w.equals(channel.game!)) ||
          campaign.game.isSpecial())
      ) {
        return true;
      }
    }
    return false;
  }

  shouldSwitch(channel: Channel): boolean {
    if (this.paused || !this.canWatch(channel)) return false;
    const watching = this.watchingChannel.getWithDefault(null);
    if (watching === null || !this.canWatch(watching)) return true;
    const order = this.getPriority(channel);
    const watchingOrder = this.getPriority(watching);
    return order < watchingOrder || (order === watchingOrder && Number(channel.aclBased) > Number(watching.aclBased));
  }

  watch(channel: Channel, updateStatus = true): void {
    if (this.paused) return;
    if (this.watchingStartedAt === null) this.watchingStartedAt = performance.now();
    const previous = this.watchingChannel.getWithDefault(null);
    if (previous === null || previous.id !== channel.id) {
      this.stats.increment("channel_switches");
    }
    this.gui.notifier.set_activity("active");
    this.gui.channels.setWatching(channel);
    this.watchingChannel.set(channel);
    if (updateStatus) {
      const text = format(translate("status", "watching"), { channel: channel.name });
      this.print(text);
      this.gui.status.update(text);
    }
  }

  stopWatching(): void {
    this.watchingStartedAt = null;
    this.gui.clearDrop();
    this.watchingChannel.clear();
    this.gui.channels.clearWatching();
  }

  restartWatching(): void {
    this.gui.progress.stopTimer();
    this.watchingRestart.set();
  }

  pause(): void {
    this.paused = true;
    this.stopWatching();
    this.changeState(EngineState.IDLE);
  }

  resume(): void {
    this.paused = false;
    this.changeState(EngineState.INVENTORY_FETCH);
  }

  // -- websocket handlers ----------------------------------------------------

  async processStreamState(channelId: number, message: Record<string, unknown>): Promise<void> {
    const type = message["type"];
    const channel = this.channels.get(channelId);
    if (!channel) {
      this.log("error", `Stream state change for a non-existing channel: ${channelId}`);
      return;
    }
    if (type === "viewcount") {
      if (!channel.online) {
        channel.checkOnline();
      } else {
        channel.viewers = message["viewers"] as number;
        channel.display();
      }
    } else if (type === "stream-down") {
      channel.setOffline();
    } else if (type === "stream-up") {
      channel.checkOnline();
    } else if (type !== "commercial") {
      this.log("warn", `Unknown stream state: ${type}`);
    }
  }

  async processStreamUpdate(channelId: number, message: Record<string, unknown>): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) {
      this.log("error", `Broadcast settings update for a non-existing channel: ${channelId}`);
      return;
    }
    channel.checkOnline();
  }

  onChannelUpdate(channel: Channel, before: import("./models.ts").Stream | null, after: import("./models.ts").Stream | null): void {
    if (before === null) {
      if (after !== null) {
        if (this.shouldSwitch(channel)) {
          this.print(format(translate("status", "goes_online"), { channel: channel.name }));
          this.watch(channel);
        } else {
          this.log("info", `${channel.name} goes ONLINE`);
        }
      }
    } else {
      const watching = this.watchingChannel.getWithDefault(null);
      if (watching !== null && watching.equals(channel)) {
        if (!this.canWatch(channel)) {
          if (after === null) {
            this.print(format(translate("status", "goes_offline"), { channel: channel.name }));
          } else {
            this.log("info", `${channel.name} status has been updated, switching...`);
          }
          this.changeState(EngineState.CHANNEL_SWITCH);
        }
      } else if (after === null) {
        this.log("info", `${channel.name} goes OFFLINE`);
      } else {
        this.log("info", `${channel.name} status has been updated`);
        if (this.shouldSwitch(channel)) this.watch(channel);
      }
    }
    channel.display();
  }

  async processDrops(userId: number, message: Record<string, unknown>): Promise<void> {
    const type = message["type"];
    if (type !== "drop-progress" && type !== "drop-claim") return;
    const data = message["data"] as Record<string, unknown>;
    const dropId = data["drop_id"] as string;
    const drop = this.drops.get(dropId) ?? null;
    const watching = this.watchingChannel.getWithDefault(null);
    void userId;
    if (type === "drop-claim") {
      if (!drop) {
        this.log("error", `Received a drop claim ID for a non-existing drop: ${dropId}\nDrop claim ID: ${data["drop_instance_id"]}`);
        return;
      }
      drop.updateClaim(data["drop_instance_id"] as string);
      const campaign = drop.campaign;
      await drop.claim();
      drop.display();
      await sleep(4000);
      if (watching !== null) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const context = await this.gqlRequest(GQL_QUERIES["CurrentDrop"]!.withVariables({ channelID: String(watching.id) }));
          const current = ((context["data"] as Record<string, unknown>)["currentUser"] as Record<string, unknown>)["dropCurrentSession"] as Record<string, unknown> | null;
          if (current === null || current["dropID"] !== drop.id) break;
          await sleep(2000);
        }
      }
      if (campaign.canEarn(watching)) {
        this.restartWatching();
      } else {
        this.changeState(EngineState.INVENTORY_FETCH);
      }
      return;
    }
    if (drop !== null && drop.canEarn(this.watchingChannel.getWithDefault(null))) {
      this.updateConfirmedMinutes(drop, data["current_progress_min"] as number);
    }
  }

  async processNotifications(_userId: number, message: Record<string, unknown>): Promise<void> {
    if (message["type"] !== "create-notification") return;
    const data = (message["data"] as Record<string, unknown>)["notification"] as Record<string, unknown>;
    if (
      data["type"] === "user_drop_reward_reminder_notification" ||
      data["type"] === "quests_viewer_reward_campaign_earned_emote"
    ) {
      this.changeState(EngineState.INVENTORY_FETCH);
      await this.gqlRequest(GQL_QUERIES["NotificationsDelete"]!.withVariables({ input: { id: data["id"] } }));
    }
  }

  // -- GQL client --------------------------------------------------------------

  async gqlRequest(ops: GqlQuery | Record<string, unknown>): Promise<Record<string, unknown>>;
  async gqlRequest(ops: Array<GqlQuery | Record<string, unknown>>): Promise<Array<Record<string, unknown>>>;
  async gqlRequest(
    ops: GqlQuery | Record<string, unknown> | Array<GqlQuery | Record<string, unknown>>,
  ): Promise<Record<string, unknown> | Array<Record<string, unknown>>> {
    const backoff = new ExponentialBackoff({ maximum: 60 });
    let singleRetry = true;
    for (;;) {
      const delay = backoff.delay();
      const result = await this.gqlLimiter.run(async () => {
        await this.getAuth();
        const body = Array.isArray(ops) ? ops.map((op) => (op instanceof GqlQuery ? op.toJSON() : op)) : ops instanceof GqlQuery ? ops.toJSON() : ops;
        return this.request("POST", "https://gql.twitch.tv/gql", {
          json: body,
          headers: this.auth.headers({ userAgent: this.clientInfo.userAgent, gql: true }),
        });
      });
      const parsed = (await result.json()) as Record<string, unknown> | Array<Record<string, unknown>>;
      const original = parsed;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      let forceRetry = false;
      let completed = false;
      for (const item of list) {
        if ("errors" in item && Array.isArray(item["errors"])) {
          let itemHandled = false;
          for (const errorDict of item["errors"] as Array<Record<string, unknown>>) {
            if (typeof errorDict["message"] !== "string") continue;
            const message = errorDict["message"] as string;
            if (singleRetry && (message === "service error" || message === "PersistedQueryNotFound")) {
              singleRetry = false;
              forceRetry = true;
              itemHandled = true;
              break;
            } else if (message === "server error") {
              const data = (item as Record<string, unknown>)["data"] as Record<string, unknown>;
              const path = (errorDict["path"] as string[]) ?? [];
              let target = data;
              for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
              target[path[path.length - 1]!] = null;
              itemHandled = true;
              break;
            } else if (message === "service timeout" || message === "service unavailable" || message === "context deadline exceeded") {
              forceRetry = true;
              itemHandled = true;
              break;
            }
          }
          if (!itemHandled) throw new GQLException(JSON.stringify((item["errors"] as unknown[])));
        } else if ("error" in item) {
          throw new GQLException(`${item["error"]}: ${item["message"]}`);
        }
      }
      if (!forceRetry) {
        completed = true;
        return original as Record<string, unknown> | Array<Record<string, unknown>>;
      }
      void completed;
      // Single-retry overwrite for very short delays, like Python.
      await sleep(Math.max(delay, forceRetry && delay < 5 && !singleRetry ? delay : delay) * 1000);
    }
  }

  // -- inventory ---------------------------------------------------------------

  mergeData(primary: Record<string, unknown>, secondary: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(primary), ...Object.keys(secondary)])) {
      const inPrimary = key in primary;
      if (inPrimary && key in secondary) {
        const vp = primary[key];
        const vs = secondary[key];
        if ( kindOf(vp) !== kindOf(vs)) throw new MinerException("Inconsistent merge data");
        merged[key] = isObject(vp) && isObject(vs) ? this.mergeData(vp as Record<string, unknown>, vs as Record<string, unknown>) : vp;
      } else if (inPrimary) {
        merged[key] = primary[key];
      } else {
        merged[key] = secondary[key];
      }
    }
    return merged;
  }

  async fetchCampaigns(campaignsChunk: Array<[string, Record<string, unknown>]>): Promise<Map<string, Record<string, unknown>>> {
    const ids = new Map(campaignsChunk);
    const auth = await this.getAuth();
    const responses = (await this.gqlRequest(
      [...ids.keys()].map((cid) => GQL_QUERIES["CampaignDetails"]!.withVariables({ channelLogin: String(auth.user_id), dropID: cid })),
    )) as Array<Record<string, unknown>>;
    const fetched = new Map<string, Record<string, unknown>>();
    for (const item of responses) {
      const campaign = ((item["data"] as Record<string, unknown>)["user"] as Record<string, unknown>)["dropCampaign"] as Record<string, unknown> | null;
      if (campaign !== null) fetched.set(campaign["id"] as string, campaign);
    }
    const merged = new Map<string, Record<string, unknown>>();
    for (const [key, value] of ids) merged.set(key, value);
    for (const [key, value] of fetched) {
      const prior = merged.get(key);
      merged.set(key, prior ? this.mergeData(prior, value) : value);
    }
    return merged;
  }

  async fetchInventory(): Promise<void> {
    const statusUpdate = (text: string): void => this.gui.status.update(text);
    statusUpdate(translate("gui", "status", "fetching_inventory"));
    const inventoryResponse = (await this.gqlRequest(GQL_QUERIES["Inventory"]!)) as Record<string, unknown>;
    const inventory = (inventoryResponse["data"] as Record<string, unknown>)["currentUser"] as Record<string, Record<string, unknown>>;
    const gameEventDrops = ((inventory["inventory"] as Record<string, unknown[]>)["gameEventDrops"] ?? []) as Array<Record<string, unknown>>;
    this.recordHistory("ingest_inventory", gameEventDrops);
    const ongoing = (((inventory["inventory"] as Record<string, unknown>)["dropCampaignsInProgress"] as Array<Record<string, unknown>> | null) ?? []) as Array<Record<string, unknown>>;
    const claimedBenefits = new Map<string, Date>();
    for (const row of gameEventDrops) {
      if (typeof row["id"] === "string" && typeof row["lastAwardedAt"] === "string") {
        claimedBenefits.set(row["id"] as string, new Date(row["lastAwardedAt"] as string));
      }
    }
    const inventoryData = new Map<string, Record<string, unknown>>(ongoing.map((c) => [c["id"] as string, c]));
    const campaignsResponse = (await this.gqlRequest(GQL_QUERIES["Campaigns"]!)) as Record<string, unknown>;
    const available = ((((campaignsResponse["data"] as Record<string, unknown>)["currentUser"] as Record<string, unknown>)["dropCampaigns"] as Array<Record<string, unknown>> | null) ?? []).filter(
      (c) => c["status"] === "ACTIVE" || c["status"] === "UPCOMING",
    );
    statusUpdate(translate("gui", "status", "fetching_campaigns"));
    const chunks = chunk([...available.map((c) => [c["id"], c] as [string, Record<string, unknown>])], 20);
    const fetchedChunks = await Promise.all(chunks.map((c) => this.fetchCampaigns(c)));
    for (const part of fetchedChunks) {
      for (const [key, value] of part) {
        inventoryData.set(key, inventoryData.has(key) ? this.mergeData(inventoryData.get(key)!, value) : value);
      }
    }
    for (const [id, data] of [...inventoryData]) {
      if (data["game"] === null || data["game"] === undefined) inventoryData.delete(id);
    }
    if (this.settings.get("dump")) {
      try {
        const { statSync, unlinkSync, appendFileSync } = await import("node:fs");
        const dumpPath = `${this.dataDir}/dump.dat`;
        try {
          if (statSync(dumpPath).size > 5 * 1024 * 1024) unlinkSync(dumpPath);
        } catch {
          // Missing file: nothing to rotate.
        }
        const dumpable: Record<string, Record<string, unknown>> = {};
        for (const [key, value] of inventoryData) dumpable[key] = JSON.parse(JSON.stringify(value));
        for (const campaign of Object.values(dumpable)) {
          const record = campaign as Record<string, Record<string, unknown>>;
          const allow = record["allow"] as { isEnabled?: boolean; channels?: unknown[] } | null;
          if (allow && allow.isEnabled !== false && allow.channels) {
            allow.channels = `${allow.channels.length} channels` as unknown as unknown[];
          }
          for (const drop of ((record["timeBasedDrops"] as unknown as Array<Record<string, Record<string, unknown>>> | null) ?? [])) {
            if (drop["self"]?.["dropInstanceID"]) drop["self"]["dropInstanceID"] = "...";
          }
        }
        appendFileSync(dumpPath, JSON.stringify(dumpable, null, 4) + "\n\n");
        appendFileSync(dumpPath, JSON.stringify(gameEventDrops, null, 4));
      } catch {
        // Best-effort diagnostics dump; never break mining.
      }
    }
    const campaigns = [...inventoryData.values()].map((data) => new DropsCampaign(this, data as never, claimedBenefits));
    this.recordHistory("record_campaigns", campaigns);
    campaigns.sort((a, b) => Number(b.active) - Number(a.active));
    campaigns.sort((a, b) => {
      const ka = a.upcoming ? a.startsAt.getTime() : a.endsAt.getTime();
      const kb = b.upcoming ? b.startsAt.getTime() : b.endsAt.getTime();
      return ka - kb;
    });
    campaigns.sort((a, b) => Number(b.eligible) - Number(a.eligible));
    this.drops.clear();
    this.gui.inv.clear();
    this.inventory.length = 0;
    this.campaigns.clear();
    this.mntTriggers.length = 0;
    const switchTriggers = new Set<number>();
    const nextHour = new Date(Date.now() + 3600 * 1000);
    for (const campaign of campaigns) {
      for (const drop of campaign.drops) this.drops.set(drop.id, drop);
      if (campaign.canEarnWithin(nextHour)) {
        for (const trigger of campaign.timeTriggers) switchTriggers.add(trigger);
      }
      this.inventory.push(campaign);
      this.campaigns.set(campaign.id, campaign);
    }
    let counter = 0;
    const total = campaigns.length;
    const updateAdding = (): void => {
      counter += 1;
      statusUpdate(format(translate("gui", "status", "adding_campaigns"), { counter: `(${counter}/${total})` }));
      if (this.closeEvent.isSet()) throw new ExitRequest();
    };
    statusUpdate(format(translate("gui", "status", "adding_campaigns"), { counter: `(0/${total})` }));
    await Promise.all(
      campaigns.map((campaign) => this.gui.inv.addCampaign(campaign).then(() => updateAdding())),
    );
    this.mntTriggers.push(...[...switchTriggers].sort((a, b) => a - b));
    const now = Date.now();
    while (this.mntTriggers.length > 0 && this.mntTriggers[0]! <= now) this.mntTriggers.shift();
    this.mntTask = this.maintenanceGuarded();
  }

  getActiveCampaign(channel: Channel | null = null): DropsCampaign | null {
    if (this.wantedGames.length === 0) return null;
    const watching = this.watchingChannel.getWithDefault(channel);
    if (watching === null) return null;
    const earnable = this.inventory.filter((c) => c.canEarn(watching));
    if (earnable.length === 0) return null;
    earnable.sort((a, b) => a.remainingMinutes - b.remainingMinutes);
    return earnable[0]!;
  }

  async getLiveStreams(game: Game, limit = 20, dropsEnabled = true): Promise<Channel[]> {
    const filters: string[] = [];
    if (dropsEnabled) filters.push("DROPS_ENABLED");
    let response: Record<string, unknown> | Array<Record<string, unknown>>;
    try {
      response = (await this.gqlRequest(
        GQL_QUERIES["GameDirectory"]!.withVariables({
          limit,
          slug: game.slug,
          options: { includeRestricted: ["SUB_ONLY_LIVE"], systemFilters: filters },
        }),
      )) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof GQLException) throw new MinerException(`Game: ${game.slug}`);
      throw error;
    }
    const data = response["data"] as Record<string, unknown>;
    if (typeof data["game"] !== "object" || data["game"] === null) return [];
    const streams = (data["game"] as Record<string, unknown>)["streams"] as Record<string, unknown>;
    const edges = (streams["edges"] as Array<{ node: unknown }> | null) ?? [];
    return edges
      .filter((edge) => (edge["node"] as Record<string, unknown> | null)?.["broadcaster"] != null)
      .map((edge) => Channel.fromDirectory(this, edge["node"] as never, dropsEnabled));
  }

  async bulkCheckOnline(channels: Channel[]): Promise<void> {
    const ops = channels.map((channel) => channel.streamGql);
    if (ops.length === 0) return;
    const streamMap = new Map<number, Record<string, unknown>>();
    const streamChunks = await Promise.all(chunk(ops, 20).map((part) => this.gqlRequest(part) as Promise<Array<Record<string, unknown>>>));
    for (const list of streamChunks) {
      for (const item of list) {
        const data = (item["data"] as Record<string, unknown>)["user"] as Record<string, unknown> | null;
        if (data !== null) streamMap.set(Number(data["id"]), data);
      }
    }
    const availableMap = new Map<number, Array<Record<string, unknown>>>();
    if (this.settings.available_drops_check) {
      const availableOps: Array<{ query: GqlQuery; channelId: number }> = [];
      for (const [id, data] of streamMap) {
        if ((data["stream"] as unknown) !== null) {
          availableOps.push({ query: GQL_QUERIES["AvailableDrops"]!.withVariables({ channelID: String(id) }), channelId: id });
        }
      }
      const availableChunks = await Promise.all(
        chunk(availableOps, 20).map((part) => this.gqlRequest(part.map((p) => p.query)) as Promise<Array<Record<string, unknown>>>),
      );
      for (const list of availableChunks) {
        for (const item of list) {
          const info = (item["data"] as Record<string, unknown>)["channel"] as Record<string, unknown>;
          availableMap.set(Number(info["id"]), (info["viewerDropCampaigns"] as Array<Record<string, unknown>> | null) ?? []);
        }
      }
    }
    for (const channel of channels) {
      const data = streamMap.get(channel.id);
      if (!data) continue;
      if (data["stream"] === null) continue;
      channel.externalUpdate(data as never, (availableMap.get(channel.id) ?? []) as never);
    }
  }

  // -- shutdown ---------------------------------------------------------------

  async shutdown(restart = false): Promise<void> {
    const started = performance.now();
    if (!restart && this.history) {
      try {
        this.history.close();
      } catch (error) {
        this.historyError = String(error);
        this.warn(`Could not close reward history: ${error}`);
      } finally {
        this.history = null;
      }
    }
    this.stopWatching();
    this.shutdownRequested = true;
    this.watchingRestart.set();
    await Promise.race([this.watchingTask, sleep(2000)]);
    await Promise.race([this.mntTask, sleep(2000)]);
    this.watchingTask = null;
    this.mntTask = null;
    await this.websocket.stop(true);
    if (this.auth.accessToken && this.cookies.get("auth-token", new URL(this.clientInfo.clientUrl).hostname)) {
      this.cookies.saveFile(this.cookiesPath);
    }
    this.drops.clear();
    this.channels.clear();
    this.inventory.length = 0;
    this.auth.clear();
    this.wantedGames.length = 0;
    this.mntTriggers.length = 0;
    const elapsed = performance.now() - started;
    if (elapsed < 500) await sleep(500 - elapsed);
  }
}

function kindOf(value: unknown): string {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "str";
  if (typeof value === "object") return "dict";
  return typeof value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class AwaitableValueImpl<T> {
  private value: T | undefined;
  private event = false;
  private waiters: Array<() => void> = [];

  hasValue(): boolean {
    return this.event;
  }

  getWithDefault<D>(defaultValue: D): T | D {
    return this.event ? (this.value as T) : defaultValue;
  }

  async get(): Promise<T> {
    if (this.event) return this.value as T;
    await new Promise<void>((resolve) => {
      this.waiters.push(() => resolve());
    });
    return this.value as T;
  }

  set(value: T): void {
    this.value = value;
    this.event = true;
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake();
  }

  clear(): void {
    this.event = false;
  }
}

export type { RequestOptions };
void CaptchaRequired;
void LoginException;
