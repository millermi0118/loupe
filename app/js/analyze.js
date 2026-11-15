// Per-photo measurements: tone, color, sharpness, saliency, skin, composition,
// and a compact embedding used for similarity / burst detection.

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

export function rgbToLab(r, g, b) {
  const R = LIN[r | 0], G = LIN[g | 0], B = LIN[b | 0];
  const x = fLab((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = fLab(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = fLab((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

// float rgb (0..255) in, so LUT building does not quantize twice
export function rgbToLabF(r, g, b) {
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const x = fLab((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = fLab(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = fLab((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const toS = (c) => {
    c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, c * 255));
  };
  return [
    toS(X * 3.2406 - Y * 1.5372 - Z * 0.4986),
    toS(-X * 0.9689 + Y * 1.8758 + Z * 0.0415),
    toS(X * 0.0557 - Y * 0.204 + Z * 1.057),
  ];
}

export async function decode(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) {
    return await createImageBitmap(blob);
  }
}

export function scaledCanvas(src, maxSide) {
  const sw = src.width, sh = src.height;
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * s));
  c.height = Math.max(1, Math.round(sh * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export function canvasBlob(c, type = 'image/jpeg', q = 0.86) {
  return new Promise((res) => c.toBlob(res, type, q));
}

export function analyzeCanvas(c) {
  const w = c.width, h = c.height, n = w * h;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const gray = new Float32Array(n), skin = new Uint8Array(n);
  const hist = new Float32Array(101);
  const bins = new Float32Array(64 * 4); // count, r, g, b sums per 4x4x4 bin
  let sL = 0, sL2 = 0, sA = 0, sA2 = 0, sB = 0, sB2 = 0, sC = 0;
  let sRG = 0, sRG2 = 0, sYB = 0, sYB2 = 0, hi = 0, lo = 0, skinN = 0;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    const [l, aa, bb] = rgbToLab(r, g, b);
    L[i] = l; A[i] = aa; B[i] = bb;
    sL += l; sL2 += l * l; sA += aa; sA2 += aa * aa; sB += bb; sB2 += bb * bb;
    sC += Math.hypot(aa, bb);
    hist[Math.max(0, Math.min(100, Math.round(l)))]++;
    if (l > 97) hi++;
    if (l < 3) lo++;
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const rg = r - g, yb = 0.5 * (r + g) - b;
    sRG += rg; sRG2 += rg * rg; sYB += yb; sYB2 += yb * yb;
    if (l > 20 && isSkin(r, g, b)) { skin[i] = 1; skinN++; }
    const bi = ((r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)) * 4;
    bins[bi]++; bins[bi + 1] += r; bins[bi + 2] += g; bins[bi + 3] += b;
  }

  const mean = (s) => s / n;
  const sd = (s, s2) => Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  const meanL = mean(sL), stdL = sd(sL, sL2);
  const meanA = mean(sA), stdA = sd(sA, sA2), meanB = mean(sB), stdB = sd(sB, sB2);
  const colorfulness = Math.hypot(sd(sRG, sRG2), sd(sYB, sYB2)) + 0.3 * Math.hypot(mean(sRG), mean(sYB));

  // luminance quantiles (17 points) for tone-curve matching
  const q = [];
  let acc = 0, k = 0;
  for (let v = 0; v <= 100 && k < 17; v++) {
    const prev = acc;
    acc += hist[v];
    while (k < 17 && acc >= (k / 16) * n) {
      const need = (k / 16) * n - prev;
      q.push(v - 0.5 + (hist[v] ? need / hist[v] : 0));
      k++;
    }
  }
  while (q.length < 17) q.push(100);
  q[0] = Math.max(0, q[0]);

  // sharpness: Laplacian variance per tile, take the sharpest tiles (subject can be sharp over bokeh)
  const T = 4;
  const tS = new Float64Array(T * T), tS2 = new Float64Array(T * T), tN = new Float64Array(T * T);
  const gw = 24, gh = Math.max(8, Math.min(48, Math.round((24 * h) / w)));
  const gGrad = new Float32Array(gw * gh), gDist = new Float32Array(gw * gh);
  const gSkin = new Float32Array(gw * gh), gN = new Float32Array(gw * gh);
  const gGray = new Float32Array(16 * 16), gGN = new Float32Array(16 * 16);
  const fw = 64, fh = Math.max(16, Math.round((64 * h) / w));
  const fSkin = new Float32Array(fw * fh), fN = new Float32Array(fw * fh);
  let gradSum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gi = Math.floor((y * gh) / h) * gw + Math.floor((x * gw) / w);
      const si = Math.floor((y * 16) / h) * 16 + Math.floor((x * 16) / w);
      gGray[si] += gray[i]; gGN[si]++;
      const fi = Math.floor((y * fh) / h) * fw + Math.floor((x * fw) / w);
      fSkin[fi] += skin[i]; fN[fi]++;
      const dist = Math.sqrt((L[i] - meanL) ** 2 + 1.5 * (A[i] - meanA) ** 2 + 1.5 * (B[i] - meanB) ** 2);
      gDist[gi] += dist; gSkin[gi] += skin[i]; gN[gi]++;
      if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
        const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        const ti = Math.floor((y * T) / h) * T + Math.floor((x * T) / w);
        tS[ti] += lap; tS2[ti] += lap * lap; tN[ti]++;
        const gr = Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + w] - gray[i - w]);
        gGrad[gi] += gr; gradSum += gr;
      }
    }
  }
  const tileVar = [];
  for (let t = 0; t < T * T; t++) if (tN[t]) tileVar.push(tS2[t] / tN[t] - (tS[t] / tN[t]) ** 2);
  tileVar.sort((a, b) => b - a);
  const sharp = Math.log1p((tileVar[0] + tileVar[1] + tileVar[2]) / 3);

  for (let g = 0; g < gw * gh; g++) {
    const c2 = gN[g] || 1;
    gGrad[g] /= c2; gDist[g] /= c2; gSkin[g] /= c2;
  }
  const maxG = Math.max(...gGrad) || 1, maxD = Math.max(...gDist) || 1;
  let sal = new Float32Array(gw * gh);
  for (let g = 0; g < gw * gh; g++) sal[g] = 0.45 * (gGrad[g] / maxG) + 0.4 * (gDist[g] / maxD) + 0.25 * gSkin[g];
  sal = blurGrid(sal, gw, gh);

  // saliency centroid from the strongest cells
  const sorted = Array.from(sal).sort((a, b) => b - a);
  const thr = sorted[Math.floor(sorted.length * 0.2)];
  let cx = 0, cy = 0, cw = 0, salTotal = 0, salTop = 0;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const s = sal[y * gw + x];
    salTotal += s;
    if (s >= thr) { const ww = s * s; cx += ((x + 0.5) / gw) * ww; cy += ((y + 0.5) / gh) * ww; cw += ww; salTop += s; }
  }
  const centroid = cw ? [cx / cw, cy / cw] : [0.5, 0.5];
  const focus = salTotal ? salTop / salTotal : 0.2; // how concentrated the subject is

  const comp = compositionScore(centroid);

  // skin box (proxy for person/face region)
  let sx0 = 1, sy0 = 1, sx1 = 0, sy1 = 0, sCells = 0;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    if (gSkin[y * gw + x] > 0.35) {
      sCells++;
      sx0 = Math.min(sx0, x / gw); sy0 = Math.min(sy0, y / gh);
      sx1 = Math.max(sx1, (x + 1) / gw); sy1 = Math.max(sy1, (y + 1) / gh);
    }
  }
  const skinBox = sCells >= 2 ? [sx0, sy0, sx1, sy1] : null;

  // embedding: 16x16 normalized structure + 4x4x4 color histogram (Hellinger)
  const emb = new Float32Array(256 + 64);
  let gm = 0;
  for (let i = 0; i < 256; i++) { gGray[i] /= gGN[i] || 1; gm += gGray[i]; }
  gm /= 256;
  let gs = 0;
  for (let i = 0; i < 256; i++) gs += (gGray[i] - gm) ** 2;
  gs = Math.sqrt(gs / 256) || 1;
  for (let i = 0; i < 256; i++) emb[i] = (gGray[i] - gm) / gs / 16;
  for (let i = 0; i < 64; i++) emb[256 + i] = Math.sqrt(bins[i * 4] / n) * 0.9;
  let norm = 0;
  for (let i = 0; i < emb.length; i++) norm += emb[i] * emb[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < emb.length; i++) emb[i] /= norm;

  // palette: heaviest color bins
  const pal = [];
  for (let i = 0; i < 64; i++) if (bins[i * 4]) pal.push([bins[i * 4], bins[i * 4 + 1] / bins[i * 4], bins[i * 4 + 2] / bins[i * 4], bins[i * 4 + 3] / bins[i * 4]]);
  pal.sort((a, b) => b[0] - a[0]);

  return {
    w, h, aspect: w / h, meanL, stdL, meanA, stdA, meanB, stdB,
    chroma: sC / n, colorfulness, q, clipHi: hi / n, clipLo: lo / n,
    sharp, comp, centroid, focus, clutter: gradSum / n / 60,
    skinFrac: skinN / n, skinBox, faceBox: guessFace(fSkin.map((v, i) => v / (fN[i] || 1)), fw, fh, w, h),
    grid: { gw, gh, sal, grad: gGrad.map((v) => v / maxG), skin: gSkin },
    emb, palette: pal.slice(0, 6).map((p) => [p[1], p[2], p[3], p[0] / n]),
  };
}

export function isSkin(r, g, b) {
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return cb > 77 && cb < 127 && cr > 135 && cr < 173 && r > g && r > 60;
}

// Fallback face finder when no face model has run: the most face-shaped compact skin blob.
function guessFace(gSkin, gw, gh, w, h) {
  const seen = new Uint8Array(gw * gh);
  let best = null, bestV = 0;
  for (let i = 0; i < gw * gh; i++) {
    if (seen[i] || gSkin[i] < 0.4) continue;
    const stack = [i], cells = [];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop(), x = c % gw, y = (c / gw) | 0;
      cells.push([x, y]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy, j = yy * gw + xx;
        if (xx >= 0 && yy >= 0 && xx < gw && yy < gh && !seen[j] && gSkin[j] >= 0.4) { seen[j] = 1; stack.push(j); }
      }
    }
    const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs) + 1, y0 = Math.min(...ys), y1 = Math.max(...ys) + 1;
    const fill = cells.length / ((x1 - x0) * (y1 - y0));
    const bw = (x1 - x0) / gw, bh = (y1 - y0) / gh, ar = (bh * h) / (bw * w);
    // backgrounds (warm skies, beige walls, sand) touch the frame edges; faces rarely touch two
    const edges = (x0 === 0) + (y0 === 0) + (x1 === gw) + (y1 === gh);
    if (cells.length < 6 || fill < 0.45 || ar < 0.6 || ar > 2.6 || bw * bh > 0.15 || edges >= 2 || (y0 === 0 && bw > 0.4)) continue;
    const v = cells.length * fill * (1 - Math.abs((y0 + y1) / 2 / gh - 0.4) * 0.6);
    // skin blobs usually include the neck: cap the face at 1.35x its width
    if (v > bestV) { bestV = v; best = [x0 / gw, y0 / gh, x1 / gw, Math.min(y1 / gh, y0 / gh + (1.35 * bw * w) / h)]; }
  }
  return best;
}

