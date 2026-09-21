/**
 * Port of `history.py`: account-scoped reward snapshots plus locally
 * observed claim events, stored in SQLite via `bun:sqlite`.
 *
 * The schema, SQL, and stored string formats are identical to Python, so a
 * `history.sqlite3` written by either runtime opens in the other (verified
 * by the cross-read test in `history.test.ts`). Timestamps are stored with
 * a `+00:00` suffix exactly like Python's `isoformat()`.
 *
 * Engine objects (`campaigns`, `drops`) are accepted as minimal structural
 * interfaces; phase 2 of the port replaces these with the real classes.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** SQLite bindings used across this module (mirrors Python's str/int/None). */
type Bindings = Array<string | number | null>;

export const HISTORY_COVERAGE =
  "Available Twitch inventory plus claims recorded by this installation; " +
  "older missing awards cannot be recovered.";

export class HistoryDatabaseError extends Error {}

export interface HistoryGame {
  id: number | string;
  name: string;
}

export interface HistoryBenefit {
  id: number | string;
  name: string;
  imageUrl: unknown;
}

export interface HistoryDrop {
  id: string;
  name: string;
  campaign: HistoryCampaign;
  benefits: HistoryBenefit[];
  startsAt: Date;
  endsAt: Date;
}

export interface HistoryCampaign {
  id: string;
  name: string;
  game: HistoryGame;
  drops: HistoryDrop[];
}

export interface HistoryItem {
  benefitId: string;
  name: string;
  imageUrl: string | null;
  gameId: string | null;
  gameName: string;
  campaignId: string | null;
  campaignName: string | null;
  lastAwardedAt: string | null;
  observedAt: string;
  source: string;
  awardCount: number | null;
}

export interface HistoryQueryResult {
  items: HistoryItem[];
  total: number;
  offset: number;
  limit: number;
}

export interface HistorySummaryGame {
  id: string | null;
  name: string;
  rewardCount: number;
  localClaimCount: number;
}

export interface HistorySummary {
  rewardCount: number;
  localClaimCount: number;
  gameCount: number;
  games: HistorySummaryGame[];
  firstObservedAt: string | null;
  lastSyncedAt: string | null;
  coverage: string;
  dailyClaims: Array<{ date: string; count: number }>;
}

/** Format like Python's `datetime.isoformat()`: no millis when zero. */
function pythonIso(timeMs: number): string {
  const date = new Date(timeMs);
  const base = date.toISOString().slice(0, 19);
  const millis = date.getUTCMilliseconds();
  const fraction = millis === 0 ? "" : `.${String(millis).padStart(3, "0")}`;
  return `${base}${fraction}+00:00`;
}

function nowIso(): string {
  return pythonIso(Date.now());
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && !Number.isNaN(value)) return String(value);
  return null;
}

/** Parse an ISO timestamp; naive strings (no tz designator) return null. */
function asDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(value.trim())) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return pythonIso(time);
}

const EXPECTED_COLUMNS: Record<string, Set<string>> = {
  rewards: new Set([
    "account_id", "benefit_id", "name", "image_url", "game_id", "game_name",
    "campaign_id", "campaign_name", "last_awarded_at", "observed_at",
    "last_seen_at", "source", "award_count", "metadata",
  ]),
  claims: new Set([
    "account_id", "campaign_id", "drop_id", "recorded_at", "game_id",
    "game_name", "campaign_name", "drop_name", "benefits",
  ]),
  syncs: new Set(["account_id", "synced_at"]),
};

