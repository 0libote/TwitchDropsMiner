# Twitch Drops Miner Next

A cleaner, web-first community fork of
[DevilXD/TwitchDropsMiner](https://github.com/DevilXD/TwitchDropsMiner) for Windows, macOS,
and Docker.

> [!IMPORTANT]
> This is an independent fork, not a Twitch product and not an official DevilXD release. The
> proven mining engine, original interface, translations, and initial artwork come from
> DevilXD and the upstream contributors. See [NOTICE.md](NOTICE.md).

The project keeps upstream's low-bandwidth Twitch Drops engine and replaces the desktop-only
Tkinter experience with one responsive dashboard. Desktop builds open it locally; Docker serves
the same UI. The original UI remains available during the transition with `--legacy-ui`.

## Current status

The web dashboard and headless runtime are functional, but **Next is still pre-release software**.
Use the original upstream release if you need its most established desktop experience today.

| Mode | Experience | Persistent data |
| --- | --- | --- |
| Windows | Packaged folder + local dashboard | `%LOCALAPPDATA%\Twitch Drops Miner Next` |
| macOS | Packaged app + local dashboard | `~/Library/Application Support/Twitch Drops Miner Next` |
| Docker | Hosted dashboard on port `8080` | `/data` volume |
| Source | Local dashboard at `127.0.0.1:8080` | Repository directory or `TDM_DATA_DIR` |

## What it does

- Progresses timed Twitch Drops without downloading stream video or audio.
- Discovers eligible campaigns and claims completed drops automatically.
- Switches to a suitable live channel when availability changes.
- Supports priority and exclusion lists.
- Stores Twitch authorization locally and reuses it between runs.
- Presents campaign progress, channels, settings, and activity in one responsive interface.
- Tracks upstream engine changes without silently applying volatile Twitch API updates.

## Run from source

Python 3.10 or newer is required.

```bash
python -m venv env
```

On macOS or Linux:

```bash
env/bin/pip install -r requirements-headless.txt
env/bin/python main.py
```

On Windows PowerShell:

```powershell
env\Scripts\pip install -r requirements-headless.txt
env\Scripts\python main.py
```

The dashboard opens automatically. Twitch uses a device authorization flow: open the displayed
Twitch page and enter the one-time code. The dashboard does not collect your Twitch password.

Useful options:

```text
--host ADDRESS       Bind address; defaults to 127.0.0.1
--port PORT          Dashboard port; defaults to 8080
--no-browser         Do not launch a browser automatically
--legacy-ui          Run the original Tkinter interface
--log                Write log.txt in the data directory
```

## Desktop builds

Download the latest version from the single
[Latest prerelease](https://github.com/0libote/TwitchDropsMiner/releases/tag/latest). Choose the archive for
Windows x64, macOS Apple Silicon, or macOS Intel. Each archive is started and health-checked on
the matching hosted runner before publication.

Pushing a `v*` version tag updates that prerelease and moves its `latest` tag to the tested commit.
The version tag remains available for source history, while older prerelease entries are removed.
The apps are not code-signed or notarized yet, so Windows SmartScreen or macOS Gatekeeper may show
an unknown-publisher warning. Signing should be added only after the product name and publisher
identity are final.

## Run with Docker

Published images support `linux/amd64` and `linux/arm64`. Run the latest image:

```bash
docker run -d \
  --name twitch-drops-miner-next \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v tdm-data:/data \
  ghcr.io/0libote/twitchdropsminer:latest
```

To build directly from a clone instead:

```bash
docker compose up -d --build
```

Open `http://127.0.0.1:8080/`.

The Compose configuration publishes only to the host's loopback interface. If you deliberately
expose it beyond a trusted LAN, add authentication and HTTPS at the reverse proxy; the dashboard
can control the miner and reveal Twitch account state.

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

The modern path deliberately uses the dependencies already central to the miner:

- Python and `asyncio` for the engine and lifecycle.
- `aiohttp` for Twitch networking and the dashboard server.
- Plain HTML, CSS, and JavaScript with server-sent events for the UI.
- PyInstaller for Windows and macOS artifacts.

There is no Node build, frontend framework, database, or second API server to keep synchronized.

Run the checks:

```bash
env/bin/python -m unittest discover -s tests -v
env/bin/python -m compileall -q .
env/bin/python scripts/check_upstream.py --check
```

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
