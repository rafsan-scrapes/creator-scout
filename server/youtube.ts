import type { Video, SearchFilters, SearchResponse } from "@shared/schema";
import { UploadDateFilter, DurationFilter, SortBy } from "@shared/schema";
import { createHash } from "node:crypto";
import { ProviderError } from "./provider-errors";
import { addUsage, getUsageToday, isChannelKnown, recordChannel } from "./db";
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

function getPublishedAfter(uploadDate: UploadDateFilter): string | undefined {
  const now = new Date();

  switch (uploadDate) {
    case UploadDateFilter.HOUR:
      now.setHours(now.getHours() - 1);
      return now.toISOString();
    case UploadDateFilter.TODAY:
      now.setHours(0, 0, 0, 0);
      return now.toISOString();
    case UploadDateFilter.WEEK:
      now.setDate(now.getDate() - 7);
      return now.toISOString();
    case UploadDateFilter.MONTH:
      now.setMonth(now.getMonth() - 1);
      return now.toISOString();
    case UploadDateFilter.YEAR:
      now.setFullYear(now.getFullYear() - 1);
      return now.toISOString();
    default:
      return undefined;
  }
}

function getVideoDuration(duration: DurationFilter): string | undefined {
  switch (duration) {
    case DurationFilter.SHORT:
      return "short";
    case DurationFilter.MEDIUM:
      return "medium";
    case DurationFilter.LONG:
      return "long";
    default:
      return undefined;
  }
}

