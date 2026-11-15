// Sample shoot: procedurally drawn frames so the whole flow can be tried
// without uploading anything. Includes bursts, a blink, blur and bad exposures.
import { canvasBlob } from './analyze.js';

const SCENES = {
  golden: {
    sky: ['#3b2a5c', '#c4577a', '#ff9a62', '#ffd08a'], sun: [0.72, 0.58, '#fff2c4'],
    ground: '#2a1a24', shirt: '#f4efe6', hair: '#2b1a14', skin: '#d9a07c',
  },
  neon: {
    sky: ['#05061a', '#120c34', '#24124a', '#0b0a20'], ground: '#0c0a18',
    shirt: '#1a1a22', hair: '#0e0a0a', skin: '#c48a72', neon: true,
  },
  cafe: {
    sky: ['#efe3d2', '#eadcc8', '#e2d1ba', '#d8c3a8'], ground: '#b48b64',
    shirt: '#5b7a99', hair: '#3a2416', skin: '#e2b494', cafe: true,
  },
};

function drawScene(ctx, W, H, sc, v) {
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(v.tilt || 0);
  ctx.scale(v.zoom || 1, v.zoom || 1);
  ctx.translate(-W / 2 + (v.pan || 0) * W, -H / 2);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  sc.sky.forEach((c, i) => g.addColorStop(i / (sc.sky.length - 1), c));
  ctx.fillStyle = g;
  ctx.fillRect(-W, -H, W * 3, H * 3);

  if (sc.sun) {
    const [sx, sy, col] = sc.sun;
    const rg = ctx.createRadialGradient(sx * W, sy * H, 4, sx * W, sy * H, W * 0.5);
    rg.addColorStop(0, col); rg.addColorStop(0.12, 'rgba(255,220,160,.8)'); rg.addColorStop(1, 'rgba(255,160,120,0)');
    ctx.fillStyle = rg; ctx.fillRect(-W, -H, W * 3, H * 3);
    ctx.fillStyle = sc.ground;
    for (let i = 0; i < 14; i++) {
      const bw = W * (0.06 + ((i * 37) % 7) / 60), bh = H * (0.08 + ((i * 53) % 9) / 40);
      ctx.fillRect(-W * 0.2 + i * W * 0.11, H * 0.7 - bh, bw, bh + H);
    }
  }
  if (sc.neon) {
    const signs = [[0.1, 0.18, 0.22, 0.07, '#ff3fa4'], [0.62, 0.12, 0.3, 0.09, '#2de2e6'], [0.7, 0.34, 0.08, 0.26, '#ffcf3f'], [0.05, 0.4, 0.12, 0.05, '#8b5bff']];
    for (const [x, y, w, h, c] of signs) {
      ctx.shadowColor = c; ctx.shadowBlur = W * 0.05; ctx.fillStyle = c;
      ctx.fillRect(x * W, y * H, w * W, h * H);
      ctx.globalAlpha = 0.25; ctx.fillRect(x * W, (1.42 - y) * H, w * W, h * H * 0.6); ctx.globalAlpha = 1;
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(20,16,40,.7)'; ctx.fillRect(-W, H * 0.74, W * 3, H);
  }
  if (sc.cafe) {
    ctx.fillStyle = '#fbf7ef'; ctx.fillRect(W * 0.08, H * 0.1, W * 0.38, H * 0.42);
    ctx.fillStyle = '#d7e7f0'; ctx.fillRect(W * 0.1, H * 0.12, W * 0.34, H * 0.38);
    ctx.fillStyle = '#4f7a4a';
    for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.ellipse(W * (0.78 + Math.cos(i) * 0.08), H * (0.3 + Math.sin(i * 2) * 0.08), W * 0.06, W * 0.03, i, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#a5643c'; ctx.fillRect(W * 0.72, H * 0.4, W * 0.12, H * 0.08);
    ctx.fillStyle = sc.ground; ctx.fillRect(-W, H * 0.78, W * 3, H);
  }
  drawPerson(ctx, W, H, sc, v);
  ctx.restore();
}

function drawPerson(ctx, W, H, sc, v) {
  const s = (v.size || 1) * W;
  const cx = (v.x ?? 0.5) * W, cy = H * (v.y ?? 0.5);
  ctx.fillStyle = sc.shirt;
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.26, H * 1.05); ctx.quadraticCurveTo(cx - s * 0.28, cy + s * 0.2, cx - s * 0.1, cy + s * 0.14);
  ctx.lineTo(cx + s * 0.1, cy + s * 0.14); ctx.quadraticCurveTo(cx + s * 0.28, cy + s * 0.2, cx + s * 0.26, H * 1.05); ctx.fill();
  ctx.fillStyle = sc.skin;
  ctx.fillRect(cx - s * 0.035, cy + s * 0.04, s * 0.07, s * 0.12);
  ctx.beginPath(); ctx.ellipse(cx, cy, s * 0.085, s * 0.11, v.headTilt || 0, 0, 7); ctx.fill();
  if (sc.neon) {
    ctx.fillStyle = 'rgba(255,63,164,.35)'; ctx.beginPath(); ctx.ellipse(cx - s * 0.04, cy, s * 0.05, s * 0.1, 0, 0, 7); ctx.fill();
  }
  ctx.fillStyle = sc.hair;
  ctx.beginPath(); ctx.ellipse(cx, cy - s * 0.05, s * 0.095, s * 0.08, 0, Math.PI, 0); ctx.fill();
  ctx.fillRect(cx - s * 0.095, cy - s * 0.05, s * 0.025, s * 0.16);
  ctx.fillRect(cx + s * 0.07, cy - s * 0.05, s * 0.025, s * 0.16);
  ctx.strokeStyle = '#2a1712'; ctx.fillStyle = '#1d120e'; ctx.lineWidth = Math.max(1.5, s * 0.008);
  for (const ex of [-0.032, 0.032]) {
    ctx.beginPath();
    if (v.blink) { ctx.moveTo(cx + ex * s - s * 0.014, cy); ctx.quadraticCurveTo(cx + ex * s, cy + s * 0.008, cx + ex * s + s * 0.014, cy); ctx.stroke(); }
    else { ctx.ellipse(cx + ex * s, cy, s * 0.011, s * 0.009, 0, 0, 7); ctx.fill(); }
  }
  ctx.strokeStyle = '#8a3b3b'; ctx.lineWidth = Math.max(1.5, s * 0.01);
  ctx.beginPath();
  const smile = v.smile ?? 0.6;
  ctx.moveTo(cx - s * 0.03, cy + s * 0.05); ctx.quadraticCurveTo(cx, cy + s * (0.05 + 0.03 * smile), cx + s * 0.03, cy + s * 0.05); ctx.stroke();
}

function finish(c, v, grade) {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (v.blur) {
    const t = document.createElement('canvas');
    t.width = Math.round(c.width / v.blur); t.height = Math.round(c.height / v.blur);
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(t, 0, 0, c.width, c.height);
  }
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  let seed = v.seed || 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const e = v.exposure ?? 1;
  for (let p = 0; p < d.length; p += 4) {
    const n = (rnd() - 0.5) * 14;
    for (let k = 0; k < 3; k++) {
      let x = d[p + k] * e + n;
      if (grade) x = grade(x, k);
      d[p + k] = x;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// A consistent look for the sample "past edits": warm, lifted blacks, softened highlights.
const LOOK = (x, k) => {
  x = 22 + x * 0.86;
  if (k === 0) x = x * 1.04 + 4;
  if (k === 2) x = x * 0.9;
  return x;
};

async function frame(sceneKey, v, W, H, grade) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  drawScene(c.getContext('2d'), W, H, SCENES[sceneKey], v);
  finish(c, v, grade);
  return canvasBlob(c, 'image/jpeg', 0.9);
}

export async function sampleReferences() {
  const specs = [
    ['golden', { x: 0.4, y: 0.42, size: 1.1, smile: 0.9 }], ['golden', { x: 0.62, y: 0.5, size: 0.9 }],
    ['cafe', { x: 0.36, y: 0.45, size: 1.05, smile: 1 }], ['cafe', { x: 0.6, y: 0.44, size: 0.95 }],
    ['neon', { x: 0.45, y: 0.46, size: 1.0 }], ['golden', { x: 0.5, y: 0.4, size: 1.3, smile: 0.7 }],
    ['cafe', { x: 0.5, y: 0.42, size: 1.25 }], ['neon', { x: 0.36, y: 0.44, size: 1.15, smile: 0.8 }],
    ['golden', { x: 0.34, y: 0.48, size: 0.85 }],
  ];
  const out = [];
  for (let i = 0; i < specs.length; i++) {
    const [k, v] = specs[i];
    out.push({ blob: await frame(k, { ...v, seed: 100 + i }, 600, 750, LOOK), name: `past-edit-${String(i + 1).padStart(2, '0')}.jpg` });
  }
  return out;
}

export async function sampleShoot() {
  const day = new Date(2026, 10, 8, 18, 42, 5).getTime();
  const sec = 1000, min = 60 * sec;
  const specs = [
    // golden hour rooftop
    ['golden', 0, { x: 0.42, y: 0.42, size: 1.1, smile: 0.9 }],
    ['golden', 2 * sec, { x: 0.43, y: 0.42, size: 1.1, smile: 0.9, blur: 6 }],
    ['golden', 3 * sec, { x: 0.42, y: 0.43, size: 1.1, smile: 0.6, blink: true }],
    ['golden', 5 * sec, { x: 0.44, y: 0.42, size: 1.1, smile: 1 }],
    ['golden', 1 * min, { x: 0.9, y: 0.5, size: 0.8, smile: 0.4 }],
    ['golden', 2 * min, { x: 0.5, y: 0.42, size: 0.95, exposure: 1.55 }],
    ['golden', 3 * min, { x: 0.64, y: 0.4, size: 1.35, smile: 0.8 }],
    // neon street
    ['neon', 2.5 * 60 * min, { x: 0.45, y: 0.45, size: 1.0 }],
    ['neon', 2.5 * 60 * min + 1 * sec, { x: 0.46, y: 0.45, size: 1.0, blur: 7 }],
    ['neon', 2.5 * 60 * min + 3 * sec, { x: 0.45, y: 0.45, size: 1.0, smile: 1 }],
    ['neon', 2.5 * 60 * min + 2 * min, { x: 0.36, y: 0.44, size: 1.2, exposure: 0.45 }],
    ['neon', 2.5 * 60 * min + 3 * min, { x: 0.58, y: 0.42, size: 1.15, tilt: 0.09, smile: 0.8 }],
    // cafe, next morning
    ['cafe', 16.6 * 60 * min, { x: 0.36, y: 0.44, size: 1.05, smile: 1 }],
    ['cafe', 16.6 * 60 * min + 2 * sec, { x: 0.37, y: 0.44, size: 1.05, smile: 0.5, blink: true }],
    ['cafe', 16.6 * 60 * min + 1.5 * min, { x: 0.55, y: 0.48, size: 0.7 }],
    ['cafe', 16.6 * 60 * min + 3 * min, { x: 0.5, y: 0.38, size: 1.45, smile: 0.9 }],
  ];
  const out = [];
  for (let i = 0; i < specs.length; i++) {
    const [k, t, v] = specs[i];
    out.push({ blob: await frame(k, { ...v, seed: 7 + i * 13 }, 720, 960), name: `IMG_${4810 + i}.jpg`, time: day + t });
  }
  return out;
}
