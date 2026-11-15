import { readExif } from './exif.js';
import { detectFaces } from './faces.js';
import { openVault, serializeRef, hydrateRef, MAX_REFS } from './vault.js';
import { decode, scaledCanvas, analyzeCanvas, canvasBlob, skinStats, labToRgb } from './analyze.js';
import {
  buildProfile, profileStrength, describeProfile, parseDirection, clusterScenes, findBursts,
  scoreShots, selectPicks, reasonsFor, updateWeights, nextPair, FEATURES, DEFAULT_WEIGHTS, styleMatch, learnFromOverride,
} from './engine.js';
import { ADJUST, defaultAdjust, renderEdit, facePlan } from './edit.js';
import { PLATFORMS, rankCovers, FACTOR_COPY } from './covers.js';
import { sampleReferences, sampleShoot } from './demo.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STEPS = [
  { id: 'look', label: 'Your look' },
  { id: 'brief', label: 'New shoot' },
  { id: 'pick', label: 'Pick' },
  { id: 'edit', label: 'Edit' },
  { id: 'cover', label: 'Cover' },
];
const EXAMPLES = ['6 picks, warm golden film vibe, no closed eyes', '10 for a carousel, bright and airy', '3 moody b&w portraits', '8 vivid neon night shots'];

const S = {
  step: 'look', refs: [], profile: null, sampleRefs: false, vault: null, booting: true, confirmDelete: false,
  weights: { ...DEFAULT_WEIGHTS }, duels: 0,
  seen: new Set(), brief: EXAMPLES[0], dir: parseDirection(EXAMPLES[0]), target: 6,
  shots: [], scenes: [], picks: [], locked: new Set(), banned: new Set(), inspect: null, sampleShots: false, culled: false,
  adj: {}, active: null, split: 0.5, safe: true, coverChoice: {}, editedCache: {}, busy: null,
  sample: null, sampleImages: null, useClaude: true, judging: null,
};

const mainFace = (boxes) => boxes.slice().sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]))[0] || null;
let uid = 0;
window.loupe = S; // handy for poking at state from devtools
const capability = (name) => (window.claude?.use ? window.claude.use(name).catch(() => null) : Promise.resolve(null));
const downloadsP = capability('downloads');
capability('sample').then(async (s) => {
  if (!s) return;
  S.sample = s;
  const lim = await s.limits().catch(() => null);
  S.sampleImages = lim?.images || null;
  if (S.step === 'pick') render();
});

/* ---------------- ingest ---------------- */

async function ingest(blob, name, extra = {}) {
  const exif = /jpe?g$/i.test(blob.type) || /\.jpe?g$/i.test(name) ? await readExif(blob) : {};
  const bmp = await decode(blob);
  const mid = scaledCanvas(bmp, 480);
  const feat = analyzeCanvas(scaledCanvas(mid, 400));
  let faces = null;
  try { faces = await detectFaces(scaledCanvas(bmp, 640)); } catch (e) { faces = null; }
  const main = faces ? mainFace(faces.map((f) => f.box)) : feat.faceBox;
  const skin = skinStats(bmp, main);
  const origW = bmp.width, origH = bmp.height;
  if (bmp.close) bmp.close();
  const thumb = await canvasBlob(mid, 'image/jpeg', 0.84);
  const small = extra.ref ? scaledCanvas(mid, 320).toDataURL('image/jpeg', 0.8) : null;
  return {
    id: extra.ref ? 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) : 'p' + ++uid, small, name, blob, feat, faces, faceChecked: faces !== null, skin, origW, origH, thumb, url: URL.createObjectURL(thumb), exif,
    time: extra.time ?? exif.time ?? null,
    gps: exif.lat != null ? { lat: exif.lat, lon: exif.lon } : null,
  };
}

async function ingestMany(list, label) {
  const out = [];
  const failed = [];
  for (let i = 0; i < list.length; i++) {
    setBusy(`${label} ${i + 1}/${list.length}`);
    try { out.push(await ingest(list[i].blob, list[i].name, list[i])); } catch (e) { failed.push(list[i].name); }
  }
  setBusy(null);
  if (failed.length) toast(`Couldn't read ${failed.length} file${failed.length > 1 ? 's' : ''} (${failed.slice(0, 2).join(', ')}). HEIC needs Safari, or export as JPEG.`);
  return out;
}

function filesFrom(fileList) {
  return Array.from(fileList).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|avif)$/i.test(f.name)).map((f) => ({ blob: f, name: f.name }));
}

/* ---------------- profile ---------------- */

function rebuildProfile() {
  S.profile = buildProfile(S.refs);
}

function saveTaste() {
  S.vault?.saveTaste({ weights: S.weights, duels: S.duels });
}

// Upload once: every real reference photo is kept (thumbnail + measurements) for next time.
async function persistRefs(refs) {
  if (!S.vault) return 0;
  let saved = 0;
  for (const r of refs) {
    setBusy(`Saving to your profile ${saved + 1}/${refs.length}`);
    try { await S.vault.putRef(serializeRef(r)); r.stored = true; saved++; }
    catch (e) {
      toast(e?.code === 'quota_exceeded' ? `Profile storage is full. ${saved} of ${refs.length} new photos were saved.` : `Couldn't save ${r.name} to your profile.`);
      break;
    }
  }
  setBusy(null);
  return saved;
}

/* ---------------- culling ---------------- */

function cull() {
  S.dir = parseDirection(S.brief);
  S.target = S.dir.count || 6;
  S.locked = new Set(); S.banned = new Set(); S.seen = new Set();
  S.scenes = clusterScenes(S.shots);
  findBursts(S.scenes);
  rescore();
  S.inspect = S.picks[0]?.id || null;
  S.culled = true;
  S.adj = {}; S.editedCache = {}; S.coverChoice = {};
  S.active = S.picks[0]?.id || null;
}

