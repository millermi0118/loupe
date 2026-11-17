// Face reshape: slim face, V-line jaw, chin, eyes, nose and lips, as smooth local warps
// anchored to the 68 face landmarks. Also measures face proportions (feature sizes relative
// to the face) so new photos can be nudged toward the proportions in the creator's past edits.
//
// Landmark index map (68-point): 0-16 jaw (0 = left ear, 8 = chin), 27-30 nose bridge,
// 31-35 nostrils, 36-41 left eye, 42-47 right eye, 48-59 outer lips, 60-67 inner lips.

export const SHAPE_KEYS = ['slim', 'jaw', 'chin', 'eyes', 'nose', 'lips'];
// Mouth width mostly follows expression (a smile widens it), so lips are manual only.
const AUTO_KEYS = ['slim', 'jaw', 'chin', 'eyes', 'nose'];
// which proportion each slider moves
const MEASURE_OF = { slim: 'width', jaw: 'jaw', chin: 'chin', eyes: 'eye', nose: 'nose', lips: 'lips' };

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

export const toPx = (pts, W, H) => pts.map((p) => [p[0] * W, p[1] * H]);

/* ---------------- proportions ---------------- */

// Rotation and scale free. Internal values are normalized by the distance between the
// eye centers, which none of the reshape tools move, so they compare across photos.
export function measureShape(P) {
  if (!P || P.length < 68) return null;
  const eL = mid(P.slice(36, 42)), eR = mid(P.slice(42, 48));
  const iod = dist(eL, eR);
  if (iod < 1e-6) return null;
  const cheek = (dist(P[2], P[14]) + dist(P[3], P[13])) / 2;
  const faceW = dist(P[0], P[16]);
  const faceH = dist(P[27], P[8]);
  return {
    width: cheek / iod,                                       // face width at the cheeks
    jaw: dist(P[5], P[11]) / cheek,                           // lower jaw vs cheeks (lower = V-line)
    chin: dist(P[33], P[8]) / iod,                            // nose base to chin (lower face length)
    eye: (dist(P[36], P[39]) + dist(P[42], P[45])) / 2 / iod, // eye width
    nose: dist(P[31], P[35]) / iod,                           // nostril width
    lips: dist(P[48], P[54]) / iod,                           // mouth width
    yaw: (P[30][0] - (eL[0] + eR[0]) / 2) / iod,             // head turn, 0 = facing camera
    // human-readable versions, relative to the face
    show: {
      eye: (dist(P[36], P[39]) + dist(P[42], P[45])) / 2 / faceW,
      nose: dist(P[31], P[35]) / faceW,
      lips: dist(P[48], P[54]) / faceW,
      width: cheek / faceH,
      jaw: dist(P[5], P[11]) / cheek,
      chin: dist(P[33], P[8]) / faceH,
    },
  };
}

// Typical (median) proportions across the creator's past edits; median ignores a stray bad detection.
export function shapeProfile(shapes) {
  const list = shapes.filter((s) => s && Math.abs(s.yaw ?? 0) < 0.3);
  if (!list.length) return null;
  const med = (get) => { const v = list.map(get).sort((a, b) => a - b), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const out = { n: list.length, show: {} };
  for (const k of ['width', 'jaw', 'chin', 'eye', 'nose', 'lips']) {
    out[k] = med((s) => s[k]);
    out.show[k] = med((s) => s.show[k]);
  }
  return out;
}

/* ---------------- warp field ---------------- */

// Each tool is a group of ops. Translations inside one group are blended (so neighboring jaw
// points don't stack), groups add up. amounts are -1..1, positive = slimmer, sharper, longer, bigger.
export function buildOps(P, amt) {
  const faceW = dist(P[0], P[16]), faceH = dist(P[27], P[8]);
  const top = P[27], chin = P[8];
  const axis = [chin[0] - top[0], chin[1] - top[1]], axLen = Math.hypot(axis[0], axis[1]) || 1;
  const ax = [axis[0] / axLen, axis[1] / axLen];
  // unit vector from a point toward the face's center line
  const inward = (p) => {
    const t = (p[0] - top[0]) * ax[0] + (p[1] - top[1]) * ax[1];
    const f = [top[0] + ax[0] * t, top[1] + ax[1] * t];
    const v = [f[0] - p[0], f[1] - p[1]], l = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / l, v[1] / l];
  };
  const groups = [];
  const push = (key, idx, weights, vec, R) => {
    const a = amt[key] || 0;
    if (Math.abs(a) < 0.005) return;
    groups.push({ type: 'move', R, ops: idx.map((i, j) => { const v = vec(P[i]); return { c: P[i], v: [v[0] * a * weights[j], v[1] * a * weights[j]] }; }) });
  };
  // slim: pull the cheeks and jaw sides toward the center line
  const slimIdx = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];
  const slimW = [0.35, 0.65, 0.9, 1, 0.9, 0.6, 0.3, 0.3, 0.6, 0.9, 1, 0.9, 0.65, 0.35];
  push('slim', slimIdx, slimW, (p) => inward(p).map((v) => v * 0.05 * faceW), 0.3 * faceW);
  // V-line: narrow the lower jaw toward the chin, lifting it slightly
  const jawIdx = [3, 4, 5, 6, 7, 9, 10, 11, 12, 13];
  const jawW = [0.25, 0.6, 0.95, 1, 0.65, 0.65, 1, 0.95, 0.6, 0.25];
  push('jaw', jawIdx, jawW, (p) => { const v = inward(p); return [v[0] * 0.055 * faceW - ax[0] * 0.012 * faceH, v[1] * 0.055 * faceW - ax[1] * 0.012 * faceH]; }, 0.24 * faceW);
  // chin: move the chin along the face axis
  push('chin', [6, 7, 8, 9, 10], [0.35, 0.8, 1, 0.8, 0.35], () => [ax[0] * 0.07 * faceH, ax[1] * 0.07 * faceH], 0.26 * faceW);
  // eyes, nose, lips: local magnify / shrink around each feature
  const scale = (key, c, R, k) => { const a = amt[key] || 0; if (Math.abs(a) >= 0.005) groups.push({ type: 'scale', c, R, k: k * a }); };
  const eL = mid(P.slice(36, 42)), eR = mid(P.slice(42, 48));
  const ew = (dist(P[36], P[39]) + dist(P[42], P[45])) / 2;
  scale('eyes', eL, ew * 1.5, 0.28);
  scale('eyes', eR, ew * 1.5, 0.28);
  const nc = mid([P[30], P[31], P[33], P[35]]);
  scale('nose', nc, dist(P[31], P[35]) * 1.35, 0.3);
  const mc = mid(P.slice(48, 60));
  scale('lips', mc, dist(P[48], P[54]) * 0.95, 0.22);
  return groups;
}

