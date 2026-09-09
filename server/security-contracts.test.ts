import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { createRateLimiter } from "./rate-limit";
import {
  apiKeySettingsSchema,
  isTrustedLocalSettingsMetadata,
} from "./settings";
import {
  SCOUT_KEYWORD_LIMIT,
  scoutChannelSchema,
  scoutRequestSchema,
  scoutResponseSchema,
  videoSchema,
} from "@shared/schema";

test("local Settings accepts a direct loopback same-origin request", () => {
  assert.equal(isTrustedLocalSettingsMetadata({
    remoteAddress: "127.0.0.1",
    host: "127.0.0.1:5000",
    origin: "http://127.0.0.1:5000",
    secFetchSite: "same-origin",
  }), true);
});

test("local Settings rejects forwarded, non-loopback, and cross-origin requests", () => {
  assert.equal(isTrustedLocalSettingsMetadata({
    remoteAddress: "127.0.0.1",
    host: "127.0.0.1:5000",
    xForwardedFor: "203.0.113.4",
  }), false);
  assert.equal(isTrustedLocalSettingsMetadata({
    remoteAddress: "192.168.1.10",
    host: "192.168.1.10:5000",
  }), false);
  assert.equal(isTrustedLocalSettingsMetadata({
    remoteAddress: "::1",
    host: "localhost:5000",
    origin: "https://example.test",
  }), false);
  assert.equal(isTrustedLocalSettingsMetadata({
    remoteAddress: "127.0.0.1",
    host: "attacker@example.test@localhost:5000",
  }), false);
});

test("Settings payload is strict, bounded, and rejects unknown keys", () => {
  assert.equal(apiKeySettingsSchema.safeParse({ youtubeApiKey: "x".repeat(513) }).success, false);
  assert.equal(apiKeySettingsSchema.safeParse({ unexpected: true }).success, false);
  assert.equal(apiKeySettingsSchema.safeParse({ youtubeApiKeys: "x".repeat(8193) }).success, false);
  assert.equal(apiKeySettingsSchema.safeParse({ youtubeApiKey: "valid-key-123", unexpected: true }).success, false);
});

test("Scout request schema enforces keyword count, subscriber range, and target bounds", () => {
  const base = {
    keywords: ["gaming"],
    minSubscribers: 1000,
    maxSubscribers: 50000,
    maxDaysSinceUpload: 30,
    minAvgViews: 1000,
    targetCount: 10,
  };

  // Too many keywords (> SCOUT_KEYWORD_LIMIT) rejected
  assert.equal(
    scoutRequestSchema.safeParse({
      ...base,
      keywords: Array.from({ length: SCOUT_KEYWORD_LIMIT + 1 }, (_, i) => `kw${i}`),
    }).success,
    false,
  );
  // minSubscribers > maxSubscribers rejected via superRefine
  assert.equal(
    scoutRequestSchema.safeParse({ ...base, minSubscribers: 90000, maxSubscribers: 1000 }).success,
    false,
  );
  // targetCount out of bounds
  assert.equal(scoutRequestSchema.safeParse({ ...base, targetCount: 0 }).success, false);
  assert.equal(scoutRequestSchema.safeParse({ ...base, targetCount: 501 }).success, false);
  // Empty keywords rejected
  assert.equal(scoutRequestSchema.safeParse({ ...base, keywords: [] }).success, false);
  // Unknown key rejected (strict)
  assert.equal(scoutRequestSchema.safeParse({ ...base, unexpected: true }).success, false);
  // Valid request passes
  assert.equal(scoutRequestSchema.safeParse(base).success, true);
  // Optional minEngagementRate
  assert.equal(scoutRequestSchema.safeParse({ ...base, minEngagementRate: 5.5 }).success, true);
  assert.equal(scoutRequestSchema.safeParse({ ...base, minEngagementRate: -1 }).success, false);
  assert.equal(scoutRequestSchema.safeParse({ ...base, minEngagementRate: 101 }).success, false);
});

test("Scout channel and response schemas enforce strict bounds", () => {
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
  assert.equal(scoutChannelSchema.safeParse(validChannel).success, true);
  // channel_name too long
  assert.equal(scoutChannelSchema.safeParse({ ...validChannel, channel_name: "x".repeat(501) }).success, false);
  // Unexpected key
  assert.equal(scoutChannelSchema.safeParse({ ...validChannel, extra: true }).success, false);

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
});

test("incoming Scout-related video records remain bounded", () => {
  const validVideo = {
    id: "video-id",
    title: "Title",
    channelTitle: "Channel",
    channelId: "channel-id",
    publishedAt: "2026-01-01T00:00:00Z",
    thumbnailUrl: "https://i.ytimg.com/example.jpg",
    description: "Description",
  };
  assert.equal(videoSchema.safeParse(validVideo).success, true);
  assert.equal(videoSchema.safeParse({ ...validVideo, title: "x".repeat(501) }).success, false);
  assert.equal(videoSchema.safeParse({ ...validVideo, tags: Array.from({ length: 101 }, () => "tag") }).success, false);
});

test("rate limiter permits the configured window and then returns 429", () => {
  let timestamp = 1_000;
  const { middleware } = createRateLimiter({ maxRequests: 2, windowMs: 60_000, now: () => timestamp });
  const request = { ip: "127.0.0.1", socket: {} } as Request;
  const headers = new Map<string, string>();
  let statusCode = 200;
  let payload: unknown;
  const response = {
    setHeader: (name: string, value: string) => headers.set(name, value),
    status: (value: number) => {
      statusCode = value;
      return response;
    },
    json: (value: unknown) => {
      payload = value;
      return response;
    },
  } as unknown as Response;
  let nextCalls = 0;
  const next = (() => { nextCalls += 1; }) as NextFunction;

  middleware(request, response, next);
  middleware(request, response, next);
  middleware(request, response, next);
  assert.equal(nextCalls, 2);
  assert.equal(statusCode, 429);
  assert.equal(headers.get("Retry-After"), "60");
  assert.deepEqual(payload, {
    error: "Too many requests. Please wait before trying again.",
    retryAfter: 60,
  });

  timestamp += 60_000;
  middleware(request, response, next);
  assert.equal(nextCalls, 3);
});
