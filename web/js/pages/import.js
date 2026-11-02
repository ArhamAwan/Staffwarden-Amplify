// Import people from their contracts. Everything is read here in the browser: typed PDFs are read
// directly, scans and photos go through OCR. HR checks every field before anyone is created.
import { html, raw, icon, plural, initials, avColor, money, dateY } from '../util.js';
import { get, post, fileBase64 } from '../api.js';
import { S, actions, tag, toast, errMsg, confirmBox } from '../ui.js';
import { parseContract, joinItems } from '../contract-parse.js';
import { CONTRACT } from './hr.js';

// one entry per file: status reading | done | error
const st = { files: [], phase: 'pick', results: [], people: [] };
let seq = 0;
const FIELDS = ['name', 'email', 'title', 'joined_on', 'base', 'currency', 'contract', 'probation_end', 'notice_days', 'phone', 'cnic', 'bank_name', 'account_title', 'iban', 'address', 'pay_from'];
const NEEDED = ['name', 'email', 'title', 'joined_on', 'base'];
const LABEL = { name: 'Full name', email: 'Email (their sign-in)', title: 'Job title', joined_on: 'Joined', base: 'Base salary, a month', currency: 'Currency', contract: 'Contract', probation_end: 'Probation ends', notice_days: 'Notice (days)', phone: 'Phone', cnic: 'CNIC', bank_name: 'Bank', account_title: 'Account title', iban: 'IBAN', address: 'Address', pay_from: 'New pay from' };
const KIND = { promotion: 'promotion agreement', increment: 'salary increment agreement', amendment: 'amended or extended contract' };

export default {
  title: 'Import from contracts',
  async load() { st.people = await get('/api/hr/people?all=1'); return {}; },
  render() {
    const head = html`<div class="page-h"><div><h1>Import from contracts</h1><p class="sub">Add people from their employment contracts. Staffwarden reads each one, you check what it found, then it creates their account and HR record.</p></div>
      <div class="tools"><a class="btn" href="#/hr">${icon('left')} People and pay</a></div></div>`;
    if (st.phase === 'done') return html`${head}${doneView()}`;
    if (!st.files.length) return html`${head}${pickView()}`;
    return html`${head}${reviewView()}`;
  },
};

// ---------- choosing files ----------
function pickView() {
  return html`<section class="panel imp-pick" data-k="pick"><div class="body">
    <label class="imp-drop" data-drop>
      <span class="imp-ic">${icon('file')}</span>
      <b>Choose contracts</b>
      <span>PDFs, or photos and scans of paper contracts. One person per file. Choose as many as you like.</span>
      <input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/webp" data-imp-files>
      <span class="btn primary" aria-hidden="true">${icon('plus')} Choose files</span>
    </label>
    <ul class="imp-how">
      <li>${icon('lock')}<div><b>Read on this computer</b><span>The files are read in your browser. Only what you approve is saved, on Staffwarden’s own server.</span></div></li>
      <li>${icon('eye')}<div><b>You check everything first</b><span>Scans and photos can be misread. Nobody is created until you press Create.</span></div></li>
      <li>${icon('users')}<div><b>Matches people already here</b><span>If someone already has an account, their record is updated instead.</span></div></li>
    </ul></div></section>`;
}

