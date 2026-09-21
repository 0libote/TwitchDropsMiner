/**
 * Port of `webui.py`: the dashboard server on `Bun.serve()` implementing
 * `TwitchGui` for the engine.
 *
 * Same routes, same auth/CSRF/host rules, same snapshot shape (typed as
 * `DashboardState` from `web/api-types.ts`), same SSE stream. The engine is
 * attached after construction (`attachEngine`), mirroring `ui_factory`.
 *
 * Deviations from Python:
 * - `open-data`/`open-log` actions are gone (Docker-only, like Python).
 * - `closeEvent` is shared with the engine (passed in), replacing the
 *   single `_close_requested` both sides used.
 * - IP SSRF checks are hand-rolled (`isBlockedUrl`) instead of `ipaddress`;
 *   the blocked set is a conservative superset (see below).
 */

import { timingSafeEqual } from "node:crypto";
import { arch, platform, release } from "node:os";
import { AsyncEvent, sleep } from "./async.ts";
import { ExitRequest } from "./errors.ts";
import type { TwitchGui } from "./engine.ts";
import { History } from "./history.ts";
import { PriorityMode, EngineState } from "./twitchProtocol.ts";
import { Channel, DropsCampaign, TimedDrop } from "./models.ts";
import type { Settings } from "./settings.ts";
import { FORK_VERSION, UPSTREAM_VERSION } from "./version.ts";
import type {
  CampaignJson,
  CampaignStatus,
  ChannelJson,
  DashboardState,
  LoginState,
  MiningPlanItem,
  TimedDropJson,
} from "../web/api-types.ts";

const WEB_ROOT = `${import.meta.dir}/../web`;
const CSRF_COOKIE = "__Host-csrf";
const HISTORY_LIMIT = 50;

// -- SSRF blocklist (port of _BLOCKED_* / _is_blocked_url) ------------------

const BLOCKED_SUFFIXES = [".internal", ".local"];
const BLOCKED_EXACT = new Set(["localhost", "metadata.google.internal", "169.254.169.254"]);

interface IpFlags {
  loopback: boolean;
  private: boolean;
  linkLocal: boolean;
  multicast: boolean;
  reserved: boolean;
}

function ipv4Flags(parts: number[]): IpFlags {
  const [a, b] = parts as [number, number];
  const first = parts[0]!;
  return {
    loopback: first === 127,
    private:
      first === 10 || (first === 172 && b >= 16 && b <= 31) || (first === 192 && b === 168) || (first === 100 && b >= 64 && b <= 127),
    linkLocal: first === 169 && b === 254,
    multicast: first >= 224 && first <= 239,
    // Unspecified, TEST-NETs, benchmarking and future-use ranges. Python's
    // `is_reserved`/`is_private` disagree on some of these across versions;
    // blocking them all is the safe superset for webhook/proxy targets.
    reserved:
      first === 0 ||
      first >= 240 ||
      (first === 192 && (b === 0 || b === 2)) ||
      (first === 198 && (b === 18 || b === 19)) ||
      (first === 203 && b === 0),
  };
}

function ipv6Flags(normalized: string): IpFlags | null {
  if (!normalized.includes(":")) return null;
  const lower = normalized.toLowerCase();
  // IPv4-mapped: judge the embedded address too.
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const inner = parseIpv4(mapped[1]!);
    if (inner) return inner;
  }
  if (lower === "::1") return { loopback: true, private: false, linkLocal: false, multicast: false, reserved: false };
  if (lower === "::") return { loopback: false, private: false, linkLocal: false, multicast: false, reserved: true };
  const head = lower.split(":")[0]!;
  const firstWord = Number.parseInt(head, 16);
  if (Number.isNaN(firstWord)) return null;
  return {
    loopback: false,
    private: firstWord >= 0xfc00 && firstWord <= 0xfdff,
    linkLocal: firstWord >= 0xfe80 && firstWord <= 0xfebf,
    multicast: firstWord >= 0xff00,
    reserved: false,
  };
}

function parseIpv4(host: string): IpFlags | null {
  const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const parts = match.slice(1, 5).map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ipv4Flags(parts);
}

/** Conservative port of `_is_blocked_url` (superset: blocks more, never less, for the tested ranges). */
export function isBlockedUrl(url: URL, allowLoopback = false): boolean {
  // WHATWG keeps IPv6 brackets in hostname; yarl strips them. Normalize.
  const raw = (url.hostname || "").toLowerCase();
  const host = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (!host) return false;
  if (BLOCKED_EXACT.has(host)) {
    if (allowLoopback && (host === "localhost" || host === "127.0.0.1" || host === "::1")) return false;
    return true;
  }
  for (const suffix of BLOCKED_SUFFIXES) {
    if (host.endsWith(suffix)) return true;
  }
  const flags = parseIpv4(host) ?? ipv6Flags(host);
  if (!flags) return false;
  if (allowLoopback && flags.loopback) return false;
  return flags.private || flags.loopback || flags.linkLocal || flags.multicast || flags.reserved;
}

// -- snapshot builders --------------------------------------------------------

