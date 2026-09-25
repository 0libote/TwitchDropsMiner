import {defineTheme} from "@astryxdesign/core/theme";
import {motion, radius, typography} from "./shared";

/** Charcoal surfaces with a brass accent. The default dark appearance. */
export const graphiteTheme = defineTheme({
  name: "graphite",
  color: {accent: "#E3A968", neutralStyle: "cool", contrast: "standard"},
  typography,
  motion,
  radius,
  tokens: {
    "--color-background-body": "#121316",
    "--color-background-surface": "#191b1f",
    "--color-background-card": "#1d1f24",
    "--color-background-popover": "#24262c",
    "--color-background-muted": "#24262d",
    "--color-border": "#ffffff14",
    "--color-accent-muted": "#e3a96824",
  },
});
