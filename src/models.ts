/**
 * Port of `channel.py` + `inventory.py`: engine domain models.
 *
 * `Game` and the pure helpers live in `utils.ts`; GQL documents, limits and
 * states in `twitchProtocol.ts`; errors in `errors.ts`.
 *
 * Deviations from Python (documented):
 * - `twitch` references are typed as `EngineLike` (the engine implements it
 *   in a later phase); translations come from `engine.translate(...)`.
 * - `request()` returns the response directly instead of an async context
 *   manager; `logger` output goes to `engine.warn(...)`.
 * - `Channel.remove()`/`checkOnline()` use `setTimeout` handles instead of
 *   `asyncio.Task`s. `bumpMinutes` evaluates every drop (Python's list
 *   comprehension has no short-circuit, unlike `Array.some`).
 * - Times are `Date`; trigger sets hold epoch millis.
 */

import { gzipSync } from "node:zlib";
import { EngineState, GQL_QUERIES, INTERVALS, LIMITS, type GqlQuery } from "./twitchProtocol.ts";
import { Game, type GameData, isonow, jsonMinify, timestamp } from "./utils.ts";
import { GQLException, MinerException, RequestException } from "./errors.ts";

export interface HttpResponse {
  status: number;
  text(): Promise<string>;
}

export interface EngineGui {
  channels: {
    display(channel: Channel, options?: { add?: boolean }): void;
    remove(channel: Channel): void;
  };
  inv: {
    updateDrop(drop: TimedDrop): void;
  };
  displayDrop(drop: TimedDrop, options?: { countdown?: boolean; subone?: boolean }): void;
  notifier: {
    notify(message: string, title: string): void;
  };
}

export interface EngineStats {
  progress(minutes: number): void;
  claim(): void;
}

export interface EngineLike {
  settings: {
    available_drops_check: boolean;
    enable_badges_emotes: boolean;
  };
  authUserId: string | number | null;
  clientUrl: string;
  campaigns: Map<string, DropsCampaign>;
  gui: EngineGui;
  translate(section: string, key: string, subkey?: string): string;
  print(message: string): void;
  warn(message: string): void;
  changeState(state: EngineState): void;
  stats: EngineStats;
  recordClaimHistory(drop: BaseDrop): void;
  getAuth(): Promise<{ user_id: string | number }>;
  request(method: string, url: string, options?: { headers?: Record<string, string>; data?: unknown }): Promise<HttpResponse>;
  gqlRequest(query: GqlQuery | Record<string, unknown>): Promise<Record<string, unknown>>;
  onChannelUpdate(channel: Channel, oldStream: Stream | null, newStream: Stream | null): void;
}

const DIMS_PATTERN = /-\d+x\d+(?=\.(?:jpg|png|gif)$)/i;

export function removeDimensions(url: string): string {
  return url.replace(DIMS_PATTERN, "");
}

export enum BenefitType {
  UNKNOWN = "UNKNOWN",
  BADGE = "BADGE",
  EMOTE = "EMOTE",
  DIRECT_ENTITLEMENT = "DIRECT_ENTITLEMENT",
}

function parseBenefitType(raw: unknown): BenefitType {
  if (raw === BenefitType.BADGE || raw === BenefitType.EMOTE || raw === BenefitType.DIRECT_ENTITLEMENT) return raw;
  return BenefitType.UNKNOWN;
}

export interface BenefitData {
  benefit: {
    id: string;
    name: string;
    distributionType?: string;
    imageAssetURL: string;
  };
}

export class Benefit {
  readonly id: string;
  readonly name: string;
  readonly type: BenefitType;
  readonly imageUrl: string;

  constructor(data: BenefitData) {
    const inner = data["benefit"];
    this.id = inner["id"];
    this.name = inner["name"];
    this.type = parseBenefitType(inner["distributionType"]);
    this.imageUrl = inner["imageAssetURL"];
  }

  isBadgeOrEmote(): boolean {
    return this.type === BenefitType.BADGE || this.type === BenefitType.EMOTE;
  }
}

