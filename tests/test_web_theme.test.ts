/**
 * Bun-native theme checks (`bun test`).
 *
 * Covers the same behavior as `tests/test_web_theme.cjs` (kept for
 * `node --test` compatibility and the `bun run test:theme` alias) but uses
 * `bun:test` idioms: `describe`/`test`/`expect`, parallel-safe, with type
 * checking via `tsc --noEmit`.
 *
 * Run: `bun test` or `bun test tests/test_web_theme.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "web", "theme.js"), "utf8");

interface ThemeHarness {
  root: { dataset: Record<string, string> };
  meta: { content?: string };
  media: { matches: boolean; changed?: () => void };
}

function load(saved: string | null, dark: boolean, blocked = false): ThemeHarness {
  const root = { dataset: {} as Record<string, string> };
  const meta: { content?: string } = {};
  const media: { matches: boolean; changed?: () => void } = {
    matches: dark,
    changed: undefined,
  };
  const context = vm.createContext({
    document: { documentElement: root, querySelector: () => meta },
    localStorage: {
      getItem(): string | null {
        if (blocked) throw new Error("Storage blocked");
        return saved;
      },
    },
    matchMedia: () => ({
      get matches() {
        return media.matches;
      },
      set matches(value: boolean) {
        media.matches = value;
      },
      addEventListener(_: string, callback: () => void) {
        media.changed = callback;
      },
    }),
  });
  // Runs the project's own theme.js in a test sandbox.
  vm.runInContext(source, context);
  return { root, meta, media };
}

describe("dashboard theme", () => {
  test("explicit themes ignore OS changes", () => {
    for (const theme of ["graphite", "paper", "midnight", "evergreen"] as const) {
      const { root, media } = load(theme, false);
      expect(root.dataset["theme"]).toBe(theme);
      media.matches = true;
      media.changed?.();
      expect(root.dataset["theme"]).toBe(theme);
    }
  });

  test("system theme follows the OS and updates live", () => {
    for (const saved of [null, "invalid", "system"] as const) {
      const { root, media, meta } = load(saved, false);
      expect(root.dataset["theme"]).toBe("paper");
      media.matches = true;
      media.changed?.();
      expect(root.dataset["theme"]).toBe("graphite");
      expect(meta.content).toBe("#17181b");
    }
  });

  test("blocked storage falls back instead of throwing", () => {
    expect(load(null, true, true).root.dataset["theme"]).toBe("graphite");
  });
});
