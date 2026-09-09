# Maintainer Handoff

Read `README.md` first. It describes the current Scout product, local-first access model, exact input limits, and verification commands. Next read `context/project-overview.md` and `context/progress-tracker.md` for future upgrades.

## Current product map

- `client/src/pages/scout.tsx`: single-page Creator Scout — keyword/filter form, progress status, and results table (the only real page besides Settings; no multi-step workflow, no sidebar of saved workflows).
- `client/src/pages/settings.tsx`: local multi-key YouTube API key management (one per line in the UI, comma-separated in `.env`); never returns saved values to the browser; loopback/same-origin only.
- `server/youtube.ts`: YouTube Data API discovery pipeline — `search.list` (type=video) → `channels.list` → `playlistItems.list` → `videos.list`, derived `avg_views`/`days_since_last_upload`/`engagement_rate_pct`, proactive quota accounting and `quotaExceeded` rotation.
- `server/db.ts`: SQLite persistence (`data/scout.db`, gitignored) — simplified `channels` table (`channel_id`, `channel_url`, `channel_name`, `source`, `matched_keyword`, `added_at`) and `api_key_usage` (per-key, per-day in Pacific time) plus helpers `isChannelKnown`, `recordChannel`, `recordSearchChannel`, `addManualChannel`, `listHistory`, `getChannelResolver`.
- `server/routes.ts`: API surface (`POST /api/scout` + Settings + `/api/history/manual-add` + `GET /api/history`) and in-memory per-process rate limiting.
- `server/settings.ts`: local-only Settings policy, owner-only `.env` writes for `YOUTUBE_API_KEYS` / `YOUTUBE_API_KEY`, never returns keys to the browser.
- `shared/schema.ts`: Scout request, response, and channel-result contracts (Zod-validated).
- `data/scout.db`: local SQLite file (gitignored) — deleting it resets dedup history and quota counters; no migration required.

## Standing boundaries

- Every evaluated channel is recorded (`qualified` true or false, or `source='manual'`) so it is never re-fetched or re-shown — this is the quota-saving guarantee.
- Channels with `hiddenSubscriberCount` are always excluded, never estimated.
- Multi-key rotation is required, not optional: proactive per-call quota counting plus `403 quotaExceeded` catch-and-rotate; if all keys are exhausted mid-run, return partial qualified results with a clear `quota_exhausted` status — never crash or return blank.
- Never return API keys to the browser or log request or response bodies.
- Keep Settings local-only (loopback/same-origin, reject forwarded/proxy requests) unless a separately authenticated remote secret-management design is implemented.
- No Gemini/AI code path, no `@google/genai` dependency, no Insights/Ideas/Script/Thumbnail/evidence-contract code, no IndexedDB workflow history, no CSV export. If AI is added in a future phase it must go through NaraRouter (`https://router.bynara.id/v1`, OpenAI-Chat-Completions-compatible, `sk-nry-...` Bearer key) — not Gemini — and that work is explicitly out of scope for this rework.
- `data/scout.db` is local and gitignored; do not commit it and do not add a server-side runtime database beyond this file.
- The retired login, initial password, Thumbnail unlock, Pro Script Studio, legacy Replit AI proxy, and database/session stack remain out of the product — do not reintroduce them as compatibility code.
- Do not make live YouTube provider calls during automated verification.
- The `channels` table stores only identity fields (`channel_id`, `channel_url`, `channel_name`, `source`, `matched_keyword`, `added_at`); metrics like subscriber count, avg views, engagement rate, and days since last upload are ephemeral per-run display only and are not persisted.

## Verification

```bash
npm test
npm run check
npm run build
```

Paid-provider (YouTube Data API) behavior still needs an explicit live-key acceptance pass with real keys. Keep that distinct from contract tests and production build success.

## History tab (Phase 8)

- A dedicated History tab shows every excluded channel: name (linked to the channel), how it was added ("Found via search" / "Manually added"), the matched keyword when applicable, and the date added.
- A single input field plus an "Add" button lets the user paste one channel link (or `@handle`) at a time to exclude a channel they already know about, without ever searching for it. The app resolves the link to YouTube's canonical channel ID before storing it, so it reliably matches that channel in future searches even if its handle or display name changes later.
- Adding a channel already in the history is a no-op that tells the user it's already excluded — it never spends API quota on a duplicate.
- Every manual add resolves through a real, quota-counted YouTube API call — manual adds participate in the same quota tracking and key rotation as a scout run, not a separate path.
- The History tab lists a flat, current exclusion list (not per-run browsing).
- Channels already known from the DB skip the API resolution call entirely, costing zero quota.
- Each entry in the History table is labeled as "Found via search" or "Manually added", and search-found entries show their matched keyword.
- The table columns are: Channel Name (linked), Added date, Source, Matched Keyword (when applicable).