export interface DropData {
  id: string;
  name: string;
  benefitEdges?: BenefitData[] | null;
  startAt: string;
  endAt: string;
  self?: { dropInstanceID: string; isClaimed: boolean; currentMinutesWatched?: number } | null;
  preconditionDrops?: Array<{ id: string }> | null;
}

export abstract class BaseDrop {
  readonly id: string;
  readonly name: string;
  readonly campaign: DropsCampaign;
  readonly benefits: Benefit[];
  readonly startsAt: Date;
  readonly endsAt: Date;
  claimId: string | null = null;
  isClaimed = false;
  readonly preconditionDrops: string[];

  constructor(campaign: DropsCampaign, data: DropData, claimedBenefits: Map<string, Date>) {
    this.campaign = campaign;
    this.id = data["id"];
    this.name = data["name"];
    this.benefits = (data["benefitEdges"] ?? []).map((b) => new Benefit(b));
    this.startsAt = timestamp(data["startAt"]);
    this.endsAt = timestamp(data["endAt"]);
    if (data["self"] != null) {
      this.claimId = data["self"].dropInstanceID;
      this.isClaimed = data["self"].isClaimed;
    } else {
      // No self edge: infer from claimed benefits whose award falls inside
      // this drop's window (mirrors the Python walrus-chain exactly).
      const dts = this.benefits
        .map((benefit) => claimedBenefits.get(benefit.id))
        .filter((dt): dt is Date => dt !== undefined);
      if (dts.length > 0 && dts.every((dt) => this.startsAt <= dt && dt < this.endsAt)) {
        this.isClaimed = true;
      }
    }
    this.preconditionDrops = (data["preconditionDrops"] ?? []).map((d) => d["id"]);
  }

  protected get twitch(): EngineLike {
    return this.campaign.engine;
  }

  get preconditionsMet(): boolean {
    return this.preconditionDrops.every((pid) => {
      const dep = this.campaign.timedDrops.get(pid);
      if (!dep) throw new MinerException(`Unknown precondition drop: ${pid}`);
      return dep.isClaimed;
    });
  }

  protected abstract onStateChanged(): void;

  /** Python underscore-methods are truly accessible; TS keeps them public. */
  baseEarnConditions(): boolean {
    return (
      this.preconditionsMet &&
      !this.isClaimed &&
      (this.benefits.length > 0 || this.campaign.preconditionsChain().has(this.id))
    );
  }

  baseCanEarn(): boolean {
    return this.baseEarnConditions() && this.startsAt <= new Date() && new Date() < this.endsAt;
  }

  canEarnWithin(stamp: Date): boolean {
    return this.baseEarnConditions() && this.endsAt > new Date() && this.startsAt < stamp;
  }

  canEarn(channel: Channel | null = null, ignoreChannelStatus = false): boolean {
    return this.baseCanEarn() && this.campaign.baseCanEarn(channel, ignoreChannelStatus);
  }

  get canClaim(): boolean {
    // Claimable until 24h after the campaign ends (Twitch mission-based-drops rule).
    return (
      this.claimId !== null && !this.isClaimed && Date.now() < this.campaign.endsAt.getTime() + 24 * 3600 * 1000
    );
  }

  updateClaim(claimId: string): void {
    this.claimId = claimId;
  }

  async generateClaim(): Promise<void> {
    // Claim IDs are constructed as UserID#CampaignID#DropID.
    const auth = await this.twitch.getAuth();
    this.claimId = `${auth.user_id}#${this.campaign.id}#${this.id}`;
  }

  rewardsText(delim = ", "): string {
    return this.benefits.map((b) => b.name).join(delim);
  }

  async claim(): Promise<boolean> {
    const wasClaimed = this.isClaimed;
    const result = await this.performClaim();
    if (result) {
      this.isClaimed = result;
      const claimText = `${this.campaign.game.name}\n${this.rewardsText()} (${this.campaign.claimedDrops}/${this.campaign.totalDrops})`;
      this.twitch.print(this.twitch.translate("status", "claimed_drop").split("{drop}").join(claimText.replace("\n", " ")));
      this.twitch.gui.notifier.notify(claimText, this.twitch.translate("gui", "tray", "notification_title"));
      if (!wasClaimed) {
        this.twitch.recordClaimHistory(this);
        this.twitch.stats.claim();
      }
    } else {
      this.twitch.warn(`Drop claim has potentially failed! Drop ID: ${this.id}`);
    }
    return result;
  }

