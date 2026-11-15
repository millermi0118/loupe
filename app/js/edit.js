// Auto-edit: "Match my look" retouches faces only, toward the skin brightness, color and
// smoothness of the creator's past edits. The rest of the photo keeps its tone unless the
// manual sliders change it (baked into a 3D LUT).
import { rgbToLab, rgbToLabF, labToRgb, isSkin, expandBox } from './analyze.js';

export const ADJUST = [
  { key: 'match', label: 'Match my look (faces)', min: 0, max: 1, step: 0.01, def: 0.8 },
  { key: 'skin', label: 'Extra smoothing', min: 0, max: 1, step: 0.01, def: 0 },
  { key: 'exposure', label: 'Exposure', min: -1, max: 1, step: 0.01, def: 0 },
  { key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01, def: 0 },
  { key: 'warmth', label: 'Warmth', min: -1, max: 1, step: 0.01, def: 0 },
  { key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01, def: 0 },
  { key: 'sat', label: 'Saturation', min: -1, max: 1, step: 0.01, def: 0 },
  { key: 'fade', label: 'Fade', min: 0, max: 1, step: 0.01, def: 0 },
  { key: 'grain', label: 'Grain', min: 0, max: 1, step: 0.01, def: 0 },
];

export function defaultAdjust() {
  const a = { mono: 0 };
  ADJUST.forEach((d) => (a[d.key] = d.def));
  return a;
}

const GLOBAL_KEYS = ['exposure', 'contrast', 'warmth', 'tint', 'sat', 'fade', 'mono'];

export function makeTransform(adj) {
  return (L, a, b) => {
    L += adj.exposure * 16 * (1 - Math.abs(L - 50) / 75);
    L = 50 + (L - 50) * (1 + 0.45 * adj.contrast);
    if (adj.fade) L = L * (1 - 0.16 * adj.fade) + 15 * adj.fade * (1 - L / 140);
    const s = 1 + adj.sat;
    a *= s; b *= s;
    b += 12 * adj.warmth; a += 3 * adj.warmth;
    a += 10 * adj.tint;
    if (adj.mono) { a = 0; b = 0; }
    return [Math.max(0, Math.min(100, L)), a, b];
  };
}

export function buildLUT(fn, N = 33) {
  const lut = new Float32Array(N * N * N * 3);
  let p = 0;
  for (let bi = 0; bi < N; bi++) for (let gi = 0; gi < N; gi++) for (let ri = 0; ri < N; ri++) {
    const r = (ri / (N - 1)) * 255, g = (gi / (N - 1)) * 255, b = (bi / (N - 1)) * 255;
    const [L, A, B] = rgbToLabF(r, g, b);
    const [L2, A2, B2] = fn(L, A, B);
    const o = labToRgb(L2, A2, B2);
    lut[p++] = o[0]; lut[p++] = o[1]; lut[p++] = o[2];
  }
  return { lut, N };
}

export function applyLUT(img, { lut, N }) {
  const d = img.data, s = (N - 1) / 255, N2 = N * N;
  for (let p = 0; p < d.length; p += 4) {
    const fr = d[p] * s, fg = d[p + 1] * s, fb = d[p + 2] * s;
    const r0 = fr | 0, g0 = fg | 0, b0 = fb | 0;
    const r1 = Math.min(N - 1, r0 + 1), g1 = Math.min(N - 1, g0 + 1), b1 = Math.min(N - 1, b0 + 1);
    const dr = fr - r0, dg = fg - g0, db = fb - b0;
    for (let c = 0; c < 3; c++) {
      const v = (ri, gi, bi) => lut[(bi * N2 + gi * N + ri) * 3 + c];
      const c00 = v(r0, g0, b0) * (1 - dr) + v(r1, g0, b0) * dr;
      const c10 = v(r0, g1, b0) * (1 - dr) + v(r1, g1, b0) * dr;
      const c01 = v(r0, g0, b1) * (1 - dr) + v(r1, g0, b1) * dr;
      const c11 = v(r0, g1, b1) * (1 - dr) + v(r1, g1, b1) * dr;
      d[p + c] = (c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db;
    }
  }
}

function boxBlur(src, w, h, r, channels) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const pass = (inp, outp, horizontal) => {
    const len = horizontal ? w : h, lines = horizontal ? h : w;
    for (let l = 0; l < lines; l++) for (let c = 0; c < channels; c++) {
      let acc = 0;
      const idx = (i) => ((horizontal ? l * w + i : i * w + l) * channels + c);
      for (let i = -r; i <= r; i++) acc += inp[idx(Math.max(0, Math.min(len - 1, i)))];
      for (let i = 0; i < len; i++) {
        outp[idx(i)] = acc / (2 * r + 1);
        acc += inp[idx(Math.min(len - 1, i + r + 1))] - inp[idx(Math.max(0, i - r))];
      }
    }
  };
  pass(src, tmp, true);
  pass(tmp, out, false);
  return out;
}

