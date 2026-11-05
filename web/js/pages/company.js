// Settings › Company: the logo, details, brand colour and signature that go on payslips, certificates,
// client statements and the client portal, with a preview of a payslip that follows the form as it is typed.
// Pictures are saved as soon as they are picked: any format is drawn onto a canvas here and sent as PNG
// (a signature or stamp has its white paper taken out); the words are saved with Save changes.
import { html, raw, esc, icon } from '../util.js';
import { get, put, del, getToken, download, fileUrl } from '../api.js';
import { S, actions, toast, errMsg, confirmBox } from '../ui.js';

const PRESETS = [['#1E2A5A', 'Navy'], ['#1F6B4A', 'Green'], ['#5B2A6E', 'Plum'], ['#8A3B12', 'Rust']];
const SLOTS = {
  logo: ['Full logo', 'For payslips and certificates, on white. PNG, JPG or SVG.'],
  logo_light: ['Light version', 'Optional. For dark headers, like the client portal.'],
  icon: ['Small icon', 'Optional. A square mark for small spaces.'],
  signature: ['Signature', 'A photo on white paper works. The paper is taken out.'],
  stamp: ['Stamp', 'Optional. Placed beside the signature.'],
};
const ok = icon('check');
const authUrls = new Map();
const PRIVATE = new Set(['signature', 'stamp']);   // behind sign-in: loaded with it, then shown
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

// the company's mark for a dark card: the light logo, else the logo on a white chip, else the name
export function companyMark(c, { name = S.settings && S.settings.org_name } = {}) {
  const co = c || (S.settings && S.settings.company) || {};
  if (co.logo_light) return html`<img class="co-mark dark" src="${co.logo_light.url}" alt="${name || ''}">`;
  if (co.logo) return html`<span class="co-chip"><img src="${co.logo.url}" alt="${name || ''}"></span>`;
  return html`<span class="mark-sm">${esc(name || '')}</span>`;
}

const val = (f, k) => (f && f.elements[k] ? String(f.elements[k].value || '').trim() : '');
const lines = (s) => String(s || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);

// a payslip or a certificate, small, in the company's colours
function preview(c, tab) {
  const brand = c.brand || '#6B4FE0';
  const logo = c.images.logo ? html`<img src="${c.images.logo.url}" alt="" class="cp-logo">` : html`<b class="cp-name">${c.name || 'Your company'}</b>`;
  const addr = [...lines(c.address), [c.ntn ? `NTN ${c.ntn}` : '', c.eobi_no ? `EOBI ${c.eobi_no}` : ''].filter(Boolean).join(' · ')].filter(Boolean);
  const reach = [c.email, c.phone, c.website].filter(Boolean).join(' · ');
  const foot = html`<div class="cp-foot"><span>${c.legal_name || c.name}</span>${reach ? html`<span>${reach}</span>` : ''}</div>`;
  const row = (k, v, neg) => html`<div class="cp-row"><span>${k}</span><b class="${neg ? 'neg' : ''}">${v}</b></div>`;
  if (tab === 'cert') {
    return html`<div class="cp" style="--b:${brand}"><i class="cp-band"></i>
      <div class="cp-h"><div>${logo}</div><div class="cp-addr r">${addr.map((a) => html`<span>${a}</span>`)}</div></div>
      <div class="cp-b"><span class="cp-mut">Issued today</span><b class="cp-title">Salary and tax certificate</b><span class="cp-sub">Tax year 2027 · July 1, 2026 to June 30, 2027</span>
        <p class="cp-p">This is to certify that <b>Sara Khan</b>, Call agent, has been employed by ${c.legal_name || c.name || 'your company'} and was paid the amounts below.</p>
        ${row('Total pay', 'Rs 95,455')}${row('Income tax taken', 'Rs 455')}<div class="cp-row strong"><span>Net pay</span><b style="color:${brand}">Rs 101,500</b></div>
        <div class="cp-sign"><div><span class="cp-sigimg" data-co-sig>${c.images.signature ? '' : html`<em>Signature</em>`}</span><i></i><b>${c.signer_name || 'Who signs'}</b><span>${c.signer_title || ''}</span></div><span class="cp-stamp" data-co-stamp></span></div></div>
      ${foot}</div>`;
  }
  return html`<div class="cp" style="--b:${brand}"><i class="cp-band"></i>
    <div class="cp-h"><div>${logo}<div class="cp-addr">${addr.map((a) => html`<span>${a}</span>`)}</div></div><div class="r"><b class="cp-title">Payslip</b><span class="cp-sub">October 2026</span></div></div>
    <div class="cp-who"><span><b>Sara Khan</b>Call agent</span><span class="r">Bank ··· 4821<br>Paid Nov 1 to Nov 10</span></div>
    <div class="cp-sum"><span>Gross<b>Rs 126,500</b></span><span>Taken off<b>Rs 25,000</b></span><span>Net pay<b style="color:${brand}">Rs 101,500</b></span></div>
    <div class="cp-lines">${row('Base salary', 'Rs 120,000')}${row('Unpaid leave', '− Rs 10,909', true)}${row('Late arrivals', '− Rs 13,636', true)}${row('Expense: headset', 'Rs 6,500')}${row('Income tax', '− Rs 455', true)}</div>
    <div class="cp-net"><b>Net pay</b><b style="color:${brand}">Rs 101,500</b></div>
    ${foot}</div>`;
}

