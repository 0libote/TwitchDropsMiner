/**
 * Shared Astryx theme configuration for Twitch Drops Miner Next.
 *
 * Every appearance is one Astryx theme: same type scale, motion and radius,
 * different colour seed. The CLI compiles each file to CSS with
 * `bunx astryx theme build` (see `bun run theme:build`).
 *
 * Local system fonts only — the dashboard has no font CDN dependency.
 */

export const typography = {
  scale: {base: 14, ratio: 1.2},
  body: {
    family: "system-ui",
    fallbacks: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  heading: {weight: "semibold" as const},
  code: {
    family: "ui-monospace",
    fallbacks: 'Menlo, Consolas, "Liberation Mono", monospace',
  },
} as const;

/** Snappy, not cinematic: this is a dashboard people leave open all day. */
export const motion = {fast: 150, medium: 300, ratio: 0.8} as const;

export const radius = {base: 4, multiplier: 1} as const;
