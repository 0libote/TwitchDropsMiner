/**
 * Tests for `src/async.ts`.
 */
import { describe, expect, test } from "bun:test";
import { AsyncEvent, AwaitableValue, CHARS_ASCII, CHARS_HEX_LOWER, chunk, createNonce, formatTraceback, TaskAbort, taskWrapper } from "./async.ts";

describe("AsyncEvent", () => {
  test("wait resolves on set and sticks once set", async () => {
    const event = new AsyncEvent();
    expect(event.isSet()).toBe(false);
    let resolved = false;
    const waiting = event.wait().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    event.set();
    await waiting;
    expect(resolved).toBe(true);
    await event.wait();
    event.clear();
    expect(event.isSet()).toBe(false);
  });
});

describe("AwaitableValue", () => {
  test("blocks until set, then serves the value", async () => {
    const box = new AwaitableValue<number>();
    expect(box.hasValue()).toBe(false);
    expect(box.getWithDefault(7)).toBe(7);
    setTimeout(() => box.set(42), 5);
    expect(await box.get()).toBe(42);
    expect(box.getWithDefault(7)).toBe(42);
    box.clear();
    expect(box.hasValue()).toBe(false);
  });
});

describe("chunk", () => {
  test("splits into fixed-size groups", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 20)).toEqual([]);
  });
});

describe("createNonce", () => {
  test("uses only the given charset at the requested length", () => {
    const nonce = createNonce(CHARS_ASCII, 30);
    expect(nonce).toHaveLength(30);
    expect([...nonce].every((c) => CHARS_ASCII.includes(c))).toBe(true);
    const hex = createNonce(CHARS_HEX_LOWER, 16);
    expect(/^[0-9a-f]{16}$/.test(hex)).toBe(true);
  });
});

describe("taskWrapper", () => {
  test("lets normal completion through", async () => {
    let ran = false;
    await taskWrapper(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("swallows TaskAbort but reports and rethrows the rest", async () => {
    await taskWrapper(async () => {
      throw new TaskAbort();
    });
    const seen: unknown[] = [];
    let critical = false;
    await expect(
      taskWrapper(
        async () => {
          throw new Error("boom");
        },
        { critical: true, onCritical: () => void (critical = true), onError: (e) => void seen.push(e) },
      ),
    ).rejects.toThrow("boom");
    expect(critical).toBe(true);
    expect(seen).toHaveLength(1);
  });

  test("formatTraceback stringifies anything", () => {
    expect(formatTraceback(new Error("x"))).toContain("x");
    expect(formatTraceback("plain")).toBe("plain");
  });
});
