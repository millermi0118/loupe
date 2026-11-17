import test from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../src/judge.js';
import { judgePrompt, normalizeJudgments } from '../src/prompt.js';
import { parseSelectRequest, HttpError } from '../src/validate.js';
import { LIMITS, request, fakeClient, message } from './helpers.js';

const photo = (n, extra = {}) => ({ photo: n, person: true, eyes_open: 0.9, expression: 0.7, angle: 0.8, taste: 0.6, faces: [[0.3, 0.2, 0.5, 0.5]], note: 'sharp, eyes open', ...extra });

test('prompt keeps the original judging rules and wording', () => {
  const p = judgePrompt(2, 5, "warm 'film' vibe");
  assert.match(p, /Images 1 to 2 are photos this creator already edited and posted/);
  assert.match(p, /Images 3 to 7 are candidates from a new shoot. Call them photo 1 to 5/);
  assert.match(p, /Be strict: blinks, half-closed eyes/);
  assert.match(p, /taste: how likely this creator would pick this frame to post/);
  assert.match(judgePrompt(0, 4, ''), /The 4 images are candidates from a new shoot, photo 1 to 4/);
});

test('normalize maps photo numbers to ids, clamps and drops junk', () => {
  const { results, missing } = normalizeJudgments({
    photos: [
      photo(2, { taste: 1.7, eyes_open: -3, faces: [[0.1, 0.1, 0.05, 0.3], [0.2, 0.2, 0.4, 0.4]], note: 'x'.repeat(200) }),
      photo(2), photo(9), { photo: 'one' }, null,
    ],
  }, ['p1', 'p2', 'p3']);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'p2');
  assert.equal(results[0].taste, 1);
  assert.equal(results[0].eyes_open, 0);
  assert.deepEqual(results[0].faces, [[0.2, 0.2, 0.4, 0.4]]);
  assert.equal(results[0].note.length, 70);
  assert.deepEqual(missing, ['p1', 'p3']);
});

test('judge sends images then prompt with structured output, and returns usage', async () => {
  const client = fakeClient(message([photo(1), photo(2, { person: false, faces: [] })]));
  const judge = createJudge({ client, model: 'claude-opus-5-5', effort: 'medium', fallbacks: 'default' });
  const input = parseSelectRequest(request(2, 1), LIMITS);
  const ctrl = new AbortController();
  const out = await judge(input, { signal: ctrl.signal });

  const { params, opts } = client.calls[0];
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.output_config.effort, 'medium');
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(params.fallbacks, 'default');
  assert.equal(params.thinking, undefined);
  const content = params.messages[0].content;
  assert.equal(content.filter((b) => b.type === 'image').length, 3);
  assert.equal(content[0].source.media_type, 'image/jpeg');
  assert.equal(content.at(-1).type, 'text');
  assert.equal(opts.signal, ctrl.signal);

  assert.deepEqual(out.results.map((r) => r.id), ['p1', 'p2']);
  assert.equal(out.results[1].person, false);
  assert.equal(out.usage.input_tokens, 1234);
  assert.equal(out.usage.output_tokens, 210);
});

test('fallbacks can be turned off for models without them', async () => {
  const client = fakeClient(message([photo(1)]));
  await createJudge({ client, model: 'm', effort: 'low', fallbacks: null })(parseSelectRequest(request(1, 0), LIMITS));
  assert.equal(client.calls[0].params.betas, undefined);
  assert.equal(client.calls[0].params.fallbacks, undefined);
});

test('refusals, truncation and unreadable output become clear errors', async () => {
  const input = parseSelectRequest(request(1, 0), LIMITS);
  const run = (reply) => createJudge({ client: fakeClient(reply), model: 'm', effort: 'low', fallbacks: null })(input);
  await assert.rejects(run(message([], { stop_reason: 'refusal' })), (e) => e instanceof HttpError && e.code === 'refused');
  await assert.rejects(run(message([], { stop_reason: 'max_tokens' })), (e) => e.code === 'truncated');
  await assert.rejects(run({ ...message([]), content: [{ type: 'text', text: 'not json' }] }), (e) => e.code === 'bad_model_output');
});
