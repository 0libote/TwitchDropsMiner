/**
 * Tests for `src/history.ts`, mirroring `tests/test_history.py`.
 * A separate `bun:sqlite` connection stands in for Python's direct
 * `self.history.db.execute` access in the legacy/backdate tests.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { History, HistoryDatabaseError, type HistoryCampaign, type HistoryDrop } from "./history.ts";

let dir = "";
let history: History | null = null;

function freshHistory(): History {
  dir = mkdtempSync(join(tmpdir(), "tdm-history-"));
  history = new History(join(dir, "history.sqlite3"));
  return history;
}

/** Swap the module-level handle (for afterEach) and return it typed. */
function replaceHistory(next: History): History {
  history = next;
  return next;
}

function dbPath(): string {
  return join(dir, "history.sqlite3");
}

afterEach(() => {
  history?.close();
  history = null;
});

function benefit(id: string) {
  return { id, name: "Reward", imageUrl: "https://example.test/a.png" };
}

function campaign(): HistoryCampaign {
  const game = { id: "g", name: "Game" };
  const campaign: HistoryCampaign = { id: "c", name: "Campaign", game, drops: [] };
  const drop: HistoryDrop = {
    id: "d",
    name: "Drop",
    campaign,
    benefits: [benefit("b")],
    startsAt: new Date("2024-01-01T00:00:00Z"),
    endsAt: new Date("2024-02-01T00:00:00Z"),
  };
  campaign.drops = [drop];
  return campaign;
}

