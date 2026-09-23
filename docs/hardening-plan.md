# Hardening Plan P0–P3

Status: Implemented in `chore/hardening-p0-p3` (PR #4), then corrected and extended in the
follow-up audit. Line references were removed because they drift; each item names the behavior
and the module instead.

Later deployment changes removed the dashboard Host allow-list in both runtimes. The entries
below record what PR #4 implemented at the time; authentication and CSRF checks still apply.

## P0 — Security / data-loss
- [x] `constants.py` / `twitch.py` — `cookies.jar` `chmod 0o600`, `os.umask(0o077)`, `DATA_DIR 0o700`
- [x] `webui.py` — per-session CSRF `__Host-csrf` double-submit + rotation on logout
- [x] `webui.py` — host allow-list: remove bare-IP bypass, require `TDM_ALLOWED_HOSTS`/`TDM_PUBLIC_URL`
- [x] `webui.py` — strict Origin check against `TDM_PUBLIC_URL` or validated Host
- [x] `webui.py` — SSRF deny for `proxy`/`webhookUrl`; proxy scrubbed from request logs
- [x] `webui.py` — `security_headers` middleware outermost
- [x] `twitch.py` — copy the inventory before sorting in the games-update state
- [x] `twitch.py` / `webui.py` — watchdog `force=True` bypass for `INVENTORY_FETCH`/`RESTART` while paused
- [x] `webui.py` — `snapshot()` uses `list(...)` copies to avoid `OrderedDict mutated`

## P1 — Reliability
- [x] `utils.py` — `lock_file` atomic `a+` + `fsync` + `chmod 0o600`
- [x] `inventory.py` — drop-inventory claim paths handle missing/extra error fields
- [x] `main.py` / `twitch.py` / `webui.py` — `RotatingFileHandler(5MB,3,utf8)`, bounded dump, bounded webhook tasks
- [x] `twitch.py` — startup/login failures no longer crash the process; fatal and login errors are logged at CRITICAL and printed to stderr
- [x] `main.py` / `websocket.py` — await pending tasks properly
- [x] `Dockerfile` — healthcheck respects `TDM_PORT`
- [x] `twitch.py` — `_campaigns` index is rebuilt on every inventory refresh (was never cleared)

## P2 — Maintainability / perf
- [x] `pyproject.toml` — enable `UP`, fix `safe_loads`, ignore `UP007/UP036` (auto-fixable rest)
- [x] `twitch.py` — `asyncio.gather` fan-out for `get_live_streams` (sem 6)
- [x] `webui.py` — `list(channels.values())` in mining plan
- [x] `settings.py` — `super().__getattribute__`
- [x] `compose.yaml` — `security_opt no-new-privileges`, `cap_drop ALL`

## P3 — Testing / CI
- [x] `ci.yml` — `pip-audit`/`bun audit` that can actually fail (correct ordering, no `|| true`),
  `sbom:true provenance:max`, `upstream.yml` SHA pin
- [x] `ci.yml` — Docker smoke test uses `TDM_WEB_TOKEN` and asserts the dashboard is protected
- [x] `ci.yml` — Python version matrix covering the declared floor (`3.10`, `3.12`, `3.13`, `3.14`)
- [x] `README` — document `TDM_ALLOWED_HOSTS`
- [x] `tests/` — regression tests for login error handling and CSRF retry

## Follow-up audit (this pass)

In addition to the items above:
- Removed the unmaintained legacy Tkinter UI (`gui.py`, `cache.py`), the `--legacy-ui` flag and
  all Tk/Pillow/seleniumwire build references; the dashboard is the single supported UI.
- Stopped the frontend rebuilding the mining/settings/diagnostics views on every server event
  (typed input, open pickers and log scroll now survive state updates).
- Frontend now re-fetches and retries once on a rotated CSRF token (HTTP 403).
- Escaped/validated dashboard links and fixed the `unavailable` campaign badge.
- Declared `yarl` as a direct dependency; removed the placeholder `uv.lock`; repaired `pack.bat`;
  added `web/` to the AppImage recipe.
