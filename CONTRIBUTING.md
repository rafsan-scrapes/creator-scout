# Contributing to YouTube Pro — Creator Scout

YouTube Pro (Scout rework) is a single-purpose, local-first creator discovery tool. Contributions should preserve its one-page Scout flow, persistent dedup guarantee, and quota-safe multi-key rotation.

## Local setup

1. Install Node.js 22.12 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and add one or more YouTube Data API v3 keys (comma-separated `YOUTUBE_API_KEYS`, or single `YOUTUBE_API_KEY` fallback), or configure them through the local Settings page.
4. Run `npm run dev` and open `http://127.0.0.1:5000`.

`data/scout.db` (SQLite, gitignored) is created on first run. It stores every evaluated channel and per-key daily quota usage. Deleting it resets dedup history — no migration needed.

Never commit `.env`, `data/scout.db`, provider keys, or any export containing private channel information.

## Required checks

Run all checks before opening a pull request:

```bash
npm test
npm run check
npm run build
```

The automated suite uses fixtures and mocks. It must not spend YouTube quota or make live provider calls.

## Pull requests

- Keep each change focused and explain its user-facing effect.
- Preserve the dedup guarantee: every evaluated channel is recorded (`qualified` true or false) so it is never re-fetched or re-shown.
- Preserve the hidden-subscriber exclusion: channels with `hiddenSubscriberCount` are always recorded as `qualified=false` and never shown in results — never estimate a count.
- Preserve quota-safe behavior: proactive per-call quota counting plus `403 quotaExceeded` catch-and-rotate; if all keys are exhausted mid-run, return partial qualified results with `quota_exhausted` — never crash or blank the page.
- Keep provider credentials and billable YouTube calls on the server; never return saved keys to the browser and never log request/response bodies.
- Do not reintroduce Gemini/AI code (`@google/genai`), Insights/Ideas/Script/Thumbnail routes, IndexedDB workflow history, or CSV export. If AI is added in a future phase it must go through NaraRouter (`https://router.bynara.id/v1`, OpenAI-Chat-Completions-compatible) — not Gemini.
- Add or update focused tests when changing request contracts, provider behavior, dedup/quota logic, or security boundaries.
- Include screenshots for meaningful interface changes in both dark and light themes when practical.
- State which checks were run and any acceptance work that remains.

## License and contributions

By contributing, you agree that your contributions will be licensed under the repository's [Apache License 2.0](LICENSE).
