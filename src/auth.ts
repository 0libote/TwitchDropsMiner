/**
 * Port of `twitch.py::_AuthState` (device OAuth, password login, session
 * validation) plus the cookie-file helpers.
 *
 * Cookies live in `cookies.json` (see `cookies.ts`), NOT Python's pickle
 * `cookies.jar`: upgrading runtimes re-logs in once through the device flow.
 * Callers drive the UI through `AuthGui`; all `_()` strings come from
 * `i18n.ts`.
 */

import { CHARS_HEX_LOWER, createNonce } from "./async.ts";
import { CookieJar } from "./cookies.ts";
import { CaptchaRequired, LoginException, MinerException, RequestInvalid } from "./errors.ts";
import type { HttpResponse } from "./http.ts";
import { format, translate } from "./i18n.ts";
import type { ClientInfo } from "./twitchProtocol.ts";

export interface AuthGuiLogin {
  askEnterCode(pageUrl: string, userCode: string): Promise<void>;
  askLogin(): Promise<{ username: string; password: string; token: string }>;
  clear(options?: { login?: boolean; password?: boolean; token?: boolean }): void;
  update(status: string, userId: number | null): void;
}

export interface AuthGui {
  login: AuthGuiLogin;
  helpButton(state: "normal" | "disabled"): void;
}

export interface AuthTwitch {
  gui: AuthGui;
  cookies: CookieJar;
  cookiesPath: string;
  clientInfo: ClientInfo & { userAgent: string };
  print(message: string): void;
  request(method: string, url: string, options?: Record<string, unknown>): Promise<HttpResponse>;
}

export class AuthState {
  userId?: number;
  deviceId?: string;
  sessionId?: string;
  accessToken?: string;
  clientVersion?: string;
  private readonly loggedIn: { set: boolean; waiters: Array<() => void> };
  private validating: Promise<void> | null = null;

  constructor(private readonly twitch: AuthTwitch) {
    const waiters: Array<() => void> = [];
    this.loggedIn = {
      set: false,
      waiters,
    };
  }

  waitUntilLogin(): Promise<true> {
    if (this.loggedIn.set) return Promise.resolve(true);
    return new Promise<true>((resolve) => {
      this.loggedIn.waiters.push(() => resolve(true));
    });
  }

  private setLoggedIn(): void {
    this.loggedIn.set = true;
    const waiters = this.loggedIn.waiters.splice(0);
    for (const wake of waiters) wake();
  }

  private clearLoggedIn(): void {
    this.loggedIn.set = false;
  }

  private hasAttrs(...attrs: Array<"deviceId" | "accessToken" | "userId" | "sessionId">): boolean {
    return attrs.every((attr) => this[attr] !== undefined);
  }

  private delAttrs(...attrs: Array<"userId" | "deviceId" | "sessionId" | "accessToken" | "clientVersion">): void {
    for (const attr of attrs) delete this[attr];
  }

  invalidate(deleteCookies: boolean): void {
    this.delAttrs("accessToken", "userId");
    this.clearLoggedIn();
    this.twitch.gui.helpButton("disabled");
    if (deleteCookies) {
      this.twitch.cookies.clear();
      this.twitch.cookies.saveFile(this.twitch.cookiesPath);
    }
  }

  clear(): void {
    this.delAttrs("userId", "deviceId", "sessionId", "accessToken", "clientVersion");
    this.clearLoggedIn();
    this.twitch.gui.helpButton("disabled");
  }

