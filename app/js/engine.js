// Culling engine: style profile, direction parsing, metadata clustering,
// burst detection, scoring, the pairwise taste ranker and diverse selection.
import { cosine } from './analyze.js';
import { shapeProfile } from './shape.js';

/* ---------------- style profile ---------------- */

export function buildProfile(refs) {
  const n = refs.length;
  if (!n) return null;
  const avg = (k) => refs.reduce((s, r) => s + r.feat[k], 0) / n;
  const q = Array.from({ length: 17 }, (_, i) => refs.reduce((s, r) => s + r.feat.q[i], 0) / n);
  const pal = [];
  refs.forEach((r) => r.feat.palette.slice(0, 3).forEach((p) => pal.push(p)));
  pal.sort((a, b) => b[3] - a[3]);
  const portrait = refs.filter((r) => r.feat.aspect < 0.95).length / n;
  return {
    n, q,
    meanL: avg('meanL'), stdL: avg('stdL'),
    meanA: avg('meanA'), stdA: avg('stdA'), meanB: avg('meanB'), stdB: avg('stdB'),
    chroma: avg('chroma'), colorfulness: avg('colorfulness'),
    clutter: avg('clutter'), skinFrac: avg('skinFrac'), comp: avg('comp'),
    centroid: [refs.reduce((s, r) => s + r.feat.centroid[0], 0) / n, refs.reduce((s, r) => s + r.feat.centroid[1], 0) / n],
    portrait, palette: dedupePalette(pal).slice(0, 6),
    embs: refs.slice(0, 60).map((r) => Array.from(r.feat.emb, (v) => +v.toFixed(4))),
    face: faceProfile(refs),
  };
}

// What the creator's retouched faces look like: skin brightness, color and smoothness,
// plus face proportions (feature sizes relative to the face) from the landmarks.
export function faceProfile(refs) {
  const f = refs.map((r) => r.skin).filter(Boolean);
  const shape = shapeProfile(refs.map((r) => r.shape));
  if (!f.length && !shape) return null;
  const avg = (k) => f.reduce((s, x) => s + x[k], 0) / f.length;
  return f.length ? { n: f.length, L: avg('L'), a: avg('a'), b: avg('b'), tex: avg('tex'), shape } : { n: 0, shape };
}

function dedupePalette(pal) {
  const out = [];
  for (const p of pal) if (!out.some((o) => Math.hypot(o[0] - p[0], o[1] - p[1], o[2] - p[2]) < 40)) out.push(p);
  return out;
}

export function profileStrength(n) {
  const v = 1 - Math.exp(-n / 14);
  const tier = n === 0 ? 'Empty' : v < 0.35 ? 'Sketch' : v < 0.7 ? 'Forming' : v < 0.9 ? 'Solid' : 'Locked in';
  return { value: v, tier };
}

export function describeProfile(p) {
  if (!p) return [];
  const out = [];
  out.push(p.meanB > 12 ? 'Warm' : p.meanB < 2 ? 'Cool' : 'Neutral');
  out.push(p.stdL > 26 ? 'Punchy contrast' : p.stdL < 17 ? 'Soft contrast' : 'Medium contrast');
  out.push(p.chroma > 26 ? 'Saturated' : p.chroma < 13 ? 'Muted color' : 'Natural color');
  out.push(p.q[1] > 12 ? 'Lifted blacks' : 'Deep blacks');
  out.push(p.meanL > 60 ? 'High key' : p.meanL < 40 ? 'Low key' : 'Mid key');
  out.push(p.portrait > 0.6 ? 'Shoots vertical' : p.portrait < 0.3 ? 'Shoots horizontal' : 'Mixed framing');
  return out;
}

/* ---------------- direction ---------------- */

const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, dozen: 12 };

