'use strict';
// A small PDF writer for the monthly statement: A4 pages, Helvetica text, lines and filled boxes.
// Nothing outside the box: the statement is a simple table, and a real PDF opens everywhere.
const W = 595.28, H = 841.89;

// Helvetica widths (per 1000 units) for the printable ASCII range, so text can be right-aligned
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// text in the PDF's own encoding (WinAnsi): typographic quotes, dashes, the middle dot and bullets are
// kept as their WinAnsi bytes; anything else outside it becomes a '?'
const WIN = { '‘': '\x91', '’': '\x92', '“': '\x93', '”': '\x94', '•': '\x95', '–': '\x96', '—': '\x97', '…': '\x85', '·': '\xB7', '×': '\xD7', '\u00A0': ' ', '\u202F': ' ' };
const WIN_W = { 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0x85: 1000, 0xB7: 278, 0xD7: 584 };
function clean(s) {
  return String(s ?? '')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')                       // invisible: zero-width spaces and joiners, soft hyphens
    .replace(/[\u2010-\u2012\u2212\uFE63\uFF0D]/g, '-')                       // hyphens that look like '-' (a name typed on a phone often has one)
    .replace(/[\u2002-\u200A\u202F\u205F\u3000]/g, ' ')                       // other spaces
    .replace(/[‘’“”•–—…·×\u00A0]/g, (c) => WIN[c])
    .replace(/[^\x20-\x7E\x85\x91-\x97\xA0-\xFF]/g, (c) => {                  // accents WinAnsi lacks: the plain letter (ā → a)
      const base = c.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      return /^[\x20-\x7E]+$/.test(base) ? base : '?';
    });
}
const esc = (s) => clean(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
function width(s, size, bold = false) {
  const t = bold ? BOLD : HELV;
  let w = 0;
  for (const ch of clean(s)) { const c = ch.charCodeAt(0); w += c < 127 ? t[c - 32] || 556 : WIN_W[c] || (c >= 0xC0 ? 556 : 333); }
  return (w / 1000) * size;
}
const rgb = (hex) => { const n = parseInt(String(hex || '#000000').slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(' '); };

class Pdf {
  constructor() { this.pages = []; this.page(); }
  page() { this.ops = []; this.pages.push(this.ops); return this; }
  // y is measured from the top of the page, like a screen
  text(x, y, s, { size = 11, bold = false, color = '#0B1D2A', align = 'left', maxW = null } = {}) {
    let str = clean(s);
    // too long for its column: cut, with "..."
    if (maxW && width(str, size, bold) > maxW) { while (str.length > 1 && width(`${str}...`, size, bold) > maxW) str = str.slice(0, -1); str = `${str.trimEnd()}...`; }
    const w = width(str, size, bold);
    const x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg ${x0.toFixed(2)} ${(H - y).toFixed(2)} Td (${esc(str)}) Tj ET`);
    return this;
  }
  line(x1, y1, x2, y2, { color = '#E2E7EC', w = 0.8 } = {}) { this.ops.push(`${rgb(color)} RG ${w} w ${x1.toFixed(2)} ${(H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(H - y2).toFixed(2)} l S`); return this; }
  rect(x, y, w, h, { fill = '#F2F4F6' } = {}) { this.ops.push(`${rgb(fill)} rg ${x.toFixed(2)} ${(H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); return this; }
  // wraps text to a width; returns the y below the last line
  para(x, y, s, { size = 10, color = '#4B5B68', maxW = 480, lead = 1.45 } = {}) {
    const words = clean(s).split(/\s+/);
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (width(next, size) > maxW && line) { this.text(x, y, line, { size, color }); y += size * lead; line = w; } else line = next;
    }
    if (line) { this.text(x, y, line, { size, color }); y += size * lead; }
    return y;
  }
  toBuffer({ title = 'Statement', author = '' } = {}) {
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    const catalog = add(null), pagesObj = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const ops of this.pages) {
      const stream = ops.join('\n');
      const c = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< /Title (${esc(title)}) /Author (${esc(author)}) /Producer (Staffwarden) >>`);
    let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offs = [];
    objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

module.exports = { Pdf, width, PAGE_W: W, PAGE_H: H };
