# Progress Tracker

Update this file after every meaningful implementation
change. Move finished items from "Next Up" into "Completed",
keep "Current Phase" and "Current Goal" pointed at whatever
is actually being worked on right now, and add anything you
learn or decide to "Architecture Decisions" or "Session Notes"
so the next session doesn't have to rediscover it.

## Current Phase

- Phase 3 — Rework the YouTube service

## Current Goal

- Phase 3 — Rework the YouTube service — all steps 1-4 complete, verify before Phase 4

## Completed

- Phase 0
- Phase 1 — Strip the app down (2026-09-08)
- Phase 2 — Add the SQLite persistence layer (2026-09-08)
- Phase 3 — Rework the YouTube service (2026-09-08) — steps 1-4 complete (see Session Notes)

## In Progress

- None — Phase 4 ready to start
## Next Up

Work through these phases in order. Do not skip ahead — later
phases assume earlier ones are done and verified. Within a
phase, do the listed steps in order too.

### Phase 0 — Orientation (do this first, every session)

1. Read `project-overview.md` in full.
2. Read `HANDOFF.md` and `README.md` in the current repo to
   understand what exists today.
3. Read this file in full, including Architecture Decisions
   below, before touching code.
4. Do not make any live YouTube or AI provider API calls during
   this phase or during automated verification later — same
   standing rule as the original repo's `HANDOFF.md`.

### Phase 1 — Strip the app down

Remove the following. Prefer deleting files outright over
commenting out code — this is a hard pivot, not a feature flag.

1. Delete `client/src/pages/script.tsx` and
   `client/src/pages/thumbnail.tsx`.
2. Delete `client/src/lib/workflow-context.tsx` and any
   sidebar/history UI that lists saved workflows
   (IndexedDB-backed "recent workflows" list).
3. Delete `server/gemini.ts` and every route in
   `server/routes.ts` that calls it (Insights, Ideas, Script
   generation/regeneration, Thumbnail generation).
4. Delete `shared/evidence-contracts.ts` and any types in
   `shared/schema.ts` that exist only to support the
   Insights/Ideas/Script/Thumbnail evidence system.
5. Remove `GEMINI_API_KEY`, `GEMINI_TEXT_MODEL`,
   `GEMINI_IMAGE_MODEL` from `.env.example` and from
   `server/settings.ts`.
6. Remove the `@google/genai` dependency from `package.json`.
7. Do **not** delete `server/youtube.ts`,
   `server/settings.ts`, or `server/routes.ts` themselves —
   they get reworked in later phases, not removed.
8. Run `npm run check` — expect it to fail with dangling
   imports pointing at everything just deleted. That's
   expected; those get fixed in Phase 3–5, not now. Just
   confirm the failures are only in the areas above and note
   any surprise (e.g. shared code you didn't expect to be
   load-bearing) in Session Notes below.

### Phase 2 — Add the SQLite persistence layer

1. Add `better-sqlite3` (and its TypeScript types) as a
   dependency.
2. Create a new `server/db.ts` that opens/creates a local
   SQLite file (e.g. `data/scout.db`, gitignored) and defines
   two tables:
   - `channels`: every channel ever evaluated, whether it
     qualified or was filtered out. Needs at minimum:
     `channel_id` (primary key), `channel_name`,
     `channel_url`, `subscriber_count`, `avg_views`,
     `engagement_rate_pct` (nullable), `last_upload_date`,
     `days_since_last_upload`, `matched_keyword`, `qualified`
     (boolean — did it pass all filters when evaluated),
     `first_seen_at`.
   - `api_key_usage`: `key_label`, `date` (YYYY-MM-DD,
     Pacific Time — YouTube's quota resets at midnight
     Pacific), `units_used`. One row per key per day,
     incremented as calls are made.
3. Write small helper functions: `isChannelKnown(channelId)`,
   `recordChannel(...)`, `getUsageToday(keyLabel)`,
   `addUsage(keyLabel, units)`.
4. This phase has no UI or API wiring yet — just get the DB
   module working and covered by a quick manual test (e.g. a
   throwaway script or a unit test) before moving on.

### Phase 3 — Rework the YouTube service

Rework `server/youtube.ts` (don't rewrite from a blank file —
reuse its existing API-calling patterns and error handling
where they still fit).