const VIBES = [
  { tag: 'moody', re: /mood|dark|night|cinematic|grunge|edgy/, adj: { exposure: -0.25, contrast: 0.2, sat: -0.12 }, pref: { meanL: 38 } },
  { tag: 'bright', re: /bright|airy|light|clean|fresh|summer/, adj: { exposure: 0.25, contrast: -0.08 }, pref: { meanL: 66 } },
  { tag: 'warm', re: /warm|golden|sunset|cozy|honey/, adj: { warmth: 0.35 }, pref: { meanB: 18 } },
  { tag: 'cool', re: /cool|blue|icy|winter|teal/, adj: { warmth: -0.35 }, pref: { meanB: -2 } },
  { tag: 'film', re: /film|vintage|retro|analog|35mm|y2k|disposable/, adj: { fade: 0.35, grain: 0.3, contrast: -0.05 } },
  { tag: 'vivid', re: /vivid|pop|colou?rful|bold|neon|saturat/, adj: { sat: 0.3, contrast: 0.1 }, pref: { chroma: 30 } },
  { tag: 'muted', re: /muted|pastel|soft|dreamy|minimal|quiet/, adj: { sat: -0.2, contrast: -0.15, fade: 0.15 }, pref: { chroma: 14 } },
  { tag: 'b&w', re: /b&w|bw|black and white|black & white|mono|grayscale|greyscale/, adj: { mono: 1, contrast: 0.15 } },
  { tag: 'candid', re: /candid|natural|laugh|smil|genuine/, pref: { face: 1 } },
  { tag: 'no closed eyes', re: /closed eyes|blink|eyes open/, pref: { face: 1 } },
];

export function parseDirection(text) {
  const t = (text || '').toLowerCase();
  let count = null;
  const m = t.match(/\b(\d{1,2})\b/);
  if (m) count = +m[1];
  else for (const [w, v] of Object.entries(WORDNUM)) if (new RegExp(`\\b${w}\\b`).test(t)) { count = v; break; }
  const vibes = VIBES.filter((v) => v.re.test(t));
  const adj = {}, pref = {};
  vibes.forEach((v) => {
    Object.entries(v.adj || {}).forEach(([k, x]) => (adj[k] = (adj[k] || 0) + x));
    Object.assign(pref, v.pref || {});
  });
  return { count: count ? Math.max(1, Math.min(40, count)) : null, tags: vibes.map((v) => v.tag), adj, pref };
}

/* ---------------- clustering ---------------- */

const SCENE_GAP = 12 * 60 * 1000;

export function clusterScenes(shots) {
  const timed = shots.filter((s) => s.time).sort((a, b) => a.time - b.time);
  const untimed = shots.filter((s) => !s.time);
  const scenes = [];
  let cur = null;
  for (const s of timed) {
    const prev = cur && cur[cur.length - 1];
    const far = prev && s.gps && prev.gps && haversine(prev.gps, s.gps) > 300;
    if (!cur || s.time - prev.time > SCENE_GAP || far) { cur = []; scenes.push(cur); }
    cur.push(s);
  }
  // no reliable capture times: fall back to visual clustering
  for (const s of untimed) {
    let best = null, bestSim = 0.55;
    for (const sc of scenes) {
      const sim = Math.max(...sc.map((o) => cosine(o.feat.emb, s.feat.emb)));
      if (sim > bestSim) { bestSim = sim; best = sc; }
    }
    if (best) best.push(s); else scenes.push([s]);
  }
  scenes.forEach((sc, i) => sc.forEach((s) => (s.scene = i)));
  return scenes;
}

export function findBursts(scenes) {
  let id = 0;
  for (const sc of scenes) {
    const parent = sc.map((_, i) => i);
    const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    for (let i = 0; i < sc.length; i++) for (let j = i + 1; j < sc.length; j++) {
      const sim = cosine(sc[i].feat.emb, sc[j].feat.emb);
      const dt = sc[i].time && sc[j].time ? Math.abs(sc[i].time - sc[j].time) : Infinity;
      if (sim > 0.93 || (sim > 0.82 && dt < 25000)) parent[root(i)] = root(j);
    }
    const groups = {};
    sc.forEach((s, i) => (groups[root(i)] ||= []).push(s));
    Object.values(groups).forEach((g) => { const b = id++; g.forEach((s) => { s.burst = b; s.burstSize = g.length; }); });
  }
}

