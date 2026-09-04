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
| 6 | Authentication | Optional Basic protection, CSRF tokens, host/origin checks | Secure browser session, logout and reverse-proxy identity support |
| 7 | Docker | Read-only filesystem, init process, healthcheck and environment configuration | Docker secrets examples and published Compose profiles |
| 8 | Watchdog | Rate-limited inventory refresh after 15 minutes without confirmed progress | Channel rotation and escalating recovery with reason history |
| 9 | Portability | Cookie-free settings/statistics export and settings import | Validated schema versions and an explicit encrypted full backup |
| 10 | Versioning | App, engine, Python, platform and packaging details in diagnostics | Rate-limited update checks with release notes |
| 11 | Metrics | Dependency-free Prometheus counters at `/metrics` | Authentication policy, labels and Grafana example dashboard |
| 12 | Windows tray | Open-dashboard and exit menu with status icon/title | Pause/resume, progress menu and notification controls |
| 13 | Autostart | Windows registry startup toggle | Task Scheduler mode for unattended Windows hosts |
| 14 | Awake mode | Optional Windows sleep prevention while actively mining | Power-state diagnostics and configurable behavior |
| 15 | Startup errors | Native Windows error dialog for fatal startup and duplicate instance | Action buttons for port conflicts and opening logs |
| 16 | Shortcuts | Dashboard buttons to open the data folder and log on Windows | Tray shortcuts and reveal individual files |
| 17 | Resume recovery | Detect a long suspend gap and refresh Twitch state | Network-change hooks and measured reconnect backoff |

## Next milestone

1. Add form-based dashboard sessions and browser logout.
2. Extend saved reward history with per-game mining time and verified export importers.
3. Exercise Windows tray, autostart, sleep and startup-error behavior on packaged CI artifacts.
4. Add notification service presets and clearer delivery history.
5. Publish example monitoring configuration for Docker users.
