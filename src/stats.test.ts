/**
 * Tests for `src/stats.ts`, mirroring `test_headless.py::test_stats_are_persisted`
 * and the `Stats` counter semantics in `stats.py`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stats } from "./stats.ts";

function tempStatsPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tdm-stats-")), "stats.json");
}

describe("Stats", () => {
  test("counters persist across instances like the Python test", () => {
    const path = tempStatsPath();
    const first = new Stats(path);
    first.progress(3);
    first.claim();
    const second = new Stats(path);
    expect(second.snapshot().lifetime["mining_minutes"]).toBe(3);
    expect(second.snapshot().lifetime["drops_claimed"]).toBe(1);
    expect(second.snapshot().lifetime["started_count"]).toBe(2);
  });

  test("progress ignores non-positive minutes", () => {
    const stats = new Stats(tempStatsPath());
    stats.progress(0);
    stats.progress(-5);
    expect(stats.snapshot().lifetime["mining_minutes"]).toBe(0);
    expect(stats.snapshot().session["mining_minutes"]).toBe(0);
  });

  test("heartbeat counts successes and failures with stamps", () => {
    const stats = new Stats(tempStatsPath());
    stats.heartbeat(true);
    stats.heartbeat(false);
    const lifetime = stats.snapshot().lifetime;
    expect(lifetime["watch_heartbeats"]).toBe(2);
    expect(lifetime["watch_failures"]).toBe(1);
    expect(lifetime["last_heartbeat_at"]).not.toBe("");
    expect(lifetime["last_progress_at"]).toBe("");
  });

  test("snapshot shape matches the dashboard contract", () => {
    const stats = new Stats(tempStatsPath());
    const snap = stats.snapshot();
    expect(typeof snap.startedAt).toBe("string");
    expect(snap.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(snap.session["started_count"]).toBe(1);
    expect(snap.lastInventoryAt).toBeNull();
    expect(snap.lastRecoveryAt).toBeNull();
  });
});