export function expandBox([x0, y0, x1, y1], k) {
  const dw = (x1 - x0) * k, dh = (y1 - y0) * k;
  return [Math.max(0, x0 - dw), Math.max(0, y0 - dh), Math.min(1, x1 + dw), Math.min(1, y1 + dh)];
}

// Skin color, brightness and texture inside a face box, measured at a fixed face width
// so photos of any size and any face size compare fairly.
export function skinStats(src, box) {
  if (!box) return null;
  const W = src.width, H = src.height;
  const [x0, y0, x1, y1] = expandBox(box, 0.05);
  const sw = (x1 - x0) * W, sh = (y1 - y0) * H;
  if (sw < 12 || sh < 12) return null;
  const tw = 160, th = Math.max(12, Math.min(400, Math.round((160 * sh) / sw)));
  const c = document.createElement('canvas');
  c.width = tw; c.height = th;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, x0 * W, y0 * H, sw, sh, 0, 0, tw, th);
  const d = ctx.getImageData(0, 0, tw, th).data;
  const n = tw * th, Ls = new Float32Array(n), m = new Uint8Array(n);
  let sL = 0, sA = 0, sB = 0, k = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const [l, a, b] = rgbToLab(d[p], d[p + 1], d[p + 2]);
    Ls[i] = l;
    if (l > 20 && isSkin(d[p], d[p + 1], d[p + 2])) { m[i] = 1; sL += l; sA += a; sB += b; k++; }
  }
  if (k < n * 0.08) return null;
  let tex = 0;
  for (let y = 2; y < th - 2; y++) for (let x = 2; x < tw - 2; x++) {
    const i = y * tw + x;
    if (!m[i]) continue;
    let s = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += Ls[i + dy * tw + dx];
    tex += Math.abs(Ls[i] - s / 25);
  }
  return { L: sL / k, a: sA / k, b: sB / k, tex: tex / k, n: k };
}

export function compositionScore([x, y]) {
  let best = 1;
  for (const px of [1 / 3, 2 / 3]) for (const py of [1 / 3, 2 / 3]) best = Math.min(best, Math.hypot(x - px, y - py));
  const thirds = Math.max(0, 1 - best / 0.22);
  const center = Math.max(0, 1 - Math.hypot(x - 0.5, y - 0.45) / 0.22) * 0.85;
  const edge = Math.min(x, y, 1 - x, 1 - y) < 0.1 ? 0.5 : 1;
  return Math.max(thirds, center, 0.15) * edge;
}

function blurGrid(g, w, h) {
  const o = new Float32Array(g.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) { const wt = dx || dy ? 1 : 2; s += g[yy * w + xx] * wt; c += wt; }
    }
    o[y * w + x] = s / c;
  }
  return o;
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
