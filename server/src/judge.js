// One judging call: reference posts + candidate frames -> per-candidate face and taste scores,
// through the official Anthropic SDK. The client is passed in so tests can use a fake.
import Anthropic from '@anthropic-ai/sdk';
import { judgePrompt, JUDGE_SCHEMA, normalizeJudgments } from './prompt.js';
import { HttpError } from './validate.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function createJudge({ client, model, effort, fallbacks }) {
  return async function judge({ brief, references, candidates }, { signal } = {}) {
    const image = (x) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: x.data } });
    const params = {
      model,
      max_tokens: 16000,
      output_config: { effort, format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          ...references.map(image),
          ...candidates.map(image),
          { type: 'text', text: judgePrompt(references.length, candidates.length, brief) },
        ],
      }],
    };
    // If a safety classifier declines, the API re-runs the request on a fallback model in the same call.
    if (fallbacks) Object.assign(params, { betas: [FALLBACK_BETA], fallbacks });

    const response = await client.beta.messages.create(params, { signal });

    if (response.stop_reason === 'refusal') {
      throw new HttpError(502, 'refused', 'Claude declined to judge this batch.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new HttpError(502, 'truncated', 'The judging answer was cut off. Try a smaller batch.');
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      throw new HttpError(502, 'bad_model_output', 'Claude returned an answer that could not be read.');
    }
    const { results, missing } = normalizeJudgments(parsed, candidates.map((c) => c.id));
    const u = response.usage || {};
    return {
      results,
      missing,
      model: response.model,
      usage: {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      },
    };
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
