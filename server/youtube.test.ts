import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ProviderError } from "./provider-errors";
import {
  chunkArray,
  computeChannelMetrics,
  getKeyLabel,
  getYouTubeApiKeys,
  pickAvailableKey,
} from "./youtube";
import * as db from "./db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalKeys = process.env.YOUTUBE_API_KEYS;
const originalKey = process.env.YOUTUBE_API_KEY;

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

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKeys === undefined) delete process.env.YOUTUBE_API_KEYS;
  else process.env.YOUTUBE_API_KEYS = originalKeys;
  if (originalKey === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = originalKey;
  delete db.__testOverrides.isChannelKnown;
  delete db.__testOverrides.recordChannel;
  delete db.__testOverrides.recordSearchChannel;
  try {
    for (let i = 0; i < 10; i++) db.setUsageToday(getKeyLabel(i), 0);
  } catch { /* ignore if DB not yet created */ }
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("chunkArray", () => {
  test("splits into chunks", () => {
    assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunkArray([], 10), []);
    assert.deepEqual(chunkArray([1], 10), [[1]]);
  });
});

describe("computeChannelMetrics", () => {
  test("computes avg_views, engagement_rate_pct, last_upload_date, days_since_last_upload", () => {
    const now = Date.now();
    const iso1 = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const iso2 = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const m = computeChannelMetrics([
      { videoId: "a", viewCount: 1000, likeCount: 100, commentCount: 10, publishedAt: iso1 },
      { videoId: "b", viewCount: 3000, likeCount: 60, commentCount: 40, publishedAt: iso2 },
    ]);
    assert.equal(m.avg_views, 2000);
    assert.equal(m.engagement_rate_pct !== null && m.engagement_rate_pct > 0, true);
    assert.equal(m.last_upload_date, iso1);
    assert.equal(m.days_since_last_upload, 2);
  });

  test("returns nulls when no usable view counts", () => {
    // No viewCount at all -> avg_views null, engagement null
    const m = computeChannelMetrics([
      { videoId: "a", publishedAt: new Date().toISOString() },
      { videoId: "b", publishedAt: new Date().toISOString() },
    ]);
    assert.equal(m.avg_views, null);
    assert.equal(m.engagement_rate_pct, null);
  });

  test("skips videos with 0/missing viewCount for engagement but includes 0 in avg", () => {
    const m = computeChannelMetrics([
      { videoId: "a", viewCount: 100, likeCount: 10, commentCount: 0, publishedAt: new Date().toISOString() },
      { videoId: "b", viewCount: 0, likeCount: 50, commentCount: 50, publishedAt: new Date().toISOString() },
    ]);
    // avg over [100, 0] = 50
    assert.equal(m.avg_views, 50);
    assert.equal(m.engagement_rate_pct, 10); // only first video counts: 10/100*100
  });
});

// ---------------------------------------------------------------------------
// Multi-key rotation
// ---------------------------------------------------------------------------

