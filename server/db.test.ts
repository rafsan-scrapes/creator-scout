import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import Database from "better-sqlite3";
import {
  addManualChannel,
  getChannel,
  getDbPath,
  recordSearchChannel,
} from "./db";

// addManualChannel duplicate handling against the real DB with throwaway
// fake IDs (same isolation approach as server/manual-add.test.ts).
// Fake rows are deleted in after() so the 24 real rows are never affected.

const ID_FRESH = `UC${"x".repeat(22)}`;
const ID_SEARCHED = `UC${"y".repeat(22)}`;

after(() => {
  const handle = new Database(getDbPath());
  try {
    handle.prepare("DELETE FROM channels WHERE channel_id IN (?, ?)").run(ID_FRESH, ID_SEARCHED);
  } finally {
    handle.close();
  }
});

describe("addManualChannel", () => {
  test("fresh add returns 'added' with manual source and null keyword", () => {
    assert.equal(
      addManualChannel(ID_FRESH, `https://www.youtube.com/channel/${ID_FRESH}`, "Fresh Manual"),
      "added",
    );
    const row = getChannel(ID_FRESH);
    assert.ok(row);
    assert.equal(row.source, "manual");
    assert.equal(row.matched_keyword, null);
    assert.equal(row.channel_name, "Fresh Manual");
    assert.equal(typeof row.added_at, "string");
  });

  test("duplicate returns 'already exists' and preserves the original row", () => {
    const before = getChannel(ID_FRESH);
    assert.ok(before);
    assert.equal(
      addManualChannel(ID_FRESH, `https://www.youtube.com/channel/${ID_FRESH}`, "Renamed"),
      "already exists",
    );
    const row = getChannel(ID_FRESH);
    assert.ok(row);
    assert.equal(row.channel_name, "Fresh Manual");
    assert.equal(row.added_at, before.added_at);
  });

  test("pre-existing search row returns 'already exists' and stays search-sourced", () => {
    recordSearchChannel(ID_SEARCHED, "Seeded", `https://www.youtube.com/channel/${ID_SEARCHED}`, "kw-seed");
    assert.equal(
      addManualChannel(ID_SEARCHED, `https://www.youtube.com/channel/${ID_SEARCHED}`, "Seeded Renamed"),
      "already exists",
    );
    const row = getChannel(ID_SEARCHED);
    assert.ok(row);
    assert.equal(row.source, "search");
    assert.equal(row.matched_keyword, "kw-seed");
    assert.equal(row.channel_name, "Seeded");
  });
});
