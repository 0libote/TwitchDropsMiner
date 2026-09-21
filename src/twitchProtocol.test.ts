/**
 * Tests for `src/twitchProtocol.ts`. Wire values (hashes, topics, client
 * IDs, agents) are verified against `constants.py` by construction — see
 * `docs/bun-port.md`. These tests pin behavior: merge rules, topic
 * formatting, limits and client table shape.
 */
import { describe, expect, test } from "bun:test";
import { CLIENT_TYPES, EngineState, GQL_QUERIES, INTERVALS, LIMITS, PriorityMode, UNSET, topicString } from "./twitchProtocol.ts";

describe("GqlQuery", () => {
  test("known wire hashes are pinned", () => {
    expect(GQL_QUERIES["ClaimDrop"]!.sha256Hash).toBe("a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930");
    expect(GQL_QUERIES["ClaimDrop"]!.operationName).toBe("DropsPage_ClaimDropRewards");
    expect(Object.keys(GQL_QUERIES)).toHaveLength(15);
  });

  test("withVariables deep-merges without touching the template", () => {
    const merged = GQL_QUERIES["GameDirectory"]!.withVariables({ slug: "just-chatting", options: { sort: "VIEWER_COUNT" } });
    const vars = merged.variables as { slug: unknown; limit: unknown; options: { sort: unknown; tags: unknown } };
    expect(vars.slug).toBe("just-chatting");
    expect(vars.limit).toBe(30);
    expect(vars.options.sort).toBe("VIEWER_COUNT");
    expect(vars.options.tags).toEqual([]);
    // Template keeps its placeholders.
    expect(GQL_QUERIES["GameDirectory"]!.variables["slug"]).toBe(UNSET as unknown);
    expect((GQL_QUERIES["GameDirectory"]!.variables["options"] as { sort: unknown }).sort).toBe("RELEVANCE");
  });

  test("withVariables rejects dict/non-dict mismatches like _merge_vars", () => {
    expect(() => GQL_QUERIES["ClaimDrop"]!.withVariables({ input: "nope" })).toThrow(/dict, var is not/);
    expect(() => GQL_QUERIES["PlaybackAccessToken"]!.withVariables({ login: { nested: true } })).toThrow(/dict, var is not|dict, base is not/);
  });

  test("checked() rejects leftover placeholders", () => {
    expect(() => GQL_QUERIES["ClaimDrop"]!.checked()).toThrow(/Unspecified variable/);
    expect(() => GQL_QUERIES["ClaimDrop"]!.withVariables({ input: { dropInstanceID: "abc" } }).checked()).not.toThrow();
  });

  test("toJSON carries the persisted-query extension", () => {
    const json = GQL_QUERIES["Inventory"]!.toJSON();
    expect(json.extensions.persistedQuery.version).toBe(1);
    expect(json.variables).toEqual({ fetchRewardCampaigns: false });
  });
});

describe("topics and clients", () => {
  test("topicString matches WebsocketTopic.as_str", () => {
    expect(topicString("User", "Drops", 123)).toBe("user-drop-events.123");
    expect(topicString("Channel", "StreamState", 456)).toBe("video-playback-by-id.456");
    expect(() => topicString("User", "Nope", 1)).toThrow(/Unknown websocket topic/);
  });

  test("client table keeps wire IDs and agent counts", () => {
    expect(CLIENT_TYPES.WEB.clientId).toBe("kimne78kx3ncx6brgo4mv6wki5h1ko");
    expect(CLIENT_TYPES.MOBILE_WEB.userAgents).toHaveLength(7);
    expect(CLIENT_TYPES.ANDROID_APP.userAgents).toHaveLength(7);
    expect(CLIENT_TYPES.SMARTBOX.clientUrl).toBe("https://android.tv.twitch.tv");
  });

  test("limits and intervals mirror constants.py", () => {
    expect(LIMITS.maxWebsockets).toBe(8);
    expect(LIMITS.wsTopicsLimit).toBe(50);
    expect(LIMITS.maxTopics).toBe(398);
    expect(LIMITS.maxChannels).toBe(199);
    expect(INTERVALS.watch).toBe(59_000);
    expect(PriorityMode.ENDING_SOONEST).toBe(1);
    expect(EngineState.CHANNEL_SWITCH as string).toBe("CHANNEL_SWITCH");
  });
});
