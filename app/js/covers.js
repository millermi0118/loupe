// Cover recommender: per-platform aspect, UI safe zones and a weighted rubric.
// Weights are priors from public creator guidance; the production plan replaces
// them with models trained on each creator's own post analytics.

export const PLATFORMS = [
  {
    id: 'ig', name: 'Instagram', surface: 'Feed / carousel cover', ratio: [4, 5],
    safe: { top: 0.0, bottom: 0.0, left: 0.0, right: 0.0 },
    frame: { eyeY: 0.36, faceX: [0.5, 0.4, 0.6], faceH: 0.2, sideMargin: 0.1, rule: 'Eyes on the upper third, off the side edges the grid trims' },
    w: { framing: 1.0, aesthetic: 1.2, style: 1.1, subject: 0.8, legibility: 0.5, contrast: 0.4, color: 0.5, textspace: 0.1, safezone: 0.5, bright: 0.3 },
    why: 'Grid cohesion and polish matter most. Keep the subject off the side edges, since the profile grid trims them to 3:4.',
  },
  {
    id: 'tt', name: 'TikTok', surface: 'Video cover', ratio: [9, 16],
    safe: { top: 0.12, bottom: 0.27, left: 0.04, right: 0.16 },
    frame: { eyeY: 0.34, faceX: 'safe', faceH: 0.2, rule: 'Face big and centered between the caption and the button rail' },
    w: { framing: 1.1, aesthetic: 0.5, style: 0.3, subject: 1.2, legibility: 1.1, contrast: 1.0, color: 0.9, textspace: 0.6, safezone: 1.2, bright: 0.4 },
    why: 'A big, readable subject in the center safe zone. Captions and buttons cover the bottom and right edges.',
  },
  {
    id: 'dy', name: 'Douyin', surface: 'Video cover', ratio: [9, 16],
    safe: { top: 0.1, bottom: 0.3, left: 0.04, right: 0.18 },
    frame: { eyeY: 0.36, faceX: 'safe', faceH: 0.2, titleTop: 0.22, rule: 'Face centered in the safe zone, calm band up top for the title' },
    w: { framing: 1.1, aesthetic: 0.6, style: 0.3, subject: 1.1, legibility: 1.0, contrast: 0.8, color: 1.1, textspace: 0.7, safezone: 1.2, bright: 0.8 },
    why: 'Bright, saturated and clear in the center. Leave room at the top for a title overlay.',
  },
  {
    id: 'xhs', name: 'Xiaohongshu', surface: 'Note cover', ratio: [3, 4],
    safe: { top: 0.0, bottom: 0.06, left: 0.0, right: 0.0 },
    frame: { eyeY: 0.5, faceX: [0.5], faceH: 0.26, titleTop: 0.3, rule: 'Big face low in the frame, top third left clear for title text' },
    w: { framing: 1.0, aesthetic: 1.0, style: 0.6, subject: 0.7, legibility: 0.9, contrast: 0.4, color: 0.6, textspace: 1.1, safezone: 0.4, bright: 1.1 },
    why: 'Covers sit in a two-column feed at thumbnail size. Bright, airy frames with clean space for big title text win the tap.',
  },
];

function integral(vals, gw, gh) {
  const I = new Float64Array((gw + 1) * (gh + 1));
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++)
    I[(y + 1) * (gw + 1) + x + 1] = vals[y * gw + x] + I[y * (gw + 1) + x + 1] + I[(y + 1) * (gw + 1) + x] - I[y * (gw + 1) + x];
  // sum over a normalized rectangle (cell-rounded)
  return (x0, y0, x1, y1) => {
    const a = Math.max(0, Math.min(gw, Math.round(x0 * gw))), b = Math.max(0, Math.min(gh, Math.round(y0 * gh)));
    const c = Math.max(a, Math.min(gw, Math.round(x1 * gw))), d = Math.max(b, Math.min(gh, Math.round(y1 * gh)));
    return { sum: I[d * (gw + 1) + c] - I[b * (gw + 1) + c] - I[d * (gw + 1) + a] + I[b * (gw + 1) + a], cells: (c - a) * (d - b) };
  };
}