function rescore() {
  scoreShots(S.shots, S.profile, S.dir);
  S.picks = selectPicks(S.shots, S.weights, Math.max(S.target, S.locked.size), S.locked, S.banned);
  S.picks.sort((a, b) => (a.time || 0) - (b.time || 0) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

const byId = (id) => S.shots.find((s) => s.id === id);
const isPicked = (s) => S.picks.some((p) => p.id === s.id);

/* ---------------- UI helpers ---------------- */

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function setBusy(msg) {
  S.busy = msg;
  const b = document.getElementById('busy');
  if (b) { b.textContent = msg || ''; b.hidden = !msg; }
}

async function saveFile(name, data) {
  const dl = await downloadsP;
  if (dl) {
    try { await dl.save({ filename: name, data }); toast(`Saved ${name}`); }
    catch (e) { if (e?.code !== 'declined') toast(`Couldn't save ${name}: ${e?.message || e?.code}`); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const fmtTime = (t) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'no timestamp');
const fmtClock = (t) => (t ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--');
const pct = (v) => Math.round(v * 100);
const LOOP = '<svg class="loop" viewBox="0 0 150 200" preserveAspectRatio="none" aria-hidden="true"><path d="M78 7 C 128 4, 146 46, 144 100 C 142 158, 118 195, 72 193 C 24 191, 6 150, 7 98 C 8 46, 32 9, 92 12"/></svg>';

function wireDrop(zone, onFiles) {
  const input = zone.querySelector('input');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { onFiles(filesFrom(input.files)); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); onFiles(filesFrom(e.dataTransfer.files)); });
}

/* ---------------- render ---------------- */

function canGo(id) {
  if (id === 'look' || id === 'brief') return true;
  return S.culled && S.picks.length > 0;
}

function renderSteps() {
  const idx = STEPS.findIndex((s) => s.id === S.step);
  $('#steps').innerHTML = STEPS.map((s, i) => `
    <button class="step ${i < idx ? 'done' : ''}" data-go="${s.id}" ${S.step === s.id ? 'aria-current="step"' : ''} ${canGo(s.id) ? '' : 'disabled'}>
      <b>${i + 1}</b><span>${s.label}</span></button>`).join('');
}

function go(id) {
  if (!canGo(id)) return;
  S.step = id;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function render() {
  renderSteps();
  const app = $('#app');
  ({ look: renderLook, brief: renderBrief, pick: renderPick, edit: renderEdit_, cover: renderCover })[S.step](app);
}

function weightsHTML(w) {
  const max = Math.max(...Object.values(w));
  return `<div class="wts">${FEATURES.map((f) => `
    <div class="wt"><span>${f.label}</span><div class="bar"><i style="width:${(w[f.key] / max) * 100}%"></i></div><span class="mono">${w[f.key].toFixed(2)}</span></div>`).join('')}</div>`;
}

function curveSVG(q) {
  const pts = q.map((v, i) => `${(i / 16) * 200},${100 - v}`).join(' ');
  return `<svg class="curve" viewBox="-4 -4 208 108" role="img" aria-label="Where your tones sit, from shadows to highlights">
    <rect x="0" y="0" width="200" height="100" fill="var(--surface-2)" rx="6"/>
    ${[25, 50, 75].map((y) => `<line x1="0" x2="200" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width=".6"/>`).join('')}
    <line x1="0" y1="100" x2="200" y2="0" stroke="var(--muted)" stroke-dasharray="3 3" stroke-width=".8"/>
    <polyline points="${pts}" fill="none" stroke="var(--marker)" stroke-width="2.4" stroke-linejoin="round"/>
    <circle cx="0" cy="${100 - q[0]}" r="3" fill="var(--marker)"/><circle cx="200" cy="${100 - q[16]}" r="3" fill="var(--marker)"/>
  </svg>`;
}

/* ---- step 1: your look ---- */

function renderLook(app) {
  const p = S.profile;
  const n = p?.n || 0;
  const st = profileStrength(n);
  app.innerHTML = `
  <section class="view">
    <div class="head">
      <div>
        <div class="eyebrow">Step 1 · Style profile</div>
        <h1>Teach Loupe <em>your look</em></h1>
        <p class="lede">Drop photos you've already edited and posted. Loupe learns your tones, color, contrast and framing, and uses them to pick and edit every new shoot. More photos make a sharper profile.</p>
      </div>
      <div class="row"><span id="busy" class="busy" hidden></span>
        <button class="btn primary" data-go="brief">Next: new shoot →</button></div>
    </div>
    <div class="grid2">
      <div class="panel">
        <label class="drop" id="refDrop" tabindex="0">
          <input type="file" accept="image/*" multiple>
          <strong>${S.refs.length && !S.sampleRefs ? 'Add more past edits' : 'Drop your past edits'}</strong>
          <span>JPEG, PNG or WebP · 20+ photos recommended · upload once, Loupe keeps your profile</span>
        </label>
        ${savedLine()}
        ${S.refs.length ? `<div class="row" style="justify-content:space-between;margin-top:16px">
            <span class="eyebrow">${S.refs.length} reference photo${S.refs.length > 1 ? 's' : ''} ${S.sampleRefs ? '<span class="sample-flag">SAMPLE</span>' : ''}</span>
            ${S.sampleRefs ? '' : S.confirmDelete ? `<span class="row"><span class="note">Delete all ${S.refs.length} photos from your profile? This can't be undone.</span>
                <button class="btn sm hot" data-act="deleteProfile">Delete</button><button class="btn sm" data-act="keepProfile">Keep</button></span>`
              : '<button class="btn sm ghost" data-act="askDelete">Delete profile</button>'}</div>
          <div class="mosaic">${S.refs.map((r) => `<figure><img src="${r.url}" alt="${esc(r.name)}" loading="lazy">
            ${S.sampleRefs ? '' : `<button class="rm" data-act="removeRef" data-id="${r.id}" aria-label="Remove ${esc(r.name)} from your profile">×</button>`}</figure>`).join('')}</div>`
          : `<div class="row" style="margin-top:14px"><button class="btn" data-act="sampleRefs">Use a sample profile</button></div>`}
      </div>
      <aside class="side">
        <div class="panel stack">
          <div class="row" style="justify-content:space-between"><h2>Your profile</h2><span class="chip ${n ? 'hot' : ''}">${st.tier}</span></div>
          <div class="meter" aria-label="Profile strength"><i style="width:${pct(st.value)}%"></i></div>
          <div class="note mono">${n} photo${n === 1 ? '' : 's'} · ${pct(st.value)}% confident</div>
          ${p ? `
            <div class="stack" style="gap:8px"><div class="eyebrow">Face look · used by Match my look</div>
              ${p.face ? `<div class="row"><i style="width:36px;height:36px;border-radius:50%;border:1px solid var(--line);background:rgb(${labToRgb(p.face.L, p.face.a, p.face.b).map((v) => v | 0).join(',')})"></i>
                <div class="note">${p.face.tex < 0.8 ? 'Heavily smoothed skin' : p.face.tex < 1.6 ? 'Smoothed skin' : 'Natural skin texture'} · ${p.face.b > 18 ? 'warm' : p.face.b < 10 ? 'cool' : 'neutral'} tone · learned from ${p.face.n} photo${p.face.n > 1 ? 's' : ''} with a face</div></div>`
              : '<p class="note">No faces found in your past edits yet. Match my look needs a few photos where your face is clearly visible.</p>'}</div>
            <div class="eyebrow">Overall style · used for picking</div>
            <div class="swatches">${p.palette.map((c) => `<i style="background:rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})"></i>`).join('')}</div>
            <div class="chips">${describeProfile(p).map((t) => `<span class="chip">${t}</span>`).join('')}</div>
            <div><div class="eyebrow" style="margin-bottom:6px">Tone curve</div>${curveSVG(p.q)}
              <div class="note">Pink is where your tones sit, dashed is a straight scan. Raised left end = lifted blacks.</div></div>
            <dl class="kv mono">
              <dt>Brightness</dt><dd>L* ${p.meanL.toFixed(0)}</dd>
              <dt>Contrast</dt><dd>σ ${p.stdL.toFixed(1)}</dd>
              <dt>Warmth</dt><dd>b* ${p.meanB >= 0 ? '+' : ''}${p.meanB.toFixed(1)}</dd>
              <dt>Saturation</dt><dd>C* ${p.chroma.toFixed(1)}</dd>
            </dl>` : '<p class="note">Add photos to see your palette, tone curve and color stats.</p>'}
        </div>
        <div class="panel stack">
          <div class="row" style="justify-content:space-between"><h2>Taste model</h2><span class="note mono">${S.duels} comparisons</span></div>
          ${weightsHTML(S.weights)}
          <p class="note">What Loupe weighs when picking. It retrains every time you play This or That on the Pick step.</p>
          ${S.duels ? '<button class="btn sm ghost" data-act="resetTaste">Reset taste</button>' : ''}
        </div>
      </aside>
    </div>
  </section>`;
  wireDrop($('#refDrop'), async (files) => {
    if (!files.length) return;
    if (S.sampleRefs) { S.refs = []; S.sampleRefs = false; }
    const room = MAX_REFS - S.refs.length;
    if (room <= 0) { toast(`Your profile already holds ${MAX_REFS} photos. Remove some to add new ones.`); return; }
    if (files.length > room) toast(`Only the first ${room} photos fit (a profile holds ${MAX_REFS}).`);
    const added = await ingestMany(files.slice(0, room).map((f) => ({ ...f, ref: true })), 'Reading');
    S.refs.push(...added);
    rebuildProfile();
    render();
    const saved = await persistRefs(added);
    if (saved) toast(`Saved ${saved} photo${saved > 1 ? 's' : ''} to your profile. ${S.vault.kind === 'account' ? "It'll be here next time, on any device." : "It'll be here next time you open Loupe in this browser."}`);
    if (S.culled) rescore();
    render();
  });
  setBusy(S.busy);
}

function savedLine() {
  if (S.booting) return '<p class="note" style="margin-top:14px">Loading your saved profile…</p>';
  if (S.sampleRefs) return '<p class="note" style="margin-top:14px">This is a sample profile and isn\'t saved. Drop your own past edits to replace it. You only need to do this once.</p>';
  if (!S.refs.length) return '';
  if (!S.vault) return '<p class="note" style="margin-top:14px">This browser blocks storage, so the profile lasts until you close the page.</p>';
  return `<p class="note" style="margin-top:14px">✓ Saved ${S.vault.kind === 'account' ? 'to your account. It loads automatically next time, on any device' : 'in this browser. It loads automatically next time'}. Only small thumbnails and measurements are kept, never the original files.</p>`;
}

/* ---- step 2: brief + upload ---- */

function renderBrief(app) {
  const d = parseDirection(S.brief);
  app.innerHTML = `
  <section class="view">
    <div class="head">
      <div>
        <div class="eyebrow">Step 2 · Brief + upload</div>
        ${S.profile && !S.sampleRefs ? `<div class="row" style="margin-bottom:10px"><span class="chip hot">✓ Your profile · ${S.profile.n} photos${S.vault ? ' · saved' : ''}</span><button class="btn sm ghost" data-go="look">Edit profile</button></div>` : ''}
        <h1>Drop the <em>whole shoot</em></h1>
        <p class="lede">Tell Loupe how many photos you want and the vibe. It groups the shoot into scenes by capture time and location, collapses bursts, and ranks every frame.</p>
      </div>
      <div class="row"><span id="busy" class="busy" hidden></span>
        <button class="btn hot" data-act="cull" ${S.shots.length ? '' : 'disabled'}>Cull ${S.shots.length || ''} frames →</button></div>
    </div>
    <div class="grid2">
      <div class="stack">
        <div class="panel brief">
          <label class="eyebrow" for="briefText">The brief</label>
          <textarea id="briefText" style="margin-top:8px" placeholder="e.g. 8 pics, warm film vibe, no closed eyes">${esc(S.brief)}</textarea>
          <div class="examples">${EXAMPLES.map((e) => `<button data-example="${esc(e)}">${esc(e)}</button>`).join('')}</div>
          <div class="row" style="margin-top:14px" id="parsed">${parsedChips(d)}</div>
        </div>
        <div class="panel">
          <label class="drop" id="shotDrop" tabindex="0">
            <input type="file" accept="image/*" multiple>
            <strong>Drop the shoot</strong>
            <span>Straight off the camera or phone. Original JPEGs keep the capture times Loupe uses to find scenes.</span>
          </label>
          ${S.shots.length ? `<div class="row" style="justify-content:space-between;margin-top:16px">
              <span class="eyebrow">${S.shots.length} frames loaded ${S.sampleShots ? '<span class="sample-flag">SAMPLE</span>' : ''}</span>
              <button class="btn sm ghost" data-act="clearShots">Clear</button></div>
            <div class="mosaic">${S.shots.map((s) => `<img src="${s.url}" alt="${esc(s.name)}" loading="lazy">`).join('')}</div>`
            : `<div class="row" style="margin-top:14px"><button class="btn" data-act="sampleShoot">Load the 16-frame sample shoot</button></div>`}
        </div>
      </div>
      <aside class="side">
        <div class="panel stack">
          ${S.sampleImages ? `<label class="row" style="font-weight:600"><input type="checkbox" id="useClaude" ${S.useClaude ? 'checked' : ''}> Let Claude judge faces and your taste</label>
            <p class="note">Claude sees small thumbnails of the shoot next to 3 of your past edits and rates each frame on how likely you'd post it, plus eyes, expression and angle. It asks permission the first time.</p>`
          : '<p class="note">Here, taste is estimated from how similar each frame is to your past posts. On the published page, Claude can also judge expressions and your taste from examples.</p>'}
          <h2>What happens next</h2>
          <dl class="kv">
            <dt class="mono">1</dt><dd style="text-align:left">Cluster by capture time and GPS into scenes</dd>
            <dt class="mono">2</dt><dd style="text-align:left">Embed every frame and merge near-duplicates into bursts</dd>
            <dt class="mono">3</dt><dd style="text-align:left">Score your taste, faces, sharpness, exposure, framing and color, weighted by what you've taught Loupe</dd>
            <dt class="mono">4</dt><dd style="text-align:left">Keep the best of each burst, then pick a varied set across scenes</dd>
          </dl>
        </div>
      </aside>
    </div>
  </section>`;
  $('#useClaude')?.addEventListener('change', (e) => (S.useClaude = e.target.checked));
  const ta = $('#briefText');
  ta.addEventListener('input', () => { S.brief = ta.value; $('#parsed').innerHTML = parsedChips(parseDirection(S.brief)); });
  wireDrop($('#shotDrop'), async (files) => {
    if (!files.length) return;
    if (S.sampleShots) { S.shots = []; S.sampleShots = false; }
    S.shots.push(...(await ingestMany(files, 'Analyzing')));
    S.culled = false;
    render();
  });
  setBusy(S.busy);
}

function parsedChips(d) {
  return `<span class="chip hot">${d.count ? `${d.count} picks` : '6 picks (default)'}</span>` +
    (d.tags.length ? d.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('') : '<span class="note">Add a vibe like warm, moody, film, bright, vivid or b&w.</span>');
}

/* ---- step 3: pick ---- */

function renderPick(app) {
  const bursts = new Set(S.shots.filter((s) => s.burstSize > 1).map((s) => s.burst)).size;
  const dups = S.shots.filter((s) => s.dupOf).length;
  const ins = byId(S.inspect);
  app.innerHTML = `
  <section class="view">
    <div class="head">
      <div>
        <div class="eyebrow">Step 3 · Contact sheet ${S.sampleShots ? '<span class="sample-flag">SAMPLE SHOOT</span>' : ''}</div>
        <h1><em>${S.picks.length}</em> picks from ${S.shots.length} frames</h1>
        <p class="lede">${S.scenes.length} scene${S.scenes.length > 1 ? 's' : ''} · ${bursts} burst${bursts === 1 ? '' : 's'} collapsed (${dups} near-duplicates set aside). Circled frames are picks. Tap a frame to see why. Tap ＋ / ✓ to override, and Loupe learns from every change.</p>
      </div>
      <div class="row"><span id="busy" class="busy" hidden></span>
        <button class="btn" data-act="duel">This or that</button>
        ${S.sampleImages ? (S.judging ? '<button class="btn" data-act="stopJudge">Stop Claude</button>' : `<button class="btn" data-act="faces">${S.shots.some((x) => x.judge) ? 'Re-judge' : 'Judge'} with Claude</button>`) : ''}
        <button class="btn hot" data-go="edit">Edit picks →</button></div>
    </div>
    <div class="grid2">
      <div>${S.scenes.map((sc, i) => sceneHTML(sc, i)).join('')}</div>
      <aside class="side">
        <div class="panel stack">
          <div class="row" style="justify-content:space-between;align-items:flex-end">
            <div class="count">${S.picks.length}<small> / ${S.target} asked</small></div>
            <div class="chips">${S.dir.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
          </div>
          <div class="picklist">${S.picks.map((p) => `
            <div class="pick"><img src="${p.url}" alt="">
              <div><div class="mono" style="font-size:12px">${esc(p.name)} · ${pct(p.score)}</div>
              <div class="chips">${reasonsFor(p, S.weights, S.profile).map((r) => `<span class="chip">${esc(r)}</span>`).join('')}</div></div></div>`).join('')}</div>
        </div>
        ${ins ? inspectorHTML(ins) : ''}
      </aside>
    </div>
  </section>`;
  setBusy(S.busy);
}

function sceneHTML(sc, i) {
  const t0 = sc[0].time, t1 = sc[sc.length - 1].time;
  const cam = sc.find((s) => s.exif.model)?.exif.model;
  return `<div class="scene">
    <div class="scene-h"><h2>Scene ${String.fromCharCode(65 + (i % 26))}</h2>
      <span class="mono note">${t0 ? `${fmtTime(t0)}${t1 && t1 - t0 > 60000 ? ' – ' + fmtClock(t1) : ''}` : 'grouped by look (no timestamps)'} · ${sc.length} frames${cam ? ' · ' + esc(cam) : ''}</span></div>
    <div class="strip"><div class="frames">${sc.map((s) => frameHTML(s)).join('')}</div></div>
  </div>`;
}

function frameHTML(s) {
  const picked = isPicked(s);
  const num = S.shots.indexOf(s) + 1;
  const dupOf = s.dupOf && byId(s.dupOf);
  const flags = [];
  if (s.eyes != null && s.eyes < 0.4) flags.push('<span class="tag amber">EYES SHUT</span>');
  else if (s.burstSize > 1 && !s.dupOf) flags.push(`<span class="tag amber">BEST ×${s.burstSize}</span>`);
  else if (dupOf) flags.push(`<span class="tag">DUP ${S.shots.indexOf(dupOf) + 1}</span>`);
  return `<div class="frame ${picked ? 'picked' : ''} ${s.dupOf ? 'dup' : ''} ${S.inspect === s.id ? 'inspect' : ''}">
    <button class="shot" data-act="inspect" data-id="${s.id}" style="border:0;padding:0;background:none;display:block;width:100%" aria-label="Inspect frame ${num}">
      <img src="${s.url}" alt="" loading="lazy"></button>
    ${flags.join('')}
    <button class="x" data-act="toggle" data-id="${s.id}" aria-label="${picked ? 'Remove from picks' : 'Add to picks'}" aria-pressed="${picked}">${picked ? '✓' : '＋'}</button>
    ${picked ? LOOP : ''}
    <div class="meta"><span>${num}${s.burstSize > 1 ? 'A' : ''}</span><span>${pct(s.score)}</span></div>
  </div>`;
}

function inspectorHTML(s) {
  const e = s.exif;
  const cam = [e.model, e.focal && `${Math.round(e.focal)}mm`, e.fnum && `f/${e.fnum.toFixed(1)}`, e.iso && `ISO ${e.iso}`].filter(Boolean).join(' · ');
  return `<div class="panel stack">
    <div class="row" style="justify-content:space-between"><h2>Frame ${S.shots.indexOf(s) + 1}</h2><span class="score">${pct(s.score)}<small> /100</small></span></div>
    <div class="note mono">${esc(s.name)} · ${fmtClock(s.time)}${cam ? '<br>' + esc(cam) : ''}</div>
    <div class="feat">${FEATURES.map((f) => `<div class="wt"><span>${f.label}</span><div class="bar"><i style="width:${pct(s.x[f.key])}%"></i></div><span class="mono">${pct(s.x[f.key])}</span></div>`).join('')}</div>
    ${s.judge ? `<p class="note">Claude: ${esc(s.judge.note || '')}</p>` : '<p class="note">Taste and face scores are estimates (similarity to your past posts, skin regions) until Claude judges this frame.</p>'}
    ${s.dupOf ? `<p class="note">Near-duplicate of frame ${S.shots.indexOf(byId(s.dupOf)) + 1}, which scored higher.</p>` : ''}
  </div>`;
}

function togglePick(id) {
  const s = byId(id);
  const added = !isPicked(s);
  const learned = learnFromOverride(S.weights, S.shots, S.picks, s, added);
  if (learned.pairs) {
    S.weights = learned.weights; S.duels += learned.pairs;
    saveTaste();
    toast(`Noted. Your taste model learned from ${learned.pairs} comparison${learned.pairs > 1 ? 's' : ''}.`);
  }
  if (!added) {
    S.locked.delete(id); S.banned.add(id);
  } else {
    S.banned.delete(id); S.locked.add(id);
    if (S.picks.length >= S.target) S.target++;
  }
  rescore();
  render();
}

/* ---- this or that ---- */

function openDuel() {
  const pair = nextPair(S.shots, S.seen, S.target);
  const layer = $('#layer');
  if (!pair) { layer.innerHTML = ''; toast('No close calls left to compare.'); render(); return; }
  const [a, b, key] = pair;
  layer.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="This or that">
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div><div class="eyebrow">Train your taste · ${S.duels} so far</div><h2 style="font-size:20px;margin-top:4px">Which one would you post?</h2></div>
        <button class="btn sm" data-act="closeDuel">Done</button></div>
      <div class="duel">
        <button data-win="a"><img src="${a.url}" alt="Option A"><span>A · ← key</span></button>
        <button data-win="b"><img src="${b.url}" alt="Option B"><span>B · → key</span></button>
      </div>
      <div class="row" style="justify-content:space-between">
        <span class="note">Loupe asks about the closest calls, where your answer teaches it the most.</span>
        <button class="btn sm ghost" data-act="skipDuel">Skip</button></div>
      ${weightsHTML(S.weights)}
    </div></div>`;
  const choose = (win) => {
    const [w, l] = win === 'a' ? [a, b] : [b, a];
    S.weights = updateWeights(S.weights, w.x, l.x);
    S.duels++; S.seen.add(key);
    saveTaste();
    rescore();
    openDuel();
  };
  layer.querySelectorAll('[data-win]').forEach((btn) => btn.addEventListener('click', () => choose(btn.dataset.win)));
  layer.querySelector('[data-act="skipDuel"]').addEventListener('click', () => { S.seen.add(key); openDuel(); });
  layer.querySelector('[data-act="closeDuel"]').addEventListener('click', closeDuel);
  duelKeys = (e) => { if (e.key === 'ArrowLeft') choose('a'); else if (e.key === 'ArrowRight') choose('b'); else if (e.key === 'Escape') closeDuel(); };
}
let duelKeys = null;
document.addEventListener('keydown', (e) => { if (duelKeys && $('#layer .modal')) duelKeys(e); });
function closeDuel() { $('#layer').innerHTML = ''; duelKeys = null; render(); }

/* ---- Claude judge: faces + taste, shown the creator's own posts as examples ---- */

const spread = (arr, k) => (arr.length <= k ? arr : Array.from({ length: k }, (_, i) => arr[Math.floor((i * arr.length) / k)]));
const clamp01 = (v) => Math.max(0, Math.min(1, +v || 0));

function judgePrompt(nRefs, n) {
  return `You are culling a photo shoot for a content creator.
${nRefs ? `Images 1 to ${nRefs} are photos this creator already edited and posted. Study them for the creator's taste: subjects, poses, angles, expressions, framing and mood.
Images ${nRefs + 1} to ${nRefs + n} are candidates from a new shoot. Call them photo 1 to ${n}.` : `The ${n} images are candidates from a new shoot, photo 1 to ${n}.`}
The creator's brief: "${S.brief.replace(/"/g, "'")}"
Return a JSON array with one object per candidate, in order:
{"photo": number, "person": boolean, "eyes_open": 0-1, "expression": 0-1, "angle": 0-1, "taste": 0-1, "faces": [[x0, y0, x1, y1]], "note": string}
taste: how likely this creator would pick this frame to post, judged against their posted examples and the brief.
Be strict: blinks, half-closed eyes, awkward mid-expressions, motion blur, unflattering angles and cut-off heads score low. Rank near-duplicates against each other honestly.
faces: a box around each visible face (forehead to chin) as fractions of image width and height, 0 to 1. Empty array if none.
note: at most 8 words on the deciding reason.
Output only the JSON array.`;
}

const validBoxes = (arr) => (Array.isArray(arr) ? arr : [])
  .filter((b) => Array.isArray(b) && b.length === 4 && b.every((v) => v >= 0 && v <= 1) && b[2] > b[0] && b[3] > b[1]);

// Measure how faces were retouched in the past edits, using Claude's face boxes on the full-size originals.
async function findRefFaces(signal) {
  const todo = S.refs.filter((r) => !r.faceChecked);
  if (!todo.length) return;
  const per = Math.max(1, Math.min(S.sampleImages.maxCount || 8, 16));
  for (let i = 0; i < todo.length && !signal.aborted; i += per) {
    const batch = todo.slice(i, i + per);
    setBusy(`Claude is finding faces in your past edits (${i}/${todo.length})…`);
    const res = await S.sample.json(`These ${batch.length} photos are numbered 1 to ${batch.length}. For each, return {"photo": number, "faces": [[x0, y0, x1, y1]]}: a box around each visible face (forehead to chin) as fractions of image width and height, 0 to 1. Empty array if there is no face. Output only the JSON array.`,
      { images: batch.map((r) => r.thumb), modelTier: 'default', signal });
    for (const [j, r] of (Array.isArray(res) ? res : []).entries()) {
      const ref = batch[(r.photo | 0) - 1] || batch[j];
      if (!ref) continue;
      ref.faceChecked = true;
      const boxes = validBoxes(r.faces);
      if (!boxes.length) { ref.skin = null; if (ref.stored) S.vault?.putRef(serializeRef(ref)).catch(() => {}); continue; }
      const bmp = await decode(ref.blob || ref.thumb);
      ref.skin = skinStats(bmp, mainFace(boxes));
      if (bmp.close) bmp.close();
      if (ref.stored) S.vault?.putRef(serializeRef(ref)).catch(() => {});
    }
  }
  rebuildProfile();
}

function applyJudgments(batch, res) {
  (Array.isArray(res) ? res : []).forEach((r, i) => {
    const s = batch[(r.photo | 0) - 1] || batch[i];
    if (!s) return;
    const boxes = validBoxes(r.faces);
    const eyes = clamp01(r.eyes_open), ex = clamp01(r.expression), an = clamp01(r.angle);
    s.judge = { taste: clamp01(r.taste), note: String(r.note || '').slice(0, 70) };
    s.face = r.person === false ? { score: 0.5, eyes: 1, boxes: [] } : { score: 0.4 * eyes + 0.35 * ex + 0.25 * an, eyes, boxes };
  });
}

async function judgeWithClaude() {
  if (!S.sample || !S.sampleImages || S.judging) return;
  const per = Math.max(4, Math.min(S.sampleImages.maxCount || 8, 16));
  const refs = spread(S.refs, Math.min(3, per - 3));
  const perBatch = per - refs.length;
  // judge everything that could make the cut, with whole bursts so a blink can lose to its sibling
  const ranked = S.shots.filter((s) => !s.dupOf).sort((a, b) => b.score - a.score);
  const bursts = new Set(ranked.slice(0, Math.max(24, S.target * 3)).map((s) => s.burst));
  const pool = S.shots.filter((s) => bursts.has(s.burst)).slice(0, 72);
  const ctrl = new AbortController();
  S.judging = ctrl;
  render();
  let done = 0, failed = null;
  try { await findRefFaces(ctrl.signal); } catch (e) { failed = e; }
  for (let i = 0; i < pool.length && !ctrl.signal.aborted && !failed; i += perBatch) {
    const batch = pool.slice(i, i + perBatch);
    setBusy(`Claude has judged ${done} of ${pool.length} frames…`);
    try {
      const res = await S.sample.json(judgePrompt(refs.length, batch.length), {
        images: [...refs.map((r) => r.thumb), ...batch.map((b) => b.thumb)], modelTier: 'default', signal: ctrl.signal,
      });
      applyJudgments(batch, res);
      done += batch.length;
      rescore();
    } catch (e) { failed = e; break; }
  }
  S.judging = null;
  S.editedCache = {}; // face boxes may have changed
  setBusy(null);
  if (failed && !ctrl.signal.aborted) toast(failed.code === 'not_granted' ? 'Claude access was declined, so picks use local scores only.' : `Claude couldn't finish judging: ${failed.message || failed.code}`);
  else if (done) toast(`Claude judged ${done} frames against your past posts. Picks updated.`);
  rescore();
  render();
}

/* ---- step 4: edit ---- */

const adjFor = (id) => (S.adj[id] ||= defaultAdjust());

// best available face boxes: landmark detector, then Claude, then the skin-color guess
const facesOf = (s) => {
  if (s.faces?.length) return s.faces.map((f) => f.box);
  if (s.face?.boxes) return s.face.boxes;
  if (s.faces === null && s.feat.faceBox) return [s.feat.faceBox];
  return [];
};

function faceFor(s, src) {
  const boxes = facesOf(s);
  const key = JSON.stringify(boxes);
  if (s.faceKey !== key) { s.faceKey = key; s.faceStats = boxes.length ? skinStats(src, mainFace(boxes)) : null; }
  return { boxes, stats: s.faceStats, plan: facePlan(S.profile?.face, s.faceStats, adjFor(s.id)) };
}
const previewCache = new Map();

async function previewSource(s, side = 1200) {
  const key = s.id + ':' + side;
  if (previewCache.has(key)) return previewCache.get(key);
  const bmp = await decode(s.blob);
  const c = scaledCanvas(bmp, side);
  if (bmp.close) bmp.close();
  if (previewCache.size > 6) previewCache.delete(previewCache.keys().next().value);
  previewCache.set(key, c);
  return c;
}

let editTimer = 0, lastAfter = null, lastBefore = null, lastFaces = [];

function faceStatus(face) {
  if (!face.boxes.length) return 'No face found in this photo, so Match my look leaves it unchanged.' + (S.sampleImages ? ' Judging with Claude finds faces more reliably.' : '');
  if (!S.profile?.face) return 'Face found, but none of your past edits had a detectable face yet. Add a few where your face is visible.';
  if (!face.stats) return 'Face found, but too little visible skin to measure.';
  const p = face.plan, sg = (v) => (v >= 0 ? '+' : '') + v.toFixed(1);
  return `Face: brightness ${sg(p.dL)} · warmth ${sg(p.db)} · rosiness ${sg(p.da)} · ${Math.round(p.smooth * 100)}% smoothing, matched to ${S.profile.face.n} past edit${S.profile.face.n > 1 ? 's' : ''}.`;
}

function renderEdit_(app) {
  if (!S.active || !isPicked(byId(S.active))) S.active = S.picks[0]?.id;
  const s = byId(S.active);
  const a = adjFor(s.id);
  app.innerHTML = `
  <section class="view">
    <div class="head">
      <div>
        <div class="eyebrow">Step 4 · Auto-edit</div>
        <h1>Faces edited to <em>your look</em></h1>
        <p class="lede">Match my look only touches faces: skin brightness, color and smoothness move toward how you retouched your past photos. The rest of each photo keeps its original tone unless you change it with the sliders. Drag the divider to compare.</p>
      </div>
      <div class="row"><span id="busy" class="busy" hidden></span>
        <button class="btn" data-act="exportAll">Export all</button>
        <button class="btn hot" data-go="cover">Pick covers →</button></div>
    </div>
    <div class="editor">
      <div class="reel">${S.picks.map((p) => `<button data-act="active" data-id="${p.id}" aria-pressed="${p.id === s.id}"><img src="${p.url}" alt="${esc(p.name)}"></button>`).join('')}</div>
      <div class="stage"><span class="lbl" style="left:24px">BEFORE</span><span class="lbl" style="right:24px">AFTER</span>
        <div class="compare" id="compare"><canvas id="view" width="10" height="10"></canvas></div></div>
      <div class="panel stack">
        <div class="row" style="justify-content:space-between"><h2>${esc(s.name)}</h2><span class="note mono">${S.profile ? `profile · ${S.profile.n} refs` : 'no profile yet'}</span></div>
        <p class="note" id="faceStatus">Reading the face…</p>
        <label class="row" style="font-size:13px;font-weight:600"><input type="checkbox" id="showFaces" ${S.showFaces ? 'checked' : ''}> Outline detected faces</label>
        <div class="sliders">${ADJUST.map((d) => `
          <div class="slider ${d.key === 'match' ? 'key' : ''}"><label for="adj-${d.key}">${d.label}<span id="v-${d.key}">${fmtAdj(d, a[d.key])}</span></label>
          <input type="range" id="adj-${d.key}" data-adj="${d.key}" min="${d.min}" max="${d.max}" step="${d.step}" value="${a[d.key]}"></div>`).join('')}
          <label class="row" style="font-size:13px;font-weight:600"><input type="checkbox" id="adj-mono" ${a.mono ? 'checked' : ''}> Black & white</label>
        </div>
        <div class="row">
          <button class="btn sm" data-act="resetAdj">Reset</button>
          <button class="btn sm" data-act="applyAll">Apply to all picks</button>
        </div>
        <div class="row">
          <button class="btn sm primary" data-act="exportOne">Export this photo</button>
        </div>
      </div>
    </div>
  </section>`;
  app.querySelectorAll('[data-adj]').forEach((inp) => inp.addEventListener('input', () => {
    const d = ADJUST.find((x) => x.key === inp.dataset.adj);
    a[d.key] = +inp.value;
    $('#v-' + d.key).textContent = fmtAdj(d, a[d.key]);
    delete S.editedCache[s.id];
    scheduleEdit(s);
  }));
  $('#showFaces').addEventListener('change', (e) => { S.showFaces = e.target.checked; compose(); });
  $('#adj-mono').addEventListener('change', (e) => { a.mono = e.target.checked ? 1 : 0; delete S.editedCache[s.id]; scheduleEdit(s); });
  wireCompare();
  setBusy(S.busy);
  scheduleEdit(s, 0);
}

function fmtAdj(d, v) {
  if (d.min === 0) return `${Math.round(v * 100)}%`;
  return `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
}

function scheduleEdit(s, delay = 70) {
  clearTimeout(editTimer);
  editTimer = setTimeout(async () => {
    const src = await previewSource(s, 1100);
    if (S.step !== 'edit' || S.active !== s.id) return;
    lastBefore = src;
    const face = faceFor(s, src);
    lastAfter = renderEdit(src, adjFor(s.id), face);
    lastFaces = face.boxes;
    const st = $('#faceStatus');
    if (st) st.textContent = faceStatus(face);
    compose();
  }, delay);
}

function compose() {
  const v = $('#view');
  if (!v || !lastAfter) return;
  const w = lastAfter.width, h = lastAfter.height;
  if (v.width !== w || v.height !== h) { v.width = w; v.height = h; }
  const ctx = v.getContext('2d');
  const x = Math.round(w * S.split);
  ctx.drawImage(lastAfter, 0, 0);
  ctx.drawImage(lastBefore, 0, 0, x, h, 0, 0, x, h);
  if (S.showFaces) {
    ctx.save(); ctx.strokeStyle = '#ffbf2e'; ctx.lineWidth = Math.max(2, w / 300); ctx.setLineDash([8, 6]);
    for (const b of lastFaces) ctx.strokeRect(b[0] * w, b[1] * h, (b[2] - b[0]) * w, (b[3] - b[1]) * h);
    ctx.restore();
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - 1, 0, 2, h);
  ctx.beginPath(); ctx.arc(x, h / 2, Math.max(12, w * 0.022), 0, 7); ctx.fill();
  const r = Math.max(12, w * 0.022) * 0.45, cy = h / 2;
  ctx.fillStyle = '#111';
  for (const dir of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(x + dir * r * 1.2, cy); ctx.lineTo(x + dir * r * 0.25, cy - r * 0.8); ctx.lineTo(x + dir * r * 0.25, cy + r * 0.8); ctx.fill();
  }
}

function wireCompare() {
  const el = $('#compare');
  let drag = false;
  const move = (e) => {
    const r = $('#view').getBoundingClientRect();
    S.split = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    compose();
  };
  el.addEventListener('pointerdown', (e) => { drag = true; el.setPointerCapture(e.pointerId); move(e); });
  el.addEventListener('pointermove', (e) => drag && move(e));
  el.addEventListener('pointerup', () => (drag = false));
}

async function fullRender(s, side = 4096) {
  const bmp = await decode(s.blob);
  const c = scaledCanvas(bmp, side);
  if (bmp.close) bmp.close();
  return renderEdit(c, adjFor(s.id), faceFor(s, c));
}

const outName = (s, suffix = 'loupe') => s.name.replace(/\.[^.]+$/, '') + `-${suffix}.jpg`;

async function exportOne(s) {
  setBusy('Rendering full size…');
  const blob = await canvasBlob(await fullRender(s), 'image/jpeg', 0.93);
  setBusy(null);
  await saveFile(outName(s), blob);
}

async function exportAll() {
  if (!window.JSZip) { for (const s of S.picks) await exportOne(s); return; }
  const zip = new window.JSZip();
  for (let i = 0; i < S.picks.length; i++) {
    const s = S.picks[i];
    setBusy(`Rendering ${i + 1}/${S.picks.length}…`);
    zip.file(outName(s), await canvasBlob(await fullRender(s), 'image/jpeg', 0.93));
  }
  setBusy('Zipping…');
  const blob = await zip.generateAsync({ type: 'blob' });
  setBusy(null);
  await saveFile(`loupe-picks-${S.picks.length}.zip`, blob);
}

/* ---- step 5: covers ---- */

async function editedVersion(s) {
  if (S.editedCache[s.id]) return S.editedCache[s.id];
  const src = await previewSource(s, 720);
  const c = renderEdit(src, adjFor(s.id), faceFor(s, src));
  const feat = analyzeCanvas(scaledCanvas(c, 400));
  return (S.editedCache[s.id] = { canvas: c, feat });
}

async function renderCover(app) {
  app.innerHTML = `<section class="view"><div class="head"><div><div class="eyebrow">Step 5 · Cover</div>
    <h1>Finding your <em>covers</em></h1></div><span class="busy">Scoring edited picks for each platform…</span></div></section>`;
  const items = [];
  for (const s of S.picks) {
    const e = await editedVersion(s);
    items.push({ id: s.id, s, feat: e.feat, canvas: e.canvas, score: s.score, x: s.x, faceBox: mainFace(facesOf(s)), origW: s.origW });
  }
  if (S.step !== 'cover') return;
  const sim = (it) => (S.profile ? styleMatch(it.feat, S.profile) : 0.5);
  const ranked = PLATFORMS.map((p) => ({ p, list: rankCovers(items, p, sim) }));
  app.innerHTML = `
  <section class="view">
    <div class="head">
      <div>
        <div class="eyebrow">Step 5 · Cover</div>
        <h1>Your <em>covers</em>, per platform</h1>
        <p class="lede">Every edited pick is reframed for each app on its own: Loupe moves and zooms the crop so the eyes, face size and title space land where that feed wants them, clear of the app's buttons and captions. Then it ranks the picks on what that feed rewards.</p>
      </div>
      <div class="row"><span id="busy" class="busy" hidden></span>
        <label class="row" style="font-size:13px;font-weight:600"><input type="checkbox" id="safeToggle" ${S.safe ? 'checked' : ''}> Show app UI zones</label></div>
    </div>
    <div class="platforms ${S.safe ? '' : 'safe-off'}" id="plats">${ranked.map(({ p, list }) => coverCardHTML(p, list)).join('')}</div>
    <p class="note" style="margin-top:20px;max-width:75ch">Ranking weights start from public creator guidance for each platform. Once your accounts are connected, they're retrained on the views your own covers actually got.</p>
  </section>`;
  ranked.forEach(({ p, list }) => drawCover(p, list[S.coverChoice[p.id] || 0]));
  $('#safeToggle').addEventListener('change', (e) => { S.safe = e.target.checked; $('#plats').classList.toggle('safe-off', !S.safe); });
  app.querySelectorAll('[data-alt]').forEach((b) => b.addEventListener('click', () => {
    S.coverChoice[b.dataset.plat] = +b.dataset.alt;
    renderCover(app);
  }));
  app.querySelectorAll('[data-export-cover]').forEach((b) => b.addEventListener('click', () => {
    const { p, list } = ranked.find((r) => r.p.id === b.dataset.exportCover);
    exportCover(p, list[S.coverChoice[p.id] || 0]);
  }));
  setBusy(S.busy);
}

function coverCardHTML(p, list) {
  const i = S.coverChoice[p.id] || 0;
  const r = list[i];
  const ar = `${p.ratio[0]} / ${p.ratio[1]}`;
  const zones = p.safe.top + p.safe.bottom + p.safe.left + p.safe.right > 0.1 ? `
    <div class="zone" style="left:0;right:0;top:0;height:${p.safe.top * 100}%"></div>
    <div class="zone" style="left:0;right:0;bottom:0;height:${p.safe.bottom * 100}%"></div>
    <div class="zone" style="right:0;top:${p.safe.top * 100}%;bottom:${p.safe.bottom * 100}%;width:${p.safe.right * 100}%"></div>
    <div class="uirail"><i></i><i></i><i></i><i></i></div>
    <div class="uicap"><i></i><i></i></div>` : '';
  return `<article class="pcard">
    <header><h2>${p.name}</h2><span class="surface">${p.surface} · ${p.ratio.join(':')}</span></header>
    <div class="phone" style="aspect-ratio:${ar}"><canvas id="cv-${p.id}" width="${p.ratio[0] * 60}" height="${p.ratio[1] * 60}"></canvas><div class="ui">${zones}</div></div>
    ${p.id === 'xhs' ? '<div class="xhs-title" aria-hidden="true"><i style="width:90%"></i><i style="width:55%"></i></div>' : ''}
    <div class="row" style="justify-content:space-between;align-items:flex-end">
      <div class="score">${pct(r.score)}<small> /100</small></div>
      ${i === 0 ? '<span class="pinned">top pick</span>' : `<span class="note mono">#${i + 1} of ${list.length}</span>`}
    </div>
    <div class="note mono">${esc(r.note)}</div>
    <div class="chips">${r.top.map((k) => `<span class="chip">${FACTOR_COPY[k][0]}</span>`).join('')}</div>
    ${r.m[r.weak] < 0.45 && p.w[r.weak] >= 0.7 ? `<p class="why meh">Watch out: ${FACTOR_COPY[r.weak][1]}.</p>` : ''}
    <p class="why"><b>Framing rule:</b> ${p.frame.rule}. ${p.why}</p>
    <div class="alts">${list.slice(0, 5).map((x, j) => `<button data-alt="${j}" data-plat="${p.id}" aria-pressed="${i === j}" aria-label="Option ${j + 1}"><img src="${x.it.s.url}" alt=""></button>`).join('')}</div>
    <button class="btn sm primary" data-export-cover="${p.id}">Export ${p.ratio.join(':')} cover</button>
  </article>`;
}

function drawCover(p, r) {
  const cv = document.getElementById('cv-' + p.id);
  if (!cv) return;
  const src = r.it.canvas, c = r.crop;
  cv.getContext('2d').drawImage(src, c.x * src.width, c.y * src.height, c.w * src.width, c.h * src.height, 0, 0, cv.width, cv.height);
}

async function exportCover(p, r) {
  setBusy('Rendering cover…');
  const full = await fullRender(r.it.s, 2600);
  const W = 1080, H = Math.round((1080 * p.ratio[1]) / p.ratio[0]);
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const c = r.crop, ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, c.x * full.width, c.y * full.height, c.w * full.width, c.h * full.height, 0, 0, W, H);
  setBusy(null);
  await saveFile(outName(r.it.s, `${p.id}-cover`), await canvasBlob(out, 'image/jpeg', 0.94));
}

/* ---------------- actions ---------------- */

document.addEventListener('click', async (e) => {
  const goBtn = e.target.closest('[data-go]');
  if (goBtn) { go(goBtn.dataset.go); return; }
  const ex = e.target.closest('[data-example]');
  if (ex) { S.brief = ex.dataset.example; $('#briefText').value = S.brief; $('#parsed').innerHTML = parsedChips(parseDirection(S.brief)); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.act) {
    case 'sampleRefs': await loadSampleRefs(); render(); break;
    case 'askDelete': S.confirmDelete = true; render(); break;
    case 'keepProfile': S.confirmDelete = false; render(); break;
    case 'deleteProfile':
      S.confirmDelete = false;
      setBusy('Deleting your profile…');
      try { await S.vault?.clear(); } catch (e) { toast("Couldn't delete everything. Try again."); }
      setBusy(null);
      S.refs = []; S.sampleRefs = false;
      rebuildProfile(); if (S.culled) rescore(); render();
      toast('Profile deleted.');
      break;
    case 'removeRef': {
      const ref = S.refs.find((r) => r.id === id);
      try { await S.vault?.delRef(id); } catch (e) { toast(`Couldn't remove ${ref?.name}.`); break; }
      S.refs = S.refs.filter((r) => r.id !== id);
      rebuildProfile(); if (S.culled) rescore(); render();
      break;
    }
    case 'resetTaste': S.weights = { ...DEFAULT_WEIGHTS }; S.duels = 0; saveTaste(); if (S.culled) rescore(); render(); break;
    case 'sampleShoot': await loadSampleShoot(); render(); break;
    case 'clearShots': S.shots = []; S.sampleShots = false; S.culled = false; S.picks = []; render(); break;
    case 'cull': cull(); go('pick'); if (S.useClaude && S.sampleImages) judgeWithClaude(); break;
    case 'inspect': S.inspect = id; render(); break;
    case 'toggle': togglePick(id); break;
    case 'duel': openDuel(); break;
    case 'faces': judgeWithClaude(); break;
    case 'stopJudge': S.judging?.abort(); break;
    case 'active': S.active = id; render(); break;
    case 'resetAdj': S.adj[S.active] = defaultAdjust(); delete S.editedCache[S.active]; render(); break;
    case 'applyAll': {
      const a = adjFor(S.active);
      S.picks.forEach((p) => { S.adj[p.id] = { ...a }; delete S.editedCache[p.id]; });
      toast(`Applied to ${S.picks.length} picks`); break;
    }
    case 'exportOne': exportOne(byId(S.active)); break;
    case 'exportAll': exportAll(); break;
  }
});

async function loadSampleRefs() {
  const refs = await ingestMany(await sampleReferences(), 'Reading sample');
  S.refs = refs; S.sampleRefs = true;
  rebuildProfile();
}

async function loadSampleShoot() {
  S.shots = await ingestMany(await sampleShoot(), 'Analyzing sample');
  S.sampleShots = true; S.culled = false;
}

/* ---------------- boot ---------------- */

(async function boot() {
  render();
  S.vault = await openVault(capability);
  let stored = [], taste = null;
  try { stored = (await S.vault?.loadRefs()) || []; taste = await S.vault?.loadTaste(); } catch (e) { /* start fresh */ }
  if (taste?.weights) { S.weights = { ...DEFAULT_WEIGHTS, ...taste.weights }; S.duels = taste.duels || 0; }
  S.booting = false;
  if (stored.length) {
    // returning creator: profile is ready, go straight to the new shoot
    S.refs = stored.sort((a, b) => a.addedAt - b.addedAt).map(hydrateRef);
    rebuildProfile();
    S.step = 'brief';
    render();
    return;
  }
  // first visit: open in a working state with a sample profile + sample shoot, already culled
  await loadSampleRefs();
  await loadSampleShoot();
  cull();
  S.step = 'pick';
  render();
})();