describe("multi-key rotation", () => {
  test("getYouTubeApiKeys reads YOUTUBE_API_KEYS comma-separated with fallback", () => {
    setKeys(["k1", "k2", "k3"]);
    assert.deepEqual(getYouTubeApiKeys(), ["k1", "k2", "k3"]);
    setKeys(["solo"]);
    assert.deepEqual(getYouTubeApiKeys(), ["solo"]);
    setKeys([]);
    assert.deepEqual(getYouTubeApiKeys(), []);
    process.env.YOUTUBE_API_KEYS = "  a ,, b , ";
    assert.deepEqual(getYouTubeApiKeys(), ["a", "b"]);
  });

  test("getYouTubeApiKeys tolerates quoted YOUTUBE_API_KEYS from .env", () => {
    process.env.YOUTUBE_API_KEYS = '"k1,k2"';
    assert.deepEqual(getYouTubeApiKeys(), ["k1", "k2"]);
    process.env.YOUTUBE_API_KEYS = '"  k1 , k2  "';
    assert.deepEqual(getYouTubeApiKeys(), ["k1", "k2"]);
    setKeys([]);
    process.env.YOUTUBE_API_KEY = '"solo"';
    assert.deepEqual(getYouTubeApiKeys(), ["solo"]);
    setKeys([]);
  });

  test("pickAvailableKey skips exhausted and over-quota keys", async () => {
    setKeys(["k1", "k2", "k3"]);
    for (let i = 0; i < 3; i++) db.setUsageToday(getKeyLabel(i), 0);
    assert.equal(pickAvailableKey(100)?.index, 0);
    db.setUsageToday(getKeyLabel(0), 1_000_000);
    assert.equal(pickAvailableKey(100)?.index, 1);
    db.setUsageToday(getKeyLabel(1), 10_000);
    assert.equal(pickAvailableKey(1)?.index, 2);
    db.setUsageToday(getKeyLabel(2), 1_000_000);
    assert.equal(pickAvailableKey(1), null);
    for (let i = 0; i < 3; i++) db.setUsageToday(getKeyLabel(i), 0);
  });

  test("pickAvailableKey respects cost", () => {
    setKeys(["k1"]);
    db.setUsageToday(getKeyLabel(0), 9_950);
    assert.equal(pickAvailableKey(100), null);
    assert.notEqual(pickAvailableKey(1), null);
    db.setUsageToday(getKeyLabel(0), 0);
  });
});

// ---------------------------------------------------------------------------
// Provider error categories via fetch mock
// ---------------------------------------------------------------------------

