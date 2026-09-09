import { ProviderError } from "./provider-errors";
import { addUsage, getUsageToday, isChannelKnown, recordChannel, setUsageToday } from "./db";
import type { ChannelRecord } from "./db";

const BASE_URL = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Quota accounting (verified against Google's quota calculator)
// search.list = 100 units regardless of type; channels/playlistItems/videos = 1
// ---------------------------------------------------------------------------
export const QUOTA_COST = {
  search: 100,
  channels: 1,
  playlistItems: 1,
  videos: 1,
} as const;

export const DAILY_QUOTA_UNITS = 10_000;
export const QUOTA_EXHAUSTED_SENTINEL = 1_000_000;

// ---------------------------------------------------------------------------
// Multi-key config (Phase 6 supplies YOUTUBE_API_KEYS comma-separated;
// YOUTUBE_API_KEY remains as single-key fallback)
// ---------------------------------------------------------------------------
export function getYouTubeApiKeys(): string[] {
  const multi = process.env.YOUTUBE_API_KEYS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (multi && multi.length > 0) return multi;
  const single = process.env.YOUTUBE_API_KEY?.trim();
  if (single) return [single];
  return [];
}

export function getKeyLabel(index: number): string {
  return `youtube-key-${index + 1}`;
}

/**
 * Return the first key that has remaining estimated quota for today.
 * If `cost` is supplied, require at least that many units remaining.
 * Skips keys already marked exhausted (sentinel) or over daily quota.
 */
export function pickAvailableKey(cost = 1): { key: string; label: string; index: number } | null {
  const keys = getYouTubeApiKeys();
  for (let i = 0; i < keys.length; i++) {
    const label = getKeyLabel(i);
    const used = getUsageToday(label);
    if (used >= QUOTA_EXHAUSTED_SENTINEL) continue;
    if (used + cost > DAILY_QUOTA_UNITS) continue;
    // Also skip if already over quota (safety)
    if (used >= DAILY_QUOTA_UNITS) continue;
    return { key: keys[i]!, label, index: i };
  }
  return null;
}

export function requireAvailableKey(cost = 1, stage = "youtube"): { key: string; label: string; index: number } {
  const picked = pickAvailableKey(cost);
  if (!picked) {
    throw new ProviderError({
      message: `All YouTube API keys are out of quota for today (stage: ${stage}).`,
      category: "quota",
      code: "YOUTUBE_QUOTA_EXHAUSTED",
      status: 429,
      retryable: false,
    });
  }
  return picked;
}

if (getYouTubeApiKeys().length === 0) {
  console.warn("Warning: No YouTube API key is configured (YOUTUBE_API_KEYS or YOUTUBE_API_KEY). YouTube search will not work.");
}

function parseOptionalCount(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getYouTubeErrorReason(body: any): string {
  return [
    body?.error?.message,
    ...(Array.isArray(body?.error?.errors)
      ? body.error.errors.flatMap((entry: any) => [entry?.reason, entry?.message])
      : []),
  ].filter((value): value is string => typeof value === "string").join(" ");
}

function youtubeHttpError(status: number, body: unknown, stage: string): ProviderError {
  const reason = getYouTubeErrorReason(body).toLowerCase();
  const invalidKey = status === 401
    || reason.includes("keyinvalid")
    || reason.includes("api key not valid")
    || reason.includes("invalid api key");
  const quota = status === 429
    || reason.includes("quota")
    || reason.includes("dailylimit")
    || reason.includes("rate limit");

  if (invalidKey) {
    return new ProviderError({
      message: `YouTube rejected the API key during ${stage}.`,
      category: "invalid_key",
      code: "YOUTUBE_INVALID_KEY",
      status: 401,
      retryable: false,
    });
  }
  if (quota) {
    return new ProviderError({
      message: `YouTube quota was unavailable during ${stage}.`,
      category: "quota",
      code: "YOUTUBE_QUOTA",
      status: 429,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new ProviderError({
      message: `YouTube returned a server error during ${stage}.`,
      category: "provider_server",
      code: "YOUTUBE_PROVIDER_SERVER",
      status: 502,
      retryable: true,
    });
  }
  return new ProviderError({
    message: `YouTube rejected the ${stage} request.`,
    category: "unknown",
    code: "YOUTUBE_REQUEST_REJECTED",
    status: 502,
    retryable: false,
  });
}

async function fetchYouTubeJson(url: string, stage: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YOUTUBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ProviderError({
        message: `YouTube returned malformed JSON during ${stage}.`,
        category: "invalid_response",
        code: "YOUTUBE_INVALID_RESPONSE",
        status: 502,
        retryable: false,
        cause: error,
      });
    }
    if (!response.ok) throw youtubeHttpError(response.status, body, stage);
    return body;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError({
        message: `YouTube timed out during ${stage}.`,
        category: "timeout",
        code: "YOUTUBE_TIMEOUT",
        status: 504,
        retryable: true,
        cause: error,
      });
    }
    throw new ProviderError({
      message: `YouTube could not be reached during ${stage}.`,
      category: "network",
      code: "YOUTUBE_NETWORK",
      status: 502,
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isQuotaError(error: unknown): boolean {
  return error instanceof ProviderError && error.category === "quota";
}

/**
 * Quota-aware fetch: picks an available key for the given stage/cost,
 * appends `key=`, calls YouTube, then increments `api_key_usage`.
 * Proactive rotation — never waits for a 403 to rotate.
 * Backstop (step 4): on 403 quotaExceeded / quota error, marks the key
 * exhausted (sentinel) in api_key_usage, rotates to the next available
 * key, and retries the same call once. If no keys remain, throws a
 * YOUTUBE_QUOTA_EXHAUSTED quota error for the caller to handle gracefully.
 */
async function fetchYouTubeJsonWithQuota(
  baseUrl: string,
  params: URLSearchParams,
  stage: string,
  cost: number,
): Promise<any> {
  let picked = pickAvailableKey(cost);
  if (!picked) {
    throw new ProviderError({
      message: `All YouTube API keys are out of quota for today (stage: ${stage}).`,
      category: "quota",
      code: "YOUTUBE_QUOTA_EXHAUSTED",
      status: 429,
      retryable: false,
    });
  }

  const urlFor = (key: string) => `${baseUrl}?${params.toString()}&key=${encodeURIComponent(key)}`;

  try {
    const data = await fetchYouTubeJson(urlFor(picked.key), stage);
    addUsage(picked.label, cost);
    return data;
  } catch (error) {
    if (!isQuotaError(error)) throw error;

    // Backstop: this key just hit quotaExceeded — mark exhausted for today
    setUsageToday(picked.label, QUOTA_EXHAUSTED_SENTINEL);

    const next = pickAvailableKey(cost);
    if (!next) {
      throw new ProviderError({
        message: `All YouTube API keys are exhausted after quotaExceeded on ${stage}.`,
        category: "quota",
        code: "YOUTUBE_QUOTA_EXHAUSTED",
        status: 429,
        retryable: false,
        cause: error,
      });
    }

    try {
      const data2 = await fetchYouTubeJson(urlFor(next.key), stage);
      addUsage(next.label, cost);
      return data2;
    } catch (error2) {
      if (isQuotaError(error2)) {
        setUsageToday(next.label, QUOTA_EXHAUSTED_SENTINEL);
        throw new ProviderError({
          message: `YouTube quota exhausted on retry for ${stage}.`,
          category: "quota",
          code: "YOUTUBE_QUOTA_EXHAUSTED",
          status: 429,
          retryable: false,
          cause: error2,
        });
      }
      throw error2;
    }
  }
}

// ---------------------------------------------------------------------------
// Scout discovery pipeline — steps 2a-2j (Phase 3 batch 1)
// No stop-condition or quotaExceeded retry here; those are step 3/4.
// ---------------------------------------------------------------------------

export interface ScoutFilters {
  minSubscribers: number;
  maxSubscribers: number;
  maxDaysSinceUpload: number;
  minAvgViews: number;
  minEngagementRate?: number;
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function channelUrlForId(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}`;
}

function computeDaysSince(dateIso: string | null | undefined): number | null {
  if (!dateIso) return null;
  const t = Date.parse(dateIso);
  if (!Number.isFinite(t)) return null;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

function computeAvgViews(viewCounts: (number | undefined)[]): number | null {
  const usable = viewCounts.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (usable.length === 0) return null;
  const sum = usable.reduce((a, b) => a + b, 0);
  return Math.round(sum / usable.length);
}

function computeEngagementRatePct(
  videos: Array<{ viewCount?: number; likeCount?: number; commentCount?: number }>,
): number | null {
  const rates: number[] = [];
  for (const v of videos) {
    const views = v.viewCount;
    if (typeof views !== "number" || !Number.isFinite(views) || views <= 0) continue;
    const likes = typeof v.likeCount === "number" && Number.isFinite(v.likeCount) ? v.likeCount : 0;
    const comments = typeof v.commentCount === "number" && Number.isFinite(v.commentCount) ? v.commentCount : 0;
    rates.push(((likes + comments) / views) * 100);
  }
  if (rates.length === 0) return null;
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  // Round to 2 decimals
  return Math.round(mean * 100) / 100;
}

function mostRecentPublishDate(videos: Array<{ publishedAt?: string }>): string | null {
  let latest: string | null = null;
  let latestMs = -Infinity;
  for (const v of videos) {
    if (!v.publishedAt) continue;
    const ms = Date.parse(v.publishedAt);
    if (!Number.isFinite(ms)) continue;
    if (ms > latestMs) {
      latestMs = ms;
      latest = v.publishedAt;
    }
  }
  return latest;
}

// 2a — search.list type=video -> unique channelIds
export async function searchChannelIdsForKeyword(keyword: string, maxResults = 25): Promise<string[]> {
  const q = keyword.trim();
  if (!q) return [];
  const params = new URLSearchParams({
    part: "snippet",
    q,
    type: "video",
    maxResults: String(Math.min(Math.max(maxResults, 1), 50)),
  });
  const data = await fetchYouTubeJsonWithQuota(`${BASE_URL}/search`, params, "search", QUOTA_COST.search);
  if (!Array.isArray(data.items)) return [];
  const ids = data.items
    .map((item: any) => item?.snippet?.channelId)
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
  return Array.from(new Set(ids));
}

interface RawChannel {
  channelId: string;
  channelName: string;
  hiddenSubscriberCount: boolean;
  subscriberCount?: number;
  uploadsPlaylistId?: string;
}

// 2c — channels.list batched 50
export async function fetchChannelsBatch(channelIds: string[]): Promise<Map<string, RawChannel>> {
  const out = new Map<string, RawChannel>();
  const chunks = chunkArray(channelIds, 50);
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      part: "snippet,statistics,contentDetails",
      id: chunk.join(","),
      maxResults: "50",
    });
    const data = await fetchYouTubeJsonWithQuota(`${BASE_URL}/channels`, params, "channels", QUOTA_COST.channels);
    const items: any[] = Array.isArray(data.items) ? data.items : [];
    for (const ch of items) {
      const id: string | undefined = ch?.id;
      if (typeof id !== "string" || !id) continue;
      out.set(id, {
        channelId: id,
        channelName: typeof ch?.snippet?.title === "string" ? ch.snippet.title : id,
        hiddenSubscriberCount: Boolean(ch?.statistics?.hiddenSubscriberCount),
        subscriberCount: ch?.statistics?.hiddenSubscriberCount
          ? undefined
          : parseOptionalCount(ch?.statistics?.subscriberCount),
        uploadsPlaylistId: typeof ch?.contentDetails?.relatedPlaylists?.uploads === "string"
          ? ch.contentDetails.relatedPlaylists.uploads
          : undefined,
      });
    }
  }
  return out;
}

// 2f — playlistItems.list per uploads playlist -> up to 10 videoIds
export async function fetchRecentVideoIdsForPlaylist(uploadsPlaylistId: string, maxResults = 10): Promise<string[]> {
  const params = new URLSearchParams({
    part: "contentDetails",
    playlistId: uploadsPlaylistId,
    maxResults: String(Math.min(Math.max(maxResults, 1), 50)),
  });
  const data = await fetchYouTubeJsonWithQuota(
    `${BASE_URL}/playlistItems`,
    params,
    "playlistItems",
    QUOTA_COST.playlistItems,
  );
  const items: any[] = Array.isArray(data.items) ? data.items : [];
  const ids = items
    .map((it: any) => it?.contentDetails?.videoId)
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
  return ids.slice(0, maxResults);
}

// 2g — videos.list batched 50 -> stats needed for compute
export interface VideoStats {
  videoId: string;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  publishedAt?: string;
}

export async function fetchVideoStatsBatch(videoIds: string[]): Promise<Map<string, VideoStats>> {
  const out = new Map<string, VideoStats>();
  const chunks = chunkArray(videoIds, 50);
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      part: "snippet,statistics",
      id: chunk.join(","),
    });
    const data = await fetchYouTubeJsonWithQuota(`${BASE_URL}/videos`, params, "videos", QUOTA_COST.videos);
    const items: any[] = Array.isArray(data.items) ? data.items : [];
    for (const v of items) {
      const id: string | undefined = v?.id;
      if (typeof id !== "string" || !id) continue;
      out.set(id, {
        videoId: id,
        viewCount: parseOptionalCount(v?.statistics?.viewCount),
        likeCount: parseOptionalCount(v?.statistics?.likeCount),
        commentCount: parseOptionalCount(v?.statistics?.commentCount),
        publishedAt: typeof v?.snippet?.publishedAt === "string" ? v.snippet.publishedAt : undefined,
      });
    }
  }
  return out;
}

// 2h — compute helpers (exported for unit testing)
export function computeChannelMetrics(videos: VideoStats[]): {
  avg_views: number | null;
  engagement_rate_pct: number | null;
  last_upload_date: string | null;
  days_since_last_upload: number | null;
} {
  const last_upload_date = mostRecentPublishDate(videos);
  const days_since_last_upload = computeDaysSince(last_upload_date);
  const avg_views = computeAvgViews(videos.map((v) => v.viewCount));
  const engagement_rate_pct = computeEngagementRatePct(videos);
  return { avg_views, engagement_rate_pct, last_upload_date, days_since_last_upload };
}

function passesScoutFilters(
  metrics: { avg_views: number | null; days_since_last_upload: number | null; engagement_rate_pct: number | null },
  filters: ScoutFilters,
): boolean {
  if (typeof metrics.days_since_last_upload === "number" && metrics.days_since_last_upload > filters.maxDaysSinceUpload) {
    return false;
  }
  if (metrics.days_since_last_upload === null) {
    // No uploads -> treat as failing recency filter
    return false;
  }
  if (metrics.avg_views === null || metrics.avg_views < filters.minAvgViews) return false;
  if (typeof filters.minEngagementRate === "number") {
    if (metrics.engagement_rate_pct === null || metrics.engagement_rate_pct < filters.minEngagementRate) return false;
  }
  return true;
}

/**
 * Full per-keyword discovery pipeline (2a-2j).
 * - Searches for `keyword`, dedups, skips known channels (2b), enriches,
 *   applies hidden/out-of-range short-circuits (2d-2e), then for remaining
 *   channels fetches recent videos and computes metrics (2f-2h), applies
 *   final filters (2i), and records every evaluated channel (qualified
 *   true/false) so it is never re-fetched. Every YouTube call is
 *   quota-counted (2j) via fetchYouTubeJsonWithQuota.
 * Returns only the qualified channels discovered for this keyword.
 */
export async function discoverChannelsForKeyword(
  keyword: string,
  filters: ScoutFilters,
): Promise<ChannelRecord[]> {
  const trimmed = keyword.trim();
  if (!trimmed) return [];

  // 2a
  const channelIds = await searchChannelIdsForKeyword(trimmed);
  if (channelIds.length === 0) return [];

  // 2b — skip already-known channels entirely
  const unknownIds = channelIds.filter((id) => !isChannelKnown(id));
  if (unknownIds.length === 0) return [];

  // 2c
  const channelMap = await fetchChannelsBatch(unknownIds);

  const qualified: ChannelRecord[] = [];
  const nowIso = new Date().toISOString();

  for (const channelId of unknownIds) {
    const raw = channelMap.get(channelId);

    // Channel not returned by channels.list (deleted/private) — record as not qualified
    if (!raw) {
      recordChannel({
        channel_id: channelId,
        channel_name: channelId,
        channel_url: channelUrlForId(channelId),
        subscriber_count: null,
        avg_views: null,
        engagement_rate_pct: null,
        last_upload_date: null,
        days_since_last_upload: null,
        matched_keyword: trimmed,
        qualified: false,
        first_seen_at: nowIso,
      });
      continue;
    }

    // 2d — hidden subscriber count -> always exclude, never estimate
    if (raw.hiddenSubscriberCount) {
      recordChannel({
        channel_id: raw.channelId,
        channel_name: raw.channelName,
        channel_url: channelUrlForId(raw.channelId),
        subscriber_count: null,
        avg_views: null,
        engagement_rate_pct: null,
        last_upload_date: null,
        days_since_last_upload: null,
        matched_keyword: trimmed,
        qualified: false,
        first_seen_at: nowIso,
      });
      continue;
    }

    const subs = raw.subscriberCount;
    // 2e — subscriber range (still record so never re-checked)
    if (typeof subs !== "number" || subs < filters.minSubscribers || subs > filters.maxSubscribers) {
      recordChannel({
        channel_id: raw.channelId,
        channel_name: raw.channelName,
        channel_url: channelUrlForId(raw.channelId),
        subscriber_count: subs ?? null,
        avg_views: null,
        engagement_rate_pct: null,
        last_upload_date: null,
        days_since_last_upload: null,
        matched_keyword: trimmed,
        qualified: false,
        first_seen_at: nowIso,
      });
      continue;
    }

    // 2f — recent video IDs (up to 10) via uploads playlist
    let videoIds: string[] = [];
    if (raw.uploadsPlaylistId) {
      try {
        videoIds = await fetchRecentVideoIdsForPlaylist(raw.uploadsPlaylistId, 10);
      } catch (e) {
        // Playlist fetch failed -> record as not qualified (quota/network handled via ProviderError)
        // Re-throw quota errors so caller can handle; otherwise record and continue
        if (e instanceof ProviderError && e.category === "quota") throw e;
        recordChannel({
          channel_id: raw.channelId,
          channel_name: raw.channelName,
          channel_url: channelUrlForId(raw.channelId),
          subscriber_count: subs,
          avg_views: null,
          engagement_rate_pct: null,
          last_upload_date: null,
          days_since_last_upload: null,
          matched_keyword: trimmed,
          qualified: false,
          first_seen_at: nowIso,
        });
        continue;
      }
    }

    // 2g — video stats
    let videoStatsList: VideoStats[] = [];
    if (videoIds.length > 0) {
      try {
        const statsMap = await fetchVideoStatsBatch(videoIds);
        videoStatsList = videoIds
          .map((id) => statsMap.get(id))
          .filter((v): v is VideoStats => Boolean(v));
      } catch (e) {
        if (e instanceof ProviderError && e.category === "quota") throw e;
        videoStatsList = [];
      }
    }

    // 2h — compute metrics
    const metrics = computeChannelMetrics(videoStatsList);

    // 2i — final filters (record either way)
    const passed = passesScoutFilters(metrics, filters);
    const rec: ChannelRecord = {
      channel_id: raw.channelId,
      channel_name: raw.channelName,
      channel_url: channelUrlForId(raw.channelId),
      subscriber_count: subs,
      avg_views: metrics.avg_views,
      engagement_rate_pct: metrics.engagement_rate_pct,
      last_upload_date: metrics.last_upload_date,
      days_since_last_upload: metrics.days_since_last_upload,
      matched_keyword: trimmed,
      qualified: passed,
      first_seen_at: nowIso,
    };
    recordChannel(rec);
    if (passed) qualified.push(rec);
  }

  return qualified;
}

// ---------------------------------------------------------------------------
// Step 3 — Whole-run orchestrator with stop conditions
// Stop as soon as: (a) target qualified count reached, (b) all keywords
// exhausted, or (c) all keys exhausted for today. Never throws quota —
// returns partial qualified results with a clear status.
// ---------------------------------------------------------------------------

export type ScoutStopReason = "target_reached" | "keywords_exhausted" | "quota_exhausted";

export interface ScoutRunOptions {
  keywords: string[];
  filters: ScoutFilters;
  targetCount: number;
}

export interface ScoutRunResult {
  qualifiedChannels: ChannelRecord[];
  stopReason: ScoutStopReason;
  found: number;
  requested: number;
  keywordsSearched: number;
}

export async function runScoutDiscovery(options: ScoutRunOptions): Promise<ScoutRunResult> {
  const keywords = options.keywords.map((k) => k.trim()).filter(Boolean);
  const targetCount = Math.max(1, Math.floor(options.targetCount));

  if (keywords.length === 0) {
    return {
      qualifiedChannels: [],
      stopReason: "keywords_exhausted",
      found: 0,
      requested: targetCount,
      keywordsSearched: 0,
    };
  }

  // Fail fast if no key has any remaining quota
  if (!pickAvailableKey(QUOTA_COST.search)) {
    return {
      qualifiedChannels: [],
      stopReason: "quota_exhausted",
      found: 0,
      requested: targetCount,
      keywordsSearched: 0,
    };
  }

  const qualifiedChannels: ChannelRecord[] = [];
  let keywordsSearched = 0;

  for (const keyword of keywords) {
    // Check target before starting next keyword
    if (qualifiedChannels.length >= targetCount) break;

    // Check quota before starting next keyword (needs at least one search call)
    if (!pickAvailableKey(QUOTA_COST.search)) {
      return {
        qualifiedChannels: qualifiedChannels.slice(0, targetCount),
        stopReason: "quota_exhausted",
        found: qualifiedChannels.length,
        requested: targetCount,
        keywordsSearched,
      };
    }

    let batch: ChannelRecord[];
    try {
      batch = await discoverChannelsForKeyword(keyword, options.filters);
    } catch (e) {
      if (isQuotaError(e)) {
        // Entire run is out of quota (rotation already tried inside fetchYouTubeJsonWithQuota)
        return {
          qualifiedChannels: qualifiedChannels.slice(0, targetCount),
          stopReason: "quota_exhausted",
          found: qualifiedChannels.length,
          requested: targetCount,
          keywordsSearched,
        };
      }
      throw e;
    }

    keywordsSearched += 1;

    for (const ch of batch) {
      if (qualifiedChannels.length >= targetCount) break;
      qualifiedChannels.push(ch);
    }

    if (qualifiedChannels.length >= targetCount) {
      return {
        qualifiedChannels: qualifiedChannels.slice(0, targetCount),
        stopReason: "target_reached",
        found: qualifiedChannels.length >= targetCount ? targetCount : qualifiedChannels.length,
        requested: targetCount,
        keywordsSearched,
      };
    }
  }

  // All keywords exhausted without hitting target
  if (!pickAvailableKey(1)) {
    return {
      qualifiedChannels,
      stopReason: "quota_exhausted",
      found: qualifiedChannels.length,
      requested: targetCount,
      keywordsSearched,
    };
  }

  return {
    qualifiedChannels,
    stopReason: "keywords_exhausted",
    found: qualifiedChannels.length,
    requested: targetCount,
    keywordsSearched,
  };
}
