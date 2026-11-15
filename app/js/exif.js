// Minimal JPEG EXIF reader: capture time, camera, lens basics and GPS.
// Only what the culling step needs for metadata clustering.

export async function readExif(file) {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return {};
    let off = 2;
    while (off < v.byteLength - 10) {
      const marker = v.getUint16(off);
      off += 2;
      if ((marker & 0xff00) !== 0xff00) break;
      const len = v.getUint16(off);
      if (marker === 0xffe1 && v.getUint32(off + 2) === 0x45786966) return parseTiff(v, off + 8);
      off += len;
    }
  } catch (e) { /* unreadable EXIF is normal for screenshots and exports */ }
  return {};
}

function parseTiff(v, start) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(start + o, le);
  const u32 = (o) => v.getUint32(start + o, le);
  const rat = (o) => u32(o) / (u32(o + 4) || 1);
  const str = (o, c) => {
    let s = '';
    for (let i = 0; i < c - 1 && start + o + i < v.byteLength; i++) {
      const ch = v.getUint8(start + o + i);
      if (!ch) break;
      s += String.fromCharCode(ch);
    }
    return s.trim();
  };
  const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const readIFD = (ifd, fn) => {
    if (start + ifd + 2 > v.byteLength) return;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (start + e + 12 > v.byteLength) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const bytes = (sizes[type] || 1) * count;
      const at = bytes > 4 ? u32(e + 8) : e + 8;
      if (start + at >= v.byteLength) continue;
      try { fn(tag, type, count, at); } catch (err) { /* skip bad entry */ }
    }
  };
  const out = {};
  let exifPtr = 0, gpsPtr = 0;
  readIFD(u32(4), (tag, type, count, o) => {
    if (tag === 0x010f) out.make = str(o, count);
    else if (tag === 0x0110) out.model = str(o, count);
    else if (tag === 0x0132) out.dateTime = str(o, count);
    else if (tag === 0x8769) exifPtr = u32(o);
    else if (tag === 0x8825) gpsPtr = u32(o);
  });
  if (exifPtr) readIFD(exifPtr, (tag, type, count, o) => {
    if (tag === 0x9003) out.dateTimeOriginal = str(o, count);
    else if (tag === 0x920a) out.focal = rat(o);
    else if (tag === 0x8827) out.iso = u16(o);
    else if (tag === 0x829d) out.fnum = rat(o);
    else if (tag === 0x829a) out.shutter = rat(o);
  });
  if (gpsPtr) {
    let latRef = 'N', lonRef = 'E', lat = null, lon = null;
    const dms = (o) => rat(o) + rat(o + 8) / 60 + rat(o + 16) / 3600;
    readIFD(gpsPtr, (tag, type, count, o) => {
      if (tag === 1) latRef = String.fromCharCode(v.getUint8(start + o));
      else if (tag === 2) lat = dms(o);
      else if (tag === 3) lonRef = String.fromCharCode(v.getUint8(start + o));
      else if (tag === 4) lon = dms(o);
    });
    if (lat != null && lon != null) {
      out.lat = lat * (latRef === 'S' ? -1 : 1);
      out.lon = lon * (lonRef === 'W' ? -1 : 1);
    }
  }
  const d = out.dateTimeOriginal || out.dateTime;
  const m = d && d.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (m) out.time = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return out;
}