1. Replace single-key config with a list of keys (see Phase 6
   for how they're supplied). Build a small rotation helper:
   given the list of keys, return the first one that has
   remaining estimated quota for today (check
   `api_key_usage`), skipping keys already known to be
   exhausted.
2. Implement the discovery pipeline per keyword:
   a. `search.list` (type=`video`, cost 100 units/call) —
      collect results, extract unique `channelId` values from
      the video snippets. This is intentionally
      video-search, not channel-search — video search matches
      topical relevance better than searching channel names.
   b. Before doing anything else with a candidate channel,
      check `isChannelKnown(channelId)` — if it's already in
      the DB, skip it entirely (already evaluated, don't
      re-spend quota).
   c. Batch remaining unknown channel IDs into `channels.list`
      calls (up to 50 IDs per call, 1 unit per call
      regardless of batch size) to get subscriber count,
      hidden-subscriber flag, uploads playlist ID, and
      country.
   d. If `hiddenSubscriberCount` is true for a channel, record
      it in the DB as `qualified = false` and move on — do
      not guess at its subscriber count.
   e. If subscriber count is outside the requested
      min/max range, record as `qualified = false` and move
      on (still record it, so it's never re-checked).
   f. For channels still in range, call `playlistItems.list`
      (1 unit) on the channel's uploads playlist to get the
      most recent video IDs (up to 10).
   g. Batch those video IDs into `videos.list` calls (up to 50
      IDs per call, 1 unit per call) to get `viewCount`,
      `likeCount`, `commentCount`, and `publishedAt` for each.
   h. Compute: `avg_views` (mean of viewCount across the
      videos retrieved, up to 10), `days_since_last_upload`
      (from the most recent video's `publishedAt`),
      `engagement_rate_pct` = mean of
      `(likeCount + commentCount) / viewCount * 100` across
      the same videos (skip this computation, leave it null,
      for any video where `viewCount` is 0 or missing).
   i. Apply the max-days-since-upload and min-avg-views
      filters (and min-engagement-rate filter, if the user
      supplied one). Record the channel either way
      (`qualified = true`/`false`) so it's never re-evaluated.
   j. After every YouTube API call, increment `api_key_usage`
      for the active key by the call's known unit cost (100
      for search, 1 for channels/playlistItems/videos) — this
      is what lets rotation happen proactively instead of
      waiting for a 403.
3. Stop condition for the whole run: stop as soon as the
   target "number of creators" count of *qualified* channels
   is reached, OR all keywords have been fully searched, OR
   every configured key is out of quota for today.
4. Wrap every YouTube call in a try/catch that specifically
   handles HTTP 403 with reason `quotaExceeded`: mark that key
   exhausted for today in `api_key_usage` (set it to a
   sentinel "exhausted" value or just set units_used to a very
   high number), rotate to the next key, and retry the same
   call once. If no keys remain, stop the run gracefully and
   return whatever qualified channels were accumulated so far
   — this must never throw an unhandled error up to the route
   handler.

### Phase 4 — Rework the API routes

1. In `server/routes.ts`, remove the Insights/Ideas/Script/
   Thumbnail routes (should already be gone from Phase 1 —
   confirm here).
2. Add a single route (e.g. `POST /api/scout`) that accepts:
   `keywords` (string array), `minSubscribers`,
   `maxSubscribers`, `maxDaysSinceUpload`, `minAvgViews`,
   `minEngagementRate` (optional), `targetCount`. Validate
   input ranges (reuse whatever validation patterns
   `shared/schema.ts` already has for the old Research
   request).
3. Decide and implement one clear behavior for how progress is
   returned to the client — either (a) a single synchronous
   response once the whole run finishes, or (b) a
   streaming/polling mechanism if runs are expected to take
   long enough that a bare spinner would be a bad experience.
   Given target counts are likely small (e.g. 10–50 channels),
   default to (a) unless you find evidence during
   implementation that runs commonly take long enough to need
   progress streaming — note whichever you pick and why in
   Architecture Decisions.
4. Response should include: the list of qualified channels
   found, how the run ended (`target_reached` /
   `keywords_exhausted` / `quota_exhausted`), and counts
   (found vs. requested).

### Phase 5 — Rework the client

1. Delete `client/src/pages/research.tsx` and replace it with
   a single new page (e.g. `client/src/pages/scout.tsx`) that
   is now the app's only real page besides Settings.
2. Build the form described in `project-overview.md` (Core
   User Flow) using the existing shadcn/ui components already
   in the project — do not introduce a new UI kit.
3. Build the results table (Channel Name linked to
   `channel_url`, Subscriber Count, Avg Views, Engagement Rate
   % if present, Last Upload Date, Days Since Last Upload,
   Matched Keyword).
4. Show the run's end status and found/requested counts
   clearly, including the partial-results case (quota
   exhausted) — this should read as a normal outcome, not an
   error state.
5. Remove routing/nav entries for the deleted pages, and the
   `/ideas` redirect if nothing references it anymore.

### Phase 6 — Multi-key Settings

1. Extend `server/settings.ts` to store a list of YouTube API
   keys instead of a single `YOUTUBE_API_KEY` (e.g. a
   `YOUTUBE_API_KEYS` env var, comma-separated, following the
   same owner-only `.env`-write and never-return-to-browser
   pattern the original Settings already uses).
2. Update the Settings page UI to let the user enter multiple
   keys (e.g. one per line), matching the existing form
   patterns already in `client/src/pages/settings.tsx`.
3. Update `.env.example` accordingly.

### Phase 7 — Docs and verification

1. Rewrite `README.md` to describe the new product using
   `project-overview.md` as the source of truth — drop every
   section describing Insights/Ideas/Script/Thumbnail/Gemini.
2. Update `HANDOFF.md`'s "Current product map" and "Standing
   boundaries" sections to match the new file structure and
   this rework's boundaries (e.g. "no AI/Gemini code", "SQLite
   is now part of the stack", "multi-key rotation is
   required, not optional").
3. Run `npm test`, `npm run check`, `npm run build` and fix
   whatever the strip-down left broken. All three must pass
   before considering the rework done.
4. Do one manual pass with real (rate-limited) YouTube keys to
   confirm the end-to-end flow actually returns and displays
   results, and that the dedup skip works on a second run with
   the same keywords.

## Open Questions

- Should completed/failed runs be visible anywhere in the UI
  (e.g. "last run: 8 found"), or is the results table
  ephemeral per-run with no history view? Current assumption
  in `project-overview.md` is no history UI — confirm this is
  still correct once the form/results page is built.
- Is there a practical cap on how many keywords a single run
  should accept (to avoid a user accidentally queueing an
  enormous, quota-draining run)? Not specified yet — consider
  a sane default limit (e.g. 25 keywords) and surface it in
  the form.
- Confirm whether the user wants the repo/product renamed away
  from "YouTube Pro" given the scope change, or kept as-is.
  Not decided — default to keeping the existing name unless
  told otherwise.

## Architecture Decisions

- **Stack stays Node/TypeScript/Express/React/Vite/shadcn.**
  Rationale: the existing codebase already has this working
  end-to-end (build, dev server, UI kit); rewriting in a
  different stack (e.g. Python) would be more work than
  stripping and reworking what's there, and the user asked for
  minimal reinvention.
- **SQLite via `better-sqlite3`, not an ORM.** Rationale:
  the schema is small (two tables) and synchronous
  `better-sqlite3` calls are simpler for an agent to reason
  about correctly than adding Drizzle or another ORM layer for
  this scope.
- **Discovery uses `search.list` with `type=video`, not
  `type=channel`.** Rationale: channel-search only matches
  channel titles/descriptions; video-search finds channels
  actively producing content on-topic, which is what "find
  creators for keyword X" actually means. Verified via
  Google's quota documentation that `search.list` costs 100
  units/call regardless of type.
- **Recent-videos lookup uses the uploads playlist
  (`playlistItems.list`, 1 unit) instead of a second
  `search.list` call (100 units).** Verified via Google's
  quota calculator that `channels.list`, `videos.list`, and
  `playlistItems.list` are each 1 unit vs. `search.list` at
  100 units — this is the single biggest quota saving
  available in this pipeline.
- **Engagement rate is a derived field, not a native API
  field.** YouTube's API does not return "engagement rate"
  directly. It returns `likeCount`, `commentCount`, and
  `viewCount` per video, so engagement rate is computed as
  `(likes + comments) / views`, averaged across the sampled
  videos. This satisfies the user's "if the API gives
  engagement rate, include it" instruction — it's available
  in derived form, so it's included.
- **Hidden-subscriber channels are always excluded, never
  estimated.** Explicit user decision.
- **Every evaluated channel is recorded, qualified or not.**
  This is what makes the dedup/quota-saving guarantee work —
  if only qualified channels were stored, disqualified
  channels would get re-fetched (and re-spend quota) on every
  future run.
- **Quota tracking is proactive (counted per call in the DB),
  with a `403 quotaExceeded` catch as a backstop, not the
  primary mechanism.** Rationale: reacting only to 403s means
  wasting the call that triggers the error and risks
  inconsistent state; tracking known unit costs per call lets
  the app rotate keys before ever hitting a hard failure.
- **No CSV export.** Explicit user decision — results are
  browser-only, table display.
- **No AI in this rework.** Explicit user decision — the app
  is 100% YouTube Data API v3. If AI is added in a future,
  separate piece of work, it must go through NaraRouter
  (`https://router.bynara.id/v1`, OpenAI-Chat-Completions-
  compatible, `sk-nry-...` Bearer key) and not Gemini — this
  is documented for the future, not implemented now.

## Session Notes

- The original repo's `HANDOFF.md` lists these as the files
  that matter most for understanding current behavior before
  reworking: `client/src/pages/research.tsx`,
  `server/youtube.ts`, `server/routes.ts`,
  `server/settings.ts`, `shared/schema.ts`,
  `shared/evidence-contracts.ts`. Read those first — they're
  the ones this rework touches or removes.
- Original repo's standing rule "never make live provider
  calls during automated verification" carries over unchanged
  — `npm test`/`npm run check`/`npm run build` must not hit
  real YouTube or AI endpoints.
- Original repo already has a Settings pattern that writes
  replacement keys to a gitignored `.env` with owner-only
  permissions and never returns saved values to the browser —
  reuse this exact pattern for the multi-key list, don't
  invent a new secrets mechanism.
- 2026-09-08 — Phase 1 check: node_modules was missing so npm install was run first (401 packages). npm run check (tsc --noEmit) now reports 65 errors across exactly 3 files — client/src/lib/pdfGenerator.ts (12 implicit-any on callbacks, pre-existing), client/src/lib/research-export.ts (18 implicit-any + 2 missing IdeaPackage/ResearchInsightsResponse from deleted shared/evidence-contracts.ts), client/src/pages/research.tsx (26 implicit-any + missing workflow-context + 3 missing evidence exports). Zero errors in server/ or shared/ — server/routes.ts, server/settings.ts, and shared/schema.ts are clean after the Gemini/evidence removal. No surprise load-bearing shared code. The dangling research-export.ts/pdfGenerator.ts exports are expected to be deleted/reworked with research.tsx in Phase 5. package-lock.json still contains @google/genai entries — will be pruned by the next npm install after lockfile update. .env.example was already Scout-aligned (no GEMINI_* vars), so no change needed there. server/youtube.ts, server/settings.ts, server/routes.ts preserved as required.
- 2026-09-08 — Phase 2: added better-sqlite3@12.11.1 + @types/better-sqlite3@9.6.0 (pinned to 12.11.1 — 13.0.3 prebuild crashes on this host with exit 5 / access violation on new Database(':memory:')). Created server/db.ts (data/scout.db, gitignored via data/) with tables channels (channel_id PK, channel_name, channel_url, subscriber_count, avg_views, engagement_rate_pct nullable, last_upload_date, days_since_last_upload, matched_keyword, qualified boolean as INTEGER, first_seen_at) and api_key_usage (key_label, date YYYY-MM-DD Pacific, units_used) — WAL mode, Pacific date via America/Los_Angeles. Helpers: isChannelKnown, recordChannel (upsert, preserves first_seen_at on conflict), getChannel, getUsageToday, addUsage, setUsageToday (for quotaExceeded sentinel in Phase 3), getDbForTesting (isolated :memory:), closeDb. Manual throwaway check (server/db-manual-check.ts) verified: dedup, qualified true/false, hidden-subscriber null fields, quota increment + sentinel, in-memory isolation — all passed, then removed. server/ and shared/ remain tsc-clean; .gitignore now includes data/.
- 2026-09-08 — Phase 3: reworked server/youtube.ts in place (kept fetchYouTubeJson/youtubeHttpError patterns). Step 1: multi-key config — getYouTubeApiKeys() reads YOUTUBE_API_KEYS comma-separated with YOUTUBE_API_KEY fallback (Phase 6 will update Settings), getKeyLabel/pickAvailableKey/requireAvailableKey check getUsageToday vs QUOTA_EXHAUSTED_SENTINEL (1_000_000) + DAILY_QUOTA_UNITS (10_000). Step 2a-2j: QUOTA_COST constants (100/1/1/1), fetchYouTubeJsonWithQuota (proactive pickAvailableKey + addUsage), searchChannelIdsForKeyword (search.list type=video), isChannelKnown dedup, fetchChannelsBatch (50, hidden + subs range checks record qualified=false), fetchRecentVideoIdsForPlaylist (10), fetchVideoStatsBatch (50), computeChannelMetrics (avg_views mean, engagement_rate_pct mean (likes+comments)/views skip 0/missing null, days_since_last_upload from most recent publishedAt), passesScoutFilters + recordChannel either way, discoverChannelsForKeyword orchestrator. Step 3: runScoutDiscovery({keywords, filters, targetCount}) — iterates keywords with target_reached / keywords_exhausted / quota_exhausted stop conditions, checks pickAvailableKey before each keyword, returns ScoutRunResult{qualifiedChannels, stopReason, found, requested, keywordsSearched}. Step 4: fetchYouTubeJsonWithQuota now wraps every YouTube call with 403 quotaExceeded catch — marks key exhausted via setUsageToday(sentinel), rotates to next pickAvailableKey, retries same call once; if no keys remain returns YOUTUBE_QUOTA_EXHAUSTED quota error, runScoutDiscovery converts to graceful quota_exhausted partial return (never throws quota up to route handler). No live YouTube calls made; server/shared remain tsc-clean.
- Quota unit costs used throughout this plan (search.list=100,
  channels.list=1, videos.list=1, playlistItems.list=1) were
  verified against Google's official quota calculator as of
  this writing — if YouTube changes these costs, the "Phase 3"
  unit-cost constants need updating in one place, not
  scattered through the code.