// ---------- checking what was read ----------
const matchOf = (f) => {
  const email = (f.v.email || '').trim().toLowerCase(), name = (f.v.name || '').trim().toLowerCase();
  return st.people.find((p) => email && p.email && p.email.toLowerCase() === email) || st.people.find((p) => name && p.name.toLowerCase() === name) || null;
};
function reviewView() {
  const reading = st.files.filter((f) => f.status === 'reading').length;
  const ready = st.files.filter((f) => f.status === 'done' && f.include);
  const upd = ready.filter((f) => matchOf(f)).length, add = ready.length - upd;
  const saving = st.phase === 'saving';
  const bar = html`<div class="imp-bar" data-k="bar"><div>${reading ? html`<b>Reading ${plural(reading, 'file')}…</b><span>You can start checking the ones that are done.</span>`
      : html`<b>${ready.length ? [add ? `Create ${plural(add, 'person', 'people')}` : '', upd ? `update ${plural(upd, 'person', 'people')}` : ''].filter(Boolean).join(', ').replace(/^u/, 'U') : 'Nothing selected'}</b><span>A green dot means it was found in the contract. Yellow fields were not.${add ? ' New people get a first password to sign in with.' : ''}</span>`}</div>
    <span class="imp-bar-a"><label class="btn"><input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/webp" data-imp-files hidden>${icon('plus')} Add more</label>
      <button class="btn" data-act="imp-reset" ${saving ? raw('disabled') : ''}>Start over</button>
      <button class="btn primary" data-act="imp-save" ${!ready.length || reading || saving ? raw('disabled') : ''}>${saving ? 'Saving…' : ready.length ? (add && !upd ? `Create ${plural(add, 'person', 'people')}` : 'Save') : 'Create'}</button></span></div>`;
  return html`${bar}<div class="imp-list">${st.files.map(card)}</div>`;
}
function card(f) {
  if (f.status === 'reading') return html`<section class="panel imp-card reading" data-k="f${f.id}"><div class="body"><div class="imp-h"><span class="doc-ic">${icon('file')}</span><div><b>${f.file.name}</b><span data-prog-t="${f.id}">${f.stage || 'Opening'}…</span></div></div>
    <span class="imp-prog"><i data-prog="${f.id}" style="width:${Math.round((f.progress || 0) * 100)}%"></i></span></div></section>`;
  if (f.status === 'error') return html`<section class="panel imp-card" data-k="f${f.id}"><div class="body"><div class="imp-h"><span class="doc-ic bad">${icon('file')}</span><div><b>${f.file.name}</b><span class="bad-t">${f.error}</span></div><button class="btn sm" data-act="imp-drop" data-id="${f.id}">Remove</button></div></div></section>`;
  const m = matchOf(f), v = f.v, miss = (k) => (NEEDED.includes(k) || k === 'iban') && (v[k] == null || v[k] === '');
  const err = f.saveError;
  const now = (k) => { if (!m || k === 'email' || k === 'name') return null; const c = k === 'title' ? m.title : k === 'base' ? (m.pay ? m.pay.base : null) : k === 'currency' ? null : m.record[k]; return c == null || c === '' || String(c).replace(/\s/g, '').toLowerCase() === String(v[k] ?? '').replace(/\s/g, '').toLowerCase() ? null : c; };
  const was = (k) => { const c = now(k); if (c == null || (k === 'base' && !f.usePay)) return ''; const shown = k === 'base' ? money(c, m.pay.currency) : k === 'contract' ? CONTRACT[c] : /_on$|_end$/.test(k) ? dateY(c) : c;
    return html`<p class="hint was">${v[k] == null || v[k] === '' ? `Left empty, so ${shown} is kept` : `Replaces ${shown}`}</p>`; };
  const inp = (k, attrs = '') => html`<div class="field ${miss(k) ? 'miss' : ''} ${f.parsed.found.includes(k) || (k === 'probation_end' && f.parsed.found.includes('probation')) ? 'got' : ''}"><label class="f" for="i${f.id}${k}">${LABEL[k]}</label><input id="i${f.id}${k}" data-imp="${f.id}" data-f="${k}" value="${v[k] ?? ''}" ${raw(attrs)} ${k === 'base' && m && m.pay && !f.usePay ? raw('disabled') : ''}>${miss(k) && !(k === 'base' && m && m.pay && !f.usePay) ? html`<p class="hint">Not found in the contract</p>` : ''}${was(k)}</div>`;
  const sel = (k, opts) => html`<div class="field"><label class="f" for="i${f.id}${k}">${LABEL[k]}</label><select id="i${f.id}${k}" data-imp="${f.id}" data-f="${k}" ${k === 'currency' && m && m.pay && !f.usePay ? raw('disabled') : ''}>${opts.map(([val, n]) => html`<option value="${val}" ${v[k] === val ? raw('selected') : ''}>${n}</option>`)}</select>${was(k)}</div>`;
  const found = NEEDED.filter((k) => !miss(k)).length;
  return html`<section class="panel imp-card ${f.include ? '' : 'off'} ${err ? 'has-err' : ''}" data-k="f${f.id}"><div class="body">
    <div class="imp-h"><label class="imp-inc" title="${f.include ? 'Leave this one out' : 'Include this one'}"><input type="checkbox" data-imp="${f.id}" data-f="include" ${f.include ? raw('checked') : ''}><span class="sr">Include ${f.file.name}</span></label>
      <span class="avatar" style="background:${avColor(m ? m.id : 900 + f.id)}" aria-hidden="true">${initials(v.name || f.file.name)}</span>
      <div><b>${v.name || f.file.name}</b><span>${f.file.name} · ${f.method === 'ocr' ? 'read by OCR, check it carefully' : 'read from the PDF text'}</span></div>
      <span class="imp-tags">${m ? tag('idle', `Updates ${m.name}`) : tag('working', 'New person')}${found < NEEDED.length ? tag('break', `${NEEDED.length - found} to fill in`) : ''}</span></div>
    ${err ? html`<p class="imp-err" role="alert">${icon('x')} ${err}</p>` : ''}
    ${KIND[f.parsed.kind] ? html`<p class="imp-kind">${icon('file')} <span>This is a <b>${KIND[f.parsed.kind]}</b>. The job and salary are the new ones${v.pay_from ? `, paid from ${dateY(v.pay_from)}` : ''}. Joined is their first day under the original contract.</span></p>` : ''}
    ${m && m.pay ? html`<label class="imp-pay"><input type="checkbox" data-imp="${f.id}" data-f="usePay" ${f.usePay ? raw('checked') : ''}><span><b>Also change their pay to the contract’s salary</b> Their pay is ${money(m.pay.base, m.pay.currency)} a month now. ${KIND[f.parsed.kind] ? 'This agreement changes their pay, so this starts on.' : 'An old contract may show an older salary, so this is off unless you turn it on.'}</span></label>` : ''}
    <div class="imp-grid">
      ${inp('name', 'maxlength="100" autocomplete="off"')}${inp('email', 'type="email" maxlength="200" autocomplete="off"')}${inp('title', 'maxlength="100"')}
      ${inp('joined_on', 'type="date"')}${inp('base', 'type="number" min="0" step="1" inputmode="numeric" class="num"')}${sel('currency', [['PKR', 'Rupees (Rs)'], ['USD', 'Dollars ($)']])}
      ${sel('contract', Object.entries(CONTRACT))}${inp('probation_end', 'type="date"')}${inp('notice_days', 'type="number" min="0" max="365"')}
      ${inp('phone', 'maxlength="40"')}${inp('cnic', 'maxlength="15" placeholder="61101-1234567-1"')}${inp('bank_name', 'maxlength="80"')}
      ${inp('account_title', 'maxlength="100"')}${inp('iban', 'maxlength="40" autocomplete="off"')}${inp('address', 'maxlength="300"')}${KIND[f.parsed.kind] ? inp('pay_from', 'type="date"') : ''}
    </div>
    <details class="imp-text"><summary>Show the text Staffwarden read</summary><pre>${f.text.slice(0, 8000)}</pre></details>
    ${m && v.email && m.email.toLowerCase() !== v.email.trim().toLowerCase() ? html`<p class="small muted">${m.name} signs in as ${m.email}. Their sign-in email is not changed.</p>` : ''}
  </div></section>`;
}

