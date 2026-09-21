/**
 * Engine/user-facing message strings.Subset of `translate.py`'s
 * `default_translation` covering every `_(...)` call reachable from the
 * ported engine and models (`{name}` placeholders filled by `format`).
 * Full locale switching moves over if the dashboard ever needs it.
 */

const STRINGS: Record<string, Record<string, string>> = {
  status: {
    terminated: "\nApplication Terminated.\nClose the window to exit the application.",
    watching: "Watching: {channel}",
    goes_online: "{channel} goes ONLINE, switching...",
    goes_offline: "{channel} goes OFFLINE, switching...",
    claimed_drop: "Claimed drop: {drop}",
    no_channel: "No available channels to watch. Waiting for an ONLINE channel...",
    no_campaign: "No active campaigns to mine drops for. Waiting for an active campaign...",
  },
  login: {
    unexpected_content:
      "Unexpected content type returned, usually due to being redirected. " +
      "Do you need to login for internet access?",
    error_code: "Login error code: {error_code}",
    incorrect_login_pass: "Incorrect username or password.",
    incorrect_email_code: "Incorrect email code.",
    incorrect_twofa_code: "Incorrect 2FA code.",
    email_code_required: "Email code required. Check your email.",
    twofa_code_required: "2FA token required.",
  },
  error: {
    captcha: "Your login attempt was denied by CAPTCHA.\nPlease try again in 12+ hours.",
    site_down: "Twitch is down, retrying in {seconds} seconds...",
    no_connection: "Cannot connect to Twitch, retrying in {seconds} seconds... ({url})",
  },
  "gui.status": {
    idle: "Idle",
    exiting: "Exiting...",
    terminated: "Terminated",
    cleanup: "Cleaning up channels...",
    gathering: "Gathering channels...",
    switching: "Switching the channel...",
    fetching_inventory: "Fetching inventory...",
    fetching_campaigns: "Fetching campaigns...",
    adding_campaigns: "Adding campaigns to inventory... {counter}",
  },
  "gui.tray": {
    notification_title: "Mined Drop",
  },
  "gui.login": {
    logging_in: "Logging in...",
    logged_in: "Logged in",
  },
  "gui.websocket": {
    initializing: "Initializing...",
    connected: "Connected",
    disconnected: "Disconnected",
    connecting: "Connecting...",
    disconnecting: "Disconnecting...",
    reconnecting: "Reconnecting...",
  },
};

export function translate(section: string, key: string, subkey?: string): string {
  if (subkey !== undefined) {
    const group = STRINGS[`${section}.${key}`] as Record<string, string> | undefined;
    const hit = group?.[subkey];
    if (typeof hit === "string") return hit;
  } else {
    const hit = STRINGS[section]?.[key];
    if (typeof hit === "string") return hit;
  }
  throw new Error(`Missing translation: ${section}.${key}${subkey ? `.${subkey}` : ""}`);
}

/** Fill `{name}` placeholders (port of `str.format(name=...)`). */
export function format(template: string, vars: Record<string, unknown>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(String(value));
  }
  return out;
}

/** `translate` + `format` in one call, matching the common call shape. */
export function t(section: string, key: string, subkeyOrVars?: string | Record<string, unknown>, vars: Record<string, unknown> = {}): string {
  if (typeof subkeyOrVars === "string") return format(translate(section, key, subkeyOrVars), vars);
  return format(translate(section, key), (subkeyOrVars as Record<string, unknown> | undefined) ?? vars);
}