  protected async performClaim(): Promise<boolean> {
    if (this.isClaimed) return true;
    if (!this.canClaim) return false;
    let response: Record<string, unknown>;
    try {
      response = await this.twitch.gqlRequest(
        GQL_QUERIES["ClaimDrop"]!.withVariables({ input: { dropInstanceID: this.claimId } }),
      );
    } catch (error) {
      if (error instanceof GQLException) return false;
      throw error;
    }
    const data = response["data"] as Record<string, unknown>;
    if (Array.isArray(response["errors"]) && (response["errors"] as unknown[]).length > 0) return false;
    if (data && Array.isArray(data["errors"]) && (data["errors"] as unknown[]).length > 0) return false;
    if (data && typeof data["claimDropRewards"] === "object" && data["claimDropRewards"] !== null) {
      const rewards = data["claimDropRewards"] as Record<string, unknown>;
      if (!rewards) return false;
      if (rewards["status"] === "ELIGIBLE_FOR_ALL" || rewards["status"] === "DROP_INSTANCE_ALREADY_CLAIMED") return true;
    }
    return false;
  }
}

export class TimedDrop extends BaseDrop {
  realCurrentMinutes: number;
  readonly requiredMinutes: number;
  extraCurrentMinutes = 0;

  constructor(campaign: DropsCampaign, data: DropData & { requiredMinutesWatched: number }, claimedBenefits: Map<string, Date>) {
    super(campaign, data, claimedBenefits);
    this.realCurrentMinutes = (data["self"] != null && data["self"].currentMinutesWatched) || 0;
    this.requiredMinutes = data["requiredMinutesWatched"];
    if (this.isClaimed) {
      // Claimed drops may report inconsistent minutes; overwrite them.
      this.realCurrentMinutes = this.requiredMinutes;
    }
  }

  protected onStateChanged(): void {
    this.twitch.gui.inv.updateDrop(this);
  }

  get currentMinutes(): number {
    return this.realCurrentMinutes + this.extraCurrentMinutes;
  }

  get remainingMinutes(): number {
    return this.requiredMinutes - this.currentMinutes;
  }

  get totalRequiredMinutes(): number {
    let extra = 0;
    for (const pid of this.preconditionDrops) {
      const dep = this.campaign.timedDrops.get(pid);
      if (dep) extra = Math.max(extra, dep.totalRequiredMinutes);
    }
    return this.requiredMinutes + extra;
  }

  get totalRemainingMinutes(): number {
    let extra = 0;
    for (const pid of this.preconditionDrops) {
      const dep = this.campaign.timedDrops.get(pid);
      if (dep) extra = Math.max(extra, dep.totalRemainingMinutes);
    }
    return this.remainingMinutes + extra;
  }

  get progress(): number {
    if (this.currentMinutes <= 0 || this.requiredMinutes <= 0) return 0.0;
    if (this.currentMinutes >= this.requiredMinutes) return 1.0;
    return this.currentMinutes / this.requiredMinutes;
  }

  get availability(): number {
    const now = Date.now();
    if (this.requiredMinutes > 0 && this.totalRemainingMinutes > 0 && now < this.endsAt.getTime()) {
      return (this.endsAt.getTime() - now) / 60000 / this.totalRemainingMinutes;
    }
    return Infinity;
  }

  override baseEarnConditions(): boolean {
    return super.baseEarnConditions() && this.requiredMinutes > 0 && this.extraCurrentMinutes < LIMITS.maxExtraMinutes;
  }

  updateRealMinutes(delta: number): void {
    if (delta === 0 || this.realCurrentMinutes + delta < 0) return;
    if (this.realCurrentMinutes + delta < this.requiredMinutes) {
      this.realCurrentMinutes += delta;
    } else {
      this.realCurrentMinutes = this.requiredMinutes;
    }
    this.extraCurrentMinutes = 0;
    this.onStateChanged();
  }

