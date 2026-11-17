// One selection call: reference posts + every candidate frame -> Claude's picks, ranking and
// per-photo scores, through the official Anthropic SDK. The client is passed in so tests can
// use a fake. Each call is logged once (success or failure) with counts, model, tokens,
// estimated cost and duration; never image data or keys.
import Anthropic from '@anthropic-ai/sdk';
import { selectPrompt, SELECT_SCHEMA, normalizeSelection } from './prompt.js';
import { HttpError } from './validate.js';
import { estimateCostUsd } from './pricing.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function createSelector({ client, model, effort, fallbacks, logger, budget }) {
  return async function select(input, { signal, rid } = {}) {
    const { brief, target, styleTags, references, candidates } = input;
    const image = (x) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: x.data } });
    const params = {
      model,
      max_tokens: 16000,
      output_config: { effort, format: { type: 'json_schema', schema: SELECT_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          ...references.map(image),
          ...candidates.map(image),
          { type: 'text', text: selectPrompt({ nRefs: references.length, n: candidates.length, target, brief, styleTags, metas: candidates.map((c) => c.meta) }) },
        ],
      }],
    };
    // If a safety classifier declines, the API re-runs the request on a fallback model in the same call.
    if (fallbacks) Object.assign(params, { betas: [FALLBACK_BETA], fallbacks });

    const t0 = Date.now();
    const base = { rid, event: 'claude_request', photos: references.length + candidates.length, references: references.length, candidates: candidates.length, target, requestedModel: model };
    let response;
    try {
      response = await client.beta.messages.create(params, { signal });
    } catch (e) {
      logger?.error({ ...base, status: 'failure', error: e?.constructor?.name, httpStatus: e?.status, ms: Date.now() - t0 });
      throw e;
    }
    const u = response.usage || {};
    const usage = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    };
    const costUsd = estimateCostUsd(response.model, usage);
    budget?.add(costUsd ?? 0);
    const ms = Date.now() - t0;
    const done = (status, extra = {}) => (status === 'success' ? logger?.info : logger?.error)?.({
      ...base, status, model: response.model, stopReason: response.stop_reason,
      inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens, cacheWriteTokens: usage.cache_creation_input_tokens,
      costUsd, ms, ...extra,
    });

    if (response.stop_reason === 'refusal') { done('failure', { error: 'refused' }); throw new HttpError(502, 'refused', 'Claude declined to evaluate these photos.'); }
    if (response.stop_reason === 'max_tokens') { done('failure', { error: 'truncated' }); throw new HttpError(502, 'truncated', 'Claude\'s answer was cut off. Try fewer photos.'); }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      done('failure', { error: 'bad_model_output' });
      throw new HttpError(502, 'bad_model_output', 'Claude returned an answer that could not be read.');
    }
    const out = normalizeSelection(parsed, candidates.map((c) => c.id), target);
    done('success', { selected: out.selected.length, missing: out.missing.length, filledFromRanking: out.filledFromRanking });
    return { ...out, model: response.model, usage, costUsd, durationMs: ms };
  };
}

// Anthropic SDK errors -> responses that don't leak upstream details to the browser.
export function mapUpstreamError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof Anthropic.RateLimitError) return new HttpError(429, 'upstream_rate_limited', 'Claude is busy right now. Try again in a minute.');
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new HttpError(500, 'server_misconfigured', 'The server cannot reach Claude. Check the server configuration.');
  }
  if (err instanceof Anthropic.BadRequestError) return new HttpError(502, 'upstream_rejected', 'Claude rejected this request.');
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new HttpError(504, 'upstream_timeout', 'Claude took too long to answer.');
  if (err instanceof Anthropic.APIUserAbortError) return new HttpError(499, 'aborted', 'Request was cancelled.');
  if (err instanceof Anthropic.APIConnectionError) return new HttpError(502, 'upstream_unreachable', 'Could not reach Claude.');
  if (err instanceof Anthropic.APIError) return new HttpError(502, 'upstream_error', 'Claude returned an error.');
  return new HttpError(500, 'internal_error', 'Something went wrong on the server.');
}
