/**
 * Port of `stats.py`: tiny persistent counters plus per-process state.
 *
 * `STATS_DEFAULTS` and the JSON layout are identical to Python, so a
 * `stats.json` written by either runtime loads in the other. Pass an
 * explicit `dataPath` (tests use a temp dir); production uses
 * `<TDM_DATA_DIR>/stats.json`.
 */

import { jsonLoad, jsonSave } from "./jsonStore.ts";

export const STATS_DEFAULTS: Record<string, number | string> = {
  drops_claimed: 0,
  mining_minutes: 0,
  channel_switches: 0,
  watch_heartbeats: 0,
  watch_failures: 0,
  started_count: 0,
  last_claim_at: "",
  last_progress_at: "",
  last_heartbeat_at: "",
};

export interface StatsSnapshot {
  startedAt: string;
  uptimeSeconds: number;
  session: Record<string, number>;
  lifetime: Record<string, number | string>;
  lastInventoryAt: string | null;
  lastRecoveryAt: string | null;
}

export class Stats {
  readonly lifetime: Record<string, number | string>;
  readonly session: Record<string, number>;
  readonly startedAt: string;
  private readonly startedMonotonic: number;
  lastInventoryAt: string | null = null;
  lastRecoveryAt: string | null = null;

  constructor(private readonly dataPath: string) {
    this.lifetime = jsonLoad(dataPath, { ...STATS_DEFAULTS });
    this.session = {};
    for (const [key, value] of Object.entries(STATS_DEFAULTS)) {
      if (typeof value === "number") this.session[key] = 0;
    }
    this.startedAt = new Date().toISOString();
    this.startedMonotonic = performance.now();
    this.lifetime["started_count"] = Number(this.lifetime["started_count"] ?? 0) + 1;
    this.session["started_count"] = 1;
    this.save();
  }

  increment(name: string, amount = 1, stamp?: string): void {
    this.lifetime[name] = Number(this.lifetime[name] ?? 0) + amount;
    this.session[name] = Number(this.session[name] ?? 0) + amount;
    if (stamp) this.lifetime[stamp] = new Date().toISOString();
    this.save();
  }

  progress(minutes: number): void {
    if (minutes > 0) this.increment("mining_minutes", minutes, "last_progress_at");
  }

  heartbeat(succeeded: boolean): void {
    this.increment("watch_heartbeats", 1, "last_heartbeat_at");
    if (!succeeded) this.increment("watch_failures");
  }

  claim(): void {
    this.increment("drops_claimed", 1, "last_claim_at");
  }

  save(): void {
    jsonSave(this.dataPath, { ...this.lifetime }, true);
  }

  snapshot(): StatsSnapshot {
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor((performance.now() - this.startedMonotonic) / 1000),
      session: { ...this.session },
      lifetime: { ...this.lifetime },
      lastInventoryAt: this.lastInventoryAt,
      lastRecoveryAt: this.lastRecoveryAt,
    };
  }
}
