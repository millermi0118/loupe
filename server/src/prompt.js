// The judging prompt and how its answer is read. Kept as close as possible to the
// prompt the browser used with the artifact's sample capability (app/js/app.js judgePrompt),
// so taste and face scores mean the same thing. Differences: the answer is a JSON object
// with a "photos" array (structured outputs need an object at the top), and photo numbers
// are mapped back to the client's ids here on the server.

export function judgePrompt(nRefs, n, brief) {
  return `You are culling a photo shoot for a content creator.
${nRefs ? `Images 1 to ${nRefs} are photos this creator already edited and posted. Study them for the creator's taste: subjects, poses, angles, expressions, framing and mood.
Images ${nRefs + 1} to ${nRefs + n} are candidates from a new shoot. Call them photo 1 to ${n}.` : `The ${n} images are candidates from a new shoot, photo 1 to ${n}.`}
The creator's brief: "${brief.replace(/"/g, "'")}"
Return a JSON object {"photos": [...]} with one object per candidate, in order:
{"photo": number, "person": boolean, "eyes_open": 0-1, "expression": 0-1, "angle": 0-1, "taste": 0-1, "faces": [[x0, y0, x1, y1]], "note": string}
taste: how likely this creator would pick this frame to post, judged against their posted examples and the brief.
Be strict: blinks, half-closed eyes, awkward mid-expressions, motion blur, unflattering angles and cut-off heads score low. Rank near-duplicates against each other honestly.
faces: a box around each visible face (forehead to chin) as fractions of image width and height, 0 to 1. Empty array if none.
note: at most 8 words on the deciding reason.`;
}

// Structured outputs schema. Numeric ranges aren't expressible here, so they're enforced in normalize().
export const JUDGE_SCHEMA = {
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
  },
  required: ['photos'],
  additionalProperties: false,
};

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(+v) ? +v : 0));
const round3 = (v) => Math.round(v * 1000) / 1000;

// Same rule as the browser's validBoxes(): four fractions, positive width and height.
export const validBoxes = (arr) => (Array.isArray(arr) ? arr : [])
  .filter((b) => Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && v >= 0 && v <= 1) && b[2] > b[0] && b[3] > b[1])
  .slice(0, 12);

// Model output -> one result per candidate id. Unknown photo numbers and repeats are dropped;
// candidates the model skipped are listed in `missing` so the client can leave them unjudged.
export function normalizeJudgments(parsed, candidateIds) {
  const list = Array.isArray(parsed?.photos) ? parsed.photos : [];
  const seen = new Set(), results = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const n = Number.isInteger(r.photo) ? r.photo : NaN;
    if (!(n >= 1 && n <= candidateIds.length) || seen.has(n)) continue;
    seen.add(n);
    results.push({
      id: candidateIds[n - 1],
      person: r.person !== false,
      eyes_open: round3(clamp01(r.eyes_open)),
      expression: round3(clamp01(r.expression)),
      angle: round3(clamp01(r.angle)),
      taste: round3(clamp01(r.taste)),
      faces: validBoxes(r.faces),
      note: String(r.note ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 70),
    });
  }
  const missing = candidateIds.filter((_, i) => !seen.has(i + 1));
  return { results, missing };
}
