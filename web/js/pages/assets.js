// Assets: everything for one client in one place, on the client's page and on each of their projects.
// Brand (logos, colours, fonts), links, files and pictures, where logins are kept, and notes.
// Designed on the "Client assets" canvas. Search and the kind filter work instantly on the page; adding
// takes anything (a link, a colour code, a note, files) and works out what it is.
import { html, raw, esc, relTime, plural, initials, avColor, copyText } from '../util.js';
import { get, post, patch, del, download, fileUrl, fileBase64, getToken } from '../api.js';
import { S, actions, toast, errMsg, openModal, confirmBox } from '../ui.js';

const KINDS = [['all', 'All'], ['brand', 'Brand'], ['links', 'Links'], ['files', 'Files'], ['logins', 'Logins'], ['notes', 'Notes']];
const isImg = (a) => /^image\/(png|jpeg|webp|gif)$/.test(a.mime || '');
const isPdf = (a) => a.mime === 'application/pdf' || /\.pdf$/i.test(a.file_name || '');
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const BIG = 4 * 1024 * 1024, MAX = 50 * 1024 * 1024;
const I = (d, s = 18, sw = 2) => raw(`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`);
const IC = {
  plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', up: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  img: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8 8"/>', globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.6 5.4 3.6 8.5s-1.2 5.9-3.6 8.5c-2.4-2.6-3.6-5.4-3.6-8.5s1.2-5.9 3.6-8.5z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>', dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', pen: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h5"/>',
};

// ---------- loading ----------
let cur = null;           // { scope, assets, where: {client}|{project} }
const view = { kind: 'all', q: '' };
export async function loadAssets(where) {
  const data = await get(`/api/assets?${where.client ? `client=${where.client}` : `project=${where.project}`}`);
  cur = { ...data, where };
  return cur;
}
// only the newest version of each piece of work shows; older ones are in the picture's window
const latest = (list) => { const m = new Map(); for (const a of list) { const k = a.chain_id || a.id; if (!m.has(k) || m.get(k).version < a.version) m.set(k, a); } return [...m.values()]; };

