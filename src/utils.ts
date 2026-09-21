/**
 * Port of the pure helpers in `utils.py` needed by the engine models:
 * `Game`, `timestamp`, `isonow` and `json_minify`.
 *
 * (`RateLimiter`/`AwaitableValue`/`task_wrapper` are async-engine pieces
 * and move over with the engine. JSON persistence lives in `jsonStore.ts`.)
 */

import { MinerException } from "./errors.ts";

export const SPECIAL_GAME_IDS: ReadonlySet<number> = new Set([509663, 509672]);

export interface GameData {
  id: number | string;
  displayName?: string;
  name?: string;
  slug?: string;
}

export class Game {
  readonly id: number;
  readonly name: string;
  private memoSlug?: string;

  constructor(data: GameData) {
    this.id = Number(data["id"]);
    this.name = data.displayName ?? data.name ?? "";
    if (data.slug !== undefined) this.memoSlug = data.slug;
  }

  toString(): string {
    return this.name;
  }

  equals(other: unknown): boolean {
    return other instanceof Game && other.id === this.id;
  }

  get slug(): string {
    if (this.memoSlug === undefined) {
      // Mirrors the cached slug property: strip quotes, slugify, collapse.
      // /u flag for parity with Python's unicode-aware \W.
      let text = this.name.toLowerCase().replace(/'/g, "");
      // JS \w is ASCII-only even with /u; \p{L}\p{N} mirrors Python's
      // unicode-aware \W.
      text = text.replace(/[^\p{L}\p{N}_]+/gu, "-");
      text = text.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
      this.memoSlug = text;
    }
    return this.memoSlug;
  }

  isSpecial(): boolean {
    return SPECIAL_GAME_IDS.has(this.id);
  }
}

/** Parse Twitch `...Z` timestamps (port of `utils.timestamp`). */
export function timestamp(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
    throw new MinerException(`Invalid timestamp: ${value}`);
  }
  return new Date(value);
}

/** Current UTC time like Python's `isonow()` (millis + `Z` suffix). */
export function isonow(): string {
  return new Date().toISOString();
}

/** Minified JSON for payload usage (port of `json_minify`). */
export function jsonMinify(data: unknown): string {
  return JSON.stringify(data);
}
