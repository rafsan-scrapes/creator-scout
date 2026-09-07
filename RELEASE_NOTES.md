# Release notes

## 2026-09-07: Creator Scout rework (current)

This is a hard pivot of the same repository from the previous multi-step AI workspace to a single-purpose, local-first **Creator Scout** — a YouTube creator discovery tool with no AI step and no CSV export. See `README.md` and `context/project-overview.md` for the current spec.

### What changed

- **New product — single-page Scout:** Keyword + filter form (subscriber range, max days since last upload, min avg views over last up to 10 videos, optional min engagement rate, target count) → `POST /api/scout` → results table (Channel Name linked to `channel_url`, Subscriber Count, Avg Views, Engagement Rate % if computable, Last Upload Date, Days Since Last Upload, Matched Keyword) plus a clear end status (`target_reached` / `keywords_exhausted` / `quota_exhausted`) and found vs. requested counts. Progress is surfaced as e.g. "Searching keyword 2 of 5 … 4 creators found so far".
- **Persistent dedup:** Every evaluated channel (qualified or filtered out) is stored in local SQLite `data/scout.db` (`channels` / `api_key_usage`, gitignored). Future runs skip known `channelId`s entirely — the main quota-saving guarantee. Deleting the DB resets history.
- **Quota-safe multi-key rotation:** `YOUTUBE_API_KEYS` (comma-separated, rotation order = list order) with `YOUTUBE_API_KEY` single-key fallback. Proactive per-call accounting in Pacific-time `YYYY-MM-DD` plus `403 quotaExceeded` catch → mark exhausted → retry once on next key. If all keys are exhausted mid-run, the run ends cleanly with partial qualified results and `quota_exhausted` — no crash or blank page.
- **Cheapest pipeline by design:** `search.list` (`type=video`, 100 units) → `channels.list` (1 unit, batched 50) → `playlistItems.list` on the uploads playlist (1 unit, replaces a second `search.list`) → `videos.list` (1 unit, batched 50). Derived `avg_views`, `days_since_last_upload`, and `engagement_rate_pct = mean((likeCount+commentCount)/viewCount*100)`; hidden-subscriber channels are always excluded, never estimated.
- **Settings:** Now manages a list of YouTube keys (one per line in the UI, stored comma-separated in `.env`), owner-only `.env` write, never returned to the browser, loopback/same-origin only.
- **Docs:** `README.md`, `HANDOFF.md`, `CONTRIBUTING.md`, `PORTING.md`, `SECURITY.md`, `docs/YOUTUBE_RESEARCH_PLAYBOOK.md` (now _Creator Scout — Discovery Playbook_), and `.env.example` rewritten for Scout. `docs/launch-video/` is archived — it described the retired workspace and is kept for reference only.

### Removed (intentionally, not a regression)

- Gemini / `@google/genai`, AI Insights, Grounded Ideas, Script Writer + teleprompter, Thumbnail Creator, evidence-contract system (`shared/evidence-contracts.ts`), IndexedDB recent-workflows sidebar and `/ideas` redirect, and CSV/file export. If AI is added later it must go through NaraRouter (`https://router.bynara.id/v1`, OpenAI-Chat-Completions-compatible, `sk-nry-...` Bearer key) — not Gemini — and is out of scope for this rework.

### Privacy and storage boundaries (current)

- YouTube keys stay server-side (`.env` + per-key daily counters); never returned to the browser.
- `data/scout.db` holds only public channel metadata and quota counters on local disk; not synced elsewhere.
- Request/response bodies are not logged. Local Settings rejects forwarded/reverse-proxy requests.
- Loopback-only by default — same internet-exposure warning as before applies.

### Verification

- `npm test` — fixtures/mocks only, no live YouTube or AI calls (must pass)
- `npm run check` — TypeScript check (must pass)
- `npm run build` — production client and server build (must pass)
- Manual live-key acceptance pass with real (rate-limited) YouTube keys — confirm end-to-end Scout run returns and displays results and that the dedup skip works on a second run with the same keywords (kept distinct from automated verification, per `HANDOFF.md`)

### Release boundary

Same as before: this is a local-first application, not a hardened multi-user internet service. Do not expose the server directly to the internet without the authentication, secret-management, shared rate-limiting, and deployment-specific security controls described in `SECURITY.md`.

