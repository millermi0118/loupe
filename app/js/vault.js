// Keeps the style profile between visits, so past edits are uploaded once.
// Signed in on the published page: the viewer's private space in the artifact database
// (follows their account across devices). Otherwise: this browser's IndexedDB.
// Only a small thumbnail and the measurements are stored, never the original file.

export const MAX_REFS = 150;
const FEAT_KEYS = ['meanL', 'stdL', 'meanA', 'stdA', 'meanB', 'stdB', 'chroma', 'colorfulness', 'clutter', 'skinFrac', 'comp', 'aspect', 'centroid', 'q', 'palette'];
const round = (v) => (Array.isArray(v) ? v.map(round) : typeof v === 'number' ? +v.toFixed(4) : v);

export function serializeRef(r) {
  const feat = {};
  for (const k of FEAT_KEYS) feat[k] = round(r.feat[k]);
  feat.emb = Array.from(r.feat.emb, (v) => +v.toFixed(4));
  return {
    id: r.id, name: r.name, addedAt: r.addedAt || Date.now(), thumb: r.small,
    feat, skin: r.skin ? Object.fromEntries(Object.entries(r.skin).map(([k, v]) => [k, round(v)])) : null,
    faceChecked: !!r.faceChecked,
  };
}

function dataUrlBlob(url) {
  const [head, b64] = url.split(',');
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: head.slice(5, head.indexOf(';')) || 'image/jpeg' });
}

export function hydrateRef(d) {
  return {
    ...d, feat: { ...d.feat, emb: Float32Array.from(d.feat.emb) },
    small: d.thumb, url: d.thumb, thumb: dataUrlBlob(d.thumb), stored: true,
  };
}

/* ---- account database ---- */

function dbBackend(db, uid) {
  const root = `data/users/${uid}`;
  const refs = db.collection(`${root}/profile/refs`);
  const taste = db.doc(`${root}/taste`);
  let tasteChain = Promise.resolve(), pendingTaste = null;
  return {
    kind: 'account',
    async loadRefs() { return (await refs.limit(MAX_REFS).get()).docs.map((d) => d.data()); },
    putRef: (r) => refs.doc(r.id).set(r),
    delRef: (id) => refs.doc(id).delete(),
    async clear() { for (const d of (await refs.limit(MAX_REFS).get()).docs) await refs.doc(d.id).delete(); },
    async loadTaste() { const s = await taste.get(); return s.exists ? s.data() : null; },
    // one write at a time to the taste doc; rapid answers collapse into the latest
    saveTaste(v) {
      const first = !pendingTaste;
      pendingTaste = v;
      if (first) tasteChain = tasteChain.then(() => { const x = pendingTaste; pendingTaste = null; return taste.set(x); }).catch(() => {});
      return tasteChain;
    },
  };
}

/* ---- this browser ---- */

function idbBackend() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open('loupe', 1); } catch (e) { resolve(null); return; }
    req.onupgradeneeded = () => {
      req.result.createObjectStore('refs', { keyPath: 'id' });
      req.result.createObjectStore('kv');
    };
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const idb = req.result;
      const run = (store, mode, fn) => new Promise((res, rej) => {
        const tx = idb.transaction(store, mode), r = fn(tx.objectStore(store));
        tx.oncomplete = () => res(r?.result);
        tx.onerror = () => rej(tx.error);
      });
      resolve({
        kind: 'browser',
        loadRefs: () => run('refs', 'readonly', (s) => s.getAll()),
        putRef: (r) => run('refs', 'readwrite', (s) => s.put(r)),
        delRef: (id) => run('refs', 'readwrite', (s) => s.delete(id)),
        clear: () => run('refs', 'readwrite', (s) => s.clear()),
        loadTaste: () => run('kv', 'readonly', (s) => s.get('taste')),
        saveTaste: (v) => run('kv', 'readwrite', (s) => s.put(v, 'taste')).catch(() => {}),
      });
    };
  });
}

export async function openVault(capability) {
  const [db, user] = await Promise.all([capability('db'), capability('user')]);
  let uid = null;
  try { uid = db && user ? await user.id() : null; } catch (e) { uid = null; }
  if (db && uid) return dbBackend(db, uid);
  return (await idbBackend()) || null;
}