export class History {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    try {
      this.validate(db);
    } catch (error) {
      db.close();
      throw error;
    }
    db.run(`CREATE TABLE IF NOT EXISTS rewards (
        account_id TEXT NOT NULL, benefit_id TEXT NOT NULL,
        name TEXT, image_url TEXT, game_id TEXT, game_name TEXT,
        campaign_id TEXT, campaign_name TEXT, last_awarded_at TEXT,
        observed_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        source TEXT NOT NULL, award_count INTEGER, metadata TEXT NOT NULL,
        PRIMARY KEY(account_id, benefit_id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS claims (
        account_id TEXT NOT NULL, campaign_id TEXT NOT NULL, drop_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL, game_id TEXT, game_name TEXT,
        campaign_name TEXT, drop_name TEXT, benefits TEXT NOT NULL,
        PRIMARY KEY(account_id, campaign_id, drop_id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS syncs (
        account_id TEXT PRIMARY KEY, synced_at TEXT NOT NULL
    )`);
    db.run("PRAGMA user_version=1");
    this.db = db;
  }

  private validate(db: Database): void {
    const versionRow = db.query("PRAGMA user_version").get() as { user_version?: unknown } | null;
    const version = typeof versionRow?.["user_version"] === "number" ? (versionRow["user_version"] as number) : 0;
    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (version > 1) throw new HistoryDatabaseError("History database was created by a newer version");
    if (tables.size > 0) {
      let valid = tables.size === Object.keys(EXPECTED_COLUMNS).length &&
        [...tables].every((t) => t in EXPECTED_COLUMNS);
      for (const table of tables) {
        const expected = EXPECTED_COLUMNS[table];
        if (!expected) {
          valid = false;
          continue;
        }
        const actual = new Set(
          (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
        );
        if (table === "claims" && version === 0 && actual.has("claimed_at")) {
          actual.delete("claimed_at");
          actual.add("recorded_at");
          db.run("ALTER TABLE claims RENAME COLUMN claimed_at TO recorded_at");
        }
        if (actual.size !== expected.size || ![...actual].every((c) => expected.has(c))) valid = false;
      }
      if (!valid) throw new HistoryDatabaseError("Unrecognized history database schema");
    } else if (version !== 0) {
      throw new HistoryDatabaseError("History database schema is missing");
    }
  }

  private reward(
    account: string,
    benefit: string,
    options: {
      name?: string | null;
      image?: string | null;
      gameId?: string | null;
      gameName?: string | null;
      awarded?: string | null;
      count?: number | null;
      source?: string;
    } = {},
  ): void {
    const { name = null, image = null, gameId = null, gameName = null, awarded = null, count = null, source = "inventory" } = options;
    const stamp = nowIso();
    const metadata = JSON.stringify({ id: benefit, name, imageURL: image, game: { id: gameId, name: gameName } });
    const params: Bindings = [account, benefit, name, image, gameId, gameName, awarded, stamp, stamp, source, count, metadata];
    this.db.query(`INSERT INTO rewards (account_id,benefit_id,name,image_url,game_id,game_name,
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
          metadata=excluded.metadata`,
    ).run(...params);
  }

  ingestInventory(userId: string, gameEventDrops: unknown): void {
    if (!userId || !Array.isArray(gameEventDrops)) return;
    const run = this.db.transaction(() => {
      for (const row of gameEventDrops) {
        if (typeof row !== "object" || row === null) continue;
        const record = row as Record<string, unknown>;
        const rawBenefit = record["benefit"];
        const benefit = (typeof rawBenefit === "object" && rawBenefit !== null ? rawBenefit : {}) as Record<string, unknown>;
        const bid = asText(benefit["id"] ?? record["id"]);
        if (!bid) continue;
        const rawGame = benefit["game"] ?? record["game"];
        const game = (typeof rawGame === "object" && rawGame !== null ? rawGame : {}) as Record<string, unknown>;
        const totalCount = record["totalCount"];
        this.reward(String(userId), bid, {
          name: asText(benefit["name"] ?? record["name"]),
          image: asText(benefit["imageAssetURL"] ?? record["imageURL"]),
          gameId: asText(game["id"]),
          gameName: asText(game["displayName"] ?? game["name"]),
          awarded: asDate(record["lastAwardedAt"]),
          count: typeof totalCount === "number" && Number.isInteger(totalCount) && totalCount >= 0 ? totalCount : null,
        });
      }
      this.db.query("INSERT INTO syncs VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET synced_at=excluded.synced_at").run(
        String(userId),
        nowIso(),
      );
    });
    run();
  }

  recordCampaigns(userId: string, campaigns: Array<{ drops?: HistoryDrop[] }>): void {
    if (!userId) return;
    const matches = new Map<string, Array<{ campaign: HistoryCampaign; drop: HistoryDrop; benefit: HistoryBenefit }>>();
    for (const campaign of campaigns as HistoryCampaign[]) {
      for (const drop of campaign.drops ?? []) {
        for (const benefit of drop.benefits ?? []) {
          const list = matches.get(String(benefit.id)) ?? [];
          list.push({ campaign, drop, benefit });
          matches.set(String(benefit.id), list);
        }
      }
    }
    const run = this.db.transaction(() => {
      const rows = this.db.query("SELECT * FROM rewards WHERE account_id=?").all(String(userId)) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const candidates = matches.get(String(row["benefit_id"])) ?? [];
        const awarded = row["last_awarded_at"];
        const awardedTime = typeof awarded === "string" ? new Date(awarded).getTime() : NaN;
        const inWindow = candidates.filter(
          ({ drop }) =>
            !Number.isNaN(awardedTime) &&
            drop.startsAt.getTime() <= awardedTime &&
            awardedTime < drop.endsAt.getTime(),
        );
        if (inWindow.length !== 1) continue;
        const match = inWindow[0]!;
        const params: Bindings = [
          match.benefit.name,
          String(match.benefit.imageUrl),
          String(match.campaign.game.id),
          match.campaign.game.name,
          match.campaign.id,
          match.campaign.name,
          String(userId),
          String(row["benefit_id"]),
        ];
        this.db.query(
          `UPDATE rewards SET name=COALESCE(name,?),image_url=COALESCE(image_url,?),
           game_id=COALESCE(game_id,?),game_name=COALESCE(game_name,?),
           campaign_id=?,campaign_name=? WHERE account_id=? AND benefit_id=?`,
        ).run(...params);
      }
    });
    run();
  }

  recordClaim(userId: string, drop: HistoryDrop): void {
    if (!userId) return;
    const campaign = drop.campaign;
    const stamp = nowIso();
    const run = this.db.transaction(() => {
      const claimParams: Bindings = [
        String(userId),
        campaign.id,
        drop.id,
        stamp,
        String(campaign.game.id),
        campaign.game.name,
        campaign.name,
        drop.name,
        JSON.stringify(drop.benefits.map((b) => String(b.id))),
      ];
      const inserted = this.db.query("INSERT OR IGNORE INTO claims VALUES (?,?,?,?,?,?,?,?,?)").run(...claimParams);
      if (Number(inserted.changes) === 0) return;
      for (const benefit of drop.benefits) {
        this.reward(String(userId), String(benefit.id), {
          name: benefit.name,
          image: String(benefit.imageUrl),
          gameId: String(campaign.game.id),
          gameName: campaign.game.name,
          source: "local",
        });
        this.db.query("UPDATE rewards SET campaign_id=?,campaign_name=? WHERE account_id=? AND benefit_id=?").run(
          campaign.id,
          campaign.name,
          String(userId),
          String(benefit.id),
        );
      }
    });
    run();
  }

  query(userId: string, gameId?: string | null, search = "", offset = 0, limit = 50): HistoryQueryResult {
    let where = "account_id=?";
    const values: Bindings = [String(userId)];
    if (gameId === "unknown") {
      where += " AND game_id IS NULL";
    } else if (gameId) {
      where += " AND game_id=?";
      values.push(String(gameId));
    }
    if (search) {
      where += " AND (instr(lower(COALESCE(name,'')),lower(?))>0 OR " +
        "instr(lower(COALESCE(game_name,'')),lower(?))>0 OR " +
        "instr(lower(COALESCE(campaign_name,'')),lower(?))>0)";
      values.push(search, search, search);
    }
    const safeOffset = Math.max(0, Math.trunc(offset));
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
    const totalRow = this.db.query<{ n: number }, Bindings>(`SELECT COUNT(*) AS n FROM rewards WHERE ${where}`).get(...values) as {
      n: number;
    };
    const rows = this.db.query<Record<string, unknown>, Bindings>(
      `SELECT * FROM rewards WHERE ${where} ORDER BY last_awarded_at DESC,benefit_id LIMIT ? OFFSET ?`,
    ).all(...values, safeLimit, safeOffset);
    return {
      items: rows.map((row) => ({
        benefitId: String(row["benefit_id"]),
        name: (row["name"] as string) || "Unknown reward",
        imageUrl: (row["image_url"] as string) ?? null,
        gameId: (row["game_id"] as string) ?? null,
        gameName: (row["game_name"] as string) || "Unknown game",
        campaignId: (row["campaign_id"] as string) ?? null,
        campaignName: (row["campaign_name"] as string) ?? null,
        lastAwardedAt: (row["last_awarded_at"] as string) ?? null,
        observedAt: String(row["observed_at"]),
        source: String(row["source"]),
        awardCount: (row["award_count"] as number) ?? null,
      })),
      total: Number(totalRow.n),
      offset: safeOffset,
      limit: safeLimit,
    };
  }

  summary(userId: string): HistorySummary {
    const account = String(userId);
    const countRow = this.db.query("SELECT COUNT(*) AS n,MIN(observed_at) AS first FROM rewards WHERE account_id=?").get(account) as {
      n: number;
      first: string | null;
    };
    const games = (
      this.db.query("SELECT game_id AS id,MAX(game_name) AS name,COUNT(*) AS n FROM rewards WHERE account_id=? GROUP BY game_id ORDER BY 2").all(account) as Array<{
        id: string | null;
        name: string | null;
        n: number;
      }>
    ).map((row) => ({
      id: row.id,
      name: row.name || "Unknown game",
      rewardCount: Number(row.n),
      localClaimCount: 0,
    }));
    const localByGame = this.db.query("SELECT game_id AS id,COUNT(*) AS n FROM claims WHERE account_id=? GROUP BY game_id").all(account) as Array<{
      id: string | null;
      n: number;
    }>;
    for (const row of localByGame) {
      const game = games.find((g) => g.id === row.id);
      if (game) game.localClaimCount = Number(row.n);
    }
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const start = new Date(today.getTime() - 29 * 86400 * 1000);
    const tomorrow = new Date(today.getTime() + 86400 * 1000);
    const recorded = this.db.query(
      "SELECT substr(recorded_at,1,10) AS day,COUNT(*) AS n FROM claims WHERE account_id=? AND recorded_at>=? AND recorded_at<? GROUP BY 1",
    ).all(account, start.toISOString(), tomorrow.toISOString()) as Array<{ day: string; n: number }>;
    const byDay = new Map(recorded.map((row) => [row.day, Number(row.n)]));
    const daily = Array.from({ length: 30 }, (_, i) => {
      const date = new Date(start.getTime() + i * 86400 * 1000).toISOString().slice(0, 10);
      return { date, count: byDay.get(date) ?? 0 };
    });
    const sync = this.db.query("SELECT synced_at FROM syncs WHERE account_id=?").get(account) as { synced_at: string } | null;
    const localCount = this.db.query("SELECT COUNT(*) AS n FROM claims WHERE account_id=?").get(account) as { n: number };
    return {
      rewardCount: Number(countRow.n),
      localClaimCount: Number(localCount.n),
      gameCount: games.filter((g) => g.id !== null).length,
      games,
      firstObservedAt: countRow.first,
      lastSyncedAt: sync ? sync.synced_at : null,
      coverage: HISTORY_COVERAGE,
      dailyClaims: daily,
    };
  }

  close(): void {
    this.db.close();
  }
}
