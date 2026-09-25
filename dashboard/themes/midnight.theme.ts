import {defineTheme} from "@astryxdesign/core/theme";
import {motion, radius, typography} from "./shared";

/** Deep navy with a pale blue accent. */
export const midnightTheme = defineTheme({
  name: "midnight",
  color: {accent: "#9CBFF5", neutralStyle: "cool", contrast: "standard"},
  typography,
  motion,
  radius,
  tokens: {
    "--color-background-body": "#0d141f",
    "--color-background-surface": "#141d2b",
    "--color-background-card": "#172131",
    "--color-background-popover": "#1e2a3c",
    "--color-background-muted": "#1f2b3d",
    "--color-border": "#ffffff17",
    "--color-accent-muted": "#9cbff526",
  },
});