const slotCard = (c, slot, { tall = false } = {}) => {
  const im = c.images[slot], [t, sub] = SLOTS[slot], dark = slot === 'logo_light';
  const id = `co-up-${slot}`;
  return html`<div class="co-lg ${im ? 'set' : ''}" data-k="co-${slot}">
    <label class="co-well ${im ? (dark ? 'dark' : 'paper') : 'empty'} ${tall ? 'tall' : ''}" for="${id}">${im ? (im.url && !PRIVATE.has(slot) ? html`<img src="${im.url}" alt="${t}">` : html`<img data-co-auth="${slot}" alt="${t}" src="${authUrls.get(slot) || BLANK}">`) : html`${icon('up')}<span>${slot === 'icon' ? 'Add a square icon' : slot === 'stamp' ? 'Add the company stamp' : `Add the ${t.toLowerCase()}`}</span>`}</label>
    <input type="file" id="${id}" class="sr" accept="image/png,image/jpeg,image/svg+xml,image/webp" data-co-file="${slot}">
    <b>${t}</b><small>${sub}</small>
    <div class="co-acts"><label for="${id}" class="linkbtn">${im ? 'Replace' : 'Upload'}</label>${im ? html`<button type="button" class="linkbtn danger" data-act="co-img-rm" data-slot="${slot}" data-label="${t}">Remove</button>` : ''}</div></div>`;
};

