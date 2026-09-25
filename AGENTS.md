# AGENTS.md

Project-specific guidance for AI coding agents.

## Dashboard build

- UI source is `dashboard/` (React + Astryx): entry `dashboard/app.tsx`, routes in
  `dashboard/routes/`, shell/page furniture in `dashboard/shell/`, state + routing in
  `dashboard/core/`.
- `bun run build` compiles it to `web/app.js` + `web/app.css`. **Both are committed and served
  as plain static files — rebuild and commit them after every UI change.** Docker rebuilds the
  bundle too, so a stale commit still ships correct code.
- `bun run theme:build` recompiles the four appearances from `dashboard/themes/*.theme.ts`.
  The generated `.css`, `.js` and `.d.ts` next to them are committed as well; never edit them by
  hand.
- `web/theme.js` must stay a standalone classic script: theme tests run it in a VM, and it paints
  `data-theme` / `data-astryx-theme` on `<html>` before any stylesheet loads.
- Verify with `bun run typecheck`, `bun test`, `bun tests/test_web_theme.cjs`, and
  `bun run test:browser` against a running `bun run preview`.

<!-- ASTRYX:START -->
Astryx v0.6.3 · 164 components
CLI: run every command as `bunx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — discover, don't guess. Before writing UI:
1. `astryx build "<idea>"` — START HERE: returns a kit (closest [page] + [block]s + [component]s). No args = full playbook.
2. `astryx template <name> [--skeleton]` — scaffold the [page]/[block]s it named, or study their layout. Templates are reference code.
3. `astryx component <Name>` — props + examples for every component you use.

RULES:
- No <div> — components do all layout/spacing, page frame included.
- Frame first: read `astryx docs layout` before writing any page or screen — page frame, region widths, breakpoint behavior.
- Dense data = rows (Table, List/Item), never Card-wrapped list items; Card is for standalone widgets. Status = StatusDot/Token; Badge = counts only.
- Custom styling: component props first; else style/className with tokens — var(--color-*|--spacing-*|--radius-*). No raw hex/px. (No StyleX/Tailwind compiler here — don't use xstyle/utility classes.)
- Tokens for every value (`astryx docs tokens`). Brand/accent belongs in the theme (`astryx theme list` / `theme add <slug>`, or `astryx theme template` for a custom one) — never override --color-* in :root.
- SELF-CHECK before you finish: re-read the file and replace any raw <div>/<span> layout, imported .css/@apply, or hardcoded value (#hex, 16px) with the component or a token (var(--color-*|--spacing-*|…)). If unsure a component/prop exists, run `astryx component <Name>` / `astryx search "<thing>"`; don't hand-roll CSS.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   164 components by category
  template --list    page + block recipes
  docs <topic>       browser-support, cli-integrations, color, elevation, getting-started, icons, illustrations, internationalization, layout, migration, motion, principles, shape, spacing, styling-libraries, styling, theme, tokens, typography, working-with-ai
  swizzle <Name>     eject component source for deep customization
  upgrade --apply    run after any Astryx or integration dependency bump
<!-- ASTRYX:END -->
