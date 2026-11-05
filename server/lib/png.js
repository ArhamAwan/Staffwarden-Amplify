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

// writes RGB(A) samples as a PNG (no filters: small logos only)
function encode({ w, h, rgb, alpha }) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let x = 0xffffffff; for (const v of b) x = crcT[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ch = alpha ? 4 : 3, hd = Buffer.alloc(13); hd.writeUInt32BE(w, 0); hd.writeUInt32BE(h, 4); hd[8] = 8; hd[9] = alpha ? 6 : 2;
  const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0, o = 0; y < h; y++) { raw[o++] = 0; for (let x = 0; x < w; x++) { const k = y * w + x; raw[o++] = rgb[k * 3]; raw[o++] = rgb[k * 3 + 1]; raw[o++] = rgb[k * 3 + 2]; if (alpha) raw[o++] = alpha[k]; } }
  return Buffer.concat([SIG, chunk('IHDR', hd), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// a see-through logo with white parts, made for dark backgrounds: they vanish on white paper
function whiteParts(img) {
  if (!img || !img.alpha) return false;
  let see = 0, solid = 0, white = 0;
  for (let k = 0; k < img.w * img.h; k++) { const a = img.alpha[k]; if (a < 250) see++; if (a > 200) { solid++; if (img.rgb[k * 3] > 235 && img.rgb[k * 3 + 1] > 235 && img.rgb[k * 3 + 2] > 235) white++; } }
  return see > img.w * img.h * 0.05 && solid > 0 && white / solid > 0.06;
}
// the same logo with its white and pale grey parts in dark ink, for white paper
function inked(img) {
  const rgb = Buffer.from(img.rgb);
  for (let k = 0; k < img.w * img.h; k++) {
    const r = rgb[k * 3], g = rgb[k * 3 + 1], b = rgb[k * 3 + 2], l = 0.299 * r + 0.587 * g + 0.114 * b;
    if ((!img.alpha || img.alpha[k] > 0) && l > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 40) { rgb[k * 3] = 22; rgb[k * 3 + 1] = 18; rgb[k * 3 + 2] = 58; }
  }
  return { ...img, rgb };
}
module.exports.encode = encode;
module.exports.whiteParts = whiteParts;
module.exports.inked = inked;
// takes the paper out of a photographed signature or stamp: the paper's brightness is measured in each
// part of the picture (so grey paper, uneven light and shadows all go), and only what is clearly darker or
// coloured than the paper around it is kept, softly at its edges. Already see-through parts stay so.
function removePaper(img) {
  const { w, h } = img, n = w * h, L = new Float32Array(n), S = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const a = img.alpha ? img.alpha[k] : 255, r = img.rgb[k * 3], g = img.rgb[k * 3 + 1], b = img.rgb[k * 3 + 2];
    L[k] = a < 20 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b; S[k] = a < 20 ? 0 : Math.max(r, g, b) - Math.min(r, g, b);
  }
  const cs = Math.max(12, Math.round(Math.min(w, h) / 6)), gx = Math.ceil(w / cs), gy = Math.ceil(h / cs), bg = new Float32Array(gx * gy);
  for (let cy = 0; cy < gy; cy++) for (let cx = 0; cx < gx; cx++) {
    const v = [];
    for (let y = cy * cs; y < Math.min(h, (cy + 1) * cs); y += 2) for (let x = cx * cs; x < Math.min(w, (cx + 1) * cs); x += 2) v.push(L[y * w + x]);
    v.sort((a, b) => a - b); bg[cy * gx + cx] = v.length ? v[Math.floor(v.length * 0.8)] : 255;
  }
  const at = (x, y) => bg[Math.min(gy - 1, Math.max(0, y)) * gx + Math.min(gx - 1, Math.max(0, x))];
  const alpha = Buffer.alloc(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = x / cs - 0.5, fy = y / cs - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const paper = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
    const k = y * w + x, ink = Math.max(paper - L[k], S[k] * 0.9 - 25);
    const a = Math.max(0, Math.min(1, (ink - 22) / 40));
    alpha[k] = Math.round(a * (img.alpha ? img.alpha[k] : 255));
  }
  return { ...img, alpha };
}
module.exports.removePaper = removePaper;
