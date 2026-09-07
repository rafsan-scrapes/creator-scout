# YouTube Pro — Creator Scout Rework

## Overview

YouTube Pro is being reworked from an AI-heavy research/script/thumbnail
workspace into a single-purpose creator discovery tool. The reworked app
takes a list of YouTube search keywords plus a set of filters (subscriber
range, max days since last upload, minimum average views, minimum
engagement rate if available, and a target number of creators to find),
runs entirely against the YouTube Data API v3, and displays the qualifying
channels in a results table on the page. Every channel it finds is stored
in a local database so future runs automatically skip channels already
seen, saving both API quota and time. There is no CSV export and no AI
step in this version — AI is explicitly deferred to a future, optional
phase.

This is a personal/internal tool, not a public product. It keeps the
existing Node.js/TypeScript/Express/React/Vite/shadcn foundation from the
original repository and removes everything unrelated to this one job.

## Goals

1. Given N keywords and a set of filters, find up to a target number of
   YouTube channels that match all filters, using only the YouTube Data
   API v3.
2. Never repeat a channel across runs — every channel found (or ruled
   out) is remembered locally.
3. Run safely against YouTube's daily quota across multiple rotating API
   keys, and degrade gracefully (return partial results, no crash) if
   quota runs out mid-run.
4. Remove all Gemini/AI-insights/script-writing/thumbnail-generation
   functionality and the UI built around it.
5. Keep the rework minimal-invention: reuse the existing project's
   structure, tooling, and UI kit wherever it still fits, rather than
   rebuilding from scratch.

## Core User Flow

1. User opens the app (single page — no multi-step workflow, no sidebar
   of saved workflows).
2. User fills in a form:
   - Keywords (one per line or comma-separated)
   - Minimum subscribers
   - Maximum subscribers
   - Maximum days since last upload
   - Minimum average views (based on the last 10 videos)
   - Number of creators to find (target count)
3. User clicks "Run Scout" (or similar).
4. The app searches YouTube per keyword, enriches and filters candidate
   channels, and streams/display progress (e.g. "Searching keyword 2 of
   5… 4 creators found so far").
5. The app stops when it reaches the target count, exhausts all
   keywords, or exhausts all configured API keys' quota — whichever
   comes first.
6. Results appear in a table: Channel Name, Channel URL (linked),
   Subscriber Count, Avg Views (last up to 10 videos), Engagement Rate %
   (if computable), Last Upload Date, Days Since Last Upload, Matched
   Keyword.
7. A status line reports how the run ended (target reached / keywords
   exhausted / quota exhausted) and how many channels were found vs.
   requested.
8. On the next run, any channel already in the local database is
   skipped automatically — it will never be re-fetched or re-shown.

## Features

### Creator Discovery

- Multi-keyword search against `search.list` (type=video), deduplicated
  by channel across all keywords in a single run.
- Filtering by subscriber range, max days since last upload, minimum
  average views over the last (up to) 10 uploaded videos, and an
  optional minimum engagement rate.
- Configurable target count of creators to return per run.
- Skips channels with a hidden subscriber count (cannot be filtered
  reliably, so they're excluded rather than guessed at).

### Quota-Safe Multi-Key YouTube API Access

- Settings field for multiple YouTube Data API v3 keys (not just one).
- Automatic rotation to the next key when the active key's daily quota
  is exhausted (tracked proactively in the database, with a `403
  quotaExceeded` catch as a backstop).
- If every configured key's quota is exhausted mid-run, the run ends
  cleanly and returns whatever channels were already found, with a
  clear status message — it never crashes or returns nothing.

### Persistent Dedup Database

- Every channel the app has ever evaluated (whether it qualified or
  was filtered out) is stored locally in SQLite.
- Future runs never re-fetch a channel already in the database,
  regardless of keyword — this is the main quota-saving mechanism.

### Results Display

- A single results table on the page (no CSV, no download step).
- Sortable/scrollable list of qualifying creators with all computed
  fields visible.

### (Removed) Legacy Features

The following features exist in the current repo and are explicitly
being removed in this rework — see the companion instructions file for
the removal order:

- Gemini-powered AI Insights, Grounded Ideas, Script Writer, Thumbnail
  Creator, and their supporting evidence-contract system.
- The multi-step Research → Insights → Ideas → Script → Thumbnail
  workflow and its sidebar of saved workflows (IndexedDB history).
- Any AI provider integration (Gemini specifically is being dropped
  entirely, not swapped 1:1 — see below).

### (Deferred, Optional) Future AI Add-On

- Not built in this rework. If AI is added later (e.g. to summarize a
  batch of found creators, or help write outreach messages), it must
  use the NaraRouter gateway (`https://router.bynara.id/v1`), which is
  OpenAI-Chat-Completions-compatible, authenticated with a
  `sk-nry-...` Bearer key — **not Gemini**. This is a placeholder for
  future scope only; no AI code should be written in this rework.

## Scope

### In Scope

- Rewriting the server's YouTube integration to support the new
  filter set and multi-key rotation.
- Adding a SQLite-backed persistence layer for discovered channels and
  per-key quota usage.
- Rebuilding the client into a single scout form + results table page.
- Extending Settings to manage a list of YouTube API keys instead of
  one.
- Removing all Gemini/AI, script, thumbnail, and multi-workflow code
  and UI.
- Updating README/HANDOFF-style docs to reflect the new product.

### Out of Scope

- CSV or any file export.
- Any AI/LLM feature (Insights, Ideas, Script, Thumbnails, or anything
  new) — including NaraRouter integration itself; only the *option* to
  add it later is preserved architecturally.
- User accounts, authentication, or multi-user support (stays
  local-first/loopback, same as the original).
- Deploying this remotely or exposing it to the internet.
- Historical run browsing/saved workflows UI (the DB retains data, but
  there's no UI requirement to browse past runs — the value is purely
  "don't re-show channels already seen").

## Success Criteria

1. A user can enter keywords and filters, run a scout, and see a table
   of matching channels with all required fields populated correctly.
2. Running the same keywords twice in a row returns zero duplicate
   channels the second time (already-seen channels are silently
   skipped, not re-displayed).
3. Configuring 3 YouTube API keys and artificially exhausting the
   first key's quota mid-run causes the app to continue on the second
   key without user intervention or error.
4. Exhausting all configured keys' quota mid-run ends the run cleanly
   with a status message and whatever partial results were found — no
   unhandled crash, no blank page.
5. Channels with a hidden subscriber count never appear in results.
6. No Gemini API key, Gemini code path, script writer, thumbnail
   creator, or multi-step workflow sidebar remains in the codebase.
7. `npm run check`, `npm test`, and `npm run build` all pass against
   the reworked codebase.