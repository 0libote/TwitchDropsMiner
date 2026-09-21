# Roadmap

This roadmap tracks the first operational-quality pass and the next useful increment for each
feature. The basic column describes what exists now; later work should be driven by user feedback
and real failure data.

| # | Area | Basic feature now | Improvement path |
|---|---|---|---|
| 1 | Statistics | Persistent/session counters plus account-specific SQLite reward history, game filters and 30-day local claim observations | Per-game mining-time history, retention controls and charts |
| 2 | Estimates | Engine-selected mining plan, qualified completion estimates and prerequisites | Improve estimates for overlapping campaigns and changing channel availability |
| 3 | Health | Liveness, readiness and redacted diagnostics endpoints | Reason codes and configurable readiness policy |
| 4 | Activity | Timestamped bounded activity and downloadable diagnostics | Severity filters and optional persistent event history |
| 5 | Notifications | Configurable JSON webhook with a dashboard test action | Templates and service presets |
| 6 | Authentication | Optional Basic protection, CSRF tokens with rotation on logout, host/origin checks | Secure form-based browser sessions and reverse-proxy identity support |
| 7 | Docker | Read-only filesystem, init process, healthcheck and environment configuration | Docker secrets examples and published Compose profiles |
| 8 | Watchdog | Rate-limited inventory refresh after 15 minutes without confirmed progress | Channel rotation and escalating recovery with reason history |
| 9 | Portability | Cookie-free settings/statistics export and settings import | Validated schema versions and an explicit encrypted full backup |
| 10 | Versioning | App, engine, Python, platform and packaging details in diagnostics | Rate-limited update checks with release notes |
| 11 | Metrics | Dependency-free Prometheus counters at `/metrics` | Authentication policy, labels and Grafana example dashboard |
| 12 | Notifications | Claim/webhook notifications in the activity feed | Templates and service presets |
| 13 | Startup errors | Plain log/console errors for fatal startup and duplicate instance | Action buttons for port conflicts |
| 14 | Resume recovery | Detect a long suspend gap and refresh Twitch state | Network-change hooks and measured reconnect backoff |

## Next milestone

1. Add form-based dashboard sessions and a real browser logout (a CSRF-rotating disconnect action exists).
2. Extend saved reward history with per-game mining time and verified export importers.
3. Add notification service presets and clearer delivery history.
4. Publish example monitoring configuration for Docker users.

> Removed when the project went Docker-only: Windows tray, autostart, awake mode,
> native startup dialogs, open-data/open-log shortcuts, and PyInstaller/AppImage
> packaging (former rows 12–16).
