/**
 * History-API routing for the single-page dashboard.
 *
 * Paths mirror the server's SPA routes (`/`, `/campaigns`,
 * `/campaigns/:id`, `/mining`, `/history`, `/settings`, `/diagnostics`).
 * A guard supplied by the app can veto a navigation when the settings form
 * has unsaved changes.
 */

import {useSyncExternalStore} from "react";

export type RouteName =
  | "dashboard"
  | "campaigns"
  | "campaign"
  | "mining"
  | "settings"
  | "history"
  | "diagnostics";

export interface Route {
  name: RouteName;
  id?: string;
}

export const routeMeta: Record<RouteName, [string, string]> = {
  dashboard: ["Your drops, at a glance", "Overview"],
  campaigns: ["Discover rewards and track your collection", "Campaigns"],
  campaign: ["Campaign", "Campaign details"],
  mining: ["Choose what to watch next", "Mining plan"],
  settings: ["Make this miner your own", "Settings"],
  history: ["Saved rewards across your Twitch campaigns", "Reward history"],
  diagnostics: ["Connection health and miner events", "Diagnostics"],
};

export function routeFromPath(path: string = location.pathname): Route {
  const detail = path.match(/^\/campaigns\/([^/]+)$/);
  if (detail) return {name: "campaign", id: decodeURIComponent(detail[1] ?? "")};
  const known: Record<string, RouteName> = {
    "/": "dashboard",
    "/campaigns": "campaigns",
    "/mining": "mining",
    "/settings": "settings",
    "/diagnostics": "diagnostics",
    "/history": "history",
  };
  return {name: known[path] ?? "dashboard"};
}

let currentPath = location.pathname;
const listeners = new Set<() => void>();
let guard: (() => boolean) | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Veto navigation (returns false) while the settings form is dirty. */
export function setNavigationGuard(check: (() => boolean) | null): void {
  guard = check;
}

export interface NavigateOptions {
  replace?: boolean;
  focus?: boolean;
}

export function navigate(path: string, options: NavigateOptions = {}): void {
  if (path === currentPath) return;
  if (guard && !guard()) return;
  if (options.replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  currentPath = path;
  emit();
  scrollTo(0, 0);
  if (options.focus !== false) {
    requestAnimationFrame(() => document.getElementById("view")?.focus({preventScroll: true}));
  }
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => currentPath, () => currentPath);
}

export function useRoute(): Route {
  return routeFromPath(usePath());
}

function handlePopState(): void {
  if (guard && !guard()) {
    history.pushState({}, "", currentPath);
    return;
  }
  currentPath = location.pathname;
  emit();
  scrollTo(0, 0);
}

addEventListener("popstate", handlePopState);
