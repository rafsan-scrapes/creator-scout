# Progress Tracker

Update this file after every meaningful implementation
change. Move finished items from "Next Up" into "Completed",
keep "Current Phase" and "Current Goal" pointed at whatever
is actually being worked on right now, and add anything you
learn or decide to "Architecture Decisions" or "Session Notes"
so the next session doesn't have to rediscover it.

## Current Phase

- Phase 8

## Current Goal

- Phase 8 — History tab + manual channel exclusion (Phase 7 automated
  checks complete 2026-09-09; Phase 7 step 4, the manual live-key
  pass, is being done directly by the user, not an agent — see
  Session Notes)

## Completed

- Phase 0
- Phase 1 — Strip the app down (2026-09-08)
- Phase 2 — Add the SQLite persistence layer (2026-09-08)
- Phase 3 — Rework the YouTube service (2026-09-08) — steps 1-4 complete (see Session Notes)
- Phase 4
- Phase 5
- Phase 6 step 1 — server/settings.ts multi-key store (YOUTUBE_API_KEYS comma-separated) — done (2026-09-09)
- Phase 6 steps 2–3 — Settings page multi-key textarea (`youtubeApiKeys`, one per line / comma-separated) + `.env.example` `YOUTUBE_API_KEYS` — done (2026-09-09) (Phase 6.1 C1 re-audited: single `Textarea` → `youtubeApiKeys`, `Configured · N keys` badge, `WebkitTextSecurity` toggle, `npm run check` passes, zero Gemini fields)
- Phase 6.1 — Full-Codebase Audit — Fix-List Before Phase 7 (added 2026-09-09) (completed 2026-09-09)
- Phase 6 — Multi-key Settings — complete (2026-09-09)
- Phase 7 steps 1-3 — README/HANDOFF rewrite + `npm test`/`npm run
  check`/`npm run build` all passing — complete (2026-09-09, verified
  directly by user's own terminal output, not by an agent)

## In Progress

— Phase 7 step 4 (manual live-key pass — user is doing this
  themselves; not an agent task, no action needed here)
— Phase 8 (History tab + manual channel exclusion)

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
     **[SUPERSEDED 2026-09-10 by Phase 8 step 1 — this schema
     is simplified down to `channel_id`, `channel_url`,
     `channel_name`, `source`, `matched_keyword`, `added_at`.
     This description is kept for history; implement Phase 8's
     version, not this one, if building fresh.]**
   - `api_key_usage`: `key_label`, `date` (YYYY-MM-DD,
     Pacific Time — YouTube's quota resets at midnight
     Pacific), `units_used`. One row per key per day,
     incremented as calls are made. (Unaffected by Phase 8.)
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
3. Implement how progress is
   returned to the client by giving a single synchronous
   response once the whole run finishes
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

1. [DONE 2026-09-09] Extend `server/settings.ts` to store a list of YouTube API
   keys instead of a single `YOUTUBE_API_KEY` (`YOUTUBE_API_KEYS` env var,
   comma-separated, `YOUTUBE_API_KEY` kept as single-key fallback). Follows the
   same owner-only `.env`-write (`0o600` + `chmod` + atomic `rename`) and
   never-return-to-browser pattern the original Settings already uses. Helpers:
   `getYouTubeApiKeysFromEnv()`, `parseYouTubeKeysInput`, `validateYouTubeKeys`,
   `getApiKeyStatus() -> { youtube, youtubeKeyCount }`.
2. [DONE 2026-09-09] Update the Settings page UI to let the user enter multiple
   keys (e.g. one per line / comma-separated textarea, maps to `youtubeApiKeys`),
   matching the existing form patterns already in `client/src/pages/settings.tsx`.
   Must remove all Gemini fields (see Phase 6.1 C1) — verified done via re-audit
   2026-09-09: `client/src/pages/settings.tsx` already satisfies (single `Textarea`
   one-per-line/comma-separated → `youtubeApiKeys` + `Configured · N keys` badge,
   `WebkitTextSecurity: disc` toggle, sends only `{ youtubeApiKeys: raw }`, zero
   Gemini/`ModelOption`/`Select` fields; `npm run check` passes; `grep gemini` 0 hits).
3. Update `.env.example` accordingly. [DONE 2026-09-09 — already shows
   `YOUTUBE_API_KEYS` + commented `YOUTUBE_API_KEY` fallback.]

### Phase 6.1 — Full-Codebase Audit — Fix-List Before Phase 7 (added 2026-09-09) (completed 2026-09-09)

> Full read-all pass done 2026-09-09 across: `server/settings.ts`, `server/youtube.ts`,
> `server/db.ts`, `server/routes.ts`, `shared/schema.ts`, `client/src/pages/scout.tsx`,
> `client/src/pages/settings.tsx`, `client/src/App.tsx`, `client/src/components/app-sidebar.tsx`,
> `client/index.html`, `server/index.ts`, `server/provider-errors.ts`, `server/rate-limit.ts`,
> `server/vite.ts`, `server/static.ts`, `package.json`, `.env.example`, `.gitignore`,
> `vite.config.ts`, `tsconfig.json`, `script/build.ts`, `README.md`, `HANDOFF.md`,
> `client/src/**/*`, `server/**/*`. Do these in order; CRITICAL first. Check each item off
> in this file as you fix it.

#### CRITICAL — must fix before Phase 7 (blocks `npm test` / `npm run check` / Settings)

- **[DONE 2026-09-09] C1 — `client/src/pages/settings.tsx` was contract-broken vs `server/settings.ts` + `server/routes.ts` — fixed: now multi-key textarea only.**
  Server `GET /api/settings/status` returns `{ youtube: boolean, youtubeKeyCount: number }`
  (`getApiKeyStatus()`); `PUT /api/settings/api-keys` accepts only `youtubeApiKey?` /
  `youtubeApiKeys?` (strict schema). Client still declares `interface ApiKeyStatus { youtube, gemini, models: { text, image, textOptions, imageOptions } }`
  and on submit sends `{ youtubeApiKey?, geminiApiKey?, geminiTextModel, geminiImageModel }`.
  `strict()` rejects `gemini*` → every save is `400 Unrecognized key(s)`. Status fetch casts
  to the stale type so `data.gemini`/`data.models` are `undefined` and `setGeminiTextModel(undefined)`
  crashes the Select. **Fix:** rewrite `settings.tsx` to a single multi-key textarea
  (one per line or comma-separated → `youtubeApiKeys`), show `youtubeKeyCount` / `Configured` badge,
  remove every Gemini field, `ModelOption`, `Select`, `gemini*` state/ref, and community-card-adjacent
  Gemini copy. Send only `{ youtubeApiKeys }` (or legacy `{ youtubeApiKey }` for one key).
- **[DONE 2026-09-09] C2 — `shared/schema.ts:160` keyword limit 25→50 — fixed.**
  `export const SCOUT_KEYWORD_LIMIT` now `50`. Schema uses
  `z.array(...).max(SCOUT_KEYWORD_LIMIT)` and `client/src/pages/scout.tsx` surfaces the
  constant in label/hint/validation — single-constant fix. `server/settings.ts` `youtubeApiKeys`
  array `max(25)` is key-count, not keyword-count — leave it. After fix, update any doc that
  says "e.g. 25" to 50.
- **[DONE 2026-09-09] C3 — `server/routes.ts:88-114` legacy `GET /api/youtube/search` — removed.**
  Single-purpose Scout has no search UI. Route still exposes unauthenticated, quota-uncounted
  YouTube search via legacy `searchVideos` (see C4). Delete the handler and its imports
  `searchVideos`, `searchFiltersSchema`, and the `rateLimit` (`createRateLimiter().middleware`)
  instance if nothing else uses it. The Phase 1 comment on line 43 already says routes were removed
  — finish the job.
- **[DONE 2026-09-09] C4 — `server/youtube.ts:820-1095` legacy `searchVideos` (quota-bypass) — removed with helper dead-code.**
  `const apiKey = process.env.YOUTUBE_API_KEY?.trim() || getYouTubeApiKeys()[0]` + direct
  `fetchYouTubeJson(searchUrl, "search")` — no `pickAvailableKey`/`addUsage`/`setUsageToday`, no
  sentinel. While `GET /api/youtube/search` exists this is a 100-unit quota leak per call and
  rotation never triggers. **Fix:** when C3 is done, delete `searchVideos` + `createSnapshotId` +
  helpers `getPublishedAfter`/`getVideoDuration`/`getOrderBy` if unreferenced, or gate behind
  a TODO if they are kept for reference. Keep Scout helpers
  `fetchYouTubeJsonWithQuota` / `searchChannelIdsForKeyword` / `discoverChannelsForKeyword` /
  `runScoutDiscovery` as the forward path.
- **[DONE 2026-09-09] C5 — `server/security-contracts.test.ts` has dangling imports → `npm test` throws `ERR_MODULE_NOT_FOUND`.**
  Imports `narrationExtractionRequestSchema`, `titleRegenerationRequestSchema` from
  non-existent `./api-contracts` and `scriptInputSchema` from `@shared/schema` (deleted in Phase 1).
  `tsconfig.json` `exclude: ["**/*.test.ts"]` hides this from `npm run check`, but
  `npm test` (`tsx --test server/*.test.ts`) immediately fails. The `apiKeySettingsSchema`
  assertion on line 46–47 (`geminiTextModel: "unknown-model"` should fail) now passes only
  vacuously via `strict()`. **Fix:** replace file with Scout contracts: assert
  `scoutRequestSchema`, `SCOUT_KEYWORD_LIMIT`, `scoutResponseSchema` bounds, keep
  `isTrustedLocalSettingsMetadata` loopback/forwarded/origin checks, keep rate-limiter test.
- **[DONE 2026-09-09] C6 — `server/youtube.test.ts` only exercises deleted legacy path; Scout pipeline has zero coverage.**
  All 7 tests import `searchVideos`/`createSnapshotId` and mock single-key `YOUTUBE_API_KEY`.
  No fixtures for `searchChannelIdsForKeyword`, `fetchChannelsBatch`, `discoverChannelsForKeyword`,
  `runScoutDiscovery`, quota rotation, or `recordChannel` dedup. Phase 6 says no live quota spend
  but fixture-based Scout tests are required. **Fix:** decide keep-or-delete; if kept, add mocked-`fetch`
  tests for Scout helpers (or at minimum keep one `createSnapshotId` test if that helper stays).
  As-is it gives false confidence.
- **[DONE 2026-09-09] C7 — `shared/research-contracts.test.ts` imports deleted research contracts.**
  Imports `researchInsightsRequestSchema` / `researchInsightsResponseSchema` (deleted with
  `shared/evidence-contracts.ts`). Same `ERR_MODULE_NOT_FOUND` on `npm test` as C5 (hidden from
  `tsc` by exclude). **Fix:** delete file or replace with Scout contract tests
  (`scoutRequestSchema` `min<=max` superRefine, `scoutChannelSchema`, `scoutStopReasonSchema`).

#### WARNING — should fix before Phase 7 (quality / security / bloat)

- **[DONE 2026-09-09] W1 — `package.json` retains legacy deps.** `html2canvas`, `jspdf`, `recharts`, `framer-motion`,
  `embla-carousel-react`, `vaul`, `react-resizable-panels`, `react-day-picker`, `input-otp`, `cmdk`
  and Replit dev deps `@replit/vite-plugin-*` + `optionalDependencies: bufferutil` are unused by
  Scout (`scout.tsx`/`settings.tsx` use only shadcn primitives + `lucide-react`). Remove them to
  shrink `dist/public` and audit surface. Verify `@google/genai` is already gone (it is).
- **[DONE 2026-09-09] W2 — `server/index.ts:30-37` JSON limit `18mb` is legacy thumbnail value.**
  Comment says "Three prepared thumbnail references may contain up to 12 MB..." — Scout payloads
  are < 256 kB JSON. Keeping 18 MB widens DoS surface. Lower to `64kb` (or `256kb` max) and
  delete stale comment. `express.urlencoded { limit: "64kb" }` is already tight — JSON should match.
- **[DONE 2026-09-09] W3 — `server/provider-errors.ts:26` type still carries `gemini`.**
  `type ProviderErrorContext = "youtube" | "gemini"` — spec says no Gemini, future AI via
  NaraRouter (`sk-nry-...`). Change to `"youtube"` (or `"youtube" | "nara"` if a placeholder is wanted)
  and update `invalid_response` suggestion which still says "choose another supported model".
- **[DONE 2026-09-09] W4 (W4 already folded into W1 (vite allowedHosts/Replit)) — `vite.config.ts` + `server/vite.ts` Replit leftovers & permissive hosts.**
  `vite.config.ts` imports `runtimeErrorOverlay` from `@replit/...`, conditionally loads
  `cartographer`/`devBanner` on `REPL_ID`, aliases `"@assets" -> attached_assets` (deleted).
  `server/vite.ts:16` uses `allowedHosts: true`. For local-only Scout either remove Replit block
  or gate it, and set `allowedHosts` to `["127.0.0.1","localhost","::1"]` or omit.
- **[DONE 2026-09-09] W5 — Scout response missing `Cache-Control: no-store`.**
  Settings routes set `no-store` correctly; `POST /api/scout` (billable, dedup-sensitive) does not.
  Add `res.setHeader("Cache-Control", "no-store")` there as well.
- **[DONE 2026-09-09] W6 — `server/settings.ts:182-195` `.env` writer quoting vs reader splitting.**
  `setEnvValue` stores `YOUTUBE_API_KEYS="key1,key2"` via `JSON.stringify`; reader splits on `,`
  relying on `loadEnvFile` to strip quotes (Node 22 does). Add explicit guard on read
  (`value.replace(/^"|"$/g, "")` before split) or write without `JSON.stringify`, and add a test.
- **[DONE 2026-09-09] W7 — `server/settings.ts:22-27` string vs array caps misaligned.**
  `youtubeApiKeys` string cap `8192` vs array cap `25 * 512 + 24` — string cap is tighter.
  Raise string cap to `16384` or document that paste-variance is via textarea (string) path.
- **[DONE 2026-09-09] W8 — `server/youtube.ts:52` dead duplicate quota check.**
  `if (used + cost > DAILY_QUOTA_UNITS) continue;` already covers `if (used >= DAILY_QUOTA_UNITS) continue;`
  — second branch is dead. Remove it.
- **[DONE 2026-09-09] W9 — `server/index.ts` `trust proxy` not explicitly disabled.**
  Rate limiter keys on `req.ip || req.socket.remoteAddress`. If `HOST` is ever changed, spoofed
  `X-Forwarded-For` could bypass limits. Add `app.set("trust proxy", false)` and a comment that
  limiter is per-process local-only (README already warns not distributed).
- **[DONE 2026-09-09] W10 — `server/settings.ts:57-91` `isTrustedLocalSettingsMetadata` host regex typo (I10) — fixed `/[@\/\s%]/`.**
  `if (/[@/\\s%]/.test(input.host))` was char class `\\s` (backslash-or-`s`, not whitespace).
  Corrected to `/[@\/%\s]/`. Previously over-blocked hosts containing `s` and missed whitespace bypass.
- **[DONE 2026-09-09] W11 — `server/db.ts` no index on `matched_keyword` — added `idx_channels_matched_keyword`.**
  `CREATE INDEX IF NOT EXISTS idx_channels_matched_keyword ON channels(matched_keyword)` in both
  `getDb()` and `getDbForTesting()`. No migration needed; existing `channels` rows gain the index on next
  open. Keeps keyword-scoped re-scout / reporting fast if that UX is ever added.

#### INFO / NITS — polish when convenient (not blocking) - Deferred

- **I1** `client/src/index.css:328-341` `ai-insights-glow` + `@keyframes ai-glow-pulse` are dead Research-era CSS (~1 kB). Remove.
- **I2** `client/src/lib/queryClient.ts` `getQueryFn`/`queryClient` are instantiated but no `useQuery` remains in `scout.tsx` (only `apiRequest` is used by broken `settings.tsx`). Dead code — prune or keep for Phase 7.
- **I3** `README.md:30` workflow step 3 says "progress streams as e.g. Searching keyword 2 of 5" but `POST /api/scout` is synchronous single response (Phase 4). Align doc to "Run Scout \u2014 synchronous response, status line shows `keywordsSearched` when done."
- **I4** `README.md:30` / `README.md:91` say "e.g. 25" / "e.g. 25" — after C2 update to 50.
- **I5** `.gitignore:9` `server/public` is stale (Vite outDir is `dist/public`). Keep or alias to `dist/`.
- **I6** `client/src/pages/scout.tsx:368-370` `Button onClick={handleRun}` without `<form onSubmit>` — Enter on inputs does not submit. Wrap in `<form>` or add `onKeyDown` Enter handler for a11y.
- **I7** `server/youtube.ts:76-78` startup `console.warn` fires on every import including tests. Gate behind `process.env.NODE_ENV !== "test"`.
- **I8** `client/index.html:14` Google Fonts is the only external request; CSP in `server/index.ts:24` correctly allowlists `fonts.gstatic.com`/`fonts.googleapis.com` — good, no action.
- **I9** `script/build.ts:7-11` allowlist `["date-fns","express","zod"]` bundles only those three; `better-sqlite3` is native and correctly externalized — good, no action.
- **I10** `client/src/components/app-sidebar.tsx` `Play` logo `fill="currentColor"` is intentional — no action.

> Checklist for the 10 audit questions: (1) multi-key `server/settings.ts` YES (I10 nit + W6 quoting only);
> (2) client `settings.tsx` vs contract NO — CRITICAL C1; (3) `SCOUT_KEYWORD_LIMIT` NO — 25 vs 50 C2;
> (4) `routes.ts` legacy `GET /api/youtube/search` YES still present C3; (5) `youtube.ts` `searchVideos`
> single-key bypass YES C4; (6) `package.json` removed deps PARTIAL — `@google/genai` gone but canvas/pdf/chart remain W1;
> (7) client pages vs deleted files no direct import crash but `settings.tsx` fields + `security-contracts.test.ts`
> dangling imports C5; (8) mental `tsc` FAIL hidden by `exclude: ["**/*.test.ts"]` C5/C7; (9) security loopback solid
> (I10/W10 nit), quota sentinel correct, rate limits `10/60s` on Scout, Scout response lacks `no-store` W5, JSON 18 MB W2;
> (10) UX keyword limit surfaced but at 25 not 50, table columns match spec.

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
   before considering the rework done. [DONE 2026-09-09 — user
   ran these directly; 3 unrelated `npm audit` advisories were
   fixed via `npm audit fix`, all 28 tests passed, `tsc` and the
   production build were both clean.]
4. Do one manual pass with real (rate-limited) YouTube keys to
   confirm the end-to-end flow actually returns and displays
   results, and that the dedup skip works on a second run with
   the same keywords. [Being done directly by the user, not an
   agent — see Session Notes. An agent should not attempt this
   step or ask for live API keys.]

### Phase 8 — History tab + manual channel exclusion

This phase reverses part of the "no history UI" decision recorded
under Open Questions below: the exclusion list now has a visible tab
instead of being purely internal. It does **not** reopen full
run-history browsing (see `project-overview.md` Scope) — only a flat,
current list of excluded channels.

1. **Simplify the `channels` table schema in `server/db.ts`.**
   Replace the current columns with: `channel_id` (primary key),
   `channel_url`, `channel_name` (nullable, best-effort),
   `source` (`'search'` or `'manual'`, `CHECK` constraint),
   `matched_keyword` (nullable — only ever set when
   `source = 'search'`), `added_at`. Drop `subscriber_count`,
   `avg_views`, `engagement_rate_pct`, `last_upload_date`,
   `days_since_last_upload`, and `qualified` — those metrics were
   only ever needed for a single run's Results table (already
   ephemeral, never persisted past the response) and add nothing
   to the exclusion purpose this table actually serves.
   Recreate the table rather than writing a data migration — as of
   this rework no live scout run has produced real accumulated
   history yet (Phase 7 step 4 was still pending when this phase
   started), so a clean recreate is simpler and safer than migrating
   in place. If you discover real history rows already exist when
   you get here, stop and flag it in Session Notes instead of
   silently dropping them.
