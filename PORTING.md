# Porting Guide — Creator Scout

The app is local-first with a single local SQLite file (`data/scout.db`, gitignored) and no authentication layer. For the current product and setup, read `README.md`.

> **Rework note:** The previous Research → Insights → Ideas → Script → Thumbnail workflow, Gemini integration, evidence contracts, and IndexedDB workflow history have been removed. This guide now describes the Scout rework.

## Portable boundaries

- Scout backend: `server/youtube.ts` (discovery pipeline + quota rotation), `server/db.ts` (SQLite persistence), `server/provider-errors.ts`, `server/settings.ts` (multi-key `.env` writes), and the Scout schemas in `shared/schema.ts`.
- Scout client: `client/src/pages/scout.tsx` (form + progress + results table), `client/src/pages/settings.tsx` (multi-key settings), and the shared UI primitives in `client/src/components/ui/`.
- Persistence: `data/scout.db` — `channels` (every evaluated channel, `qualified` true/false) and `api_key_usage` (per-key, per-day in Pacific time). Deleting the file resets dedup history; no migration required.

The browser expects same-origin `/api` routes. The UI uses Wouter, TanStack Query, shadcn/ui primitives, and the design tokens in `client/src/index.css`.

## Security requirements when porting

- Keep YouTube Data API keys on the server. Never return saved values to the browser.
- Preserve strict Zod validation on `POST /api/scout` and the dedup/quota invariants (every evaluated channel recorded; hidden-subscriber channels never shown; quota exhaustion returns partial results with `quota_exhausted`).
- Preserve the local-only Settings boundary: accept direct loopback, same-origin requests only; reject normal forwarded/reverse-proxy requests. Disable or place behind separately authenticated administration if the app becomes remote.
- Replace the in-memory per-process rate limiter with a shared limiter before running multiple instances.
- `data/scout.db` contains only public channel metadata and quota counters — not keys — but treat it as local state: gitignore it and do not sync it to untrusted storage.
- Add authentication before exposing `POST /api/scout` to untrusted users.
- Do not reintroduce Gemini/AI code (`@google/genai`), Insights/Ideas/Script/Thumbnail routes, IndexedDB workflow history, CSV export, or the retired login/password/Pro Script Studio/Replit AI proxy flows as accidental compatibility code.

## Routes

- `POST /api/scout` — run a Scout search (keywords + filters → qualified channels, `target_reached` / `keywords_exhausted` / `quota_exhausted`, found vs. requested counts)
- `GET /api/settings/status` — local Settings status (never returns saved keys)
- `PUT /api/settings/api-keys` — save YouTube API keys (comma-separated `YOUTUBE_API_KEYS` or single `YOUTUBE_API_KEY` fallback; owner-only `.env` write)

The following routes from the previous workspace no longer exist and must not be reintroduced:

`GET /api/youtube/search`, `POST /api/research/insights`, `POST /api/ideas/generate`, `POST /api/script/generate`, `POST /api/script/regenerate-titles`, `POST /api/script/regenerate-section`, `POST /api/script/regenerate-paragraph`, `POST /api/script/extract-narration`, `POST /api/thumbnail/generate`, `POST /api/thumbnail/suggestions`.

## Quota model

- `search.list` (type=video) = 100 units/call; `channels.list`, `videos.list`, `playlistItems.list` = 1 unit/call (batching up to 50 IDs does not increase cost). The pipeline counts these proactively in `api_key_usage` and also catches `403 quotaExceeded` as a backstop.
- Quota resets at midnight Pacific — `api_key_usage.date` is stored as `YYYY-MM-DD` in Pacific time.