  private async responseJson(response: HttpResponse): Promise<Record<string, unknown>> {
    // Twitch error bodies are not always JSON: normalize so callers fail
    // with a useful message instead of a parse/lookup crash.
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new LoginException(`Twitch returned an unreadable response during login (HTTP ${response.status})`);
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new LoginException(`Twitch returned an unexpected response during login (HTTP ${response.status})`);
    }
    return data as Record<string, unknown>;
  }

  async oauthLogin(): Promise<string> {
    const loginForm = this.twitch.gui.login;
    const client = this.twitch.clientInfo;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "Accept-Language": "en-US",
      "Cache-Control": "no-cache",
      "Client-Id": client.clientId,
      Host: "id.twitch.tv",
      Origin: client.clientUrl,
      Pragma: "no-cache",
      Referer: client.clientUrl,
      "User-Agent": client.userAgent,
      ...(this.deviceId ? { "X-Device-Id": this.deviceId } : {}),
    };
    let payload: Record<string, string> = { client_id: client.clientId, scopes: "" };
    for (;;) {
      const now = Date.now();
      const device = await this.twitch.request("POST", "https://id.twitch.tv/oauth2/device", { headers, data: payload });
      const deviceJson = await this.responseJson(device);
      if (device.status !== 200) {
        const reason = String(deviceJson["message"] ?? "unknown error");
        throw new LoginException(
          "Twitch rejected the device authorization request " +
            `(HTTP ${device.status}: ${reason}). A new login cannot be started with ` +
            "this client right now; an existing saved session is required.",
        );
      }
      let deviceCode: string;
      let userCode: string;
      let interval: number;
      let verificationUri: string;
      let expiresAt: Date;
      try {
        deviceCode = deviceJson["device_code"] as string;
        userCode = deviceJson["user_code"] as string;
        interval = Number(deviceJson["interval"] ?? 5);
        verificationUri = deviceJson["verification_uri"] as string;
        expiresAt = new Date(now + Number(deviceJson["expires_in"]) * 1000);
        if (!deviceCode || !userCode || !verificationUri || !Number.isFinite(interval) || Number.isNaN(expiresAt.getTime())) {
          throw new Error("incomplete");
        }
      } catch {
        throw new LoginException("Twitch returned an incomplete device authorization response");
      }
      await loginForm.askEnterCode(verificationUri, userCode);
      payload = { client_id: client.clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" };
      for (;;) {
        // Sleep first: nobody enters the code *that* fast.
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        let response: HttpResponse;
        try {
          response = await this.twitch.request("POST", "https://id.twitch.tv/oauth2/token", {
            headers,
            data: payload,
            invalidateAfter: expiresAt,
          });
        } catch (error) {
          // The device code expired mid-poll: outer loop requests a new one.
          if (error instanceof RequestInvalid) continue;
          throw error;
        }
        const tokenJson = await this.responseJson(response);
        if (response.status === 200) {
          const accessToken = tokenJson["access_token"];
          if (!accessToken) throw new LoginException("Twitch login response did not include an access token");
          this.accessToken = String(accessToken);
          return this.accessToken;
        }
        // Twitch reports the pending/terminal state in the message field.
        const error = String(tokenJson["message"] ?? "");
        if (error === "" || error === "authorization_pending") continue;
        if (error === "slow_down") {
          interval = Math.min(interval + 5, 30);
          continue;
        }
        if (error === "expired_token") break; // request a fresh device code
        if (error === "access_denied") throw new LoginException("Twitch device authorization was denied");
        throw new LoginException(`Twitch device authorization failed: ${error}`);
      }
    }
  }

  async passwordLogin(): Promise<string> {
    const loginForm = this.twitch.gui.login;
    const print = (message: string): void => this.twitch.print(message);
    const client = this.twitch.clientInfo;
    let tokenKind = "";
    let useChrome = false;
    const payload: Record<string, unknown> = {
      client_id: client.clientId,
      undelete_user: false,
      remember_me: true,
    };
    for (;;) {
      const loginData = await loginForm.askLogin();
      payload["username"] = loginData.username;
      payload["password"] = loginData.password;
      delete payload["authy_token"];
      delete payload["twitchguard_code"];
      if (loginData.token) {
        if (!tokenKind) tokenKind = "authy";
        if (tokenKind === "authy") payload["authy_token"] = loginData.token;
        else payload["twitchguard_code"] = loginData.token;
      }
      const headers: Record<string, string> = {
        Accept: "application/vnd.twitchtv.v3+json",
        "Accept-Encoding": "gzip",
        "Accept-Language": "en-US",
        "Client-Id": client.clientId,
        "Content-Type": "application/json; charset=UTF-8",
        Host: "passport.twitch.tv",
        "User-Agent": client.userAgent,
        ...(this.deviceId ? { "X-Device-Id": this.deviceId } : {}),
      };
      const response = await this.twitch.request("POST", "https://passport.twitch.tv/login", { headers, json: payload });
      const loginResponse = (await response.json()) as Record<string, unknown>;
      if ("captcha_proof" in loginResponse) {
        payload["captcha"] = { proof: loginResponse["captcha_proof"] };
      }
      if ("error_code" in loginResponse) {
        const errorCode = loginResponse["error_code"] as number;
        if (errorCode === 1000) {
          useChrome = true;
          break; // CAPTCHA required -> chrome flow (unsupported)
        }
        if (errorCode === 2004 || errorCode === 3001) {
          print(translate("login", "incorrect_login_pass"));
          if (errorCode === 2004) loginForm.clear({ login: true });
          loginForm.clear({ password: true });
          continue;
        }
        if (errorCode === 3012 || errorCode === 3023) {
          if (errorCode === 3023) {
            tokenKind = "email";
            print(translate("login", "incorrect_email_code"));
          } else {
            tokenKind = "authy";
            print(translate("login", "incorrect_twofa_code"));
          }
          loginForm.clear({ token: true });
          continue;
        }
        if (errorCode === 3011 || errorCode === 3022) {
          if (errorCode === 3022) {
            tokenKind = "email";
            print(translate("login", "email_code_required"));
          } else {
            tokenKind = "authy";
            print(translate("login", "twofa_code_required"));
          }
          continue;
        }
        if (errorCode >= 5000) {
          print(format(translate("login", "error_code"), { error_code: errorCode }));
          useChrome = true;
          break;
        }
        throw new LoginException(String(loginResponse));
      }
      if ("access_token" in loginResponse) {
        this.accessToken = String(loginResponse["access_token"]);
        loginForm.clear();
        break;
      }
    }
    if (useChrome) {
      // Chrome-assisted login was removed upstream of this port.
      throw new CaptchaRequired();
    }
    if (this.accessToken !== undefined) return this.accessToken;
    throw new LoginException("Login flow finished without setting the access token");
  }

  headers(options?: { userAgent?: string; gql?: boolean }): Record<string, string> {
    const client = this.twitch.clientInfo;
    const headers: Record<string, string> = {
      Accept: "*/*",
      "Accept-Encoding": "gzip",
      "Accept-Language": "en-US",
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
      "Client-Id": client.clientId,
    };
    if (options?.userAgent) headers["User-Agent"] = options.userAgent;
    if (this.sessionId !== undefined) headers["Client-Session-Id"] = this.sessionId;
    if (this.deviceId !== undefined) headers["X-Device-Id"] = this.deviceId;
    if (options?.gql) {
      headers["Origin"] = client.clientUrl;
      headers["Referer"] = client.clientUrl;
      headers["Authorization"] = `OAuth ${this.accessToken}`;
    }
    return headers;
  }

  /** Serialized validate() (mirrors the asyncio.Lock). */
  validate(): Promise<void> {
    if (!this.validating) {
      this.validating = this.validateInner().finally(() => {
        this.validating = null;
      });
    }
    return this.validating;
  }

  private async validateInner(): Promise<void> {
    if (this.sessionId === undefined) {
      this.sessionId = createNonce(CHARS_HEX_LOWER, 16);
    }
    const client = this.twitch.clientInfo;
    const host = new URL(client.clientUrl).hostname;
    if (this.deviceId === undefined) {
      const page = await this.twitch.request("GET", client.clientUrl, { headers: this.headers() });
      await page.text();
      const unique = this.twitch.cookies.get("unique_id", host);
      if (!unique) throw new MinerException("Unable to extract the device id");
      this.deviceId = unique.value;
    }
    if (this.accessToken === undefined || this.userId === undefined) {
      const loginForm = this.twitch.gui.login;
      const cookies = this.twitch.cookies;
      loginForm.update(translate("gui", "login", "logging_in"), null);
      let verified: Record<string, unknown> | null = null;
      for (let clientAttempt = 0; clientAttempt < 2; clientAttempt++) {
        let innerBroke = false;
        for (let tokenAttempt = 0; tokenAttempt < 2; tokenAttempt++) {
          if (!cookies.has("auth-token", host)) {
            this.accessToken = await this.oauthLogin();
            cookies.set("auth-token", this.accessToken, host);
          } else if (this.accessToken === undefined) {
            this.accessToken = cookies.get("auth-token", host)?.value;
          }
          const validation = await this.twitch.request("GET", "https://id.twitch.tv/oauth2/validate", {
            headers: { Authorization: `OAuth ${this.accessToken}` },
          });
          if (validation.status === 401) {
            // Token invalid: drop it and retry; two failures escalate below.
            cookies.clearDomain(host);
            cookies.saveFile(this.twitch.cookiesPath);
            delete this.accessToken;
            continue;
          }
          if (validation.status === 200) {
            verified = (await validation.json()) as Record<string, unknown>;
            innerBroke = true;
            break;
          }
          // Other statuses fall through to the next attempt.
        }
        if (!innerBroke) throw new Error("Login verification failure (step #2)");
        if (verified!["client_id"] === client.clientId) break;
        // Cookie client ID mismatch: wipe the jar and start over.
        cookies.clear();
        cookies.saveFile(this.twitch.cookiesPath);
        verified = null;
      }
      if (verified === null) throw new Error("Login verification failure (step #1)");
      this.userId = Number(verified["user_id"]);
      cookies.set("persistent", String(this.userId), host);
      cookies.saveFile(this.twitch.cookiesPath);
    }
    this.twitch.gui.login.update(translate("gui", "login", "logged_in"), this.userId ?? null);
    this.twitch.gui.helpButton("normal");
    this.setLoggedIn();
  }
}
