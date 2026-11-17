import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { createJudge } from '../src/judge.js';
import { request, fakeClient, message } from './helpers.js';

const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-static-'));
fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Loupe</title>');
fs.writeFileSync(path.join(staticDir, '.env'), 'SECRET=1');
fs.writeFileSync(path.join(path.dirname(staticDir), 'outside.txt'), 'nope');

async function start({ env = {}, judge } = {}) {
  const config = { ...loadConfig({ PORT: '0', STATIC_DIR: staticDir, MAX_IMAGE_BYTES: '65536', MAX_BODY_BYTES: '200000', ...env }) };
  const logs = [];
  const logger = { info: (o) => logs.push(JSON.stringify(o)), error: (o) => logs.push(JSON.stringify(o)) };
  const client = fakeClient(message([{ photo: 1, person: true, eyes_open: 1, expression: 0.8, angle: 0.9, taste: 0.7, faces: [], note: 'ok' }]));
  const server = createServer({ config, judge: judge || createJudge({ client, model: 'claude-opus-5-5', effort: 'medium', fallbacks: 'default' }), logger });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.allowedOrigins.add(base);
  return { base, logs, client, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

const post = (base, body, headers = {}) => fetch(base + '/api/select', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('health reports limits only', async () => {
  const s = await start();
  try {
    const h = await (await fetch(s.base + '/api/health')).json();
    assert.equal(h.ok, true);
    assert.equal(h.limits.maxCandidates, 13);
    assert.equal(JSON.stringify(h).includes('key'), false);
  } finally { await s.close(); }
});

test('select returns results by id with token usage, and logs no image data', async () => {
  const s = await start();
  try {
    const body = request(1, 1);
    const r = await post(s.base, body, { Origin: s.base });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.results[0].id, 'p1');
    assert.equal(out.usage.input_tokens, 1234);
    assert.ok(out.requestId);
    const logged = s.logs.join('\n');
    assert.ok(logged.includes('"event":"judged"'));
    assert.equal(logged.includes(body.candidates[0].data), false);
    assert.equal(logged.includes(body.references[0].data), false);
  } finally { await s.close(); }
});

test('rejects other origins, wrong content type, bad JSON and oversized bodies', async () => {
  const s = await start();
  try {
    assert.equal((await post(s.base, request(1, 0), { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(s.base, JSON.stringify(request(1, 0)), { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post(s.base, '{nope')).status, 400);
    assert.equal((await post(s.base, { ...request(1, 0), pad: 'x'.repeat(300000) })).status, 413);
    assert.equal((await fetch(s.base + '/api/select')).status, 405);
    assert.equal(s.client.calls.length, 0);
  } finally { await s.close(); }
});

test('rate limits per client', async () => {
  const s = await start({ env: { RATE_LIMIT_PER_MINUTE: '2' } });
  try {
    assert.equal((await post(s.base, request(1, 0))).status, 200);
    assert.equal((await post(s.base, request(1, 0))).status, 200);
    const r = await post(s.base, request(1, 0));
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error.code, 'rate_limited');
  } finally { await s.close(); }
});

test('upstream errors are mapped without leaking details', async () => {
  const judge = async () => { throw new Anthropic.AuthenticationError(401, { error: { message: 'invalid x-api-key sk-ant-secret' } }, 'invalid x-api-key', new Headers()); };
  const s = await start({ judge });
  try {
    const r = await post(s.base, request(1, 0));
    assert.equal(r.status, 500);
    const text = await r.text();
    assert.match(text, /server_misconfigured/);
    assert.equal(text.includes('sk-ant'), false);
  } finally { await s.close(); }
});

test('serves the app but never dotfiles or files outside it', async () => {
  const s = await start();
  try {
    assert.equal((await fetch(s.base + '/')).status, 200);
    assert.equal((await fetch(s.base + '/.env')).status, 404);
    assert.equal((await fetch(s.base + '/%2e%2e/outside.txt')).status, 404);
    assert.equal((await fetch(s.base + '/..%2foutside.txt')).status, 404);
  } finally { await s.close(); }
});
