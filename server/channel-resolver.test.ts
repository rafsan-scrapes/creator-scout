import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ProviderError } from "./provider-errors";
import { getKeyLabel } from "./youtube";
import * as db from "./db";
import {
  ChannelResolveError,
  parseChannelIdentifier,
  resolveChannelIdentifier,
} from "./channel-resolver";

// ---------------------------------------------------------------------------
// Helpers (same conventions as server/youtube.test.ts)
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalKeys = process.env.YOUTUBE_API_KEYS;
const originalKey = process.env.YOUTUBE_API_KEY;

const ID_A = `UC${"a".repeat(22)}`;
const ID_B = `UC${"b".repeat(22)}`;

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

function channelItem(id: string, title: string) {
  return { id, snippet: { title } };
}

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

// ---------------------------------------------------------------------------
// Pure parsing — no fetch
// ---------------------------------------------------------------------------

describe("parseChannelIdentifier", () => {
  test("bare channel ID", () => {
    assert.deepEqual(parseChannelIdentifier(ID_A), { kind: "channel-id", channelId: ID_A });
    assert.deepEqual(parseChannelIdentifier(`  ${ID_A}  `), { kind: "channel-id", channelId: ID_A });
  });

  test("/channel/ URL with trailing slash and query", () => {
    assert.deepEqual(
      parseChannelIdentifier(`https://www.youtube.com/channel/${ID_A}?sub_confirmation=1`),
      { kind: "channel-id", channelId: ID_A },
    );
    assert.deepEqual(
      parseChannelIdentifier(`https://youtube.com/channel/${ID_A}/`),
      { kind: "channel-id", channelId: ID_A },
    );
  });

  test("/channel/ URL with malformed ID is invalid", () => {
    assert.deepEqual(parseChannelIdentifier("https://www.youtube.com/channel/UCshort"), { kind: "invalid" });
    assert.deepEqual(parseChannelIdentifier("https://www.youtube.com/channel/"), { kind: "invalid" });
  });

  test("bare @handle and @handle URL", () => {
    assert.deepEqual(parseChannelIdentifier("@mkbhd"), { kind: "handle", handle: "@mkbhd" });
    assert.deepEqual(
      parseChannelIdentifier("https://www.youtube.com/@mkbhd/featured"),
      { kind: "handle", handle: "@mkbhd" },
    );
  });

  test("/user/ URL", () => {
    assert.deepEqual(
      parseChannelIdentifier("https://www.youtube.com/user/SomeUser/videos"),
      { kind: "username", username: "SomeUser" },
    );
  });

  test("/c/ URL", () => {
    assert.deepEqual(
      parseChannelIdentifier("https://www.youtube.com/c/CustomName"),
      { kind: "custom", customName: "CustomName" },
    );
  });

  test("rejects everything else", () => {
    assert.deepEqual(parseChannelIdentifier(""), { kind: "invalid" });
    assert.deepEqual(parseChannelIdentifier("   "), { kind: "invalid" });
    assert.deepEqual(parseChannelIdentifier("just some words"), { kind: "invalid" });
    assert.deepEqual(parseChannelIdentifier("UCshort"), { kind: "invalid" });
    assert.deepEqual(parseChannelIdentifier("@"), { kind: "invalid" });
    assert.deepEqual(parseChannelIdentifier("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), { kind: "invalid" });
    assert.deepEqual(parseChannelIdentifier("https://www.youtube.com/shorts/abc123"), { kind: "invalid" });
    assert.deepEqual(parseChannelIdentifier("https://www.youtube.com/"), { kind: "invalid" });
    assert.deepEqual(parseChannelIdentifier("https://youtu.be/dQw4w9WgXcQ"), { kind: "invalid" });
    assert.deepEqual(parseChannelIdentifier("https://example.com/@mkbhd"), { kind: "invalid" });
    assert.deepEqual(parseChannelIdentifier("ftp://www.youtube.com/@mkbhd"), { kind: "invalid" });
    assert.deepEqual(parseChannelIdentifier(`https://www.youtube.com/@${"x".repeat(600)}`), { kind: "invalid" });
  });
});

// ---------------------------------------------------------------------------
// Resolution with mocked fetch
// ---------------------------------------------------------------------------

describe("resolveChannelIdentifier", () => {
  beforeEach(() => {
    db.__testOverrides.isChannelKnown = () => false;
    setKeys(["test-key"]); // pragma: allowlist secret
    try { db.setUsageToday(getKeyLabel(0), 0); } catch {}
  });

  test("case a: already-known bare ID returns already-in-history with no API call", async () => {
    db.__testOverrides.isChannelKnown = (id: string) => id === ID_A;
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; throw new Error("must not be called"); }) as typeof fetch;

    const result = await resolveChannelIdentifier(ID_A);
    assert.deepEqual(result, { status: "already-in-history" });
    assert.equal(fetchCalled, false);
  });

  test("case a: unknown bare ID is confirmed via channels.list?id (1 unit)", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (input) => {
      seenUrl = String(input);
      return Response.json({ items: [channelItem(ID_A, "Channel A")] });
    }) as typeof fetch;

    const result = await resolveChannelIdentifier(ID_A);
    const params = new URL(seenUrl).searchParams;
    assert.equal(params.get("id"), ID_A);
    assert.equal(seenUrl.includes("/channels?"), true);
    assert.deepEqual(result, {
      status: "resolved",
      channel: {
        channelId: ID_A,
        channelUrl: `https://www.youtube.com/channel/${ID_A}`,
        channelName: "Channel A",
      },
      quotaCost: 1,
    });
    assert.equal(db.getUsageToday(getKeyLabel(0)), 1);
  });

  test("case a: /channel/ URL of unknown ID resolves the same way", async () => {
    globalThis.fetch = (async () => Response.json({ items: [channelItem(ID_B, "Channel B")] })) as typeof fetch;
    const result = await resolveChannelIdentifier(`https://www.youtube.com/channel/${ID_B}`);
    assert.equal(result.status, "resolved");
    assert.equal(result.status === "resolved" && result.channel.channelId, ID_B);
  });

  test("case a: confirmed-missing ID throws channel-not-found", async () => {
    globalThis.fetch = (async () => Response.json({ items: [] })) as typeof fetch;
    await assert.rejects(
      () => resolveChannelIdentifier(ID_A),
      (e: unknown) => e instanceof ChannelResolveError && e.code === "channel-not-found",
    );
  });

  test("case b: @handle URL and bare @handle use channels.list?forHandle", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input) => {
      seen.push(String(input));
      return Response.json({ items: [channelItem(ID_A, "Handle Channel")] });
    }) as typeof fetch;

    const fromUrl = await resolveChannelIdentifier("https://www.youtube.com/@somehandle");
    const params = new URL(seen[0]!).searchParams;
    assert.equal(params.get("forHandle"), "@somehandle");
    assert.equal(fromUrl.status === "resolved" && fromUrl.channel.channelName, "Handle Channel");

    const fromBare = await resolveChannelIdentifier("@somehandle");
    assert.equal(new URL(seen[1]!).searchParams.get("forHandle"), "@somehandle");
    assert.equal(fromBare.status, "resolved");
  });

  test("case b: unknown handle throws channel-not-found", async () => {
    globalThis.fetch = (async () => Response.json({ items: [] })) as typeof fetch;
    await assert.rejects(
      () => resolveChannelIdentifier("@nosuchhandle"),
      (e: unknown) => e instanceof ChannelResolveError && e.code === "channel-not-found",
    );
  });

  test("case c: /user/ URL uses channels.list?forUsername", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (input) => {
      seenUrl = String(input);
      return Response.json({ items: [channelItem(ID_B, "Legacy User")] });
    }) as typeof fetch;

    const result = await resolveChannelIdentifier("https://www.youtube.com/user/LegacyUser");
    assert.equal(new URL(seenUrl).searchParams.get("forUsername"), "LegacyUser");
    assert.equal(result.status === "resolved" && result.channel.channelId, ID_B);
  });

  test("case d: /c/ URL falls back to search.list type=channel (100 units), top match wins", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (input) => {
      seenUrl = String(input);
      return Response.json({ items: [{ id: { channelId: ID_A }, snippet: { title: "Custom Match" } }] });
    }) as typeof fetch;

    const result = await resolveChannelIdentifier("https://www.youtube.com/c/CustomName");
    const params = new URL(seenUrl).searchParams;
    assert.equal(seenUrl.includes("/search?"), true);
    assert.equal(params.get("type"), "channel");
    assert.equal(params.get("q"), "CustomName");
    assert.deepEqual(result, {
      status: "resolved",
      channel: {
        channelId: ID_A,
        channelUrl: `https://www.youtube.com/channel/${ID_A}`,
        channelName: "Custom Match",
      },
      quotaCost: 100,
    });
    assert.equal(db.getUsageToday(getKeyLabel(0)), 100);
  });

  test("invalid input throws invalid-input with no API call", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; throw new Error("must not be called"); }) as typeof fetch;
    await assert.rejects(
      () => resolveChannelIdentifier("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
      (e: unknown) => e instanceof ChannelResolveError && e.code === "invalid-input",
    );
    assert.equal(fetchCalled, false);
  });

  test("no available key throws quota error before any fetch", async () => {
    setKeys([]);
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; throw new Error("must not be called"); }) as typeof fetch;
    await assert.rejects(
      () => resolveChannelIdentifier(ID_A),
      (e: unknown) => e instanceof ProviderError && e.category === "quota" && e.code === "YOUTUBE_QUOTA_EXHAUSTED",
    );
    assert.equal(fetchCalled, false);
  });

  test("quota error mid-resolution propagates as quota ProviderError", async () => {
    globalThis.fetch = (async () => Response.json({
      error: { errors: [{ reason: "quotaExceeded" }], message: "Quota exceeded" },
    }, { status: 403 })) as typeof fetch;
    await assert.rejects(
      () => resolveChannelIdentifier(ID_A),
      (e: unknown) => e instanceof ProviderError && e.category === "quota",
    );
    db.setUsageToday(getKeyLabel(0), 0);
  });
});
