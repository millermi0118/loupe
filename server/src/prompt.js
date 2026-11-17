// The selection prompt and how its answer is read. Claude sees every candidate image in one
// request and chooses the picks itself. Local metadata (capture time, scene, burst, simple
// technical flags) is passed as hints only. The judging rules are carried over from the
// original prompt (app/js/app.js judgePrompt) so per-photo scores keep their meaning.

const pad = (n) => String(n).padStart(2, '0');
const clock = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? null : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
const sceneName = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
const FLAG_TEXT = { blurry: 'looks blurry', dark: 'looks underexposed', bright: 'looks overexposed', eyes_closed: 'eyes may be closed', no_face: 'no face detected' };

function metaLine(n, m) {
  if (!m) return `photo ${n}: no metadata`;
  const parts = [];
  const t = m.takenAt && clock(m.takenAt);
  if (t) parts.push(`taken ${t}`);
  if (m.width && m.height) parts.push(`${m.width}x${m.height}`);
  if (m.scene != null) parts.push(`scene ${sceneName(m.scene)}`);
  if (m.burst != null && m.burstSize > 1) parts.push(`burst #${m.burst} (${m.burstSize} near-identical frames)`);
  if (m.flags?.length) parts.push(`local checks: ${m.flags.map((f) => FLAG_TEXT[f]).join(', ')}`);
  return `photo ${n}: ${parts.join('; ') || 'no metadata'}`;
}

export function selectPrompt({ nRefs, n, target, brief, styleTags = [], metas = [] }) {
  return `You are culling a photo shoot for a content creator and choosing which photos they should post.
${nRefs ? `Images 1 to ${nRefs} are photos this creator already edited and posted. Study them for the creator's taste: subjects, poses, angles, expressions, framing and mood.
Images ${nRefs + 1} to ${nRefs + n} are candidates from a new shoot. Call them photo 1 to ${n}.` : `The ${n} images are candidates from a new shoot, photo 1 to ${n}.`}
The creator's brief: "${brief.replace(/"/g, "'")}"${styleTags.length ? `\nTheir usual editing style: ${styleTags.join(', ')}.` : ''}

Choose the ${target} best photos to post.
Judge from what you see in each image. The notes below come from simple automatic checks and capture data; use them as hints, and trust the image when they disagree.
${metas.map((m, i) => metaLine(i + 1, m)).join('\n')}

Rules:
- Be strict: blinks, half-closed eyes, awkward mid-expressions, motion blur, unflattering angles and cut-off heads score low.
- Frames in the same burst are near-duplicates: compare them honestly and pick at most one unless they show clearly different moments.
- When quality is close, prefer variety across scenes, poses and framing.
- Match the brief and the creator's posted examples.

For every candidate, rate:
person: whether a person is the subject. eyes_open, expression, angle: 0-1. taste: 0-1, how likely this creator would post it.
faces: a box around each visible face (forehead to chin) as fractions of image width and height, 0 to 1. Empty array if none.
note: at most 8 words on the deciding reason.
ranking: every candidate's photo number, best first.
selected: exactly ${target} photos in ranked order, each with a reason of at most 15 words naming what you saw.`;
}

// Structured outputs schema. Numeric ranges aren't expressible here, so they're enforced below.
export const SELECT_SCHEMA = {
  type: 'object',
  properties: {
    photos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          photo: { type: 'integer' },
          person: { type: 'boolean' },
          eyes_open: { type: 'number' },
          expression: { type: 'number' },
          angle: { type: 'number' },
          taste: { type: 'number' },
          faces: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
          note: { type: 'string' },
        },
        required: ['photo', 'person', 'eyes_open', 'expression', 'angle', 'taste', 'faces', 'note'],
        additionalProperties: false,
      },
    },
    ranking: { type: 'array', items: { type: 'integer' } },
    selected: {
      type: 'array',
      items: {
        type: 'object',
        properties: { photo: { type: 'integer' }, reason: { type: 'string' } },
        required: ['photo', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['photos', 'ranking', 'selected'],
  additionalProperties: false,
};

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(+v) ? +v : 0));
const round3 = (v) => Math.round(v * 1000) / 1000;
const cleanText = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

// Same rule as the browser's validBoxes(): four fractions, positive width and height.
export const validBoxes = (arr) => (Array.isArray(arr) ? arr : [])
  .filter((b) => Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && v >= 0 && v <= 1) && b[2] > b[0] && b[3] > b[1])
  .slice(0, 12);

// Model output -> per-candidate scores, a full ranking and the selection, all keyed by the
// client's ids. Invalid or repeated photo numbers are dropped; a short selection is filled
// from the ranking so the creator always gets the count they asked for.
export function normalizeSelection(parsed, candidateIds, target) {
  const n = candidateIds.length;
  const ok = (x) => Number.isInteger(x) && x >= 1 && x <= n;

  const seen = new Set(), results = [];
  for (const r of Array.isArray(parsed?.photos) ? parsed.photos : []) {
    if (!r || typeof r !== 'object' || !ok(r.photo) || seen.has(r.photo)) continue;
    seen.add(r.photo);
    results.push({
      id: candidateIds[r.photo - 1],
      person: r.person !== false,
      eyes_open: round3(clamp01(r.eyes_open)),
      expression: round3(clamp01(r.expression)),
      angle: round3(clamp01(r.angle)),
      taste: round3(clamp01(r.taste)),
      faces: validBoxes(r.faces),
      note: cleanText(r.note, 70),
    });
  }
  const taste = new Map(results.map((r) => [r.id, r.taste]));

  const rankNums = [];
  for (const x of Array.isArray(parsed?.ranking) ? parsed.ranking : []) if (ok(x) && !rankNums.includes(x)) rankNums.push(x);
  const unranked = candidateIds.map((_, i) => i + 1).filter((x) => !rankNums.includes(x))
    .sort((a, b) => (taste.get(candidateIds[b - 1]) ?? -1) - (taste.get(candidateIds[a - 1]) ?? -1));
  const ranking = [...rankNums, ...unranked].map((x) => candidateIds[x - 1]);

  const want = Math.min(target, n);
  const selected = [];
  for (const s of Array.isArray(parsed?.selected) ? parsed.selected : []) {
    if (!s || !ok(s.photo) || selected.some((x) => x.id === candidateIds[s.photo - 1]) || selected.length >= want) continue;
    selected.push({ id: candidateIds[s.photo - 1], reason: cleanText(s.reason, 120), byClaude: true });
  }
  const filled = selected.length < want;
  for (const id of ranking) {
    if (selected.length >= want) break;
    if (!selected.some((x) => x.id === id)) selected.push({ id, reason: '', byClaude: false });
  }
  selected.forEach((s, i) => (s.rank = i + 1));

  return { selected, ranking, results, missing: candidateIds.filter((_, i) => !seen.has(i + 1)), filledFromRanking: filled };
}