function haversine(a, b) {
  const R = 6371e3, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------------- scoring ---------------- */

export const FEATURES = [
  { key: 'taste', label: 'Your taste' },
  { key: 'sharp', label: 'Sharpness' },
  { key: 'exposure', label: 'Exposure' },
  { key: 'face', label: 'Face & expression' },
  { key: 'composition', label: 'Composition' },
  { key: 'subject', label: 'Subject pop' },
  { key: 'color', label: 'Color' },
  { key: 'style', label: 'Matches your look' },
  { key: 'vibe', label: 'Matches the brief' },
];

export const DEFAULT_WEIGHTS = { taste: 1.4, sharp: 1.2, exposure: 0.9, face: 1.0, composition: 0.8, subject: 0.6, color: 0.5, style: 0.9, vibe: 0.7 };

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const sig = (z) => 1 / (1 + Math.exp(-z));

export function scoreShots(shots, profile, dir) {
  const stats = (arr) => {
    const mu = arr.reduce((a, b) => a + b, 0) / arr.length;
    return { mu, sd: Math.sqrt(arr.reduce((a, b) => a + (b - mu) ** 2, 0) / arr.length) || 1 };
  };
  const median = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  const g = stats(shots.map((s) => s.feat.sharp));
  // judge sharpness and exposure against the frame's own scene: a night street is supposed to be dark
  const scene = {};
  for (const s of shots) (scene[s.scene] ||= []).push(s);
  const sc = {};
  for (const k in scene) {
    const list = scene[k];
    sc[k] = { sharp: list.length > 2 ? stats(list.map((s) => s.feat.sharp)) : g, L: median(list.map((s) => s.feat.meanL)) };
  }
  const colors = shots.map((s) => s.feat.colorfulness).sort((a, b) => a - b);
  for (const s of shots) {
    const f = s.feat, st = sc[s.scene] || { sharp: g, L: f.meanL };
    const intent = dir.pref.meanL ?? profile?.meanL ?? 52;
    const targetL = 0.75 * st.L + 0.25 * intent;
    const exposure = clamp01(1 - Math.abs(f.meanL - targetL) / 28 - f.clipHi * 4 - f.clipLo * 3);
    const zs = 0.6 * ((f.sharp - st.sharp.mu) / st.sharp.sd) + 0.4 * ((f.sharp - g.mu) / g.sd);
    const style = profile ? styleMatch(f, profile) : 0.5;
    let vibe = 0.5;
    if (dir.pref.meanL != null) vibe = (vibe + clamp01(1 - Math.abs(f.meanL - dir.pref.meanL) / 40)) / 2;
    if (dir.pref.meanB != null) vibe = (vibe + clamp01(1 - Math.abs(f.meanB - dir.pref.meanB) / 25)) / 2;
    if (dir.pref.chroma != null) vibe = (vibe + clamp01(1 - Math.abs(f.chroma - dir.pref.chroma) / 25)) / 2;
    const face = faceScore(s);
    let tasteLocal = 0.5;
    if (profile?.embs?.length) {
      let best = 0;
      for (const e of profile.embs) best = Math.max(best, cosine(e, f.emb));
      tasteLocal = clamp01((best - 0.35) / 0.5);
    }
    s.tasteLocal = tasteLocal;
    s.x = {
      sharp: sig(zs * 1.6),
      exposure,
      face,
      composition: f.comp,
      subject: clamp01(f.focus * 1.4 + Math.min(f.skinFrac, 0.25) * 1.2),
      color: colors.indexOf(f.colorfulness) / Math.max(1, colors.length - 1),
      style,
      vibe,
      taste: s.judge ? s.judge.taste : tasteLocal,
    };
  }
  // frames Claude never saw were already below the cut locally: keep them from outranking judged ones
  const judged = shots.filter((s) => s.judge).map((s) => s.judge.taste).sort((a, b) => a - b);
  if (judged.length) {
    const floor = judged[Math.floor(judged.length * 0.25)];
    for (const s of shots) if (!s.judge) s.x.taste = Math.min(s.x.taste, floor);
  }
}

// Eyes open (worst face in the frame, so one blink in a group counts), smile and facing the camera,
// from the landmark detector; blended with Claude's read of expression and angle when available.
export function faceScore(s) {
  let det = null;
  if (s.faces?.length) {
    const eyes = Math.min(...s.faces.map((f) => f.eyesOpen));
    const m = s.faces.reduce((a, b) => ((b.box[2] - b.box[0]) > (a.box[2] - a.box[0]) ? b : a));
    det = 0.55 * eyes + 0.2 * m.smile + 0.25 * Math.max(0, 1 - Math.abs(m.yaw) / 0.6);
    s.eyes = eyes;
  } else s.eyes = s.face?.eyes ?? null;
  if (s.judge && s.face) return det == null ? s.face.score : 0.5 * s.face.score + 0.5 * det;
  return det ?? 0.5;
}

export function styleMatch(f, p) {
  const d = Math.hypot((f.meanL - p.meanL) / 18, (f.stdL - p.stdL) / 9, (f.meanA - p.meanA) / 8, (f.meanB - p.meanB) / 10, (f.chroma - p.chroma) / 12);
  return Math.exp(-d * 0.6);
}

export function totalScore(x, w) {
  let s = 0, z = 0;
  for (const k in w) { s += w[k] * x[k]; z += Math.abs(w[k]); }
  return z ? s / z : 0;
}

/* ---------------- pairwise taste ranker (Bradley–Terry / linear RankNet) ---------------- */

export function updateWeights(w, winner, loser, lr = 0.9) {
  const diff = {};
  let m = 0;
  for (const k in w) { diff[k] = winner[k] - loser[k]; m += w[k] * diff[k]; }
  const g = 1 - sig(4 * m); // how surprised the model was
  const next = { ...w };
  for (const k in w) next[k] = Math.max(0.05, Math.min(3, w[k] + lr * g * diff[k]));
  return next;
}

export function nextPair(shots, seen, count) {
  const pool = shots.filter((s) => !s.dupOf).sort((a, b) => b.score - a.score).slice(0, Math.max(6, count * 2));
  let best = null, bestGap = Infinity;
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
    const key = [pool[i].id, pool[j].id].sort().join('|');
    if (seen.has(key)) continue;
    const gap = Math.abs(pool[i].score - pool[j].score) + (pool[i].burst === pool[j].burst ? -0.02 : 0);
    if (gap < bestGap) { bestGap = gap; best = [pool[i], pool[j], key]; }
  }
  return best;
}

