// Notes, like Apple Notes: folders, a list, and the note. Private to the person who writes them unless shared
// with people (can edit or can view) or with a project team. Saved as you type; when two people change a
// note at once, both changes are kept (paragraph by paragraph). @mention people who can open it, turn a
// checklist line into a task, add pictures, files and tables.
import { html, raw, esc, icon, plural, relTime, dayLong, initials, avColor, nowMs } from '../util.js';
import { get, post, put, patch, del, qs, download, fileUrl, getToken } from '../api.js';
import { S, actions, toast, errMsg, openModal, confirmBox, empty } from '../ui.js';

const first = (n) => String(n || '').split(/\s+/)[0];
const av = (id, name, cls = 'sm') => html`<span class="avatar ${cls}" style="background:${avColor(id)}" title="${name}" aria-hidden="true">${initials(name)}</span>`;
const SVG = {
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>', pin: '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v8"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.4c2.2.6 3.5 2.5 3.5 5.6"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>', trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  new: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  aa: '<path d="M4 18l5-12 5 12M5.8 14h6.4M15 18l3-7 3 7M15.8 16h4.4"/>', ck: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>', table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
  clip: '<path d="M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7"/>', cam: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13.5" r="3.5"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>', task: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
  share: '<circle cx="8" cy="12" r="3"/><circle cx="17" cy="6" r="3"/><circle cx="17" cy="18" r="3"/><path d="M10.6 10.6l3.8-2.6M10.6 13.4l3.8 2.6"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>', left: '<path d="M15 5l-7 7 7 7"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>', plus: '<path d="M12 5v14M5 12h14"/>', file: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/>',
};
const I = (n, cls = 'ic') => raw(`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${SVG[n]}</svg>`);
const STATUS = { todo: 'To do', in_progress: 'In progress', in_review: 'In review', done: 'Done' };

// ---------- the same cleaning as the server, so nothing in a note can run here either ----------
const OK_TAGS = new Set(['P', 'DIV', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'H2', 'H3', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN', 'A', 'IMG', 'HR', 'BLOCKQUOTE']);
export function cleanNote(htmlText) {
  const doc = new DOMParser().parseFromString(`<body>${htmlText || ''}</body>`, 'text/html');
  const walk = (node, out) => {
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 3) { out.appendChild(document.createTextNode(c.textContent)); continue; }
      if (c.nodeType !== 1) continue;
      if (!OK_TAGS.has(c.tagName)) { if (!/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|TEMPLATE|NOSCRIPT|SVG|MATH|TEXTAREA|SELECT)$/.test(c.tagName)) walk(c, out); continue; }
      const e = document.createElement(c.tagName.toLowerCase());
      const cls = (c.getAttribute('class') || '').split(/\s+/);
      if (c.tagName === 'UL' && cls.includes('ck')) e.className = 'ck';
      if (c.tagName === 'LI' && c.getAttribute('data-done') === '1') e.setAttribute('data-done', '1');
      if (c.tagName === 'SPAN' && cls.includes('mention') && /^\d+$/.test(c.dataset.uid || '')) { e.className = 'mention'; e.dataset.uid = c.dataset.uid; e.contentEditable = 'false'; }
      if (c.tagName === 'SPAN' && cls.includes('nt-task') && /^\d+$/.test(c.dataset.task || '')) { e.className = 'nt-task'; e.dataset.task = c.dataset.task; e.contentEditable = 'false'; }
      if (c.tagName === 'A') {
        if (/^\d+$/.test(c.dataset.file || '')) { e.className = 'nt-file'; e.dataset.file = c.dataset.file; e.contentEditable = 'false'; e.setAttribute('href', '#'); }
        else if (/^https?:\/\/\S+$/i.test(c.getAttribute('href') || '')) { e.setAttribute('href', c.getAttribute('href')); e.target = '_blank'; e.rel = 'noopener noreferrer nofollow'; }
      }
      if (c.tagName === 'IMG') { if (!/^\d+$/.test(c.dataset.file || '')) continue; e.dataset.file = c.dataset.file; e.alt = (c.getAttribute('alt') || '').slice(0, 200); }
      if ((c.tagName === 'TD' || c.tagName === 'TH') && /^[1-9]$/.test(c.getAttribute('colspan') || '')) e.setAttribute('colspan', c.getAttribute('colspan'));
      if (c.tagName !== 'IMG') walk(c, e);
      out.appendChild(e);
    }
    return out;
  };
  const box = walk(doc.body, document.createElement('div'));
  // an empty line keeps a line break, so the caret can go there
  box.querySelectorAll('p, div, h2, h3, li, td, th').forEach((e) => { if (!e.firstChild) e.appendChild(document.createElement('br')); });
  return box.innerHTML;
}
// what is saved: the editor's HTML without what the page adds for show (live task status, picture links)
function serialize(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('img').forEach((i) => i.removeAttribute('src'));
  c.querySelectorAll('.nt-task').forEach((t) => { t.removeAttribute('data-label'); t.removeAttribute('data-status'); });
  c.querySelectorAll('.nk-mk').forEach((x) => x.remove());
  return cleanNote(c.innerHTML);
}

// ---------- when two people change a note at once: keep both, paragraph by paragraph ----------
const blocks = (h) => { const d = document.createElement('div'); d.innerHTML = cleanNote(h); return [...d.childNodes].map((n) => (n.nodeType === 1 ? n.outerHTML : esc(n.textContent))).filter((x) => x.trim() !== ''); };
function lcs(a, b) {
  const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return pairs;
}
export function merge3(base, mine, theirs) {
  const o = blocks(base), a = blocks(mine), b = blocks(theirs);
  const ma = new Map(lcs(o, a)), mb = new Map(lcs(o, b));
  const out = []; let pa = 0, pb = 0, po = 0;
  const flush = (oi, ai, bi) => {
    const oc = o.slice(po, oi), ac = a.slice(pa, ai), bc = b.slice(pb, bi);
    const same = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);
    if (same(ac, oc)) out.push(...bc); else if (same(bc, oc) || same(ac, bc)) out.push(...ac); else out.push(...bc, ...ac.filter((x) => !bc.includes(x)));
  };
  for (let k = 0; k < o.length; k++) {
    if (ma.has(k) && mb.has(k)) { flush(k, ma.get(k), mb.get(k)); out.push(o[k]); po = k + 1; pa = ma.get(k) + 1; pb = mb.get(k) + 1; }
  }
  flush(o.length, a.length, b.length);
  return out.join('');
}

