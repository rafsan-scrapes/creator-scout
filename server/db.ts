import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Local SQLite file — gitignored via `data/` in .gitignore.
// Deleting the file resets dedup history and quota counters; no migration
// beyond the Phase 8 step 1 one-time channels simplification below.
const DB_PATH = path.resolve(process.cwd(), "data/scout.db");

let _db: Database.Database | null = null;

function pacificDateString(date = new Date()): string {
  // YouTube quota resets at midnight Pacific. Use America/Los_Angeles.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// Phase 8 step 1 — identity-only exclusion-list schema. Metrics
// (subscriber_count, avg_views, engagement_rate_pct, last_upload_date,
// days_since_last_upload, qualified) were only ever needed for a single
// run's ephemeral Results table, never for exclusion matching.
const CHANNELS_DDL = `
  CREATE TABLE IF NOT EXISTS channels (
    channel_id TEXT PRIMARY KEY,
    channel_url TEXT NOT NULL,
    channel_name TEXT,
    source TEXT NOT NULL CHECK (source IN ('search', 'manual')),
    matched_keyword TEXT CHECK (matched_keyword IS NULL OR source = 'search'),
    added_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_channels_matched_keyword ON channels(matched_keyword);
`;

const API_KEY_USAGE_DDL = `
  CREATE TABLE IF NOT EXISTS api_key_usage (
    key_label TEXT NOT NULL,
    date TEXT NOT NULL,
    units_used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key_label, date)
  );
`;

function columnNames(db: Database.Database, table: string): string[] {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as unknown;
  return Boolean(row);
}

// One-time migration for the 24 real rows found in data/scout.db on
// 2026-09-10 (Phase 7 step 4 live run). Old table had per-run metrics +
// first_seen_at; new table keeps identity only with source = 'search'.
function migrateChannelsIfNeeded(db: Database.Database): void {
  if (!tableExists(db, "channels")) {
    db.exec(CHANNELS_DDL);
    return;
  }
  const cols = columnNames(db, "channels");
  const isNew = cols.includes("source") && cols.includes("added_at");
  const isOld = cols.includes("qualified") || cols.includes("subscriber_count") || cols.includes("first_seen_at");
  if (isNew && !isOld) {
    // Already on the new schema — just ensure index exists.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_channels_matched_keyword ON channels(matched_keyword);`);
    return;
  }
  if (!isOld) {
    // Unknown shape — don't silently drop; recreate only if empty.
    const count = (db.prepare("SELECT count(*) AS n FROM channels").get() as { n: number }).n;
    if (count > 0) {
      throw new Error(
        `channels table has unexpected columns (${cols.join(",")}) with ${count} rows — refusing to migrate automatically`,
      );
    }
    db.exec(`DROP TABLE channels;`);
    db.exec(CHANNELS_DDL);
    return;
  }
  // Old schema -> new schema, preserving history.
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS channels_new (
        channel_id TEXT PRIMARY KEY,
        channel_url TEXT NOT NULL,
        channel_name TEXT,
        source TEXT NOT NULL CHECK (source IN ('search', 'manual')),
        matched_keyword TEXT CHECK (matched_keyword IS NULL OR source = 'search'),
        added_at TEXT NOT NULL
      );
    `);
    db.exec(`
      INSERT OR IGNORE INTO channels_new
        (channel_id, channel_url, channel_name, source, matched_keyword, added_at)
      SELECT
        channel_id, channel_url, channel_name, 'search', matched_keyword, first_seen_at
      FROM channels;
    `);
    db.exec(`DROP TABLE channels;`);
    db.exec(`ALTER TABLE channels_new RENAME TO channels;`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_channels_matched_keyword ON channels(matched_keyword);`);
  });
  migrate();
}

function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  // WAL is better for concurrent reads; safe for this single-process local app.
  db.pragma("journal_mode = WAL");
  migrateChannelsIfNeeded(db);
  db.exec(API_KEY_USAGE_DDL);
  _db = db;
  return db;
}

// For tests / throwaway scripts that need an isolated in-memory DB.
// Always creates the new minimal schema — no migration needed.
export function getDbForTesting(dbPath = ":memory:"): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(CHANNELS_DDL);
  db.exec(API_KEY_USAGE_DDL);
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// Phase 8 step 1 — minimal exclusion-list record. channel_name is
// best-effort nullable; matched_keyword is only ever set when
// source = 'search' (enforced by CHECK above).
export type ChannelSource = "search" | "manual";