  bumpMinutes(channel: Channel | null): boolean {
    if (this.canEarn(channel)) {
      this.extraCurrentMinutes += 1;
      this.onStateChanged();
      if (this.extraCurrentMinutes >= LIMITS.maxExtraMinutes) return true;
    }
    return false;
  }

  override async claim(): Promise<boolean> {
    const result = await super.claim();
    if (result) {
      this.realCurrentMinutes = this.requiredMinutes;
      this.extraCurrentMinutes = 0;
    }
    this.onStateChanged();
    return result;
  }

  display(options?: { countdown?: boolean; subone?: boolean }): void {
    this.twitch.gui.displayDrop(this, options);
  }

  updateMinutes(newMinutes: number): void {
    let delta = newMinutes - this.realCurrentMinutes;
    if (delta === 0) return;
    if (this.realCurrentMinutes + delta < 0) {
      delta = -this.realCurrentMinutes;
    } else if (this.realCurrentMinutes + delta > this.requiredMinutes) {
      delta = this.requiredMinutes - this.realCurrentMinutes;
    }
    this.campaign.updateRealMinutes(delta);
    this.twitch.stats.progress(delta);
  }
}

export interface CampaignData {
  id: string;
  name: string;
  game: GameData & { boxArtURL: string };
  self: { isAccountConnected: boolean };
  accountLinkURL: string;
  startAt: string;
  endAt: string;
  status: string;
  allow: { channels?: Array<{ id: number | string; name: string; displayName?: string }> | null; isEnabled?: boolean };
  timeBasedDrops: Array<DropData & { requiredMinutesWatched: number }>;
}

export class DropsCampaign {
  readonly id: string;
  readonly name: string;
  readonly game: Game;
  readonly linked: boolean;
  readonly linkUrl: string;
  readonly imageUrl: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  private readonly valid: boolean;
  readonly allowedChannels: Channel[];
  readonly timedDrops: Map<string, TimedDrop>;
  private memoBadgeOrEmote?: boolean;

  constructor(
    readonly engine: EngineLike,
    data: CampaignData,
    claimedBenefits: Map<string, Date>,
  ) {
    this.id = data["id"];
    this.name = data["name"];
    this.game = new Game(data["game"]);
    this.linked = data["self"]["isAccountConnected"];
    this.linkUrl = data["accountLinkURL"];
    // The campaign image comes from the game object minus its dimensions part.
    this.imageUrl = removeDimensions(data["game"]["boxArtURL"]);
    this.startsAt = timestamp(data["startAt"]);
    this.endsAt = timestamp(data["endAt"]);
    this.valid = data["status"] !== "EXPIRED";
    const allowed = data["allow"];
    this.allowedChannels =
      allowed["channels"] && allowed["isEnabled"] !== false
        ? allowed["channels"].map((c) => Channel.fromAcl(engine, c))
        : [];
    this.timedDrops = new Map(
      data["timeBasedDrops"].map((dropData) => [dropData["id"], new TimedDrop(this, dropData, claimedBenefits)]),
    );
  }

  get drops(): Iterable<TimedDrop> {
    return this.timedDrops.values();
  }

  get timeTriggers(): Set<number> {
    const triggers = new Set<number>([this.startsAt.getTime(), this.endsAt.getTime()]);
    for (const drop of this.drops) {
      triggers.add(drop.startsAt.getTime());
      triggers.add(drop.endsAt.getTime());
    }
    return triggers;
  }

  get active(): boolean {
    const now = Date.now();
    return this.valid && this.startsAt.getTime() <= now && now < this.endsAt.getTime();
  }

  get upcoming(): boolean {
    return this.valid && Date.now() < this.startsAt.getTime();
  }

  get expired(): boolean {
    return !this.valid || this.endsAt.getTime() <= Date.now();
  }

  get totalDrops(): number {
    return this.timedDrops.size;
  }

  get eligible(): boolean {
    if (this.hasBadgeOrEmote) return this.engine.settings.enable_badges_emotes;
    return this.linked;
  }

