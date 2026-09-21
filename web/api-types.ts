/**
 * Shared dashboard contract for Twitch Drops Miner Next.
 *
 * Mirrors `WebUI.snapshot()` in `webui.py` (plus `_campaign_json`,
 * `_drop_json`, `_channel_json`, `History.query`/`summary` and
 * `Stats.snapshot()`). The Python backend remains authoritative at runtime;
 * this file exists so Bun tooling (`tsc --noEmit`, `Bun.build`,
 * `Bun.serve` previews, Playwright tests) can type-check fixtures and
 * frontend code against the same shape without importing Python.
 *
 * Keep in sync when `webui.py:snapshot` changes.
 */

export type CampaignStatus = "active" | "upcoming" | "expired" | "unavailable";
export type ActivityState = string;
export type HistorySource = "inventory" | "local" | "both";

export interface DropBenefit {
  name: string;
  type: string;
  image: string;
}

export interface DropPrerequisite {
  id: string;
  name: string;
  claimed: boolean;
}

export interface TimedDropJson {
  id: string;
  name: string;
  rewards: string;
  claimed: boolean;
  claimable: boolean;
  currentMinutes: number;
  requiredMinutes: number;
  remainingMinutes: number;
  progress: number;
  totalRemainingMinutes?: number;
  prerequisites?: DropPrerequisite[];
  startsAt: string;
  endsAt: string;
  benefits: DropBenefit[];
}

export interface CampaignJson {
  id: string;
  name: string;
  game: string;
  gameId: string;
  image: string;
  linkUrl: string;
  linked: boolean;
  eligible: boolean;
  finished: boolean;
  status: CampaignStatus;
  startsAt: string;
  endsAt: string;
  claimedDrops: number;
  totalDrops: number;
  remainingMinutes: number;
  progress: number;
  drops: TimedDropJson[];
}

export interface ChannelJson {
  id: number;
  name: string;
  login: string;
  url: string;
  online: boolean;
  pending: boolean;
  watching: boolean;
  watchable: boolean;
  game: string | null;
  viewers: number | null;
  dropsEnabled: boolean;
  title: string | null;
}

export interface LoginState {
  status: string;
  userId: number | null;
  activationUrl?: string | null;
  activationCode?: string | null;
}

export interface MinerSettings {
  priority: string[];
  exclude: string[];
  priorityMode: "PRIORITY_ONLY" | "ENDING_SOONEST" | "LOW_AVBL_FIRST" | string;
  connectionQuality: number;
  trayNotifications: boolean;
  enableBadgesEmotes: boolean;
  availableDropsCheck: boolean;
  autostart?: boolean;
  keepAwake?: boolean;
  proxy: string;
  webhookUrl?: string;
}

export interface MiningPlanItem {
  game: string;
  gameId: string | null;
  campaignId: string | null;
  name?: string;
  image?: string | null;
  reason: string;
  reasonCode: string;
  remainingMinutes: number | null;
  estimatedCompletionAt: string | null;
  endsAt: string | null;
  watching: boolean;
  priority: boolean;
}

export interface ProgressHealth {
  lastConfirmedAt: string | null;
  secondsWithoutProgress: number | null;
  nextRecoveryInSeconds: number | null;
  recoveryReason: string | null;
}

export interface MinerStats {
  startedAt?: string | null;
  uptimeSeconds: number;
  session: Record<string, number>;
  lifetime: Record<string, number | string | null>;
  lastInventoryAt?: string | null;
  lastRecoveryAt?: string | null;
}

export interface MinerSystem {
  version: string;
  upstreamVersion: string;
  python: string;
  platform: string;
  packaged: boolean;
  dataDirectory: string;
  authenticationEnabled: boolean;
  webhookManagedByEnvironment?: boolean;
}

export interface MinerMessage {
  time: string;
  level?: string;
  message: string;
}

export interface MinerNotification {
  time: string;
  title: string;
  message: string;
}

export interface WebSocketJson {
  id: number;
  status: string;
  topics: number;
}

export interface DashboardState {
  revision: number;
  paused: boolean;
  miningPlan: MiningPlanItem[];
  progressHealth?: ProgressHealth | null;
  status: string;
  activity: ActivityState;
  login: LoginState;
  canLogout: boolean;
  watchingChannelId: number | null;
  activeDrop: TimedDropJson | null;
  campaigns: CampaignJson[];
  channels: ChannelJson[];
  websockets: WebSocketJson[];
  messages: MinerMessage[];
  notifications: MinerNotification[];
  stats: MinerStats;
  system: MinerSystem;
  networkIssues: string[];
  games: string[];
  settings: MinerSettings;
  summary: {
    campaigns: number;
    activeCampaigns: number;
    completedCampaigns: number;
    onlineChannels: number;
  };
}

export interface HistoryItem {
  benefitId: string;
  name: string;
  imageUrl: string | null;
  gameId: string | null;
  gameName: string;
  campaignId: string | null;
  campaignName: string | null;
  lastAwardedAt: string | null;
  observedAt: string;
  source: HistorySource | string;
  awardCount: number | null;
}

export interface HistorySummaryGame {
  id: string | null;
  name: string;
  rewardCount: number;
  localClaimCount?: number;
}

export interface HistorySummary {
  rewardCount: number;
  localClaimCount?: number;
  gameCount: number;
  games: HistorySummaryGame[];
  coverage: string;
  lastSyncedAt: string | null;
}

export interface HistoryResponse {
  items: HistoryItem[];
  total: number;
  offset: number;
  limit: number;
  summary?: HistorySummary;
}
