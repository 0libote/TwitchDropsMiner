# Roadmap

This roadmap tracks the first operational-quality pass and the next useful increment for each
feature. The basic column describes what exists now; later work should be driven by user feedback
and real failure data.

| # | Area | Basic feature now | Improvement path |
|---|---|---|---|
| 1 | Statistics | Persistent and session claim, mining-minute, switch, heartbeat and failure counters | Per-game/day history, retention controls and charts |
| 2 | Estimates | Active-drop completion time and campaign feasibility warning | Queue-aware estimates across dependent drops |
| 3 | Health | Liveness, readiness and redacted diagnostics endpoints | Reason codes and configurable readiness policy |
| 4 | Activity | Timestamped bounded activity and downloadable diagnostics | Severity filters and optional persistent event history |
| 5 | Notifications | Generic JSON webhook for claims, failures, recovery and stalls | Templates, test button and service presets |
| 6 | Authentication | Optional `TDM_WEB_TOKEN` HTTP Basic protection | Secure browser session, logout and reverse-proxy identity support |
| 7 | Docker | Read-only filesystem, init process, healthcheck and environment configuration | Docker secrets examples and published Compose profiles |
| 8 | Watchdog | One rate-limited inventory refresh after 15 minutes without progress | Channel rotation and escalating recovery with reason history |
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

1. Harden authentication into a form-based session and add CSRF protection.
2. Add queue-aware estimates and per-game daily statistics.
3. Exercise Windows tray, autostart, sleep and startup-error behavior on packaged CI artifacts.
4. Add webhook configuration and a test action to the dashboard.
5. Publish example monitoring configuration for Docker users.