  get hasBadgeOrEmote(): boolean {
    if (this.memoBadgeOrEmote === undefined) {
      this.memoBadgeOrEmote = [...this.drops].some((drop) => drop.benefits.some((b) => b.isBadgeOrEmote()));
    }
    return this.memoBadgeOrEmote;
  }

  get finished(): boolean {
    return [...this.drops].every((d) => d.isClaimed || d.requiredMinutes <= 0);
  }

  get claimedDrops(): number {
    return [...this.drops].filter((d) => d.isClaimed).length;
  }

  get remainingDrops(): number {
    return [...this.drops].filter((d) => !d.isClaimed).length;
  }

  get requiredMinutes(): number {
    return Math.max(...[...this.drops].map((d) => d.totalRequiredMinutes));
  }

  get remainingMinutes(): number {
    return Math.max(...[...this.drops].map((d) => d.totalRemainingMinutes));
  }

  get progress(): number {
    return [...this.drops].reduce((sum, d) => sum + d.progress, 0) / this.totalDrops;
  }

  get availability(): number {
    return Math.min(...[...this.drops].map((d) => d.availability));
  }

  get firstDrop(): TimedDrop | null {
    const earnable = [...this.drops].filter((d) => d.canEarn()).sort((a, b) => a.remainingMinutes - b.remainingMinutes);
    return earnable[0] ?? null;
  }

  updateRealMinutes(delta: number): void {
    for (const drop of this.drops) drop.updateRealMinutes(delta);
    this.firstDrop?.display();
  }

  baseCanEarn(channel: Channel | null = null, ignoreChannelStatus = false): boolean {
    return (
      this.eligible &&
      this.active &&
      (channel === null ||
        ((!this.allowedChannels.length || this.allowedChannels.some((c) => c.equals(channel))) &&
          (ignoreChannelStatus || (channel.game !== null && channel.game.equals(this.game)) || this.game.isSpecial())))
    );
  }

  getDrop(dropId: string): TimedDrop | undefined {
    return this.timedDrops.get(dropId);
  }

  preconditionsChain(): Set<string> {
    const chain = new Set<string>();
    for (const drop of this.drops) {
      if (!drop.isClaimed) for (const pid of drop.preconditionDrops) chain.add(pid);
    }
    return chain;
  }

  canEarn(channel: Channel | null = null, ignoreChannelStatus = false): boolean {
    return this.baseCanEarn(channel, ignoreChannelStatus) && [...this.drops].some((d) => d.baseCanEarn());
  }

  canEarnWithin(stamp: Date): boolean {
    return (
      this.eligible &&
      this.valid &&
      this.endsAt.getTime() > Date.now() &&
      this.startsAt < stamp &&
      [...this.drops].some((d) => d.canEarnWithin(stamp))
    );
  }

  bumpMinutes(channel: Channel): void {
    // NOTE: every drop is bumped before checking (no short-circuit, like Python).
    const results = [...this.drops].map((drop) => drop.bumpMinutes(channel));
    if (results.includes(true)) {
      this.engine.warn(
        `At least one of the drops in campaign "${this.name}(${this.game.name})" has reached the maximum extra minutes limit!`,
      );
      this.engine.changeState(EngineState.CHANNEL_SWITCH);
    }
    this.firstDrop?.display();
  }
}

export interface StreamData {
  id: number | string;
  game: GameData | null;
  viewers: number;
  title: string;
}

export class Stream {
  readonly broadcastId: number;
  viewers: number;
  dropsEnabled: boolean;
  readonly game: Game | null;
  readonly title: string;
  private streamUrl: string | null = null;
  private memoWatchPayload?: Array<Record<string, unknown>>;
  private memoSpadePayload?: Record<string, unknown>;
  private memoGqlPayload?: Record<string, unknown>;

  constructor(
    readonly channel: Channel,
    data: StreamData & { dropsEnabled?: boolean },
  ) {
    this.broadcastId = Number(data.id);
    this.viewers = data.viewers;
    this.dropsEnabled = data.dropsEnabled ?? !channel.engine.settings.available_drops_check;
    this.game = data.game ? new Game(data.game) : null;
    this.title = data.title;
  }