// Search every zoom and position for the crop that frames the face the way this platform wants.
// face is a normalized box in image coordinates, or null (then saliency drives the crop).
export function smartCrop(feat, platform, face, origW) {
  const { gw, gh, sal, grad } = feat.grid;
  const sal2 = sal.map((v) => v * v);
  const S = integral(sal2, gw, gh), G = integral(grad, gw, gh);
  const total = S(0, 0, 1, 1).sum || 1;
  const [rw, rh] = platform.ratio, safe = platform.safe, fr = platform.frame;
  const imgAR = feat.w / feat.h, tAR = rw / rh;
  const bw = imgAR > tAR ? tAR / imgAR : 1, bh = imgAR > tAR ? 1 : imgAR / tAR;
  const minZoom = Math.max(0.35, Math.min(1, 720 / Math.max(1, bw * (origW || feat.w * 4)))); // keep >= ~720px of real pixels
  const safeX = safe.left + (1 - safe.left - safe.right) / 2;
  const targetsX = fr.faceX === 'safe' ? [safeX] : fr.faceX;
  let best = null;
  for (let zoom = 1; zoom >= minZoom - 1e-6; zoom -= 0.04) {
    const cw = bw * zoom, ch = bh * zoom, steps = 22;
    for (let iy = 0; iy <= steps; iy++) for (let ix = 0; ix <= steps; ix++) {
      const x0 = (1 - cw) * (ix / steps), y0 = (1 - ch) * (iy / steps);
      const keep = S(x0, y0, x0 + cw, y0 + ch).sum / total;
      const top = G(x0, y0, x0 + cw, y0 + ch * (fr.titleTop || 0.3));
      const calmTop = Math.max(0, 1 - (top.cells ? top.sum / top.cells : 0) * 2.2);
      let v, info;
      if (face) {
        const fx0 = (face[0] - x0) / cw, fy0 = (face[1] - y0) / ch, fx1 = (face[2] - x0) / cw, fy1 = (face[3] - y0) / ch;
        const inside = fx0 >= 0.02 && fy0 >= 0.02 && fx1 <= 0.98 && fy1 <= 0.98;
        const eyeY = fy0 + 0.42 * (fy1 - fy0), fcx = (fx0 + fx1) / 2, fh = fy1 - fy0;
        const eyeFit = 1 - Math.min(1, Math.abs(eyeY - fr.eyeY) / 0.25);
        const xFit = 1 - Math.min(1, Math.min(...targetsX.map((t) => Math.abs(fcx - t))) / 0.3);
        const sizeFit = 1 - Math.min(1, Math.abs(Math.log(fh / fr.faceH)) / 0.9);
        const ox = Math.max(0, Math.min(fx1, 1 - safe.right) - Math.max(fx0, safe.left)), oy = Math.max(0, Math.min(fy1, 1 - safe.bottom) - Math.max(fy0, safe.top));
        const faceSafe = (ox * oy) / Math.max(1e-4, (fx1 - fx0) * (fy1 - fy0));
        const side = fr.sideMargin ? Math.min(1, Math.min(fx0, 1 - fx1) / fr.sideMargin) : 1;
        v = 0.14 * keep + 0.24 * eyeFit + 0.14 * xFit + 0.22 * sizeFit + 0.18 * faceSafe + 0.04 * side + (fr.titleTop ? 0.08 * calmTop : 0) - (inside ? 0 : 0.6);
        info = { eyeY, fh, faceSafe, calmTop, fit: (eyeFit + xFit + sizeFit + faceSafe) / 4 };
      } else {
        const sv = S(x0 + cw * safe.left, y0 + ch * safe.top, x0 + cw * (1 - safe.right), y0 + ch * (1 - safe.bottom)).sum;
        const inCrop = S(x0, y0, x0 + cw, y0 + ch).sum || 1;
        v = keep * 0.55 + (sv / inCrop) * 0.3 + (fr.titleTop ? 0.1 * calmTop : 0) - (1 - zoom) * 0.1;
        info = { faceSafe: sv / inCrop, calmTop, fit: Math.min(1, keep * 1.2) };
      }
      if (!best || v > best.v) best = { v, x: x0, y: y0, w: cw, h: ch, zoom, ...info };
    }
  }
  return best;
}

export function framingNote(crop, face) {
  if (!face) return 'No face found: framed on the strongest subject';
  const parts = [`Eyes at ${Math.round(crop.eyeY * 100)}% height`, `face fills ${Math.round(crop.fh * 100)}%`];
  if (crop.zoom < 0.97) parts.push(`${Math.round(100 / crop.zoom)}% zoom`);
  return parts.join(' · ');
}

export function rankCovers(items, platform, profileSim) {
  const res = items.map((it) => {
    const f = it.feat;
    const crop = smartCrop(f, platform, it.faceBox, it.origW);
    const m = {
      framing: crop.fit,
      aesthetic: it.score ?? 0.5,
      style: profileSim(it),
      subject: Math.min(1, (it.x?.face ?? 0.5) * 0.6 + f.focus * 0.8),
      legibility: Math.min(1, f.stdL / 28) * 0.6 + Math.min(1, it.faceBox ? crop.fh * 3 : f.focus * 1.6) * 0.4,
      contrast: Math.min(1, f.stdL / 30),
      color: Math.min(1, f.colorfulness / 70),
      textspace: crop.calmTop,
      safezone: crop.faceSafe,
      bright: Math.max(0, 1 - Math.abs(f.meanL - 64) / 40),
    };
    let s = 0, z = 0;
    for (const k in platform.w) { s += platform.w[k] * m[k]; z += platform.w[k]; }
    const why = Object.keys(platform.w).map((k) => ({ k, c: platform.w[k] * (m[k] - 0.5) })).sort((a, b) => b.c - a.c);
    return { it, crop, score: s / z, m, top: why.slice(0, 3).map((x) => x.k), weak: why[why.length - 1].k, note: framingNote(crop, it.faceBox) };
  });
  res.sort((a, b) => b.score - a.score);
  return res;
}

export const FACTOR_COPY = {
  framing: ['Frames well for this app', 'awkward to frame for this app'],
  aesthetic: ['Strongest overall frame', 'weaker frame overall'],
  style: ['Matches your grid', 'off-look for your grid'],
  subject: ['Subject reads instantly', 'subject is small'],
  legibility: ['Reads at thumbnail size', 'muddy at thumbnail size'],
  contrast: ['High contrast', 'flat contrast'],
  color: ['Color pops in feed', 'quiet color'],
  textspace: ['Clean space for a title', 'busy top, little room for text'],
  safezone: ['Subject clear of app UI', 'subject runs under app UI'],
  bright: ['Bright and airy', 'on the dark side'],
};
