/**
 * Port of the pure-protocol data in `constants.py`: persisted GQL queries,
 * websocket topics, client identities, engine states, limits and intervals.
 *
 * Hashes, topic names and client IDs are wire values — they must stay
 * byte-identical to Python. Times are milliseconds (Python `timedelta`s).
 */

export enum PriorityMode {
  PRIORITY_ONLY = 0,
  ENDING_SOONEST = 1,
  LOW_AVBL_FIRST = 2,
}

export enum EngineState {
  IDLE = "IDLE",
  INVENTORY_FETCH = "INVENTORY_FETCH",
  GAMES_UPDATE = "GAMES_UPDATE",
  CHANNELS_FETCH = "CHANNELS_FETCH",
  CHANNELS_CLEANUP = "CHANNELS_CLEANUP",
  CHANNEL_SWITCH = "CHANNEL_SWITCH",
  RESTART = "RESTART",
  EXIT = "EXIT",
}

/**
 * Placeholder for values the caller must supply via `withVariables`
 * (Python uses `Ellipsis` / `...` for these).
 */
export const UNSET: unique symbol = Symbol("twitchProtocol.unset");

export type GqlVariables = Record<string, unknown>;

export interface PersistedQuery {
  operationName: string;
  sha256Hash: string;
  variables?: GqlVariables;
}

function mergeVars(base: Record<string, unknown>, vars: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in base)) {
      base[key] = value;
    } else if (isVarsObject(value)) {
      if (!isVarsObject(base[key])) throw new Error(`Var is a dict, base is not: '${key}'`);
      mergeVars(base[key] as Record<string, unknown>, value);
    } else if (isVarsObject(base[key])) {
      throw new Error(`Base is a dict, var is not: '${key}'`);
    } else {
      base[key] = value;
    }
  }
}

function isVarsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepCopyVars(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepCopyVars);
  if (isVarsObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepCopyVars(item);
    return out;
  }
  return value;
}

function assertNoUnset(value: unknown, path: string): void {
  if (value === (UNSET as unknown)) throw new Error(`Unspecified variable: '${path}'`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnset(item, `${path}[${index}]`));
  } else if (isVarsObject(value)) {
    for (const [key, item] of Object.entries(value)) assertNoUnset(item, key);
  }
}

export class GqlQuery {
  constructor(
    readonly operationName: string,
    readonly sha256Hash: string,
    readonly variables: GqlVariables = {},
  ) {}

  /** Deep-merge caller variables (Python's `with_variables`); returns a copy. */
  withVariables(vars: GqlVariables): GqlQuery {
    const base = deepCopyVars(this.variables) as Record<string, unknown>;
    mergeVars(base, vars);
    return new GqlQuery(this.operationName, this.sha256Hash, base);
  }

  /** Throw if any `UNSET` placeholder survived (mirrors `_merge_vars`). */
  checked(): GqlQuery {
    assertNoUnset(this.variables, "(variables)");
    return this;
  }

  toJSON(): { operationName: string; extensions: { persistedQuery: { version: number; sha256Hash: string } }; variables?: GqlVariables } {
    return {
      operationName: this.operationName,
      extensions: { persistedQuery: { version: 1, sha256Hash: this.sha256Hash } },
      ...(Object.keys(this.variables).length > 0 ? { variables: this.variables } : {}),
    };
  }
}

const q = (operationName: string, sha256Hash: string, variables: GqlVariables = {}): GqlQuery =>
  new GqlQuery(operationName, sha256Hash, variables);

export const GQL_QUERIES: Record<string, GqlQuery> = {
  GetStreamInfo: q("VideoPlayerStreamInfoOverlayChannel", "198492e0857f6aedead9665c81c5a06d67b25b58034649687124083ff288597d", {
    channel: UNSET as unknown,
  }),
  ClaimCommunityPoints: q("ClaimCommunityPoints", "46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0", {
    input: { claimID: UNSET as unknown, channelID: UNSET as unknown },
  }),
  ClaimDrop: q("DropsPage_ClaimDropRewards", "a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930", {
    input: { dropInstanceID: UNSET as unknown },
  }),
  ChannelPointsContext: q("ChannelPointsContext", "374314de591e69925fce3ddc2bcf085796f56ebb8cad67a0daa3165c03adc345", {
    channelLogin: UNSET as unknown,
  }),
  Inventory: q("Inventory", "8337eb8541b314040b0edde0c09c5c7a2783ba1960aa9edfbf3bac16d0fec404", {
    fetchRewardCampaigns: false,
  }),
  CurrentDrop: q("DropCurrentSessionContext", "4d06b702d25d652afb9ef835d2a550031f1cf762b193523a92166f40ea3d142b", {
    channelID: UNSET as unknown,
    channelLogin: "",
  }),
  Campaigns: q("ViewerDropsDashboard", "d9cae7761dafab85908c85e6683cb4201b449e66ac3bb5e894f15ff12aeafaa7", {
    fetchRewardCampaigns: false,
  }),
  CampaignDetails: q("DropCampaignDetails", "039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1", {
    channelLogin: UNSET as unknown,
    dropID: UNSET as unknown,
  }),
  AvailableDrops: q("DropsHighlightService_AvailableDrops", "782dad0f032942260171d2d80a654f88bdd0c5a9dddc392e9bc92218a0f42d20", {
    channelID: UNSET as unknown,
  }),
  PlaybackAccessToken: q("PlaybackAccessToken", "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9", {
    isLive: true,
    isVod: false,
    login: UNSET as unknown,
    platform: "web",
    playerType: "site",
    vodID: "",
  }),
  GameDirectory: q("DirectoryPage_Game", "86bcceb4e8b1a51256ff8eed8bd8aae4acacf80d737efe904f84f3aeadf8cafd", {
    limit: 30,
    slug: UNSET as unknown,
    imageWidth: 50,
    includeCostreaming: false,
    options: {
      broadcasterLanguages: [],
      freeformTags: null,
      includeRestricted: ["SUB_ONLY_LIVE"],
      recommendationsContext: { platform: "web" },
      sort: "RELEVANCE",
      systemFilters: [],
      tags: [],
      requestID: "JIRA-VXP-2397",
    },
    sortTypeIsRecency: false,
  }),
  SlugRedirect: q("DirectoryGameRedirect", "1f0300090caceec51f33c5e20647aceff9017f740f223c3c532ba6fa59f6b6cc", {
    name: UNSET as unknown,
  }),
  NotificationsView: q("OnsiteNotifications_View", "e8e06193f8df73d04a1260df318585d1bd7a7bb447afa058e52095513f2bfa4f", {
    input: {},
  }),
  NotificationsList: q("OnsiteNotifications_ListNotifications", "11cdb54a2706c2c0b2969769907675680f02a6e77d8afe79a749180ad16bfea6", {
    cursor: "",
    displayType: "VIEWER",
    language: "en",
    limit: 10,
    shouldLoadLastBroadcast: false,
  }),
  NotificationsDelete: q("OnsiteNotifications_DeleteNotification", "13d463c831f28ffe17dccf55b3148ed8b3edbbd0ebadd56352f1ff0160616816", {
    input: { id: "" },
  }),
};

