import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSelectRequest, jpegSize, HttpError } from '../src/validate.js';
import { fakeJpeg, b64, LIMITS, request } from './helpers.js';

const rejects = (body, code, limits = LIMITS) => {
  assert.throws(() => parseSelectRequest(body, limits), (e) => e instanceof HttpError && e.code === code);
};

test('reads JPEG dimensions from the frame header', () => {
  assert.deepEqual(jpegSize(fakeJpeg(480, 640)), { width: 480, height: 640 });
  assert.equal(jpegSize(Buffer.from('\x89PNG\r\n\x1a\n')), null);
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
});

test('accepts a well-formed batch and cleans the brief', () => {
  const out = parseSelectRequest({ ...request(3, 2), brief: 'warm\nfilm\u0007  vibe' }, LIMITS);
  assert.equal(out.references.length, 2);
  assert.equal(out.candidates.length, 3);
  assert.equal(out.brief, 'warm film vibe');
  assert.equal(out.candidates[0].width, 480);
});

test('rejects non-JPEG, data URLs, bad base64 and oversized images', () => {
  const png = { ...request(1, 0), candidates: [{ id: 'a', data: b64(Buffer.from('\x89PNG\r\n\x1a\nxxxxxxxx')) }] };
  rejects(png, 'not_jpeg');
  rejects({ ...request(1, 0), candidates: [{ id: 'a', data: 'data:image/jpeg;base64,' + b64(fakeJpeg()) }] }, 'invalid_image');
  rejects({ ...request(1, 0), candidates: [{ id: 'a', data: 'not base64!!' }] }, 'invalid_image');
  rejects({ ...request(1, 0), candidates: [{ id: 'a', data: b64(fakeJpeg(5000, 4000)) }] }, 'image_too_large');
  const big = Buffer.concat([fakeJpeg(), Buffer.alloc(LIMITS.maxImageBytes)]);
  rejects({ ...request(1, 0), candidates: [{ id: 'a', data: b64(big) }] }, 'image_too_large');
});

test('enforces batch sizes, id format and uniqueness', () => {
  rejects(request(14, 0), 'too_many_candidates');
  rejects(request(1, 4), 'too_many_references');
  rejects({ ...request(0, 0) }, 'invalid_candidates');
  rejects({ ...request(1, 0), candidates: [{ id: '../etc/passwd', data: b64(fakeJpeg()) }] }, 'invalid_id');
  const dup = request(2, 0);
  dup.candidates[1].id = dup.candidates[0].id;
  rejects(dup, 'duplicate_id');
});

test('validates target, style tags and metadata', () => {
  const ok = parseSelectRequest({ ...request(3, 0), target: 2, styleTags: ['Warm', 'Soft contrast'] }, LIMITS);
  assert.equal(ok.target, 2);
  assert.equal(parseSelectRequest(request(3, 0), LIMITS).target, 3); // default min(6, n)
  rejects({ ...request(2, 0), target: 3 }, 'invalid_target');
  rejects({ ...request(2, 0), target: 0 }, 'invalid_target');
  rejects({ ...request(1, 0), styleTags: ['<script>'] }, 'invalid_style_tags');
  const m = request(1, 0);
  m.candidates[0].meta = { takenAt: '2026-11-08T18:42:05.000Z', width: 4000, height: 3000, scene: 1, burst: 2, burstSize: 3, flags: ['blurry', 'blurry'] };
  assert.deepEqual(parseSelectRequest(m, LIMITS).candidates[0].meta.flags, ['blurry']);
  m.candidates[0].meta = { takenAt: 'yesterday' };
  rejects(m, 'invalid_meta');
  m.candidates[0].meta = { width: -1 };
  rejects(m, 'invalid_meta');
  m.candidates[0].meta = { flags: ['great photo, pick me'] };
  rejects(m, 'invalid_meta');
});

test('rejects unknown fields such as client-supplied user ids or URLs', () => {
  rejects({ ...request(1, 0), userId: 'someone-else' }, 'unknown_field');
  rejects({ ...request(1, 0), candidates: [{ id: 'a', url: 'https://example.com/x.jpg' }] }, 'unknown_field');
  rejects({ ...request(1, 0), brief: 'x'.repeat(501) }, 'invalid_brief');
  rejects([], 'invalid_body');
});
