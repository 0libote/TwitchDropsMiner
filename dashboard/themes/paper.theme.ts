import {defineTheme} from "@astryxdesign/core/theme";
import {motion, radius, typography} from "./shared";

/** Warm paper: cream ground, white cards, terracotta accent. */
export const paperTheme = defineTheme({
  name: "paper",
  color: {accent: "#B4552D", neutralStyle: "warm", contrast: "standard"},
  typography,
  motion,
  radius,
  tokens: {
    "--color-background-body": "#f5f3ee",
    "--color-background-surface": "#fbfaf6",
    "--color-background-card": "#fffefa",
    "--color-background-popover": "#ffffff",
    "--color-background-muted": "#efece5",
    "--color-border": "#1a15120f",
    "--color-accent-muted": "#b4552d1f",
  },
});