// ---------- after saving ----------
function doneView() {
  const made = st.results.filter((r) => r.created), upd = st.results.filter((r) => !r.created);
  return html`<section class="panel" data-k="done"><header><h2>${[made.length ? `${plural(made.length, 'person', 'people')} added` : '', upd.length ? `${plural(upd.length, 'person', 'people')} updated` : ''].filter(Boolean).join(', ')}</h2></header><div class="body">
    ${made.length ? html`<div class="banner warn"><span><b>Copy these first passwords now.</b> They are shown only once. Give each person theirs privately. They can change it on their Profile page.</span></div>` : ''}
    <ul class="imp-done">${st.results.map((r) => html`<li data-k="r${r.id}"><span class="avatar" style="background:${avColor(r.id)}" aria-hidden="true">${initials(r.name)}</span><div><b>${r.name}</b><span>${r.email}${r.doc ? ' · contract kept in their documents' : ''}${r.docError ? ` · contract not kept: ${r.docError}` : ''}</span></div>
      ${r.password ? html`<code class="imp-pw">${r.password}</code><button class="btn sm" data-act="imp-copy" data-pw="${r.password}" data-email="${r.email}">Copy</button>` : tag('idle', 'Record updated')}<a class="btn sm" href="#/hr?id=${r.id}">Open</a></li>`)}</ul>
    ${made.length > 1 ? html`<p><button class="btn" data-act="imp-copy-all">Copy all as a list</button></p>` : ''}
    <div class="form-end"><button class="btn" data-act="imp-reset">Import more</button><a class="btn primary" href="#/hr">Done</a></div></div></section>`;
}

