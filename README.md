# Twitch Drops Miner Next

A cleaner, web-first community fork of
[DevilXD/TwitchDropsMiner](https://github.com/DevilXD/TwitchDropsMiner),
packaged as a Docker container.

> [!IMPORTANT]
> This is an independent fork, not a Twitch product and not an official DevilXD release. The
> proven mining engine, original interface, translations, and initial artwork come from
> DevilXD and the upstream contributors. See [NOTICE.md](NOTICE.md).

The project keeps upstream's low-bandwidth Twitch Drops engine and replaces the desktop-only
Tkinter experience with one responsive dashboard, served from the container.

## Current status

The web dashboard and container runtime are functional, but **Next is still pre-release
software**. There are no desktop builds: Windows tray, autostart, sleep prevention, and
PyInstaller/AppImage packaging were removed when the project went Docker-only.

| Mode | Experience | Persistent data |
| --- | --- | --- |
| Docker | Hosted dashboard on port `8080` | `/data` volume |
| Source | Local dashboard at `127.0.0.1:8080` (development only) | Repository directory or `TDM_DATA_DIR` |

## What it does

- Progresses timed Twitch Drops without downloading stream video or audio.
- Discovers eligible campaigns and claims completed drops automatically.
- Switches to a suitable live channel when availability changes.
- Supports priority and exclusion lists.
- Stores Twitch authorization locally and reuses it between runs.
- Presents campaign progress, channels, settings, and activity in one responsive interface.
- Keeps a permanent, account-specific SQLite reward history with search and game filters.
- Tracks upstream engine changes without silently applying volatile Twitch API updates.

## Run from source (development only)

Bun 1.4.2 or newer is required (pinned in `package.json:packageManager`).
Production runs are Docker-only; source runs exist for development work.

```bash
bun install
TDM_DATA_DIR=./data bun src/main.ts
```

The dashboard opens automatically. Twitch uses a device authorization flow: open the displayed
Twitch page and enter the one-time code. The dashboard does not collect your Twitch password.

Useful options:

```text
--host ADDRESS       Bind address; defaults to 127.0.0.1
--port PORT          Dashboard port; defaults to 8080
--no-browser         Do not launch a browser automatically
--log                Write log.txt in the data directory
```

Operational environment variables:

```text
TDM_LOG=1                 Enable the persistent log
TDM_WEB_TOKEN=secret      Protect the dashboard with HTTP Basic auth (user: tdm)
TDM_WEBHOOK_URL=https://  Send claim, network and watchdog events as JSON
TDM_PUBLIC_URL=https://  Exact dashboard origin when using a hostname/reverse proxy
```

Choose **Settings → Appearance** for Graphite (charcoal and brass), Paper (warm light),
Midnight (deep blue), Evergreen (forest and sage), or your system’s light/dark theme.
The sidebar also has a quick appearance selector.
Appearance is saved per browser.

Pause remains in effect through channel changes, refreshes and miner restarts. Use **Resume
mining** to continue. The mining plan shows the engine's selected games and blocked preferences;
completion estimates assume continuous availability and are not guarantees.

**History** saves rewards returned by Twitch's normal inventory refresh and future successful
claims to `history.sqlite3` in the data directory. Search by reward, game or campaign and filter
by game. Rewards survive subsequent Twitch inventory changes, and accounts stay separate.
This is the available history Twitch returns, not a guarantee of every drop ever claimed.
See [history coverage and storage](docs/history.md) for details and backup guidance.

Configure a JSON webhook under **Settings → Webhook notifications**, save, then use **Test
notification** to verify delivery. `TDM_WEBHOOK_URL` overrides the saved URL. Webhook URLs and
proxy credentials are omitted from settings exports.

The dashboard exposes `/healthz` for liveness, `/readyz` for authenticated Twitch readiness,
`/api/diagnostics` for redacted runtime details, and `/metrics` for basic Prometheus counters.
See [ROADMAP.md](ROADMAP.md) for the current operational QoL feature status and planned upgrades.

## Run with Docker

Docker is the only supported production runtime.

Published images support `linux/amd64` and `linux/arm64`. Set `TDM_WEB_TOKEN` in your shell,
then run the latest image:

```bash
docker run -d \
  --name twitch-drops-miner-next \
  --restart unless-stopped \
  -p 8080:8080 \
  -e TDM_WEB_TOKEN="${TDM_WEB_TOKEN:?Set a dashboard password first}" \
  -v tdm-data:/data \
  ghcr.io/0libote/twitchdropsminer:latest
```

The `latest` image follows every successful build of `main`. Version tags also publish a matching
immutable container tag alongside `latest`.

The current container uses Twitch's smart TV client for device authorization. Twitch currently
rejects new device authorizations for the older Android client. After updating, you may need to
activate the miner once more; settings and reward history remain in the data volume.

To build directly from a clone instead:

```bash
docker compose up -d --build
```

Open `http://127.0.0.1:8080/`.

On a remote server, `127.0.0.1` refers to the server itself. From another device, open
`http://SERVER_IP:8080/`. If you use a reverse proxy, point it at the server's published port
and set `TDM_PUBLIC_URL` below.
For Compose, put `TDM_PUBLIC_URL=https://miner.example.com` in a `.env` file beside
`compose.yaml`, then run `docker compose up -d --build` so the value reaches the container.

Compose publishes on all server interfaces by default. Set `TDM_WEB_TOKEN` before exposing the
dashboard to other devices; it can control the miner and reveal Twitch account state. Set
`TDM_BIND_ADDRESS=127.0.0.1` if you want access only from the server or through an SSH tunnel.

To open the dashboard directly from another device on your LAN, put these values in `.env`
beside `compose.yaml`, then recreate the container with `docker compose up -d --build`:

```text
TDM_PUBLISHED_PORT=18766
TDM_WEB_TOKEN=choose-a-long-password
```

Open `http://SERVER_LAN_IP:18766/` and sign in as `tdm`.

The dashboard accepts requests addressed to any IP or hostname. When accessing it through an
HTTPS reverse proxy, set
`TDM_PUBLIC_URL=https://miner.example.com` to the exact browser origin (scheme, hostname and
port, with no path). Dashboard actions require a CSRF token and reject foreign origins;
API clients first GET `/api/csrf` and send its `token` as `X-CSRF-Token` on writes. HTTP Basic
authentication remains controlled by `TDM_WEB_TOKEN`; it does not provide browser session logout.

Common commands:

```bash
docker compose logs -f miner
docker compose restart miner
docker compose down
```

Authorization cookies and settings live in the `tdm-data` volume and survive container updates.

### DNS blockers and firewalls

Twitch Drops Miner Next shows a dashboard warning after repeated requests to a Twitch hostname
fail. This is often caused by network-wide blocking rather than a miner bug. In particular,
`spade.twitch.tv` carries the watch heartbeat used for drop progress, so blocking it can leave a
drop stuck at the same percentage.

Prefer allowlisting only the exact hostnames shown in the warning:

- **Pi-hole:** add each hostname as an exact allowlist entry under Group Management > Domains, or
  run `pihole allow spade.twitch.tv` on the Pi-hole host.
- **AdGuard Home:** add `@@||spade.twitch.tv^` under Filters > Custom filtering rules. Add the
  other hostnames shown by the dashboard in the same form.

Alternatively, give only this container an unfiltered DNS resolver. Add `--dns 1.1.1.1` to the
`docker run` command, or add this to the `miner` service in `compose.yaml`:

```yaml
    dns:
      - 1.1.1.1
      - 1.0.0.1
```

Restart the container after changing DNS. A per-container override bypasses home DNS filtering
for every hostname requested by this container; an exact allowlist entry is the narrower option.

## Development

The miner is TypeScript on Bun: engine, dashboard server and lifecycle live
under `src/`. The dashboard UI is React with Meta's
[Astryx](https://astryx.atmeta.com) design system: components live in
`dashboard/`, and `bun run build` compiles them into the static files the
server serves from `web/` (`app.js`, `app.css`). Those two files are
committed, so a fresh checkout runs without a build step; Docker rebuilds
them anyway so an image can never ship a stale bundle. SQLite is built into
Bun and needs no database service. Python remains in the repo as the
upstream-tracking reference implementation (see below).

Run the checks:

```bash
bun run typecheck   # tsc --noEmit over src/, dashboard/, web/api-types.ts, scripts, tests
bun test            # Bun-native unit tests (src/*.test.ts)
bun run build       # dashboard/ -> web/app.js + web/app.css (commit the result)
bun audit           # JS supply-chain audit (also run in CI)
```

Restyle the dashboard with the Astryx CLI after editing a theme or looking
for a component:

```bash
bunx astryx theme build dashboard/themes/*.theme.ts   # or: bun run theme:build
bunx astryx component <Name>                         # props and examples
bunx astryx template <name> --skeleton               # page/block reference code
```

Run the miner from source (development only; production uses Docker):

```bash
bun install
TDM_DATA_DIR=./data bun src/main.ts
```

Browser checks (also required by CI):

```bash
bun install
bunx --package playwright@1.62.1 playwright install --with-deps chromium # --with-deps required on Linux
bun run preview                 # Bun.serve fixture preview on :8095
# In another terminal:
bun run test
```

The browser suite uses fictional fixtures and intercepts API actions; it never controls a live
miner. The Python reference suite (`env/bin/python -m unittest discover -s tests`,
`compileall`, `scripts/check_upstream.py --check`) still runs in CI against the
upstream-tracking implementation.

The browser suite uses fictional fixtures and intercepts API actions; it never controls a live
miner. Python tests exercise the real request validation and persistence against temporary data.

## Upstream maintenance

The repository preserves the full upstream Git history. Configure remotes like this after cloning:

```bash
git remote add upstream https://github.com/DevilXD/TwitchDropsMiner.git
git fetch upstream
```

`.upstream-base` records the last upstream commit reviewed against this fork. Every Monday, the
`Upstream watch` workflow fetches `upstream/master`, lists new commits, highlights changes to the
mining backend, and opens or updates a tracking issue. It does **not** auto-merge Twitch protocol
changes.

After integrating and testing an upstream update, replace `.upstream-base` with the reviewed full
SHA. This makes the next report contain only newer work.

## Security and Twitch behavior

The authorization cookie grants access to the connected Twitch account. Keep the data directory
or Docker volume private. Do not publish it, copy it into images, or expose the dashboard without
access control.

Watching Twitch in another browser with the same account while mining can make reported progress
unreliable. Account linking for campaign rewards must still be completed on Twitch.

Twitch can change private APIs without notice. Upstream tracking reduces detection time but cannot
guarantee uninterrupted operation.

## Credits and license

This fork exists because of the extensive work by
[DevilXD](https://github.com/DevilXD) and every contributor to the
[original project](https://github.com/DevilXD/TwitchDropsMiner/graphs/contributors). Please direct
support for their work to the upstream project.

The code is distributed under the [MIT License](LICENSE). The original copyright notice is
retained as required.