// ---------- the panel ----------
export function assetsPanel(data, { onProject = false } = {}) {
  cur = { ...cur, ...data };
  const s = data.scope, list = latest(data.assets);
  const by = (sec) => list.filter((a) => a.section === sec);
  const counts = Object.fromEntries(KINDS.map(([k]) => [k, k === 'all' ? list.length : by(k).length]));
  const searchText = (a) => esc([a.title, a.value, a.url, a.note, a.file_name, a.host].filter(Boolean).join(' ').toLowerCase());
  const who = (a) => (!s.has_client || a.kind === 'login' ? '' : a.shared ? html`<span class="as-who shared" title="${s.name} sees this">${I(IC.eye, 13, 2.2)}Shared</span>` : '');
  if (!list.length) return emptyState(s, onProject);

  const brand = by('brand'), logos = brand.filter((a) => a.kind === 'file' && isImg(a)), colors = brand.filter((a) => a.kind === 'color'), fonts = brand.filter((a) => a.kind === 'font'), brandOther = brand.filter((a) => !logos.includes(a) && !colors.includes(a) && !fonts.includes(a));
  const sec = (key, title, extra, inner, n) => html`<section class="as-sec as-card" data-sec="${key}" aria-label="${title}"><div class="as-ch"><h2>${title}</h2>${extra || html`<span class="muted small">${n}</span>`}</div>${inner}</section>`;
  const linkRow = (a) => html`<li class="as-item" data-k="a${a.id}" data-as-s="${raw(searchText(a))}"><span class="as-fav" style="background:${avColor(900 + (a.host || a.title).length)}">${(a.host || a.title || '?')[0].toUpperCase()}</span>
    <button type="button" class="as-t" data-act="as-edit" data-id="${a.id}"><b>${a.title}</b><span>${a.host || a.url}${a.note ? ` · ${a.note}` : ''}</span></button>${who(a)}
    <button type="button" class="btn sm icon" data-act="as-copy" data-v="${a.url}" aria-label="Copy the link to ${a.title}" title="Copy the link">${I(IC.copy, 16)}</button><a class="btn sm" href="${a.url}" target="_blank" rel="noopener noreferrer">Open</a></li>`;
  const textRow = (a, icon) => html`<li class="as-item" data-k="a${a.id}" data-as-s="${raw(searchText(a))}"><span class="as-fav ${a.kind === 'login' ? 'as-lock' : 'as-notei'}">${I(icon, 18)}</span>
    <button type="button" class="as-t" data-act="as-edit" data-id="${a.id}"><b>${a.title}</b><span class="as-pre">${a.value}</span>${a.kind === 'note' ? html`<span class="faint">${a.by || 'Someone'} · ${relTime(a.updated_at)}</span>` : ''}</button>${who(a)}</li>`;
  const tile = (a) => html`<li class="as-file" data-k="a${a.id}" data-as-s="${raw(searchText(a))}"><button type="button" class="as-pic" data-act="as-open" data-id="${a.id}" aria-label="Open ${a.title}">${thumb(a)}${a.task ? html`<span class="as-badge">${a.version > 1 ? `V${a.version} · ` : ''}Approved</span>` : a.from_client ? html`<span class="as-badge">From ${s.name.split(' ')[0]}</span>` : ''}</button><b>${a.title}</b><span>${[a.task && a.task.key ? `From ${a.task.key}` : a.from_client ? `Sent by ${a.by}` : '', isPdf(a) ? 'PDF' : isImg(a) ? '' : (a.file_name || '').split('.').pop().toUpperCase(), kb(a.size)].filter(Boolean).join(' · ')}</span>${a.shared && s.has_client ? html`<span class="as-who shared">${I(IC.eye, 13, 2.2)}Shared</span>` : ''}</li>`;

  const files = by('files').slice().reverse();   // newest first
  return html`<div class="as" data-kind="${view.kind}">
    <div class="as-bar">
      <label class="as-search">${I(IC.search)}<span class="sr">Search assets</span><input type="search" data-as-q value="${view.q}" placeholder="Search logos, links, files, notes" autocomplete="off"></label>
      <div class="as-kinds" role="group" aria-label="Show">${KINDS.map(([k, n]) => html`<button type="button" class="as-kind" aria-pressed="${String(view.kind === k)}" data-act="as-kind" data-v="${k}">${n} <span>${counts[k]}</span></button>`)}</div>
      <button type="button" class="btn primary" data-act="as-add">${I(IC.plus, 16, 2.4)}Add</button>
    </div>
    ${onProject ? html`<p class="muted as-scope">${s.has_client ? html`These are <b>${s.name}</b>’s assets. Anything added here is saved to the client, so their other projects have it too.` : html`This project has no client yet. Its assets stay here, and move to the client when you link one.`}</p>` : ''}
    ${brand.length ? sec('brand', 'Brand', html`<span class="muted small">Click a colour to copy it</span>`, html`
      ${logos.length ? html`<ul class="as-logos">${logos.map((a) => html`<li data-k="a${a.id}" data-as-s="${raw(searchText(a))}"><button type="button" class="as-logo" data-act="as-open" data-id="${a.id}" aria-label="Open ${a.title}">${thumb(a)}</button><b>${a.title}</b><span>${(a.file_name || '').split('.').pop().toUpperCase()} · ${kb(a.size)}</span></li>`)}</ul>` : ''}
      ${colors.length ? html`<ul class="as-swatches" aria-label="Colours">${colors.map((a) => html`<li data-k="a${a.id}" data-as-s="${raw(searchText(a))}"><button type="button" class="as-sw" data-act="as-copy" data-v="${a.value}" title="Copy ${a.value}"><i style="background:${a.value}"></i><span>${a.title !== a.value ? a.title : ''}<small>${a.value}</small></span></button><button type="button" class="as-swx" data-act="as-edit" data-id="${a.id}" aria-label="Change ${a.title}">${I(IC.pen, 13)}</button></li>`)}</ul>` : ''}
      ${fonts.length || brandOther.length ? html`<ul class="as-fonts">${fonts.map((a) => html`<li data-k="a${a.id}" data-as-s="${raw(searchText(a))}"><button type="button" class="as-font" data-act="as-edit" data-id="${a.id}"><b style="font-family:'${a.value.replace(/['"\\]/g, '')}',serif">${a.value}</b><span>${a.title !== a.value ? a.title : 'Font'}${a.note ? ` · ${a.note}` : ''}</span></button></li>`)}${brandOther.map((a) => html`<li data-k="a${a.id}" data-as-s="${raw(searchText(a))}"><button type="button" class="as-font" data-act="as-open" data-id="${a.id}"><b style="font-size:16px;font-weight:600">${a.title}</b><span>${(a.file_name || '').split('.').pop().toUpperCase()} · ${kb(a.size)}${a.by ? ` · added by ${a.by}` : ''}</span></button></li>`)}</ul>` : ''}`) : ''}
    ${by('links').length || by('logins').length || by('notes').length ? html`<div class="as-g2">
      ${by('links').length ? sec('links', 'Links', '', html`<ul class="as-list">${by('links').map(linkRow)}</ul>`, by('links').length) : ''}
      <div class="as-col">
        ${by('logins').length ? sec('logins', 'Logins', html`<span class="tag warn as-team">${I(IC.lock, 12, 2.4)}Team only</span>`, html`<p class="muted small as-hint">Passwords stay in your password manager. Save here where to find each one.</p><ul class="as-list">${by('logins').map((a) => textRow(a, IC.lock))}</ul>`) : ''}
        ${by('notes').length ? sec('notes', 'Notes', '', html`<ul class="as-list">${by('notes').map((a) => textRow(a, IC.note))}</ul>`, by('notes').length) : ''}
      </div></div>` : ''}
    ${files.length ? sec('files', 'Files and pictures', html`<span class="muted small">${files.length} · newest first</span>`, html`<ul class="as-files">${files.map(tile)}</ul>`) : ''}
    <p class="as-none muted" hidden>Nothing matches. Try another word.</p>
  </div>`;
}

function thumb(a) {
  if (isImg(a)) { const src = `/api/assets/${a.id}/file?inline=1`; return html`<img alt="" data-asimg="${src}" ${raw(imgs.get(src) ? `src="${imgs.get(src)}"` : '')}>`; }
  return html`<span class="as-doc" aria-hidden="true"><i style="width:70%"></i><i style="width:90%"></i><i style="width:55%"></i><em>${isPdf(a) ? 'PDF' : (a.file_name || '').split('.').pop().toUpperCase().slice(0, 4)}</em></span>`;
}

function emptyState(s, onProject) {
  return html`<section class="as-card as-empty"><div class="as-et"><h2>Everything for ${s.name}, in one place</h2><p class="muted">Their logo, colours, website, shared folders, photos and where to find each login. Anyone on the team finds it here instead of asking.${onProject && !s.has_client ? ' This project has no client yet: its assets move to the client when you link one.' : ''}</p></div>
    <div class="as-drop" data-as-drop><span class="as-dropi">${I(IC.up, 30, 1.8)}</span><b>Drop files here, or paste a link</b><span class="muted">Pictures, PDFs, logos and videos up to 50 MB. Press Cmd + V or Ctrl + V on this page to paste.</span><button type="button" class="btn primary" data-act="as-add">Add the first thing</button></div>
    <div class="as-starts"><span class="muted small">Most teams start with</span><div>
      ${[['logo', IC.img, 'Their logo', 'Upload it once, use it everywhere'], ['link', IC.globe, 'Their website', 'Paste the address'], ['color', null, 'Brand colours', 'Type or paste a code like #1F4E46'], ['login', IC.lock, 'Where logins are kept', 'Not the passwords, just where to find them']].map(([k, ic, t, d]) => html`<button type="button" class="as-item as-start" data-act="as-add" data-v="${k}"><span class="as-fav ${k === 'login' ? 'as-lock' : ''}" ${raw(k === 'color' ? 'style="background:linear-gradient(135deg,#F7B544 0 33%,#3DD68C 33% 66%,#7C5CF0 66%)"' : '')}>${ic ? I(ic, 18) : ''}</span><span class="as-t"><b>${t}</b><span>${d}</span></span></button>`)}</div></div>
  </section>`;
}

// pictures behind sign-in: fetched once, then kept
const imgs = new Map();
export function assetsAfter(root) {
  for (const img of root.querySelectorAll('img[data-asimg]')) {
    const p = img.dataset.asimg;
    if (imgs.get(p)) { if (img.getAttribute('src') !== imgs.get(p)) img.src = imgs.get(p); continue; }
    if (imgs.has(p)) continue;
    imgs.set(p, null);
    fileUrl(p).then((u) => { imgs.set(p, u); for (const i of document.querySelectorAll(`img[data-asimg="${CSS.escape(p)}"]`)) i.src = u; }).catch(() => imgs.delete(p));
  }
  filter(root);
}
// search and kinds: shown and hidden on the page, no reload
function filter(root = document) {
  const box = root.querySelector ? root.querySelector('.as') : null;
  if (!box) return;
  box.dataset.kind = view.kind;
  const q = view.q.trim().toLowerCase();
  let any = false;
  for (const el of box.querySelectorAll('[data-as-s]')) { const on = !q || el.dataset.asS.includes(q); el.hidden = !on; if (on) any = true; }
  for (const sec of box.querySelectorAll('.as-sec')) { const items = sec.querySelectorAll('[data-as-s]'); sec.classList.toggle('as-gone', !!q && ![...items].some((i) => !i.hidden)); }
  const none = box.querySelector('.as-none'); if (none) none.hidden = !q || any;
}

// ---------- actions ----------
const where = () => (cur.where.client ? { client_id: cur.where.client } : { project_id: cur.where.project });
const whereQ = () => (cur.where.client ? `client=${cur.where.client}` : `project=${cur.where.project}`);
const done = (msg) => { if (msg) toast(msg); (S.refreshNow || S.refresh)(); };
const find = (id) => cur.assets.find((a) => a.id === Number(id));

actions['as-kind'] = (el) => {
  view.kind = el.dataset.v;
  for (const b of document.querySelectorAll('.as-kind')) b.setAttribute('aria-pressed', String(b.dataset.v === view.kind));
  filter();
};
document.addEventListener('input', (e) => { if (e.target.matches && e.target.matches('[data-as-q]')) { view.q = e.target.value; filter(); } });
actions['as-copy'] = async (el) => {
  try { if (!(await copyText(el.dataset.v))) throw new Error('blocked'); toast(`Copied ${el.dataset.v.length > 40 ? 'the link' : el.dataset.v}`); } catch { toast('Your browser blocked copying. Select it and copy by hand.', true); }
};

// upload one file, big ones as they are
async function upload(file, extra = {}) {
  if (file.size > MAX) throw new Error(`${file.name} is ${kb(file.size)}. Files can be at most 50 MB.`);
  const name = file.name && file.name !== 'image.png' ? file.name : `pasted-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.png`;
  const opts = Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null && v !== ''));
  if (file.size > BIG) {
    const q = new URLSearchParams({ name, mime: file.type || '', ...opts });
    const res = await fetch(`/api/assets/upload?${whereQ()}&${q}`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: file });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'The upload didn’t go through. Try again.');
    return out;
  }
  const body = { ...where(), kind: 'file', name, mime: file.type || null, data_base64: await fileBase64(file) };
  for (const [k, v] of Object.entries(opts)) body[k] = k === 'shared' ? v === '1' : v;
  return post('/api/assets', body);
}

// what a pasted or typed value is
function detect(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return 'color';
  if (/^(https?:\/\/|www\.)\S+$/i.test(s) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) return 'link';
  return 'note';
}
const KIND_LABEL = { link: 'Links', color: 'Brand: a colour', font: 'Brand: a font', login: 'Logins: where it’s kept', note: 'Notes', file: 'Files' };

// Add: paste anything, or drop files
let staged = [];
actions['as-add'] = (el) => {
  const s = cur.scope, start = el && el.dataset ? el.dataset.v : null;
  staged = [];
  const first = start === 'login' ? 'login' : start === 'color' ? 'color' : start === 'link' ? 'link' : '';
  const m = openModal({
    title: `Add to ${s.name}`, submit: 'Save', wide: true,
    sub: 'Paste a link, a colour code or a note, or drop files. Staffwarden works out what it is.',
    body: html`<div class="as-add">
      <div class="field"><label class="f" for="as-in">${start === 'login' ? 'Where is the login kept?' : start === 'color' ? 'Colour code' : 'Paste or type'}</label><textarea id="as-in" name="value" rows="2" maxlength="4000" placeholder="${start === 'login' ? 'In 1Password, “Harbor & Pine › WordPress”' : start === 'color' ? '#1F4E46' : start === 'link' ? 'https://' : 'https://… , #1F4E46, or a note'}" ${raw(start === 'logo' ? '' : 'autofocus')}></textarea></div>
      <div class="as-found" data-as-found hidden></div>
      <div class="as-addrow"><div class="field"><label class="f" for="as-name">Name</label><input id="as-name" name="title" maxlength="120" placeholder="Website"></div>
        <div class="field"><label class="f" for="as-kindsel">Goes under</label><select id="as-kindsel" name="kind">${Object.entries(KIND_LABEL).filter(([k]) => k !== 'file').map(([k, n]) => html`<option value="${k}" ${raw(k === (first || 'note') ? 'selected' : '')}>${n}</option>`)}</select></div></div>
      ${s.has_client ? html`<fieldset class="as-whofs" data-as-whofs><legend class="f">Who sees it</legend><div><label class="as-radio"><input type="radio" name="shared" value="0" checked><span><b>The team</b><span>Only people here</span></span></label><label class="as-radio"><input type="radio" name="shared" value="1"><span><b>${s.name} too</b><span>${s.client_signs_in ? 'Shows in their portal' : 'Shows in their portal once they can sign in'}</span></span></label></div></fieldset>` : ''}
      <label class="as-drop as-dropsm" data-as-drop>${I(IC.up, 22, 1.8)}<b>${start === 'logo' ? 'Pick their logo' : 'Drop files or pick them'}</b><span class="muted small">Up to 50 MB each${start === 'logo' ? '. It goes under Brand.' : ''}</span><input type="file" multiple data-as-files hidden></label>
      <ul class="as-staged" data-as-staged></ul>
    </div>`,
    onSubmit: async (fd, form) => {
      const value = String(fd.get('value') || '').trim(), kind = fd.get('kind'), title = String(fd.get('title') || '').trim(), shared = fd.get('shared') === '1';
      if (!value && !staged.length) { m.setError('Paste something or add a file first'); return false; }
      let n = 0;
      if (value) {
        const body = { ...where(), kind, title: title || null, shared };
        if (kind === 'link') body.url = value; else body.value = value;
        await post('/api/assets', body); n++;
      }
      const rows = form.querySelectorAll('[data-as-staged] li');
      for (let i = 0; i < staged.length; i++) {
        const row = rows[i]; if (row) row.querySelector('.as-st').textContent = 'Uploading…';
        await upload(staged[i], { shared: shared ? '1' : '0', section: start === 'logo' || (staged[i].type || '').startsWith('image/') && /logo/i.test(staged[i].name) ? 'brand' : 'files', title: start === 'logo' && i === 0 ? 'Logo' : null });
        if (row) { row.querySelector('.as-st').textContent = 'Saved'; row.classList.add('ok'); }
        n++;
      }
      staged = [];
      done(n === 1 ? 'Saved' : `${n} things saved`);
    },
  });
  if (start === 'logo') setTimeout(() => m.form.querySelector('[data-as-files]').click(), 50);
  const ta = m.form.querySelector('#as-in'), sel = m.form.querySelector('#as-kindsel'), name = m.form.querySelector('#as-name'), found = m.form.querySelector('[data-as-found]'), whofs = m.form.querySelector('[data-as-whofs]');
  let picked = !!first, timer = null;
  const sync = () => {
    if (whofs) whofs.hidden = sel.value === 'login';
    const sb = m.form.querySelector('button[type="submit"]'); const n = (ta.value.trim() ? 1 : 0) + staged.length;
    sb.textContent = n > 1 ? `Save ${n} things` : 'Save';
  };
  sel.addEventListener('change', () => { picked = true; sync(); });
  ta.addEventListener('input', () => {
    const k = detect(ta.value);
    if (!picked && k) sel.value = k;
    sync();
    clearTimeout(timer);
    if (k === 'link' && sel.value === 'link') timer = setTimeout(async () => {
      const url = /^https?:/i.test(ta.value.trim()) ? ta.value.trim() : `https://${ta.value.trim()}`;
      try {
        const p = await get(`/api/chat/preview?url=${encodeURIComponent(url)}`);
        if (p.ok) { found.hidden = false; found.innerHTML = html`<span class="as-fav" style="background:${avColor(900 + p.site.length)}">${(p.site || '?')[0].toUpperCase()}</span><span class="as-t"><span class="as-fl">Link found</span><b>${p.title}</b><span>${p.site}</span></span>`.toString(); if (!name.value) name.value = p.title.split(/\s[|·–-]\s/)[0].slice(0, 120); }
      } catch { /* no preview: fine */ }
    }, 500);
    else found.hidden = true;
  });
  const showStaged = () => {
    m.form.querySelector('[data-as-staged]').innerHTML = staged.map((f) => html`<li class="as-item"><span class="as-fav">${I(f.type.startsWith('image/') ? IC.img : IC.note, 18)}</span><span class="as-t"><b>${f.name}</b><span>${kb(f.size)}${f.size > MAX ? ' · too big, over 50 MB' : ''}</span></span><span class="as-st tag">Ready</span></li>`).join('');
    sync();
  };
  m.form.addEventListener('change', (e) => { if (e.target.matches('[data-as-files]')) { staged.push(...e.target.files); e.target.value = ''; showStaged(); } });
  m.form.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); m.form.classList.add('as-over'); } });
  m.form.addEventListener('dragleave', () => m.form.classList.remove('as-over'));
  m.form.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); m.form.classList.remove('as-over'); staged.push(...e.dataTransfer.files); showStaged(); });
  m.form.addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); staged.push(...fs); showStaged(); } });
  sync();
  return m;
};