---

## 2026-08-25: Version 1.0.0 public release — retired workspace

> **Archived:** This release described the retired Research → Insights → Ideas → Script → Thumbnail workspace. It is kept for history. The current product is the Creator Scout rework above.

This release brings the complete local-first workflow, current product documentation, and release checks together in the public GitHub repository.

### Included

- **Complete creation workflow:** Research, evidence-grounded AI Insights, automatically generated Ideas, Script Writer with teleprompter, and Thumbnail Creator remain connected through one restorable project.
- **Workflow history controls:** The eight most recent browser-local projects can be reopened, renamed, or deleted after explicit confirmation.
- **Current product tour:** Five current screenshots document Research analytics, source videos, AI Insights, the Script teleprompter, and Thumbnail Creator.
- **Launch package:** A five-minute demonstration script, presentation, shot list, and YouTube publishing package are available under `docs/launch-video/`.
- **Open-source repository:** The exact release is available at `AgriciDaniel/youtubepro` under the Apache License 2.0.

### Verification

- `npm test`: 62 tests passed
- `npm run check`: TypeScript check passed
- `npm run build`: Production client and server builds completed
- `npm audit --audit-level=high`: 0 vulnerabilities
- Current source scan outside the ignored `.env`: 0 secret findings
- GitHub Actions runs the same test, TypeScript, and production-build gates on every push and pull request

### Release boundary

This is a local-first application release, not a hardened multi-user internet service. Do not expose the server directly to the internet without the authentication, secret-management, shared rate-limiting, and deployment-specific security controls described in `SECURITY.md`.

## 2026-08-24: Restorable local workflows and refreshed research experience — retired workspace

> **Archived:** Part of the retired workspace (pre-Scout). Kept for history.

This update makes YouTube Pro easier to leave and resume. Research, generated ideas, scripts, and thumbnail work now stay grouped as local workflows, while the research brief presents dense AI output in a more visual, scan-first format.

### Added

- **Recent workflows:** The sidebar lists the eight most recently updated projects and reopens the last useful Research, Script Writer, or Thumbnail Creator step.
- **Browser-local persistence:** Research snapshots, AI Insights, grounded ideas, script output and revisions, thumbnail briefs, and generated thumbnail results are stored in IndexedDB.
- **Independent projects:** **New Workflow** starts a fresh project without replacing earlier work in the recent-workflow list.
- **Workflow management:** Recent projects can be renamed from the sidebar or deleted after explicit confirmation.
- **Workflow helper tests:** Shared title, ordering, deduplication, and history-limit behavior now have focused automated coverage.

### Improved

- **Research readability:** AI Insights use compact visual summaries, expandable findings, opportunity cards, and collapsed evidence and methodology details.
- **Evidence clarity:** Observed findings, inferred recommendations, and metrics that require channel-owner YouTube Studio data remain visibly separated.
- **Resume behavior:** Research results are saved as soon as the public-data snapshot returns, then enriched again when AI Insights and grounded ideas finish.
- **Script Writer:** Generated output, supporting metadata, form inputs, and user revisions restore with the selected workflow.
- **Thumbnail Creator:** The brief, advanced visual controls, generated image, and model information restore with the selected workflow.
- **Navigation:** Opening a saved workflow returns to the most useful completed step instead of an empty route.

### Documentation

- Replaced the product-tour captures with five current screenshots covering Research analytics, Source Videos, AI Insights, the Script teleprompter, and Thumbnail Creator.
- Expanded the README with workflow-history behavior, local-storage boundaries, and restoration details.

### Privacy and storage boundaries

- Workflow history remains in the current browser profile. It is not synchronized to a server or another device.
- API keys remain server-side and are not written into workflow history.
- Uploaded thumbnail reference images are not retained. Users must select them again for a later generation.
- Research continues to use public YouTube Data API metadata. Owner-only metrics such as impressions, click-through rate, traffic sources, and retention require YouTube Studio and are not inferred as public facts.

### Verification

- `npm test`: 61 tests passed
- `npm run check`: TypeScript check passed
- `npm run build`: Production client and server builds completed
- README image-reference and source-image checksum checks passed
