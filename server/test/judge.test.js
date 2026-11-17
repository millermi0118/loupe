import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelector } from '../src/judge.js';
import { selectPrompt, normalizeSelection } from '../src/prompt.js';
import { parseSelectRequest, HttpError } from '../src/validate.js';
import { estimateCostUsd, dailyBudget } from '../src/pricing.js';
import { LIMITS, request, fakeClient, message } from './helpers.js';

const photo = (n, extra = {}) => ({ photo: n, person: true, eyes_open: 0.9, expression: 0.7, angle: 0.8, taste: 0.6, faces: [[0.3, 0.2, 0.5, 0.5]], note: 'sharp, eyes open', ...extra });
const logger = () => { const lines = []; return { lines, info: (o) => lines.push(o), error: (o) => lines.push(o) }; };

test('prompt keeps the judging rules and asks Claude to choose from the images', () => {
  const p = selectPrompt({ nRefs: 2, n: 5, target: 3, brief: "warm 'film' vibe", styleTags: ['Warm', 'Soft contrast'],
    metas: [{ takenAt: '2026-11-08T18:42:05.000Z', width: 4000, height: 3000, scene: 0, burst: 3, burstSize: 4, flags: ['blurry'] }] });
  assert.match(p, /Images 1 to 2 are photos this creator already edited and posted/);
  assert.match(p, /Images 3 to 7 are candidates from a new shoot. Call them photo 1 to 5/);
  assert.match(p, /Choose the 3 best photos to post/);
  assert.match(p, /trust the image when they disagree/);
  assert.match(p, /Be strict: blinks, half-closed eyes/);
  assert.match(p, /photo 1: taken 18:42:05; 4000x3000; scene A; burst #3 \(4 near-identical frames\); local checks: looks blurry/);
  assert.match(p, /usual editing style: Warm, Soft contrast/);
});

test('normalizeSelection maps numbers to ids, clamps, dedupes and fills a short selection', () => {
  const ids = ['p1', 'p2', 'p3', 'p4'];
  const out = normalizeSelection({
    photos: [photo(2, { taste: 1.7, eyes_open: -3, faces: [[0.1, 0.1, 0.05, 0.3], [0.2, 0.2, 0.4, 0.4]], note: 'x'.repeat(200) }), photo(2), photo(9), photo(4, { taste: 0.9 })],
    ranking: [2, 2, 7, 3],
    selected: [{ photo: 2, reason: 'Genuine smile, eyes open' }, { photo: 2, reason: 'dup' }, { photo: 99, reason: 'bad' }],
  }, ids, 3);
  assert.deepEqual(out.results.map((r) => r.id), ['p2', 'p4']);
  assert.equal(out.results[0].taste, 1);
  assert.equal(out.results[0].eyes_open, 0);
  assert.deepEqual(out.results[0].faces, [[0.2, 0.2, 0.4, 0.4]]);
  assert.equal(out.results[0].note.length, 70);
  assert.deepEqual(out.ranking, ['p2', 'p3', 'p4', 'p1']); // unranked appended by taste
  assert.deepEqual(out.selected.map((s) => [s.id, s.rank, s.byClaude]), [['p2', 1, true], ['p3', 2, false], ['p4', 3, false]]);
  assert.equal(out.filledFromRanking, true);
  assert.deepEqual(out.missing, ['p1', 'p3']);
});

test('selector sends every image with metadata in one structured-output request and logs cost', async () => {
  const client = fakeClient(message([photo(1), photo(2, { person: false, faces: [] })], { ranking: [2, 1], selected: [{ photo: 2, reason: 'Best light' }] }));
  const log = logger();
  const budget = dailyBudget(5);
  const select = createSelector({ client, model: 'claude-opus-5-5', effort: 'medium', fallbacks: 'default', logger: log, budget });
  const input = parseSelectRequest({ ...request(2, 1), target: 1 }, LIMITS);
  const ctrl = new AbortController();
  const out = await select(input, { signal: ctrl.signal, rid: 'r1' });

  const { params, opts } = client.calls[0];
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.output_config.effort, 'medium');
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(params.fallbacks, 'default');
  const content = params.messages[0].content;
  assert.equal(content.filter((b) => b.type === 'image').length, 3);
  assert.equal(content[0].source.media_type, 'image/jpeg');
  assert.match(content.at(-1).text, /Choose the 1 best photos/);
  assert.equal(opts.signal, ctrl.signal);

  assert.deepEqual(out.selected.map((s) => s.id), ['p2']);
  assert.equal(out.selected[0].reason, 'Best light');
  assert.deepEqual(out.ranking, ['p2', 'p1']);
  assert.equal(out.usage.input_tokens, 1234);
  assert.equal(out.costUsd, estimateCostUsd('claude-opus-5-5', out.usage));
  assert.ok(out.costUsd > 0);

  const line = log.lines.find((l) => l.event === 'claude_request');
  assert.equal(line.status, 'success');
  assert.equal(line.rid, 'r1');
  assert.equal(line.photos, 3);
  assert.equal(line.model, 'claude-opus-5-5');
  assert.equal(line.inputTokens, 1234);
  assert.equal(line.outputTokens, 210);
  assert.equal(typeof line.ms, 'number');
  assert.ok(budget.spent() > 0);
  assert.equal(JSON.stringify(log.lines).includes(input.candidates[0].data), false);
});

test('fallbacks can be turned off for models without them', async () => {
  const client = fakeClient(message([photo(1)], { ranking: [1], selected: [{ photo: 1, reason: 'ok' }] }));
  await createSelector({ client, model: 'm', effort: 'low', fallbacks: null })(parseSelectRequest({ ...request(1, 0), target: 1 }, LIMITS));
  assert.equal(client.calls[0].params.betas, undefined);
  assert.equal(client.calls[0].params.fallbacks, undefined);
});

test('refusals, truncation, unreadable output and API errors are logged as failures', async () => {
  const input = parseSelectRequest({ ...request(1, 0), target: 1 }, LIMITS);
  const log = logger();
  const run = (reply) => createSelector({ client: fakeClient(reply), model: 'claude-opus-5-5', effort: 'low', fallbacks: null, logger: log })(input, { rid: 'x' });
  await assert.rejects(run(message([], { stop_reason: 'refusal' })), (e) => e instanceof HttpError && e.code === 'refused');
  await assert.rejects(run(message([], { stop_reason: 'max_tokens' })), (e) => e.code === 'truncated');
  await assert.rejects(run({ ...message([]), content: [{ type: 'text', text: 'not json' }] }), (e) => e.code === 'bad_model_output');
  await assert.rejects(run(() => { throw new Error('network down'); }), /network down/);
  const fails = log.lines.filter((l) => l.event === 'claude_request' && l.status === 'failure');
  assert.equal(fails.length, 4);
  assert.deepEqual(fails.map((l) => l.error).slice(0, 3), ['refused', 'truncated', 'bad_model_output']);
  assert.equal(fails[0].inputTokens, 1234); // billed even though refused
});

test('cost estimate and daily budget', () => {
  assert.equal(estimateCostUsd('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 }), 6);
  assert.equal(estimateCostUsd('unknown-model', { input_tokens: 5 }), null);
  let now = Date.parse('2026-11-17T10:00:00Z');
  const b = dailyBudget(1, () => now);
  b.add(0.6); assert.equal(b.exhausted(), false);
  b.add(0.5); assert.equal(b.exhausted(), true);
  now += 24 * 3600 * 1000; assert.equal(b.exhausted(), false);
  assert.equal(dailyBudget(0).exhausted(), false);
});