describe("YouTube provider errors (Scout pipeline)", () => {
  beforeEach(() => {
    db.__testOverrides.isChannelKnown = () => false;
    db.__testOverrides.recordSearchChannel = () => {};
  });

  test("distinguishes missing key", async () => {
    setKeys([]);
    for (let i = 0; i < 3; i++) db.setUsageToday(getKeyLabel(i), 0);
    const { searchChannelIdsForKeyword } = await import("./youtube");
    await assert.rejects(
      () => searchChannelIdsForKeyword("test"),
      (e: unknown) => e instanceof ProviderError && e.category === "quota" && e.code === "YOUTUBE_QUOTA_EXHAUSTED",
    );
  });

  test("distinguishes invalid key, quota, timeout, network via fetch mock", async () => {
    setKeys(["test-key"]); // pragma: allowlist secret — test fixture
    const { searchChannelIdsForKeyword } = await import("./youtube");

    globalThis.fetch = (async () => Response.json({
      error: { errors: [{ reason: "keyInvalid" }], message: "API key not valid" },
    }, { status: 400 })) as typeof fetch;
    await assert.rejects(
      () => searchChannelIdsForKeyword("kw"),
      (e: unknown) => e instanceof ProviderError && e.category === "invalid_key",
    );

    setKeys(["test-key"]);
    for (let i = 0; i < 3; i++) db.setUsageToday(getKeyLabel(i), 0);
    globalThis.fetch = (async () => Response.json({
      error: { errors: [{ reason: "quotaExceeded" }], message: "Quota exceeded" },
    }, { status: 403 })) as typeof fetch;
    await assert.rejects(
      () => searchChannelIdsForKeyword("kw"),
      (e: unknown) => e instanceof ProviderError && e.category === "quota",
    );
    db.setUsageToday(getKeyLabel(0), 0);

    globalThis.fetch = (async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;
    await assert.rejects(
      () => searchChannelIdsForKeyword("kw"),
      (e: unknown) => e instanceof ProviderError && e.category === "timeout",
    );

    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await assert.rejects(
      () => searchChannelIdsForKeyword("kw"),
      (e: unknown) => e instanceof ProviderError && e.category === "network",
    );
  });
});

// ---------------------------------------------------------------------------
// Scout pipeline integration (mocked fetch + stubbed DB)
// ---------------------------------------------------------------------------

describe("Scout pipeline", () => {
  beforeEach(() => {
    db.__testOverrides.isChannelKnown = () => false;
    db.__testOverrides.recordSearchChannel = () => {};
    setKeys(["test-key"]); // pragma: allowlist secret
    try { db.setUsageToday(getKeyLabel(0), 0); } catch {}
  });

  test("runScoutDiscovery returns qualified channels with keywords_exhausted", async () => {
    const nowIso = new Date().toISOString();
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/search?")) {
        return Response.json({
          items: [{ snippet: { channelId: "UC_test" } }, { snippet: { channelId: "UC_test" } }],
        });
      }
      if (url.includes("/channels?")) {
        return Response.json({
          items: [{
            id: "UC_test",
            snippet: { title: "Test Channel" },
            statistics: { subscriberCount: "5000", hiddenSubscriberCount: false },
            contentDetails: { relatedPlaylists: { uploads: "UU_test" } },
          }],
        });
      }
      if (url.includes("/playlistItems?")) {
        return Response.json({
          items: [{ contentDetails: { videoId: "vid1" } }, { contentDetails: { videoId: "vid2" } }],
        });
      }
      if (url.includes("/videos?")) {
        return Response.json({
          items: [
            { id: "vid1", snippet: { publishedAt: nowIso }, statistics: { viewCount: "1000", likeCount: "50", commentCount: "10" } },
            { id: "vid2", snippet: { publishedAt: nowIso }, statistics: { viewCount: "2000", likeCount: "100", commentCount: "20" } },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const { runScoutDiscovery } = await import("./youtube");
    const result = await runScoutDiscovery({
      keywords: ["gaming"],
      filters: { minSubscribers: 1000, maxSubscribers: 10000, maxDaysSinceUpload: 30, minAvgViews: 500 },
      targetCount: 10,
    });

    assert.equal(result.found, 1);
    assert.equal(result.qualifiedChannels.length, 1);
    assert.equal(result.qualifiedChannels[0]!.channel_id, "UC_test");
    assert.equal(result.stopReason, "keywords_exhausted");
  });

  test("hidden-subscriber channel is recorded for exclusion and omitted from results", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/search?")) return Response.json({ items: [{ snippet: { channelId: "UC_hidden" } }] });
      if (url.includes("/channels?")) return Response.json({
        items: [{
          id: "UC_hidden",
          snippet: { title: "Hidden" },
          statistics: { hiddenSubscriberCount: true },
          contentDetails: { relatedPlaylists: { uploads: "UU_hidden" } },
        }],
      });
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const records: { channelId: string; channelName: string | null; channelUrl: string; matchedKeyword: string }[] = [];
    db.__testOverrides.recordSearchChannel = (r) => records.push(r);

    const { runScoutDiscovery } = await import("./youtube");
    const result = await runScoutDiscovery({
      keywords: ["kw"],
      filters: { minSubscribers: 0, maxSubscribers: 1_000_000, maxDaysSinceUpload: 365, minAvgViews: 0 },
      targetCount: 5,
    });

    assert.equal(result.found, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.channelId, "UC_hidden");
    assert.equal(records[0]!.channelName, "Hidden");
    assert.equal(records[0]!.matchedKeyword, "kw");
  });

  test("already-known channels are skipped entirely", async () => {
    db.__testOverrides.isChannelKnown = (id: string) => id === "UC_known";
    let channelsCalled = false;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/search?")) return Response.json({ items: [{ snippet: { channelId: "UC_known" } }] });
      if (url.includes("/channels?")) { channelsCalled = true; return Response.json({ items: [] }); }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const { discoverChannelsForKeyword } = await import("./youtube");
    const out = await discoverChannelsForKeyword("kw", {
      minSubscribers: 0, maxSubscribers: 1_000_000, maxDaysSinceUpload: 365, minAvgViews: 0,
    });
    assert.equal(out.length, 0);
    assert.equal(channelsCalled, false);
  });

  test("quota exhausted mid-run returns partial results gracefully", async () => {
    db.setUsageToday(getKeyLabel(0), 1_000_000);
    const { runScoutDiscovery } = await import("./youtube");
    const result = await runScoutDiscovery({
      keywords: ["kw"],
      filters: { minSubscribers: 0, maxSubscribers: 1_000_000, maxDaysSinceUpload: 365, minAvgViews: 0 },
      targetCount: 5,
    });
    assert.equal(result.stopReason, "quota_exhausted");
    assert.equal(result.found, 0);
    db.setUsageToday(getKeyLabel(0), 0);
  });
});
