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
--access-token TOKEN Protect the dashboard with a token
--legacy-ui          Run the original Tkinter interface
--log                Write log.txt in the data directory
```

## Run with Docker

Choose a long random dashboard token, then start the service:

```bash
export TDM_ACCESS_TOKEN="replace-with-a-long-random-value"
docker compose up -d --build
```

Open `http://127.0.0.1:8080/?token=replace-with-a-long-random-value` once. The dashboard stores an
HTTP-only session cookie so the token does not need to remain in later URLs.

The Compose configuration publishes only to the host's loopback interface. If you deliberately
expose it through a reverse proxy, use HTTPS and keep the access token enabled; the dashboard can
control the miner and reveal Twitch account state.

Common commands:

```bash
docker compose logs -f miner
docker compose restart miner
docker compose down
```

Authorization cookies and settings live in the `tdm-data` volume and survive container updates.

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
