// Strict validation for POST /api/select. Everything from the client is untrusted:
// ids are opaque labels (checked for shape and uniqueness), images must be small baseline
// JPEGs sent inline as base64. No URLs, storage keys or user ids are accepted.

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

// Width and height from the JPEG frame header, or null if this isn't a well-formed JPEG.
export function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null;
    let m = buf[off + 1];
    while (m === 0xff && off + 2 < buf.length) { off++; m = buf[off + 1]; } // fill bytes
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { off += 2; continue; } // markers without a length
    if (m === 0xd9 || m === 0xda) return null; // end of image / scan data before any frame header
    const len = buf.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > buf.length) return null;
    if (SOF.has(m)) {
      if (len < 7) return null;
      const height = buf.readUInt16BE(off + 5), width = buf.readUInt16BE(off + 7);
      return width && height ? { width, height } : null;
    }
    off += 2 + len;
  }
  return null;
}

function decodeImage(item, where, limits) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, 'invalid_image', `${where} must be an object`);
  const { id, data } = item;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, 'invalid_id', `${where}.id must be 1-64 letters, digits, - or _`);
  if (typeof data !== 'string' || !data.length) throw new HttpError(400, 'invalid_image', `${where}.data must be base64 JPEG`);
  // rough pre-check before decoding so a huge string can't make us allocate
  if (data.length > Math.ceil(limits.maxImageBytes / 3) * 4 + 4) throw new HttpError(413, 'image_too_large', `${where} is larger than ${limits.maxImageBytes} bytes`);
  if (data.length % 4 !== 0 || !B64_RE.test(data)) throw new HttpError(400, 'invalid_image', `${where}.data is not plain base64 (no data: prefix, no whitespace)`);
  const buf = Buffer.from(data, 'base64');
  if (buf.length > limits.maxImageBytes) throw new HttpError(413, 'image_too_large', `${where} is larger than ${limits.maxImageBytes} bytes`);
  const size = jpegSize(buf);
  if (!size) throw new HttpError(415, 'not_jpeg', `${where} is not a JPEG`);
  if (Math.max(size.width, size.height) > limits.maxImageSide) {
    throw new HttpError(413, 'image_too_large', `${where} is ${size.width}x${size.height}; resize to at most ${limits.maxImageSide}px on the long side`);
  }
  return { id, data, bytes: buf.length, ...size };
}

const cleanBrief = (s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

export function parseSelectRequest(body, limits) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_body', 'Body must be a JSON object');
  const allowed = new Set(['brief', 'references', 'candidates']);
  const extra = Object.keys(body).filter((k) => !allowed.has(k));
  if (extra.length) throw new HttpError(400, 'unknown_field', `Unknown field: ${extra[0]}`);

  const brief = body.brief ?? '';
  if (typeof brief !== 'string') throw new HttpError(400, 'invalid_brief', 'brief must be a string');
  if (brief.length > limits.maxBriefChars) throw new HttpError(400, 'invalid_brief', `brief is longer than ${limits.maxBriefChars} characters`);

  const refs = body.references ?? [];
  const cands = body.candidates;
  if (!Array.isArray(refs)) throw new HttpError(400, 'invalid_references', 'references must be an array');
  if (!Array.isArray(cands) || !cands.length) throw new HttpError(400, 'invalid_candidates', 'candidates must be a non-empty array');
  if (refs.length > limits.maxReferences) throw new HttpError(400, 'too_many_references', `At most ${limits.maxReferences} references per request`);
  if (cands.length > limits.maxCandidates) throw new HttpError(400, 'too_many_candidates', `At most ${limits.maxCandidates} candidates per request`);

  const references = refs.map((r, i) => decodeImage(r, `references[${i}]`, limits));
  const candidates = cands.map((c, i) => decodeImage(c, `candidates[${i}]`, limits));
  const ids = new Set();
  for (const x of [...references, ...candidates]) {
    if (ids.has(x.id)) throw new HttpError(400, 'duplicate_id', `Duplicate id: ${x.id}`);
    ids.add(x.id);
  }
  return { brief: cleanBrief(brief), references, candidates };
}