// Every manual override is a preference label. Adding X says X beats the frames the model ranked above it;
// removing Y says the other picks beat Y.
export function learnFromOverride(w, shots, picks, s, added) {
  const pairs = added
    ? shots.filter((o) => o !== s && !o.dupOf && !picks.includes(o) && o.score > s.score).slice(0, 6).map((o) => [s, o])
    : picks.filter((p) => p !== s).slice(0, 6).map((p) => [p, s]);
  let next = w;
  for (const [win, lose] of pairs) next = updateWeights(next, win.x, lose.x, 0.5);
  return { weights: next, pairs: pairs.length };
}

/* ---------------- selection ---------------- */

export function selectPicks(shots, weights, count, locked = new Set(), banned = new Set()) {
  for (const s of shots) { s.score = totalScore(s.x, weights); s.dupOf = null; }
  const byBurst = {};
  shots.forEach((s) => (byBurst[s.burst] ||= []).push(s));
  Object.values(byBurst).forEach((g) => {
    g.sort((a, b) => b.score - a.score);
    g.slice(1).forEach((s) => (s.dupOf = g[0].id));
  });
  const picks = shots.filter((s) => locked.has(s.id));
  const pool = shots.filter((s) => !s.dupOf && !locked.has(s.id) && !banned.has(s.id));
  const scenesSeen = new Set(picks.map((p) => p.scene));
  while (picks.length < count && pool.length) {
    let bi = 0, bv = -Infinity;
    pool.forEach((s, i) => {
      const red = picks.length ? Math.max(...picks.map((p) => cosine(p.feat.emb, s.feat.emb))) : 0;
      const inScene = picks.filter((p) => p.scene === s.scene).length;
      const v = s.score - 0.25 * Math.max(0, red - 0.5) + (scenesSeen.has(s.scene) ? 0 : 0.06) - 0.03 * inScene;
      if (v > bv) { bv = v; bi = i; }
    });
    const s = pool.splice(bi, 1)[0];
    picks.push(s);
    scenesSeen.add(s.scene);
  }
  return picks;
}

export function reasonsFor(s, weights, profile) {
  const out = [];
  if (s.burstSize > 1) out.push(`Best of ${s.burstSize}-frame burst`);
  const contrib = FEATURES.map((f) => ({ ...f, v: s.x[f.key], c: s.x[f.key] * weights[f.key] }))
    .filter((f) => f.v > 0.62).sort((a, b) => b.c - a.c).slice(0, 3);
  for (const f of contrib) {
    if (f.key === 'taste') out.push(s.judge?.note || 'Like what you post');
    else if (f.key === 'style' && profile) out.push('Close to your past edits');
    else if (f.key === 'face' && s.face) out.push(s.judge ? 'Eyes open, good expression' : 'Strong expression');
    else if (f.key === 'sharp') out.push('Tack sharp');
    else if (f.key === 'composition') out.push('Strong framing');
    else if (f.key === 'exposure') out.push('Clean exposure');
    else if (f.key === 'vibe') out.push('Fits the brief');
    else if (f.key === 'subject') out.push('Subject stands out');
    else if (f.key === 'color') out.push('Rich color');
  }
  return out.slice(0, 3);
}