// Destination pixel -> where to sample it from in the original.
function backward(x, y, groups) {
  let dx = 0, dy = 0;
  for (const g of groups) {
    if (g.type === 'move') {
      const R2 = g.R * g.R;
      let sx = 0, sy = 0, sw = 0;
      for (const o of g.ops) {
        const d2 = (x - o.c[0]) ** 2 + (y - o.c[1]) ** 2;
        if (d2 >= R2) continue;
        const f = (1 - d2 / R2) ** 2;
        sx += f * o.v[0]; sy += f * o.v[1]; sw += f;
      }
      if (sw > 0) { const n = Math.max(1, sw); dx -= sx / n; dy -= sy / n; }
    } else {
      const ox = x - g.c[0], oy = y - g.c[1], d2 = ox * ox + oy * oy, R2 = g.R * g.R;
      if (d2 >= R2) continue;
      const f = g.k * (1 - d2 / R2) ** 2;
      dx -= ox * f; dy -= oy * f;
    }
  }
  return [x + dx, y + dy];
}

// Where an original point lands after the warp (inverts backward() by fixed-point iteration).
export function forwardPts(P, groups) {
  if (!groups.length) return P;
  return P.map((p) => {
    let q = [p[0], p[1]];
    for (let i = 0; i < 8; i++) { const b = backward(q[0], q[1], groups); q = [q[0] + p[0] - b[0], q[1] + p[1] - b[1]]; }
    return q;
  });
}

/* ---------------- matching ---------------- */

// Slider values (lips excluded) that move this face's proportions to the target's, one tool at a time
// (in an order where later tools barely affect earlier measurements). Capped at ±limit.
export function solveShape(P, target, limit = 0.85) {
  const out = Object.fromEntries(SHAPE_KEYS.map((k) => [k, 0]));
  const base = measureShape(P);
  if (!base || !target || Math.abs(base.yaw) > 0.3) return out; // turned heads distort proportions
  for (const key of AUTO_KEYS) {
    const m = MEASURE_OF[key], goal = target[m];
    const f = (a) => measureShape(forwardPts(P, buildOps(P, { ...out, [key]: a })))[m];
    let lo = -limit, hi = limit, flo = f(lo), fhi = f(hi);
    const up = fhi > flo;
    if (up ? goal <= flo : goal >= flo) { out[key] = lo; continue; }
    if (up ? goal >= fhi : goal <= fhi) { out[key] = hi; continue; }
    for (let i = 0; i < 14; i++) {
      const a = (lo + hi) / 2, v = f(a);
      if ((v < goal) === up) lo = a; else hi = a;
    }
    out[key] = (lo + hi) / 2;
  }
  return out;
}

/* ---------------- apply ---------------- */

export function warpImage(img, P, amt) {
  const groups = buildOps(P, amt);
  if (!groups.length) return;
  const { width: W, height: H, data: d } = img;
  // only the area the tools can reach
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  const grow = (c, r) => { x0 = Math.min(x0, c[0] - r); y0 = Math.min(y0, c[1] - r); x1 = Math.max(x1, c[0] + r); y1 = Math.max(y1, c[1] + r); };
  for (const g of groups) { if (g.type === 'move') g.ops.forEach((o) => grow(o.c, g.R + Math.hypot(o.v[0], o.v[1]))); else grow(g.c, g.R); }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(W - 1, Math.ceil(x1)); y1 = Math.min(H - 1, Math.ceil(y1));
  if (x1 <= x0 || y1 <= y0) return;
  const src = d.slice(); // sample from the untouched original
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const [sx, sy] = backward(x + 0.5, y + 0.5, groups);
    const fx = Math.max(0, Math.min(W - 1.001, sx - 0.5)), fy = Math.max(0, Math.min(H - 1.001, sy - 0.5));
    if (Math.abs(fx - x) < 0.01 && Math.abs(fy - y) < 0.01) continue;
    const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
    const p00 = (iy * W + ix) * 4, p10 = p00 + 4, p01 = p00 + W * 4, p11 = p01 + 4;
    const o = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) {
      d[o + c] = (src[p00 + c] * (1 - tx) + src[p10 + c] * tx) * (1 - ty) + (src[p01 + c] * (1 - tx) + src[p11 + c] * tx) * ty;
    }
  }
}
