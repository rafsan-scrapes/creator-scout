# Security Policy

## Reporting a vulnerability

Do not report suspected vulnerabilities in a public issue. Use the repository's private security advisory flow, or contact the repository owner through an already approved private channel.

Include the affected route or component, reproduction steps, expected impact, and a minimal proof of concept. Remove API keys, access tokens, personal data, and private channel data from all reports and screenshots.

## Supported configuration

The current supported configuration is local-first (Creator Scout rework):

- The server binds to `127.0.0.1` by default.
- YouTube Data API v3 keys (`YOUTUBE_API_KEYS` / `YOUTUBE_API_KEY` fallback) remain in the server environment (`.env`, gitignored) and in local quota counters — they are never returned to the browser or written to client storage.
- The local Settings endpoint accepts same-origin loopback requests only and rejects normal forwarded/reverse-proxy requests.
- The billable Scout route (`POST /api/scout`) uses an in-memory per-process rate limiter (10 req / 60s per client address).
- Local SQLite state (`data/scout.db`, gitignored) holds only public channel metadata and per-key daily quota counters — it is not synced elsewhere and deleting it resets dedup history.

This is not a hardened multi-user internet service. Before remote deployment, add authenticated access, a trusted secret-management path, a shared rate limiter, request observability that excludes secrets and content bodies, and a deployment-specific threat review. Disable or separately protect local Settings when exposing the server beyond loopback.

> **Rework note:** Gemini/AI provider configuration (`GEMINI_API_KEY`, `GEMINI_TEXT_MODEL`, `GEMINI_IMAGE_MODEL`, `@google/genai`) has been removed. The only provider in this rework is the YouTube Data API v3. If AI is added in a future phase it must go through NaraRouter (`https://router.bynara.id/v1`) — not Gemini.

## Credential response

If a credential is accidentally committed, revoke or rotate it immediately. Removing it from the latest commit is not sufficient because Git history and clones may retain the value.
