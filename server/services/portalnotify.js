'use strict';
const webpush = require('../lib/webpush');

// The client's bell and everyone's phone notifications.
// Clients get their own notifications (client_notifications), never mixed with the team's. Anyone, staff
// or client, can add a phone or browser for push: a pop-up on the lock screen with the same title and
// link as the bell. Each client person chooses which kinds come to their phone, and the hour alerts.
const CLIENT_KINDS = {
  approval_asked: 'approvals', file_asked: 'approvals', approval_reminder: 'approvals', approval_version: 'approvals',
  chat: 'messages', request_reply: 'requests', request_estimate: 'requests', request_update: 'requests', task_comment: 'messages',
  update_posted: 'updates', milestone_done: 'updates', meeting: 'meetings', meeting_notes: 'meetings',
  hours_80: 'hours', hours_week: 'hours',
};
const CLIENT_CATEGORIES = {
  approvals: 'Approvals and files the team asks for',
  messages: 'Messages and comments',
  requests: 'Replies and estimates on your requests',
  updates: 'Weekly updates and finished milestones',
  meetings: 'Calls: new times, and notes afterwards',
  hours: 'Hour alerts',
};

function createPortalNotify(ctx) {
  const { db, nowIso } = ctx;

  // ---------- keys for push, made once and kept ----------
  let keys = null;
  function vapid() {
    if (keys) return keys;
    let r = db.prepare("SELECT value FROM settings WHERE key = 'vapid'").get();
    if (!r) { db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('vapid', JSON.stringify(webpush.makeVapidKeys())); r = db.prepare("SELECT value FROM settings WHERE key = 'vapid'").get(); }
    keys = JSON.parse(r.value);
    return keys;
  }
  const subject = () => (/^https:\/\//.test(String(ctx.publicUrl || '')) ? String(ctx.publicUrl) : `mailto:${(db.prepare("SELECT email FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get() || {}).email || 'admin@workhelm.app'}`);

  // ---------- a client person's choices ----------
  function prefsOf(cu) {
    let p = {};
    try { p = cu && cu.notify_prefs ? JSON.parse(cu.notify_prefs) : {}; } catch { p = {}; }
    const push = {};
    for (const k of Object.keys(CLIENT_CATEGORIES)) push[k] = !(p.push && p.push[k] === false);
    return { push, hours80: p.hours80 !== false, hours_week: !!p.hours_week };
  }

  // ---------- push ----------
  const sending = new Set();
  // want(sub): which of the person's devices get it (all of them unless said)
  function pushTo(kind, id, payload, want = null) {
    const subs = db.prepare('SELECT * FROM push_subs WHERE owner_kind = ? AND owner_id = ?').all(kind, id).filter((s) => !want || want(s));
    for (const s of subs) {
      const job = webpush.send(s, payload, vapid(), subject(), { fetchImpl: ctx.pushFetch || fetch }).then((status) => {
        if (status >= 200 && status < 300) db.prepare('UPDATE push_subs SET last_ok_at = ?, fails = 0 WHERE id = ?').run(nowIso(), s.id);
        else if (status === 404 || status === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);   // that browser unsubscribed
        else db.prepare('UPDATE push_subs SET fails = fails + 1 WHERE id = ?').run(s.id);
        // a browser that keeps failing is let go
        db.prepare('DELETE FROM push_subs WHERE id = ? AND fails >= 20').run(s.id);
      }).catch(() => {}).finally(() => sending.delete(job));
      sending.add(job);
    }
  }
  const settle = () => Promise.all([...sending]);

  // ---------- the client's bell ----------
  // to: client user ids. Duplicates by `dedupe` are dropped. Returns how many were created.
  function notifyClient(to, { kind, title, body = null, link = null, project_id = null, dedupe = null, actor = null }) {
    let n = 0;
    for (const id of new Set((Array.isArray(to) ? to : [to]).filter((x) => x != null).map(Number))) {
      if (actor && actor.kind === 'client' && actor.id === id) continue;
      const cu = db.prepare('SELECT cu.*, cl.archived FROM client_users cu JOIN clients cl ON cl.id = cu.client_id WHERE cu.id = ?').get(id);
      if (!cu || !cu.active || cu.archived) continue;
      if (dedupe && db.prepare('SELECT 1 FROM client_notifications WHERE client_user_id = ? AND dedupe = ?').get(id, dedupe)) continue;
      db.prepare('INSERT INTO client_notifications (client_user_id, kind, title, body, link, project_id, dedupe, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, kind, String(title).slice(0, 200), body == null ? null : String(body).slice(0, 500), link, project_id, dedupe, nowIso());
      n++;
      ctx.emitClientUser(id, 'notify');
      const cat = CLIENT_KINDS[kind];
      if (!cat || prefsOf(cu).push[cat]) pushTo('client', id, { title: String(title).slice(0, 120), body: body ? String(body).slice(0, 200) : '', link: link || '#/overview', tag: `c${kind}${project_id || ''}` });
    }
    return n;
  }
  // everyone at the project's client (optionally only those who can approve)
  function clientsOf(project, { approvers = false } = {}) {
    if (!project || !project.client_id) return [];
    return db.prepare(`SELECT id FROM client_users WHERE client_id = ? AND active = 1 ${approvers ? 'AND can_approve = 1' : ''}`).all(project.client_id).map((r) => r.id);
  }
  const toProject = (project, payload, o = {}) => notifyClient(clientsOf(project, o), { project_id: project.id, ...payload });

  return { notifyClient, toProject, clientsOf, pushTo, prefsOf, vapid, settle, CLIENT_KINDS, CLIENT_CATEGORIES };
}

module.exports = { createPortalNotify, CLIENT_KINDS, CLIENT_CATEGORIES };
