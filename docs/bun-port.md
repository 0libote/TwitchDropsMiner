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
| `channel.py`, `inventory.py` (models) | `src/models.ts` | phase 2 | Needs GQL response typing |
| `websocket.py` | `src/websocket.ts` | phase 2 | Bun native WebSocket client |
| `twitch.py` (engine) | `src/engine.ts` | phase 2 | The big one: state machine, GQL, watch loop |
| `webui.py` (dashboard server) | `src/server.ts` | phase 2 | `Bun.serve()` routes + SSE; serve `web/` |
| `main.py` (CLI/lifecycle) | `src/main.ts` | phase 3 | Args, signals, lock file |
| `translate.py`, `lang/*.json` | reuse as-is | phase 3 | Load JSON directly, no port needed |
| `exceptions.py` | inline error classes | phase 2 | Trivial, port with engine |

## Phases

1. **Foundations (done):** `jsonStore`, `backoff`, `stats`, `history`,
   `twitchProtocol`, `settings` + 39 `bun:test` tests, all cross-checked
   against Python behavior.
2. **Engine:** protocol data, models, websocket, engine, server. Dashboard
   runs against the TS server behind a flag; Playwright suite runs against
   both.
3. **Cutover:** `Dockerfile` switches to `oven/bun`, Python becomes the
   fallback for one release, then is removed with `requirements*.txt`,
   `uv.lock`, and the Python CI matrix.
