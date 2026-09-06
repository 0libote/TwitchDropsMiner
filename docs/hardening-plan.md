# Hardening Plan P0–P3

Status: Implemented in `chore/hardening-p0-p3` (PR #4) — all checks green locally.

## P0 — Security / data-loss
- [x] `constants.py:121` / `twitch.py:84,537` — `cookies.jar` `chmod 0o600`, `os.umask(0o077)`, `DATA_DIR 0o700`
- [x] `webui.py:358,651,781` — per-session CSRF `__Host-csrf` double-submit + rotation on logout
- [x] `webui.py:621,628` — host allow-list: remove bare-IP bypass, require `TDM_ALLOWED_HOSTS`/`TDM_PUBLIC_URL`
- [x] `webui.py:644` — strict Origin check against `TDM_PUBLIC_URL` or validated Host
- [x] `webui.py:850` + `twitch.py:1348` — SSRF deny for `proxy`/`webhookUrl`, scrub proxy from logs
- [x] `webui.py:581` — `security_headers` outermost
- [x] `twitch.py:746` — `sorted(self.inventory)` copy
- [x] `twitch.py:609` + `webui.py:998,784` — watchdog `force=True` bypass for `INVENTORY_FETCH`/`RESTART` while paused
- [x] `webui.py:420` — `snapshot()` `list(...)` copy to avoid `OrderedDict mutated`

## P1 — Reliability
- [x] `utils.py:78` — `lock_file` atomic `a+` + `fsync` + `chmod 0o600`
- [x] `inventory.py:189` — dead `"errors" in data` → check `response`
- [x] `main.py:129` — `RotatingFileHandler(5MB,3,utf8)`, `twitch.py:1564` bounded dump, `webui.py:359` webhook cap (sem 4, max 20)
- [x] `cache.py:94` — release lock before fetch, double-checked store
- [x] `main.py:162` / `websocket.py:112` — await pending tasks properly
- [x] `Dockerfile:27` — healthcheck respects `TDM_PORT`

## P2 — Maintainability / perf
- [x] `pyproject.toml:32` — enable `UP`, fix `safe_loads`, ignore `UP007/UP036` (auto-fixable rest)
- [x] `twitch.py:842` — `asyncio.gather` fan-out for `get_live_streams` (sem 6)
- [x] `webui.py:504` — `list(channels.values())` in mining plan
- [x] `settings.py:86` — `super().__getattribute__`
- [x] `compose.yaml:6` — `security_opt no-new-privileges`, `cap_drop ALL`

## P3 — Testing / CI
- [x] `ci.yml` — `pip-audit`/`bun audit`, `sbom:true provenance:max`, `upstream.yml` SHA pin
- [x] `README` — document `TDM_ALLOWED_HOSTS`
- [x] `tests/test_mining_plan.py:100` — expect `force=True` for watchdog