// paste or drop anywhere on the assets page opens Add with it
document.addEventListener('paste', (e) => {
  if (!document.querySelector('.as, .as-empty') || document.querySelector('#overlay > *') || (e.target.closest && e.target.closest('input, textarea'))) return;
  const files = [...(e.clipboardData?.files || [])], text = e.clipboardData?.getData('text') || '';
  if (!files.length && !text.trim()) return;
  e.preventDefault();
  const m = actions['as-add']();
  if (files.length) { staged.push(...files); m.form.querySelector('[data-as-files]').dispatchEvent(new Event('change', { bubbles: true })); m.form.querySelector('[data-as-staged]').innerHTML = files.map((f) => html`<li class="as-item"><span class="as-t"><b>${f.name}</b><span>${kb(f.size)}</span></span><span class="as-st tag">Ready</span></li>`).join(''); }
  else { const ta = m.form.querySelector('#as-in'); ta.value = text.trim(); ta.dispatchEvent(new Event('input', { bubbles: true })); }
});
document.addEventListener('dragover', (e) => { if (e.target.closest && e.target.closest('.as, .as-empty') && [...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.target.closest('.as, .as-empty').classList.add('as-over'); } });
document.addEventListener('dragleave', (e) => { const z = e.target.closest && e.target.closest('.as, .as-empty'); if (z && !z.contains(e.relatedTarget)) z.classList.remove('as-over'); });
document.addEventListener('drop', (e) => {
  const z = e.target.closest && e.target.closest('.as, .as-empty');
  if (!z || !e.dataTransfer?.files?.length || document.querySelector('#overlay > *')) return;
  e.preventDefault(); z.classList.remove('as-over');
  const files = [...e.dataTransfer.files];
  const m = actions['as-add']();
  staged.push(...files);
  m.form.querySelector('[data-as-staged]').innerHTML = files.map((f) => html`<li class="as-item"><span class="as-t"><b>${f.name}</b><span>${kb(f.size)}</span></span><span class="as-st tag">Ready</span></li>`).join('');
  const sb = m.form.querySelector('button[type="submit"]'); sb.textContent = files.length > 1 ? `Save ${files.length} things` : 'Save';
});

// change a link, colour, font, login or note
actions['as-edit'] = (el) => {
  const a = find(el.dataset.id); if (!a) return;
  const s = cur.scope;
  const label = { link: 'Link', color: 'Colour code', font: 'Font name', login: 'Where it’s kept', note: 'Note' }[a.kind];
  const m = openModal({
    title: a.title, submit: 'Save',
    body: html`<div class="field"><label class="f" for="as-et">Name</label><input id="as-et" name="title" maxlength="120" value="${a.title}" required></div>
      <div class="field"><label class="f" for="as-ev">${label}</label>${a.kind === 'note' ? html`<textarea id="as-ev" name="value" rows="4" maxlength="4000">${a.value}</textarea>` : html`<input id="as-ev" name="value" maxlength="2000" value="${a.kind === 'link' ? a.url : a.value}">`}</div>
      ${a.kind !== 'note' ? html`<div class="field"><label class="f" for="as-en">Note (optional)</label><input id="as-en" name="note" maxlength="2000" value="${a.note || ''}" placeholder="${a.kind === 'link' ? 'What it’s for' : ''}"></div>` : ''}
      ${s.has_client && a.kind !== 'login' ? html`<label class="check"><input type="checkbox" name="shared" ${raw(a.shared ? 'checked' : '')}><span>${s.name} sees it in their portal</span></label>` : a.kind === 'login' ? html`<p class="hint">${I(IC.lock, 13, 2.2)} Logins are only ever seen by the team.</p>` : ''}
      <p class="hint">Added by ${a.by || 'someone'} ${relTime(a.created_at)}.</p>
      <button type="button" class="linkbtn small" data-act="as-del" data-id="${a.id}" style="color:var(--bad,#FFB3A8)">Remove</button>`,
    onSubmit: async (fd) => {
      const body = { title: fd.get('title') };
      if (a.kind === 'link') body.url = fd.get('value'); else body.value = fd.get('value');
      if (a.kind !== 'note') body.note = fd.get('note') || null;
      if (s.has_client && a.kind !== 'login') body.shared = fd.get('shared') === 'on';
      await patch(`/api/assets/${a.id}`, body); done('Saved');
    },
  });
  return m;
};
actions['as-del'] = async (el) => {
  const a = find(el.dataset.id); if (!a) return;
  if (!(await confirmBox({ title: `Remove ${a.title}?`, message: a.kind === 'file' ? 'The file is deleted from the assets. Copies on tasks stay.' : 'It is removed for everyone.', confirm: 'Remove', danger: true }))) return;
  try {
    await del(`/api/assets/${a.id}`);
    [...document.querySelectorAll('#overlay [data-close]')].forEach((b) => b.click());
    done('Removed');
  } catch (err) { toast(errMsg(err), true); }
};

// one file opened: big, with its versions
actions['as-open'] = async (el) => {
  const a = find(el.dataset.id); if (!a) return;
  const s = cur.scope, vers = cur.assets.filter((x) => (x.chain_id || x.id) === (a.chain_id || a.id)).sort((x, y) => y.version - x.version);
  const src = `/api/assets/${a.id}/file?inline=1`;
  const m = openModal({
    title: a.title, submit: 'Save', wide: true,
    sub: [isPdf(a) ? 'PDF' : (a.mime || '').split('/')[1]?.toUpperCase(), kb(a.size), a.task ? `from ${a.task.key || 'a task'}, saved when it was approved` : a.from_client ? `sent by ${a.by}` : `added by ${a.by || 'someone'}`, relTime(a.created_at)].filter(Boolean).join(' · '),
    body: html`<div class="as-view">
      <div class="as-viewpic">${isImg(a) ? html`<img alt="${a.title}" data-asimg="${src}" ${raw(imgs.get(src) ? `src="${imgs.get(src)}"` : '')}>` : html`<div class="as-viewdoc">${thumb(a)}<b>${a.file_name}</b></div>`}</div>
      <div class="as-viewside">
        <div class="as-va"><button type="button" class="btn primary" data-act="as-dl" data-id="${a.id}">${I(IC.dl, 16)}Download</button><label class="btn">${I(IC.up, 16)}New version<input type="file" data-as-ver="${a.id}" hidden></label></div>
        <div class="field"><label class="f" for="as-vt">Name</label><input id="as-vt" name="title" maxlength="120" value="${a.title}"></div>
        <div class="field"><label class="f" for="as-vs">Goes under</label><select id="as-vs" name="section"><option value="files" ${raw(a.section === 'files' ? 'selected' : '')}>Files and pictures</option><option value="brand" ${raw(a.section === 'brand' ? 'selected' : '')}>Brand</option></select></div>
        <div class="field"><label class="f" for="as-vn">Note</label><textarea id="as-vn" name="note" rows="2" maxlength="2000" placeholder="Where it’s used, which one to use">${a.note || ''}</textarea></div>
        ${s.has_client ? html`<label class="check"><input type="checkbox" name="shared" ${raw(a.shared ? 'checked' : '')}><span>${s.name} sees it in their portal</span></label>` : ''}
        ${vers.length > 1 ? html`<div class="as-vers"><span class="f">Versions</span><ul class="as-list">${vers.map((v) => html`<li class="as-item${v.id === a.id ? ' on' : ''}"><span class="as-t"><b>V${v.version}${v.id === a.id ? ' · this one' : ''}</b><span>${relTime(v.created_at)} · ${v.by || ''}</span></span>${v.id !== a.id ? html`<button type="button" class="btn sm" data-act="as-dl" data-id="${v.id}">Download</button>` : ''}</li>`)}</ul></div>` : ''}
        <button type="button" class="linkbtn small" data-act="as-del" data-id="${a.id}" style="color:#FFB3A8;align-self:flex-start">Remove${vers.length > 1 ? ' this version' : ''}</button>
      </div></div>`,
    onSubmit: async (fd) => { await patch(`/api/assets/${a.id}`, { title: fd.get('title'), section: fd.get('section'), note: fd.get('note') || null, ...(s.has_client ? { shared: fd.get('shared') === 'on' } : {}) }); done('Saved'); },
  });
  assetsAfter(m.form);
  m.form.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-as-ver]') || !e.target.files[0]) return;
    const f = e.target.files[0];
    try { toast(`Uploading ${f.name}…`); await upload(f, { version_of: a.id }); m.close(); done(`V${a.version + 1} of ${a.title} saved`); } catch (err) { m.setError(errMsg(err)); }
  });
};
actions['as-dl'] = async (el) => { const a = find(el.dataset.id); try { await download(`/api/assets/${a.id}/file`, a.file_name); } catch (err) { toast(errMsg(err), true); } };
