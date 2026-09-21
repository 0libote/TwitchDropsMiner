/**
 * Port of the async helpers in `utils.py`: `AwaitableValue`, `chunk`,
 * `create_nonce` (+ charsets), `task_wrapper` and `format_traceback`.
 *
 * `asyncio.Event` becomes the tiny `AsyncEvent` below; `asyncio.Condition`
 * (`RateLimiter`) moves with the engine in a later phase.
 */

export const CHARS_ASCII = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const CHARS_HEX_LOWER = "0123456789abcdef";
export const CHARS_HEX_UPPER = "0123456789ABCDEF";

/** Promise-based event flag (port of `asyncio.Event`). */
export class AsyncEvent {
  private setFlag = false;
  private waiters: Array<() => void> = [];

  isSet(): boolean {
    return this.setFlag;
  }

  set(): void {
    this.setFlag = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  clear(): void {
    this.setFlag = false;
  }

  async wait(): Promise<true> {
    if (this.setFlag) return true;
    await new Promise<void>((resolve) => {
      this.waiters.push(() => resolve());
    });
    return true;
  }

  /**
   * Cancellable wait: call `cancel()` to drop the waiter (prevents waiter
   * accumulation for listeners that only care about shutdown races).
   */
  waitHandle(): { promise: Promise<true>; cancel(): void } {
    if (this.setFlag) return { promise: Promise.resolve(true), cancel: () => {} };
    let wake!: () => void;
    const promise = new Promise<true>((resolve) => {
      wake = () => resolve(true);
    });
    this.waiters.push(wake);
    return {
      promise,
      cancel: () => {
        const index = this.waiters.indexOf(wake);
        if (index >= 0) this.waiters.splice(index, 1);
      },
    };
  }
}

/** A value that arrives later (port of `AwaitableValue`). */
export class AwaitableValue<T> {
  private value!: T;
  private readonly event = new AsyncEvent();

  hasValue(): boolean {
    return this.event.isSet();
  }

  wait(): Promise<true> {
    return this.event.wait();
  }

  getWithDefault<D>(defaultValue: D): T | D {
    return this.event.isSet() ? this.value : defaultValue;
  }

  async get(): Promise<T> {
    await this.event.wait();
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    this.event.set();
  }

  clear(): void {
    this.event.clear();
  }
}

export function chunk<T>(items: Iterable<T>, length: number): T[][] {
  const list = [...items];
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += length) out.push(list.slice(i, i + length));
  return out;
}

/** Crypto-random nonce (Twitch nonces are auth-adjacent: never Math.random). */
export function createNonce(chars: string, length: number): string {
  const pool = new Uint32Array(length);
  crypto.getRandomValues(pool);
  let out = "";
  for (let i = 0; i < length; i++) out += chars[pool[i]! % chars.length];
  return out;
}

/**
 * Wraps an async task body: swallowed `ExitRequest`-style aborts stay
 * silent, anything else is reported and rethrown. `onCritical` mirrors
 * `task_wrapper(critical=True)` closing the miner on task death.
 */
export async function taskWrapper(
  body: () => Promise<void>,
  options?: { critical?: boolean; onCritical?: () => void; onError?: (error: unknown) => void; name?: string },
): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (error instanceof TaskAbort) return;
    options?.onError?.(error);
    if (options?.critical) options?.onCritical?.();
    throw error;
  }
}

/** Cooperative-abort signal (replaces `ExitRequest`/`ReloadRequest` here). */
export class TaskAbort extends Error {
  constructor(message = "Task aborted") {
    super(message);
    this.name = "TaskAbort";
  }
}

/** `traceback.format_exception` equivalent for error logs. */
export function formatTraceback(error: unknown): string {
  return error instanceof Error ? (error.stack ?? String(error)) : String(error);
}

/** Interruptible sleep (port of the `wait_for(..., timeout=...)` idiom). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the process open: production stays alive via the server,
    // and tests must exit even with hour-long maintenance sleeps pending.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/**
 * Totalling rate limiter (port of `utils.RateLimiter`): at most `capacity`
 * acquisitions per `windowSeconds`; concurrent holders count too.
 */
export class RateLimiter {
  private total = 0;
  private concurrent = 0;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly capacity: number,
    private readonly windowSeconds: number,
  ) {}

  private canProceed(): boolean {
    return Math.max(this.total, this.concurrent) < this.capacity;
  }

  private pump(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private reset(): void {
    this.resetTimer = null;
    this.total = 0;
    this.pump();
  }

  async acquire(): Promise<() => void> {
    while (!this.canProceed()) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    this.total += 1;
    this.concurrent += 1;
    if (this.resetTimer === null) {
      this.resetTimer = setTimeout(() => this.reset(), this.windowSeconds * 1000);
      (this.resetTimer as unknown as { unref?: () => void }).unref?.();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.concurrent -= 1;
      this.pump();
    };
  }

  /** Run `fn` under the limit, mirroring `async with limiter:`. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