export function companyBlock(c) {
  if (!c) return '';
  const field = (k, label, opt = '', { hint = '', type = 'text', max = 120, wide = false } = {}) => html`<div class="field ${wide ? 'co-wide' : ''}"><label class="f" for="co-${k}">${label}${opt ? html` <span class="muted">${opt}</span>` : ''}</label>${type === 'area' ? html`<textarea id="co-${k}" name="${k}" rows="3" maxlength="${max}">${c[k] || ''}</textarea>` : html`<input id="co-${k}" name="${k}" type="${type}" value="${c[k] || ''}" maxlength="${max}" autocomplete="off">`}${hint ? html`<span class="hint">${hint}</span>` : ''}</div>`;
  const cur = c.brand || '';
  const isPreset = PRESETS.some(([h]) => h.toLowerCase() === cur.toLowerCase());
  return html`<section class="panel sset co" id="set-company" data-k="set-company"><header><div><h2>Your company</h2><p>Your logo and details go on payslips, certificates, client statements and the client portal.</p></div></header><div class="body">
    <form class="co-form" data-submit="co-save" data-coform novalidate>
      <div class="co-cols"><div class="co-main">
        <div class="co-sec"><h3>Logo</h3><p class="hint">Upload it once. Staffwarden picks the right one for white paper and for dark headers.</p>
          <div class="co-logos">${slotCard(c, 'logo')}${slotCard(c, 'logo_light')}${slotCard(c, 'icon')}</div></div>
        <div class="co-sec"><h3>Company details</h3><p class="hint">Printed at the top and bottom of every document. Leave out anything you don’t want shown.</p>
          <div class="co-grid">${field('legal_name', 'Legal name', '', { max: 120 })}${field('name', 'Name people know', '(on screens)', { max: 80 })}
            ${field('address', 'Address', '', { type: 'area', max: 300, wide: true })}
            ${field('phone', 'Phone', '', { type: 'tel', max: 40 })}${field('email', 'Email for pay questions', '', { type: 'email' })}
            ${field('website', 'Website')}${field('ntn', 'NTN', '(tax number)', { max: 40 })}
            ${field('secp', 'SECP registration', '(optional)', { max: 40 })}${field('eobi_no', 'EOBI employer number', '(optional)', { max: 40, hint: 'Shown on payslips once EOBI is on in Payroll rules.' })}</div></div>
        <div class="co-sec"><h3>Brand colour</h3><p class="hint">For the band at the top of documents and for net pay.${c.images.logo ? ' The first one is taken from your logo.' : ''}</p>
          <div class="co-sws" role="radiogroup" aria-label="Brand colour">
            ${c.images.logo ? html`<label class="co-sw" title="From your logo" data-own="sw-auto"><input type="radio" name="brand" value="" data-co-auto ${raw(!cur ? 'checked' : '')}><i data-co-autosw></i><span class="sr">From your logo</span></label>` : ''}
            ${PRESETS.map(([h, n]) => html`<label class="co-sw" title="${n}" data-own="sw-${h}"><input type="radio" name="brand" value="${h}" ${raw(cur.toLowerCase() === h.toLowerCase() ? 'checked' : '')}><i style="background:${h}"></i><span class="sr">${n}</span></label>`)}
            <label class="co-sw co-custom ${!isPreset && cur ? 'set' : ''}" title="Your own colour" data-own="sw-custom"><input type="radio" name="brand" value="${!isPreset && cur ? cur : '#3a6ea5'}" data-co-custom ${raw(cur && !isPreset ? 'checked' : '')}><i style="${!isPreset && cur ? `background:${cur}` : ''}" data-co-customsw></i><span class="sr">Your own colour</span></label>
            <label class="co-hex"><input type="color" value="${cur || c.auto_brand || '#6b4fe0'}" data-co-picker aria-label="Pick your own colour"><b data-co-hex>${cur || c.auto_brand || '#6b4fe0'}</b></label></div></div>
        <div class="co-sec"><h3>Who signs</h3><p class="hint">Goes on salary and tax certificates. Payslips don’t need a signature.</p>
          <div class="co-grid">${field('signer_name', 'Name', '', { max: 80 })}${field('signer_title', 'Title', '', { max: 80 })}</div>
          <div class="co-logos two">${slotCard(c, 'signature', { tall: true })}${slotCard(c, 'stamp', { tall: true })}</div></div>
        <div class="co-sec"><h3>Where this shows</h3>
          <ul class="co-uses">${['Payslips, on screen and as PDF', 'Salary and tax certificates', 'Client monthly statements', 'Bank sheet and accountant’s register', 'The client portal’s header'].map((t) => html`<li>${ok}${t}</li>`)}</ul>
          <p class="hint">A month already approved keeps the details it was approved with. New ones use these.</p></div>
        <div class="co-bar"><span class="co-state" data-co-state>${ok}All changes saved</span><button type="button" class="btn" data-act="co-sample">${icon('download')} Download a sample payslip</button><button class="btn primary" type="submit" data-co-save>Save changes</button></div>
        <p class="err" data-err role="alert"></p>
      </div>
      <aside class="co-pv" aria-label="Preview"><div class="co-pvh"><b>How it looks</b><div class="co-seg" role="tablist" aria-label="Preview"><button type="button" role="tab" aria-selected="true" data-act="co-tab" data-tab="slip">Payslip</button><button type="button" role="tab" aria-selected="false" data-act="co-tab" data-tab="cert">Certificate</button></div></div>
        <div class="co-paper" data-co-preview data-own="co-preview">${preview(c, 'slip')}</div>
        <p class="hint">Follows the form as you type. The figures are a sample.</p></aside>
      </div></form></div></section>`;
}

