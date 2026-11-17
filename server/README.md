# Loupe server (Phase 1, local prototype)

A small Node.js backend that judges photos with Claude through the official Anthropic SDK,
so the Anthropic API key stays on the server. It replaces the Claude Artifact `sample`
capability for local use. The published artifact keeps using its built-in capability.

> **Not production-secure.** There is no user authentication, the rate limit lives in memory,
> and images travel inline in the request. Run it on your own machine only. The list of what
> must change before a public deployment is below.

## What it does

```
browser (app/)                                   server/ (Node)                       Anthropic API
─────────────                                    ──────────────                       ─────────────
analyze, faces, bursts, weighted ranking (local)
judgeWithClaude()
  └─ 480px JPEG thumbnails, base64 ── POST /api/select ──▶ validate (size, JPEG, ids)
                                                         judgePrompt() + images ──▶ messages.create
                                    ◀── results by id ── normalize, clamp          ◀── JSON (structured output)
applyJudgments() → s.judge, s.face
rescore() → same weights, same selection
```

Everything except the Claude call still runs in the browser: image analysis, duplicate and burst
detection, weighted ranking and final selection are unchanged. The server only answers
"how would this creator rate these frames?" for one small batch at a time.

The prompt is the same one the artifact used (`app/js/app.js` `judgePrompt`), with two changes:
the answer is a JSON object `{"photos": [...]}` enforced by structured outputs, and photo numbers
are mapped back to the browser's frame ids on the server. Scores are clamped to 0..1 and face boxes
checked the same way as before, so `applyJudgments()` produces the same `s.judge` / `s.face` values.

Model: `claude-opus-5-5` at `medium` effort, with server-side refusal fallback on (if a safety
classifier declines a batch, the API retries it on a fallback model inside the same call).
All three are configurable.

## Run it

Needs Node 18.18 or newer.

```bash
cd server
npm install
cp .env.example .env
```

Put your key in `server/.env` (git-ignored):

```
ANTHROPIC_API_KEY=sk-ant-...
```

Then:

```bash
npm start
```

Open http://localhost:5179. The server also serves `app/`, so the page and API share one origin
and no CORS is needed. The Pick step gets a **Judge with Claude** button; the toast after judging
shows the tokens used.

Without the server (e.g. `python3 -m http.server 5178 -d app`) the app works as before with
local scoring only. Inside the published artifact it uses the artifact's own Claude capability.

## Tests

```bash
cd server
npm test
```

Uses Node's built-in test runner and a fake Anthropic client: no network, no key, no cost.
Covers request validation, the prompt and output normalization, the SDK request shape,
refusal / truncation handling, origin and content-type checks, body-size and rate limits,
error mapping, static file serving (dotfiles, path traversal) and that logs never contain image data.

## API

### `GET /api/health`

```json
{ "ok": true, "judge": true, "limits": { "maxReferences": 3, "maxCandidates": 13, "maxImageBytes": 524288, "maxImageSide": 1024 } }
```

### `POST /api/select`

`Content-Type: application/json`

```json
{
  "brief": "6 picks, warm golden film vibe, no closed eyes",
  "references": [{ "id": "ref-1", "data": "<base64 JPEG>" }],
  "candidates": [{ "id": "p12", "data": "<base64 JPEG>" }]
}
```

- `references`: up to 3 of the creator's past posts (taste examples). `candidates`: up to 13 frames.
- `data` is plain base64 of a JPEG (no `data:` prefix), at most 512 KB decoded and 1024 px on the long side.
- `id` is an opaque label, 1-64 of `A-Z a-z 0-9 - _`, unique in the request. Unknown fields are rejected.

Response:

```json
{
  "requestId": "…",
  "results": [
    { "id": "p12", "person": true, "eyes_open": 0.95, "expression": 0.8, "angle": 0.85,
      "taste": 0.72, "faces": [[0.31, 0.22, 0.52, 0.5]], "note": "Genuine smile, eyes open" }
  ],
  "missing": [],
  "model": "claude-opus-5-5",
  "usage": { "input_tokens": 9120, "output_tokens": 640, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 }
}
```

`missing` lists candidate ids the model didn't rate; the browser leaves those on local scores.
`model` is the model that served the answer (differs if a refusal fallback ran).

Errors: `{ "requestId": "…", "error": { "code": "…", "message": "…" } }` with status
400 (invalid input), 403 (origin), 405, 413 (too large), 415 (not JSON / not JPEG), 429 (rate limited),
503 (busy), 500/502/504 (server or upstream). Upstream error details are logged, not returned.

## Security in this phase

- The key is read by the SDK from `ANTHROPIC_API_KEY` on the server. It is never in browser code,
  responses or logs. `.env` is git-ignored; only `.env.example` is committed.
- Listens on `127.0.0.1` by default.
- Cross-site protection: requests with an `Origin` other than the allowed list get 403, and only
  `application/json` is accepted, so another website can't make your browser spend your credits.
- Strict input checks: count, byte size, JPEG signature and dimensions, base64 format, id format,
  no unknown fields. No URLs, storage keys or user ids are accepted from the client.
- Logs are JSON lines with request id, counts, byte totals, timing, model and token usage. Never image bytes or base64.
- In-memory rate limit per client address (20/min) and a cap on concurrent Claude calls (2).
- Upstream errors are mapped to generic messages.

## Before any public deployment

This is the list of what Phase 1 does not do. None of it is optional for a public service.

1. **Authentication.** Every API call must come from a signed-in user; derive the user id from the
   verified session or token on the server, never from the request body.
2. **Ownership checks.** Reference photos and shoots must belong to the caller; validate on the server.
3. **Storage.** Move images out of request bodies into private S3-compatible storage with short-lived
   presigned uploads, generating object keys on the server. The server reads objects by its own keys only.
4. **Async jobs.** `POST /api/select` creates a job (BullMQ on Redis) and returns `jobId`;
   `GET /api/select/:jobId` returns status and results. Job state and results in PostgreSQL.
5. **Idempotency.** Accept an `Idempotency-Key` per job so retries don't double-charge.
6. **Shared rate limits and quotas** (Redis), per user and per organization, plus per-user spend caps.
7. **Retries with backoff** in the worker for 429/5xx (the SDK already retries twice per call).
8. **Usage monitoring.** Persist `usage` per job and user; alert on spend; dashboards for latency and errors.
9. **Transport and headers.** HTTPS only, HSTS, a strict Content-Security-Policy, CORS limited to the real origin.
10. **Secrets** from a secret manager, rotated; separate keys per environment.
11. **Data handling.** Retention and deletion policy for uploaded photos, consent text, and a privacy review
    (these are photos of people's faces).
12. **Abuse.** Image content checks, request signing for internal services, and audit logs.
13. **Ref face boxes.** The artifact also asked Claude to find faces in past edits (`findRefFaces`).
    The backend skips that and relies on the in-browser landmark detector; port it if detection misses faces.
14. **Cost.** Consider prompt caching for repeated reference images once batches grow, and measure
    whether `low` effort holds quality for this route.
