'use strict';
// Assets: everything for one client in one place. Logos, colours and fonts (Brand), links, files and
// pictures, where each login is kept (never the password), and notes. They belong to the client and show
// on the client's page and on every project of theirs; a project with no client keeps its own, and they
// move to the client when the project is linked to one. Logins and team-only items never reach the client;
// the client sees what is shared with them in the portal, and can send files in.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { need, str, optStr, int } = require('../lib/http');

const SECTIONS = ['brand', 'links', 'files', 'logins', 'notes'];
const KINDS = ['file', 'link', 'color', 'font', 'login', 'note'];
const HOME = { file: 'files', link: 'links', color: 'brand', font: 'brand', login: 'logins', note: 'notes' };
const MAX_JSON = 5 * 1024 * 1024;
const MAX_RAW = 50 * 1024 * 1024;
const INLINE = /^image\/(png|jpeg|webp|gif)$/;
const PINNABLE = /^(image\/(png|jpeg|webp|gif)|application\/pdf)$/;

module.exports = (ctx) => {
  const { db, cfg, route, nowIso, isManager, projectVisible, getProject, isProjectLead } = ctx;
  const N = ctx.notify;
  const C = { client: true };
  const dir = path.join(cfg.dataDir, 'asset-files');
  fs.mkdirSync(dir, { recursive: true });
  const taskDir = path.join(cfg.dataDir, 'files');

  const clientRow = (id) => db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  const projectsOf = (cid) => db.prepare('SELECT * FROM projects WHERE client_id = ?').all(cid);
  const canSeeClient = (user, cid) => isManager(user) || projectsOf(cid).some((p) => projectVisible(user, p));
  const nameOf = (id) => (id ? (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || null : null);

  // whose assets: a client's, or a project's own while it has no client
  function scopeOf(user, src) {
    const pid = src.project ?? src.project_id, cid = src.client ?? src.client_id;
    if (pid != null && pid !== '') {
      const p = getProject(Number(pid));
      need(p && projectVisible(user, p), 404, 'Project not found');
      if (p.client_id) { const c = clientRow(p.client_id); if (c) return { client_id: c.id, project_id: null, name: c.name, client: c, via: p }; }
      return { client_id: null, project_id: p.id, name: p.name, via: p };
    }
    need(cid != null && cid !== '', 400, 'Say which client or project');
    const c = clientRow(Number(cid));
    need(c && canSeeClient(user, c.id), 404, 'Client not found');
    return { client_id: c.id, project_id: null, name: c.name, client: c };
  }
  const scopeSql = (s) => (s.client_id ? ['client_id = ?', s.client_id] : ['project_id = ?', s.project_id]);
  const scopeOfAsset = (a) => (a.client_id ? { client_id: a.client_id, project_id: null } : { client_id: null, project_id: a.project_id });
  function loadAsset(user, id) {
    const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(id));
    need(a, 404, 'Not found');
    if (a.client_id) need(canSeeClient(user, a.client_id), 404, 'Not found');
    else { const p = getProject(a.project_id); need(p && projectVisible(user, p), 404, 'Not found'); }
    return a;
  }
  const canRemove = (user, a) => a.created_by === user.id || isManager(user)
    || (a.client_id ? projectsOf(a.client_id).some((p) => isProjectLead(p, user)) : isProjectLead(getProject(a.project_id), user));

  function out(a) {
    let host = null;
    if (a.url) { try { host = new URL(a.url).hostname.replace(/^www\./, ''); } catch { /* kept as typed */ } }
    const t = a.source_task_id ? db.prepare('SELECT t.id, t.number, t.title, p.key FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?').get(a.source_task_id) : null;
    return {
      id: a.id, section: a.section, kind: a.kind, title: a.title, url: a.url, host, value: a.value, note: a.note,
      file_name: a.file_name, mime: a.mime, size: a.size, has_file: !!a.file, chain_id: a.chain_id || a.id, version: a.version,
      shared: !!a.shared, created_at: a.created_at, updated_at: a.updated_at,
      by: a.client_user_id ? (db.prepare('SELECT name FROM client_users WHERE id = ?').get(a.client_user_id) || {}).name || 'The client' : nameOf(a.created_by),
      from_client: !!a.client_user_id, created_by: a.created_by,
      task: t ? { id: t.id, key: t.key && t.number ? `${t.key}-${t.number}` : null, title: t.title } : null,
    };
  }
  const listOf = (s) => { const [w, v] = scopeSql(s); return db.prepare(`SELECT * FROM assets WHERE ${w} ORDER BY created_at, id`).all(v); };

  // ---------- checking what was sent ----------
  function readFields(body, kind, { partial = false } = {}) {
    const set = {};
    if ('title' in body) set.title = optStr(body.title, 'title', 120) || null;
    if ('note' in body) set.note = optStr(body.note, 'note', 2000) || null;
    if ('section' in body && body.section != null) { need(SECTIONS.includes(body.section), 400, 'section must be brand, links, files, logins or notes'); set.section = body.section; }
    if ('shared' in body) set.shared = body.shared ? 1 : 0;
    if ('url' in body && (kind === 'link' || body.url)) {
      const raw = str(body.url, 'url', 2000).trim();
      let u = null; try { u = new URL(/^[a-z][\w+.-]*:/i.test(raw) ? raw : `https://${raw}`); } catch { /* checked below */ }
      need(u && (u.protocol === 'https:' || u.protocol === 'http:') && /\./.test(u.hostname), 400, 'Paste a link that starts with https://');
      set.url = u.href;
    }
    if ('value' in body) {
      if (kind === 'color') {
        let v = String(body.value || '').trim().replace(/^([0-9a-f]{3}|[0-9a-f]{6})$/i, '#$1');
        if (/^#[0-9a-f]{3}$/i.test(v)) v = `#${v.slice(1).split('').map((c) => c + c).join('')}`;
        need(/^#[0-9a-f]{6}$/i.test(v), 400, 'A colour is a code like #1F4E46');
        set.value = v.toUpperCase();
      } else set.value = optStr(body.value, 'value', kind === 'note' ? 4000 : 300) || null;
    }
    if (!partial) {
      if (kind === 'link') need(set.url, 400, 'Paste the link');
      if (['color', 'font', 'login', 'note'].includes(kind)) need(set.value, 400, kind === 'login' ? 'Say where the login is kept' : kind === 'note' ? 'Write the note' : 'Add the value');
    }
    return set;
  }
  const defaultTitle = (kind, set) => set.title || (kind === 'link' ? (() => { try { return new URL(set.url).hostname.replace(/^www\./, ''); } catch { return 'Link'; } })() : kind === 'color' ? set.value : kind === 'font' ? set.value : kind === 'note' ? 'Note' : 'Login');

  function insert(s, user, row) {
    const now = nowIso();
    const r = { client_id: s.client_id, project_id: s.project_id, created_by: user && user.kind !== 'client' ? user.id : null, created_at: now, updated_at: now, shared: 0, version: 1, ...row };
    if (r.kind === 'login') r.shared = 0;   // where a login is kept never leaves the team
    const keys = Object.keys(r);
    const id = Number(db.prepare(`INSERT INTO assets (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => r[k])).lastInsertRowid);
    if (!r.chain_id) db.prepare('UPDATE assets SET chain_id = ? WHERE id = ?').run(id, id);
    changed(s);
    return db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  }
  function changed(s) {
    if (s.client_id) for (const p of projectsOf(s.client_id)) ctx.emitPortal && ctx.emitPortal(p, 'assets');
    ctx.emit && ctx.emit('assets');
  }
  function storeFile(buf) {
    const file = `${crypto.randomBytes(12).toString('hex')}`;
    fs.writeFileSync(path.join(dir, file), buf);
    return file;
  }
  const cleanName = (n) => String(n || 'file').replace(/[\\/\0]/g, '_').slice(0, 200) || 'file';
  const cleanMime = (m) => (typeof m === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(m) ? m : 'application/octet-stream');
  // a new version of an asset already there: it joins the same chain
  function chainFor(s, versionOf) {
    if (versionOf == null || versionOf === '') return {};
    const prev = db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(versionOf));
    const same = prev && (s.client_id ? prev.client_id === s.client_id : prev.project_id === s.project_id);
    need(same && prev.kind === 'file', 404, 'The earlier version was not found');
    const chain = prev.chain_id || prev.id;
    const v = db.prepare('SELECT MAX(version) v FROM assets WHERE chain_id = ?').get(chain).v || 1;
    return { chain_id: chain, version: v + 1, title: prev.title, section: prev.section, shared: prev.shared };
  }
  function addFile(user, s, { name, mime, buf, section, shared, title, note, versionOf, client_user_id = null }) {
    need(buf.length > 0, 400, 'The file is empty');
    const chain = chainFor(s, versionOf);
    return insert(s, user, {
      kind: 'file', section: section && SECTIONS.includes(section) && section !== 'logins' ? section : 'files',
      title: (title || cleanName(name).replace(/\.[a-z0-9]{1,5}$/i, '')).slice(0, 120), note: note || null,
      file: storeFile(buf), file_name: cleanName(name), mime: cleanMime(mime), size: buf.length, shared: shared ? 1 : 0, client_user_id,
      ...chain, ...(chain.title && !title ? {} : title ? { title } : {}),
    });
  }

  // ---------- the team ----------
  route('GET', '/api/assets', ({ user, query }) => {
    const s = scopeOf(user, { client: query.get('client'), project: query.get('project') });
    const portal = s.client ? db.prepare('SELECT COUNT(*) n FROM client_users WHERE client_id = ? AND active = 1').get(s.client.id).n : 0;
    return {
      scope: { client_id: s.client_id, project_id: s.project_id, name: s.name, has_client: !!s.client_id, client_signs_in: portal > 0 },
      assets: listOf(s).map(out),
    };
  });
  route('POST', '/api/assets', ({ user, body }) => {
    const s = scopeOf(user, body);
    const kind = body.kind;
    need(KINDS.includes(kind), 400, 'kind must be file, link, color, font, login or note');
    if (kind === 'file') {
      const buf = Buffer.from(str(body.data_base64, 'data_base64', ctx.MAX_BODY), 'base64');
      need(buf.length <= MAX_JSON, 413, 'Files over 5 MB are sent another way. Update the page and try again.');
      return out(addFile(user, s, { name: str(body.name, 'name', 200), mime: body.mime, buf, section: body.section, shared: !!body.shared, title: optStr(body.title, 'title', 120), note: optStr(body.note, 'note', 2000), versionOf: body.version_of }));
    }
    const set = readFields(body, kind);
    if (kind === 'link') {
      // the same link twice is the same asset
      const [w, v] = scopeSql(s);
      const dup = db.prepare(`SELECT * FROM assets WHERE ${w} AND kind = 'link' AND url = ?`).get(v, set.url);
      need(!dup, 409, `That link is already saved as “${dup && dup.title}”`);
    }
    return out(insert(s, user, { kind, section: set.section || HOME[kind], title: defaultTitle(kind, set), url: set.url || null, value: set.value || null, note: set.note || null, shared: set.shared || 0 }));
  });
  // the file itself as the body, up to 50 MB
  route('POST', '/api/assets/upload', ({ user, body, query }) => {
    const q = (k, max) => { const v = query.get(k); return v == null || v === '' ? null : String(v).slice(0, max); };
    const s = scopeOf(user, { client: q('client', 20), project: q('project', 20) });
    need(q('name', 200), 400, 'name is required');
    return out(addFile(user, s, { name: q('name', 200), mime: q('mime', 100), buf: body, section: q('section', 20), shared: q('shared', 5) === '1', title: q('title', 120), note: q('note', 2000), versionOf: q('version_of', 20) }));
  }, { raw: MAX_RAW });
  route('PATCH', '/api/assets/:id', ({ user, params, body }) => {
    const a = loadAsset(user, params.id);
    const set = readFields(body, a.kind, { partial: true });
    if (a.kind === 'login') delete set.shared;
    if (set.section === 'logins' && a.kind !== 'login') delete set.section;
    if ('title' in set && !set.title) delete set.title;
    need(Object.keys(set).length, 400, 'Nothing to change');
    set.updated_at = nowIso();
    const keys = Object.keys(set);
    // a file's name, section and who sees it apply to every version
    const where = a.kind === 'file' && keys.some((k) => ['title', 'section', 'shared'].includes(k)) ? 'chain_id = ?' : 'id = ?';
    const shared = keys.filter((k) => ['title', 'section', 'shared', 'updated_at'].includes(k));
    if (where === 'chain_id = ?') db.prepare(`UPDATE assets SET ${shared.map((k) => `${k} = ?`).join(', ')} WHERE chain_id = ?`).run(...shared.map((k) => set[k]), a.chain_id || a.id);
    const own = keys.filter((k) => where === 'id = ?' || !['title', 'section', 'shared'].includes(k));
    if (own.length) db.prepare(`UPDATE assets SET ${own.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...own.map((k) => set[k]), a.id);
    changed(scopeOfAsset(a));
    return out(db.prepare('SELECT * FROM assets WHERE id = ?').get(a.id));
  });
  route('DELETE', '/api/assets/:id', ({ user, params }) => {
    const a = loadAsset(user, params.id);
    need(canRemove(user, a), 403, 'Only the person who added it, the project manager can remove it');
    if (a.file) { try { fs.unlinkSync(path.join(dir, a.file)); } catch { /* gone */ } }
    db.prepare('DELETE FROM assets WHERE id = ?').run(a.id);
    // the next version down becomes the one shown
    changed(scopeOfAsset(a));
    return { ok: true };
  });
  function sendFile(a, inline) {
    need(a.file, 404, 'No file');
    const p = path.join(dir, a.file);
    need(fs.existsSync(p), 404, 'File missing');
    const show = inline && INLINE.test(a.mime || '');
    return { raw: fs.readFileSync(p), type: show ? a.mime : a.mime || 'application/octet-stream', headers: { 'Content-Disposition': `${show ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.file_name || 'file')}`, 'X-Content-Type-Options': 'nosniff', ...(show ? { 'Content-Security-Policy': "default-src 'none'" } : {}) } };
  }
  route('GET', '/api/assets/:id/file', ({ user, params, query }) => sendFile(loadAsset(user, params.id), query && query.get('inline') === '1'));

  // ---------- from a task: save a file or a link to the client's assets ----------
  function taskScope(t) {
    if (!t.project_id) return null;
    const p = getProject(t.project_id);
    if (!p) return null;
    if (p.client_id) { const c = clientRow(p.client_id); if (c) return { client_id: c.id, project_id: null, name: c.name, client: c, via: p }; }
    return { client_id: null, project_id: p.id, name: p.name, via: p };
  }
  const clientSees = (t, s) => !!(s.client && ctx.portalTaskVisible && ctx.portalTaskVisible(t, ctx.clientSettings(s.client)));
  function saveTaskFile(t, f, user, s, { auto = false } = {}) {
    const exists = db.prepare('SELECT * FROM assets WHERE source_file_id = ?').get(f.id);
    if (exists) return exists;
    const src = path.join(taskDir, f.file);
    if (!fs.existsSync(src)) return null;
    const file = `${crypto.randomBytes(12).toString('hex')}`;
    fs.copyFileSync(src, path.join(dir, file));
    // a later version of work saved before joins the same chain
    const chainSrc = f.chain_id || f.id;
    const prev = db.prepare('SELECT * FROM assets WHERE source_chain_id = ? ORDER BY version DESC LIMIT 1').get(chainSrc);
    const label = f.label || String(f.name).replace(/\.[a-z0-9]{1,5}$/i, '');
    return insert(s, user, {
      kind: 'file', section: 'files', title: (prev ? prev.title : label).slice(0, 120), file, file_name: f.name, mime: f.mime, size: f.size,
      shared: prev ? prev.shared : auto && clientSees(t, s) ? 1 : 0, source_task_id: t.id, source_file_id: f.id, source_chain_id: chainSrc,
      chain_id: prev ? prev.chain_id : null, version: prev ? prev.version + 1 : 1,
    });
  }
  // when work is approved, the approved version of each picture and PDF is saved for the client
  ctx.assetsOnApproved = (t, user) => {
    try {
      const s = taskScope(t);
      if (!s) return [];
      const files = db.prepare('SELECT * FROM task_files WHERE task_id = ? ORDER BY version DESC, id DESC').all(t.id);
      const seen = new Set(), saved = [];
      for (const f of files) {
        const chain = f.chain_id || f.id;
        if (seen.has(chain)) continue;
        seen.add(chain);
        if (!PINNABLE.test(f.mime || '')) continue;
        const a = saveTaskFile(t, f, user, s, { auto: true });
        if (a) saved.push(a.id);
      }
      return saved;
    } catch { return []; }
  };
  ctx.assetsForTask = (t) => {
    const s = taskScope(t);
    if (!s) return null;
    const [w, v] = scopeSql(s);
    const files = new Set(db.prepare(`SELECT source_file_id FROM assets WHERE ${w} AND source_file_id IS NOT NULL`).all(v).map((r) => r.source_file_id));
    const urls = new Set(db.prepare(`SELECT url FROM assets WHERE ${w} AND kind = 'link'`).all(v).map((r) => r.url));
    const saved = db.prepare('SELECT * FROM assets WHERE source_task_id = ? ORDER BY id').all(t.id).map(out);
    return { name: s.name, client_id: s.client_id, project_id: s.project_id, files: [...files], urls: [...urls], saved };
  };
  route('POST', '/api/tasks/:id/save-asset', ({ user, params, body }) => {
    const t = ctx.loadTaskVisible(user, params.id);
    const s = taskScope(t);
    need(s, 400, 'Only tasks in a project have assets to save to');
    if (body.file_id != null) {
      const f = db.prepare('SELECT * FROM task_files WHERE id = ? AND task_id = ?').get(Number(body.file_id), t.id);
      need(f, 404, 'File not found');
      const a = saveTaskFile(t, f, user, s);
      need(a, 404, 'File missing');
      return out(a);
    }
    const l = db.prepare('SELECT * FROM task_links WHERE id = ? AND task_id = ?').get(Number(body.link_id), t.id);
    need(l, 404, 'Link not found');
    const [w, v] = scopeSql(s);
    const dup = db.prepare(`SELECT * FROM assets WHERE ${w} AND kind = 'link' AND url = ?`).get(v, l.url);
    if (dup) return out(dup);
    let host = 'Link'; try { host = new URL(l.url).hostname.replace(/^www\./, ''); } catch { /* as typed */ }
    return out(insert(s, user, { kind: 'link', section: 'links', title: (l.title || host).slice(0, 120), url: l.url, source_task_id: t.id }));
  });
  // a project linked to a client: its own assets move to the client
  ctx.assetsToClient = (projectId, clientId) => {
    const n = db.prepare('UPDATE assets SET client_id = ?, project_id = NULL WHERE project_id = ?').run(clientId, projectId).changes;
    if (n) changed({ client_id: clientId });
    return n;
  };

  // ---------- the client portal: what is shared with them, and sending files in ----------
  route('GET', '/api/portal/projects/:pid/assets', ({ user, params }) => {
    const a = ctx.portalAccess(user, Number(params.pid));
    const all = db.prepare('SELECT * FROM assets WHERE client_id = ? ORDER BY created_at DESC, id DESC').all(a.c.id);
    const mine = user.kind === 'client' ? all.filter((x) => x.client_user_id === user.id) : [];
    const shown = all.filter((x) => x.shared && x.kind !== 'login');
    const strip = (x) => { const o = out(x); delete o.created_by; return { ...o, url_file: x.file ? `/api/portal/assets/${x.id}/file` : null }; };
    return { assets: shown.map(strip), sent: mine.slice(0, 20).map(strip) };
  }, C);
  route('POST', '/api/portal/projects/:pid/assets/upload', ({ user, params, body, query }) => {
    const a = ctx.portalAccess(user, Number(params.pid));
    need(a.client, 403, 'Only people at the client send files here');
    const name = String(query.get('name') || '').slice(0, 200);
    need(name, 400, 'name is required');
    const note = query.get('note') ? String(query.get('note')).slice(0, 2000) : null;
    const row = addFile(null, { client_id: a.c.id, project_id: null }, { name, mime: query.get('mime'), buf: body, shared: true, note, client_user_id: user.id });
    if (N) N.notify([a.p.lead_id, ...ctx.managersOf(-1)], { kind: 'client_message', title: `${user.name} (${a.c.name}) sent ${row.file_name}`, body: note || 'Saved to their assets.', link: `#/project?id=${a.p.id}&tab=assets` });
    return strip1(row);
  }, { client: true, raw: MAX_RAW });
  const strip1 = (x) => { const o = out(x); delete o.created_by; return { ...o, url_file: x.file ? `/api/portal/assets/${x.id}/file` : null }; };
  route('GET', '/api/portal/assets/:id/file', ({ user, params, query }) => {
    const x = db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(params.id));
    need(x, 404, 'Not found');
    if (user.kind === 'client') need(x.client_id === user.client_id && x.kind !== 'login' && (x.shared || x.client_user_id === user.id), 404, 'Not found');
    else loadAsset(user, x.id);
    return sendFile(x, query && query.get('inline') === '1');
  }, C);
};
