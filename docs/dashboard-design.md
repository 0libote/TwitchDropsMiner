# Dashboard design

The dashboard should feel like a small, well-made game library. Its first job is to answer what reward is being earned, how far along it is, and what happens next. It is the same frontend in Docker, desktop builds and source runs.

## Design decisions

- Give the active reward the most space. Use actual Twitch reward artwork, a readable progress figure and minutes remaining. Keep other rewards from the same campaign visible beneath it.
- Put session information in a quieter adjacent column. Use simple rows for uptime and mining time; these do not need separate cards.
- Make the queue informative. Show game artwork, remaining drops, campaign availability and whether a live channel is available. Link directly to campaign details.
- Use restrained solid surfaces, a compact navigation rail, consistent outlines and one accent per palette. Avoid decorative gradients, promotional copy, oversized dashboard headings and unnecessary motion.
- Keep actions predictable across routes. Preserve keyboard focus and unsaved form input during live state updates. Disconnection must visibly qualify the last received state.
- Use local system fonts and inline SVG icons. The frontend has no font, icon or framework CDN dependency. Missing Twitch artwork leaves a gift placeholder.

Graphite uses charcoal and brass; Paper uses warm neutrals and terracotta; Midnight uses navy and pale blue; Evergreen uses forest greens and sage. System follows the operating system. Preferences remain local to the browser and apply before the stylesheet loads. All five choices are available in Settings, with a quick selector in the desktop sidebar.

## Research

The phrase “AI slop” describes a subjective reaction, not a measurable design standard. The useful criticism is repetition without a reason: identical cards, generic copy and effects unrelated to the task. [Kosta Canatselis’s design critique](https://world.hey.com/kostac/spot-the-slop-a-ui-designer-s-guide-to-fixing-ai-defaults-4c448c9c) captures that concern.

The positive direction comes from [NN/g’s visual design principles](https://www.nngroup.com/articles/principles-visual-design/): hierarchy, proximity, scale and contrast should make the interface easier to understand. [Their discussion of content dispersion](https://www.nngroup.com/articles/content-dispersion/) also cautions against spreading useful desktop information across excessive whitespace. [Linear’s account of its 2024 redesign](https://linear.app/now/how-we-redesigned-the-linear-ui) is a useful reference for refining a working product in context. These informed the decisions above; this application does not copy their layouts.

## Preview and verification

A read-only preview uses fictional sample rewards, channels and statistics. It never connects to Twitch or reads local credentials:

```sh
python scripts/preview_web.py
```

Open `http://127.0.0.1:8095`. The sample fixture uses game cover art for some reward images. Action requests show a preview-only message; run the real miner for working controls.

Existing checks:

```sh
node tests/test_web_theme.cjs
python -m unittest discover -s tests -p 'test_*.py'
```

The optional browser regression suite needs Playwright and its Chromium browser. Install these in a temporary directory to keep frontend tooling out of the application:

```sh
npm install --prefix /tmp/tdm-browser-tools playwright
/tmp/tdm-browser-tools/node_modules/.bin/playwright install chromium
PLAYWRIGHT_MODULE=/tmp/tdm-browser-tools/node_modules/playwright node tests/test_web_ui.cjs
```

Run the preview server first. `TDM_PREVIEW_URL` can override its URL; `CHROMIUM_PATH` can select an existing browser executable. The suite intercepts all API requests and injects sample events. It checks themes, focus during updates, save behavior, the game picker, search, reconnect/paused/empty states, missing artwork, authorization, and all six routes at desktop, tablet and mobile widths. Desktop and mobile screenshots should also be reviewed when changing layout.

Docker users receive the shared frontend when rebuilding with `docker compose up -d --build`. No settings migration is required.