  static fromGetStream(channel: Channel, channelData: { stream: { id: number | string; viewersCount: number }; broadcastSettings: { game: GameData | null; title: string } }): Stream {
    return new Stream(channel, {
      id: channelData["stream"]["id"],
      game: channelData["broadcastSettings"]["game"],
      viewers: channelData["stream"]["viewersCount"],
      title: channelData["broadcastSettings"]["title"],
    });
  }

  static fromDirectory(
    channel: Channel,
    channelData: { id: number | string; game: GameData; viewersCount: number; title: string },
    dropsEnabled = false,
  ): Stream {
    return new Stream(channel, {
      id: channelData["id"],
      game: channelData["game"],
      viewers: channelData["viewersCount"],
      title: channelData["title"],
      dropsEnabled,
    });
  }

  equals(other: unknown): boolean {
    return other instanceof Stream && other.broadcastId === this.broadcastId;
  }

  get watchPayload(): Array<Record<string, unknown>> {
    if (!this.memoWatchPayload) {
      this.memoWatchPayload = [
        {
          event: "minute-watched",
          properties: {
            broadcast_id: String(this.broadcastId),
            channel_id: String(this.channel.id),
            channel: this.channel.login,
            client_time: isonow(),
            game: this.game?.name ?? "",
            game_id: this.game ? String(this.game.id) : "",
            hidden: false,
            is_live: true,
            live: true,
            logged_in: true,
            minutes_logged: 1,
            muted: false,
            user_id: this.channel.engine.authUserId,
          },
        },
      ];
    }
    return this.memoWatchPayload;
  }

  get spadePayload(): Record<string, unknown> {
    if (!this.memoSpadePayload) {
      this.memoSpadePayload = { data: Buffer.from(jsonMinify(this.watchPayload), "utf8").toString("base64") };
    }
    return this.memoSpadePayload;
  }

  get gqlPayload(): Record<string, unknown> {
    if (!this.memoGqlPayload) {
      const compressed = gzipSync(Buffer.from(jsonMinify(this.watchPayload), "utf8"));
      this.memoGqlPayload = {
        query: "\n mutation SendEvents($input: SendSpadeEventsInput!) {\n sendSpadeEvents(input: $input) {\n statusCode\n}\n}\n",
        variables: {
          input: { data: compressed.toString("base64"), repository: "twilight", encoding: "GZIP_B64" },
        },
      };
    }
    return this.memoGqlPayload;
  }