function getOrderBy(sortBy: SortBy): string {
  switch (sortBy) {
    case SortBy.DATE:
      return "date";
    case SortBy.VIEW_COUNT:
      return "viewCount";
    case SortBy.RATING:
      return "rating";
    default:
      return "relevance";
  }
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

/**
 * Quota-aware fetch: picks an available key for the given stage/cost,
 * appends `key=`, calls YouTube, then increments `api_key_usage`.
 * Proactive rotation — never waits for a 403 to rotate.
 */
async function fetchYouTubeJsonWithQuota(
  baseUrl: string,
  params: URLSearchParams,
  stage: string,
  cost: number,
): Promise<any> {
  const picked = requireAvailableKey(cost, stage);
  const url = `${baseUrl}?${params.toString()}&key=${encodeURIComponent(picked.key)}`;
  const data = await fetchYouTubeJson(url, stage);
  addUsage(picked.label, cost);
  return data;
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
// Legacy Research search — preserved for now (uses single-key path before
// this rework; kept so existing /api/youtube/search route still works until
// Phase 4 replaces it). New Scout code above is the forward path.
// ---------------------------------------------------------------------------

export function createSnapshotId(filters: SearchFilters, orderedVideoIds: string[], retrievedAt: string): string {
  const identity = JSON.stringify({
    query: filters.query.trim(),
    uploadDate: filters.uploadDate,
    duration: filters.duration,
    sortBy: filters.sortBy,
    maxResults: filters.maxResults,
    orderedVideoIds,
    retrievedAt,
  });
  return `yt_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

export async function searchVideos(filters: SearchFilters): Promise<SearchResponse> {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim() || getYouTubeApiKeys()[0];
  if (!apiKey) {
    throw new ProviderError({
      message: "YouTube API key is not configured.",
      category: "missing_key",
      code: "YOUTUBE_MISSING_KEY",
      status: 503,
      retryable: false,
    });
  }

  const params = new URLSearchParams({
    part: "snippet",
    q: filters.query,
    type: "video",
    maxResults: String(filters.maxResults || 25),
    key: apiKey,
    order: getOrderBy(filters.sortBy),
  });

  const publishedAfter = getPublishedAfter(filters.uploadDate);
  if (publishedAfter) {
    params.set("publishedAfter", publishedAfter);
  }

  const videoDuration = getVideoDuration(filters.duration);
  if (videoDuration) {
    params.set("videoDuration", videoDuration);
  }

  const searchUrl = `${BASE_URL}/search?${params}`;
  const searchData = await fetchYouTubeJson(searchUrl, "search");
  const retrievedAt = new Date().toISOString();
  const warnings: SearchResponse["warnings"] = [];
  if (!Array.isArray(searchData.items)) {
    throw new ProviderError({
      message: "YouTube returned an invalid search response.",
      category: "invalid_response",
      code: "YOUTUBE_INVALID_RESPONSE",
      status: 502,
      retryable: false,
    });
  }

  if (searchData.items.length === 0) {
    const orderedVideoIds: string[] = [];
    return {
      videos: [],
      totalResults: 0,
      resultsPerPage: 0,
      regionCode: typeof searchData.regionCode === "string" ? searchData.regionCode : undefined,
      snapshotId: createSnapshotId(filters, orderedVideoIds, retrievedAt),
      retrievedAt,
      totalResultsIsApproximate: true,
      provenance: {
        provider: "youtube-data-api-v3",
        query: filters.query.trim(),
        filters: {
          uploadDate: filters.uploadDate,
          duration: filters.duration,
          sortBy: filters.sortBy,
          maxResults: filters.maxResults,
        },
        orderedVideoIds,
      },
      enrichment: {
        search: { status: "complete", requested: filters.maxResults, returned: 0 },
        videoDetails: { status: "skipped", requested: 0, returned: 0 },
        channels: { status: "skipped", requested: 0, returned: 0 },
      },
      warnings,
    };
  }

  const orderedVideoIds: string[] = searchData.items
    .map((item: any) => item.id?.videoId)
    .filter((id: unknown): id is string => typeof id === "string");
  if (orderedVideoIds.length !== searchData.items.length) {
    warnings.push({
      code: "SEARCH_ITEMS_OMITTED",
      stage: "search",
      message: "Some search rows did not contain a public video identifier and were omitted.",
    });
  }
  if (orderedVideoIds.length === 0) {
    return {
      videos: [],
      totalResults: parseOptionalCount(searchData.pageInfo?.totalResults) ?? 0,
      resultsPerPage: parseOptionalCount(searchData.pageInfo?.resultsPerPage) ?? 0,
      regionCode: typeof searchData.regionCode === "string" ? searchData.regionCode : undefined,
      snapshotId: createSnapshotId(filters, orderedVideoIds, retrievedAt),
      retrievedAt,
      totalResultsIsApproximate: true,
      provenance: {
        provider: "youtube-data-api-v3",
        query: filters.query.trim(),
        filters: {
          uploadDate: filters.uploadDate,
          duration: filters.duration,
          sortBy: filters.sortBy,
          maxResults: filters.maxResults,
        },
        orderedVideoIds,
      },
      enrichment: {
        search: { status: "partial", requested: filters.maxResults, returned: 0 },
        videoDetails: { status: "skipped", requested: 0, returned: 0 },
        channels: { status: "skipped", requested: 0, returned: 0 },
      },
      warnings,
    };
  }
  const videoIds = orderedVideoIds.join(",");

  const detailsParams = new URLSearchParams({
    part: "snippet,statistics,contentDetails,status,topicDetails,paidProductPlacementDetails,liveStreamingDetails",
    id: videoIds,
    key: apiKey,
  });

  const detailsUrl = `${BASE_URL}/videos?${detailsParams}`;
  const detailsData = await fetchYouTubeJson(detailsUrl, "video details");
  if (!Array.isArray(detailsData.items)) {
    throw new ProviderError({
      message: "YouTube returned an invalid video-details response.",
      category: "invalid_response",
      code: "YOUTUBE_INVALID_RESPONSE",
      status: 502,
      retryable: false,
    });
  }
  if (detailsData.items.length !== orderedVideoIds.length) {
    warnings.push({
      code: "VIDEO_DETAILS_PARTIAL",
      stage: "video_details",
      message: "Some search results no longer had public video details and were omitted.",
    });
  }
  const channelIds = Array.from(new Set(
    detailsData.items
      .map((item: any) => item.snippet?.channelId)
      .filter((id: unknown): id is string => typeof id === "string"),
  ));

  const channelDetails = new Map<string, any>();
  let channelStatus: "complete" | "partial" | "skipped" = channelIds.length > 0 ? "complete" : "skipped";
  if (channelIds.length > 0) {
    const channelParams = new URLSearchParams({
      part: "snippet,statistics,topicDetails,brandingSettings",
      id: channelIds.join(","),
      maxResults: "50",
      key: apiKey,
    });

    try {
      const channelData = await fetchYouTubeJson(`${BASE_URL}/channels?${channelParams}`, "channel enrichment");
      for (const channel of Array.isArray(channelData.items) ? channelData.items : []) {
        channelDetails.set(channel.id, channel);
      }
      if (channelDetails.size !== channelIds.length) channelStatus = "partial";
    } catch {
      channelStatus = "partial";
    }
    if (channelStatus === "partial") {
      warnings.push({
        code: "CHANNEL_ENRICHMENT_PARTIAL",
        stage: "channel_enrichment",
        message: "Channel-level public metadata was unavailable for some or all videos.",
      });
    }
  }

  const detailsById = new Map<string, any>(
    detailsData.items.map((item: any) => [item.id, item]),
  );

  const videos: Video[] = orderedVideoIds.flatMap((id) => {
    const item = detailsById.get(id);
    if (!item) return [];
    const channel = channelDetails.get(item.snippet.channelId);
    const channelStats = channel?.statistics;

    return [{
      id: item.id,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      channelId: item.snippet.channelId,
      publishedAt: item.snippet.publishedAt,
      thumbnailUrl: item.snippet.thumbnails?.maxres?.url
        || item.snippet.thumbnails?.standard?.url
        || item.snippet.thumbnails?.high?.url
        || item.snippet.thumbnails?.medium?.url
        || item.snippet.thumbnails?.default?.url,
      description: item.snippet.description,
      viewCount: parseOptionalCount(item.statistics?.viewCount),
      likeCount: parseOptionalCount(item.statistics?.likeCount),
      commentCount: parseOptionalCount(item.statistics?.commentCount),
      duration: item.contentDetails?.duration,
      tags: item.snippet.tags,
      categoryId: item.snippet.categoryId,
      liveBroadcastContent: item.snippet.liveBroadcastContent,
      defaultLanguage: item.snippet.defaultLanguage,
      defaultAudioLanguage: item.snippet.defaultAudioLanguage,
      definition: item.contentDetails?.definition,
      hasCaptions: item.contentDetails?.caption === "true"
        ? true
        : item.contentDetails?.caption === "false"
          ? false
          : undefined,
      licensedContent: item.contentDetails?.licensedContent,
      embeddable: item.status?.embeddable,
      madeForKids: item.status?.madeForKids,
      hasPaidProductPlacement: item.paidProductPlacementDetails?.hasPaidProductPlacement,
      topicCategories: item.topicDetails?.topicCategories,
      liveStreamingDetails: item.liveStreamingDetails ? {
        actualStartTime: item.liveStreamingDetails.actualStartTime,
        actualEndTime: item.liveStreamingDetails.actualEndTime,
        scheduledStartTime: item.liveStreamingDetails.scheduledStartTime,
        concurrentViewers: parseOptionalCount(item.liveStreamingDetails.concurrentViewers),
      } : undefined,
      channelStatistics: channel ? {
        subscriberCount: channelStats?.hiddenSubscriberCount
          ? undefined
          : parseOptionalCount(channelStats?.subscriberCount),
        hiddenSubscriberCount: Boolean(channelStats?.hiddenSubscriberCount),
        videoCount: parseOptionalCount(channelStats?.videoCount),
        viewCount: parseOptionalCount(channelStats?.viewCount),
        publishedAt: channel.snippet?.publishedAt,
        country: channel.snippet?.country,
        thumbnailUrl: channel.snippet?.thumbnails?.default?.url,
        description: channel.snippet?.description,
        customUrl: channel.snippet?.customUrl,
        defaultLanguage: channel.brandingSettings?.channel?.defaultLanguage,
        keywords: channel.brandingSettings?.channel?.keywords,
        topicCategories: channel.topicDetails?.topicCategories,
      } : undefined,
    }];
  });

  return {
    videos,
    totalResults: searchData.pageInfo?.totalResults || videos.length,
    nextPageToken: searchData.nextPageToken,
    resultsPerPage: searchData.pageInfo?.resultsPerPage || videos.length,
    regionCode: searchData.regionCode,
    snapshotId: createSnapshotId(filters, orderedVideoIds, retrievedAt),
    retrievedAt,
    totalResultsIsApproximate: true,
    provenance: {
      provider: "youtube-data-api-v3",
      query: filters.query.trim(),
      filters: {
        uploadDate: filters.uploadDate,
        duration: filters.duration,
        sortBy: filters.sortBy,
        maxResults: filters.maxResults,
      },
      orderedVideoIds,
    },
    enrichment: {
      search: { status: "complete", requested: filters.maxResults, returned: orderedVideoIds.length },
      videoDetails: {
        status: detailsData.items.length === orderedVideoIds.length ? "complete" : "partial",
        requested: orderedVideoIds.length,
        returned: detailsData.items.length,
      },
      channels: {
        status: channelStatus,
        requested: channelIds.length,
        returned: channelDetails.size,
      },
    },
    warnings,
  };
}
