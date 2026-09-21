/**
 * Port of `utils.ExponentialBackoff`: jittered exponential delays for
 * Twitch retries and reconnects. Semantics match Python exactly,
 * including the subtle rule that a capped value does *not* advance the
 * step counter (so repeated calls at the cap stay at the cap instead of
 * growing the exponent).
 *
 * `RateLimiter` / `AwaitableValue` (asyncio primitives) move over with the
 * engine in phase 2.
 */

export interface BackoffOptions {
  base?: number;
  /** Constant jitter factor (`0.1` → ±10%) or explicit `[min, max]` range. */
  variance?: number | [number, number];
  shift?: number;
  maximum?: number;
}

export class ExponentialBackoff implements Iterable<number>, Iterator<number> {
  private steps = 0;
  private readonly base: number;
  private readonly shift: number;
  private readonly maximum: number;
  private readonly varianceMin: number;
  private readonly varianceMax: number;

  constructor(options: BackoffOptions = {}) {
    const { base = 2, variance = 0.1, shift = 0, maximum = 300 } = options;
    if (!(base > 1)) throw new Error("Base has to be greater than 1");
    this.base = base;
    this.shift = shift;
    this.maximum = maximum;
    if (Array.isArray(variance)) {
      [this.varianceMin, this.varianceMax] = variance;
    } else {
      this.varianceMin = 1 - variance;
      this.varianceMax = 1 + variance;
    }
  }

  /** Matches Python's `.exp` (starts at 0, lags `steps` by one). */
  get exp(): number {
    return Math.max(0, this.steps - 1);
  }

  next(): IteratorResult<number> {
    // Randomness here is jitter, not cryptography (same as Python's comment).
    const jitter = Math.random() * (this.varianceMax - this.varianceMin) + this.varianceMin;
    const value = this.base ** this.steps * jitter + this.shift;
    if (value > this.maximum) return { value: this.maximum, done: false };
    this.steps += 1;
    return { value, done: false };
  }

  /** Convenience wrapper so call sites read like the Python iterator. */
  delay(): number {
    return this.next().value;
  }

  [Symbol.iterator](): Iterator<number> {
    return this;
  }

  reset(): void {
    this.steps = 0;
  }
}
