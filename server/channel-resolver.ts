import { isChannelKnown } from "./db";
import {
  QUOTA_COST,
  YOUTUBE_BASE_URL,
  fetchYouTubeJsonWithQuota,
} from "./youtube";

// ---------------------------------------------------------------------------
// Phase 8 step 5 — channel-identifier resolver for manual adds.
// Turns whatever the user pastes (bare channel ID, /channel/ URL, @handle,
// /user/ URL, /c/ URL) into a canonical { channelId, channelUrl, channelName }.
// Every resolution call goes through fetchYouTubeJsonWithQuota — a manual add
// is a real, billable YouTube API call and participates in the same quota
// tracking and key rotation as a scout run.
// ---------------------------------------------------------------------------

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE_BODY_RE = /^[A-Za-z0-9._-]+$/;
// Defensive cap — the route validates length too; the resolver must never
// crash or build absurd URLs from unbounded input.
const MAX_INPUT_LENGTH = 500;

export type ParsedChannelIdentifier =
  | { kind: "channel-id"; channelId: string }
  | { kind: "handle"; handle: string } // canonical form, leading @ included
  | { kind: "username"; username: string }
  | { kind: "custom"; customName: string }
  | { kind: "invalid" };

// Pure parse — no API calls. Exported for unit testing.
export function parseChannelIdentifier(rawInput: string): ParsedChannelIdentifier {
  const input = rawInput.trim();
  if (!input || input.length > MAX_INPUT_LENGTH) return { kind: "invalid" };

  // Bare channel ID (case a without the URL wrapper).
  if (CHANNEL_ID_RE.test(input)) return { kind: "channel-id", channelId: input };

  // Bare @handle (case b without the URL wrapper).
  if (input.startsWith("@")) {
    const body = input.slice(1).split(/[\s/]/)[0] ?? "";
    if (body && HANDLE_BODY_RE.test(body)) return { kind: "handle", handle: `@${body}` };
    return { kind: "invalid" };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { kind: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "invalid" };
  const host = url.hostname.toLowerCase();
  if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return { kind: "invalid" };

  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const first = segments[0];
  if (!first) return { kind: "invalid" };

  // Case a — /channel/UC...
  if (first === "channel") {
    const id = segments[1];
    if (id && CHANNEL_ID_RE.test(id)) return { kind: "channel-id", channelId: id };
    return { kind: "invalid" };
  }

  // Case b — /@handle (trailing path like /featured or /about is ignored).
  if (first.startsWith("@")) {
    const body = first.slice(1);
    if (body && HANDLE_BODY_RE.test(body)) return { kind: "handle", handle: `@${body}` };
    return { kind: "invalid" };
  }

  // Case c — legacy /user/Username.
  if (first === "user") {
    const username = segments[1];
    if (username) return { kind: "username", username };
    return { kind: "invalid" };
  }

  // Case d — legacy /c/CustomName.
  if (first === "c") {
    const customName = segments[1];
    if (customName) return { kind: "custom", customName };
    return { kind: "invalid" };
  }

  // /watch, /playlist, /shorts, /results, bare domain, etc. — not a channel.
  return { kind: "invalid" };
}

export interface ResolvedChannel {
  channelId: string;
  channelUrl: string;
  channelName: string;
}

export type ChannelResolution =
  | { status: "resolved"; channel: ResolvedChannel; quotaCost: number }
  | { status: "already-in-history" };

// Resolver-level failures. Quota/key/network/provider failures propagate as
// ProviderError from fetchYouTubeJsonWithQuota; the step 6 route maps
// invalid-input -> user-readable "invalid format" and channel-not-found ->
// "channel not found".
export class ChannelResolveError extends Error {
  readonly code: "invalid-input" | "channel-not-found";

  constructor(code: ChannelResolveError["code"], message: string) {
    super(message);
    this.name = "ChannelResolveError";
    this.code = code;
  }
}

function channelUrlForId(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}`;
}

function titleOf(item: any, fallback: string): string {
  const title = item?.snippet?.title;
  if (typeof title === "string" && title.trim()) return title;
  const channelTitle = item?.snippet?.channelTitle;
  if (typeof channelTitle === "string" && channelTitle.trim()) return channelTitle;
  return fallback;
}

// channels.list?id=... — 1 unit. Confirms the ID is real and fetches the
// current display name so a mistyped ID never silently sits in history.
async function fetchChannelById(channelId: string): Promise<ResolvedChannel | null> {
  const params = new URLSearchParams({ part: "snippet", id: channelId, maxResults: "1" });
  const data = await fetchYouTubeJsonWithQuota(
    `${YOUTUBE_BASE_URL}/channels`,
    params,
    "manual-add-resolve-id",
    QUOTA_COST.channels,
  );
  const item = Array.isArray(data?.items) ? data.items[0] : undefined;
  const id = item?.id;
  if (typeof id !== "string" || !id) return null;
  return { channelId: id, channelUrl: channelUrlForId(id), channelName: titleOf(item, id) };
}

// channels.list?forHandle=... — 1 unit. The API accepts the handle with or
// without the leading @; we pass the canonical @ form.
async function fetchChannelByHandle(handle: string): Promise<ResolvedChannel | null> {
  const params = new URLSearchParams({ part: "snippet", forHandle: handle, maxResults: "1" });
  const data = await fetchYouTubeJsonWithQuota(
    `${YOUTUBE_BASE_URL}/channels`,
    params,
    "manual-add-resolve-handle",
    QUOTA_COST.channels,
  );
  const item = Array.isArray(data?.items) ? data.items[0] : undefined;
  const id = item?.id;
  if (typeof id !== "string" || !id) return null;
  return { channelId: id, channelUrl: channelUrlForId(id), channelName: titleOf(item, id) };
}

// channels.list?forUsername=... — 1 unit.
async function fetchChannelByUsername(username: string): Promise<ResolvedChannel | null> {
  const params = new URLSearchParams({ part: "snippet", forUsername: username, maxResults: "1" });
  const data = await fetchYouTubeJsonWithQuota(
    `${YOUTUBE_BASE_URL}/channels`,
    params,
    "manual-add-resolve-username",
    QUOTA_COST.channels,
  );
  const item = Array.isArray(data?.items) ? data.items[0] : undefined;
  const id = item?.id;
  if (typeof id !== "string" || !id) return null;
  return { channelId: id, channelUrl: channelUrlForId(id), channelName: titleOf(item, id) };
}

// search.list?type=channel&q=... — 100 units. /c/ URLs are not reliably
// resolvable via channels.list, so this takes the top match. The step 8
// History UI must note this cost under the input rather than spending it
// silently.
async function searchChannelByCustomName(customName: string): Promise<ResolvedChannel | null> {
  const params = new URLSearchParams({
    part: "snippet",
    type: "channel",
    q: customName,
    maxResults: "1",
  });
  const data = await fetchYouTubeJsonWithQuota(
    `${YOUTUBE_BASE_URL}/search`,
    params,
    "manual-add-resolve-custom",
    QUOTA_COST.search,
  );
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  const item = items.find((entry) => typeof entry?.id?.channelId === "string");
  const id: string | undefined = item?.id?.channelId;
  if (!id) return null;
  return { channelId: id, channelUrl: channelUrlForId(id), channelName: titleOf(item, id) };
}

/**
 * Resolve a pasted channel identifier to its canonical channel.
 * - Case a (bare ID or /channel/ URL): if the ID is already in history,
 *   return "already-in-history" WITHOUT any API call (quota saved).
 *   Otherwise confirm via channels.list?id=... (1 unit).
 * - Cases b/c (@handle, /user/): channels.list (1 unit each).
 * - Case d (/c/): search.list (100 units), top match wins.
 * Throws ChannelResolveError("invalid-input" | "channel-not-found") for
 * unresolvable input; ProviderError (quota etc.) propagates untouched.
 */
export async function resolveChannelIdentifier(rawInput: string): Promise<ChannelResolution> {
  const parsed = parseChannelIdentifier(rawInput);

  if (parsed.kind === "invalid") {
    throw new ChannelResolveError(
      "invalid-input",
      "That doesn't look like a YouTube channel — paste a channel link, @handle, or channel ID.",
    );
  }

  if (parsed.kind === "channel-id") {
    // Step f — the one case where the ID is knowable without an API call.
    if (isChannelKnown(parsed.channelId)) return { status: "already-in-history" };
    const channel = await fetchChannelById(parsed.channelId);
    if (!channel) {
      throw new ChannelResolveError(
        "channel-not-found",
        "No YouTube channel exists with that channel ID — check for a typo and try again.",
      );
    }
    return { status: "resolved", channel, quotaCost: QUOTA_COST.channels };
  }

  if (parsed.kind === "handle") {
    const channel = await fetchChannelByHandle(parsed.handle);
    if (!channel) {
      throw new ChannelResolveError(
        "channel-not-found",
        `No YouTube channel exists with the handle ${parsed.handle}.`,
      );
    }
    return { status: "resolved", channel, quotaCost: QUOTA_COST.channels };
  }

  if (parsed.kind === "username") {
    const channel = await fetchChannelByUsername(parsed.username);
    if (!channel) {
      throw new ChannelResolveError(
        "channel-not-found",
        `No YouTube channel exists with the username ${parsed.username}.`,
      );
    }
    return { status: "resolved", channel, quotaCost: QUOTA_COST.channels };
  }

  const channel = await searchChannelByCustomName(parsed.customName);
  if (!channel) {
    throw new ChannelResolveError(
      "channel-not-found",
      `No YouTube channel matched "${parsed.customName}".`,
    );
  }
  return { status: "resolved", channel, quotaCost: QUOTA_COST.search };
}
