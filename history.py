"""Account-scoped reward snapshots and independently observed claim events."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

COVERAGE = (
    "Available Twitch inventory plus claims recorded by this installation; "
    "older missing awards cannot be recovered."
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _text(value: Any) -> str | None:
    return str(value) if isinstance(value, (str, int)) and not isinstance(value, bool) else None


def _date(value: Any) -> str | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc).isoformat() if parsed.tzinfo else None
    except (ValueError, TypeError):
        return None


class History:
    def __init__(self, path: str | Path) -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        tables = {r[0] for r in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        columns = {
            "rewards": {"account_id", "benefit_id", "name", "image_url", "game_id", "game_name",
                        "campaign_id", "campaign_name", "last_awarded_at", "observed_at",
                        "last_seen_at", "source", "award_count", "metadata"},
            "claims": {"account_id", "campaign_id", "drop_id", "recorded_at", "game_id",
                       "game_name", "campaign_name", "drop_name", "benefits"},
            "syncs": {"account_id", "synced_at"},
        }
        if version > 1:
            self.db.close()
            raise sqlite3.DatabaseError("History database was created by a newer version")
        legacy = False
        if tables:
            valid = tables == set(columns)
            for table in tables & set(columns):
                actual = {r[1] for r in self.db.execute(f"PRAGMA table_info({table})")}
                if table == "claims" and version == 0 and "claimed_at" in actual:
                    actual = actual - {"claimed_at"} | {"recorded_at"}
                    legacy = True
                valid = valid and actual == columns[table]
            if not valid:
                self.db.close()
                raise sqlite3.DatabaseError("Unrecognized history database schema")
        elif version:
            self.db.close()
            raise sqlite3.DatabaseError("History database schema is missing")
        if legacy:
            with self.db:
                self.db.execute("ALTER TABLE claims RENAME COLUMN claimed_at TO recorded_at")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS rewards (
                account_id TEXT NOT NULL, benefit_id TEXT NOT NULL,
                name TEXT, image_url TEXT, game_id TEXT, game_name TEXT,
                campaign_id TEXT, campaign_name TEXT, last_awarded_at TEXT,
                observed_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
                source TEXT NOT NULL, award_count INTEGER, metadata TEXT NOT NULL,
                PRIMARY KEY(account_id, benefit_id)
            );
            CREATE TABLE IF NOT EXISTS claims (
                account_id TEXT NOT NULL, campaign_id TEXT NOT NULL, drop_id TEXT NOT NULL,
                recorded_at TEXT NOT NULL, game_id TEXT, game_name TEXT,
                campaign_name TEXT, drop_name TEXT, benefits TEXT NOT NULL,
                PRIMARY KEY(account_id, campaign_id, drop_id)
            );
            CREATE TABLE IF NOT EXISTS syncs (
                account_id TEXT PRIMARY KEY, synced_at TEXT NOT NULL
            );
            PRAGMA user_version=1;
        """)

    def _reward(self, account: str, benefit: str, *, name: str | None = None,
                image: str | None = None, game_id: str | None = None,
                game_name: str | None = None, awarded: str | None = None,
                count: int | None = None, source: str = "inventory") -> None:
        now = _now()
        # Store only whitelisted presentation metadata, never arbitrary API payloads.
        metadata = json.dumps({"id": benefit, "name": name, "imageURL": image,
                               "game": {"id": game_id, "name": game_name}})
        self.db.execute("""
            INSERT INTO rewards (account_id,benefit_id,name,image_url,game_id,game_name,
                last_awarded_at,observed_at,last_seen_at,source,award_count,metadata)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(account_id,benefit_id) DO UPDATE SET
                name=COALESCE(excluded.name,rewards.name),
                image_url=COALESCE(excluded.image_url,rewards.image_url),
                game_id=COALESCE(excluded.game_id,rewards.game_id),
                game_name=COALESCE(excluded.game_name,rewards.game_name),
                last_awarded_at=CASE WHEN rewards.last_awarded_at IS NULL
                    OR excluded.last_awarded_at > rewards.last_awarded_at
                    THEN excluded.last_awarded_at ELSE rewards.last_awarded_at END,
                last_seen_at=excluded.last_seen_at,
                source=CASE WHEN rewards.source=excluded.source THEN rewards.source ELSE 'both' END,
                award_count=CASE WHEN excluded.award_count IS NULL THEN rewards.award_count
                    WHEN rewards.award_count IS NULL THEN excluded.award_count
                    ELSE MAX(rewards.award_count,excluded.award_count) END,
                metadata=excluded.metadata
        """, (account, benefit, name, image, game_id, game_name, awarded, now, now,
              source, count, metadata))

    def ingest_inventory(self, user_id: str, game_event_drops: Any) -> None:
        if not user_id or not isinstance(game_event_drops, list):
            return
        with self.db:
            for row in game_event_drops:
                if not isinstance(row, dict):
                    continue
                benefit = row.get("benefit")
                benefit = benefit if isinstance(benefit, dict) else {}
                bid = _text(benefit.get("id") or row.get("id"))
                if not bid:
                    continue
                game = benefit.get("game") or row.get("game") or {}
                game = game if isinstance(game, dict) else {}
                count = row.get("totalCount")
                self._reward(str(user_id), bid,
                             name=_text(benefit.get("name") or row.get("name")),
                             image=_text(benefit.get("imageAssetURL") or row.get("imageURL")),
                             game_id=_text(game.get("id")),
                             game_name=_text(game.get("displayName") or game.get("name")),
                             awarded=_date(row.get("lastAwardedAt")),
                             count=count if type(count) is int and count >= 0 else None)
            self.db.execute("INSERT INTO syncs VALUES (?,?) ON CONFLICT(account_id) "
                            "DO UPDATE SET synced_at=excluded.synced_at", (str(user_id), _now()))

    def record_campaigns(self, user_id: str, campaigns: Any) -> None:
        if not user_id:
            return
        matches: dict[str, list[Any]] = {}
        for campaign in campaigns:
            for drop in campaign.drops:
                for benefit in drop.benefits:
                    matches.setdefault(str(benefit.id), []).append((campaign, drop, benefit))
        with self.db:
            for row in self.db.execute("SELECT * FROM rewards WHERE account_id=?", (str(user_id),)).fetchall():
                candidates = matches.get(row["benefit_id"], [])
                awarded = row["last_awarded_at"]
                candidates = [(c, d, b) for c, d, b in candidates if awarded
                              and d.starts_at <= datetime.fromisoformat(awarded) < d.ends_at]
                if len(candidates) != 1:
                    continue
                c, _, b = candidates[0]
                self.db.execute("""UPDATE rewards SET name=COALESCE(name,?),
                    image_url=COALESCE(image_url,?),game_id=COALESCE(game_id,?),
                    game_name=COALESCE(game_name,?),campaign_id=?,campaign_name=?
                    WHERE account_id=? AND benefit_id=?""",
                    (b.name, str(b.image_url), str(c.game.id), c.game.name,
                     c.id, c.name, str(user_id), row["benefit_id"]))

    def record_claim(self, user_id: str, drop: Any) -> None:
        if not user_id:
            return
        campaign = drop.campaign
        # A successful response can mean ALREADY_CLAIMED. This records observation
        # time only; the inventory remains authoritative for the original award date.
        now = _now()
        with self.db:
            inserted = self.db.execute("INSERT OR IGNORE INTO claims VALUES (?,?,?,?,?,?,?,?,?)",
                (str(user_id), campaign.id, drop.id, now, str(campaign.game.id),
                 campaign.game.name, campaign.name, drop.name,
                 json.dumps([str(b.id) for b in drop.benefits]))).rowcount
            if not inserted:
                return
            for b in drop.benefits:
                self._reward(str(user_id), str(b.id), name=b.name, image=str(b.image_url),
                             game_id=str(campaign.game.id), game_name=campaign.game.name,
                             source="local")
                self.db.execute("UPDATE rewards SET campaign_id=?,campaign_name=? "
                                "WHERE account_id=? AND benefit_id=?",
                                (campaign.id, campaign.name, str(user_id), str(b.id)))

    def query(self, user_id: str, game_id: str | None = None, search: str = "",
              offset: int = 0, limit: int = 50) -> dict[str, Any]:
        where = "account_id=?"
        values: list[Any] = [str(user_id)]
        if game_id == "unknown":
            where += " AND game_id IS NULL"
        elif game_id:
            where += " AND game_id=?"
            values.append(str(game_id))
        if search:
            where += " AND (instr(lower(COALESCE(name,'')),lower(?))>0 OR " \
                     "instr(lower(COALESCE(game_name,'')),lower(?))>0 OR " \
                     "instr(lower(COALESCE(campaign_name,'')),lower(?))>0)"
            values.extend([search, search, search])
        offset, limit = max(0, int(offset)), min(200, max(1, int(limit)))
        total = self.db.execute(f"SELECT COUNT(*) FROM rewards WHERE {where}", values).fetchone()[0]
        rows = self.db.execute(f"SELECT * FROM rewards WHERE {where} "
                               "ORDER BY last_awarded_at DESC,benefit_id LIMIT ? OFFSET ?",
                               [*values, limit, offset])
        items = [{"benefitId": r["benefit_id"], "name": r["name"] or "Unknown reward",
                  "imageUrl": r["image_url"], "gameId": r["game_id"],
                  "gameName": r["game_name"] or "Unknown game", "campaignId": r["campaign_id"],
                  "campaignName": r["campaign_name"], "lastAwardedAt": r["last_awarded_at"],
                  "observedAt": r["observed_at"], "source": r["source"],
                  "awardCount": r["award_count"]} for r in rows]
        return {"items": items, "total": total, "offset": offset, "limit": limit}

    def summary(self, user_id: str) -> dict[str, Any]:
        account = (str(user_id),)
        count, first = self.db.execute("SELECT COUNT(*),MIN(observed_at) FROM rewards "
                                      "WHERE account_id=?", account).fetchone()
        games = [{"id": r[0], "name": r[1] or "Unknown game", "rewardCount": r[2]}
                 for r in self.db.execute("SELECT game_id,MAX(game_name),COUNT(*) FROM rewards "
                                          "WHERE account_id=? GROUP BY game_id ORDER BY 2", account)]
        local_by_game = {r[0]: r[1] for r in self.db.execute(
            "SELECT game_id,COUNT(*) FROM claims WHERE account_id=? GROUP BY game_id", account)}
        for game in games:
            game["localClaimCount"] = local_by_game.get(game["id"], 0)
        today = datetime.now(timezone.utc).date()
        start = today - timedelta(days=29)
        recorded_by_day = {r[0]: r[1] for r in self.db.execute(
            "SELECT substr(recorded_at,1,10),COUNT(*) FROM claims WHERE account_id=? "
            "AND recorded_at>=? AND recorded_at<? GROUP BY 1",
            (*account, start.isoformat(), (today + timedelta(days=1)).isoformat()))}
        daily = [{"date": (start + timedelta(days=i)).isoformat(),
                  "count": recorded_by_day.get((start + timedelta(days=i)).isoformat(), 0)}
                 for i in range(30)]
        sync = self.db.execute("SELECT synced_at FROM syncs WHERE account_id=?", account).fetchone()
        return {"rewardCount": count, "localClaimCount": self.db.execute(
                    "SELECT COUNT(*) FROM claims WHERE account_id=?", account).fetchone()[0],
                "gameCount": sum(g["id"] is not None for g in games), "games": games,
                "firstObservedAt": first, "lastSyncedAt": sync[0] if sync else None,
                "coverage": COVERAGE, "dailyClaims": daily}

    def close(self) -> None:
        self.db.close()
