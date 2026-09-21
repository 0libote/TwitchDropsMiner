# Bun port plan

Docker-only is done (#9). This tracks the TypeScript/Bun rewrite of the
Python miner. The container still ships Python until the TS server reaches
parity; `src/` modules are developed and tested side-by-side.

## Compatibility guarantees

- **JSON files** (`settings.json`, `stats.json`): byte-compatible via
  `src/jsonStore.ts` — same `__type` tags, same atomic `<name>.new` +
  rename saves, same merge semantics. Either runtime reads the other's
  files (proven by `jsonStore.test.ts` + the Python-written
  `tests/fixtures/history-python.sqlite3` read in `history.test.ts`).
- **SQLite** (`history.sqlite3`): identical schema, SQL, and `+00:00`
  timestamp storage via `bun:sqlite` in `src/history.ts`.
- **API surface**: `GET /api/state` and friends keep their shape so the
  existing `web/` dashboard works unchanged against either backend.

## Module map

| Python | TypeScript | Status | Notes |
|---|---|---|---|
| `utils.py` JSON (`json_load/save`, `merge_json`, tags) | `src/jsonStore.ts` | ✅ done | `RateLimiter`/`AwaitableValue`/`task_wrapper` move with the engine (phase 2) |
| `utils.py` `ExponentialBackoff` | `src/backoff.ts` | ✅ done | Exact semantics incl. no-step-on-cap |
| `stats.py` | `src/stats.ts` | ✅ done | Same defaults, stamps, snapshot shape |
| `history.py` | `src/history.ts` | ✅ done | Same schema/SQL; engine objects are structural interfaces for now |
| `constants.py` (GQL queries, topics, limits) | `src/twitchProtocol.ts` | ✅ done | All 15 query hashes/structures and agent lists verified against Python |
| `settings.py` | `src/settings.ts` | ✅ done | Same defaults/merge/CLI-overlay; reads Python-written `settings.json` |
| `channel.py`, `inventory.py` (models) | `src/models.ts` (+`utils.ts`, `errors.ts`) | ✅ done | 29 tests; `EngineLike` interface stands in for the engine |
| `utils.py` async (`AwaitableValue`, `chunk`, `create_nonce`, `RateLimiter`) | `src/async.ts` | ✅ done | Tested alongside websocket/engine |
| `websocket.py` | `src/websocket.ts` | ✅ done | Bun-native sockets; same rules, tested live |
| `twitch.py` (auth + engine) | `src/auth.ts`, `src/engine.ts` (+`cookies.ts`, `http.ts`, `i18n.ts`) | ✅ done | 21 tests on scripted transport; JSON cookies (one re-login); `EngineGui` stands in for the server |
| `webui.py` (dashboard server) | `src/server.ts` (+`version.ts`) | ✅ done | Same routes/rules/snapshot; 18 tests incl. live SSE |
| `main.py` (CLI/lifecycle) | `src/main.ts` | ✅ done | Same flags/env; PID lock instead of OS file locks |
| `translate.py`, `lang/*.json` | `src/i18n.ts` (engine subset) | ✅ done | Full locale switching not ported; strings identical |
| `exceptions.py` | `src/errors.ts` | ✅ done | Same hierarchy + `received` flag |

## Phases

1. **Foundations (done):** `jsonStore`, `backoff`, `stats`, `history`,
   `twitchProtocol`, `settings`, all cross-checked against Python behavior.
2. **Engine (done):** models, websocket, auth, engine, server, CLI — 139
   `bun:test` tests plus a full-stack boot test; Playwright suite runs
   against either backend unchanged.
3. **Cutover (this change):** `Dockerfile` switches to `oven/bun`.
   Python stays in the repo as the upstream-tracking reference and its
   test matrix keeps running; the shipped image is Bun-only.
