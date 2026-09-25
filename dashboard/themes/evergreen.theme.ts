import {defineTheme} from "@astryxdesign/core/theme";
import {motion, radius, typography} from "./shared";

/** Forest green with a sage accent. */
export const evergreenTheme = defineTheme({
  name: "evergreen",
  color: {accent: "#BFD6A3", neutralStyle: "warm", contrast: "standard"},
  typography,
  motion,
  radius,
  tokens: {
    "--color-background-body": "#101a15",
    "--color-background-surface": "#17211c",
    "--color-background-card": "#1a2620",
    "--color-background-popover": "#212f27",
    "--color-background-muted": "#213028",
    "--color-border": "#ffffff15",
    "--color-accent-muted": "#bfd6a324",
  },
});
