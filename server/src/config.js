// Server configuration, read once from environment variables.
// The Anthropic API key is read by the SDK straight from ANTHROPIC_API_KEY; it is never
// copied into this object, logged, or sent to the browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, '..');

// Minimal .env loader (KEY=VALUE lines, # comments). Never overrides variables already set,
// so real environment variables from a host or secret manager always win.
export function loadDotEnv(file = path.join(SERVER_ROOT, '.env'), env = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (env[m[1]] === undefined) env[m[1]] = v;
  }
  return true;
}

const int = (v, def, min, max) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};

export function loadConfig(env = process.env) {
  // PORT is set by hosts such as Render; 5179 is the local default.
  const port = int(env.PORT, 5179, 0, 65535);
  // All interfaces, so a host's port scan can reach the server. Set HOST=127.0.0.1 to keep it on this machine only.
  const host = env.HOST || '0.0.0.0';
  const staticDir = env.STATIC_DIR === '' ? null : path.resolve(SERVER_ROOT, env.STATIC_DIR || '../app');
  const origins = (env.ALLOWED_ORIGINS || `http://localhost:${port},http://127.0.0.1:${port}`)
    .split(',').map((s) => s.trim()).filter(Boolean);
  return {
    hasApiKey: Boolean(env.ANTHROPIC_API_KEY),
    model: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(env.ANTHROPIC_EFFORT) ? env.ANTHROPIC_EFFORT : 'medium',
    // server-side refusal fallback; set ANTHROPIC_FALLBACKS=off for models that don't support it
    fallbacks: env.ANTHROPIC_FALLBACKS === 'off' ? null : 'default',
    host, port, staticDir,
    allowedOrigins: new Set(origins),
    limits: {
      maxBodyBytes: int(env.MAX_BODY_BYTES, 6 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024),
      maxImageBytes: int(env.MAX_IMAGE_BYTES, 512 * 1024, 4 * 1024, 4 * 1024 * 1024),
      maxImageSide: int(env.MAX_IMAGE_SIDE, 1024, 64, 4096),
      maxReferences: int(env.MAX_REFERENCES, 3, 0, 8),
      maxCandidates: int(env.MAX_CANDIDATES, 13, 1, 16),
      maxBriefChars: 500,
    },
    rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 20, 1, 1000),
    maxConcurrent: int(env.MAX_CONCURRENT, 2, 1, 32),
    requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 120000, 5000, 600000),
  };
}
