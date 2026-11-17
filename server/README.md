# Loupe server (prototype)

A small Node.js backend that lets Claude choose the picks from a shoot, through the official
Anthropic SDK, so the Anthropic API key stays on the server. The Vercel frontend calls it on
Render; locally it also serves the app itself.

> **Not production-secure.** There is no user authentication: anyone who finds the URL can call
> `/api/select` and spend the key's credits, up to the daily budget cap. The rate limit and budget
> live in memory, and images travel inline in the request. The list of what must change before a
> real public service is at the end.

## How a cull works

```
browser (app/, on Vercel or localhost)                 server/ (Render or localhost)          Anthropic API
──────────────────────────────────────                 ─────────────────────────────          ─────────────
"Cull frames" → startCull()
  cull(): EXIF times, dimensions, scenes, bursts,
          sharpness / exposure / eyes / faces (local)
  runClaudeSelection()                       "Preparing photos"
    up to 40 frames as the existing 480px JPEG previews,
    3 past edits, brief, style tags,
    per-frame metadata (time, size, scene, burst, flags)
    ── POST /api/select ──▶ validate (sizes, JPEG, ids, metadata)
                            budget + rate limit
                            selectPrompt() + all images ───────▶ one messages.create
                                                       "Analyzing with Claude"
                            normalize: ids, ranking,  ◀──────── JSON (structured output)
    ◀── selected + ranking + reasons + usage + cost ──
  picks = Claude's selection                 "Selection complete" (tokens, est. cost)
```

Claude sees every candidate image in one request and chooses. The local checks are passed as
hints and the prompt tells Claude to trust the image when they disagree. The app's manual
overrides (✓ / ＋) still work on top of Claude's answer: removing a pick refills from Claude's ranking.

If anything fails (server asleep, CORS, budget, Anthropic error) the page shows **AI selection failed**
with the reason, picks nothing, and offers **Try Claude again** or **Use local-only selection**.
Local scoring only runs when the creator chooses it, or when no backend is configured (and the page says so).

Model: `claude-opus-5-5` at `medium` effort, with server-side refusal fallback on (if a safety
classifier declines, the API retries on a fallback model inside the same call). All configurable.

## Run it locally

Needs Node 18.18 or newer.

```bash
cd server
npm install
cp .env.example .env      # then put your key after ANTHROPIC_API_KEY=
npm start
```

Open http://localhost:5179. On localhost the page calls the API on its own origin, so no CORS setup
is needed. To point a local page at another backend (e.g. the Render one), run this in the browser
console: `localStorage.setItem('loupe.apiBase', 'https://your-service.onrender.com')` (remove it to undo).

## Deploy (Vercel frontend + Render backend)

**Render** (Web Service, root directory `server`, build `npm install`, start `npm start`), Environment:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your key (only here, never in the repo) |
| `ALLOWED_ORIGINS` | your Vercel origin, e.g. `https://your-site.vercel.app` (no trailing slash; comma-separate several) |
| `DAILY_BUDGET_USD` | optional, default `5` |
| `STATIC_DIR` | optional: set empty if Render shouldn't also serve the app |

Render sets `PORT`; the server listens on `0.0.0.0`.

**Vercel** serves `app/`. The backend URL is the `loupe-api-base` meta tag in `app/index.html`
(a public URL, not a secret). The page only uses it when it isn't on localhost.

**Check it live:** open the Vercel site, DevTools → Network → Fetch/XHR, load the sample shoot,
click **Cull frames**. You should see `OPTIONS` then `POST …onrender.com/api/select` (status 200),
the banner go Preparing photos → Analyzing with Claude → Selection complete with token counts and
an estimated cost, Render's log show a `claude_request` line with `"status":"success"`, and usage
appear in the Anthropic Console a few minutes later.

## Tests

```bash
cd server
npm test
```

Node's built-in test runner with a fake Anthropic client: no network, no key, no cost. Covers
request and metadata validation, the prompt and selection normalization, the SDK request shape,
refusal / truncation / error logging, cost estimates and the daily budget, CORS preflight and origin
checks, body-size and rate limits, error mapping, static file serving, and that logs never contain image data.

## API

### `GET /api/health`

```json
{ "ok": true, "judge": true, "model": "claude-opus-5-5",
  "limits": { "maxReferences": 3, "maxCandidates": 40, "maxImageBytes": 524288, "maxImageSide": 1024 } }
```

### `POST /api/select`

`Content-Type: application/json`

```json
{
  "brief": "6 picks, warm golden film vibe, no closed eyes",
  "target": 6,
  "styleTags": ["Warm", "Soft contrast"],
  "references": [{ "id": "ref-1", "data": "<base64 JPEG>" }],
  "candidates": [{
    "id": "p12", "data": "<base64 JPEG>",
    "meta": { "takenAt": "2026-11-08T18:42:05.000Z", "width": 4032, "height": 3024,
              "scene": 0, "burst": 3, "burstSize": 4, "flags": ["eyes_closed"] }
  }]
}
```

