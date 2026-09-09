import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { createServer, type Server } from "http";
import { getKeyLabel } from "./youtube";
import * as db from "./db";
import { registerRoutes } from "./routes";

// ---------------------------------------------------------------------------
// Harness: real Express app on an ephemeral loopback port, YouTube API
// mocked at global fetch (localhost traffic passes through to the app).
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalKeys = process.env.YOUTUBE_API_KEYS;
const originalKey = process.env.YOUTUBE_API_KEY;

// Fake-but-well-formed channel IDs used only by these tests.
const ID_NEW = `UC${"m".repeat(22)}`;
const ID_DUP = `UC${"d".repeat(22)}`;
const ID_HIST = `UC${"h".repeat(22)}`;

function setKeys(keys: string[]) {
  if (keys.length === 0) {
    delete process.env.YOUTUBE_API_KEYS;
    delete process.env.YOUTUBE_API_KEY;
  } else if (keys.length === 1) {
    delete process.env.YOUTUBE_API_KEYS;
    process.env.YOUTUBE_API_KEY = keys[0]!;
  } else {
    process.env.YOUTUBE_API_KEYS = keys.join(",");
    delete process.env.YOUTUBE_API_KEY;
  }
}

function deleteTestRows() {
  const handle = new Database(db.getDbPath());
  try {
    handle.prepare("DELETE FROM channels WHERE channel_id IN (?, ?, ?)").run(ID_NEW, ID_DUP, ID_HIST);
  } finally {
    handle.close();
  }
}

let baseUrl = "";
let httpServer: Server;

before(async () => {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  const server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  httpServer = server;
});

after(async () => {
  deleteTestRows();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  // NOTE: no isChannelKnown stub here (unlike youtube.test.ts) — these route
  // tests exercise the real dedup check against throwaway fake IDs.
  setKeys(["test-key"]); // pragma: allowlist secret
  try { db.setUsageToday(getKeyLabel(0), 0); } catch {}
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKeys === undefined) delete process.env.YOUTUBE_API_KEYS;
  else process.env.YOUTUBE_API_KEYS = originalKeys;
  if (originalKey === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = originalKey;
  delete db.__testOverrides.isChannelKnown;
  try {
    for (let i = 0; i < 10; i++) db.setUsageToday(getKeyLabel(i), 0);
  } catch { /* ignore if DB not yet created */ }
});

// YouTube mock: everything except loopback traffic is a channels.list stub.
// `handler` receives the request URL and returns the JSON body.
function mockYouTube(handler: (url: string) => unknown, onCall?: () => void) {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("127.0.0.1") || url.includes("localhost")) {
      return originalFetch(input, init);
    }
    onCall?.();
    return Response.json(handler(url));
  }) as typeof fetch;
}

async function postManualAdd(body: unknown) {
  const res = await fetch(`${baseUrl}/api/history/manual-add`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, cacheControl: res.headers.get("cache-control"), body: (await res.json()) as any };
}

describe("POST /api/history/manual-add", () => {
  test("valid bare ID resolves, adds, and returns the record", async () => {
    mockYouTube(() => ({ items: [{ id: ID_NEW, snippet: { title: "Manual Channel" } }] }));
    const { status, cacheControl, body } = await postManualAdd({ input: ID_NEW });

    assert.equal(status, 201);
    assert.equal(cacheControl, "no-store");
    assert.equal(body.status, "added");
    assert.equal(body.channel.channel_id, ID_NEW);
    assert.equal(body.channel.channel_name, "Manual Channel");
    assert.equal(body.channel.channel_url, `https://www.youtube.com/channel/${ID_NEW}`);
    assert.equal(body.channel.source, "manual");
    assert.equal(body.channel.matched_keyword, null);
    assert.equal(db.isChannelKnown(ID_NEW), true);
  });

  test("duplicate bare ID returns already-in-history without an API call", async () => {
    let calls = 0;
    mockYouTube(() => ({ items: [] }), () => { calls += 1; });
    const { status, body } = await postManualAdd({ input: ID_NEW });

    assert.equal(status, 409);
    assert.equal(body.status, "already-in-history");
    assert.match(body.error, /already in your history/);
    assert.equal(calls, 0);
  });

  test("duplicate via @handle is caught by the post-resolution re-check", async () => {
    db.addManualChannel(ID_DUP, `https://www.youtube.com/channel/${ID_DUP}`, "Dup Channel");
    mockYouTube((url) => {
      assert.match(url, /forHandle=%40/);
      return { items: [{ id: ID_DUP, snippet: { title: "Dup Channel" } }] };
    });
    const { status, body } = await postManualAdd({ input: "@duphandle" });

    assert.equal(status, 409);
    assert.equal(body.status, "already-in-history");
  });

  test("invalid format returns invalid-input without an API call", async () => {
    let calls = 0;
    mockYouTube(() => ({ items: [] }), () => { calls += 1; });
    const { status, body } = await postManualAdd({ input: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });

    assert.equal(status, 400);
    assert.equal(body.status, "invalid-input");
    assert.equal(calls, 0);
  });

  test("empty and blank inputs are rejected", async () => {
    assert.equal((await postManualAdd({})).body.status, "invalid-input");
    assert.equal((await postManualAdd({ input: "   " })).body.status, "invalid-input");
  });

  test("unknown channel returns channel-not-found", async () => {
    mockYouTube(() => ({ items: [] }));
    const { status, body } = await postManualAdd({ input: "@nosuchhandle" });

    assert.equal(status, 404);
    assert.equal(body.status, "channel-not-found");
  });

  test("quota exhausted while resolving returns quota-exhausted", async () => {
    setKeys([]);
    let calls = 0;
    mockYouTube(() => ({ items: [] }), () => { calls += 1; });
    const { status, body } = await postManualAdd({ input: "@somehandle" });

    assert.equal(status, 429);
    assert.equal(body.status, "quota-exhausted");
    assert.equal(calls, 0);
  });
});

describe("GET /api/history", () => {
  test("returns rows newest-first with no-store", async () => {
    db.addManualChannel(ID_HIST, `https://www.youtube.com/channel/${ID_HIST}`, "Hist Channel");
    const res = await fetch(`${baseUrl}/api/history`);
    const body = (await res.json()) as any;

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(Array.isArray(body.channels));
    // Seeded row has added_at = now, newer than every pre-existing row.
    assert.equal(body.channels[0].channel_id, ID_HIST);
    assert.equal(body.channels[0].source, "manual");
    assert.equal(body.channels[0].matched_keyword, null);
    const stamps = body.channels.map((c: any) => c.added_at);
    assert.ok(stamps.every((s: string, i: number, a: string[]) => i === 0 || a[i - 1]! >= s));
  });
});