export const WEBSOCKET_TOPICS: Record<string, Record<string, string>> = {
  User: {
    Presence: "presence",
    Drops: "user-drop-events",
    Notifications: "onsite-notifications",
    CommunityPoints: "community-points-user-v1",
  },
  Channel: {
    Drops: "channel-drop-events",
    StreamState: "video-playback-by-id",
    StreamUpdate: "broadcast-settings-update",
    CommunityPoints: "community-points-channel-v1",
  },
};

export function topicString(category: "User" | "Channel", topicName: string, targetId: number): string {
  const prefix = WEBSOCKET_TOPICS[category]?.[topicName];
  if (prefix === undefined) throw new Error(`Unknown websocket topic: ${category}.${topicName}`);
  return `${prefix}.${targetId}`;
}

export interface ClientInfo {
  clientUrl: string;
  clientId: string;
  userAgents: string[];
}

function client(clientUrl: string, clientId: string, userAgents: string | string[]): ClientInfo {
  return { clientUrl, clientId, userAgents: Array.isArray(userAgents) ? userAgents : [userAgents] };
}

const CHROME_138 = "Chrome/138.0.0.0 Safari/537.36";

export const CLIENT_TYPES: Record<"WEB" | "MOBILE_WEB" | "ANDROID_APP" | "SMARTBOX", ClientInfo> = {
  WEB: client(
    "https://www.twitch.tv",
    "kimne78kx3ncx6brgo4mv6wki5h1ko",
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ${CHROME_138}`,
  ),
  MOBILE_WEB: client("https://m.twitch.tv", "r8s4dac0uhzifbpu9sjdiwzctle17ff", [
    "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.158 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 16; SM-A205U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.158 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 16; SM-A102U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.158 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 16; SM-G960U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.158 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 16; SM-N960U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.158 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 16; LM-Q720) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.158 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 16; LM-X420) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.158 Mobile Safari/537.36",
  ]),
  ANDROID_APP: client("https://www.twitch.tv", "kd1unb4b3q4t58fwlpcbzcbnm76a8fp", [
    "Dalvik/2.1.0 (Linux; U; Android 16; SM-S911B Build/TP1A.220624.014) tv.twitch.android.app/25.3.0/2503006",
    "Dalvik/2.1.0 (Linux; U; Android 16; SM-S938B Build/BP2A.250605.031) tv.twitch.android.app/25.3.0/2503006",
    "Dalvik/2.1.0 (Linux; Android 16; SM-X716N Build/UP1A.231005.007) tv.twitch.android.app/25.3.0/2503006",
    "Dalvik/2.1.0 (Linux; U; Android 15; SM-G990B Build/AP3A.240905.015.A2) tv.twitch.android.app/25.3.0/2503006",
    "Dalvik/2.1.0 (Linux; U; Android 15; SM-G970F Build/AP3A.241105.008) tv.twitch.android.app/25.3.0/2503006",
    "Dalvik/2.1.0 (Linux; U; Android 15; SM-A566E Build/AP3A.240905.015.A2) tv.twitch.android.app/25.3.0/2503006",
    "Dalvik/2.1.0 (Linux; U; Android 14; SM-X306B Build/UP1A.231005.007) tv.twitch.android.app/25.3.0/2503006",
  ]),
  SMARTBOX: client(
    "https://android.tv.twitch.tv",
    "ue6666qo983tsx6so1t0vnawi233wa",
    `Mozilla/5.0 (Linux; Android 7.1; Smart Box C1) AppleWebKit/537.36 (KHTML, like Gecko) ${CHROME_138}`,
  ),
};

export const LIMITS = {
  maxExtraMinutes: 15,
  baseTopics: 2,
  maxWebsockets: 8,
  wsTopicsLimit: 50,
  topicsPerChannel: 2,
  maxTopics: 8 * 50 - 2,
  maxChannels: Math.floor((8 * 50 - 2) / 2),
} as const;

export const INTERVALS = {
  ping: 3 * 60 * 1000,
  pingTimeout: 10 * 1000,
  onlineDelay: 120 * 1000,
  watch: 59 * 1000,
} as const;
