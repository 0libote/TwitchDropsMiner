/**
 * Minimal cookie jar for the Twitch session (device `unique_id`,
 * `auth-token`, `persistent`). Bun's `fetch` has no cookie jar, so the
 * engine manages `Cookie`/`Set-Cookie` headers itself.
 *
 * Stored as plain JSON (`cookies.json`, mode 0600). This intentionally does
 * NOT read Python's pickle `cookies.jar`: upgrading runtimes re-logs in
 * once via the normal device flow.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expiresAt: number | null;
  secure: boolean;
  httpOnly: boolean;
}

function parseSetCookie(header: string, fallbackHost: string): StoredCookie | null {
  const parts = header.split(";");
  const first = parts.shift();
  if (!first) return null;
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const cookie: StoredCookie = {
    name: first.slice(0, eq).trim(),
    value: first.slice(eq + 1).trim(),
    domain: fallbackHost.toLowerCase(),
    path: "/",
    expiresAt: null,
    secure: false,
    httpOnly: false,
  };
  for (const part of parts) {
    const eqIndex = part.indexOf("=");
    const rawKey = eqIndex < 0 ? part : part.slice(0, eqIndex);
    const value = eqIndex < 0 ? "" : part.slice(eqIndex + 1).trim();
    const key = rawKey.trim().toLowerCase();
    if (key === "domain" && value) {
      cookie.domain = value.toLowerCase().replace(/^\./, "");
    } else if (key === "path" && value.startsWith("/")) {
      cookie.path = value;
    } else if (key === "max-age" && /^-?\d+$/.test(value)) {
      cookie.expiresAt = Date.now() + Number(value) * 1000;
    } else if (key === "expires") {
      const time = Date.parse(value);
      if (!Number.isNaN(time)) cookie.expiresAt = time;
    } else if (key === "secure") {
      cookie.secure = true;
    } else if (key === "httponly") {
      cookie.httpOnly = true;
    }
  }
  if (!cookie.name) return null;
  return cookie;
}

export class CookieJar {
  private cookies: StoredCookie[] = [];

  static loadFile(path: string): CookieJar {
    const jar = new CookieJar();
    if (!existsSync(path)) return jar;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) {
        jar.cookies = (parsed as StoredCookie[]).filter(
          (c) => typeof c?.name === "string" && typeof c?.value === "string" && typeof c?.domain === "string",
        );
      }
    } catch {
      // Corrupt jar: start empty like the Python loader's except-branch.
    }
    jar.prune();
    return jar;
  }

  saveFile(path: string): void {
    this.prune();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.cookies), "utf8");
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort (non-POSIX filesystems).
    }
  }

  private prune(): void {
    const now = Date.now();
    this.cookies = this.cookies.filter((c) => c.expiresAt === null || c.expiresAt > now);
  }

  private domainMatches(cookieDomain: string, host: string): boolean {
    return host === cookieDomain || host.endsWith(`.${cookieDomain}`);
  }

  /** `Cookie` header value for `url`, or `null` when the jar is empty. */
  headerFor(url: string): string | null {
    this.prune();
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const secure = parsed.protocol === "https:";
    const pairs = this.cookies
      .filter((c) => this.domainMatches(c.domain, host) && parsed.pathname.startsWith(c.path) && (!c.secure || secure))
      .map((c) => `${c.name}=${c.value}`);
    return pairs.length > 0 ? pairs.join("; ") : null;
  }

  /** Fold `Set-Cookie` response headers into the jar. */
  storeFromHeaders(url: string, headers: Headers): void {
    const host = new URL(url).hostname.toLowerCase();
    const raw = headers.getSetCookie?.() ?? [];
    for (const header of raw) {
      const parsed = parseSetCookie(header, host);
      if (!parsed) continue;
      this.cookies = this.cookies.filter(
        (c) => !(c.name === parsed.name && c.domain === parsed.domain && c.path === parsed.path),
      );
      if (parsed.expiresAt !== null && parsed.expiresAt <= Date.now()) continue;
      this.cookies.push(parsed);
    }
  }

  /** Named cookie visible for `host` (e.g. `unique_id`, `auth-token`). */
  get(name: string, host: string): StoredCookie | undefined {
    this.prune();
    const lower = host.toLowerCase();
    return this.cookies.find((c) => c.name === name && this.domainMatches(c.domain, lower));
  }

  has(name: string, host: string): boolean {
    return this.get(name, host) !== undefined;
  }

  set(name: string, value: string, host: string, path = "/"): void {
    this.cookies = this.cookies.filter(
      (c) => !(c.name === name && c.domain === host.toLowerCase() && c.path === path),
    );
    this.cookies.push({ name, value, domain: host.toLowerCase(), path, expiresAt: null, secure: false, httpOnly: false });
  }

  clearDomain(host: string): void {
    const lower = host.toLowerCase();
    this.cookies = this.cookies.filter((c) => !this.domainMatches(c.domain, lower));
  }

  clear(): void {
    this.cookies = [];
  }

  get size(): number {
    this.prune();
    return this.cookies.length;
  }
}
