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