2. **Keep recording every search-found channel, qualified or not.**
   This is the behavior the user is describing as unchanged — a
   channel that was searched and rejected must still never be
   re-fetched. Update `recordChannel` (or replace it with a
   simplified `recordSearchChannel(channelId, channelName,
   channelUrl, matchedKeyword)`) to only write the new minimal
   columns with `source = 'search'`. Update every call site in
   `server/youtube.ts` (`discoverChannelsForKeyword` and friends)
   accordingly — the qualify/disqualify *logic* during a run doesn't
   change, only what gets persisted afterward.
3. **Add `addManualChannel(channelId, channelUrl, channelName)`** to
   `server/db.ts`, writing `source = 'manual'`, `matched_keyword =
   null`, `added_at = now`. Should no-op safely (return "already
   exists") if the channel ID is already present — never throw a
   raw DB constraint error up to the route handler.
4. **Add `listHistory()`** to `server/db.ts` — returns all rows
   ordered by `added_at` descending, for the History tab.
5. **Add a channel-identifier resolver** (new file, e.g.
   `server/channel-resolver.ts`, or functions added to
   `server/youtube.ts`) that turns whatever the user pastes into a
   canonical `{ channelId, channelUrl, channelName }`:
   a. If the input is already a bare channel ID (`UC` followed by 22
      characters) or a `/channel/UC...` URL, extract the ID directly
      — no resolution call needed for parsing — but still call
      `channels.list?id=...` (1 unit) to confirm the ID is real and
      to fetch its current display name, so a mistyped ID doesn't
      silently sit in history.
   b. If the input is an `@handle` URL or bare `@handle`, call
      `channels.list?forHandle=...` (1 unit).
   c. If the input is a legacy `/user/Username` URL, call
      `channels.list?forUsername=...` (1 unit).
   d. If the input is a legacy `/c/CustomName` URL (not reliably
      resolvable via `channels.list`), fall back to
      `search.list?type=channel&q=CustomName` (100 units) and take
      the top match. This path is far more expensive than the
      others — surface that to the user in the client (e.g. a
      one-line note under the input) rather than silently spending
      100 units on a paste.
   e. Every one of these calls must go through the existing
      `fetchYouTubeJsonWithQuota` / `pickAvailableKey` /
      `addUsage` machinery from Phase 3 — a manual add is a real,
      billable YouTube API call and must participate in the same
      quota tracking and key rotation as a scout run, not a separate
      path.
   f. Before making any resolution call, check `isChannelKnown` on
      whatever channel ID you can already extract without an API
      call (case a). If it's already known, skip the API call
      entirely and return "already in history" — this is the one
      case where we can save quota on a duplicate add before
      resolving anything.
6. **Add `POST /api/history/manual-add`** to `server/routes.ts` —
   body `{ input: string }`. Validate non-empty/bounded length,
   resolve via step 5, check `isChannelKnown` again after resolution
   (covers the handle/username/custom-URL cases where the ID wasn't
   knowable up front), call `addManualChannel` if new, and return
   either the added record or a specific, user-readable error
   (invalid format, channel not found, quota exhausted while
   resolving). Reuse the existing rate-limiter pattern from
   `POST /api/scout` (this route makes real API calls too).
7. **Add `GET /api/history`** to `server/routes.ts` — returns
   `listHistory()` for the History tab table. Set `Cache-Control:
   no-store` (same reasoning as Phase 6.1 W5 — this reflects live,
   mutable state).
8. **Add `client/src/pages/history.tsx`** — an input field + "Add"
   button (disabled + spinner while the add request is in flight,
   since it's a real network call, not instant validation) above a
   table listing every row from `GET /api/history` (Channel Name
   linked to its URL, a "Found via search" / "Manually added" badge,
   Matched Keyword when present, Added date). Show inline feedback
   for each outcome: added, already-in-history, or resolution error
   — including the "this costs more quota" note for the `/c/` legacy
   path described in step 5d.
9. **Wire up navigation.** Add a "History" entry to
   `client/src/components/app-sidebar.tsx` and a route in
   `client/src/App.tsx`, alongside Scout and Settings.
10. **Tests.** Add mocked-`fetch` unit tests (no live calls, same
    standing rule as always) for: each branch of the identifier
    resolver in step 5, `addManualChannel` duplicate handling,
    `GET /api/history`, and `POST /api/history/manual-add` (valid
    add, duplicate, invalid input, resolution failure, quota
    exhausted mid-resolution).
11. **Update docs.** In `README.md` and `HANDOFF.md`, add the
    History tab to the product description and correct the line
    (added in Phase 7) that said there's no history UI — it should
    now say the History tab shows the flat exclusion list, not a
    per-run log (see `project-overview.md` Scope for the exact
    wording to match).
12. Run `npm test`, `npm run check`, `npm run build` again — same
    gate as Phase 7 step 3. An agent should stop here; the
    equivalent of Phase 7 step 4 for this feature (pasting a real
    channel link with live keys and confirming it's excluded from
    the next scout run) is being done directly by the user, per
    their standing preference — an agent should not attempt it or
    ask for live keys.

## Open Questions

- [SUPERSEDED 2026-09-10, was RESOLVED 2026-09-09: no history UI] The
  2026-09-09 resolution — "no history view, DB retains data only for
  dedup, not for browsing" — is **partially reversed** as of Phase 8:
  the app now has a History tab showing the flat list of excluded
  channels (search-found and manually-added). What's still true from
  the original resolution: there is no per-*run* browsing (no "what
  did keyword X find on Tuesday" log) — see `project-overview.md`
  Scope for the exact boundary.
- [RESOLVED: 50 keywords max] Practical cap is **50 keywords per run** (not 25).
  `SCOUT_KEYWORD_LIMIT` must be raised from 25 to 50 in `shared/schema.ts` (and
  surfaced in the Scout form hint/counter — see Phase 6.1 C2). This is a quota guard.
- [RESOLVED: keep name] Repo/product stays **"YouTube Pro"** — no rename.
- **[OPEN as of Phase 8]** Should a History entry be removable/
  undoable once added? Not requested by the user — Phase 8 as
  specified is add-only, no delete route or UI. Flagging so it isn't
  silently assumed either way; ask before building it.
- **[OPEN as of Phase 8]** The `/c/CustomName` legacy-URL resolution
  fallback (Phase 8 step 5d) costs 100 units per attempt, same as a
  full keyword search. If this comes up often in practice, worth
  revisiting whether it's worth supporting at all versus telling the
  user to find the channel's `/channel/UC...` or `@handle` link
  instead. No action needed unless the user raises it.

> Previous open-question text preserved below for context:
> - Should completed/failed runs be visible anywhere in the UI
>   (e.g. "last run: 8 found"), or is the results table
>   ephemeral per-run with no history view? → Reopened and partially
>   reversed in Phase 8; see above.
> - Is there a practical cap on how many keywords a single run
>   should accept? → 50.
> - Confirm whether the user wants the repo/product renamed → kept as-is.

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
- **[Phase 8] History table stores only identity fields, not
  metrics.** User asked "only keeping the channel links should
  be enough tho right?" — the answer is: for *display*, yes;
  for *reliably matching a manually-pasted channel against
  future search results*, no — a `/c/CustomName` or `@handle`
  URL can change over time, so it must be resolved to YouTube's
  permanent channel ID once, at add time, rather than
  re-resolved every future run. The table keeps `channel_id` as
  the real matching key and `channel_url`/`channel_name` for
  human display, but drops all per-run metrics (subscriber
  count, avg views, engagement rate, upload recency) — those
  only ever described a moment in time for that run's Results
  table and were never needed for exclusion.
- **[Phase 8] Manual add always resolves through a real,
  quota-counted YouTube API call, never a raw string match.**
  Rationale: without resolving to a channel ID, a manually-added
  entry could fail to match the same channel found later by
  search under a different URL, silently defeating the whole
  point of adding it. The one exception is a duplicate add of an
  already-known ID, which is checked before any API call and
  costs zero quota.
- **[Phase 8] History UI is a flat, current exclusion list —
  not per-run browsing.** This is a deliberate, narrower reversal
  of the 2026-09-09 "no history UI" resolution (see Open
  Questions): the user asked to see and manage *which channels
  are excluded*, not to browse *what each past run found*. Keep
  this distinction — don't build run-level history unless asked.

- **Open questions resolved 2026-09-09:** (a) No history UI — results table is ephemeral per-run, DB retained only for dedup; (b) Keyword cap is **50** (`SCOUT_KEYWORD_LIMIT = 50`), surfaced as `{count}/50` in the Scout form; (c) Product keeps the name **YouTube Pro**.

- **Phase 4 progress delivery: single synchronous response
  (a), not streaming/polling (b).** Rationale: request is for
  one blocking `POST /api/scout` that returns once the whole
  run finishes. Target counts are small (10-50 in Core User
  Flow; schema caps at 500 but `targetCount` is the stop
  condition) and the run is server-bound YouTube calls
  (`search` 100 + `channels`/`playlistItems`/`videos` at 1
  each) with dedup skip on known channels, so latency is
  acceptable without progress streaming. Client shows a spinner
  until the single `ScoutResponse` arrives. Reconsider
  streaming/polling only if the manual live-key pass (Phase 7)
  shows runs commonly exceed a comfortable spinner duration.

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
- 2026-09-08 — Phase 4: confirmed Insights/Ideas/Script/Thumbnail routes already removed (Phase 1). Added Scout contracts to shared/schema.ts (SCOUT_KEYWORD_LIMIT 25, scoutRequestSchema with min<=max superRefine, scoutChannelSchema, scoutStopReasonSchema target_reached/keywords_exhausted/quota_exhausted, scoutResponseSchema). Added POST /api/scout to server/routes.ts with dedicated scoutRateLimit (10/60s), Zod validation, deduped keywords, single synchronous runScoutDiscovery call, and response {channels, stopReason, found, requested, keywordsSearched} matching ScoutResponse semantics. Progress delivery is single synchronous response (Architecture Decisions) — no streaming/polling; client shows spinner until ScoutResponse arrives. Re-check if Phase 7 live-key pass shows long runs. server/ and shared/ remain tsc-clean; no live YouTube calls made.
- 2026-09-08 — Phase 5: deleted client/src/pages/research.tsx and replaced with client/src/pages/scout.tsx (only real page besides Settings). Built Scout form (keywords textarea one-per-line/comma, SCOUT_KEYWORD_LIMIT 25 counter, min/max subscribers, maxDaysSinceUpload 1-3650, minAvgViews, optional minEngagementRate 0-100, targetCount 1-500) using shadcn/ui (Card/Input/Textarea/Label/Table/Badge/Alert/Button), validation mirroring scoutRequestSchema (min<=max etc.) with inline Alert. Wired single synchronous POST /api/scout (deduped keywords, spinner Running…, error Alert with category/suggestion, quota_exhausted treated as normal partial not error). Built results table (Channel linked to channel_url + ExternalLink, Subscriber Count, Avg Views, Engagement Rate % — if present, Last Upload Date, Days Since, Matched Keyword badge) with empty-state handling. Added run-status Card (stopReason badge + found/requested + keywordsSearched, quota_exhausted amber partial messaging, target_reached green, keywords_exhausted neutral). Step 5: removed routing/nav for deleted pages — deleted client/src/components/controller-guide.tsx, coming-soon.tsx, empty-state.tsx, search-filters.tsx, video-card.tsx, video-card-skeleton.tsx, video-detail-dialog.tsx and client/src/lib/research-export.ts, pdfGenerator.ts, youtube-analytics.ts; removed ControllerGuide from client/src/App.tsx header and Compass unused import from app-sidebar.tsx; routing now Scout-only (Switch: / -> ScoutPage, /settings -> SettingsPage, fallback NotFound — no /ideas redirect remains). Updated client/index.html title/description to Creator Scout and client/src/pages/not-found.tsx copy Return to Scout. Verified grep shows no remaining research/ideas/script/thumbnail/workflow-context/evidence imports. npm run check now passes with 0 errors (was 65 across 3 files). No live YouTube calls made.
- 2026-09-09 — Phase 6 step 1 done: `server/settings.ts` now stores `YOUTUBE_API_KEYS` (comma-separated, rotation order = list order) with `YOUTUBE_API_KEY` single-key fallback. `SUPPORTED_KEYS` includes both vars, `ApiKeySettings` / `apiKeySettingsSchema` accept `youtubeApiKey?` (legacy) and `youtubeApiKeys?` (string up to 8192 or string[] up to 25, strict). Helpers `getYouTubeApiKeysFromEnv()`, `getApiKeyStatus() -> { youtube, youtubeKeyCount }`, `parseYouTubeKeysInput` (splits on `[,\\n]+`, trims), `validateYouTubeKeys` (8–512 chars, dedup preserving order with `Set`), `setEnvValue`, `saveApiKeySettings` (validates, dedupes, joins with `,`, atomic `writeFile(.env.tmp, 0o600)` + `rename` + `chmod 0o600`, syncs `process.env.YOUTUBE_API_KEYS` and `process.env.YOUTUBE_API_KEY` fallback). `.env.example` already updated (commented `YOUTUBE_API_KEYS=` + `# YOUTUBE_API_KEY=`). `server/youtube.ts` already consumed via `getYouTubeApiKeys()` with fallback — no change needed there. `client/src/pages/settings.tsx` NOT yet updated (see Phase 6.1 C1) — step 2 remains.
- 2026-09-09 — Phase 6.1 full-codebase audit: read every load-bearing file (`server/*`, `shared/*`, `client/src/**/*`, `package.json`, `.env.example`, `vite.config.ts`, `tsconfig.json`, `script/build.ts`, `README.md`, `HANDOFF.md`) plus grep for `gemini|evidence|workflow-context` and glob checks. Findings written into this file as § Phase 6.1 (CRITICAL C1–C7, WARNING W1–W11, INFO I1–I10) — do those in order before Phase 7. Key outcomes: Open Questions resolved (no history UI, 50-keyword cap, keep "YouTube Pro" name) and folded into Architecture Decisions; `SCOUT_KEYWORD_LIMIT` must go 25→50 (C2); Settings page is contract-broken and must be rewritten (C1); legacy `GET /api/youtube/search` + `searchVideos` must be removed (C3–C4); `security-contracts.test.ts` + `research-contracts.test.ts` have dangling imports that break `npm test` despite `tsc` exclude (C5, C7); `youtube.test.ts` covers only deleted path (C6); plus W/I nits (18 MB JSON, `gemini` type, Replit leftovers, `no-store` on Scout, quoting, regex `\\s` typo, dead CSS).
- 2026-09-09 — Phase 6.1 C1 fixed: rewrote `client/src/pages/settings.tsx` to match `server/settings.ts` multi-key contract. Now single `Textarea` (one per line or comma-separated → `youtubeApiKeys`), local count badge `Configured · N keys`, eye toggle via `WebkitTextSecurity: disc`, send only `{ youtubeApiKeys: raw }`. Removed every Gemini field / `ModelOption` / `Select` / `gemini*` state/ref. `ApiKeyStatus` now `{ youtube, youtubeKeyCount }` with defensive cast on status fetch. `npm run check` passes (exit 0).
- 2026-09-09 — Phase 7 steps 1-3 confirmed via the user's own terminal output (not run by an agent): `npm audit` found 3 advisories (browserslist high, postcss-selector-parser high, qs moderate) all with `npm audit fix` available and none touching runtime YouTube/DB code paths; `npm audit fix` resolved all 3 with 0 remaining. `npm run check` (`tsc`) — clean. `npm test` — 28/28 passing across 8 suites (Settings loopback/strict, Scout request/response contracts, `chunkArray`, `computeChannelMetrics`, multi-key rotation, YouTube provider error categories, Scout pipeline incl. quota-exhausted-mid-run and already-known-skip). `npm run build` — client + server both built clean. `npm run dev` initially failed on Windows/PowerShell because the `dev` script uses Unix-style inline `NODE_ENV=development ...`, which PowerShell/cmd.exe don't support — recommended fix is `cross-env` (`npm install --save-dev cross-env`, update the `dev` script to `cross-env NODE_ENV=development tsx server/index.ts`). Phase 7 step 4 (manual live-key pass, confirming dedup on a second run) is being done directly by the user per their stated preference, not delegated to an agent — no agent action needed for it, and none should be attempted (don't request live API keys).
- 2026-09-10 — Phase 8 opened per user request: two changes — (1) architectural: expose the existing dedup mechanism as a visible History tab (previously internal-only, per the 2026-09-09 "no history UI" resolution — see Open Questions for the reversal), with the `channels` table schema simplified to identity-only fields; (2) feature: a one-at-a-time manual-add field on that tab so the user can exclude a known channel without searching for it. See Phase 8 in Next Up for the full step-by-step, and the two new Architecture Decisions entries above for the reasoning on "why not just store the raw link" and "why every add still costs an API call."
- 2026-09-10 — Phase 8 step 1 STOPPED per its own guard clause: `data/scout.db` already contains 24 real rows (all `matched_keyword = 'AI tools review'`, 4 qualified / 20 not, `first_seen_at = 2026-09-09T02:31:53.976Z` — read-only query via `better-sqlite3`, no writes). This contradicts the step's assumption that "no live scout run has produced real accumulated history yet (Phase 7 step 4 was still pending)". Looks like the Phase 7 step 4 manual live-key pass did run and accumulate history. Per step 1 ("If you discover real history rows already exist when you get here, stop and flag it in Session Notes instead of silently dropping them"), `server/db.ts` was deliberately LEFT UNCHANGED — no recreate, no migration, no deletes. Awaiting user decision: (a) preserve + migrate those 24 IDs/URLs/names into the new minimal schema (`channel_id`, `channel_url`, `channel_name`, `source='search'`, `matched_keyword`, `added_at`), (b) back the DB up then clean-recreate as originally specified, or (c) something else. Do not proceed to Phase 8 step 2 until this is resolved.
- 2026-09-10 — Phase 8 step 1 RESOLVED (user chose migrate): backed up `data/scout.db` to `data/scout.db.pre-phase8-backup` (gitignored, both), then simplified `server/db.ts` to the minimal schema (`channel_id` PK, `channel_url` NOT NULL, `channel_name` nullable, `source` CHECK `IN ('search','manual')`, `matched_keyword` nullable with CHECK `(matched_keyword IS NULL OR source = 'search')`, `added_at`; index `idx_channels_matched_keyword` kept). `getDb()` runs a one-time `channels` → `channels_new` → rename migration mapping `first_seen_at` → `added_at`, `source = 'search'`; `getDbForTesting()` creates the new schema directly. All 24 rows preserved and verified (`source='search'` × 24, `matched_keyword='AI tools review'`, CHECKs reject `manual`+keyword and bad `source`, accept NULL name). `recordChannel(legacy ChannelRecord)` kept as a compat shim (writes only minimal columns, upsert preserves `added_at`) so `server/youtube.ts` + existing tests compile untouched — full replacement is Phase 8 step 2, not done here. `getChannel()` now returns `ChannelHistoryRecord`; `shared/schema.ts` scout response untouched (ephemeral metrics stay). `npm run check` clean, `npm test` 28/28 pass.
- 2026-09-10 — Phase 8 step 2 done: `server/db.ts` now exposes `recordSearchChannel(channelId, channelName, channelUrl, matchedKeyword)` — the only search-path write, identity-only with `source = 'search'`, upsert preserving `added_at`. `recordChannel(legacy)` kept as a deprecated wrapper delegating to it (plus `__testOverrides.recordSearchChannel` slot with fallback to legacy stubs, so old test doubles still intercept). `server/youtube.ts` `discoverChannelsForKeyword` updated at all 5 record sites (unknown/deleted, hidden-subs, sub-range, playlist-fail, final) — qualify/disqualify *logic* untouched, every evaluated channel still recorded either way. Pipeline return type is now local `ScoutPipelineChannel` (full ephemeral metrics, matches `shared/scoutChannelSchema` at runtime); `shared/schema.ts` untouched. `server/youtube.test.ts` stubs moved to `recordSearchChannel`; hidden-subscriber test now asserts the exclusion record (`channelId`/`channelName`/`matchedKeyword`) instead of a `qualified` flag that no longer persists. Verified live write path against real DB with a fake row (insert → `isChannelKnown` true → upsert preserves `added_at` → row deleted after, total back to 24). `npm run check` clean, `npm test` 28/28 pass.
- 2026-09-10 — Phase 8 step 3 done: `server/db.ts` now exposes `addManualChannel(channelId, channelUrl, channelName): "added" | "already exists"` — writes `source = 'manual'`, `matched_keyword = NULL`, `added_at = now` via `INSERT ... ON CONFLICT(channel_id) DO NOTHING`, so a duplicate ID (search- or manual-sourced) is left untouched and reported as `"already exists"` — no raw constraint error can reach the step 6 route handler. Plus an `addManualChannel` slot on `__testOverrides` for future route/resolver tests. Verified live against the real DB with throwaway rows (fresh → `"added"` with `source='manual'`/NULL keyword; repeat → `"already exists"` with `added_at` preserved; pre-existing `source='search'` row stays `search` with its keyword; both fakes deleted after, total back to 24). `npm run check` clean, `npm test` 28/28 pass.
- 2026-09-10 — Phase 8 step 4 done: `server/db.ts` now exposes `listHistory(): ChannelHistoryRecord[]` — `SELECT * FROM channels ORDER BY added_at DESC` (newest first, for the History tab), plus a `listHistory` slot on `__testOverrides` for the step 7/10 route tests. Verified live against the real DB (seeded one 2020 row + one 2030 row → 26 rows back, newest first / oldest last / full sequence monotonically descending; both fakes deleted after, total back to 24). `npm run check` clean, `npm test` 28/28 pass.