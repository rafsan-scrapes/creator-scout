# Creator Scout — Discovery Playbook

Last reviewed: 2026-09-07 (Scout rework)

> **Rework note:** This playbook replaces the previous YouTube Research Playbook (Research → Insights → Ideas → Script → Thumbnail, evidence labels, AI prompt contract). That workflow and its Gemini integration have been removed. The current product is the single-page Creator Scout described in `README.md` and `context/project-overview.md`.

This is the operating reference for the Scout discovery pipeline. It translates the product promise into pipeline rules, then separates those rules from what the YouTube Data API v3 can actually provide.

## The product promise

Given keywords and filters, find up to N YouTube channels that match all filters, using only the YouTube Data API v3 — then never show the same channel again. Runs end cleanly with partial results if quota is exhausted.

## Pipeline

For each keyword, in order:

1. `search.list` with `part=snippet`, `type=video` (100 units/call) — collect video results, extract unique `channelId` values. Video search is intentional: channel-search only matches names/descriptions, while video search finds channels actively producing on-topic content.
2. For each candidate `channelId`, check `isChannelKnown(channelId)` against `data/scout.db`. If known, skip entirely — no further API spend, regardless of keyword.
3. Batch remaining IDs into `channels.list` (up to 50 IDs/call, 1 unit/call) — `statistics.subscriberCount`, `statistics.hiddenSubscriberCount`, `contentDetails.relatedPlaylists.uploads`, `snippet`.
4. If `hiddenSubscriberCount` is true → `recordChannel(..., qualified=false)` and stop for that channel. Never estimate.
5. If subscriber count is outside `[minSubscribers, maxSubscribers]` → `recordChannel(..., qualified=false)` and stop. Still record, so it is never re-checked.
6. `playlistItems.list` (1 unit) on the uploads playlist — up to 10 most recent video IDs. This is used instead of a second `search.list` (100 units) — the single biggest quota saving in the pipeline.
7. Batch video IDs into `videos.list` (up to 50 IDs/call, 1 unit/call) — `statistics.viewCount`, `statistics.likeCount`, `statistics.commentCount`, `snippet.publishedAt` per video.
8. Compute:
   - `avg_views` — mean of `viewCount` across retrieved videos (up to 10).
   - `days_since_last_upload` — from the most recent video's `publishedAt`.
   - `engagement_rate_pct` — mean of `(likeCount + commentCount) / viewCount * 100` across the same videos; skip any video where `viewCount` is 0/missing and leave `null` if none are computable. This is derived — YouTube has no native "engagement rate" field.
9. Apply `maxDaysSinceUpload`, `minAvgViews`, and optional `minEngagementRate` filters → `recordChannel(..., qualified=true/false)`.
10. After every YouTube call, `addUsage(keyLabel, units)` for proactive rotation. On `403 quotaExceeded`, mark the key exhausted for today, rotate to the next key, retry once. No keys left → stop gracefully with accumulated qualified channels.

Stop the whole run when the first of these is true: qualified count reaches `targetCount`, all keywords are exhausted, or every configured key is out of quota for the day.

## Public API coverage

Useful public fields in this pipeline:

- Channel: `subscriberCount`, `hiddenSubscriberCount`, uploads playlist ID, channel title/handle.
- Video: `viewCount`, `likeCount`, `commentCount`, `publishedAt`.

Useful deterministic views: `avg_views`, `days_since_last_upload`, `engagement_rate_pct` (all computed locally from the fields above).

Important caveats:

- `hiddenSubscriberCount=true` means subscriber filtering is impossible — exclude, don't guess.
- `videos.list` counts are public totals at call time, not historical values.
- `search.list` results are a relevance snapshot, not a market census.
- A video under four minutes is not necessarily a Short — don't label it as one.
- Missing or hidden values stay unavailable, never zero-filled.

## What the pipeline does not do

- No search-volume, CTR, retention, watch-time, traffic-source, revenue, or private audience metrics — those require YouTube Analytics/Reporting APIs and channel-owner authorization. Scout never invents them.
- No thumbnail-pixel inspection.
- No CSV export, no AI insights, no script/thumbnail generation.

## Quota model

- `search.list` = 100 units/call; `channels.list` = 1 unit/call; `videos.list` = 1 unit/call; `playlistItems.list` = 1 unit/call. Batching up to 50 IDs does not increase cost. If Google changes these, update the constants in `server/youtube.ts` in one place.
- Quota resets at midnight Pacific — `api_key_usage.date` is stored as `YYYY-MM-DD` in Pacific time.
- Rotation is proactive (counted per call) with `403 quotaExceeded` as a backstop, not the primary mechanism.

## Current primary sources

- YouTube Data API quota costs: https://developers.google.com/youtube/v3/determine_quota_cost
- `search.list`: https://developers.google.com/youtube/v3/docs/search/list
- `channels.list`: https://developers.google.com/youtube/v3/docs/channels/list
- `videos.list`: https://developers.google.com/youtube/v3/docs/videos/list
- `playlistItems.list`: https://developers.google.com/youtube/v3/docs/playlistItems/list
- YouTube API Services Developer Policies: https://developers.google.com/youtube/terms/developer-policies
