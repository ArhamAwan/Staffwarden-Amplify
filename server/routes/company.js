'use strict';
// The company on documents: its logo (and a light version and a small icon), legal name, address, phone,
// email, website, tax and registration numbers, a brand colour, and who signs certificates (with a
// signature and stamp). Payslips, salary certificates, client statements, the bank sheet and register and
// the client portal's header all use it. The owner or HR set it in Settings.
//
// Pictures arrive as PNG made in the browser (any format the person picks is drawn onto a canvas first),
// are kept under the data folder by their content, and are never deleted when replaced: a month already
// approved keeps a copy of these details, and its payslips must still find the logo they went out with.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { need, optStr } = require('../lib/http');
const PNG = require('../lib/png');
const { Pdf, PAGE_W } = require('../lib/pdf');

const SLOTS = ['logo', 'logo_light', 'icon', 'signature', 'stamp'];
const PUBLIC = new Set(['logo', 'logo_light', 'icon']);        // shown in the client portal's header and the app
const MAX_IMG = 4 * 1024 * 1024;
const FIELDS = { legal_name: 120, address: 300, phone: 40, email: 120, website: 120, ntn: 40, secp: 40, eobi_no: 40, signer_name: 80, signer_title: 80 };

module.exports = (ctx) => {
  const { cfg, route, audit, emit, saveSetting, isHR } = ctx;
  const dir = path.join(cfg.dataDir, 'company');
  fs.mkdirSync(dir, { recursive: true });
  const canEdit = (u) => u.role === 'owner' || isHR(u);
  const needEdit = (u) => need(u && u.kind !== 'client' && canEdit(u), 403, 'Only the owner or HR can change the company details');

  const current = () => {
    const c = cfg.company && typeof cfg.company === 'object' ? cfg.company : {};
    return { ...Object.fromEntries(Object.keys(FIELDS).map((k) => [k, c[k] || ''])), brand: /^#[0-9a-f]{6}$/i.test(c.brand || '') ? c.brand : '', images: c.images || {}, name: cfg.orgName || '' };
  };
  const imgOut = (c, slot, viewer) => {
    const im = c.images[slot];
    if (!im) return null;
    if (!PUBLIC.has(slot) && !(viewer && canEdit(viewer))) return { set: true };
    return { url: `/api/company/images/${slot}?v=${im.file.slice(-16, -4)}`, w: im.w, h: im.h };
  };
  const out = (viewer) => {
    const c = current();
    return { ...c, auto_brand: autoColour(c), logo_inked: logoInked(c), images: Object.fromEntries(SLOTS.map((s) => [s, imgOut(c, s, viewer)])), can_edit: !!(viewer && viewer.kind !== 'client' && canEdit(viewer)) };
  };

  // decoded pictures for PDFs, kept in memory by file name (they never change once written)
  const cache = new Map();
  const picture = (file) => {
    if (!file) return null;
    if (cache.has(file)) return cache.get(file);
    let img = null;
    try { img = PNG.decode(fs.readFileSync(path.join(dir, path.basename(file)))); } catch { img = null; }
    cache.set(file, img);
    return img;
  };
  // the colour most used in the logo (leaving out white, black, grey and see-through), darkened enough to
  // carry white text: the brand colour when the person picks "From your logo"
  function logoColour(img) {
    if (!img) return null;
    const bins = new Map(), step = Math.max(1, Math.floor((img.w * img.h) / 6000));
    for (let k = 0; k < img.w * img.h; k += step) {
      if (img.alpha && img.alpha[k] < 200) continue;
      const r = img.rgb[k * 3], g = img.rgb[k * 3 + 1], b = img.rgb[k * 3 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx > 235 || mx < 60 || (mx - mn) / mx < 0.35) continue;   // white, near-black (text) and greys don't count
      const key = `${r >> 4},${g >> 4},${b >> 4}`, e = bins.get(key) || [0, 0, 0, 0]; e[0] += r; e[1] += g; e[2] += b; e[3]++; bins.set(key, e);
    }
    let best = null; for (const e of bins.values()) if (!best || e[3] > best[3]) best = e;
    if (!best) return null;
    let [r, g, b] = best.slice(0, 3).map((x) => x / best[3]);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b; if (lum > 120) { const f = 120 / lum; r *= f; g *= f; b *= f; }
    return `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
  }
  const autoColour = (c) => (c.images && c.images.logo ? logoColour(picture(c.images.logo.file)) : null);
  // the full logo as it goes on white paper: a logo made for dark backgrounds gets its white parts in dark ink
  const inkCache = new Map();
  const paperLogo = (file) => {
    if (!file) return null;
    if (inkCache.has(file)) return inkCache.get(file);
    const img = picture(file), out = img && PNG.whiteParts(img) ? PNG.inked(img) : img;
    inkCache.set(file, out);
    return out;
  };
  // a signature or stamp with its paper taken out (also cleans ones saved before this was done well)
  const inkCache2 = new Map();
  const inkOnly = (file) => {
    if (!file) return null;
    if (!inkCache2.has(file)) { const img = picture(file); inkCache2.set(file, img ? PNG.removePaper(img) : null); }
    return inkCache2.get(file);
  };
  const logoInked = (c) => { const f = c.images.logo && c.images.logo.file; return !!(f && paperLogo(f) && paperLogo(f) !== picture(f)); };
  // what a document is made with: the details now, or the copy a month kept when it was approved
  const snapshot = () => { const c = current(); return { ...c, brand: c.brand || autoColour(c) || '', images: Object.fromEntries(Object.entries(c.images).map(([k, v]) => [k, { file: v.file, w: v.w, h: v.h }])) }; };
  ctx.companySnapshot = snapshot;
  ctx.companyFor = (saved) => {
    let c = null;
    if (saved) { try { c = JSON.parse(saved); } catch { c = null; } }
    c = c || snapshot();
    return { ...c, brand: c.brand || '', name: c.name || cfg.orgName || '', legal: c.legal_name || c.name || cfg.orgName || '', pic: (slot) => (slot === 'logo' ? paperLogo(c.images && c.images.logo && c.images.logo.file) : slot === 'signature' || slot === 'stamp' ? inkOnly(c.images && c.images[slot] && c.images[slot].file) : picture(c.images && c.images[slot] && c.images[slot].file)) };
  };
  ctx.companyPublic = () => { const c = current(); const origLight = !c.images.logo_light && logoInked(c) ? { url: `/api/company/images/logo?orig=1&v=${c.images.logo.file.slice(-16, -4)}`, w: c.images.logo.w, h: c.images.logo.h } : null; return { brand_now: c.brand || autoColour(c) || null, name: c.name, details: !!(c.address || c.ntn), logo: imgOut(c, 'logo', null), logo_light: imgOut(c, 'logo_light', null) || origLight, icon: imgOut(c, 'icon', null), brand: c.brand || null }; };

  route('GET', '/api/company', ({ user }) => out(user));

  route('PUT', '/api/company', ({ user, body }) => {
    needEdit(user);
    const prev = cfg.company && typeof cfg.company === 'object' ? cfg.company : {};
    const next = { ...prev };
    const changed = [];
    for (const [k, max] of Object.entries(FIELDS)) if (k in body) { const v = optStr(body[k], k, max) || ''; if ((prev[k] || '') !== v) changed.push(k); next[k] = v; }
    if ('email' in body && next.email) need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email), 400, 'That email address doesn’t look right');
    if ('brand' in body) { need(body.brand === '' || body.brand === null || /^#[0-9a-f]{6}$/i.test(body.brand), 400, 'The brand colour must look like #0E6E78'); next.brand = String(body.brand || '').toLowerCase(); if ((prev.brand || '') !== next.brand) changed.push('brand'); }
    if ('name' in body) { const n = optStr(body.name, 'name', 80); need(n, 400, 'Give the company a name'); if (n !== cfg.orgName) { saveSetting('orgName', n); changed.push('name'); } }
    saveSetting('company', next);
    if (changed.length) audit(user, 'company.changed', null, changed.join(', '));
    emit('settings');
    return out(user);
  });

  route('POST', '/api/company/images/:slot', ({ user, params, body }) => {
    needEdit(user);
    const slot = params.slot;
    need(SLOTS.includes(slot), 404, 'Unknown picture');
    need(Buffer.isBuffer(body) && body.length > 0, 400, 'Send the picture');
    const hd = PNG.info(body);
    need(hd, 400, 'Send the picture as a PNG');
    need(hd.w <= 4000 && hd.h <= 4000, 400, 'That picture is too large. Keep it under 4000 pixels a side.');
    let readable = true; try { PNG.decode(body); } catch { readable = false; }
    need(readable, 400, 'That picture can’t be read. Try saving it as a PNG.');
    const file = `${slot}-${crypto.createHash('sha256').update(body).digest('hex').slice(0, 24)}.png`;
    fs.writeFileSync(path.join(dir, file), body);
    const prev = cfg.company && typeof cfg.company === 'object' ? cfg.company : {};
    saveSetting('company', { ...prev, images: { ...(prev.images || {}), [slot]: { file, w: hd.w, h: hd.h } } });
    audit(user, 'company.image', null, slot);
    emit('settings');
    return out(user);
  }, { raw: MAX_IMG });

  route('DELETE', '/api/company/images/:slot', ({ user, params }) => {
    needEdit(user);
    need(SLOTS.includes(params.slot), 404, 'Unknown picture');
    const prev = cfg.company && typeof cfg.company === 'object' ? cfg.company : {};
    const images = { ...(prev.images || {}) }; delete images[params.slot];
    saveSetting('company', { ...prev, images });
    audit(user, 'company.image_removed', null, params.slot);
    emit('settings');
    return out(user);
  });

  // the logo and icon are open to anyone (the sign-in page and the client portal show them); a signature or
  // stamp only to the owner and HR
  const inkPng = new Map();
  route('GET', '/api/company/images/:slot', ({ user, params, query }) => {
    need(SLOTS.includes(params.slot), 404, 'Not found');
    if (!PUBLIC.has(params.slot)) need(user && user.kind !== 'client' && canEdit(user), 404, 'Not found');
    const im = current().images[params.slot];
    need(im, 404, 'Not found');
    const p = path.join(dir, path.basename(im.file));
    need(fs.existsSync(p), 404, 'Not found');
    if (params.slot === 'signature' || params.slot === 'stamp') {
      const ink = inkOnly(im.file);
      if (ink) { if (!inkPng.has(`p:${im.file}`)) inkPng.set(`p:${im.file}`, PNG.encode(ink)); return { raw: inkPng.get(`p:${im.file}`), type: 'image/png', headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } }; }
    }
    if (params.slot === 'logo' && query.get('orig') !== '1') {
      const pl = paperLogo(im.file);
      if (pl && pl !== picture(im.file)) {
        if (!inkPng.has(im.file)) inkPng.set(im.file, PNG.encode(pl));
        return { raw: inkPng.get(im.file), type: 'image/png', headers: { 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } };
      }
    }
    return { raw: fs.readFileSync(p), type: 'image/png', headers: { 'Cache-Control': PUBLIC.has(params.slot) ? 'public, max-age=86400' : 'private, no-store', 'X-Content-Type-Options': 'nosniff' } };
  }, { open: true, client: true });

  // ---------------------------------------------------------------------------------------------
  // the document's own parts, the same on a payslip, a certificate and a statement
  // ---------------------------------------------------------------------------------------------
  const INK = '#16123A', MUTED = '#5E5A80', SOFT = '#F5F4FA';
  const L = 56, R = PAGE_W - 56;
  const brandOf = (co) => co.brand || '#6B4FE0';
  // the top: a band of the brand colour, the logo (or the name in bold), the address under it, and the
  // document's own title on the right. Returns the y below it.
  function head(doc, co, { title, sub, sub2, addressRight = false }) {
    const brand = brandOf(co);
    doc.rect(0, 0, PAGE_W, 8, { fill: brand });
    const logo = co.pic('logo');
    let y = 40;
    if (logo) { const d = doc.image(L, y, 200, 52, logo); y += d.h + 18; }
    else { doc.text(L, y + 22, co.name || co.legal, { size: 19, bold: true, color: INK, maxW: 300 }); y += 36; }
    const addr = [...String(co.address || '').split(/\n+/).map((x) => x.trim()).filter(Boolean), [co.ntn ? `NTN ${co.ntn}` : '', co.eobi_no ? `EOBI ${co.eobi_no}` : ''].filter(Boolean).join(' · ')].filter(Boolean);
    if (addressRight) {
      let ay = 52; for (const a of [...addr, [co.phone, co.email].filter(Boolean).join(' · ')].filter(Boolean)) { doc.text(R, ay, a, { size: 9, color: MUTED, align: 'right', maxW: 260 }); ay += 13; }
      y = Math.max(y, ay) + 8;
      doc.line(0, y, PAGE_W, y, { color: '#E6E4F0' });
      return y + 30;
    }
    for (const a of addr) { doc.text(L, y, a, { size: 9, color: MUTED, maxW: 300 }); y += 13; }
    if (title) {
      doc.text(R, 62, title, { size: 21, bold: true, color: INK, align: 'right' });
      if (sub) doc.text(R, 82, sub, { size: 11.5, bold: true, color: brand, align: 'right' });
      if (sub2) doc.text(R, 97, sub2, { size: 9, color: MUTED, align: 'right' });
    }
    return Math.max(y, 110) + 14;
  }
  // the bottom: the legal name, how to reach the company, and a line on the right
  function foot(doc, co, right = '') {
    doc.rect(0, 786, PAGE_W, 56, { fill: SOFT });
    doc.text(L, 806, co.legal, { size: 8.5, bold: true, color: MUTED, maxW: right ? R - L - 230 : R - L });
    if (right) doc.text(R, 806, right, { size: 8.5, color: MUTED, align: 'right', maxW: 220 });
    const reach = [co.email, co.phone, co.website, co.secp ? `SECP ${co.secp}` : ''].filter(Boolean).join('  ·  ');
    if (reach) doc.text(L, 820, reach, { size: 8.5, color: MUTED, maxW: R - L });
  }
  // a signature line with the signer's name, and the stamp beside it, at the foot of a certificate
  function signature(doc, co, y) {
    const sig = co.pic('signature'), stamp = co.pic('stamp');
    if (sig) doc.image(L, y, 170, 50, sig);
    doc.line(L, y + 58, L + 210, y + 58, { color: '#9C98B8' });
    doc.text(L, y + 74, co.signer_name || 'Authorised signature', { size: 10.5, bold: !!co.signer_name, color: INK });
    if (co.signer_title) doc.text(L, y + 88, co.signer_title, { size: 9, color: MUTED });
    if (stamp) doc.image(R - 110, y - 20, 110, 110, stamp, { align: 'right' });
  }
  // a payslip's sign-off: the signature and stamp near the foot, when the company has them. Returns false
  // when there's nothing to add. Goes on a new page when the lines have filled this one.
  function signOff(doc, co, y) {
    if (!co.pic('signature') && !co.pic('stamp')) return false;
    let at = Math.max(y + 24, 650);
    if (at > 668) { foot(doc, co); doc.page(); at = 70; }
    doc.text(L, at - 8, 'Approved for payment', { size: 9, color: MUTED });
    signature(doc, co, at);
    return true;
  }
  ctx.docParts = { head, foot, signature, signOff, brandOf, INK, MUTED, SOFT, L, R };

  // a sample payslip with today's details, to check the look before payroll is run
  route('GET', '/api/company/sample.pdf', ({ user }) => {
    needEdit(user);
    const co = ctx.companyFor(null), brand = brandOf(co), m = (n) => `Rs ${Math.abs(n).toLocaleString('en-US')}`;
    const doc = new Pdf();
    let y = head(doc, co, { title: 'Payslip', sub: 'Sample', sub2: 'How your payslips will look' });
    doc.line(L, y, R, y, { color: '#E6E4F0' }); y += 26;
    doc.text(L, y, 'Employee', { size: 9, color: MUTED }); doc.text(L, y + 16, 'Sara Khan', { size: 13, bold: true, color: INK }); doc.text(L, y + 30, 'Call agent', { size: 9.5, color: MUTED });
    doc.text(L + 180, y, 'Paid to', { size: 9, color: MUTED }); doc.text(L + 180, y + 16, 'Bank ... 4821', { size: 12, bold: true, color: INK });
    y += 52; doc.line(L, y, R, y, { color: '#E6E4F0' }); y += 22;
    doc.rect(L, y, R - L, 54, { fill: SOFT });
    [['Gross pay', 126500], ['Income tax', 455], ['Deductions', 24545], ['Net pay', 101500]].forEach(([k, v], i) => { const x = L + 16 + (i * (R - L)) / 4; doc.text(x, y + 20, k, { size: 9, color: MUTED }); doc.text(x, y + 39, m(v), { size: 13, bold: true, color: i === 3 ? brand : INK }); });
    y += 80;
    for (const [k, note, v] of [['Base salary', 'Full month', 120000], ['Unpaid leave', '2 days', -10909], ['Late arrivals', '15 late starts', -13636], ['Expense paid back', 'Not taxed', 6500], ['Income tax', 'On the brackets', -455]]) {
      doc.text(L, y, k, { size: 11, bold: true, color: INK }); doc.text(R, y, `${v < 0 ? '- ' : ''}${m(v)}`, { size: 11, bold: true, color: v < 0 ? '#B4442E' : INK, align: 'right' });
      doc.text(L, y + 14, note, { size: 9, color: MUTED }); y += 26; doc.line(L, y, R, y, { color: '#ECEAF4' }); y += 18;
    }
    doc.rect(L, y, R - L, 2, { fill: INK }); y += 26;
    doc.text(L, y, 'Net pay', { size: 14, bold: true, color: INK }); doc.text(R, y, m(101500), { size: 19, bold: true, color: brand, align: 'right' });
    doc.text(L, y + 30, 'Sample figures, not a real payslip.', { size: 9, color: MUTED });
    signOff(doc, co, y + 40);
    foot(doc, co, 'Sample');
    return { raw: doc.toBuffer({ title: 'Sample payslip', author: co.legal }), type: 'application/pdf', headers: { 'Content-Disposition': 'attachment; filename="sample-payslip.pdf"', 'Cache-Control': 'private, no-store' } };
  });
};