// ---------- after the page is drawn ----------
let coData = null, coTab = 'slip', autoBrand = null;
const formEl = () => document.querySelector('[data-coform]');
const formVals = (f) => ({ ...coData, auto: !!f.querySelector('[data-co-auto]:checked'), ...Object.fromEntries(['legal_name', 'name', 'address', 'phone', 'email', 'website', 'ntn', 'secp', 'eobi_no', 'signer_name', 'signer_title'].map((k) => [k, val(f, k)])), brand: brandOf(f) });
function brandOf(f) { const r = f.querySelector('input[name=brand]:checked'); return r ? (r.value || autoBrand || '') : coData.brand; }
// the chip beside the swatches: the colour in use, as a swatch and its code
function syncChip(f) { const v = brandOf(f) || '#6b4fe0'; const hx = f.querySelector('[data-co-hex]'), pk = f.querySelector('[data-co-picker]'); if (hx) hx.textContent = v; if (pk && pk.value.toLowerCase() !== v.toLowerCase()) pk.value = v; }
function redraw() {
  const f = formEl(); if (!f || !coData) return;
  const box = f.querySelector('[data-co-preview]'); box.innerHTML = preview(formVals(f), coTab).toString();
  paintAuthImages(f);
}
async function paintAuthImages(root) {
  for (const [slot, sel] of [['signature', '[data-co-sig]'], ['stamp', '[data-co-stamp]']]) {
    if (!coData.images[slot]) continue;
    let u = authUrls.get(slot);
    if (!u) { try { u = await fileUrl(`/api/company/images/${slot}?v=${Date.now()}`); authUrls.set(slot, u); } catch { continue; } }
    for (const img of root.querySelectorAll(`img[data-co-auth="${slot}"]`)) if (img.src !== u) img.src = u;
    const holder = root.querySelector(sel); if (holder && !holder.querySelector('img')) holder.innerHTML = `<img src="${u}" alt="">`;
  }
}
function markDirty(f) {
  const st = f.querySelector("[data-co-state]"); const dirty = JSON.stringify(pick(formVals(f))) !== JSON.stringify(pick(coData));
  st.classList.toggle('dirty', dirty);
  st.innerHTML = dirty ? 'Unsaved changes' : `${ok}All changes saved`;
}
const pick = (c) => { const auto = c.auto !== undefined ? c.auto : !c.brand; return { auto, legal_name: c.legal_name || '', name: c.name || '', address: c.address || '', phone: c.phone || '', email: c.email || '', website: c.website || '', ntn: c.ntn || '', secp: c.secp || '', eobi_no: c.eobi_no || '', signer_name: c.signer_name || '', signer_title: c.signer_title || '', brand: auto ? '' : String(c.brand || '').toLowerCase() }; };

