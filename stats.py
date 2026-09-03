from __future__ import annotations

from datetime import datetime, timezone
from time import monotonic
from typing import Any

from constants import DATA_DIR
from utils import json_load, json_save


STATS_PATH = DATA_DIR / "stats.json"
DEFAULTS: dict[str, Any] = {
    "drops_claimed": 0,
    "mining_minutes": 0,
    "channel_switches": 0,
    "watch_heartbeats": 0,
    "watch_failures": 0,
    "started_count": 0,
    "last_claim_at": "",
    "last_progress_at": "",
    "last_heartbeat_at": "",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Stats:
    """Tiny persistent counters plus per-process operational state."""

    def __init__(self) -> None:
        self.lifetime = json_load(STATS_PATH, DEFAULTS)
        self.session = {key: 0 for key in DEFAULTS if isinstance(DEFAULTS[key], int)}
        self.started_at = _now()
        self.started_monotonic = monotonic()
        self.last_inventory_at: str | None = None
        self.last_recovery_at: str | None = None
        self.lifetime["started_count"] += 1
        self.session["started_count"] = 1
        self.save()

    def increment(self, name: str, amount: int = 1, *, stamp: str | None = None) -> None:
        self.lifetime[name] = int(self.lifetime.get(name, 0)) + amount
        self.session[name] = int(self.session.get(name, 0)) + amount
        if stamp:
            self.lifetime[stamp] = _now()
        self.save()

    def progress(self, minutes: int) -> None:
        if minutes > 0:
            self.increment("mining_minutes", minutes, stamp="last_progress_at")

    def heartbeat(self, succeeded: bool) -> None:
        self.increment("watch_heartbeats", stamp="last_heartbeat_at")
        if not succeeded:
            self.increment("watch_failures")

    def claim(self) -> None:
        self.increment("drops_claimed", stamp="last_claim_at")

    def save(self) -> None:
        json_save(STATS_PATH, self.lifetime, sort=True)

    def snapshot(self) -> dict[str, Any]:
        return {
            "startedAt": self.started_at,
            "uptimeSeconds": int(monotonic() - self.started_monotonic),
            "session": dict(self.session),
            "lifetime": dict(self.lifetime),
            "lastInventoryAt": self.last_inventory_at,
            "lastRecoveryAt": self.last_recovery_at,
        }
