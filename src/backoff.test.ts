/**
 * Tests for `src/backoff.ts`, mirroring `utils.ExponentialBackoff`.
 */
import { describe, expect, test } from "bun:test";
import { ExponentialBackoff } from "./backoff.ts";

describe("ExponentialBackoff", () => {
  test("doubles deterministically without variance", () => {
    const backoff = new ExponentialBackoff({ variance: 0 });
    expect([backoff.delay(), backoff.delay(), backoff.delay(), backoff.delay()]).toEqual([1, 2, 4, 8]);
  });

  test("a capped value does not advance the step counter", () => {
    const backoff = new ExponentialBackoff({ base: 2, variance: 0, maximum: 3 });
    expect(backoff.delay()).toBe(1);
    expect(backoff.delay()).toBe(2);
    // 4 would exceed the cap: stays at 3 without consuming a step.
    expect(backoff.delay()).toBe(3);
    expect(backoff.delay()).toBe(3);
    expect(backoff.exp).toBe(1);
  });

  test("shift offsets every delay", () => {
    const backoff = new ExponentialBackoff({ variance: 0, shift: 10 });
    expect(backoff.delay()).toBe(11);
    expect(backoff.delay()).toBe(12);
  });

  test("tuple variance stays within bounds", () => {
    const backoff = new ExponentialBackoff({ variance: [0.5, 0.5] });
    expect(backoff.delay()).toBe(0.5);
    expect(backoff.delay()).toBe(1);
  });

  test("reset restarts the sequence and rejects bad bases", () => {
    const backoff = new ExponentialBackoff({ variance: 0 });
    backoff.delay();
    backoff.delay();
    backoff.reset();
    expect(backoff.delay()).toBe(1);
    expect(backoff.exp).toBe(0);
    expect(() => new ExponentialBackoff({ base: 1 })).toThrow();
  });
});
