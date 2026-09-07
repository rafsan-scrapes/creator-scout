<p align="center">
  <img src="client/public/youtube-pro.svg" width="88" alt="YouTube Pro logo">
</p>

<h1 align="center">YouTube Pro — Creator Scout</h1>

<p align="center">
  Find YouTube creators by keyword and filter — entirely on the YouTube Data API v3, with local dedup and quota-safe multi-key rotation.
</p>

YouTube Pro (Scout rework) is a single-purpose, local-first creator discovery tool. Give it keywords and filters, it searches YouTube for videos matching each keyword, enriches the unique channels it finds, applies your filters, and shows only the channels that match — remembering every channel it has ever evaluated in a local SQLite database so future runs never re-fetch or re-show the same channel.

YouTube Pro is an independent project. It is not affiliated with, endorsed by, or sponsored by YouTube or Google. YouTube and Google product names are trademarks of their respective owners.

> **Rework note:** This repository was reworked from the previous Research → Insights → Ideas → Script → Thumbnail workspace. That multi-step AI workflow, Gemini integration, IndexedDB workflow history, and the `/ideas` redirect have been removed. See [context/project-overview.md](context/project-overview.md) for the current spec.

## What it does

- **Multi-keyword discovery:** Searches `search.list` (`type=video`) per keyword, deduplicates by channel across the whole run. Video search is intentional — it finds channels actively producing on-topic content, not just channels whose name matches a keyword.
- **Filtered qualification:** Applies subscriber range, recency, average-views, and optional engagement-rate filters against fresh public metadata. Channels with a hidden subscriber count are always excluded (never guessed at).
- **Persistent dedup:** Every evaluated channel — qualified or filtered out — is stored locally in SQLite (`data/scout.db`). The next run with the same keywords skips known channels entirely, saving quota and time.
- **Quota-safe multi-key rotation:** Configure multiple YouTube Data API v3 keys. The server tracks estimated quota usage per key per day (quota resets at midnight Pacific) and proactively rotates to the next key with remaining quota. A `403 quotaExceeded` is also caught, the key is marked exhausted, and the same call is retried once on the next key. If all keys are exhausted mid-run, the run ends cleanly with partial results and a clear status — no crash, no blank page.
- **Single-page results table:** Channel Name, Channel URL (linked), Subscriber Count, Avg Views (last up to 10 videos), Engagement Rate % (if computable), Last Upload Date, Days Since Last Upload, Matched Keyword — plus a status line stating how the run ended and how many channels were found vs. requested.
- **No CSV export, no AI step.** AI is explicitly deferred. If added later it must go through the NaraRouter gateway (`https://router.bynara.id/v1`, OpenAI-Chat-Completions-compatible, `sk-nry-...` Bearer key) — not Gemini. No AI code ships in this rework.

## Workflow

1. **Open the app** — single page, no multi-step workflow and no sidebar of saved workflows.
2. **Fill the form:**
   - Keywords — one per line or comma-separated (sane cap applied in the form, e.g. 25)
   - Minimum subscribers
   - Maximum subscribers
   - Maximum days since last upload
   - Minimum average views (mean over the last up to 10 videos)
   - Minimum engagement rate % (optional; derived as mean `(likeCount + commentCount) / viewCount * 100` across the same videos, left `null` when `viewCount` is 0/missing)
   - Number of creators to find (target count)
3. **Run Scout** — progress streams as e.g. `Searching keyword 2 of 5 … 4 creators found so far`.
4. **Stop condition** — the first of: target count of qualified channels reached, all keywords exhausted, or all configured keys out of quota for today.
5. **Review the table** — sortable/scrollable results with all computed fields and a status line (`target_reached` / `keywords_exhausted` / `quota_exhausted`) with found vs. requested counts.
6. **Run again** — any channel already in the local database is silently skipped, regardless of keyword. It is never re-fetched or re-shown.

## Requirements

- Node.js 22.12 or newer. CI verifies Node.js 22.12 and the current Node.js 24 LTS line.
- One or more YouTube Data API v3 keys (quota is per-key, per-day). Create keys in Google Cloud Console with YouTube Data API v3 enabled.

Copy the example configuration and fill it locally:

```bash
cp .env.example .env
npm install
npm run dev
```

The server listens on `127.0.0.1:5000` by default. Open `http://127.0.0.1:5000`.

You can instead start without keys and add them in **Settings**. Settings writes replacements to the ignored `.env` file with owner-only permissions. Saved values are never returned to the browser. Settings accepts direct loopback, same-origin requests only and rejects normal forwarded or reverse-proxy requests.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `YOUTUBE_API_KEYS` | Comma-separated YouTube Data API v3 keys (rotation order = list order) | — |
| `YOUTUBE_API_KEY` | Single-key fallback for backward compatibility | — |
| `PORT` | Local HTTP port | `5000` |
| `HOST` | Bind address | `127.0.0.1` |

`YOUTUBE_API_KEYS` takes precedence when both are set. The Settings page exposes the keys as one-per-line (stored as comma-separated in `.env`) and never echoes saved values back to the client.