export interface ChannelHistoryRecord {
  channel_id: string;
  channel_url: string;
  channel_name: string | null;
  source: ChannelSource;
  matched_keyword: string | null;
  added_at: string;
}

// Legacy pipeline record (pre-Phase-8 full metrics). Kept so
// server/youtube.ts call sites keep compiling until Phase 8 step 2
// replaces them with recordSearchChannel — recordChannel() below
// accepts this shape but persists only the minimal columns.
export interface ChannelRecord {
  channel_id: string;
  channel_name: string;
  channel_url: string;
  subscriber_count: number | null;
  avg_views: number | null;
  engagement_rate_pct: number | null;
  last_upload_date: string | null;
  days_since_last_upload: number | null;
  matched_keyword: string;
  qualified: boolean;
  first_seen_at: string;
}

// Test-only overrides so pipeline tests can stub dedup without touching the real DB file.
// ESM namespace imports are read-only, so monkey-patching `import * as db` does not work.
export const __testOverrides: {
  isChannelKnown?: (channelId: string) => boolean;
  recordChannel?: (record: ChannelRecord) => void;
} = {};

export function isChannelKnown(channelId: string): boolean {
  if (__testOverrides.isChannelKnown) return __testOverrides.isChannelKnown(channelId);
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM channels WHERE channel_id = ?").get(channelId) as unknown;
  return Boolean(row);
}

// Writes source = 'search' with the minimal columns. Extra metric
// fields on the legacy ChannelRecord input are intentionally ignored —
// they only ever described a single run's ephemeral Results table.
// Upsert preserves the original added_at on conflict.
export function recordChannel(record: ChannelRecord): void {
  if (__testOverrides.recordChannel) return __testOverrides.recordChannel(record);
  const db = getDb();
  db.prepare(
    `INSERT INTO channels (
      channel_id, channel_url, channel_name, source, matched_keyword, added_at
    ) VALUES (
      @channel_id, @channel_url, @channel_name, 'search', @matched_keyword, @added_at
    )
    ON CONFLICT(channel_id) DO UPDATE SET
      channel_url = excluded.channel_url,
      channel_name = excluded.channel_name,
      matched_keyword = excluded.matched_keyword
    `,
  ).run({
    channel_id: record.channel_id,
    channel_url: record.channel_url,
    channel_name: record.channel_name ?? null,
    matched_keyword: record.matched_keyword ?? null,
    added_at: record.first_seen_at,
  });
}

export function getChannel(channelId: string): ChannelHistoryRecord | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM channels WHERE channel_id = ?")
    .get(channelId) as ChannelHistoryRecord | undefined;
  return row;
}

export function getUsageToday(keyLabel: string): number {
  const db = getDb();
  const today = pacificDateString();
  const row = db
    .prepare("SELECT units_used FROM api_key_usage WHERE key_label = ? AND date = ?")
    .get(keyLabel, today) as { units_used: number } | undefined;
  return row?.units_used ?? 0;
}

export function addUsage(keyLabel: string, units: number): void {
  if (!Number.isFinite(units) || units <= 0) return;
  const intUnits = Math.floor(units);
  const db = getDb();
  const today = pacificDateString();
  db.prepare(
    `INSERT INTO api_key_usage (key_label, date, units_used)
     VALUES (?, ?, ?)
     ON CONFLICT(key_label, date) DO UPDATE SET units_used = units_used + excluded.units_used`,
  ).run(keyLabel, today, intUnits);
}

// Exposed for quotaExceeded sentinel (Phase 3 sets usage to a very high value).
export function setUsageToday(keyLabel: string, units: number): void {
  const db = getDb();
  const today = pacificDateString();
  db.prepare(
    `INSERT INTO api_key_usage (key_label, date, units_used)
     VALUES (?, ?, ?)
     ON CONFLICT(key_label, date) DO UPDATE SET units_used = excluded.units_used`,
  ).run(keyLabel, today, Math.floor(units));
}

export function getDbPath(): string {
  return DB_PATH;
}

export function getPacificDate(date = new Date()): string {
  return pacificDateString(date);
}
