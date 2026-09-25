# Dashboard design

The dashboard should feel like a small, well-made game library. Its first job is to answer what
reward is being earned, how far along it is, and what happens next. It is the same frontend in
Docker and source runs.

## Architecture

- `dashboard/` — React source. `dashboard/app.tsx` is the entry; routes live in
  `dashboard/routes/`, shared shell and page furniture in `dashboard/shell/`, state, routing and
  formatting in `dashboard/core/`.
- Styling comes from [Astryx](https://astryx.atmeta.com), Meta's open-source design system:
  `@astryxdesign/core/reset.css` + `astryx.css` supply components and typography, and every
  appearance is one Astryx theme compiled by the CLI (`bun run theme:build`) into
  `dashboard/themes/<name>.css`. App-specific layout lives in `dashboard/styles/app.css` and may
  only use design tokens (`var(--color-*)`, `var(--spacing-*)`, `var(--radius-*)`, …).
- `bun run build` bundles `dashboard/app.tsx` into `web/app.js` + `web/app.css`, which the
  servers hand out as static files. Both outputs are committed; Docker rebuilds them anyway.
- `web/theme.js` still runs before the stylesheet: it reads the saved appearance and sets
  `data-theme` / `data-astryx-theme` on `<html>` so Astryx tokens apply on first paint.

Component and layout rules come from the system, not from taste: Astryx's own guidance is in the
generated `AGENTS.md`, and every component's props are printed by `bunx astryx component <Name>`.

## Design decisions

- Give the active reward the most space. Use actual Twitch reward artwork, a readable progress
  figure and minutes remaining. Keep other rewards from the same campaign visible beneath it.
- Put session information in a quieter adjacent column. Simple rows, not a wall of cards.
- Make the queue informative. Show game artwork, the selection reason and whether this entry is
  being mined right now; link directly to campaign details.
- Dense data is rows, edge-to-edge with dividers (Astryx `Table` / `List`); `Card` is reserved
  for self-contained widgets such as the reward hero, settings groups and diagnostics tiles.
- One lead per region, ranked by weight and colour rather than by shrinking text, and no
  secondary text colour below `--color-text-secondary`.
- Use system fonts, local SVG icons and no CDN dependency at all. Missing Twitch artwork leaves
  an intentional gift placeholder.
- Keep actions predictable across routes. Preserve keyboard focus and unsaved form input during
  live state updates; disconnection visibly qualifies the last received state.

Graphite uses charcoal and brass; Paper uses warm neutrals and terracotta; Midnight uses navy and
pale blue; Evergreen uses forest greens and sage. System follows the operating system.
Preferences remain local to the browser and apply before the stylesheet loads. All five choices
are available in Settings, with a quick selector in the sidebar.

## Research

The phrase “AI slop” describes a subjective reaction, not a measurable design standard. The
useful criticism is repetition without a reason: identical cards, generic copy and effects
unrelated to the task. [Kosta Canatselis’s design critique](https://world.hey.com/kostac/spot-the-slop-a-ui-designer-s-guide-to-fixing-ai-defaults-4c448c9c)
captures that concern.

The positive direction comes from [NN/g’s visual design principles](https://www.nngroup.com/articles/principles-visual-design/):
hierarchy, proximity, scale and contrast should make the interface easier to understand.
[Their discussion of content dispersion](https://www.nngroup.com/articles/content-dispersion/)
also cautions against spreading useful desktop information across excessive whitespace. This
application does not copy anyone's layout.

## Preview and verification

A read-only preview uses fictional sample rewards, channels and statistics. It never connects to
Twitch or reads local credentials:

```sh
python scripts/preview_web.py   # or: bun run preview
```

Open `http://127.0.0.1:8095`. The sample fixture uses game cover art for some reward images.
Action requests show a preview-only message; run the real miner for working controls.

Existing checks:

```sh
bun run typecheck
bun test
bun tests/test_web_theme.cjs
python -m unittest discover -s tests -p 'test_*.py'
```

The browser regression suite uses pinned, development-only Playwright and its Chromium browser
(via Bun):

```sh
bun install
bunx --package playwright@1.62.1 playwright install --with-deps chromium # --with-deps for Linux deps
bun run test
```

Run the preview server first. `TDM_PREVIEW_URL` can override its URL; `CHROMIUM_PATH` can select
an existing browser executable. The suite intercepts all API requests and injects sample events.
It checks themes, focus during updates, save behavior, the game picker, search,
reconnect/paused/empty states, missing artwork, authorization, and all seven routes at desktop,
tablet and mobile widths. Desktop and mobile screenshots should also be reviewed when changing
layout.

Docker users receive the shared frontend when rebuilding with `docker compose up -d --build`; the
image rebuilds the bundle from `dashboard/`, so no settings migration and no manual build step is
required.

The saved History view distinguishes available Twitch inventory from local claim observations,
keeps account data separate, and shows unknown dates/games explicitly. The dashboard mining plan
comes from engine selection; estimates are qualified and omitted when timing is unknown.
CSRF bootstrap, account changes, reward history and live focus retention are covered in CI.
