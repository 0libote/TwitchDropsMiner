// Load before the stylesheet so a saved theme never flashes the default palette.
const themeNames = {system: "System", graphite: "Graphite", paper: "Paper", midnight: "Midnight", evergreen: "Evergreen"};
const themeDescriptions = {system: "Follow your device", graphite: "Charcoal & brass", paper: "Warm & light", midnight: "Deep blue", evergreen: "Forest & sage"};
let themePreference = "system";
try {
  const saved = localStorage.getItem("tdm-theme");
  if (Object.hasOwn(themeNames, saved)) themePreference = saved;
} catch (_) { /* Storage may be unavailable in private or restricted browsers. */ }
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const theme = themePreference === "system" ? (systemTheme.matches ? "graphite" : "paper") : themePreference;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = {graphite: "#17181b", paper: "#f5f3ee", midnight: "#111925", evergreen: "#17221f"}[theme];
}
applyTheme();
systemTheme.addEventListener("change", applyTheme);
