/**
 * Appearance bridge.
 *
 * `web/theme.js` owns the first paint: it reads the saved preference and
 * sets `data-theme` / `data-astryx-theme` on <html> before the stylesheet
 * applies, so a chosen palette never flashes. This module exposes the same
 * preference to React and notifies it when the choice or the OS scheme
 * changes.
 */

import {useSyncExternalStore} from "react";

export type Appearance = "graphite" | "paper" | "midnight" | "evergreen";
export type Preference = Appearance | "system";

/* Globals provided by web/theme.js (a classic script loaded first). */
declare const themeNames: Record<string, string>;
declare const themeDescriptions: Record<string, string>;
declare let themePreference: string;
declare function applyTheme(): void;

export const appearanceNames: Record<string, string> = themeNames;
export const appearanceDescriptions: Record<string, string> = themeDescriptions;

const listeners = new Set<() => void>();
const media = matchMedia("(prefers-color-scheme: dark)");

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readPreference(): Preference {
  return (Object.hasOwn(appearanceNames, themePreference) ? themePreference : "system") as Preference;
}

function readResolved(): Appearance {
  const preference = readPreference();
  return preference === "system" ? (media.matches ? "graphite" : "paper") : preference;
}

/** Apply an appearance and remember it for this browser. */
export function chooseAppearance(value: string): boolean {
  if (!Object.hasOwn(appearanceNames, value)) return false;
  themePreference = value;
  applyTheme();
  notify();
  try {
    localStorage.setItem("tdm-theme", value);
    return true;
  } catch {
    return false; // Preference applied, but private/restricted storage rejected it.
  }
}

/** The stored preference (system, graphite, paper, midnight, evergreen). */
export function usePreference(): Preference {
  useSyncExternalStore(subscribe, readPreference, readPreference);
  return readPreference();
}

/** The palette actually painted right now. */
export function useResolvedAppearance(): Appearance {
  useSyncExternalStore(
    (listener) => {
      const unsubscribe = subscribe(listener);
      media.addEventListener("change", listener);
      return () => {
        unsubscribe();
        media.removeEventListener("change", listener);
      };
    },
    readResolved,
    readResolved,
  );
  return readResolved();
}
