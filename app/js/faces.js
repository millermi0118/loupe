// Face detection + 68-point landmarks in the browser (face-api on TF.js; models ship with the page).
// Gives face boxes for retouching and framing, plus eyes-open, smile and head-turn for picking.

let ready = null;

// Weights ship as JSON (tensor specs + base64 bytes) so they can be served next to the page.
async function weights(fa, url) {
  const { specs, data } = await (await fetch(url)).json();
  const bin = atob(data), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return fa.tf.io.decodeWeights(bytes.buffer, specs);
}

export function facesReady() {
  if (!window.faceapi) return Promise.resolve(false);
  return (ready ||= (async () => {
    try {
      const fa = window.faceapi;
      try { await fa.tf.setBackend('webgl'); } catch (e) { await fa.tf.setBackend('cpu'); }
      await fa.tf.ready();
      await fa.nets.tinyFaceDetector.loadFromWeightMap(await weights(fa, 'models/tiny_face_detector.json'));
      await fa.nets.faceLandmark68Net.loadFromWeightMap(await weights(fa, 'models/face_landmark_68.json'));
      return true;
    } catch (e) {
      console.warn('Face model unavailable', e);
      return false;
    }
  })());
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (pts) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });

// Returns an array of faces, or null when the detector can't run here.
export async function detectFaces(canvas) {
  if (!(await facesReady())) return null;
  const fa = window.faceapi;
  const res = await fa
    .detectAllFaces(canvas, new fa.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }))
    .withFaceLandmarks();
  const W = canvas.width, H = canvas.height;
  return res.map((r) => {
    const p = r.landmarks.positions;
    // eye aspect ratio: ~0.3 open, under ~0.18 closed
    const ear = (i) => (dist(p[i + 1], p[i + 5]) + dist(p[i + 2], p[i + 4])) / (2 * dist(p[i], p[i + 3]));
    const eyeL = mean(p.slice(36, 42)), eyeR = mean(p.slice(42, 48));
    const xs = p.map((q) => q.x), browY = Math.min(...p.slice(17, 27).map((q) => q.y)), chinY = Math.max(...p.slice(0, 17).map((q) => q.y));
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const top = browY - 0.3 * (chinY - browY); // forehead
    const iod = dist(eyeL, eyeR) || 1;
    return {
      box: [clamp01(x0 / W), clamp01(top / H), clamp01(x1 / W), clamp01(chinY / H)],
      eyeY: (eyeL.y + eyeR.y) / 2 / H,
      eyesOpen: clamp01(((ear(36) + ear(42)) / 2 - 0.17) / 0.1),
      smile: clamp01((dist(p[48], p[54]) / iod - 0.75) / 0.45),
      yaw: (p[30].x - (eyeL.x + eyeR.x) / 2) / iod, // 0 = facing camera
      conf: r.detection.score,
    };
  });
}
