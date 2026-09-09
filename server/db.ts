import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Local SQLite file — gitignored via `data/` in .gitignore.
// Deleting the file resets dedup history and quota counters; no migration.
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

function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  // WAL is better for concurrent reads; safe for this single-process local app.
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      channel_id TEXT PRIMARY KEY,
      channel_name TEXT NOT NULL,
      channel_url TEXT NOT NULL,
      subscriber_count INTEGER,
      avg_views INTEGER,
      engagement_rate_pct REAL,
      last_upload_date TEXT,
      days_since_last_upload INTEGER,
      matched_keyword TEXT NOT NULL,
      qualified INTEGER NOT NULL,
      first_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channels_matched_keyword ON channels(matched_keyword);
    CREATE TABLE IF NOT EXISTS api_key_usage (
      key_label TEXT NOT NULL,
      date TEXT NOT NULL,
      units_used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key_label, date)
    );
  `);
  _db = db;
  return db;
}

// For tests / throwaway scripts that need an isolated in-memory DB.
export function getDbForTesting(dbPath = ":memory:"): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      channel_id TEXT PRIMARY KEY,
      channel_name TEXT NOT NULL,
      channel_url TEXT NOT NULL,
      subscriber_count INTEGER,
      avg_views INTEGER,
      engagement_rate_pct REAL,
      last_upload_date TEXT,
      days_since_last_upload INTEGER,
      matched_keyword TEXT NOT NULL,
      qualified INTEGER NOT NULL,
      first_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channels_matched_keyword ON channels(matched_keyword);
    CREATE TABLE IF NOT EXISTS api_key_usage (
      key_label TEXT NOT NULL,
      date TEXT NOT NULL,
      units_used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key_label, date)
    );
  `);
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

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

export function recordChannel(record: ChannelRecord): void {
  if (__testOverrides.recordChannel) return __testOverrides.recordChannel(record);
  const db = getDb();
  db.prepare(
    `INSERT INTO channels (
      channel_id, channel_name, channel_url, subscriber_count, avg_views,
      engagement_rate_pct, last_upload_date, days_since_last_upload,
      matched_keyword, qualified, first_seen_at
    ) VALUES (
      @channel_id, @channel_name, @channel_url, @subscriber_count, @avg_views,
      @engagement_rate_pct, @last_upload_date, @days_since_last_upload,
      @matched_keyword, @qualified, @first_seen_at
    )
    ON CONFLICT(channel_id) DO UPDATE SET
      channel_name = excluded.channel_name,
      channel_url = excluded.channel_url,
      subscriber_count = excluded.subscriber_count,
      avg_views = excluded.avg_views,
      engagement_rate_pct = excluded.engagement_rate_pct,
      last_upload_date = excluded.last_upload_date,
      days_since_last_upload = excluded.days_since_last_upload,
      matched_keyword = excluded.matched_keyword,
      qualified = excluded.qualified
    `,
  ).run({
    ...record,
    qualified: record.qualified ? 1 : 0,
  });
}

type DbChannelRow = Omit<ChannelRecord, "qualified"> & { qualified: number };

export function getChannel(channelId: string): ChannelRecord | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM channels WHERE channel_id = ?")
    .get(channelId) as DbChannelRow | undefined;
  if (!row) return undefined;
  const { qualified, ...rest } = row;
  return { ...rest, qualified: Boolean(qualified) };
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