The local SQLite file lives at `data/scout.db` (gitignored). It holds the `channels` table (every evaluated channel) and the `api_key_usage` table (per-key, per-day quota accounting in Pacific time). Deleting the file resets dedup history and usage counters — no migration step is required.

## How the discovery pipeline works

For each keyword, in order:

1. `search.list` (`type=video`, 100 units/call) — collect video results, extract unique `channelId` values.
2. Skip any `channelId` already in `channels` (`isChannelKnown`) — no API spend.
3. Batch remaining IDs into `channels.list` (up to 50 IDs/call, 1 unit/call) — subscriber count, `hiddenSubscriberCount`, uploads playlist ID.
4. Hidden-subscriber or out-of-range subscriber count → `recordChannel(..., qualified=false)` and stop for that channel.
5. `playlistItems.list` (1 unit) on the uploads playlist → up to 10 most recent video IDs.
6. Batch video IDs into `videos.list` (up to 50 IDs/call, 1 unit/call) → `viewCount`, `likeCount`, `commentCount`, `publishedAt`.
7. Compute `avg_views`, `days_since_last_upload` (from most recent `publishedAt`), and `engagement_rate_pct` (mean `(likes+comments)/views` where `views > 0`).
8. Apply max-days, min-avg-views, and optional min-engagement-rate filters → `recordChannel(..., qualified=true/false)`.
9. After every YouTube call, `addUsage(keyLabel, units)` for proactive rotation.
10. Any `403 quotaExceeded` → mark key exhausted for today, rotate, retry the same call once. No keys left → end run gracefully with accumulated qualified channels.

This ordering is the main quota saving: `playlistItems.list` (1 unit) is used for recent videos instead of a second `search.list` (100 units), and every channel is recorded whether it qualified or not so it is never re-evaluated.

## Data and request limits

- Keywords: at least 1 keyword per run; form caps at a sane maximum (e.g. 25) to avoid accidental quota-draining runs.
- Filters: subscriber min/max must be non-negative integers (`min <= max` when both set); `maxDaysSinceUpload`, `minAvgViews`, and `targetCount` are positive integers; `minEngagementRate` is an optional percentage.
- Recent-video sample: up to 10 most recent uploads per channel; fewer if the channel has fewer public videos.
- Engagement rate: derived, not a native API field; `null` when no sampled video has a usable `viewCount`.
- Hidden subscriber count: channel is recorded as `qualified=false` and never shown in results.
- Global JSON body: unchanged limit for API payloads (the previous 18 MB thumbnail-reference ceiling no longer applies; the Scout payload is small JSON).
- Billable YouTube route (`POST /api/scout`): 10 requests per client address per 60 seconds in this single-process local server (same in-memory limiter as before, suitable for local use only — not a distributed deployment).

## Privacy and access model

- There is no login screen, initial password, or gated workflow.
- YouTube API keys stay server-side in `.env` (ignored) and in `data/scout.db` usage counters; they are never returned to the browser or written to client storage.
- Dedup history (`data/scout.db`) stays on disk next to the server, not in the browser and not synced elsewhere. It contains only public channel metadata, not API keys.
- Request and response bodies are not logged.
- The application binds to loopback unless `HOST` is explicitly changed.
- Do not expose the server directly to the internet. If remote access is required, add authentication and rate limiting at a trusted gateway, and disable or separately protect local Settings.
- The in-memory rate limiter is per process. It is suitable for this local-first default, not a distributed public deployment.

## Commands

```bash
npm run dev       # development server
npm test          # contract and provider-behavior tests (fixtures/mocks only — no live quota spend)
npm run check     # TypeScript check
npm run build     # production client and server build
npm start         # run the production build
```

Continuous integration runs the test suite, TypeScript check, and production build on every pull request and push to `main`.

## Technology

- React 18, TypeScript, Vite, Tailwind CSS, and shadcn/ui
- Express 5
- YouTube Data API v3 (`search.list`, `channels.list`, `playlistItems.list`, `videos.list`)
- SQLite via `better-sqlite3` (local file `data/scout.db`)
- Zod for request/response validation
- No server-side Gemini/AI integration, no Replit AI proxy, no session store, no Passport authentication

## Quotas and costs

- `search.list` costs 100 units per call regardless of `type`; `channels.list`, `videos.list`, and `playlistItems.list` each cost 1 unit per call (batching up to 50 IDs does not increase cost). These are the figures the pipeline's quota accounting is based on — if Google changes them, update the constants in `server/youtube.ts` in one place.
- Each YouTube API key has its own daily quota (default 10,000 units/day for new projects, configurable in Google Cloud Console). The app's multi-key rotation stretches the effective daily budget across keys.
- Check the current official docs before changing keys or making the server remotely accessible:
  - [YouTube Data API quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)
  - [YouTube Data API — search.list](https://developers.google.com/youtube/v3/docs/search/list)
  - [YouTube Data API — channels.list](https://developers.google.com/youtube/v3/docs/channels/list)
  - [YouTube Data API — videos.list](https://developers.google.com/youtube/v3/docs/videos/list)

## License

YouTube Pro is open source under the [Apache License 2.0](LICENSE).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local quality gate. Report security issues privately according to [SECURITY.md](SECURITY.md), never in a public issue.