  async getStreamUrl(): Promise<string | null> {
    if (this.streamUrl !== null) return this.streamUrl;
    const response = await this.channel.engine.gqlRequest(
      GQL_QUERIES["PlaybackAccessToken"]!.withVariables({ login: this.channel.login }),
    );
    const token = (response["data"] as Record<string, Record<string, string>>)["streamPlaybackAccessToken"]!;
    const qualitiesResponse = await this.channel.engine.request(
      "GET",
      `https://usher.ttvnw.net/api/channel/hls/${this.channel.login}.m3u8?sig=${token["signature"]}&token=${token["value"]}`,
    );
    const body = await qualitiesResponse.text();
    const parsed = tryParseJson(body);
    if (parsed !== undefined) {
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (first !== null && typeof first === "object" && "error" in (first as Record<string, unknown>)) {
        this.channel.engine.warn(`Stream URL get error: "${String((first as Record<string, unknown>)["error"])}"`);
        this.channel.setOffline();
      }
      return null;
    }
    // Pick the last URL: usually the lowest-quality stream.
    const last = body.trim().split("\n").at(-1) ?? "";
    try {
      this.streamUrl = new URL(last).toString();
    } catch {
      this.channel.engine.print(body);
      throw new MinerException(`Invalid stream URL: ${last}`);
    }
    return this.streamUrl;
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface AclData {
  id: number | string;
  name: string;
  displayName?: string;
}

export interface DirectoryData {
  broadcaster: { id: number | string; login: string; displayName?: string };
  id: number | string;
  game: GameData;
  viewersCount: number;
  title: string;
}

export class Channel {
  readonly id: number;
  readonly login: string;
  private displayName: string | null;
  private spadeUrl: string | null = null;
  stream: Stream | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  readonly aclBased: boolean;

  constructor(
    readonly engine: EngineLike,
    data: { id: number | string; login: string; displayName?: string | null; aclBased?: boolean },
  ) {
    this.id = Number(data.id);
    this.login = data.login;
    this.displayName = data.displayName ?? null;
    this.aclBased = data.aclBased ?? false;
  }

  static fromAcl(engine: EngineLike, data: AclData): Channel {
    return new Channel(engine, { id: data["id"], login: data["name"], displayName: data["displayName"], aclBased: true });
  }

  static fromDirectory(engine: EngineLike, data: DirectoryData, dropsEnabled = false): Channel {
    const channel = new Channel(engine, {
      id: data["broadcaster"]["id"],
      login: data["broadcaster"]["login"],
      displayName: data["broadcaster"]["displayName"],
    });
    channel.stream = Stream.fromDirectory(channel, data, dropsEnabled);
    return channel;
  }

  toString(): string {
    const name = this.displayName !== null ? `${this.displayName}(${this.login})` : this.login;
    return `Channel(${name}, ${this.id})`;
  }

  equals(other: unknown): boolean {
    return other instanceof Channel && other.id === this.id;
  }

  get streamGql(): GqlQuery {
    return GQL_QUERIES["GetStreamInfo"]!.withVariables({ channel: this.login });
  }

  get name(): string {
    return this.displayName ?? this.login;
  }

  get url(): string {
    return `${this.engine.clientUrl}/${this.login}`;
  }

  get iid(): string {
    return String(this.id);
  }

  get online(): boolean {
    return this.stream !== null;
  }

  get offline(): boolean {
    return this.stream === null && this.pendingTimer === null;
  }

  get pendingOnline(): boolean {
    return this.stream === null && this.pendingTimer !== null;
  }

  get game(): Game | null {
    return this.stream?.game ?? null;
  }

  get viewers(): number | null {
    return this.stream?.viewers ?? null;
  }

  set viewers(value: number) {
    if (this.stream !== null) this.stream.viewers = value;
  }

  get dropsEnabled(): boolean {
    return this.stream?.dropsEnabled ?? false;
  }

  display(options?: { add?: boolean }): void {
    this.engine.gui.channels.display(this, options);
  }

  remove(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.engine.gui.channels.remove(this);
  }

  async getSpadeUrl(): Promise<string> {
    const SETTINGS_PATTERN = /src="(https:\/\/[\w.]+\/config\/settings\.[0-9a-f]{32}\.js)"/i;
    const SPADE_PATTERN = /"spade_?url": ?"(https:\/\/[.\w\-/]+)"/i;
    const first = await this.engine.request("GET", this.url);
    const html = await first.text();
    let match = html.match(SPADE_PATTERN);
    if (!match) {
      const settingsMatch = html.match(SETTINGS_PATTERN);
      if (!settingsMatch) throw new MinerException("Error while spade_url extraction: step #1");
      const second = await this.engine.request("GET", settingsMatch[1]!);
      const settingsJs = await second.text();
      match = settingsJs.match(SPADE_PATTERN);
      if (!match) throw new MinerException("Error while spade_url extraction: step #2");
    }
    return match[1]!;
  }

  checkDropsEnabled(availableDrops: Array<{ id: string }>): boolean {
    return availableDrops.some((campaignData) => {
      const campaign = this.engine.campaigns.get(campaignData["id"]);
      return campaign !== undefined && campaign.canEarn(this, true);
    });
  }

  externalUpdate(channelData: { stream: unknown } & Record<string, unknown>, availableDrops: Array<{ id: string }>): void {
    if (!channelData["stream"]) {
      this.stream = null;
      return;
    }
    const stream = Stream.fromGetStream(this, channelData as Parameters<typeof Stream.fromGetStream>[1]);
    if (!stream.dropsEnabled) {
      stream.dropsEnabled = this.checkDropsEnabled(availableDrops);
    }
    this.stream = stream;
  }

  async getStream(): Promise<Stream | null> {
    let response: Record<string, unknown>;
    try {
      response = await this.engine.gqlRequest(this.streamGql);
    } catch (error) {
      if (error instanceof MinerException) throw new MinerException(`Channel: ${this.login}`);
      throw error;
    }
    const channelData = (response["data"] as Record<string, unknown>)["user"] as Record<string, unknown> | null;
    if (!channelData) return null;
    if (this.displayName === null) this.displayName = channelData["displayName"] as string;
    if (!channelData["stream"]) return null;
    const stream = Stream.fromGetStream(this, channelData as Parameters<typeof Stream.fromGetStream>[1]);
    if (!stream.dropsEnabled) {
      try {
        const campaigns = await this.engine.gqlRequest(
          GQL_QUERIES["AvailableDrops"]!.withVariables({ channelID: String(this.id) }),
        );
        const channel = (campaigns["data"] as Record<string, Record<string, Array<{ id: string }> | null>>)["channel"]!;
        stream.dropsEnabled = this.checkDropsEnabled(channel["viewerDropCampaigns"] ?? []);
      } catch (error) {
        if (!(error instanceof MinerException)) throw error;
        // CALL-level in Python (below INFO): not worth surfacing.
      }
    }
    return stream;
  }

  async updateStream(): Promise<boolean> {
    const oldStream = this.stream;
    this.stream = await this.getStream();
    this.engine.onChannelUpdate(this, oldStream, this.stream);
    return this.stream !== null;
  }

  checkOnline(): void {
    if (this.pendingTimer === null) {
      this.pendingTimer = setTimeout(() => {
        void (async () => {
          this.pendingTimer = null;
          await this.updateStream();
        })();
      }, INTERVALS.onlineDelay);
      this.display();
    }
  }

  setOffline(): void {
    let needsDisplay = false;
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
      needsDisplay = true;
    }
    if (this.online) {
      const oldStream = this.stream;
      this.stream = null;
      this.engine.onChannelUpdate(this, oldStream, this.stream);
      needsDisplay = false;
    }
    if (needsDisplay) this.display();
  }

  async sendWatchPlaylist(): Promise<boolean> {
    if (this.stream === null) return false;
    const streamUrl = await this.stream.getStreamUrl();
    if (streamUrl === null) return false;
    const chunksResponse = await this.engine.request("GET", streamUrl, { headers: { Connection: "close" } });
    if (chunksResponse.status >= 400) return false;
    let chunks = await chunksResponse.text();
    chunks = chunks.replace(/"url": ?".+?"\},/g, "");
    const parsed = tryParseJson(chunks);
    if (parsed !== undefined) {
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (first !== null && typeof first === "object" && "error" in (first as Record<string, unknown>)) {
        this.engine.warn(`Send watch error: "${String((first as Record<string, unknown>)["error"])}"`);
      }
      return false;
    }
    const lines = chunks.trim().split("\n");
    let selected = lines.at(-1) ?? "";
    if (selected === "#EXT-X-ENDLIST") selected = lines.at(-2) ?? "";
    const head = await this.engine.request("HEAD", selected);
    return head.status === 200;
  }

  async sendWatch(): Promise<boolean> {
    if (this.stream === null) return false;
    if (this.spadeUrl === null) this.spadeUrl = await this.getSpadeUrl();
    try {
      const response = await this.engine.request("POST", this.spadeUrl, { data: this.stream.spadePayload });
      return response.status === 204;
    } catch (error) {
      if (error instanceof RequestException) return false;
      throw error;
    }
  }

  async sendWatchGql(): Promise<boolean> {
    if (this.stream === null) return false;
    try {
      const response = await this.engine.gqlRequest(this.stream.gqlPayload);
      const data = response["data"] as Record<string, Record<string, number>>;
      return data["sendSpadeEvents"]!["statusCode"] === 204;
    } catch (error) {
      if (error instanceof RequestException) return false;
      throw error;
    }
  }
}
