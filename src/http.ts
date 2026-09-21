/**
 * Port of `Twitch.request`: fetch with connection-quality timeouts, proxy
 * support, exponential-backoff retries, 5xx messaging and close-awareness.
 *
 * Deviations from Python:
 * - Bodies are pre-read into memory (like `response.read()`), so the
 *   returned response can be consumed more than once.
 * - No separate connect timeout: Bun has a single total timeout
 *   (`10s × quality`); the invalidation margin uses the same budget.
 * - TLS failures surface as fetch rejections and are retried as connection
 *   problems (Bun does not distinguish them like `ClientConnectorCertificateError`).
 */

import { AsyncEvent, sleep } from "./async.ts";
import { ExponentialBackoff } from "./backoff.ts";
import { ExitRequest, RequestInvalid } from "./errors.ts";
import { format, translate } from "./i18n.ts";

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Form-encoded body (aiohttp `data=dict`). */
  data?: Record<string, string>;
  /** JSON body (aiohttp `json=`). */
  json?: unknown;
  proxy?: string;
  /** Pre-set `Cookie` header (the engine manages its own jar). */
  cookie?: string;
  invalidateAfter?: Date;
  timeoutScale?: number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

class BufferedResponse implements HttpResponse {
  constructor(
    readonly status: number,
    readonly headers: Headers,
    private readonly body: string,
  ) {}

  async text(): Promise<string> {
    return this.body;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.body);
  }
}

export interface HttpCallbacks {
  /** Closed/shutdown latch: requests abort and the loop raises ExitRequest. */
  closeEvent: AsyncEvent;
  connectionQuality(): number;
  reportIssue(url: string): void;
  reportRecovery(url: string): void;
  print(message: string): void;
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export class HttpClient {
  constructor(
    private readonly callbacks: HttpCallbacks,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  private sessionTimeoutMs(): number {
    const quality = Math.min(6, Math.max(1, Math.round(this.callbacks.connectionQuality())));
    return quality * 10 * 1000;
  }

  async request(method: string, url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    const backoff = new ExponentialBackoff({ maximum: 3 * 60 });
    const upper = method.toUpperCase();
    let attempt = 0;
    for (;;) {
      const delay = backoff.delay();
      attempt += 1;
      if (this.callbacks.closeEvent.isSet()) throw new ExitRequest();
      if (options.invalidateAfter && Date.now() >= options.invalidateAfter.getTime() - this.sessionTimeoutMs()) {
        throw new RequestInvalid();
      }
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      let body: string | undefined;
      if (options.json !== undefined) {
        body = JSON.stringify(options.json);
        headers["Content-Type"] ??= "application/json";
      } else if (options.data !== undefined) {
        body = new URLSearchParams(options.data).toString();
      }
      const cookie = (options as { cookie?: string }).cookie;
      if (cookie) headers["Cookie"] = cookie;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutScale ?? this.sessionTimeoutMs());
      const closeHandle = this.callbacks.closeEvent.waitHandle();
      const onAbort = () => controller.abort();
      void closeHandle.promise.then(onAbort);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: upper,
          headers,
          body,
          signal: controller.signal,
          ...(options.proxy ? { proxy: options.proxy } : {}),
        });
      } catch {
        this.callbacks.reportIssue(url);
        // Skip the message for the first quick retry, like Python.
        if (attempt > 1) {
          this.callbacks.print(format(translate("error", "no_connection"), { seconds: Math.round(delay), url }));
        }
        await this.sleepOrClosed(delay * 1000);
        continue;
      } finally {
        clearTimeout(timeout);
        closeHandle.cancel();
      }
      this.callbacks.reportRecovery(url);
      const buffered = new BufferedResponse(response.status, response.headers, await response.text());
      if (buffered.status < 500) return buffered;
      this.callbacks.print(format(translate("error", "site_down"), { seconds: Math.round(delay) }));
      await this.sleepOrClosed(delay * 1000);
    }
  }

  private async sleepOrClosed(ms: number): Promise<void> {
    // Mirror `wait_for(wait_until_closed(), timeout=delay)`: sleeping ends
    // early on shutdown; the loop top then raises ExitRequest.
    const handle = this.callbacks.closeEvent.waitHandle();
    try {
      await Promise.race([sleep(ms), handle.promise]);
    } finally {
      handle.cancel();
    }
  }
}