// ---------- the list ----------
const FOLDERS = { '': 'All notes', pinned: 'Pinned', shared: 'Shared with me', deleted: 'Recently deleted' };
function inFolder(n, f) {
  if (f === 'pinned') return n.pinned;
  if (f === 'shared') return !n.mine;
  if (/^f\d+$/.test(f)) return n.folder_id === Number(f.slice(1));
  if (/^p\d+$/.test(f)) return n.projects.some((p) => p.id === Number(f.slice(1)));
  return true;
}
function groupOf(iso) {
  const d = (nowMs() - Date.parse(iso)) / 86400000, dt = new Date(iso), today = new Date(nowMs());
  if (dt.toDateString() === today.toDateString()) return 'Today';
  if (d < 2 && new Date(nowMs() - 86400000).toDateString() === dt.toDateString()) return 'Yesterday';
  if (d < 7) return 'Previous 7 days';
  if (d < 30) return 'Previous 30 days';
  return dt.toLocaleString('en-US', { month: 'long', year: dt.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
const when = (iso) => { const dt = new Date(iso), d = (nowMs() - dt) / 86400000; if (dt.toDateString() === new Date(nowMs()).toDateString()) return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); if (d < 7) return dt.toLocaleDateString('en-US', { weekday: 'short' }); return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
const faces = (people) => html`<span class="nk-faces">${people.slice(0, 3).map((p) => av(p.id, p.name, 'xs'))}</span>`;

function link(q, id) { const p = new URLSearchParams(); if (q.get('folder')) p.set('folder', q.get('folder')); if (q.get('q')) p.set('q', q.get('q')); if (id) p.set('id', id); const s = p.toString(); return `#/notes${s ? `?${s}` : ''}`; }

// ---------- the page ----------
let ed = { id: null, version: 0, base: '', title: '', dirty: false, timer: null, saving: false, typingAt: 0, pinged: 0, hereTimer: null, note: null };
export default {
  title: 'Notes',
  async load(q) {
    const folder = q.get('folder') || '';
    const list = await get(`/api/notebook${qs({ q: q.get('q'), folder: folder === 'deleted' ? 'deleted' : null })}`);
    let id = Number(q.get('id')) || null;
    const shown = list.notes.filter((n) => folder === 'deleted' || inFolder(n, folder));
    if (!id && window.innerWidth > 760 && q.get('view') !== 'folders') id = (shown.find((n) => n.pinned && folder !== 'deleted') || shown[0] || {}).id || null;
    const note = id ? await get(`/api/notebook/${id}`).catch((e) => (e.status === 404 ? { gone: true, id } : Promise.reject(e))) : null;
    return { list, note, shown, folder };
  },
  render({ list, note, shown, folder }, q) {
    const c = list.counts;
    const fl = (key, ic, name, count) => html`<a href="${link(new URLSearchParams(key ? `folder=${key}` : ''), null)}" class="nk-fi${folder === key ? ' on' : ''}" ${raw(folder === key ? 'aria-current="page"' : '')}>${I(ic)}<span>${name}</span><em>${count || ''}</em></a>`;
    const mode = note ? 'note' : q.get('view') === 'folders' ? 'folders' : 'list';
    const folderName = FOLDERS[folder] ?? (folder.startsWith('f') ? (list.folders.find((f) => `f${f.id}` === folder) || {}).name : (list.projects.find((p) => `p${p.id}` === folder) || {}).name) ?? 'Notes';
    const canNew = folder !== 'deleted' && folder !== 'shared';
    const groups = [];
    for (const n of shown) {
      const g = n.pinned && folder !== 'deleted' && folder !== 'pinned' ? 'Pinned' : groupOf(n.updated_at);
      let last = groups[groups.length - 1];
      if (!last || last.name !== g) { last = groups.find((x) => x.name === g) || { name: g, items: [] }; if (!groups.includes(last)) groups.push(last); }
      last.items.push(n);
    }
    groups.sort((a, b) => (a.name === 'Pinned' ? -1 : b.name === 'Pinned' ? 1 : 0));
    return html`<div class="nbk" data-mode="${mode}">
      <nav class="nk-f" aria-label="Folders">
        <div class="nk-fh"><h1>Notes</h1></div>
        ${fl('', 'note', 'All notes', c.all)}${fl('pinned', 'pin', 'Pinned', c.pinned)}${fl('shared', 'users', 'Shared with me', c.shared)}
        <div class="nk-fg"><span>Your folders</span><button type="button" class="nk-ib" data-act="nk-newfolder" aria-label="New folder" title="New folder">${I('plus')}</button></div>
        ${list.folders.length ? list.folders.map((f) => html`<div class="nk-frow">${fl(`f${f.id}`, 'folder', f.name, f.count)}<button type="button" class="nk-ib nk-fm" data-act="nk-folder" data-id="${f.id}" data-name="${f.name}" aria-label="Rename or remove ${f.name}">${I('more')}</button></div>`) : html`<p class="nk-none">Make folders to keep notes apart.</p>`}
        ${list.projects.length ? html`<div class="nk-fg"><span>Projects</span></div>${list.projects.map((p) => html`<a href="#/notes?folder=p${p.id}" class="nk-fi${folder === `p${p.id}` ? ' on' : ''}"><i class="nk-pc" style="background:${p.color}"></i><span>${p.name}</span><em>${p.count}</em></a>`)}` : ''}
        <span class="nk-sp"></span>
        ${fl('deleted', 'trash', 'Recently deleted', c.deleted)}
      </nav>
      <section class="nk-l" aria-label="${folderName}">
        <div class="nk-lh"><div class="nk-row"><a class="nk-back" href="#/notes?view=folders">${I('left')}<span>Folders</span></a></div>
          <div class="nk-row"><h2 class="nk-grow">${folderName}</h2>${canNew ? html`<button type="button" class="nk-ib" data-act="nk-new" aria-label="New note" title="New note">${I('new')}</button>` : ''}</div>
          <label class="nk-srch">${I('search')}<span class="sr">Search notes</span><input type="search" placeholder="Search notes" value="${q.get('q') || ''}" data-q="q"></label></div>
        <div class="nk-items">${shown.length ? groups.map((g) => html`<h3 class="nk-gh">${g.name}</h3>${g.items.map((n) => html`<a href="${link(q, n.id)}" class="nk-i${note && note.id === n.id ? ' on' : ''}" data-k="n${n.id}" ${raw(note && note.id === n.id ? 'aria-current="true"' : '')}>
            <b>${n.title}</b><span class="nk-m"><b>${when(folder === 'deleted' ? n.deleted_at : n.updated_at)}</b><span class="nk-grow">${n.snippet || (n.mine ? 'No more text' : `From ${first(n.owner.name)}`)}</span>${n.shared ? faces(n.people) : ''}</span></a>`)}`)
          : html`<div class="nk-empty">${q.get('q') ? html`<b>No notes match</b><span>Try other words.</span>` : folder === 'deleted' ? html`<b>Nothing here</b><span>Notes you delete wait here until you delete them for good.</span>` : folder === 'shared' ? html`<b>Nothing shared with you yet</b><span>When someone shares a note with you, it shows here.</span>` : html`<b>No notes yet</b><span>Write the first one. Only you see it, until you share it.</span><button type="button" class="btn primary sm" data-act="nk-new">${I('new')} New note</button>`}</div>`}</div>
      </section>
      <section class="nk-e" aria-label="${note && !note.gone ? note.title : 'Note'}">${note ? (note.gone ? html`<div class="nk-empty"><b>This note isn’t available</b><span>It was deleted, or it’s no longer shared with you.</span></div>` : editor(note, q)) : html`<div class="nk-empty"><b>No note open</b><span>Pick one from the list, or write a new one.</span>${canNew ? html`<button type="button" class="btn primary sm" data-act="nk-new">${I('new')} New note</button>` : ''}</div>`}</section>
    </div>`;
  },
  after(view, data) { mount(view, data); },
};

function editor(n, q) {
  const can = (n.access === 'owner' || n.access === 'edit') && !n.deleted_at;
  const tb = (act, ic, label, extra = '') => html`<button type="button" class="nk-tb" data-act="${act}" ${raw(extra)} aria-label="${label}" title="${label}">${I(ic)}</button>`;
  const others = (n.here || []);
  const typing = others.filter((p) => p.typing).map((p) => first(p.name));
  return html`<div class="nk-bar" role="toolbar" aria-label="Note tools">
      <a class="nk-back" href="${link(q, null)}">${I('left')}<span>${FOLDERS[q.get('folder') || ''] || 'Notes'}</span></a>
      ${can ? html`<span class="nk-fmt" role="group" aria-label="Formatting">${tb('nk-style', 'aa', 'Text styles')}${tb('nk-ck', 'ck', 'Checklist')}${tb('nk-ul', 'list', 'Bulleted list')}${tb('nk-table', 'table', 'Table')}<span class="nk-sep"></span>
        <label class="nk-tb" title="Add a photo" aria-label="Add a photo">${I('cam')}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-nk-file hidden></label>
        <label class="nk-tb" title="Attach a file" aria-label="Attach a file">${I('clip')}<input type="file" data-nk-file hidden></label>
        ${tb('nk-at', 'at', 'Mention someone')}${tb('nk-link', 'task', 'Link a task')}</span>` : ''}
      <span class="nk-grow"></span>
      <span class="nk-st small" role="status" data-nk-status>${n.deleted_at ? '' : can ? 'Saved' : 'View only'}</span>
      ${others.length ? html`<span class="nk-here" title="${others.map((p) => p.name).join(', ')} ${others.length === 1 ? 'has' : 'have'} it open">${faces(others)}${typing.length ? html`<span class="small">${typing.join(', ')} ${typing.length === 1 ? 'is' : 'are'} typing</span>` : ''}</span>` : ''}
      ${!n.deleted_at ? html`<button type="button" class="nk-tb${n.pinned ? ' on' : ''}" data-act="nk-pin" aria-pressed="${n.pinned ? 'true' : 'false'}" aria-label="${n.pinned ? 'Unpin' : 'Pin'}" title="${n.pinned ? 'Unpin' : 'Pin to the top'}">${I('pin')}</button>` : ''}
      ${n.access === 'owner' && !n.deleted_at ? html`<button type="button" class="nk-tb" data-act="nk-more" aria-label="Move or delete" title="Move or delete">${I('more')}</button><button type="button" class="btn sm" data-act="nk-share">${I('share')} Share</button>` : !n.mine ? html`<span class="nk-from small">${av(n.owner.id, n.owner.name, 'xs')}${first(n.owner.name)}’s note</span>` : ''}
    </div>
    ${n.deleted_at ? html`<div class="banner nk-ban"><span>This note is in Recently deleted. Restore it to change it.</span><span><button type="button" class="btn sm" data-act="nk-restore">${I('restore')} Restore</button> <button type="button" class="btn sm danger" data-act="nk-forever">Delete for good</button></span></div>`
      : !can ? html`<div class="banner info nk-ban"><span>You can read this note. ${first(n.owner.name)} can let you edit it.</span></div>` : ''}
    <article class="nk-doc">
      <p class="nk-when">${dayLong(n.updated_at.slice(0, 10)) ? new Date(n.updated_at).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(', ', ', ').replace(/ at /, ' at ') : ''}${n.updated_by && n.updated_by !== S.me.name ? ` · edited by ${first(n.updated_by)}` : ''}</p>
      <label class="sr" for="nk-title">Title</label>
      <textarea id="nk-title" class="nk-title" rows="1" maxlength="300" placeholder="Title" data-own="t${n.id}" ${raw(can ? '' : 'readonly')}></textarea>
      <div class="nk-body" data-own="b${n.id}" ${raw(can ? 'contenteditable="true"' : '')} role="textbox" aria-multiline="true" aria-label="Note" data-placeholder="Start writing. Type @ to mention someone."></div>
    </article>`;
}

// ---------- putting a note in the editor, and keeping it current ----------
function mount(view, data) {
  const n = data && data.note;
  const el = view.querySelector('.nk-body'), ti = view.querySelector('.nk-title');
  clearInterval(ed.hereTimer);
  if (!n || n.gone || !el) { if (ed.id) leave(); ed.id = null; return; }
  const can = (n.access === 'owner' || n.access === 'edit') && !n.deleted_at;
  if (ed.id !== n.id) {
    if (ed.id && ed.dirty) saveNow();
    if (ed.id) leave();
    ed = { id: n.id, version: n.version, base: n.body, title: n.titled ? n.title : '', dirty: false, timer: null, saving: false, typingAt: 0, pinged: 0, hereTimer: null, note: n, can };
    el.innerHTML = cleanNote(n.body) || '<p><br></p>'; ti.value = n.titled ? n.title : '';
    decorate(el, n); fit(ti); blank(el);
    if (can && !n.body && !n.titled) setTimeout(() => ti.focus(), 30);
  } else {
    ed.note = n; ed.can = can;
    // someone else saved: show it, unless you are in the middle of typing (your next save keeps both)
    if (n.version > ed.version && !ed.dirty && !ed.saving && nowMs() - ed.typingAt > 2500) {
      const scroll = el.closest('.nk-e').scrollTop;
      el.innerHTML = cleanNote(n.body) || '<p><br></p>'; ti.value = n.titled ? n.title : ''; ed.version = n.version; ed.base = n.body; ed.title = ti.value;
      decorate(el, n); fit(ti); blank(el); el.closest('.nk-e').scrollTop = scroll;
    } else {
      decorate(el, n);
      // you were typing a moment ago: show their change once you pause (your own next save keeps both anyway)
      if (n.version > ed.version && !ed.dirty) { clearTimeout(ed.later); ed.later = setTimeout(() => S.refresh(), 2700); }
    }
  }
  if (!n.deleted_at) { here(); ed.hereTimer = setInterval(() => { if (!document.querySelector(`.nk-body[data-own="b${ed.id}"]`)) { clearInterval(ed.hereTimer); leave(); return; } if (!document.hidden) here(); }, 15000); }
}
// the hint shows in an empty note; new lines are paragraphs, so each line is its own block (and merges well)
const blank = (el) => { el.classList.toggle('blank', !el.textContent.trim() && !el.querySelector('img,table,ul,ol,.nt-task,.nt-file,.mention')); };
try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* old browsers */ }
const fit = (t) => { if (!t) return; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; };
function here(typing = false) { if (!ed.id) return; ed.pinged = nowMs(); post(`/api/notebook/${ed.id}/here`, { typing }).catch(() => {}); }
function leave() { if (ed.id) post(`/api/notebook/${ed.id}/here`, { leave: true }).catch(() => {}); }
window.addEventListener('pagehide', () => { if (ed.id && ed.dirty) saveNow(true); leave(); });

// live task status on linked tasks, and the pictures
const imgs = new Map();
function decorate(el, n) {
  for (const t of el.querySelectorAll('.nt-task')) {
    const x = n.tasks && n.tasks[t.dataset.task];
    if (!x || x.hidden) { t.dataset.status = 'hidden'; t.dataset.label = 'Not shared with you'; continue; }
    t.dataset.status = x.status; t.dataset.label = STATUS[x.status] || x.status;
    const txt = `${x.key ? `${x.key} ` : ''}${x.title}`;
    if (t.textContent !== txt) t.textContent = txt;
  }
  for (const im of el.querySelectorAll('img[data-file]')) {
    const key = `${n.id}:${im.dataset.file}`;
    if (imgs.has(key)) { if (im.src !== imgs.get(key)) im.src = imgs.get(key); continue; }
    fileUrl(`/api/notebook/${n.id}/files/${im.dataset.file}`).then((u) => { imgs.set(key, u); im.src = u; }).catch(() => { im.alt = `${im.alt || 'Picture'} (unavailable)`; });
  }
}

// ---------- saving ----------
const status = (t) => { const s = document.querySelector('[data-nk-status]'); if (s) s.textContent = t; };
function changed() {
  ed.dirty = true; ed.typingAt = nowMs(); status('Saving…');
  clearTimeout(ed.timer); ed.timer = setTimeout(saveNow, 700);
  if (nowMs() - ed.pinged > 5000) here(true);
}
async function saveNow(beacon = false) {
  clearTimeout(ed.timer);
  const el = document.querySelector(`.nk-body[data-own="b${ed.id}"]`), ti = document.querySelector('.nk-title');
  if (!ed.id || !ed.dirty || !el || !ed.can) return;
  if (ed.saving) { ed.timer = setTimeout(saveNow, 300); return; }
  const body = serialize(el), title = ti ? ti.value : ed.title, id = ed.id;
  if (beacon) { try { fetch(`/api/notebook/${id}`, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` }, body: JSON.stringify({ version: ed.version, body, title }) }); } catch { /* best effort */ } return; }
  ed.saving = true; ed.dirty = false;
  try {
    const r = await put(`/api/notebook/${id}`, { version: ed.version, body, title });
    if (ed.id === id) { ed.version = r.version; ed.base = r.body; ed.title = title; if (!ed.dirty) status('Saved'); }
  } catch (e) {
    if (e.status === 409 && e.data && e.data.latest && ed.id === id) {
      // someone saved meanwhile: put both changes together, then save that
      const L = e.data.latest;
      const merged = merge3(ed.base, body, L.body);
      const myTitleChanged = title !== ed.title;
      if (el.isConnected) { el.innerHTML = cleanNote(merged); decorate(el, ed.note); }
      if (ti && !myTitleChanged) { ti.value = L.title; fit(ti); }
      ed.version = L.version; ed.base = L.body; ed.title = L.title; ed.dirty = true;
      toast(`${first(L.updated_by) || 'Someone'} changed this note too. Both changes are kept.`);
      ed.saving = false; return saveNow();
    }
    ed.dirty = true; status(e.status === 0 ? 'Offline. Will save when you’re back' : 'Not saved');
    if (e.status !== 0) toast(errMsg(e), true);
    ed.timer = setTimeout(saveNow, e.status === 0 ? 5000 : 15000);
  } finally { ed.saving = false; }
}

// ---------- typing in the note ----------
document.addEventListener('input', (e) => {
  if (e.target.matches && e.target.matches('.nk-title')) { fit(e.target); changed(); return; }
  const b = e.target.closest && e.target.closest('.nk-body');
  if (b) { tidy(b); blank(b); changed(); mentionCheck(); }
});
document.addEventListener('keydown', (e) => {
  const body = e.target.closest && e.target.closest('.nk-body');
  if (e.target.matches && e.target.matches('.nk-title') && e.key === 'Enter') { e.preventDefault(); const b = document.querySelector('.nk-body'); if (b) { b.focus(); placeCaret(b, true); } return; }
  if (!body) return;
  if (menu) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mAt = (mAt + (e.key === 'ArrowDown' ? 1 : -1) + mHits.length) % mHits.length; paintMenu(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mAt); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
  }
  if ((e.metaKey || e.ctrlKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) return;   // the browser's own bold/italic/underline
  // in a table, Tab goes to the next cell (and adds a row at the end), Shift+Tab goes back
  const cell = caretBlock('td, th');
  if (e.key === 'Tab' && cell && body.contains(cell)) {
    e.preventDefault();
    const cells = [...cell.closest('table').querySelectorAll('th, td')], i = cells.indexOf(cell);
    let next = cells[i + (e.shiftKey ? -1 : 1)];
    if (!next && !e.shiftKey) { const row = cell.closest('tr').cloneNode(true); row.querySelectorAll('th, td').forEach((c) => { const d = document.createElement('td'); d.appendChild(document.createElement('br')); c.replaceWith(d); }); (cell.closest('table').querySelector('tbody') || cell.closest('table')).appendChild(row); next = row.firstElementChild; changed(); }
    if (next) { const r = document.createRange(); r.selectNodeContents(next); r.collapse(false); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
    return;
  }
  // a new checklist line starts unticked
  if (e.key === 'Enter') setTimeout(() => { const li = caretBlock('li'); if (li && li.dataset.done && !li.textContent.trim()) { delete li.dataset.done; } }, 0);
});
// ticking a checklist line: the circle at its start
document.addEventListener('mousedown', (e) => {
  const li = e.target.closest && e.target.closest('.nk-body ul.ck > li');
  if (!li || !ed.can) return;
  const r = li.getBoundingClientRect();
  if (e.clientX - r.left > 26) return;
  e.preventDefault();
  if (li.dataset.done) delete li.dataset.done; else li.dataset.done = '1';
  changed();
});
document.addEventListener('click', (e) => {
  const t = e.target.closest && e.target.closest('.nk-body .nt-task');
  if (t) { e.preventDefault(); if (t.dataset.status !== 'hidden') S.navigate(`#/task?id=${t.dataset.task}`); return; }
  const f = e.target.closest && e.target.closest('.nk-body .nt-file');
  if (f) { e.preventDefault(); download(`/api/notebook/${ed.id}/files/${f.dataset.file}`, f.textContent.trim()).catch((err) => toast(errMsg(err), true)); }
});
// pasting: words come in as plain text (no stray styles); pictures are added to the note
document.addEventListener('paste', (e) => {
  const body = e.target.closest && e.target.closest('.nk-body');
  if (!body || !ed.can) return;
  const files = [...(e.clipboardData && e.clipboardData.files || [])];
  e.preventDefault();
  if (files.length) { for (const f of files) addFile(f); return; }
  const text = e.clipboardData.getData('text/plain');
  document.execCommand('insertText', false, text);
});
document.addEventListener('drop', (e) => {
  const body = e.target.closest && e.target.closest('.nk-body');
  if (!body || !ed.can || !e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  for (const f of e.dataTransfer.files) addFile(f);
});
document.addEventListener('change', (e) => { if (e.target.matches && e.target.matches('[data-nk-file]')) { for (const f of e.target.files) addFile(f); e.target.value = ''; } });

// text typed straight into the note (not in a paragraph) is put in one, keeping the caret where it was
function tidy(b) {
  // words, people, task links and files sitting straight in the note go into a paragraph together
  const sel = window.getSelection(), an = sel.rangeCount ? sel.anchorNode : null, ao = sel.rangeCount ? sel.anchorOffset : 0;
  let run = null, moved = false;
  for (const n of [...b.childNodes]) {
    const block = n.nodeType === 1 && /^(P|DIV|H2|H3|UL|OL|TABLE|IMG|HR|BLOCKQUOTE)$/.test(n.tagName);
    const blankText = n.nodeType === 3 && !n.textContent.trim();
    if (block || n.nodeType === 8) { run = null; continue; }
    if (blankText && !run) continue;
    if (!run) { run = document.createElement('p'); b.insertBefore(run, n); }
    run.appendChild(n); moved = true;
  }
  if (moved && an && b.contains(an) && an !== b) { const r = document.createRange(); r.setStart(an, Math.min(ao, an.nodeType === 3 ? an.length : an.childNodes.length)); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
  // a list, table or heading the browser put inside a paragraph comes out of it (a paragraph can't hold them)
  for (const p of [...b.querySelectorAll('p')]) {
    if (!p.querySelector(':scope > ul, :scope > ol, :scope > table, :scope > p, :scope > div, :scope > h2, :scope > h3, :scope > blockquote, :scope > hr')) continue;
    const s = window.getSelection(), an = s.rangeCount ? s.anchorNode : null, ao = s.rangeCount ? s.anchorOffset : 0;
    const out = []; let run = null;
    for (const c of [...p.childNodes]) {
      if (c.nodeType === 1 && /^(UL|OL|TABLE|P|DIV|H2|H3|BLOCKQUOTE|HR)$/.test(c.tagName)) { run = null; out.push(c); }
      else if (c.nodeType === 3 && !c.textContent.trim() && !run) continue;
      else if (c.nodeName === 'BR' && !run) continue;
      else { if (!run) { run = document.createElement('p'); out.push(run); } run.appendChild(c); }
    }
    p.replaceWith(...out);
    if (an && b.contains(an)) { const r = document.createRange(); r.setStart(an, Math.min(ao, an.nodeType === 3 ? an.length : an.childNodes.length)); r.collapse(true); s.removeAllRanges(); s.addRange(r); }
  }
  if (!b.firstChild) b.innerHTML = '<p><br></p>';
}
function caretBlock(sel) { const s = window.getSelection(); if (!s.rangeCount) return null; let n = s.anchorNode; if (n && n.nodeType === 3) n = n.parentNode; return n && n.closest ? n.closest(sel) : null; }
function placeCaret(el, end) { const r = document.createRange(); const blk = end ? el.lastElementChild : el.firstElementChild; r.selectNodeContents(blk && !/^(TABLE|UL|OL|IMG|HR)$/.test(blk.tagName) ? blk : el); r.collapse(!end); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
function focusBody() { const b = document.querySelector('.nk-body'); if (!b) return null; if (!b.contains(document.activeElement) && document.activeElement !== b) { b.focus(); if (!b.contains(window.getSelection().anchorNode)) placeCaret(b, true); } return b; }
let savedRange = null;
document.addEventListener('selectionchange', () => { const s = window.getSelection(); if (s.rangeCount && s.anchorNode && s.anchorNode.parentElement && s.anchorNode.parentElement.closest('.nk-body')) savedRange = s.getRangeAt(0).cloneRange(); });
function restoreRange() {
  const b = focusBody(); if (!b) return null;
  const s = window.getSelection();
  if (savedRange && b.contains(savedRange.startContainer)) { s.removeAllRanges(); s.addRange(savedRange); }
  // the caret between blocks (after a table or a picture): start a new paragraph there
  if (s.rangeCount && s.anchorNode === b) {
    const p = document.createElement('p'); p.appendChild(document.createElement('br'));
    b.insertBefore(p, b.childNodes[s.anchorOffset] || null);
    const r = document.createRange(); r.setStart(p, 0); r.collapse(true); s.removeAllRanges(); s.addRange(r);
  }
  return b;
}

// ---------- the toolbar ----------
actions['nk-ck'] = () => {
  if (!restoreRange()) return;
  const ul = caretBlock('ul');
  if (ul && ul.classList.contains('ck')) { document.execCommand('insertUnorderedList'); }
  else { if (!ul) document.execCommand('insertUnorderedList'); const u = caretBlock('ul'); if (u) u.className = 'ck'; }
  tidy(document.querySelector('.nk-body')); changed();
};
actions['nk-ul'] = () => {
  if (!restoreRange()) return;
  const ul = caretBlock('ul');
  if (ul && ul.classList.contains('ck')) ul.className = ''; else document.execCommand('insertUnorderedList');
  tidy(document.querySelector('.nk-body')); changed();
};
actions['nk-table'] = () => {
  if (!restoreRange()) return;
  document.execCommand('insertHTML', false, '<table><tbody><tr><th><br></th><th><br></th><th><br></th></tr><tr><td><br></td><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td><td><br></td></tr></tbody></table><p><br></p>');
  tidy(document.querySelector('.nk-body'));
  const t = caretBlock('p'), prev = t && t.previousElementSibling;
  if (prev && prev.tagName === 'TABLE') { const r = document.createRange(); r.setStart(prev.querySelector('th'), 0); r.collapse(true); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
  changed();
};
actions['nk-style'] = (el) => {
  const box = el.getBoundingClientRect();
  closePop();
  const pop = document.createElement('div');
  pop.className = 'nk-pop'; pop.setAttribute('role', 'menu');
  const items = [['h2', 'Heading', 'nk-h2'], ['h3', 'Subheading', 'nk-h3'], ['p', 'Body', ''], ['-'], ['bold', 'Bold', 'b'], ['italic', 'Italic', 'i'], ['underline', 'Underline', 'u'], ['strikeThrough', 'Strikethrough', 's'], ['-'], ['insertOrderedList', 'Numbered list', '']];
  pop.innerHTML = items.map(([k, n, c]) => (k === '-' ? '<hr>' : `<button type="button" role="menuitem" data-cmd="${k}" class="${c}">${n}</button>`)).join('');
  pop.style.left = `${Math.min(window.innerWidth - 220, box.left)}px`; pop.style.top = `${box.bottom + 6}px`;
  pop.addEventListener('mousedown', (e) => e.preventDefault());
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]'); if (!b) return;
    restoreRange();
    const k = b.dataset.cmd;
    if (['h2', 'h3', 'p'].includes(k)) document.execCommand('formatBlock', false, k); else document.execCommand(k);
    closePop(); changed();
  });
  document.body.appendChild(pop); pop.querySelector('button').focus();
};
let popEl = null;
function closePop() { const p = document.querySelector('.nk-pop'); if (p) p.remove(); }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('.nk-pop') && !e.target.closest('[data-act="nk-style"]')) closePop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
void popEl;
actions['nk-at'] = () => { if (!restoreRange()) return; document.execCommand('insertText', false, '@'); mentionCheck(); };

// pictures and files
async function addFile(f) {
  if (!ed.id || !ed.can) return;
  if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is over 25 MB`, true); return; }
  status('Adding…');
  try {
    const res = await fetch(`/api/notebook/${ed.id}/files${qs({ name: f.name, mime: f.type || 'application/octet-stream' })}`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: f });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Could not add the file');
    restoreRange();
    if (r.image) document.execCommand('insertHTML', false, `<img data-file="${r.id}" alt="${esc(r.name)}"><p><br></p>`);
    else document.execCommand('insertHTML', false, `<a class="nt-file" data-file="${r.id}" contenteditable="false" href="#">${esc(r.name)}</a>&nbsp;`);
    const b = document.querySelector('.nk-body'); if (b) decorate(b, ed.note);
    changed();
  } catch (e) { status('Not saved'); toast(errMsg(e), true); }
}

// ---------- @mentions ----------
let menu = null, mHits = [], mAt = 0, mRange = null;
function closeMenu() { if (menu) menu.remove(); menu = null; mHits = []; }
function mentionCheck() {
  const s = window.getSelection(); if (!s.rangeCount || !ed.note) return closeMenu();
  const node = s.anchorNode; if (!node || node.nodeType !== 3) return closeMenu();
  const before = node.textContent.slice(0, s.anchorOffset);
  const m = /(?:^|[\s( ])@([^\s@ ]{0,24})$/u.exec(before);
  if (!m) return closeMenu();
  const q = m[1].toLowerCase();
  const pool = ed.note.pool || [];
  mHits = pool.filter((p) => p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || p.name.toLowerCase().startsWith(q)).slice(0, 6);
  if (!pool.length) mHits = [];
  mRange = { node, start: s.anchorOffset - m[1].length - 1, end: s.anchorOffset };
  if (!menu) {
    menu = document.createElement('div'); menu.className = 'mn-menu'; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', 'People who can open this note');
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    menu.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) pickMention(Number(b.dataset.i)); });
    document.body.appendChild(menu);
  }
  mAt = Math.min(mAt, Math.max(0, mHits.length - 1));
  paintMenu();
  const r = s.getRangeAt(0).getBoundingClientRect(), h = menu.offsetHeight;
  menu.style.width = '300px';
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 308, r.left))}px`;
  menu.style.top = `${r.bottom + h + 12 < window.innerHeight ? r.bottom + 6 : r.top - h - 6}px`;
}
function paintMenu() {
  if (!menu) return;
  menu.innerHTML = (mHits.length ? mHits.map((p, i) => `<button type="button" role="option" class="mn-o" aria-selected="${i === mAt}" data-i="${i}">${av(p.id, p.name)}<span class="mn-t"><b>${esc(p.name)}</b>${p.title ? `<span>${esc(p.title)}</span>` : ''}</span></button>`).join('')
    : `<p class="mn-foot" style="margin:8px">${(ed.note.pool || []).length ? 'Nobody by that name can open this note.' : 'Share this note first. You can mention people who can open it.'}</p>`)
    + (mHits.length ? '<p class="mn-foot">Only people who can open this note can be mentioned. They get a notification.</p>' : '');
}
function pickMention(i) {
  const p = mHits[i]; if (!p || !mRange) return;
  const { node, start, end } = mRange;
  const r = document.createRange(); r.setStart(node, start); r.setEnd(node, end); r.deleteContents();
  const span = document.createElement('span'); span.className = 'mention'; span.dataset.uid = p.id; span.contentEditable = 'false'; span.textContent = `@${p.name}`;
  const sp = document.createTextNode(' ');
  r.insertNode(sp); r.insertNode(span);
  const s = window.getSelection(); const after = document.createRange(); after.setStartAfter(sp); after.collapse(true); s.removeAllRanges(); s.addRange(after);
  closeMenu(); changed();
}
document.addEventListener('focusout', (e) => { if (e.target.closest && e.target.closest('.nk-body')) setTimeout(() => { if (!document.activeElement || !document.activeElement.closest('.nk-body')) closeMenu(); }, 150); });

// ---------- a checklist line becomes a task ----------
let hoverLi = null;
document.addEventListener('mousemove', (e) => {
  const doc = e.target.closest && e.target.closest('.nk-doc');
  const btn = document.querySelector('.nk-mk-float');
  if (!doc || !ed.can) { if (btn && !(e.target.closest && e.target.closest('.nk-mk-float'))) btn.remove(); return; }
  const li = e.target.closest('.nk-body ul.ck > li');
  if (!li) { if (btn && !e.target.closest('.nk-mk-float') && (!hoverLi || !hoverLi.contains(e.target))) { btn.remove(); hoverLi = null; } return; }
  if (li === hoverLi && btn) return;
  if (li.querySelector('.nt-task') || !li.textContent.trim()) { if (btn) btn.remove(); hoverLi = null; return; }
  hoverLi = li;
  const b = btn || Object.assign(document.createElement('button'), { type: 'button', className: 'btn sm nk-mk-float' });
  b.innerHTML = `${I('task')}<span>Make a task</span>`; b.dataset.act = 'nk-mktask';
  const r = li.getBoundingClientRect(), d = doc.getBoundingClientRect();
  const tr = document.createRange(); tr.selectNodeContents(li); const end = tr.getBoundingClientRect().right;
  b.style.top = `${r.top - d.top + (Math.min(r.height, 30) - 30) / 2}px`;
  b.style.left = `${Math.min(end - d.left + 14, d.width - 150)}px`;
  if (!btn) doc.appendChild(b);
});
actions['nk-mktask'] = async () => {
  const li = hoverLi; if (!li) return;
  const text = li.textContent.replace(/\s+/g, ' ').trim();
  const [projects] = await Promise.all([get('/api/projects')]);
  const mine = projects.filter((p) => !p.archived && (p.can_plan || p.my_role));
  const noteProject = ed.note && ed.note.projects && ed.note.projects[0];
  const m = openModal({
    title: 'Make a task from this line', sub: 'The line turns into a link to the task, and shows how it’s going.', submit: 'Make the task',
    body: html`<div class="field"><label class="f" for="nk-tt">Task</label><input id="nk-tt" name="title" maxlength="200" value="${text.slice(0, 200)}" required></div>
      <div class="grid2"><div class="field"><label class="f" for="nk-tp">Project</label><select id="nk-tp" name="project_id"><option value="">No project</option>${mine.map((p) => html`<option value="${p.id}" ${raw(noteProject && noteProject.id === p.id ? 'selected' : '')}>${p.name}</option>`)}</select></div>
        <div class="field"><label class="f" for="nk-ta">For</label><select id="nk-ta" name="assignee_id"><option value="${S.me.id}">Me</option></select></div></div>
      <div class="field"><label class="f" for="nk-td">Due (optional)</label><input id="nk-td" name="due_day" type="date"></div>`,
    onSubmit: async (fd) => {
      const t = await post('/api/tasks', { title: fd.get('title'), project_id: fd.get('project_id') ? Number(fd.get('project_id')) : null, assignee_id: Number(fd.get('assignee_id')) || S.me.id, due_day: fd.get('due_day') || null });
      li.innerHTML = '';
      const chip = document.createElement('span'); chip.className = 'nt-task'; chip.dataset.task = t.id; chip.contentEditable = 'false'; chip.textContent = `${t.key ? `${t.key} ` : ''}${t.title}`;
      li.appendChild(chip);
      ed.note.tasks = { ...(ed.note.tasks || {}), [t.id]: { id: t.id, key: t.key, title: t.title, status: t.status } };
      decorate(li.closest('.nk-body'), ed.note); changed();
      toast(`${t.key || 'Task'} made`);
    },
  });
  // who it can go to: the project's team when you run the project, otherwise you
  const ps = m.form.querySelector('#nk-tp'), as = m.form.querySelector('#nk-ta');
  const fill = () => {
    const p = mine.find((x) => x.id === Number(ps.value));
    const people = p && p.can_plan ? p.members.filter((x) => x.id !== S.me.id) : [];
    as.innerHTML = `<option value="${S.me.id}">Me</option>${people.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}`;
  };
  ps.addEventListener('change', fill); fill();
};
// link a task that already exists
actions['nk-link'] = () => {
  const range = savedRange;
  const m = openModal({
    title: 'Link a task', submit: 'Link it', footer: true,
    body: html`<div class="field"><label class="f" for="nk-ls">Find a task</label><input id="nk-ls" type="search" placeholder="Type a name or a key like WE-12" autocomplete="off"></div><div class="pickl" data-nk-res><p class="muted small" style="margin:6px">Start typing to find a task.</p></div>`,
    onSubmit: async (fd) => {
      const id = Number(fd.get('task')); if (!id) throw new Error('Pick a task');
      const t = await get(`/api/tasks/${id}`);
      savedRange = range; restoreRange();
      document.execCommand('insertHTML', false, `<span class="nt-task" data-task="${t.id}" contenteditable="false">${esc(`${t.key ? `${t.key} ` : ''}${t.title}`)}</span>&nbsp;`);
      ed.note.tasks = { ...(ed.note.tasks || {}), [t.id]: { id: t.id, key: t.key, title: t.title, status: t.status } };
      decorate(document.querySelector('.nk-body'), ed.note); changed();
    },
  });
  const inp = m.form.querySelector('#nk-ls'), box = m.form.querySelector('[data-nk-res]');
  let tm = null;
  inp.addEventListener('input', () => {
    clearTimeout(tm); tm = setTimeout(async () => {
      const v = inp.value.trim(); if (!v) { box.innerHTML = '<p class="muted small" style="margin:6px">Start typing to find a task.</p>'; return; }
      const list = await get(`/api/tasks${qs({ assignee: 'all', q: v, done_days: 60 })}`).catch(() => []);
      box.innerHTML = list.length ? list.slice(0, 12).map((t) => `<label class="pick"><input type="radio" name="task" value="${t.id}"><span><b>${esc(t.key || '')}</b> ${esc(t.title)}<span class="muted small"> · ${esc(STATUS[t.status] || '')}</span></span></label>`).join('') : '<p class="muted small" style="margin:6px">No tasks match.</p>';
    }, 220);
  });
};

// ---------- notes and folders ----------
const curQ = () => new URLSearchParams(location.hash.split('?')[1] || '');
actions['nk-new'] = async () => {
  const q = curQ(), f = q.get('folder') || '';
  try {
    const r = await post('/api/notebook', { folder_id: /^f\d+$/.test(f) ? Number(f.slice(1)) : null, project_id: /^p\d+$/.test(f) ? Number(f.slice(1)) : null, title: '', body: '' });
    const p = new URLSearchParams(); if (f && f !== 'pinned') p.set('folder', f); p.set('id', r.id);
    S.navigate(`#/notes?${p}`);
  } catch (e) { toast(errMsg(e), true); }
};
actions['nk-pin'] = async () => { if (!ed.id) return; try { await patch(`/api/notebook/${ed.id}`, { pinned: !ed.note.pinned }); toast(ed.note.pinned ? 'Unpinned' : 'Pinned to the top'); S.refresh(); } catch (e) { toast(errMsg(e), true); } };
actions['nk-more'] = async () => {
  const n = ed.note; if (!n) return;
  const list = await get('/api/notebook');
  openModal({
    title: `Move “${n.title}”`, submit: 'Move',
    body: html`<div class="pickl" role="radiogroup" aria-label="Folder"><label class="pick"><input type="radio" name="f" value="" ${raw(!n.folder_id ? 'checked' : '')}><span><b>No folder</b><span class="muted small"> · All notes</span></span></label>
      ${list.folders.map((f) => html`<label class="pick"><input type="radio" name="f" value="${f.id}" ${raw(n.folder_id === f.id ? 'checked' : '')}><span><b>${f.name}</b></span></label>`)}</div>
      <div class="nk-danger"><span class="muted small">Deleted notes wait in Recently deleted until you delete them for good.</span><button type="button" class="btn sm danger" data-act="nk-del">${I('trash')} Delete note</button></div>`,
    onSubmit: async (fd) => { await patch(`/api/notebook/${n.id}`, { folder_id: fd.get('f') ? Number(fd.get('f')) : null }); toast('Moved'); S.refresh(); },
  });
};
actions['nk-del'] = async () => {
  const n = ed.note; if (!n) return;
  document.querySelectorAll('#overlay .scrim').forEach((s) => s.remove());
  if (ed.dirty) await saveNow();
  try { await del(`/api/notebook/${n.id}`); toast('Moved to Recently deleted'); const q = curQ(); q.delete('id'); S.navigate(`#/notes${q.toString() ? `?${q}` : ''}`); } catch (e) { toast(errMsg(e), true); }
};
actions['nk-restore'] = async () => { try { await post(`/api/notebook/${ed.note.id}/restore`); toast('Restored'); S.navigate(`#/notes?id=${ed.note.id}`); } catch (e) { toast(errMsg(e), true); } };
actions['nk-forever'] = async () => {
  const n = ed.note;
  if (!(await confirmBox({ title: 'Delete this note for good?', message: 'It can’t be brought back, and the people it was shared with lose it too.', confirm: 'Delete for good', danger: true }))) return;
  try { await del(`/api/notebook/${n.id}?forever=1`); toast('Deleted for good'); S.navigate('#/notes?folder=deleted'); } catch (e) { toast(errMsg(e), true); }
};
actions['nk-newfolder'] = () => openModal({ title: 'New folder', submit: 'Make folder', body: html`<div class="field"><label class="f" for="nk-fn">Name</label><input id="nk-fn" name="name" maxlength="60" required placeholder="Stand-ups"></div>`,
  onSubmit: async (fd) => { const f = await post('/api/notebook/folders', { name: fd.get('name') }); S.navigate(`#/notes?folder=f${f.id}`); } });
actions['nk-folder'] = (el) => {
  const id = el.dataset.id;
  const m = openModal({ title: `“${el.dataset.name}”`, submit: 'Rename', body: html`<div class="field"><label class="f" for="nk-fr">Name</label><input id="nk-fr" name="name" maxlength="60" required value="${el.dataset.name}"></div>
    <div class="nk-danger"><span class="muted small">Removing the folder keeps its notes, in All notes.</span><button type="button" class="btn sm danger" data-nk-rmf>Remove folder</button></div>`,
    onSubmit: async (fd) => { await patch(`/api/notebook/folders/${id}`, { name: fd.get('name') }); toast('Folder renamed'); S.refresh(); } });
  m.form.querySelector('[data-nk-rmf]').addEventListener('click', async () => { try { await del(`/api/notebook/folders/${id}`); m.close(); toast('Folder removed. Its notes are in All notes.'); S.navigate('#/notes'); } catch (e) { m.setError(errMsg(e)); } });
};

// ---------- sharing ----------
actions['nk-share'] = async () => {
  const n = await get(`/api/notebook/${ed.id}`);
  const [people, projects] = await Promise.all([get('/api/directory'), get('/api/projects')]);
  const teams = projects.filter((p) => !p.archived && p.my_role);
  const perm = (s) => html`<select data-nk-perm="${s.id}" aria-label="${s.user_name || `${s.project_name} team`} ${s.perm === 'edit' ? 'can edit' : 'can view'}"><option value="view" ${raw(s.perm === 'view' ? 'selected' : '')}>Can view</option><option value="edit" ${raw(s.perm === 'edit' ? 'selected' : '')}>Can edit</option></select>`;
  const m = openModal({
    title: `Share “${n.title}”`, cancel: 'Done', footer: true,
    body: html`<div class="nk-share">
      <div class="nk-sh-add"><label class="sr" for="nk-sw">Person or project team</label><select id="nk-sw" data-nk-who><option value="">Add a person or a project team</option><optgroup label="People">${people.filter((u) => u.id !== S.me.id && !n.shares.some((s) => s.user_id === u.id)).map((u) => html`<option value="u${u.id}">${u.name}</option>`)}</optgroup>${teams.length ? html`<optgroup label="Project teams">${teams.filter((p) => !n.shares.some((s) => s.project_id === p.id)).map((p) => html`<option value="p${p.id}">${p.name} team</option>`)}</optgroup>` : ''}</select>
        <label class="sr" for="nk-sp">Can</label><select id="nk-sp" data-nk-newperm><option value="edit">Can edit</option><option value="view">Can view</option></select><button type="button" class="btn sm primary" data-nk-add>Add</button></div>
      <ul class="nk-sh-l">
        <li>${av(S.me.id, S.me.name, '')}<span class="nk-grow"><b>${S.me.name} (you)</b><span class="muted small">Made this note</span></span><span class="muted small">Full access</span></li>
        ${n.shares.map((s) => html`<li data-k="s${s.id}">${s.user_id ? av(s.user_id, s.user_name, '') : html`<span class="nk-team" style="background:${s.project_color}" aria-hidden="true"></span>`}<span class="nk-grow"><b>${s.user_id ? s.user_name : `${s.project_name} team`}</b><span class="muted small">${s.user_id ? s.user_title || '' : plural(s.team_size || 0, 'person', 'people')}</span></span>${perm(s)}<button type="button" class="nk-ib" data-nk-rm="${s.id}" aria-label="Stop sharing with ${s.user_name || `the ${s.project_name} team`}">${raw('<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>')}</button></li>`)}
      </ul>
      <p class="muted small" style="margin:0">Only the people here can open it. Managers and the owner can’t open your notes unless you share them.</p></div>`,
  });
  const f = m.form;
  f.querySelector('[data-nk-add]').addEventListener('click', async () => {
    const v = f.querySelector('[data-nk-who]').value; if (!v) { m.setError('Choose a person or a project team'); return; }
    try { await put(`/api/notebook/${n.id}/shares`, { [v[0] === 'u' ? 'user_id' : 'project_id']: Number(v.slice(1)), perm: f.querySelector('[data-nk-newperm]').value }); m.close(); toast('Shared'); await actions['nk-share'](); } catch (e) { m.setError(errMsg(e)); }
  });
  f.addEventListener('change', async (e) => {
    const s = e.target.dataset.nkPerm; if (!s) return;
    const sh = n.shares.find((x) => String(x.id) === s);
    try { await put(`/api/notebook/${n.id}/shares`, { [sh.user_id ? 'user_id' : 'project_id']: sh.user_id || sh.project_id, perm: e.target.value }); toast('Saved'); } catch (err) { m.setError(errMsg(err)); }
  });
  f.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-nk-rm]'); if (!b) return;
    try { await del(`/api/notebook/${n.id}/shares/${b.dataset.nkRm}`); m.close(); toast('No longer shared with them'); await actions['nk-share'](); } catch (err) { m.setError(errMsg(err)); }
  });
};
