// Local prototype HTTP server (no framework): serves the app/ folder and the judging API.
//   GET  /api/health   what the frontend needs to know to use the backend
//   POST /api/select   judge one small batch of resized JPEGs
// Logs carry request ids, counts, sizes, timings and token usage, never image data.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError, parseSelectRequest } from './validate.js';
import { mapUpstreamError } from './judge.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export const consoleLogger = { info: (o) => console.log(JSON.stringify(o)), error: (o) => console.error(JSON.stringify(o)) };

// Fixed-window counter per client address. In memory, so per process only (see README).
function rateLimiter(perMinute) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    const w = hits.get(key);
    if (!w || now - w.start >= 60000) { hits.set(key, { start: now, n: 1 }); return true; }
    if (hits.size > 10000) hits.clear();
    w.n++;
    return w.n <= perMinute;
  };
}

function sendJson(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

// Reads at most maxBytes; anything bigger is rejected without buffering the rest.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > maxBytes) { reject(new HttpError(413, 'body_too_large', `Request body is larger than ${maxBytes} bytes`)); return; }
    const chunks = [];
    let size = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) { done = true; reject(new HttpError(413, 'body_too_large', `Request body is larger than ${maxBytes} bytes`)); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

export function createServer({ config, judge, logger = consoleLogger }) {
  const allow = rateLimiter(config.rateLimitPerMinute);
  let active = 0;

  async function serveStatic(req, res, urlPath) {
    if (!config.staticDir) return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    let rel;
    try { rel = decodeURIComponent(urlPath); } catch { return sendJson(res, 400, { error: { code: 'bad_path', message: 'Bad path' } }); }
    if (rel.includes('\0')) return sendJson(res, 400, { error: { code: 'bad_path', message: 'Bad path' } });
    if (rel.endsWith('/')) rel += 'index.html';
    const root = path.resolve(config.staticDir);
    const file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (file !== root && !file.startsWith(root + path.sep)) return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    // no dotfiles (.env, .git) even if someone points STATIC_DIR at the wrong folder
    if (path.relative(root, file).split(path.sep).some((p) => p.startsWith('.'))) return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    try {
      const realRoot = await fs.realpath(root);
      const real = await fs.realpath(file);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('outside root');
      const data = await fs.readFile(real);
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    }
  }

  async function select(req, res, rid) {
    const origin = req.headers.origin;
    // Browsers always send Origin on cross-site POSTs; refusing unknown ones stops other sites
    // from spending this server's Anthropic credits through a visitor's browser.
    if (origin && !config.allowedOrigins.has(origin)) throw new HttpError(403, 'origin_not_allowed', 'This origin may not use the API');
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'unsupported_media_type', 'Send application/json');
    const ip = req.socket.remoteAddress || 'unknown';
    if (!allow(ip)) throw new HttpError(429, 'rate_limited', 'Too many requests. Wait a minute and try again.');
    if (active >= config.maxConcurrent) throw new HttpError(503, 'busy', 'The server is busy. Try again shortly.');

    const raw = await readBody(req, config.limits.maxBodyBytes);
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'invalid_json', 'Body is not valid JSON'); }
    const input = parseSelectRequest(body, config.limits);

    active++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.requestTimeoutMs);
    const onClose = () => { if (!res.writableEnded) ctrl.abort(); };
    res.on('close', onClose);
    const t0 = Date.now();
    try {
      const out = await judge(input, { signal: ctrl.signal });
      logger.info({
        rid, event: 'judged', references: input.references.length, candidates: input.candidates.length,
        imageBytes: [...input.references, ...input.candidates].reduce((s, x) => s + x.bytes, 0),
        judged: out.results.length, missing: out.missing.length, model: out.model, usage: out.usage, ms: Date.now() - t0,
      });
      sendJson(res, 200, { requestId: rid, ...out });
    } finally {
      active--;
      clearTimeout(timer);
      res.off('close', onClose);
    }
  }

  return http.createServer(async (req, res) => {
    const rid = crypto.randomUUID();
    const t0 = Date.now();
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { error: { code: 'bad_url', message: 'Bad URL' } }); }
    try {
      if (url.pathname === '/api/health') {
        if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Use GET');
        const { maxReferences, maxCandidates, maxImageBytes, maxImageSide } = config.limits;
        return sendJson(res, 200, { ok: true, judge: true, limits: { maxReferences, maxCandidates, maxImageBytes, maxImageSide } });
      }
      if (url.pathname === '/api/select') {
        if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST');
        return await select(req, res, rid);
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'not_found', 'Not found');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      return await serveStatic(req, res, url.pathname);
    } catch (e) {
      const err = mapUpstreamError(e);
      if (err.status >= 500) logger.error({ rid, event: 'error', path: url.pathname, code: err.code, cause: e?.constructor?.name, status: e?.status, ms: Date.now() - t0 });
      else logger.info({ rid, event: 'rejected', path: url.pathname, code: err.code, status: err.status });
      if (!res.headersSent && !res.writableEnded) sendJson(res, err.status, { requestId: rid, error: { code: err.code, message: err.message } });
    }
  });
}
