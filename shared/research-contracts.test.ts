import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  providerErrorResponseSchema,
  SCOUT_KEYWORD_LIMIT,
  scoutChannelSchema,
  scoutRequestSchema,
  scoutResponseSchema,
  scoutStopReasonSchema,
} from "./schema";

describe("scout request contracts", () => {
  const base = {
    keywords: ["gaming"],
    minSubscribers: 1000,
    maxSubscribers: 50000,
    maxDaysSinceUpload: 30,
    minAvgViews: 1000,
    targetCount: 10,
  };

  test("requires at least one keyword and caps at SCOUT_KEYWORD_LIMIT", () => {
    assert.equal(scoutRequestSchema.safeParse({ ...base, keywords: [] }).success, false);
    assert.equal(
      scoutRequestSchema.safeParse({
        ...base,
        keywords: Array.from({ length: SCOUT_KEYWORD_LIMIT + 1 }, (_, i) => `kw${i}`),
      }).success,
      false,
    );
    assert.equal(scoutRequestSchema.safeParse(base).success, true);
  });

  test("rejects minSubscribers > maxSubscribers via superRefine", () => {
    assert.equal(
      scoutRequestSchema.safeParse({ ...base, minSubscribers: 90000, maxSubscribers: 1000 }).success,
      false,
    );
  });

  test("rejects unknown keys (strict)", () => {
    assert.equal(scoutRequestSchema.safeParse({ ...base, unexpected: true }).success, false);
  });

  test("validates targetCount bounds and optional engagement rate", () => {
    assert.equal(scoutRequestSchema.safeParse({ ...base, targetCount: 0 }).success, false);
    assert.equal(scoutRequestSchema.safeParse({ ...base, targetCount: 501 }).success, false);
    assert.equal(scoutRequestSchema.safeParse({ ...base, minEngagementRate: -1 }).success, false);
    assert.equal(scoutRequestSchema.safeParse({ ...base, minEngagementRate: 101 }).success, false);
    assert.equal(scoutRequestSchema.safeParse({ ...base, minEngagementRate: 5 }).success, true);
  });
});

describe("scout response contracts", () => {
  const validChannel = {
    channel_id: "UC_test123",
    channel_name: "Test Channel",
    channel_url: "https://www.youtube.com/channel/UC_test123",
    subscriber_count: 12345,
    avg_views: 5000,
    engagement_rate_pct: 2.5,
    last_upload_date: "2026-09-01T00:00:00.000Z",
    days_since_last_upload: 8,
    matched_keyword: "gaming",
    qualified: true,
    first_seen_at: "2026-09-09T00:00:00.000Z",
  };

  test("accepts a valid scout channel and rejects strict violations", () => {
    assert.equal(scoutChannelSchema.safeParse(validChannel).success, true);
    assert.equal(scoutChannelSchema.safeParse({ ...validChannel, channel_name: "x".repeat(501) }).success, false);
    assert.equal(scoutChannelSchema.safeParse({ ...validChannel, extra: true }).success, false);
  });

  test("validates scout response stop reasons and strict payload", () => {
    const validResponse = {
      channels: [validChannel],
      stopReason: "target_reached" as const,
      found: 1,
      requested: 10,
      keywordsSearched: 2,
    };
    assert.equal(scoutResponseSchema.safeParse(validResponse).success, true);
    assert.equal(scoutResponseSchema.safeParse({ ...validResponse, stopReason: "unknown" }).success, false);
    assert.equal(scoutResponseSchema.safeParse({ ...validResponse, unexpected: true }).success, false);
    assert.equal(scoutStopReasonSchema.safeParse("quota_exhausted").success, true);
    assert.equal(scoutStopReasonSchema.safeParse("other").success, false);
  });
});

describe("provider error categories remain machine-readable", () => {
  test("parses a quota provider error response", () => {
    const result = providerErrorResponseSchema.parse({
      error: "YouTube Data API quota is unavailable",
      code: "YOUTUBE_QUOTA",
      category: "quota",
      retryable: true,
      suggestion: "Wait for quota to reset.",
    });
    assert.equal(result.category, "quota");
    assert.equal(result.retryable, true);
  });
});
