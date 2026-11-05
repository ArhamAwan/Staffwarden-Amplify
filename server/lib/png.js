'use strict';
// Reads a PNG into what a PDF needs: the colour samples and, when it has transparency, an alpha mask.
// Covers what browsers write from a canvas (8-bit RGBA or RGB, not interlaced) plus 8-bit grey and palette
// images, which is everything the company logo upload sends. Anything else is refused with a clear error.
const zlib = require('node:zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function info(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIG) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), depth: buf[24], color: buf[25], interlace: buf[28] };
}

function decode(buf) {
  const hd = info(buf);
  if (!hd) throw new Error('Not a PNG');
  if (hd.depth !== 8 || hd.interlace !== 0 || ![0, 2, 3, 4, 6].includes(hd.color)) throw new Error('Unsupported PNG');
  const idat = [];
  let pal = null, trns = null;
  for (let o = 8; o + 8 <= buf.length;) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IDAT') idat.push(data); else if (type === 'PLTE') pal = data; else if (type === 'tRNS') trns = data; else if (type === 'IEND') break;
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[hd.color], stride = hd.w * ch, { w, h } = hd;
  const px = Buffer.alloc(stride * h);
  // undo the per-row filters
  for (let y = 0, i = 0; y < h; y++) {
    const f = raw[i++], row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++, i++) {
      const a = x >= ch ? px[row + x - ch] : 0, b = y ? px[prev + x] : 0, c = x >= ch && y ? px[prev + x - ch] : 0;
      let p = raw[i];
      if (f === 1) p += a; else if (f === 2) p += b; else if (f === 3) p += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = p & 255;
    }
  }
  const rgb = Buffer.alloc(w * h * 3), alpha = Buffer.alloc(w * h, 255);
  let see = false;
  for (let k = 0; k < w * h; k++) {
    let r, g, b, a = 255;
    if (hd.color === 6) { r = px[k * 4]; g = px[k * 4 + 1]; b = px[k * 4 + 2]; a = px[k * 4 + 3]; }
    else if (hd.color === 2) { r = px[k * 3]; g = px[k * 3 + 1]; b = px[k * 3 + 2]; }
    else if (hd.color === 0) { r = g = b = px[k]; }
    else if (hd.color === 4) { r = g = b = px[k * 2]; a = px[k * 2 + 1]; }
    else { const n = px[k]; r = pal ? pal[n * 3] : 0; g = pal ? pal[n * 3 + 1] : 0; b = pal ? pal[n * 3 + 2] : 0; if (trns && n < trns.length) a = trns[n]; }
    rgb[k * 3] = r; rgb[k * 3 + 1] = g; rgb[k * 3 + 2] = b; alpha[k] = a;
    if (a !== 255) see = true;
  }
  return { w, h, rgb, alpha: see ? alpha : null };
}

module.exports = { info, decode };