// ---------- reading ----------
const scripts = {};
function script(src) {
  return scripts[src] || (scripts[src] = new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => { delete scripts[src]; bad(new Error('Could not load the reader. Check your connection and try again.')); }; document.head.appendChild(s); }));
}
async function pdfLib() { await script('/vendor/pdf/pdf.min.js'); const L = window.pdfjsLib; L.GlobalWorkerOptions.workerSrc = '/vendor/pdf/pdf.worker.min.js'; return L; }
let ocrWorker = null;
let ocrFor = null;   // the file the OCR progress belongs to
async function ocr() {
  if (ocrWorker) return ocrWorker;
  await script('/vendor/tess/tesseract.min.js');
  ocrWorker = window.Tesseract.createWorker('eng', 1, {
    workerPath: '/vendor/tess/worker.min.js', corePath: '/vendor/tess/core', langPath: '/vendor/tess/lang', workerBlobURL: false, gzip: true,
    logger: (m) => { if (ocrFor && m.status === 'recognizing text') progress(ocrFor, ocrFor.base + m.progress * ocrFor.span, ocrFor.stageText); },
  });
  try { return await ocrWorker; } catch (e) { ocrWorker = null; throw e; }
}
function progress(f, p, stage) {
  f.progress = p; if (stage) f.stage = stage;
  const bar = document.querySelector(`[data-prog="${f.id}"]`); if (bar) bar.style.width = `${Math.round(p * 100)}%`;
  const t = document.querySelector(`[data-prog-t="${f.id}"]`); if (t && stage) t.textContent = `${stage}…`;
}
async function ocrImage(f, img, base, span, stageText) {
  const w = await ocr();
  ocrFor = Object.assign(f, { base, span, stageText });
  progress(f, base, stageText);
  const { data } = await w.recognize(img);
  return data.text || '';
}
async function pdfText(f) {
  const L = await pdfLib();
  const doc = await L.getDocument({ data: new Uint8Array(await f.file.arrayBuffer()), isEvalSupported: false }).promise;
  // the text of every page (long contracts put notice and bank details near the end); OCR, which is slow,
  // only reads the first 12 pages of a scan
  const all = Math.min(doc.numPages, 60), pages = Math.min(doc.numPages, 12);
  let text = '';
  for (let i = 1; i <= all; i++) {
    const page = await doc.getPage(i);
    const c = await page.getTextContent();
    text += joinItems(c.items) + '\n\n';
    progress(f, (i / all) * 0.3, 'Reading the text');
  }
  if (text.replace(/\s/g, '').length >= 200) return { text, method: 'text' };
  // a scan saved as a PDF: draw each page and read it with OCR
  let out = '';
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 2 });
    const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    out += (await ocrImage(f, cv, 0.3 + ((i - 1) / pages) * 0.7, 0.7 / pages, `Reading page ${i} of ${pages} by OCR`)) + '\n\n';
  }
  return { text: out, method: 'ocr' };
}
async function read(f) {
  try {
    if (f.file.size > 20 * 1024 * 1024) throw new Error('This file is over 20 MB');
    const isPdf = f.file.type === 'application/pdf' || /\.pdf$/i.test(f.file.name);
    if (!isPdf && !/^image\//.test(f.file.type)) throw new Error('Choose a PDF or an image');
    const r = isPdf ? await pdfText(f) : { text: await ocrImage(f, f.file, 0.05, 0.95, 'Reading it by OCR'), method: 'ocr' };
    if (r.text.replace(/\s/g, '').length < 30) throw new Error('No text could be read. Try a sharper scan or photo.');
    const p = parseContract(r.text);
    Object.assign(f, { status: 'done', text: r.text, method: r.method, parsed: p, include: true, usePay: p.kind !== 'new', v: Object.fromEntries(FIELDS.map((k) => [k, p[k] ?? (k === 'currency' ? 'PKR' : k === 'contract' ? 'full_time' : '')])) });
  } catch (e) { Object.assign(f, { status: 'error', error: errMsg(e) }); }
  S.refresh();
}
async function addFiles(list) {
  const fresh = Array.from(list || []).map((file) => ({ id: ++seq, file, status: 'reading', progress: 0 }));
  if (!fresh.length) return;
  st.files.push(...fresh); st.phase = 'review';
  S.refresh();
  for (const f of fresh) await read(f);     // one at a time: OCR is heavy
}

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches && t.matches('[data-imp-files]')) { addFiles(t.files); t.value = ''; return; }
  if (t.dataset && t.dataset.imp) { edit(t); S.refresh(); }
});
document.addEventListener('input', (e) => { const t = e.target; if (t.dataset && t.dataset.imp && t.type !== 'checkbox') edit(t); });
function edit(t) {
  const f = st.files.find((x) => x.id === Number(t.dataset.imp)); if (!f || !f.v) return;
  if (t.dataset.f === 'include') f.include = t.checked; else if (t.dataset.f === 'usePay') f.usePay = t.checked; else f.v[t.dataset.f] = t.value;
  f.saveError = null;
}
document.addEventListener('dragover', (e) => { const d = e.target.closest && e.target.closest('[data-drop]'); if (d) { e.preventDefault(); d.classList.add('over'); } });
document.addEventListener('dragleave', (e) => { const d = e.target.closest && e.target.closest('[data-drop]'); if (d) d.classList.remove('over'); });
document.addEventListener('drop', (e) => { const d = e.target.closest && e.target.closest('[data-drop]'); if (d) { e.preventDefault(); d.classList.remove('over'); addFiles(e.dataTransfer.files); } });