// the colour most used in the logo, leaving out near-white, near-black, grey and see-through pixels
async function logoColour(url) {
  try {
    const img = await loadImg(url); const n = 64, cv = document.createElement('canvas'); cv.width = n; cv.height = n;
    const g = cv.getContext('2d'); g.drawImage(img, 0, 0, n, n);
    const d = g.getImageData(0, 0, n, n).data, bins = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const [r, gg, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]]; if (a < 200) continue;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b); if (mx > 235 || mx < 60 || (mx - mn) / mx < 0.35) continue;
      const k = `${r >> 4},${gg >> 4},${b >> 4}`; const e = bins.get(k) || [0, 0, 0, 0]; e[0] += r; e[1] += gg; e[2] += b; e[3]++; bins.set(k, e);
    }
    let best = null; for (const e of bins.values()) if (!best || e[3] > best[3]) best = e;
    if (!best) return null;
    let [r, gg, b] = best.slice(0, 3).map((x) => x / best[3]);
    // dark enough to carry white text and to read as a heading colour on paper
    const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b; if (lum > 120) { const k = 120 / lum; r *= k; gg *= k; b *= k; }
    return `#${[r, gg, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
  } catch { return null; }
}
const loadImg = (src) => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('That picture can’t be opened')); i.src = src; });

export async function companyAfter(view, c) {
  const f = view.querySelector('[data-coform]'); if (!f || !c) return;
  coData = c;
  if (c.images.logo && c.images.logo.url) {
    autoBrand = c.auto_brand || await logoColour(c.images.logo.url);
    const sw = f.querySelector('[data-co-autosw]'); if (sw) sw.style.background = autoBrand || '#6B4FE0';

  } else autoBrand = null;
  if (!f.dataset.wired) {
    f.dataset.wired = '1';
    f.addEventListener('input', (e) => {
      if (e.target.matches('[data-co-picker]')) { const r = f.querySelector('[data-co-custom]'); r.value = e.target.value; r.checked = true; const sw = f.querySelector('[data-co-customsw]'); sw.style.background = e.target.value; sw.parentElement.classList.add('set'); }
      if (e.target.name === 'brand' || e.target.matches('[data-co-picker]')) syncChip(f);
      redraw(); markDirty(f);
    });
    f.addEventListener('change', (e) => { if (e.target.matches('[data-co-file]')) { uploadPick(e.target); } else { redraw(); markDirty(f); } });
  }
  syncChip(f); redraw(); paintAuthImages(f); markDirty(f);
}

// a picked picture: drawn onto a canvas (any format, sized down), the paper taken out of a signature or
// stamp, the empty edges trimmed, and sent as PNG
async function toPng(file, slot) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const max = slot === 'icon' ? 512 : 1200;
    let w = img.naturalWidth || img.width || 600, h = img.naturalHeight || img.height || 200;
    const k = Math.min(1, max / Math.max(w, h)); w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.drawImage(img, 0, 0, w, h);
    const id = g.getImageData(0, 0, w, h), d = id.data;
    if (slot === 'signature' || slot === 'stamp') {
      for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; if (l > 215) d[i + 3] = 0; else if (l > 160) d[i + 3] = Math.round(d[i + 3] * (215 - l) / 55); }
      g.putImageData(id, 0, 0);
    }
    // a see-through logo with white parts was made for dark backgrounds: on white paper those parts vanish
    let see = 0, solid = 0, white = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 250) see++; if (d[i + 3] > 200) { solid++; if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++; } }
    const clear = see > (w * h) * 0.05;
    const whiteParts = clear && solid > 0 && white / solid > 0.06;
    // trim see-through edges, and plain white ones on a logo with a white background
    const empty = (i) => d[i + 3] < 12 || ((slot === 'logo' || slot === 'icon') && !clear && d[i] > 248 && d[i + 1] > 248 && d[i + 2] > 248);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!empty((y * w + x) * 4)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) throw new Error('That picture looks empty');
    const pad = 4, tw = Math.min(w, x1 - x0 + 1 + pad * 2), th = Math.min(h, y1 - y0 + 1 + pad * 2);
    const out = document.createElement('canvas'); out.width = tw; out.height = th;
    out.getContext('2d').drawImage(cv, Math.max(0, x0 - pad), Math.max(0, y0 - pad), tw, th, 0, 0, tw, th);
    const asBlob = (c) => new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('That picture can’t be read'))), 'image/png'));
    const blob = await asBlob(out);
    blob.whiteParts = whiteParts;
    // for white paper: the same logo with its white and near-white parts in dark ink
    if (whiteParts) {
      const g2 = out.getContext('2d'), od = g2.getImageData(0, 0, tw, th), q = od.data;
      for (let i = 0; i < q.length; i += 4) { const l = 0.299 * q[i] + 0.587 * q[i + 1] + 0.114 * q[i + 2], sat = Math.max(q[i], q[i + 1], q[i + 2]) - Math.min(q[i], q[i + 1], q[i + 2]); if (q[i + 3] > 0 && l > 200 && sat < 40) { q[i] = 22; q[i + 1] = 18; q[i + 2] = 58; } }
      const dk = document.createElement('canvas'); dk.width = tw; dk.height = th; dk.getContext('2d').putImageData(od, 0, 0);
      blob.dark = await asBlob(dk);
    }
    return blob;
  } finally { URL.revokeObjectURL(url); }
}
async function uploadPick(input) {
  const slot = input.dataset.coFile, file = input.files && input.files[0]; input.value = '';
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) { toast('That picture is over 15 MB. Pick a smaller one.', true); return; }
  const card = input.closest('.co-lg'); if (card) card.classList.add('busy');
  try {
    const png = await toPng(file, slot);
    const send = async (to, body) => {
      const res = await fetch(`/api/company/images/${to}`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'image/png' }, body });
      const outp = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(outp.error || 'The upload didn’t go through. Try again.');
    };
    let to = slot;
    if (slot === 'logo' && png.whiteParts) {
      if (card) card.classList.remove('busy');
      const both = await confirmBox({ title: 'Part of this logo is white', message: 'Its white parts would disappear on white payslips. Staffwarden can keep this one as the light version, for dark headers, and make the full logo from it with the white parts in dark ink.', confirm: 'Make both versions', cancel: 'Keep it as it is' });
      if (card) card.classList.add('busy');
      if (both) { await send('logo_light', png); await send('logo', png.dark); to = 'both'; }
      else await send('logo', png);
    } else await send(slot, png);
    authUrls.delete(slot);
    toast(to === 'both' ? 'Full logo and light version saved' : `${SLOTS[slot][0]} saved`);
    S.refresh();
  } catch (e) { toast(errMsg(e), true); } finally { if (card) card.classList.remove('busy'); }
}

actions['co-save'] = async (form) => {
  const err = form.querySelector('[data-err]'), btn = form.querySelector('[data-co-save]'); err.textContent = '';
  const v = formVals(form);
  if (!v.name) { err.textContent = 'Give the company a name people know'; form.elements.name.focus(); return; }
  btn.disabled = true;
  try {
    const body = pick(v); if (form.querySelector('[data-co-auto]:checked')) body.brand = '';
    coData = await put('/api/company', body);
    if (S.settings) S.settings.org_name = coData.name;
    form.querySelectorAll('[data-dirty]').forEach((x) => delete x.dataset.dirty);
    markDirty(form); toast('Company details saved'); S.refresh();
  } catch (e) { err.textContent = errMsg(e); } finally { btn.disabled = false; }
};
actions['co-img-rm'] = async (el) => {
  if (!(await confirmBox({ title: `Remove the ${el.dataset.label.toLowerCase()}?`, message: 'New payslips and documents go out without it. Months already approved keep theirs.', confirm: 'Remove', danger: true }))) return;
  try { await del(`/api/company/images/${el.dataset.slot}`); authUrls.delete(el.dataset.slot); toast(`${el.dataset.label} removed`); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
actions['co-tab'] = (el) => {
  coTab = el.dataset.tab;
  for (const b of el.parentElement.querySelectorAll('button')) b.setAttribute('aria-selected', String(b === el));
  redraw();
};
actions['co-sample'] = async (el) => {
  const f = formEl(); if (f && f.querySelector('[data-co-state].dirty')) { toast('Save your changes first, so the sample shows them', true); return; }
  el.disabled = true; try { await download('/api/company/sample.pdf', 'sample-payslip.pdf'); } catch (e) { toast(errMsg(e), true); } finally { el.disabled = false; }
};
export const loadCompany = () => get('/api/company').catch(() => null);
