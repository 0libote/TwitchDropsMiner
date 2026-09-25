/**
 * Display formatting for the dashboard.
 *
 * All user-facing strings flow through these helpers so dates, durations and
 * progress figures stay consistent between routes.
 */

export function percent(progress: number | null | undefined): number {
  return Math.round(Math.min(1, Math.max(0, Number(progress) || 0)) * 100);
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  const hours = Math.floor(minutes / 60);
  const mins = Math.max(0, minutes % 60);
  return hours ? `${hours}h ${mins}m remaining` : `${mins}m remaining`;
}

export function formatDate(value: string | null | undefined, relative = false): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  if (relative) {
    const minutes = Math.round((date.getTime() - Date.now()) / 60000);
    const absolute = Math.abs(minutes);
    if (absolute < 60) return `${absolute}m ${minutes >= 0 ? "from now" : "ago"}`;
    const hours = Math.round(absolute / 60);
    if (hours < 48) return `${hours}h ${minutes >= 0 ? "from now" : "ago"}`;
    const days = Math.round(hours / 24);
    return `${days}d ${minutes >= 0 ? "from now" : "ago"}`;
  }
  return new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(date);
}

export function formatClockTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {hour: "2-digit", minute: "2-digit"}).format(date);
}

export function formatDuration(seconds: number): string {
  const total = Number(seconds) || 0;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return [days && `${days}d`, hours && `${hours}h`, `${minutes}m`].filter(Boolean).join(" ");
}

/** Only allow http(s) links sourced from Twitch/account data. */
export function safeUrl(value: unknown): string {
  try {
    const url = new URL(String(value ?? ""), location.origin);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

export const priorityLabels: Record<string, string> = {
  PRIORITY_ONLY: "Priority games only",
  ENDING_SOONEST: "Ending soonest",
  LOW_AVBL_FIRST: "Lowest availability",
};
