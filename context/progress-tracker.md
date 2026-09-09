# Progress Tracker

Update this file after every meaningful implementation
change. Move finished items from "Next Up" into "Completed",
keep "Current Phase" and "Current Goal" pointed at whatever
is actually being worked on right now, and add anything you
learn or decide to "Architecture Decisions" or "Session Notes"
so the next session doesn't have to rediscover it.

## Current Phase

- Phase 6

## Current Goal

- Phase 6.1 : C1–C7 done; remaining W/I before Phase 7

## Completed

- Phase 0
- Phase 1 — Strip the app down (2026-09-08)
- Phase 2 — Add the SQLite persistence layer (2026-09-08)
- Phase 3 — Rework the YouTube service (2026-09-08) — steps 1-4 complete (see Session Notes)
- Phase 4
- Phase 5
- Phase 6 step 1 — server/settings.ts multi-key store (YOUTUBE_API_KEYS comma-separated) — done (2026-09-09)
- Phase 6.1 C1 — Settings page rewrite to multi-key contract — done (2026-09-09) (`npm run check` passes)
- Phase 6.1 C2 — `SCOUT_KEYWORD_LIMIT` 25→50 + README caps updated — done (2026-09-09)
- Phase 6.1 C3 — legacy `GET /api/youtube/search` removed from `server/routes.ts` — done (2026-09-09) (`npm run check` passes)
- Phase 6.1 C4 — legacy `server/youtube.ts` `searchVideos`/`createSnapshotId` + `getPublishedAfter`/`getVideoDuration`/`getOrderBy` removed — done (2026-09-09) (`server/youtube.ts` 1096→746 lines, `npm run check` passes)

## In Progress

— Phase 6 (steps 2–3 + Phase 6.1 audit fix-list)

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
2. Update the Settings page UI to let the user enter multiple
   keys (e.g. one per line / comma-separated textarea, maps to `youtubeApiKeys`),
   matching the existing form patterns already in `client/src/pages/settings.tsx`.
   Must remove all Gemini fields (see Phase 6.1 C1).
3. Update `.env.example` accordingly. [DONE 2026-09-09 — already shows
   `YOUTUBE_API_KEYS` + commented `YOUTUBE_API_KEY` fallback.]

### Phase 6.1 — Full-Codebase Audit — Fix-List Before Phase 7 (added 2026-09-09)

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
- **W7 — `server/settings.ts:22-27` string vs array caps misaligned.**
  `youtubeApiKeys` string cap `8192` vs array cap `25 * 512 + 24` — string cap is tighter.
  Raise string cap to `16384` or document that paste-variance is via textarea (string) path.
- **W8 — `server/youtube.ts:52` dead duplicate quota check.**
  `if (used + cost > DAILY_QUOTA_UNITS) continue;` already covers `if (used >= DAILY_QUOTA_UNITS) continue;`
  — second branch is dead. Remove it.
- **W9 — `server/index.ts` `trust proxy` not explicitly disabled.**
  Rate limiter keys on `req.ip || req.socket.remoteAddress`. If `HOST` is ever changed, spoofed
  `X-Forwarded-For` could bypass limits. Add `app.set("trust proxy", false)` and a comment that
  limiter is per-process local-only (README already warns not distributed).
- **W10 — `server/settings.ts:57-91` `isTrustedLocalSettingsMetadata` host regex typo (I10).**
  `if (/[@/\\s%]/.test(input.host))` — char class `\\s` is backslash-or-`s`, not whitespace.
  Intended `/[@\/\s%]/`. Currently over-blocks hosts containing `s` and misses whitespace bypass.
  Fix to `/[@\/%\s]/` or `/[@\/\s%]/`.
- **W11 — `server/db.ts` no index on `matched_keyword` (minor).**
  Not needed now; note only if keyword-scoped re-scout UX is added later.

#### INFO / NITS — polish when convenient (not blocking)

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
   before considering the rework done.
4. Do one manual pass with real (rate-limited) YouTube keys to
   confirm the end-to-end flow actually returns and displays
   results, and that the dedup skip works on a second run with
   the same keywords.

## Open Questions — Resolved 2026-09-09

- [RESOLVED: no history UI] Completed/failed runs are NOT visible anywhere —
  the results table is ephemeral per-run with no history view. `project-overview.md`
  assumption confirmed correct. DB retains data only for dedup, not for browsing.
- [RESOLVED: 50 keywords max] Practical cap is **50 keywords per run** (not 25).
  `SCOUT_KEYWORD_LIMIT` must be raised from 25 to 50 in `shared/schema.ts` (and
  surfaced in the Scout form hint/counter — see Phase 6.1 C2). This is a quota guard.
- [RESOLVED: keep name] Repo/product stays **"YouTube Pro"** — no rename.

> Previous open-question text preserved below for context:
> - Should completed/failed runs be visible anywhere in the UI
>   (e.g. "last run: 8 found"), or is the results table
>   ephemeral per-run with no history view?
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