// ---------- saving ----------
const DOC_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
actions['imp-save'] = async () => {
  const list = st.files.filter((f) => f.status === 'done' && f.include);
  const bad = list.find((f) => !String(f.v.name || '').trim() || (!matchOf(f) && !String(f.v.email || '').trim()));
  if (bad) { bad.saveError = String(bad.v.name || '').trim() ? 'Add their email: it is how they sign in.' : 'Add their name.'; S.refresh(); toast('Some contracts need a name or email', true); return; }
  const add = list.filter((f) => !matchOf(f)).length;
  if (!(await confirmBox({ title: add && list.length - add ? `Create ${plural(add, 'person', 'people')} and update ${list.length - add}?` : add ? `Create ${plural(add, 'person', 'people')}?` : `Update ${plural(list.length, 'person', 'people')}?`, message: `${add ? `${add === 1 ? 'They get' : 'Each gets'} an account, an HR record and their pay. ` : ''}${list.length - add ? 'People already here have their record updated, and their pay only where you turned that on. ' : ''}The contract file is kept in each person’s documents.`, confirm: add ? 'Create' : 'Update' }))) return;
  st.phase = 'saving'; S.refresh();
  const done = [];
  for (const f of list) {
    const m = matchOf(f), v = f.v, val = (k) => (v[k] === '' || v[k] == null ? undefined : String(v[k]).trim());
    const record = {};
    for (const k of ['contract', 'joined_on', 'probation_end', 'phone', 'cnic', 'address', 'bank_name', 'account_title', 'iban']) if (val(k) !== undefined) record[k] = val(k);
    if (val('notice_days') !== undefined) record.notice_days = Number(val('notice_days'));
    const base = Number(val('base'));
    const pay = base > 0 && (!m || !m.pay || f.usePay) ? { base, currency: v.currency, tax_mode: v.currency === 'PKR' && v.contract !== 'contractor' ? 'pk' : 'none', effective_from: val('pay_from') || val('joined_on') || undefined, note: 'From their contract' } : undefined;
    try {
      const r = await post('/api/hr/import', { existing_id: m ? m.id : undefined, name: val('name'), email: val('email'), title: val('title'), record, pay });
      if (DOC_TYPES.includes(f.file.type) && f.file.size <= 5 * 1024 * 1024) {
        try { await post(`/api/hr/people/${r.id}/docs`, { name: 'Employment contract', kind: 'contract', status: 'signed', type: f.file.type, data_base64: await fileBase64(f.file) }); r.doc = true; } catch (e) { r.docError = errMsg(e); }
      } else r.docError = 'the file is over 5 MB';
      done.push(r); f.saved = true;
    } catch (e) { f.saveError = errMsg(e); }
  }
  st.results.push(...done);
  st.files = st.files.filter((f) => !f.saved);
  const left = st.files.filter((f) => f.saveError).length;
  st.phase = left ? 'review' : 'done';
  if (left) toast(`${plural(left, 'contract')} could not be saved. Fix ${left === 1 ? 'it' : 'them'} and try again.`, true);
  else { st.files = []; }
  if (left && done.length) toast(`${plural(done.length, 'person', 'people')} saved. Their passwords are shown when you finish.`);
  S.refresh();
};
actions['imp-reset'] = () => { st.files = []; st.results = []; st.phase = 'pick'; S.refresh(); };
actions['imp-drop'] = (el) => { st.files = st.files.filter((f) => f.id !== Number(el.dataset.id)); if (!st.files.length) st.phase = 'pick'; S.refresh(); };
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy it by hand: your browser blocked copying', true); } }
actions['imp-copy'] = (el) => copy(`${el.dataset.email}\n${el.dataset.pw}`);
actions['imp-copy-all'] = () => copy(st.results.filter((r) => r.password).map((r) => `${r.name}\t${r.email}\t${r.password}`).join('\n'));
