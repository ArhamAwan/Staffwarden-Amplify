'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { need, str, optStr, int, HttpError } = require('../lib/http');

// Notes, like Apple Notes. A note is private to the person who wrote it: nobody else (not managers, not the
// owner) can open it unless it is shared with them, or with a project team they are on. People it is shared
// with can view it or edit it; only the writer shares, moves to a folder, or deletes it. Folders and pins
// are each person's own. A deleted note waits in Recently deleted until its writer restores it or deletes
// it for good.
//   The body is HTML from the editor, cleaned on the way in to a short list of tags and attributes, so
//   nothing in a note can run: no scripts, styles, event handlers, outside images or javascript: links.
const MAX_BODY = 400000;
const MAX_FILE = 25 * 1024 * 1024;

// ---------- the cleaner ----------
const TAGS = new Set(['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'h2', 'h3', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'a', 'img', 'hr', 'blockquote']);
const VOID = new Set(['br', 'img', 'hr']);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'head', 'title', 'textarea', 'select']);
const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function cleanAttrs(tag, raw) {
  const a = {};
  for (const m of String(raw).matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) a[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  const out = [];
  const cls = (a.class || '').split(/\s+/);
  if (tag === 'ul' && cls.includes('ck')) out.push('class="ck"');
  if (tag === 'li' && a['data-done'] === '1') out.push('data-done="1"');
  if (tag === 'span' && cls.includes('mention') && /^\d{1,9}$/.test(a['data-uid'] || '')) out.push('class="mention"', `data-uid="${a['data-uid']}"`, 'contenteditable="false"');
  if (tag === 'span' && cls.includes('nt-task') && /^\d{1,9}$/.test(a['data-task'] || '')) out.push('class="nt-task"', `data-task="${a['data-task']}"`, 'contenteditable="false"');
  if (tag === 'a') {
    if (/^\d{1,9}$/.test(a['data-file'] || '')) out.push('class="nt-file"', `data-file="${a['data-file']}"`, 'contenteditable="false"');
    else if (/^https?:\/\/[^\s"<>]+$/i.test(a.href || '')) out.push(`href="${escAttr(a.href)}"`, 'target="_blank"', 'rel="noopener noreferrer nofollow"');
  }
  if (tag === 'img') {
    if (!/^\d{1,9}$/.test(a['data-file'] || '')) return null;   // only pictures added to this note
    out.push(`data-file="${a['data-file']}"`, `alt="${escAttr((a.alt || '').slice(0, 200))}"`);
  }
  if ((tag === 'td' || tag === 'th') && /^[1-9]$/.test(a.colspan || '')) out.push(`colspan="${a.colspan}"`);
  return out.join(' ');
}
// Comments out: one pass, no backtracking (an unclosed "<!--" drops the rest, as a browser would).
function stripComments(s) {
  let out = '', i = 0, p;
  while ((p = s.indexOf('<!--', i)) !== -1) {
    out += s.slice(i, p);
    const e = s.indexOf('-->', p + 4);
    if (e === -1) return out;
    i = e + 3;
  }
  return out + s.slice(i);
}
// One left-to-right pass: every character is looked at a fixed number of times, so a note of any shape
// cleans in time proportional to its length (a regex here could be made to take minutes).
function cleanHtml(html) {
  const s = stripComments(String(html || '').replace(/\u0000/g, ''));
  const esc = (t) => t.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const head = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/y;
  let out = '', i = 0, p = 0, end = -1, drop = null;
  while ((p = s.indexOf('<', p)) !== -1) {
    if (end < p) end = s.indexOf('>', p);
    if (end === -1) break;                          // nothing closes it: the rest is text
    head.lastIndex = p;
    const h = head.exec(s);
    const k = h ? head.lastIndex : -1;
    // a tag is "<name" then the end, a space, or "/>"
    if (!h || !(k === end || /\s/.test(s[k]) || (s[k] === '/' && k + 1 === end))) { p += 1; continue; }
    let raw = s.slice(k, end).trimEnd();
    const selfClose = raw.endsWith('/');
    if (selfClose) raw = raw.slice(0, -1);
    if (!drop) out += esc(s.slice(i, p));
    i = p = end + 1;
    const tag = h[2].toLowerCase(), closing = h[1] === '/';
    if (drop) { if (closing && tag === drop) drop = null; continue; }
    if (DROP_WITH_CONTENT.has(tag)) { if (!closing && !selfClose) drop = tag; continue; }
    if (!TAGS.has(tag)) continue;
    if (closing) { if (!VOID.has(tag)) out += `</${tag}>`; continue; }
    const attrs = cleanAttrs(tag, raw);
    if (attrs === null) continue;
    out += `<${tag}${attrs ? ` ${attrs}` : ''}>`;
  }
  if (!drop) out += esc(s.slice(i));
  return out;
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', apos: "'" };
const BREAK = /^<(br|\/p|\/div|\/li|\/h2|\/h3|\/tr)\b/i;
// the plain text of cleaned note HTML (for search and previews), also in one linear pass
function textOf(html) {
  const s = String(html);
  let out = '', i = 0, p;
  while ((p = s.indexOf('<', i)) !== -1) {
    const e = s.indexOf('>', p);
    if (e === -1) break;
    out += s.slice(i, p) + (BREAK.test(s.slice(p, Math.min(e + 1, p + 8))) ? '\n' : '');
    i = e + 1;
  }
  out += s.slice(i);
  const cp = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
  return out.replace(/&(#?\w{1,10});/g, (x, e) => (ENT[e] ?? (/^#\d+$/.test(e) ? cp(Number(e.slice(1))) : x))).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

module.exports = (ctx) => {
  const { db, cfg, route, nowIso, clockNow, emitUsers, audit } = ctx;
  const N = () => ctx.notify;
  const fileDir = path.join(cfg.dataDir, 'notefiles');
  fs.mkdirSync(fileDir, { recursive: true });
  const staffOnly = (u) => need(u.kind !== 'client', 403, 'Not available');
  const nameOf = (id) => (id ? (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || null : null);
  const getNote = (id) => db.prepare('SELECT * FROM pnotes WHERE id = ?').get(Number(id));
  const onTeam = (pid, uid) => !!db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(pid, uid);

  // what this person may do with the note: 'owner', 'edit', 'view' or null
  function accessOf(user, n) {
    if (!n) return null;
    if (n.owner_id === user.id) return 'owner';
    let best = null;
    for (const s of db.prepare('SELECT * FROM note_shares WHERE note_id = ?').all(n.id)) {
      const mine = s.user_id === user.id || (s.project_id && onTeam(s.project_id, user.id));
      if (mine && (best === null || s.perm === 'edit')) best = s.perm;
    }
    return best;
  }
  // everyone who can open it (for live updates, mentions and who is here)
  function people(n) {
    const ids = new Set([n.owner_id]);
    for (const s of db.prepare('SELECT * FROM note_shares WHERE note_id = ?').all(n.id)) {
      if (s.user_id) ids.add(s.user_id);
      if (s.project_id) for (const r of db.prepare('SELECT user_id FROM project_members WHERE project_id = ?').all(s.project_id)) ids.add(r.user_id);
    }
    return [...ids].filter((id) => (db.prepare('SELECT active FROM users WHERE id = ?').get(id) || {}).active);
  }
  function load(user, id, { edit = false, owner = false, deleted = false } = {}) {
    const n = getNote(id);
    const a = accessOf(user, n);
    need(n && a, 404, 'Note not found');
    need(deleted || !n.deleted_at || a === 'owner', 404, 'Note not found');
    if (owner) need(a === 'owner', 403, 'Only the person who wrote this note can do that');
    if (edit) need(a === 'owner' || a === 'edit', 403, 'You can view this note, but not change it');
    return { n, a };
  }
  const tell = (n, extra = {}) => emitUsers(people(n), 'notes', { note_id: n.id, ...extra });

  // ---------- who has it open, and who is typing ----------
  const here = new Map();   // note id -> Map(user id -> { at, typing })
  function presence(noteId, exceptId) {
    const m = here.get(noteId); if (!m) return [];
    const now = clockNow(), out = [];
    for (const [uid, p] of m) { if (now - p.at > 40000) { m.delete(uid); continue; } if (uid !== exceptId) out.push({ id: uid, name: nameOf(uid), typing: now - p.typingAt < 8000 }); }
    return out;
  }

  // ---------- a note, for its list and for the page ----------
  function summary(user, n, pins) {
    const shares = db.prepare('SELECT s.*, u.name AS user_name, p.name AS project_name, p.key AS project_key, p.color AS project_color FROM note_shares s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN projects p ON p.id = s.project_id WHERE s.note_id = ?').all(n.id);
    const text = n.text || '';
    return {
      id: n.id, title: n.title || firstLine(text) || 'New note', titled: !!n.title, snippet: (n.title ? text : text.split('\n').slice(1).join(' ')).replace(/\s+/g, ' ').slice(0, 160),
      owner: { id: n.owner_id, name: nameOf(n.owner_id) }, mine: n.owner_id === user.id, access: accessOf(user, n),
      folder_id: n.owner_id === user.id ? n.folder_id : null, pinned: pins.has(n.id),
      shared: shares.length > 0, people: [...new Set([n.owner_id, ...shares.filter((s) => s.user_id).map((s) => s.user_id)])].slice(0, 4).map((id) => ({ id, name: nameOf(id) })),
      projects: shares.filter((s) => s.project_id).map((s) => ({ id: s.project_id, name: s.project_name, key: s.project_key, color: s.project_color })),
      updated_at: n.updated_at, created_at: n.created_at, deleted_at: n.deleted_at,
    };
  }
  const firstLine = (t) => String(t || '').split('\n').map((x) => x.trim()).find(Boolean) || '';

  // every note this person can open
  function visibleNotes(user) {
    const own = db.prepare('SELECT * FROM pnotes WHERE owner_id = ?').all(user.id);
    const sharedIds = new Set(db.prepare('SELECT note_id FROM note_shares WHERE user_id = ?').all(user.id).map((r) => r.note_id));
    const projects = db.prepare('SELECT project_id FROM project_members WHERE user_id = ?').all(user.id).map((r) => r.project_id);
    if (projects.length) for (const r of db.prepare(`SELECT note_id FROM note_shares WHERE project_id IN (${projects.map(() => '?').join(',')})`).all(...projects)) sharedIds.add(r.note_id);
    const shared = sharedIds.size ? db.prepare(`SELECT * FROM pnotes WHERE id IN (${[...sharedIds].map(() => '?').join(',')}) AND owner_id != ? AND deleted_at IS NULL`).all(...sharedIds, user.id) : [];
    return [...own, ...shared];
  }

  route('GET', '/api/notebook', ({ user, query }) => {
    staffOnly(user);
    const pins = new Set(db.prepare('SELECT note_id FROM note_pins WHERE user_id = ?').all(user.id).map((r) => r.note_id));
    const all = visibleNotes(user);
    const q = (query.get('q') || '').trim().toLowerCase();
    const live = all.filter((n) => !n.deleted_at);
    const list = (query.get('folder') === 'deleted' ? all.filter((n) => n.deleted_at && n.owner_id === user.id) : live)
      .filter((n) => !q || `${n.title}\n${n.text}`.toLowerCase().includes(q))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((n) => summary(user, n, pins));
    const folders = db.prepare('SELECT id, name FROM note_folders WHERE owner_id = ? ORDER BY position, name').all(user.id)
      .map((f) => ({ ...f, count: live.filter((n) => n.owner_id === user.id && n.folder_id === f.id).length }));
    const projects = db.prepare(`SELECT DISTINCT p.id, p.name, p.key, p.color FROM note_shares s JOIN projects p ON p.id = s.project_id JOIN pnotes n ON n.id = s.note_id
      WHERE n.deleted_at IS NULL AND s.note_id IN (${live.map(() => '?').join(',') || 'NULL'}) ORDER BY p.name`).all(...live.map((n) => n.id))
      .map((p) => ({ ...p, count: live.filter((n) => db.prepare('SELECT 1 FROM note_shares WHERE note_id = ? AND project_id = ?').get(n.id, p.id)).length }));
    return {
      notes: list, folders, projects,
      counts: { all: live.length, pinned: live.filter((n) => pins.has(n.id)).length, shared: live.filter((n) => n.owner_id !== user.id).length, deleted: all.filter((n) => n.deleted_at && n.owner_id === user.id).length },
    };
  });

  route('GET', '/api/notebook/:id', ({ user, params }) => {
    staffOnly(user);
    const { n, a } = load(user, params.id, { deleted: true });
    const pins = new Set(db.prepare('SELECT note_id FROM note_pins WHERE user_id = ?').all(user.id).map((r) => r.note_id));
    const shares = db.prepare('SELECT s.id, s.user_id, s.project_id, s.perm, u.name AS user_name, u.title AS user_title, p.name AS project_name, p.key AS project_key, p.color AS project_color FROM note_shares s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN projects p ON p.id = s.project_id WHERE s.note_id = ? ORDER BY s.id').all(n.id)
      .map((s) => ({ ...s, team_size: s.project_id ? db.prepare('SELECT COUNT(*) c FROM project_members WHERE project_id = ?').get(s.project_id).c : null }));
    // the tasks linked in it: what this person may see of each
    const taskIds = [...new Set([...n.body.matchAll(/data-task="(\d+)"/g)].map((m) => Number(m[1])))];
    const tasks = {};
    for (const id of taskIds) {
      const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (t && ctx.taskVisible && ctx.taskVisible(user, t)) { const [o] = ctx.shapeTasks([t]); tasks[id] = { id, key: o.key, title: o.title, status: o.status, assignee: o.assignee }; }
      else tasks[id] = { id, hidden: true };
    }
    return {
      ...summary(user, n, pins), body: n.body, version: n.version, updated_by: nameOf(n.updated_by),
      shares: a === 'owner' ? shares : shares.map(({ id, ...s }) => s), tasks,
      files: db.prepare('SELECT id, name, mime, size FROM note_files WHERE note_id = ?').all(n.id),
      // who can be @mentioned: everyone who can open it
      pool: people(n).filter((id) => id !== user.id).map((id) => ({ id, name: nameOf(id), title: (db.prepare('SELECT title FROM users WHERE id = ?').get(id) || {}).title || null })),
      here: presence(n.id, user.id),
    };
  });

  route('POST', '/api/notebook', ({ user, body }) => {
    staffOnly(user);
    const folder = body.folder_id ? int(Number(body.folder_id), 'folder_id', 1, 1e9) : null;
    if (folder) need(db.prepare('SELECT 1 FROM note_folders WHERE id = ? AND owner_id = ?').get(folder, user.id), 404, 'Folder not found');
    const html = cleanHtml(optStr(body.body, 'body', MAX_BODY) || '');
    const title = (optStr(body.title, 'title', 300) || '').trim();
    const now = nowIso();
    const id = Number(db.prepare('INSERT INTO pnotes (owner_id, folder_id, title, body, text, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?)').run(user.id, folder, title, html, textOf(html), now, now, user.id).lastInsertRowid);
    // a note made inside a project's folder is shared with that team (they can view it)
    if (body.project_id) {
      const pid = int(Number(body.project_id), 'project_id', 1, 1e9);
      need(onTeam(pid, user.id), 403, 'You are not on that project');
      db.prepare("INSERT INTO note_shares (note_id, project_id, perm, created_at) VALUES (?,?,'view',?)").run(id, pid, now);
    }
    const n = getNote(id);
    mentions(user, n);
    tell(n);
    return { id };
  });

  // save: the title and the body, and the version it was based on (a newer one is refused, so nothing is lost)
  route('PUT', '/api/notebook/:id', ({ user, params, body }) => {
    staffOnly(user);
    const { n } = load(user, params.id, { edit: true });
    need(!n.deleted_at, 409, 'This note is in Recently deleted. Restore it to change it.');
    const base = int(Number(body.version), 'version', 1, 1e9);
    if (base !== n.version) { const e = new HttpError(409, `${nameOf(n.updated_by) || 'Someone'} changed this note`); e.extra = { latest: { version: n.version, body: n.body, title: n.title, updated_by: nameOf(n.updated_by) } }; throw e; }
    const html = 'body' in body ? cleanHtml(optStr(body.body, 'body', MAX_BODY) || '') : n.body;
    const title = 'title' in body ? (optStr(body.title, 'title', 300) || '').trim() : n.title;
    db.prepare('UPDATE pnotes SET title = ?, body = ?, text = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(title, html, textOf(html), nowIso(), user.id, n.id);
    const after = getNote(n.id);
    mentions(user, after);
    // anyone with it open hears about it (and refreshes when they aren't typing)
    tell(after, { by: user.id, version: after.version });
    return { version: after.version, updated_at: after.updated_at, body: after.body };
  });

  // tell newly @mentioned people (only people who can open the note)
  function mentions(user, n) {
    const pool = new Set(people(n));
    const ids = [...new Set([...n.body.matchAll(/class="mention" data-uid="(\d+)"/g)].map((m) => Number(m[1])))].filter((id) => id !== user.id && pool.has(id));
    for (const id of ids) {
      const r = db.prepare('INSERT OR IGNORE INTO note_mentions (note_id, user_id, by_id, created_at) VALUES (?,?,?,?)').run(n.id, id, user.id, nowIso());
      if (r.changes) N().notify(id, { kind: 'note_mention', title: `${user.name} mentioned you in “${n.title || firstLine(n.text) || 'a note'}”`, body: firstLine(n.text).slice(0, 160) || null, link: `#/notes?id=${n.id}`, actor: user });
    }
  }

  // move to a folder, pin
  route('PATCH', '/api/notebook/:id', ({ user, params, body }) => {
    staffOnly(user);
    const { n, a } = load(user, params.id);
    if ('pinned' in body) {
      if (body.pinned) db.prepare('INSERT OR IGNORE INTO note_pins (user_id, note_id) VALUES (?,?)').run(user.id, n.id);
      else db.prepare('DELETE FROM note_pins WHERE user_id = ? AND note_id = ?').run(user.id, n.id);
    }
    if ('folder_id' in body) {
      need(a === 'owner', 403, 'Only the person who wrote this note can move it');
      const f = body.folder_id == null || body.folder_id === '' ? null : int(Number(body.folder_id), 'folder_id', 1, 1e9);
      if (f) need(db.prepare('SELECT 1 FROM note_folders WHERE id = ? AND owner_id = ?').get(f, user.id), 404, 'Folder not found');
      db.prepare('UPDATE pnotes SET folder_id = ? WHERE id = ?').run(f, n.id);
    }
    ctx.emitTo(user.id, 'notes');
    return { ok: true };
  });

  // Recently deleted: to it, back from it, and out of it for good (the writer only)
  route('DELETE', '/api/notebook/:id', ({ user, params, query }) => {
    staffOnly(user);
    const { n } = load(user, params.id, { owner: true, deleted: true });
    if (query.get('forever') === '1') {
      need(n.deleted_at, 409, 'Move it to Recently deleted first');
      for (const f of db.prepare('SELECT file FROM note_files WHERE note_id = ?').all(n.id)) { try { fs.unlinkSync(path.join(fileDir, f.file)); } catch { /* gone */ } }
      const ppl = people(n);
      db.prepare('DELETE FROM pnotes WHERE id = ?').run(n.id);
      emitUsers(ppl, 'notes', { note_id: n.id });
      return { ok: true };
    }
    db.prepare('UPDATE pnotes SET deleted_at = ? WHERE id = ?').run(nowIso(), n.id);
    tell(n);
    return { ok: true };
  });
  route('POST', '/api/notebook/:id/restore', ({ user, params }) => {
    staffOnly(user);
    const { n } = load(user, params.id, { owner: true, deleted: true });
    db.prepare('UPDATE pnotes SET deleted_at = NULL WHERE id = ?').run(n.id);
    tell(n);
    return { ok: true };
  });

  // ---------- sharing (the writer) ----------
  route('PUT', '/api/notebook/:id/shares', ({ user, params, body }) => {
    staffOnly(user);
    const { n } = load(user, params.id, { owner: true });
    const perm = body.perm === 'edit' ? 'edit' : 'view';
    const now = nowIso();
    if (body.user_id != null) {
      const uid = int(Number(body.user_id), 'user_id', 1, 1e9);
      need(uid !== user.id, 400, 'This is your note already');
      const u = db.prepare('SELECT id, name, active FROM users WHERE id = ?').get(uid);
      need(u && u.active, 404, 'Person not found');
      const had = db.prepare('SELECT 1 FROM note_shares WHERE note_id = ? AND user_id = ?').get(n.id, uid);
      db.prepare('INSERT INTO note_shares (note_id, user_id, perm, created_at) VALUES (?,?,?,?) ON CONFLICT(note_id, user_id) DO UPDATE SET perm = excluded.perm').run(n.id, uid, perm, now);
      if (!had) N().notify(uid, { kind: 'note_shared', title: `${user.name} shared “${n.title || firstLine(n.text) || 'a note'}” with you`, body: perm === 'edit' ? 'You can edit it.' : 'You can read it.', link: `#/notes?id=${n.id}`, actor: user });
    } else if (body.project_id != null) {
      const pid = int(Number(body.project_id), 'project_id', 1, 1e9);
      const p = ctx.getProject(pid);
      need(p && ctx.projectVisible(user, p), 404, 'Project not found');
      need(onTeam(pid, user.id), 403, 'You can share with the team of a project you are on');
      db.prepare('INSERT INTO note_shares (note_id, project_id, perm, created_at) VALUES (?,?,?,?) ON CONFLICT(note_id, project_id) DO UPDATE SET perm = excluded.perm').run(n.id, pid, perm, now);
    } else need(false, 400, 'Choose a person or a project');
    audit(user, 'note.shared', body.user_id ? Number(body.user_id) : null, `note ${n.id}`);
    tell(n);
    return { ok: true };
  });
  route('DELETE', '/api/notebook/:id/shares/:sid', ({ user, params }) => {
    staffOnly(user);
    const { n } = load(user, params.id, { owner: true });
    const ppl = people(n);
    db.prepare('DELETE FROM note_shares WHERE id = ? AND note_id = ?').run(Number(params.sid), n.id);
    emitUsers(ppl, 'notes', { note_id: n.id });
    return { ok: true };
  });

  // ---------- folders (each person's own) ----------
  route('POST', '/api/notebook/folders', ({ user, body }) => {
    staffOnly(user);
    const name = str(body.name, 'name', 60).trim();
    need(name, 400, 'Give the folder a name');
    need(!db.prepare('SELECT 1 FROM note_folders WHERE owner_id = ? AND lower(name) = lower(?)').get(user.id, name), 409, 'You already have a folder with that name');
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM note_folders WHERE owner_id = ?').get(user.id).p;
    const id = Number(db.prepare('INSERT INTO note_folders (owner_id, name, position, created_at) VALUES (?,?,?,?)').run(user.id, name, pos, nowIso()).lastInsertRowid);
    ctx.emitTo(user.id, 'notes');
    return { id, name };
  });
  route('PATCH', '/api/notebook/folders/:id', ({ user, params, body }) => {
    staffOnly(user);
    const f = db.prepare('SELECT * FROM note_folders WHERE id = ? AND owner_id = ?').get(Number(params.id), user.id);
    need(f, 404, 'Folder not found');
    const name = str(body.name, 'name', 60).trim();
    need(name, 400, 'Give the folder a name');
    db.prepare('UPDATE note_folders SET name = ? WHERE id = ?').run(name, f.id);
    ctx.emitTo(user.id, 'notes');
    return { ok: true };
  });
  // a folder goes; its notes stay, in All notes
  route('DELETE', '/api/notebook/folders/:id', ({ user, params }) => {
    staffOnly(user);
    const f = db.prepare('SELECT * FROM note_folders WHERE id = ? AND owner_id = ?').get(Number(params.id), user.id);
    need(f, 404, 'Folder not found');
    db.prepare('UPDATE pnotes SET folder_id = NULL WHERE folder_id = ?').run(f.id);
    db.prepare('DELETE FROM note_folders WHERE id = ?').run(f.id);
    ctx.emitTo(user.id, 'notes');
    return { ok: true };
  });

  // ---------- pictures and files in a note ----------
  route('POST', '/api/notebook/:id/files', ({ user, params, body, query }) => {
    staffOnly(user);
    const { n } = load(user, params.id, { edit: true });
    need(Buffer.isBuffer(body) && body.length > 0, 400, 'The file is empty');
    need(body.length <= MAX_FILE, 413, 'Files can be up to 25 MB');
    const name = String(query.get('name') || 'file').replace(/[\\/\0]/g, '_').slice(0, 200) || 'file';
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(query.get('mime') || '') ? query.get('mime') : 'application/octet-stream';
    const file = `${n.id}-${crypto.randomBytes(12).toString('hex')}`;
    fs.writeFileSync(path.join(fileDir, file), body);
    const id = Number(db.prepare('INSERT INTO note_files (note_id, user_id, name, mime, size, file, created_at) VALUES (?,?,?,?,?,?,?)').run(n.id, user.id, name, mime, body.length, file, nowIso()).lastInsertRowid);
    return { id, name, mime, size: body.length, image: /^image\/(png|jpeg|webp|gif)$/.test(mime) };
  }, { raw: MAX_FILE });
  route('GET', '/api/notebook/:id/files/:fid', ({ user, params }) => {
    staffOnly(user);
    const { n } = load(user, params.id, { deleted: true });
    const f = db.prepare('SELECT * FROM note_files WHERE id = ? AND note_id = ?').get(Number(params.fid), n.id);
    need(f, 404, 'File not found');
    const p = path.join(fileDir, f.file);
    need(fs.existsSync(p), 404, 'File missing');
    // pictures show on the page; anything else only downloads, so nothing uploaded can run here
    const img = /^image\/(png|jpeg|webp|gif)$/.test(f.mime || '');
    return { raw: fs.readFileSync(p), type: img ? f.mime : 'application/octet-stream', headers: { 'Content-Disposition': `${img ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" } };
  });

  // ---------- who is here ----------
  route('POST', '/api/notebook/:id/here', ({ user, params, body }) => {
    staffOnly(user);
    const { n } = load(user, params.id);
    if (!here.has(n.id)) here.set(n.id, new Map());
    const m = here.get(n.id), prev = m.get(user.id);
    const now = clockNow();
    if (body && body.leave) m.delete(user.id);
    else m.set(user.id, { at: now, typingAt: body && body.typing ? now : prev ? prev.typingAt || 0 : 0 });
    // the others with it open see the change straight away
    if (!prev || !!(body && body.typing) !== (prev && now - (prev.typingAt || 0) < 8000) || (body && body.leave)) tell(n, { here: true });
    return { here: presence(n.id, user.id) };
  });

  ctx.notesClean = cleanHtml;
};
module.exports.cleanHtml = cleanHtml;
module.exports.textOf = textOf;
