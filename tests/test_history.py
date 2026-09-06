import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from history import History


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "history.sqlite3"
        self.history = History(self.path)

    def tearDown(self):
        self.history.close()
        self.directory.cleanup()

    def test_inventory_is_idempotent_persistent_and_account_scoped(self):
        reward = {"id": "reward", "name": "Hat", "lastAwardedAt": "2024-01-01T00:00:00Z",
                  "totalCount": 3, "game": {"id": "game", "name": "Example"},
                  "accessToken": "not stored"}
        self.history.ingest_inventory("a", [reward, reward])
        first = self.history.query("a")["items"][0]
        self.history.ingest_inventory("a", [])
        self.assertEqual(self.history.query("a")["total"], 1)
        self.assertEqual(self.history.query("b")["total"], 0)
        self.assertEqual(first["awardCount"], 3)
        self.assertNotEqual(first["observedAt"], first["lastAwardedAt"])
        self.assertNotIn("not stored", self.history.db.execute("SELECT metadata FROM rewards").fetchone()[0])
        self.history.close()
        self.history = History(self.path)
        self.assertEqual(self.history.query("a")["items"][0]["observedAt"], first["observedAt"])

    def test_tolerates_missing_metadata_and_literal_search(self):
        self.history.ingest_inventory("a", [None, {}, {"id": "1", "lastAwardedAt": "invalid"},
                                              {"benefit": {"id": "2", "name": "100%"}}])
        self.assertEqual(self.history.query("a", game_id="unknown")["total"], 2)
        item = self.history.query("a", search="%")["items"][0]
        self.assertEqual(item["benefitId"], "2")
        self.assertIsNone(item["lastAwardedAt"])
        self.assertEqual(self.history.query("a", offset=1, limit=1)["total"], 2)
        self.assertEqual(self.history.summary("a")["gameCount"], 0)

    def test_claim_and_inventory_do_not_double_count_rewards(self):
        campaign = SimpleNamespace(id="c", name="Campaign", game=SimpleNamespace(id="g", name="Game"))
        benefit = SimpleNamespace(id="b", name="Reward", image_url="https://example.test/a.png")
        drop = SimpleNamespace(id="d", name="Drop", campaign=campaign, benefits=[benefit])
        self.history.record_claim("a", drop)
        first = self.history.query("a")["items"][0]["lastAwardedAt"]
        self.assertIsNone(first)
        self.history.record_claim("a", drop)
        self.history.ingest_inventory("a", [{"id": "b", "lastAwardedAt": first}])
        self.assertEqual(self.history.summary("a")["localClaimCount"], 1)
        self.assertEqual(self.history.summary("a")["rewardCount"], 1)
        self.assertEqual(self.history.query("a")["items"][0]["source"], "both")
        self.assertEqual(self.history.query("a", game_id="g")["total"], 1)
        self.assertEqual(self.history.query("a", search="Campaign")["total"], 1)
        summary = self.history.summary("a")
        self.assertEqual(summary["games"][0]["localClaimCount"], 1)
        self.assertEqual(len(summary["dailyClaims"]), 30)
        self.assertEqual(summary["dailyClaims"][-1]["count"], 1)
        self.assertEqual(sum(d["count"] for d in self.history.summary("b")["dailyClaims"]), 0)
        confirmed = "2024-01-01T00:00:00+00:00"
        self.history.ingest_inventory("a", [{"id": "b", "lastAwardedAt": confirmed}])
        drop.id = "second-drop"
        self.history.record_claim("a", drop)
        self.assertEqual(self.history.query("a")["items"][0]["lastAwardedAt"], confirmed)
        old = (datetime.now(timezone.utc) - timedelta(days=35)).isoformat()
        self.history.db.execute("UPDATE claims SET recorded_at=? WHERE drop_id=?", (old, drop.id))
        self.assertEqual(sum(d["count"] for d in self.history.summary("a")["dailyClaims"]), 1)

    def test_future_and_foreign_schemas_rejected_without_writes(self):
        self.assertEqual(self.history.db.execute("PRAGMA user_version").fetchone()[0], 1)
        future = Path(self.directory.name) / "future.sqlite3"
        db = sqlite3.connect(future)
        db.execute("PRAGMA user_version=2")
        db.close()
        before = future.read_bytes()
        with self.assertRaises(sqlite3.DatabaseError):
            History(future)
        self.assertEqual(future.read_bytes(), before)
        foreign = Path(self.directory.name) / "foreign.sqlite3"
        db = sqlite3.connect(foreign)
        db.execute("CREATE TABLE unrelated (value TEXT)")
        db.close()
        before = foreign.read_bytes()
        with self.assertRaises(sqlite3.DatabaseError):
            History(foreign)
        self.assertEqual(foreign.read_bytes(), before)

    def test_initial_unversioned_schema_migrates_without_losing_data(self):
        self.history.ingest_inventory("a", [{"id": "b"}])
        self.history.db.execute("ALTER TABLE claims RENAME COLUMN recorded_at TO claimed_at")
        self.history.db.execute("PRAGMA user_version=0")
        self.history.close()
        self.history = History(self.path)
        self.assertEqual(self.history.query("a")["total"], 1)
        self.assertEqual(self.history.db.execute("PRAGMA user_version").fetchone()[0], 1)

    def test_enrichment_requires_unambiguous_matching_award_window(self):
        benefit = SimpleNamespace(id="b", name="Reward", image_url="url")
        drop = SimpleNamespace(benefits=[benefit], starts_at=datetime(2024, 1, 1, tzinfo=timezone.utc),
                               ends_at=datetime(2024, 2, 1, tzinfo=timezone.utc))
        campaign = SimpleNamespace(id="c", name="Campaign", game=SimpleNamespace(id="g", name="Game"), drops=[drop])
        self.history.ingest_inventory("a", [{"id": "b", "lastAwardedAt": "2024-01-02T00:00:00Z"}])
        self.history.record_campaigns("a", [campaign, campaign])
        self.assertIsNone(self.history.query("a")["items"][0]["gameId"])
        self.history.record_campaigns("a", [campaign])
        self.assertEqual(self.history.query("a")["items"][0]["campaignId"], "c")


if __name__ == "__main__":
    unittest.main()
