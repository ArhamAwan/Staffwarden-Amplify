'use strict';
const crypto = require('node:crypto');
const { need, str, optStr, int } = require('../lib/http');

// Clients of the agency and the people at each client who can sign in to the portal. Only the owner
// and managers set these up. What a client can see is a set of switches per client; some things
// (screenshots, activity, attendance, pay, other clients, team-only notes) are never shared at all.
const DEFAULT_SETTINGS = {
  tasks: 'all',          // 'all': every task except ones marked team only; 'shared': only tasks marked shared
  people: true,          // names and roles of who is on each task
  files: true,           // files on shared tasks
  on_it_now: false,      // "On it now" while someone's timer runs on the project (the team is told)
  hours: 'person',       // 'off' | 'total' | 'person' | 'task'
  messages: true,        // the group chat with the team
  direct: true,          // direct messages with one person
  requests: true,
  approvals: true,
  presence: false,       // a green dot on the team's names while they have Staffwarden open (never when, or how long, they work)
};
const HOURS = ['off', 'total', 'person', 'task'];

module.exports = (ctx) => {
  const { db, route, needManager, nowIso, audit, emitPortal, hashPassword, T } = ctx;

  const settingsOf = (c) => { let s = {}; try { s = JSON.parse(c.settings || '{}'); } catch { s = {}; } return { ...DEFAULT_SETTINGS, ...s }; };
  const getClient = (id) => { const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(id)); need(c, 404, 'Client not found'); return c; };
  const readable = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; return Array.from(crypto.randomBytes(14), (b) => A[b % A.length]).join(''); };
  Object.assign(ctx, { clientSettings: settingsOf, getClient, CLIENT_DEFAULTS: DEFAULT_SETTINGS });

  const personOut = (p) => ({ id: p.id, name: p.name, email: p.email, title: p.title, can_approve: !!p.can_approve, active: !!p.active, joined_at: p.joined_at, last_seen_at: p.last_seen_at, created_at: p.created_at });
  function clientOut(c, full = false) {
    const projects = db.prepare('SELECT p.id, p.name, p.key, p.color, p.status, p.lead_id, u.name AS lead_name FROM projects p LEFT JOIN users u ON u.id = p.lead_id WHERE p.client_id = ? ORDER BY p.name').all(c.id);
    const people = db.prepare('SELECT * FROM client_users WHERE client_id = ? ORDER BY active DESC, name').all(c.id);
    const out = { id: c.id, name: c.name, city: c.city, tz_name: c.tz_name, retainer_hours: c.retainer_hours, archived: !!c.archived, created_at: c.created_at,
      settings: settingsOf(c), projects, people_count: people.filter((p) => p.active).length };
    if (full) out.people = people.map(personOut);
    return out;
  }
  // a client's sign-in email can't belong to anyone else, staff or client
  const emailFree = (email, exceptClientUser = null) => !db.prepare('SELECT 1 FROM users WHERE email = ?').get(email) && !db.prepare('SELECT 1 FROM client_users WHERE email = ? AND id IS NOT ?').get(email, exceptClientUser);

  route('GET', '/api/clients', ({ user, query }) => {
    needManager(user);
    const all = query.get('all') === '1';
    return db.prepare(`SELECT * FROM clients ${all ? '' : 'WHERE archived = 0'} ORDER BY name`).all().map((c) => clientOut(c));
  });
  route('POST', '/api/clients', ({ user, body }) => {
    needManager(user);
    const name = str(body.name, 'name', 100);
    const tz = optStr(body.tz_name, 'tz_name', 60);
    need(!tz || T.validZone(tz), 400, 'Choose a time zone from the list');
    const id = Number(db.prepare('INSERT INTO clients (name, city, tz_name, retainer_hours, settings, created_at) VALUES (?,?,?,?,?,?)')
      .run(name, optStr(body.city, 'city', 100), tz, body.retainer_hours == null || body.retainer_hours === '' ? null : int(Number(body.retainer_hours), 'retainer_hours', 1, 2000), '{}', nowIso()).lastInsertRowid);
    audit(user, 'client.created', null, name);
    return clientOut(getClient(id), true);
  });
  route('GET', '/api/clients/:id', ({ user, params }) => { needManager(user); return clientOut(getClient(params.id), true); });
  route('PATCH', '/api/clients/:id', ({ user, params, body }) => {
    needManager(user);
    const c = getClient(params.id);
    const set = (col, v) => db.prepare(`UPDATE clients SET ${col} = ? WHERE id = ?`).run(v, c.id);
    if ('name' in body) set('name', str(body.name, 'name', 100));
    if ('city' in body) set('city', optStr(body.city, 'city', 100));
    if ('tz_name' in body) { const tz = optStr(body.tz_name, 'tz_name', 60); need(!tz || T.validZone(tz), 400, 'Choose a time zone from the list'); set('tz_name', tz); }
    if ('retainer_hours' in body) set('retainer_hours', body.retainer_hours == null || body.retainer_hours === '' ? null : int(Number(body.retainer_hours), 'retainer_hours', 1, 2000));
    if ('archived' in body) set('archived', body.archived ? 1 : 0);
    const changed = [];
    if (body.settings && typeof body.settings === 'object') {
      const cur = settingsOf(c), next = { ...cur };
      for (const [k, v] of Object.entries(body.settings)) {
        if (!(k in DEFAULT_SETTINGS)) continue;
        if (k === 'tasks') { need(['all', 'shared'].includes(v), 400, 'tasks must be all or shared'); next.tasks = v; }
        else if (k === 'hours') { need(HOURS.includes(v), 400, `hours must be one of ${HOURS.join(', ')}`); next.hours = v; }
        else next[k] = !!v;
        if (next[k] !== cur[k]) changed.push(`${k}: ${next[k]}`);
      }
      set('settings', JSON.stringify(next));
      // the team is told when clients start seeing that their timer is running on the project
      if (next.on_it_now && !cur.on_it_now) {
        const staff = new Set();
        for (const p of db.prepare('SELECT id FROM projects WHERE client_id = ?').all(c.id)) for (const m of db.prepare('SELECT user_id FROM project_members WHERE project_id = ?').all(p.id)) staff.add(m.user_id);
        if (ctx.notify) ctx.notify.notify([...staff], { kind: 'client_visibility', title: `${c.name} can now see when you're on their project`, body: 'While your timer runs on one of their projects, they see "On it now" next to your name. Never your screenshots, activity or other work.', actor: user });
      }
    }
    audit(user, 'client.changed', null, `${c.name}${changed.length ? ': ' + changed.join(', ') : ''}`);
    for (const p of db.prepare('SELECT * FROM projects WHERE client_id = ?').all(c.id)) emitPortal(p, 'portal');
    return clientOut(getClient(c.id), true);
  });
  // a project belongs to one client at most
  route('PUT', '/api/clients/:id/projects/:pid', ({ user, params, body }) => {
    needManager(user);
    const c = getClient(params.id);
    const p = ctx.getProject(params.pid);
    need(p, 404, 'Project not found');
    const on = body.on !== false;
    need(!on || p.client_id == null || p.client_id === c.id, 409, 'That project already belongs to another client');
    const row = db.prepare('SELECT portal_client_id FROM projects WHERE id = ?').get(p.id);
    if (on && row.portal_client_id && row.portal_client_id !== c.id) {
      // its chat, requests and sign-offs were with someone else: never handed to a new client
      const old = (db.prepare('SELECT name FROM clients WHERE id = ?').get(row.portal_client_id) || {}).name || 'another client';
      need(body.fresh === true, 409, `This project's chat, requests and sign-offs are with ${old}. Start fresh to share it with ${c.name}: that history is deleted, and comments from ${old} on tasks become team only.`);
      db.exec('BEGIN');
      try {
        for (const t of ['chat_threads', 'client_requests', 'approvals', 'project_updates']) db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(p.id);
        db.prepare('UPDATE task_comments SET team_only = 1 WHERE client_user_id IS NOT NULL AND task_id IN (SELECT id FROM tasks WHERE project_id = ?)').run(p.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      audit(user, 'client.project_fresh', null, `${p.name}: history with ${old} deleted, now ${c.name}`);
    }
    db.prepare('UPDATE projects SET client_id = ?, portal_client_id = COALESCE(?, portal_client_id) WHERE id = ?').run(on ? c.id : null, on ? c.id : null, p.id);
    // the project's own assets move to the client, so their other projects have them too
    if (on && ctx.assetsToClient) ctx.assetsToClient(p.id, c.id);
    if (on && !db.prepare("SELECT 1 FROM chat_threads WHERE project_id = ? AND kind = 'group'").get(p.id)) db.prepare("INSERT INTO chat_threads (project_id, kind, created_at) VALUES (?, 'group', ?)").run(p.id, nowIso());
    audit(user, on ? 'client.project_added' : 'client.project_removed', null, `${p.name} → ${c.name}`);
    ctx.emit('projects');
    return clientOut(getClient(c.id), true);
  });

  // people at the client: they get a first password to pass on, like new staff
  route('POST', '/api/clients/:id/people', ({ user, params, body }) => {
    needManager(user);
    const c = getClient(params.id);
    const email = str(body.email, 'email', 200).toLowerCase();
    need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 400, 'Enter a valid email address');
    need(emailFree(email), 409, `${email} is already in use`);
    const password = readable();
    const { salt, hash } = hashPassword(password);
    const id = Number(db.prepare('INSERT INTO client_users (client_id, email, name, title, pw_salt, pw_hash, can_approve, invited_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(c.id, email, str(body.name, 'name', 100), optStr(body.title, 'title', 100), salt, hash, body.can_approve ? 1 : 0, user.id, nowIso()).lastInsertRowid);
    audit(user, 'client.person_added', null, `${body.name} (${email}) at ${c.name}`);
    return { person: personOut(db.prepare('SELECT * FROM client_users WHERE id = ?').get(id)), password };
  });
  route('PATCH', '/api/client-people/:id', ({ user, params, body }) => {
    needManager(user);
    const p = db.prepare('SELECT * FROM client_users WHERE id = ?').get(Number(params.id));
    need(p, 404, 'Person not found');
    if ('name' in body) db.prepare('UPDATE client_users SET name = ? WHERE id = ?').run(str(body.name, 'name', 100), p.id);
    if ('title' in body) db.prepare('UPDATE client_users SET title = ? WHERE id = ?').run(optStr(body.title, 'title', 100), p.id);
    if ('can_approve' in body) db.prepare('UPDATE client_users SET can_approve = ? WHERE id = ?').run(body.can_approve ? 1 : 0, p.id);
    if ('active' in body) {
      db.prepare('UPDATE client_users SET active = ? WHERE id = ?').run(body.active ? 1 : 0, p.id);
      if (!body.active) db.prepare('DELETE FROM client_sessions WHERE client_user_id = ?').run(p.id);
    }
    let password = null;
    if (body.reset_password) {
      password = readable();
      const { salt, hash } = hashPassword(password);
      db.prepare('UPDATE client_users SET pw_salt = ?, pw_hash = ? WHERE id = ?').run(salt, hash, p.id);
      db.prepare('DELETE FROM client_sessions WHERE client_user_id = ?').run(p.id);
    }
    audit(user, 'client.person_changed', null, `${p.name}: ${Object.keys(body).join(', ')}`);
    return { person: personOut(db.prepare('SELECT * FROM client_users WHERE id = ?').get(p.id)), password };
  });
};