- `references`: up to 3 past posts. `candidates`: up to 40 frames, all sent to Claude in one request.
- `target`: how many to choose, 1 to the number of candidates (default 6).
- `data`: plain base64 JPEG (no `data:` prefix), at most 512 KB decoded and 1024 px on the long side.
- `meta` (optional): only these typed fields. `flags` from `blurry`, `dark`, `bright`, `eyes_closed`, `no_face`.
  No free text is accepted, so metadata can't carry instructions to the model.
- `id`: an opaque label, 1-64 of `A-Z a-z 0-9 - _`, unique in the request. Unknown fields are rejected.

Response:

```json
{
  "requestId": "…",
  "selected": [{ "id": "p12", "rank": 1, "reason": "Genuine laugh, eyes open, warm backlight", "byClaude": true }],
  "ranking": ["p12", "p15", "p3"],
  "results": [
    { "id": "p12", "person": true, "eyes_open": 0.95, "expression": 0.8, "angle": 0.85,
      "taste": 0.72, "faces": [[0.31, 0.22, 0.52, 0.5]], "note": "Genuine smile, eyes open" }
  ],
  "missing": [],
  "filledFromRanking": false,
  "model": "claude-opus-5-5",
  "usage": { "input_tokens": 9120, "output_tokens": 640, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 },
  "costUsd": 0.04928,
  "durationMs": 23810
}
```

`selected` is Claude's choice in order (`byClaude: false` marks a slot filled from Claude's ranking
when it returned fewer than asked). `ranking` lists every candidate, best first. `costUsd` is an
estimate from list prices; the Anthropic Console is the source of truth.

Errors: `{ "requestId": "…", "error": { "code": "…", "message": "…" } }` with status
400 (invalid input), 403 (origin), 405, 413 (too large), 415 (not JSON / not JPEG), 429 (rate limited),
503 (busy or `budget_exhausted`), 500/502/504 (server or upstream). Upstream details are logged, not returned.

## Logs

One JSON line per event. Per Claude request (`"event":"claude_request"`): request id, photos submitted,
requested and serving model, input / output / cache tokens, estimated cost (USD), duration, stop reason,
and `"status":"success"` or `"failure"` with the error. Never the API key, image bytes or base64.

## Security in this phase

- The key is read by the SDK from `ANTHROPIC_API_KEY` on the server. It is never in browser code,
  responses or logs. `.env` is git-ignored; only `.env.example` is committed.
- Listens on `0.0.0.0` and `PORT` (default 5179), as Render requires. Set `HOST=127.0.0.1` locally
  to keep it on this machine only.
- CORS: only origins in `ALLOWED_ORIGINS` get the allow headers; other browser origins get 403.
  This stops other websites using a visitor's browser, **not** scripts calling the URL directly.
- Strict input checks: count, byte size, JPEG signature and dimensions, base64, ids, typed metadata,
  no unknown fields. No URLs, storage keys or user ids are accepted from the client.
- Cost control: one request per cull, at most 40 previews, an in-memory daily budget (default $5),
  20 requests per minute per address, 2 Claude calls at once, one SDK retry.
- Privacy: only 480px previews leave the browser; no originals, GPS or file names. Images are not stored.

## Before any public deployment

This is what the prototype does not do. None of it is optional for a real public service.

1. **Authentication.** Every API call must come from a signed-in user; derive the user id from the
   verified session or token on the server, never from the request body.
2. **Ownership checks.** Reference photos and shoots must belong to the caller; validate on the server.
3. **Storage.** Move images out of request bodies into private S3-compatible storage with short-lived
   presigned uploads, generating object keys on the server. The server reads objects by its own keys only.
4. **Async jobs.** `POST /api/select` creates a job (BullMQ on Redis) and returns `jobId`;
   `GET /api/select/:jobId` returns status and results. Job state and results in PostgreSQL.
5. **Idempotency.** Accept an `Idempotency-Key` per job so retries don't double-charge.
6. **Shared rate limits and quotas** (Redis), per user and per organization, plus per-user spend caps
   (the current budget is per process and resets on restart).
7. **Retries with backoff** in the worker for 429/5xx.
8. **Usage monitoring.** Persist `usage` and cost per job and user; alert on spend; dashboards for latency and errors.
9. **Transport and headers.** HTTPS only, HSTS, a strict Content-Security-Policy.
10. **Secrets** from a secret manager, rotated; separate keys per environment.
11. **Data handling.** Retention and deletion policy, consent text, and a privacy review
    (these are photos of people's faces).
12. **Abuse.** Image content checks, request signing for internal services, and audit logs.
13. **Ref face boxes.** The artifact also asked Claude to find faces in past edits (`findRefFaces`).
    The backend skips that and relies on the in-browser landmark detector.
14. **Shoots over 40 frames.** Today the extra frames are set aside by local checks before Claude sees them;
    a multi-round selection (Claude shortlists per scene, then chooses) would let Claude see everything.