// How far to move this face toward the creator's retouched faces.
export function facePlan(ref, photo, adj) {
  if (!photo) return null;
  const m = ref ? adj.match : 0;
  const auto = ref ? Math.max(0, Math.min(0.85, (photo.tex - ref.tex) / Math.max(photo.tex, 0.01))) : 0;
  const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));
  return {
    smooth: Math.min(1, auto * m + adj.skin),
    dL: ref ? clamp(ref.L - photo.L, 12) * m : 0,
    da: ref ? clamp(ref.a - photo.a, 8) * m : 0,
    db: ref ? clamp(ref.b - photo.b, 8) * m : 0,
  };
}

export function faceRetouch(img, boxes, plan) {
  if (!plan || !boxes?.length) return;
  if (plan.smooth < 0.01 && Math.abs(plan.dL) + Math.abs(plan.da) + Math.abs(plan.db) < 0.3) return;
  const { width: W, height: H, data: d } = img;
  for (const box of boxes) {
    const [x0, y0, x1, y1] = expandBox(box, 0.3).map((v, i) => Math.round(v * (i % 2 ? H : W)));
    const rw = x1 - x0, rh = y1 - y0;
    if (rw < 8 || rh < 8) continue;
    const [fx0, fy0, fx1, fy1] = expandBox(box, 0.12);
    const cx = ((fx0 + fx1) / 2) * W, cy = ((fy0 + fy1) / 2) * H, rx = ((fx1 - fx0) / 2) * W, ry = ((fy1 - fy0) / 2) * H;
    const n = rw * rh, rgb = new Float32Array(n * 3), mask = new Float32Array(n);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const i = y * rw + x, p = ((y0 + y) * W + x0 + x) * 4;
      rgb[i * 3] = d[p]; rgb[i * 3 + 1] = d[p + 1]; rgb[i * 3 + 2] = d[p + 2];
      const e = 1 - ((x0 + x - cx) / rx) ** 2 - ((y0 + y - cy) / ry) ** 2;
      mask[i] = e > 0 && isSkin(d[p], d[p + 1], d[p + 2]) ? Math.min(1, e * 3) : 0;
    }
    const m = boxBlur(mask, rw, rh, Math.max(2, Math.round(rw / 30)), 1);
    const r = Math.max(1, Math.round(rx / 22));
    const blur = plan.smooth > 0.01 ? boxBlur(boxBlur(rgb, rw, rh, r, 3), rw, rh, r, 3) : null;
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const i = y * rw + x, k = m[i];
      if (k < 0.02) continue;
      const p = ((y0 + y) * W + x0 + x) * 4;
      let R = d[p], G = d[p + 1], B = d[p + 2];
      if (blur) {
        const dr = blur[i * 3] - R, dg = blur[i * 3 + 1] - G, db = blur[i * 3 + 2] - B;
        const edge = Math.max(0, 1 - (Math.abs(dr) + Math.abs(dg) + Math.abs(db)) / 45); // keeps eyes, brows, lips
        const t = plan.smooth * 0.9 * k * edge;
        R += t * dr; G += t * dg; B += t * db;
      }
      const [L, A, Bb] = rgbToLab(Math.max(0, Math.min(255, R)), Math.max(0, Math.min(255, G)), Math.max(0, Math.min(255, B)));
      const o = labToRgb(L + plan.dL * k, A + plan.da * k, Bb + plan.db * k);
      d[p] = o[0]; d[p + 1] = o[1]; d[p + 2] = o[2];
    }
  }
}

export function addGrain(img, amount) {
  if (amount <= 0) return;
  const d = img.data;
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const a = amount * 22;
  for (let p = 0; p < d.length; p += 4) {
    const lum = (d[p] + d[p + 1] + d[p + 2]) / 765;
    const g = (rnd() + rnd() - 1) * a * (1 - Math.abs(lum - 0.5));
    d[p] += g; d[p + 1] += g; d[p + 2] += g;
  }
}

// face = { boxes, plan } from the app; boxes are normalized, so any resolution works.
export function renderEdit(srcCanvas, adj, face) {
  const c = document.createElement('canvas');
  c.width = srcCanvas.width; c.height = srcCanvas.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(srcCanvas, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  faceRetouch(img, face?.boxes, face?.plan);
  if (GLOBAL_KEYS.some((k) => adj[k])) applyLUT(img, buildLUT(makeTransform(adj), 25));
  addGrain(img, adj.grain);
  ctx.putImageData(img, 0, 0);
  return c;
}