describe("History", () => {
  test("inventory is idempotent, persistent and account-scoped", () => {
    const history = freshHistory();
    const reward = {
      id: "reward",
      name: "Hat",
      lastAwardedAt: "2024-01-01T00:00:00Z",
      totalCount: 3,
      game: { id: "game", name: "Example" },
      accessToken: "not stored",
    };
    history.ingestInventory("a", [reward, reward]);
    const first = history.query("a").items[0]!;
    history.ingestInventory("a", []);
    expect(history.query("a").total).toBe(1);
    expect(history.query("b").total).toBe(0);
    expect(first.awardCount).toBe(3);
    expect(first.observedAt).not.toBe(first.lastAwardedAt);
    const admin = new Database(dbPath());
    const metadata = admin.query("SELECT metadata FROM rewards").get() as { metadata: string };
    admin.close();
    expect(metadata.metadata).not.toContain("not stored");
    const observedAt = first.observedAt;
    history.close();
    const reopened = replaceHistory(new History(dbPath()));
    expect(reopened.query("a").items[0]!.observedAt).toBe(observedAt);
  });

  test("tolerates missing metadata and treats search literally", () => {
    const history = freshHistory();
    history.ingestInventory("a", [null, {}, { id: "1", lastAwardedAt: "invalid" }, { benefit: { id: "2", name: "100%" } }]);
    expect(history.query("a", "unknown").total).toBe(2);
    const item = history.query("a", null, "%").items[0]!;
    expect(item.benefitId).toBe("2");
    expect(item.lastAwardedAt).toBeNull();
    expect(history.query("a", null, "", 1, 1).total).toBe(2);
    expect(history.summary("a").gameCount).toBe(0);
  });

  test("claims and inventory do not double-count rewards", () => {
    const history = freshHistory();
    const mined = campaign();
    const drop = { ...mined.drops[0]!, id: "d" };
    history.recordClaim("a", drop);
    const first = history.query("a").items[0]!.lastAwardedAt;
    expect(first).toBeNull();
    history.recordClaim("a", drop);
    history.ingestInventory("a", [{ id: "b", lastAwardedAt: first }]);
    expect(history.summary("a").localClaimCount).toBe(1);
    expect(history.summary("a").rewardCount).toBe(1);
    expect(history.query("a").items[0]!.source).toBe("both");
    expect(history.query("a", "g").total).toBe(1);
    expect(history.query("a", null, "Campaign").total).toBe(1);
    const summary = history.summary("a");
    expect(summary.games[0]!.localClaimCount).toBe(1);
    expect(summary.dailyClaims).toHaveLength(30);
    expect(summary.dailyClaims.at(-1)!.count).toBe(1);
    expect(history.summary("b").dailyClaims.reduce((sum, day) => sum + day.count, 0)).toBe(0);
    const confirmed = "2024-01-01T00:00:00+00:00";
    history.ingestInventory("a", [{ id: "b", lastAwardedAt: confirmed }]);
    drop.id = "second-drop";
    history.recordClaim("a", drop);
    expect(history.query("a").items[0]!.lastAwardedAt).toBe(confirmed);
    const old = new Date(Date.now() - 35 * 86400 * 1000).toISOString();
    const admin = new Database(dbPath());
    admin.query("UPDATE claims SET recorded_at=? WHERE drop_id=?").run(old, drop.id);
    admin.close();
    expect(history.summary("a").dailyClaims.reduce((sum, day) => sum + day.count, 0)).toBe(1);
  });

  test("future and foreign schemas are rejected without writes", () => {
    freshHistory();
    const admin = new Database(dbPath());
    const versionRow = admin.query("PRAGMA user_version").get() as { user_version: number };
    admin.close();
    expect(versionRow.user_version).toBe(1);
    const future = join(dir, "future.sqlite3");
    const futureSetup = new Database(future);
    futureSetup.run("PRAGMA user_version=2");
    futureSetup.close();
    const beforeFuture = readFileSync(future);
    expect(() => new History(future)).toThrow(HistoryDatabaseError);
    expect(readFileSync(future).equals(beforeFuture)).toBe(true);
    const foreign = join(dir, "foreign.sqlite3");
    const foreignSetup = new Database(foreign);
    foreignSetup.run("CREATE TABLE unrelated (value TEXT)");
    foreignSetup.close();
    const beforeForeign = readFileSync(foreign);
    expect(() => new History(foreign)).toThrow(HistoryDatabaseError);
    expect(readFileSync(foreign).equals(beforeForeign)).toBe(true);
  });

  test("unversioned legacy schema migrates without losing data", () => {
    const history = freshHistory();
    history.ingestInventory("a", [{ id: "b" }]);
    const admin = new Database(dbPath());
    admin.run("ALTER TABLE claims RENAME COLUMN recorded_at TO claimed_at");
    admin.run("PRAGMA user_version=0");
    admin.close();
    history.close();
    const migratedBack = replaceHistory(new History(dbPath()));
    expect(migratedBack.query("a").total).toBe(1);
    const migrated = new Database(dbPath());
    const versionRow = migrated.query("PRAGMA user_version").get() as { user_version: number };
    migrated.close();
    expect(versionRow.user_version).toBe(1);
  });

  test("enrichment requires an unambiguous in-window match", () => {
    const history = freshHistory();
    const enriched = campaign();
    history.ingestInventory("a", [{ id: "b", lastAwardedAt: "2024-01-02T00:00:00Z" }]);
    history.recordCampaigns("a", [enriched, enriched]);
    expect(history.query("a").items[0]!.gameId).toBeNull();
    history.recordCampaigns("a", [enriched]);
    expect(history.query("a").items[0]!.campaignId).toBe("c");
  });

  test("reads a database written by the Python implementation", () => {
    // Fixture generated with history.py: one ingested reward for account "7".
    // Copied to tmp first: opening it runs CREATE TABLE IF NOT EXISTS plus
    // PRAGMA user_version, which must not dirty the committed fixture.
    dir = mkdtempSync(join(tmpdir(), "tdm-history-"));
    const copy = join(dir, "history.sqlite3");
    writeFileSync(copy, readFileSync("tests/fixtures/history-python.sqlite3"));
    const ported = new History(copy);
    const result = ported.query("7");
    expect(result.total).toBe(1);
    const item = result.items[0]!;
    expect(item.benefitId).toBe("py-reward-1");
    expect(item.name).toBe("Python Hat");
    expect(item.gameName).toBe("Example");
    expect(item.source).toBe("inventory");
    expect(ported.summary("7").rewardCount).toBe(1);
    ported.close();
  });
});
