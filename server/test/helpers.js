// Tiny fake JPEGs: SOI, one SOF0 frame header with the given size, EOI. Enough for the
// validator; never sent anywhere real (the Anthropic client is faked in tests).
export function fakeJpeg(width = 480, height = 640) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), sof, Buffer.from([0xff, 0xd9])]);
}
export const b64 = (buf) => buf.toString('base64');

export const LIMITS = {
  maxBodyBytes: 1024 * 1024, maxImageBytes: 64 * 1024, maxImageSide: 1024,
  maxReferences: 3, maxCandidates: 13, maxBriefChars: 500,
};

export function request(n = 2, refs = 1) {
  return {
    brief: '6 picks, warm "film" vibe',
    references: Array.from({ length: refs }, (_, i) => ({ id: `ref-${i + 1}`, data: b64(fakeJpeg(320, 400)) })),
    candidates: Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, data: b64(fakeJpeg()) })),
  };
}

// Fake Anthropic client: records the request and returns a canned message.
export function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (params, opts) => { calls.push({ params, opts }); return typeof reply === 'function' ? reply(params) : reply; } } },
  };
}

export function message(photos, { ranking, selected, ...extra } = {}) {
  const body = { photos, ranking: ranking ?? photos.map((p) => p.photo), selected: selected ?? photos.slice(0, 1).map((p) => ({ photo: p.photo, reason: 'r' })) };
  return {
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(body) }],
    usage: { input_tokens: 1234, output_tokens: 210, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...extra,
  };
}