function iso(date: Date): string {
  return date.toISOString();
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

export function dropJson(drop: TimedDrop): TimedDropJson {
  return {
    id: drop.id,
    name: drop.name,
    rewards: drop.rewardsText(),
    claimed: drop.isClaimed,
    claimable: drop.canClaim,
    currentMinutes: drop.currentMinutes,
    requiredMinutes: drop.requiredMinutes,
    remainingMinutes: drop.remainingMinutes,
    progress: round4(drop.progress),
    totalRemainingMinutes: drop.totalRemainingMinutes,
    prerequisites: drop.preconditionDrops.flatMap((pid) => {
      const pre = drop.campaign.timedDrops.get(pid);
      return pre ? [{ id: pre.id, name: pre.name, claimed: pre.isClaimed }] : [];
    }),
    startsAt: iso(drop.startsAt),
    endsAt: iso(drop.endsAt),
    benefits: drop.benefits.map((benefit) => ({ name: benefit.name, type: benefit.type, image: benefit.imageUrl })),
  };
}

export function campaignJson(campaign: DropsCampaign): CampaignJson {
  const status: CampaignStatus = campaign.active ? "active" : campaign.upcoming ? "upcoming" : campaign.expired ? "expired" : "unavailable";
  return {
    id: campaign.id,
    name: campaign.name,
    game: campaign.game.name,
    gameId: String(campaign.game.id),
    image: campaign.imageUrl,
    linkUrl: campaign.linkUrl,
    linked: campaign.linked,
    eligible: campaign.eligible,
    finished: campaign.finished,
    status,
    startsAt: iso(campaign.startsAt),
    endsAt: iso(campaign.endsAt),
    claimedDrops: campaign.claimedDrops,
    totalDrops: campaign.totalDrops,
    remainingMinutes: campaign.remainingMinutes,
    progress: round4(campaign.progress),
    drops: [...campaign.drops].map(dropJson),
  };
}

export function channelJson(channel: Channel, watchingId: number | null, watchable: boolean): ChannelJson {
  const game = channel.game;
  return {
    id: channel.id,
    name: channel.name,
    login: channel.login,
    url: channel.url,
    online: channel.online,
    pending: channel.pendingOnline,
    watching: channel.id === watchingId,
    watchable,
    game: game?.name ?? null,
    viewers: channel.viewers,
    dropsEnabled: channel.dropsEnabled,
    title: channel.stream?.title ?? null,
  };
}

/** Pure watchdog rule (既 settings-free): recover after 15 stalled minutes. */
export function shouldRecoverFromStall(elapsedSeconds: number | null, sinceWatchdogSeconds: number): boolean {
  return elapsedSeconds !== null && elapsedSeconds >= 900 && sinceWatchdogSeconds >= 900;
}

// -- engine surface used by the server -----------------------------------------

export interface ServerEngine {
  paused: boolean;
  wantedGames: Array<{ id: number; name: string }>;
  inventory: DropsCampaign[];
  channels: Map<number, Channel>;
  watchingChannel: { getWithDefault<D>(fallback: D): Channel | D };
  getActiveCampaign(channel: Channel | null): DropsCampaign | null;
  canWatch(channel: Channel): boolean;
  settings: Settings;
  stats: { snapshot(): DashboardState["stats"] };
  lastConfirmedProgressAt: number | null;
  secondsWithoutProgress(): number | null;
  history: History | null;
  auth: { userId?: number; invalidate(deleteCookies: boolean): void };
  changeState(state: EngineState, force?: boolean): void;
  pause(): void;
  resume(): void;
  websocketSockets: Array<{ connected: boolean }>;
}

interface LoginData {
  username: string;
  password: string;
  token: string;
}

export interface ServerOptions {
  dataDir: string;
  settings: Settings;
  host?: string;
  port?: number;
  openBrowser?: boolean;
  closeEvent?: AsyncEvent;
}

// -- server ---------------------------------------------------------------------

export class DashboardServer implements TwitchGui {
  private engine: ServerEngine | null = null;
  private readonly settings: Settings;
  private readonly dataDir: string;
  private readonly host: string;
  private readonly port: number;
  private readonly openBrowser: boolean;
  private readonly closeEvent: AsyncEvent;
  private readonly authToken: string;
  private csrfToken: string;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private clockHandle: Promise<void> | null = null;
  private clockStopped = false;
  private revision = 0;
  private readonly subscribers = new Set<AsyncEvent>();
  private statusText = "Starting";
  private activityState = "idle";
  private readonly websocketState = new Map<number, { status: string; topics: number }>();
  private readonly loginState: LoginState = { status: "Signed out", userId: null, activationUrl: null, activationCode: null };
  private canLogout = false;
  private readonly messages: Array<{ time: string; level: string; message: string }> = [];
  private readonly notifications: Array<{ time: string; title: string; message: string }> = [];
  private readonly networkFailures = new Map<string, number>();
  private readonly gameNames = new Set<string>();
  private readonly webhookInFlight = new Set<Promise<unknown>>();
  private webhookSemaphore = 4;
  private loginPending: { resolve: (data: LoginData) => void; reject: (error: unknown) => void } | null = null;
  private lastWatchdog = performance.now();
  private recoveryReason: string | null = null;
  private displayedDrop: TimedDrop | null = null;
  private displayedAt: number | null = null;
  private selectedChannelId: number | null = null;
  readonly dashboardUrl: string;

  constructor(options: ServerOptions) {
    this.settings = options.settings;
    this.dataDir = options.dataDir;
    this.host = options.host ?? process.env["TDM_HOST"] ?? "127.0.0.1";
    this.port = options.port ?? Number(process.env["TDM_PORT"] ?? "8080");
    this.openBrowser = options.openBrowser ?? !process.env["TDM_NO_BROWSER"];
    this.closeEvent = options.closeEvent ?? new AsyncEvent();
    this.authToken = process.env["TDM_WEB_TOKEN"] ?? "";
    this.csrfToken = randomToken();
    const urlHost = this.host === "0.0.0.0" || this.host === "::" ? "127.0.0.1" : this.host;
    // Plain HTTP by design; TLS for remote access belongs at the reverse proxy.
    this.dashboardUrl = `http://${urlHost}:${this.port}/`;
  }

  attachEngine(engine: ServerEngine): void {
    this.engine = engine;
  }

  private requireEngine(): ServerEngine {
    if (!this.engine) throw new Error("DashboardServer has no engine attached");
    return this.engine;
  }

  // -- TwitchGui ---------------------------------------------------------------

  get status(): { update(text: string): void; clear(): void } {
    return {
      update: (text) => {
        this.statusText = text;
        this.changed();
      },
      clear: () => {
        this.statusText = "";
        this.changed();
      },
    };
  }

  get login(): TwitchGui["login"] {
    return {
      update: (status, userId) => {
        this.loginState.status = status;
        this.loginState.userId = userId;
        this.changed();
      },
      clear: () => {},
      askEnterCode: async (pageUrl, userCode) => {
        let host: string;
        try {
          const parsed = new URL(pageUrl);
          if (parsed.protocol !== "https:") throw new Error("bad scheme");
          host = parsed.hostname;
        } catch {
          throw new Error("Twitch returned an invalid device activation URL");
        }
        if (host !== "twitch.tv" && host !== "www.twitch.tv") {
          throw new Error("Twitch returned an invalid device activation URL");
        }
        this.statusText = "Waiting for Twitch authorization";
        this.loginState.status = "Authorization required";
        this.loginState.activationUrl = pageUrl;
        this.loginState.activationCode = userCode;
        this.changed();
      },
      askLogin: () => {
        this.loginState.status = "Sign in required";
        this.changed();
        return new Promise<LoginData>((resolve, reject) => {
          this.loginPending = { resolve, reject };
          const handle = this.closeEvent.waitHandle();
          void handle.promise.then(() => {
            if (this.loginPending) {
              this.loginPending = null;
              handle.cancel();
              reject(new ExitRequest());
            }
          });
        }).finally(() => {
          this.loginPending = null;
        });
      },
    };
  }

  submitLogin(payload: Record<string, unknown>): boolean {
    if (!this.loginPending) return false;
    const pending = this.loginPending;
    this.loginPending = null;
    pending.resolve({
      username: String(payload["username"] ?? "").trim(),
      password: String(payload["password"] ?? ""),
      token: String(payload["token"] ?? "").trim(),
    });
    return true;
  }

  helpButton(state: "normal" | "disabled"): void {
    if (state === "normal") {
      this.canLogout = true;
    } else {
      this.canLogout = false;
      this.loginState.userId = null;
    }
    this.changed();
  }

  get websockets(): TwitchGui["websockets"] {
    return {
      update: (idx, status, topics) => {
        const item = this.websocketState.get(idx) ?? { status: "Disconnected", topics: 0 };
        if (status != null) item.status = status;
        if (topics != null) item.topics = topics;
        this.websocketState.set(idx, item);
        this.changed();
      },
      remove: (idx) => {
        this.websocketState.delete(idx);
        this.changed();
      },
    };
  }

  get progress(): TwitchGui["progress"] {
    return {
      minuteAlmostDone: () => this.displayedAt === null || Date.now() - this.displayedAt >= 55_000,
      stopTimer: () => {
        this.displayedAt = null;
      },
    };
  }

  displayDrop(drop: TimedDrop | null, options?: { countdown?: boolean }): void {
    this.displayedDrop = drop;
    this.displayedAt = drop && (options?.countdown ?? true) ? Date.now() : null;
    this.changed();
  }

  clearDrop(): void {
    this.displayDrop(null);
  }

  get channels(): TwitchGui["channels"] {
    return {
      display: () => void this.changed(),
      remove: (channel) => {
        if (this.selectedChannelId === channel.id) this.selectedChannelId = null;
        this.changed();
      },
      getSelection: () => {
        const engine = this.engine;
        if (this.selectedChannelId === null || !engine) return null;
        return engine.channels.get(this.selectedChannelId) ?? null;
      },
      clearWatching: () => void this.changed(),
      setWatching: (channel) => {
        this.selectedChannelId = null;
        void channel;
        this.changed();
      },
      clear: () => {
        this.selectedChannelId = null;
        this.changed();
      },
    };
  }

  get inv(): TwitchGui["inv"] {
    return {
      updateDrop: () => void this.changed(),
      clear: () => void this.changed(),
      addCampaign: async () => void this.changed(),
    };
  }

  setGames(games: Set<{ name: string }>): void {
    for (const game of games) this.gameNames.add(game.name);
    this.changed();
  }

  get notifier(): TwitchGui["notifier"] {
    return {
      notify: (message, title) => {
        this.sendWebhook("claim", title, message);
        if (!this.requireEngine().settings.tray_notifications) return;
        this.notifications.unshift({ time: new Date().toISOString(), title, message });
        if (this.notifications.length > 20) this.notifications.length = 20;
        this.changed();
      },
      set_activity: (state) => {
        this.activityState = state;
        this.changed();
      },
    };
  }

  print(message: string): void {
    this.messages.push({ time: new Date().toISOString(), level: "info", message });
    if (this.messages.length > 250) this.messages.splice(0, this.messages.length - 250);
    this.changed();
  }

  reportNetworkIssue(url: string): void {
    const host = safeHostname(url);
    if (!host) return;
    const failures = (this.networkFailures.get(host) ?? 0) + 1;
    this.networkFailures.set(host, failures);
    if (failures === 2) {
      this.sendWebhook("network_failure", "Twitch network problem", `Requests to ${host} are failing`);
      this.changed();
    }
  }

  reportNetworkRecovery(url: string): void {
    const host = safeHostname(url);
    if (!host) return;
    if ((this.networkFailures.get(host) ?? 0) >= 2) {
      this.networkFailures.delete(host);
      this.sendWebhook("network_recovery", "Twitch network recovered", `Requests to ${host} recovered`);
      this.changed();
    }
  }

  preventClose(): void {
    this.closeEvent.clear();
  }

  close(): void {
    this.closeEvent.set();
    this.engine?.changeState(EngineState.EXIT);
  }

  get closeRequested(): boolean {
    return this.closeEvent.isSet();
  }

  waitUntilClosed(): Promise<true> {
    return this.closeEvent.wait();
  }

  save(): void {}

  start(): void {
    if (this.server) return;
    const server = Bun.serve({
      hostname: this.host,
      port: this.port,
      fetch: (req) => this.handleRequest(req),
    });
    this.server = server;
    this.clockStopped = false;
    this.runClock();
  }

  get boundPort(): number | null {
    return this.server?.port ?? null;
  }

  stop(): void {
    this.clockStopped = true;
    this.server?.stop();
    this.server = null;
  }

  // -- snapshot ------------------------------------------------------------------

  changed(): void {
    this.revision += 1;
    for (const subscriber of [...this.subscribers]) subscriber.set();
  }

  private get webhookUrl(): string {
    return process.env["TDM_WEBHOOK_URL"] || this.requireEngine().settings.webhook_url;
  }

  snapshot(): DashboardState {
    const engine = this.requireEngine();
    const watching = engine.watchingChannel.getWithDefault(null);
    const watchingId = watching?.id ?? null;
    const settings = engine.settings;
    const campaigns = engine.inventory.map(campaignJson);
    const channels = [...engine.channels.values()].map((channel) =>
      channelJson(channel, watchingId, engine.canWatch(channel)),
    );
    const stats = engine.stats.snapshot();
    return {
      revision: this.revision,
      paused: engine.paused,
      miningPlan: this.miningPlan(),
      progressHealth: this.progressHealth(),
      status: this.statusText,
      activity: this.activityState,
      login: { ...this.loginState },
      canLogout: this.canLogout,
      watchingChannelId: watchingId,
      activeDrop: this.displayedDrop ? dropJson(this.displayedDrop) : null,
      campaigns,
      channels,
      websockets: [...this.websocketState.entries()]
        .sort(([a], [b]) => a - b)
        .map(([idx, item]) => ({ id: idx + 1, ...item })),
      messages: [...this.messages],
      notifications: [...this.notifications],
      stats: {
        startedAt: stats.startedAt,
        uptimeSeconds: stats.uptimeSeconds,
        session: { ...stats.session },
        lifetime: { ...stats.lifetime },
        lastInventoryAt: stats.lastInventoryAt,
        lastRecoveryAt: stats.lastRecoveryAt,
      },
      system: {
        version: FORK_VERSION,
        upstreamVersion: UPSTREAM_VERSION,
        python: `Bun ${Bun.version}`,
        platform: `${platform()} ${release()} ${arch()}`,
        packaged: false,
        dataDirectory: this.dataDir,
        authenticationEnabled: this.authToken !== "",
        webhookManagedByEnvironment: Boolean(process.env["TDM_WEBHOOK_URL"]),
      },
      networkIssues: [...this.networkFailures.entries()].filter(([, n]) => n >= 2).map(([host]) => host).sort(),
      games: [...this.gameNames].sort(),
      settings: {
        priority: [...settings.priority],
        exclude: [...settings.exclude].sort(),
        priorityMode: PriorityMode[settings.priority_mode],
        connectionQuality: settings.connection_quality,
        trayNotifications: settings.tray_notifications,
        enableBadgesEmotes: settings.enable_badges_emotes,
        availableDropsCheck: settings.available_drops_check,
        proxy: settings.proxy,
        webhookUrl: process.env["TDM_WEBHOOK_URL"] ? "" : settings.webhook_url,
      },
      summary: {
        campaigns: campaigns.length,
        activeCampaigns: campaigns.filter((c) => c.status === "active").length,
        completedCampaigns: campaigns.filter((c) => c.finished).length,
        onlineChannels: channels.filter((c) => c.online).length,
      },
    };
  }

  private progressHealth(): DashboardState["progressHealth"] {
    const engine = this.requireEngine();
    const elapsed = engine.secondsWithoutProgress();
    const stamp = engine.lastConfirmedProgressAt;
    return {
      lastConfirmedAt: stamp !== null ? new Date(Date.now() - Math.max(0, performance.now() - stamp)).toISOString() : null,
      secondsWithoutProgress: elapsed !== null ? Math.floor(elapsed) : null,
      nextRecoveryInSeconds:
        elapsed !== null ? Math.max(0, Math.ceil(900 - elapsed), Math.ceil(900 - (performance.now() - this.lastWatchdog) / 1000)) : null,
      recoveryReason: this.recoveryReason,
    };
  }

  private miningPlan(): MiningPlanItem[] {
    const engine = this.requireEngine();
    const watching = engine.watchingChannel.getWithDefault(null);
    const current = watching ? engine.getActiveCampaign(watching) : null;
    const paused = engine.paused;
    const now = new Date();
    const planned: Array<{ game: { id: number; name: string }; campaign: DropsCampaign; active: boolean; live: boolean; single: boolean }> = [];
    for (const game of engine.wantedGames) {
      const eligible = engine.inventory.filter((c) => c.game.id === game.id && !c.finished && c.eligible && !c.expired);
      if (eligible.length === 0) continue;
      const active = current !== null && eligible.includes(current);
      const liveCampaigns = eligible.filter((c) =>
        [...engine.channels.values()].some((ch) => engine.canWatch(ch) && c.canEarn(ch)),
      );
      const campaign =
        active && current
          ? current
          : liveCampaigns.length > 0 || eligible.length > 0
            ? [...(liveCampaigns.length > 0 ? liveCampaigns : eligible)].sort((a, b) => a.remainingMinutes - b.remainingMinutes)[0]!
            : null;
      if (!campaign) continue;
      planned.push({ game, campaign, active, live: active || liveCampaigns.includes(campaign), single: eligible.length === 1 });
    }
    planned.sort((a, b) => (a.active ? 0 : a.live ? 1 : 2) - (b.active ? 0 : b.live ? 1 : 2));
    let elapsed = 0;
    let predictable = !paused;
    const result: MiningPlanItem[] = [];
    for (const item of planned) {
      const priority = engine.settings.priority.includes(item.game.name);
      const reasonCode = paused ? "paused" : item.active ? "mining" : item.live ? "queued" : "waiting";
      const reason =
        reasonCode === "paused"
          ? "Mining paused"
          : reasonCode === "mining"
            ? "Currently mining"
            : reasonCode === "queued"
              ? priority
                ? "Priority game"
                : "Selected by fallback rule"
              : "No eligible live channel discovered yet";
      let estimate: string | null = null;
      if (predictable && item.live && (item.active || item.single)) {
        elapsed += item.campaign.remainingMinutes;
        estimate = new Date(now.getTime() + elapsed * 60000).toISOString();
        if (new Date(now.getTime() + elapsed * 60000) > item.campaign.endsAt) {
          estimate = null;
          predictable = false;
        }
      } else {
        predictable = false;
      }
      if (!item.single) predictable = false;
      result.push({
        game: item.game.name,
        gameId: String(item.game.id),
        campaignId: item.campaign.id,
        name: item.campaign.name,
        image: item.campaign.imageUrl,
        reason,
        reasonCode,
        remainingMinutes: item.campaign.remainingMinutes,
        estimatedCompletionAt: estimate,
        endsAt: item.campaign.endsAt.toISOString(),
        watching: item.active,
        priority,
      });
    }
    for (const game of engine.settings.priority) {
      if (result.some((item) => item.game === game)) continue;
      const found = engine.inventory.filter((c) => c.game.name === game);
      const campaign = found[0] ?? null;
      const reason = engine.settings.exclude.has(game)
        ? "Excluded by your mining plan"
        : found.some((c) => !c.linked)
          ? "Account connection required"
          : "No eligible campaign selected";
      result.push({
        game,
        gameId: campaign ? String(campaign.game.id) : null,
        campaignId: campaign?.id ?? null,
        image: campaign?.imageUrl ?? null,
        reason,
        reasonCode: "waiting",
        remainingMinutes: null,
        estimatedCompletionAt: null,
        endsAt: null,
        watching: false,
        priority: true,
      });
    }
    return result;
  }

  // -- HTTP ------------------------------------------------------------------------

  private allowedHosts(): Set<string> {
    const hosts = new Set(["127.0.0.1", "localhost", "::1"]);
    const publicUrl = (process.env["TDM_PUBLIC_URL"] ?? "").trim();
    if (publicUrl) {
      try {
        const host = new URL(publicUrl).hostname;
        if (host) hosts.add(host);
      } catch {
        // Ignore malformed public URLs (same as Python).
      }
    }
    for (const part of (process.env["TDM_ALLOWED_HOSTS"] ?? "").split(",")) {
      const host = part.trim().toLowerCase();
      if (host) hosts.add(host);
    }
    return hosts;
  }

  private checkAuth(req: Request, url: URL): Response | null {
    const hostname = (url.hostname || "").toLowerCase();
    if (!this.allowedHosts().has(hostname)) {
      return plain(403, "Unrecognised local dashboard host");
    }
    if (!this.authToken || url.pathname === "/healthz") return null;
    const expected = `Basic ${Buffer.from(`tdm:${this.authToken}`).toString("base64")}`;
    const actual = req.headers.get("Authorization") ?? "";
    if (actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
      return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="TDM dashboard"' } });
    }
    return null;
  }

  private checkCsrf(req: Request, url: URL): Response | null {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return null;
    const origin = req.headers.get("Origin");
    if (origin) {
      const publicUrl = (process.env["TDM_PUBLIC_URL"] ?? "").trim().replace(/\/+$/, "");
      if (publicUrl) {
        if (origin !== publicUrl) return plain(403, "Cross-origin actions are not allowed");
      } else if (origin !== `${url.protocol}//${url.host}`) {
        return plain(403, "Cross-origin actions are not allowed");
      }
    }
    const presented = req.headers.get("X-CSRF-Token") ?? "";
    const cookieToken = parseCookies(req.headers.get("Cookie") ?? "")[CSRF_COOKIE] ?? "";
    const expected = cookieToken || this.csrfToken;
    const matches = (a: string, b: string): boolean =>
      a.length > 0 && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
    if (!matches(presented, expected) && !matches(presented, this.csrfToken)) {
      return plain(403, "Invalid request token; reload the dashboard and try again");
    }
    return null;
  }

  private withSecurity(req: Request, response: Response): Response {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", new URL(req.url).pathname.startsWith("/api/") ? "no-store" : "no-cache");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
    );
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  /** Router entry point (also used directly by tests). */
  async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const auth = this.checkAuth(req, url);
    if (auth) return this.withSecurity(req, auth);
    const csrf = this.checkCsrf(req, url);
    if (csrf) return this.withSecurity(req, csrf);
    try {
      return this.withSecurity(req, await this.dispatch(req, url, path));
    } catch (error) {
      if (error instanceof HttpError) return this.withSecurity(req, plain(error.status, error.message));
      throw error;
    }
  }

  private async dispatch(req: Request, url: URL, path: string): Promise<Response> {
    const SPA = new Set(["/", "/campaigns", "/mining", "/settings", "/diagnostics", "/history"]);
    if (req.method === "GET" || req.method === "HEAD") {
      if (SPA.has(path) || path.startsWith("/campaigns/")) return file(`${WEB_ROOT}/index.html`, "text/html; charset=utf-8");
      if (path === "/healthz") return Response.json({ status: "ok" });
      if (path === "/readyz") return this.ready();
      if (path === "/metrics") return this.metrics();
      if (path === "/api/diagnostics") return this.diagnostics();
      if (path === "/api/export") return this.doExport(url);
      if (path === "/api/state") return Response.json(this.snapshot());
      if (path === "/api/csrf") return this.csrf(req);
      if (path === "/api/history") return this.history(url);
      if (path === "/api/events") return this.events();
      if (path === "/assets/app.js") return file(`${WEB_ROOT}/app.js`, "text/javascript; charset=utf-8");
      if (path === "/assets/theme.js") return file(`${WEB_ROOT}/theme.js`, "text/javascript; charset=utf-8");
      if (path === "/assets/app.css") return file(`${WEB_ROOT}/app.css`, "text/css; charset=utf-8");
    }
    if (req.method === "POST" && path.startsWith("/api/actions/")) {
      return this.action(path.slice("/api/actions/".length));
    }
    if (req.method === "POST" && path.startsWith("/api/channels/")) {
      return this.switchChannel(path.slice("/api/channels/".length));
    }
    if (req.method === "PUT" && path === "/api/settings") return this.updateSettings(await readJson(req));
    if (req.method === "POST" && path === "/api/import") {
      const payload = await readJson(req);
      const settings = typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? ((payload as Record<string, unknown>)["settings"] ?? payload)
        : payload;
      return this.applySettings(settings);
    }
    if (req.method === "POST" && path === "/api/login") return this.handleLoginSubmit(await readJson(req));
    throw new HttpError(404, "Not found");
  }

  private ready(): Response {
    const engine = this.requireEngine();
    const sockets = engine.websocketSockets;
    const ready = sockets.length > 0 && sockets.every((s) => s.connected);
    const userId = engine.auth.userId;
    const ok = Boolean(userId) && ready;
    return Response.json({ status: ok ? "ready" : "starting" }, { status: ok ? 200 : 503 });
  }

  private metrics(): Response {
    const engine = this.requireEngine();
    const stats = (engine as { stats?: { snapshot(): DashboardState["stats"] } }).stats;
    if (!stats) return new Response("tdm_uptime_seconds 0\n", { status: 503, headers: { "Content-Type": "text/plain" } });
    const snapshot = stats.snapshot();
    const lifetime = snapshot.lifetime as Record<string, number | string | null>;
    const lines = [
      `tdm_uptime_seconds ${snapshot.uptimeSeconds}`,
      `tdm_drops_claimed_total ${lifetime["drops_claimed"] ?? 0}`,
      `tdm_mining_minutes_total ${lifetime["mining_minutes"] ?? 0}`,
      `tdm_channel_switches_total ${lifetime["channel_switches"] ?? 0}`,
      `tdm_watch_failures_total ${lifetime["watch_failures"] ?? 0}`,
    ];
    return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/plain" } });
  }

  private diagnostics(): Response {
    const snapshot = this.snapshot();
    return Response.json({
      status: snapshot.status,
      activity: snapshot.activity,
      websockets: snapshot.websockets,
      networkIssues: snapshot.networkIssues,
      stats: snapshot.stats,
      system: snapshot.system,
    });
  }

  private doExport(url: URL): Response {
    const engine = this.requireEngine();
    const settings = { ...this.snapshot().settings, proxy: "", webhookUrl: "" };
    const payload: Record<string, unknown> = { settings };
    if (url.searchParams.get("stats") === "1") {
      payload["stats"] = engine.stats.snapshot().lifetime;
    }
    return Response.json(payload, { headers: { "Content-Disposition": 'attachment; filename="tdm-export.json"' } });
  }

  private history(url: URL): Response {
    const engine = this.requireEngine();
    const account = engine.auth.userId;
    if (!account) throw new HttpError(409, "Connect Twitch to view this account's saved history");
    if (!engine.history) throw new HttpError(503, "Reward history is unavailable; check the process log");
    const offsetRaw = url.searchParams.get("offset") ?? "0";
    const offset = Number.parseInt(offsetRaw, 10);
    if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, "Invalid history offset");
    const result = engine.history.query(String(account), url.searchParams.get("game") || undefined, (url.searchParams.get("q") ?? "").slice(0, 200), offset, HISTORY_LIMIT);
    return Response.json({ ...result, summary: engine.history.summary(String(account)) });
  }

  private csrf(req: Request): Response {
    const response = Response.json({ token: this.csrfToken });
    const secure = new URL(req.url).protocol === "https:" || (process.env["TDM_PUBLIC_URL"] ?? "").startsWith("https://");
    response.headers.append(
      "Set-Cookie",
      `${CSRF_COOKIE}=${this.csrfToken}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`,
    );
    return response;
  }

  private events(): Response {
    const queue = new AsyncEvent();
    this.subscribers.add(queue);
    const stream = new ReadableStream({
      start: async (controller) => {
        const encoder = new TextEncoder();
        try {
          for (;;) {
            controller.enqueue(encoder.encode(`data:${JSON.stringify(this.snapshot())}\n\n`));
            const handle = queue.waitHandle();
            try {
              const woke = await Promise.race([handle.promise.then(() => true), sleep(20000).then(() => false)]);
              queue.clear();
              if (!woke) controller.enqueue(encoder.encode(":keepalive\n\n"));
            } finally {
              handle.cancel();
            }
            if (this.closeEvent.isSet()) return;
          }
        } catch {
          // Client went away.
        } finally {
          this.subscribers.delete(queue);
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        }
      },
      cancel: () => {
        this.subscribers.delete(queue);
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  private async action(action: string): Promise<Response> {
    const engine = this.requireEngine();
    if (action === "reload") {
      engine.changeState(EngineState.INVENTORY_FETCH);
    } else if (action === "restart") {
      engine.changeState(EngineState.RESTART);
    } else if (action === "pause") {
      engine.pause();
    } else if (action === "resume") {
      engine.resume();
    } else if (action === "test-webhook") {
      if (!this.webhookUrl) throw new HttpError(400, "Save a webhook URL first");
      if (!(await this.deliverWebhook("test", "Test notification", "Twitch Drops Miner notification test"))) {
        throw new HttpError(502, "Webhook delivery failed; check the URL and process log");
      }
    } else if (action === "logout") {
      engine.auth.invalidate(true);
      this.loginState.userId = null;
      this.loginState.activationCode = null;
      this.loginState.activationUrl = null;
      this.loginState.status = "Signed out";
      this.canLogout = false;
      this.csrfToken = randomToken();
      this.changed();
      engine.changeState(EngineState.RESTART, true);
    } else if (action === "shutdown") {
      this.close();
    } else {
      throw new HttpError(404, "Unknown action");
    }
    return Response.json({ ok: true });
  }

  private switchChannel(rawId: string): Response {
    const engine = this.requireEngine();
    const channelId = Number.parseInt(rawId, 10);
    if (!Number.isInteger(channelId)) throw new HttpError(400, "Invalid channel ID");
    const channel = engine.channels.get(channelId);
    if (!channel) throw new HttpError(404, "Channel not found");
    if (!engine.canWatch(channel)) throw new HttpError(409, "Channel is not eligible for an active drop");
    this.selectedChannelId = channelId;
    engine.changeState(EngineState.CHANNEL_SWITCH);
    return Response.json({ ok: true });
  }

  private async updateSettings(payload: unknown): Promise<Response> {
    if (payload === undefined || typeof payload !== "object" || payload === null) {
      throw new HttpError(400, "Settings must be valid JSON");
    }
    return this.applySettings(payload as Record<string, unknown>);
  }

  applySettings(payload: unknown): Response {
    const engine = this.requireEngine();
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new HttpError(400, "Settings must be an object");
    }
    const input = payload as Record<string, unknown>;
    const candidate = new Map<string, unknown>();
    for (const name of ["priority", "exclude"]) {
      if (!(name in input)) continue;
      const values = input[name];
      if (
        !Array.isArray(values) ||
        values.length > 1000 ||
        values.some((v) => typeof v !== "string" || !v.trim() || v.length > 200)
      ) {
        throw new HttpError(400, `${name} must be a list of game names`);
      }
      const strings = values as string[];
      candidate.set(name, name === "priority" ? [...new Set(strings)] : new Set(strings));
    }
    if ("priorityMode" in input) {
      const mode = PriorityMode[input["priorityMode"] as keyof typeof PriorityMode];
      if (mode === undefined) throw new HttpError(400, "Invalid priority mode");
      candidate.set("priority_mode", mode);
    }
    if ("connectionQuality" in input) {
      const value = input["connectionQuality"];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 6) {
        throw new HttpError(400, "Connection quality must be an integer between 1 and 6");
      }
      candidate.set("connection_quality", value);
    }
    for (const [name, attribute] of Object.entries({
      trayNotifications: "tray_notifications",
      enableBadgesEmotes: "enable_badges_emotes",
      availableDropsCheck: "available_drops_check",
    })) {
      if (!(name in input)) continue;
      if (typeof input[name] !== "boolean") throw new HttpError(400, `${name} must be a boolean`);
      candidate.set(attribute, input[name]);
    }
    for (const [name, attribute] of Object.entries({ proxy: "proxy", webhookUrl: "webhook_url" })) {
      if (!(name in input)) continue;
      const value = input[name];
      if (typeof value !== "string" || value.length > 4096) throw new HttpError(400, `${name} must be a URL string`);
      const trimmed = value.trim();
      if (trimmed) {
        let parsed: URL;
        try {
          parsed = new URL(trimmed);
        } catch {
          throw new HttpError(400, name === "proxy" ? "Proxy must include an HTTP(S) host and port" : "Webhook must be an HTTP(S) URL");
        }
        const isProxy = name === "proxy";
        if (
          (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
          !parsed.hostname ||
          (isProxy && !parsed.port) ||
          isBlockedUrl(parsed, isProxy)
        ) {
          throw new HttpError(400, isProxy ? "Proxy must include an HTTP(S) host and port" : "Webhook must be an HTTP(S) URL");
        }
      }
      if (name === "webhookUrl" && process.env["TDM_WEBHOOK_URL"]) continue;
      candidate.set(attribute, trimmed);
    }
    const settings = engine.settings;
    const previous = new Map<string, unknown>();
    for (const [name] of candidate) previous.set(name, settings.get(name));
    try {
      for (const [name, value] of candidate) {
        (settings.set as (name: string, value: unknown) => void)(name, value);
      }
      settings.save();
    } catch {
      for (const [name, value] of previous) {
        try {
          (settings.set as (name: string, value: unknown) => void)(name, value);
        } catch {
          // Best effort rollback.
        }
      }
      throw new HttpError(500, "Settings could not be saved");
    }
    engine.changeState(EngineState.GAMES_UPDATE);
    this.changed();
    return Response.json({ ok: true });
  }

  private handleLoginSubmit(payload: unknown): Response {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new HttpError(400, "Login details must be an object");
    }
    if (!this.submitLogin(payload as Record<string, unknown>)) {
      throw new HttpError(409, "The miner is not waiting for credentials");
    }
    return Response.json({ ok: true });
  }

  // -- webhooks ---------------------------------------------------------------

  private async deliverWebhook(event: string, title: string, message: string): Promise<boolean> {
    while (this.webhookSemaphore <= 0) {
      await sleep(100);
    }
    this.webhookSemaphore -= 1;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(this.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event, title, message }),
          redirect: "manual",
          signal: controller.signal,
        });
        return response.status >= 200 && response.status < 300;
      } catch {
        return false;
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      this.webhookSemaphore += 1;
    }
  }

  sendWebhook(event: string, title: string, message: string): void {
    if (!this.webhookUrl) return;
    if (this.webhookInFlight.size >= 20) return;
    const task = this.deliverWebhook(event, title, message).catch(() => false);
    this.webhookInFlight.add(task);
    void task.finally(() => {
      this.webhookInFlight.delete(task);
    });
  }

  // -- background ---------------------------------------------------------------

  private runClock(): void {
    void (async () => {
      let previous = performance.now();
      while (!this.clockStopped) {
        await sleep(60_000);
        if (this.clockStopped) return;
        const now = performance.now();
        if (now - previous > 180_000) {
          this.print("System resumed; refreshing Twitch state");
          this.requireEngine().changeState(EngineState.INVENTORY_FETCH, true);
        }
        previous = now;
        const engine = this.requireEngine();
        const elapsed = engine.secondsWithoutProgress();
        if (shouldRecoverFromStall(elapsed, (now - this.lastWatchdog) / 1000)) {
          this.lastWatchdog = now;
          this.recoveryReason = "No confirmed progress for 15 minutes; inventory refresh requested";
          this.print("Mining progress appears stalled; refreshing inventory");
          this.sendWebhook("mining_stalled", "Mining progress stalled", "No confirmed progress for 15 minutes; an automatic refresh was requested.");
          engine.changeState(EngineState.INVENTORY_FETCH, true);
        }
      }
    })();
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function plain(status: number, message: string): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function file(path: string, contentType: string): Response {
  return new Response(Bun.file(path), { headers: { "Content-Type": contentType } });
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
