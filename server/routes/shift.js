'use strict';
const T = require('../lib/time');
const { need, str, optStr } = require('../lib/http');

// The shift, around the timer: the end-of-shift check-in (hours come from the timer, nobody types
// them), announcements and who has read them, the owner's boost button, nudges when someone is idle
// or barely active (they are always asked first; the owner hears only if it goes on), and fun modes
// such as god mode, which only ever change how Staffwarden looks for that person.
module.exports = (ctx) => {
  const { db, route, nowIso, clockNow, isManager, canSee, audit, managersOf } = ctx;
  const calc = () => ctx.calc;
  const staffOnly = (user) => need(user.kind !== 'client', 404, 'Not found');
  const needOwner = (user) => need(user.role === 'owner', 403, 'Only the owner can do this');
  const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
  // what people call someone: "Muhammad Waseem" is Waseem
  const callName = (n) => { const w = String(n || '').trim().split(/\s+/); return w.length > 1 && /^(muhammad|mohammad|mohammed|muhammed|syed|sayed|m\.?)$/i.test(w[0]) ? w[1] : w[0] || ''; };
  const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const brief = (u) => ({ id: u.id, name: u.name, title: u.title || null, role: u.role });
  const owners = () => db.prepare("SELECT id FROM users WHERE role = 'owner' AND active = 1").all().map((r) => r.id);
  const running = () => db.prepare('SELECT e.*, u.name FROM time_entries e JOIN users u ON u.id = e.user_id WHERE e.ended_at IS NULL AND u.active = 1').all()
    .filter((e) => !db.prepare('SELECT 1 FROM pauses WHERE entry_id = ? AND ended_at IS NULL').get(e.id));
  const setting = (k, d) => json((db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value, d);
  const saveSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));

  // =================================================================================================
  // check-ins
  // =================================================================================================
  function checkinsThread() {
    let th = db.prepare("SELECT * FROM chat_threads WHERE project_id IS NULL AND dm_key = 'checkins'").get();
    if (!th) {
      const id = Number(db.prepare("INSERT INTO chat_threads (kind, name, topic, dm_key, created_at) VALUES ('channel', 'check-ins', 'What everyone did and what’s next, every shift', 'checkins', ?)").run(nowIso()).lastInsertRowid);
      th = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(id);
    }
    const ins = db.prepare('INSERT OR IGNORE INTO team_members (thread_id, user_id, joined_at) VALUES (?,?,?)');
    for (const u of db.prepare('SELECT id FROM users WHERE active = 1').all()) ins.run(th.id, u.id, nowIso());
    return th;
  }
  function hoursFor(u, day) {
    const d = calc().computeDay(u, day, { detail: true });
    const by = new Map();
    for (const e of d.entries || []) {
      const label = e.task || e.project || 'Not on a task';
      const k = `${e.project || ''}|${e.task || ''}`;
      const x = by.get(k) || { label, project: e.project || null, task: e.task || null, secs: 0 };
      x.secs += e.worked_secs; by.set(k, x);
    }
    return { worked_secs: d.worked_secs || 0, break_secs: d.break_secs || 0, breakdown: [...by.values()].filter((x) => x.secs > 30).sort((a, b) => b.secs - a.secs) };
  }
  // what happened on the board tonight, offered as lines for "What I did"
  function suggestions(u, day) {
    const [ws] = T.dayWindow(day, calc().dayTz(u, day));
    const rows = db.prepare(`SELECT e.kind, e.detail, t.title, t.number, p.key FROM task_events e JOIN tasks t ON t.id = e.task_id LEFT JOIN projects p ON p.id = t.project_id
      WHERE e.user_id = ? AND e.at >= ? AND e.kind IN ('status','created','comment') ORDER BY e.at DESC LIMIT 12`).all(u.id, T.iso(ws));
    const seen = new Set(), out = [];
    for (const r of rows) {
      const ref = r.key && r.number ? `${r.key}-${r.number}` : r.title;
      const to = (/->\s*(\w+)/.exec(r.detail || '') || [])[1];
      const line = r.kind === 'status' ? (to === 'done' ? `Finished ${ref}` : `Moved ${ref} to ${{ in_progress: 'In progress', in_review: 'review', todo: 'To do' }[to] || 'a new status'}`) : r.kind === 'created' ? `Made ${ref}` : `Commented on ${r.title}`;
      if (!seen.has(line)) { seen.add(line); out.push(line); }
    }
    return out.slice(0, 5);
  }
  const ciOut = (c, u) => ({ id: c.id, user: brief(u), day: c.day, did: c.did, next: c.next, blockers: c.blockers, mood: c.mood, tracked_secs: c.tracked_secs, breakdown: json(c.breakdown, []), created_at: c.created_at, updated_at: c.updated_at });

  route('GET', '/api/checkins/mine', ({ user }) => {
    staffOnly(user);
    const u = userRow(user.id), day = calc().todayOf(u);
    const h = calc().hoursOn(u, day);
    const c = db.prepare('SELECT * FROM checkins WHERE user_id = ? AND day = ?').get(user.id, day);
    const recent = db.prepare('SELECT day, did, mood FROM checkins WHERE user_id = ? AND day < ? ORDER BY day DESC LIMIT 4').all(user.id, day);
    return { day, shift: { start: h.shift_start, end: h.shift_end }, ...hoursFor(u, day), suggestions: suggestions(u, day), existing: c ? ciOut(c, u) : null, recent };
  });
  route('PUT', '/api/checkins/mine', ({ user, body }) => {
    staffOnly(user);
    const u = userRow(user.id), day = calc().todayOf(u);
    const did = str(body.did, 'what you did', 4000).trim(), next = optStr(body.next, 'what’s next', 4000) || '', blockers = optStr(body.blockers, 'blockers', 2000);
    need(did, 400, 'Say what you did');
    const mood = ['smooth', 'busy', 'rough'].includes(body.mood) ? body.mood : null;
    const hrs = hoursFor(u, day);
    const had = db.prepare('SELECT * FROM checkins WHERE user_id = ? AND day = ?').get(user.id, day);
    db.prepare(`INSERT INTO checkins (user_id, day, did, next, blockers, mood, tracked_secs, breakdown, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id, day) DO UPDATE SET did = excluded.did, next = excluded.next, blockers = excluded.blockers, mood = excluded.mood, tracked_secs = excluded.tracked_secs, breakdown = excluded.breakdown, updated_at = excluded.updated_at`)
      .run(user.id, day, did, next, blockers || null, mood, hrs.worked_secs, JSON.stringify(hrs.breakdown), nowIso(), nowIso());
    if (!had) {
      const th = checkinsThread();
      const hh = `${Math.floor(hrs.worked_secs / 3600)}h ${String(Math.round((hrs.worked_secs % 3600) / 60)).padStart(2, '0')}m`;
      ctx.teamPost(th, user, { body: `Did: ${did}${next ? `\nNext: ${next}` : ''}${blockers ? `\nBlocked: ${blockers}` : ''}`, kind: 'checkin', meta: { day, tracked_secs: hrs.worked_secs, hours: hh, mood, blocked: !!blockers } });
    }
    if (blockers && (!had || had.blockers !== blockers)) {
      const leads = db.prepare('SELECT DISTINCT p.lead_id id FROM projects p JOIN project_members pm ON pm.project_id = p.id WHERE pm.user_id = ? AND p.archived = 0 AND p.lead_id IS NOT NULL').all(user.id).map((r) => r.id);
      ctx.notify.notify([...owners(), ...leads], { kind: 'checkin_blocked', title: `${user.name} is blocked`, body: blockers.slice(0, 200), link: `#/checkins?day=${day}`, actor: user, dedupe: `blk:${user.id}:${day}` });
    }
    return ciOut(db.prepare('SELECT * FROM checkins WHERE user_id = ? AND day = ?').get(user.id, day), u);
  });
  route('GET', '/api/checkins', ({ user, query }) => {
    staffOnly(user);
    const team = db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY name').all().filter((u) => u.id === user.id || (isManager(user) && canSee(user, u.id)));
    const day = /^\d{4}-\d{2}-\d{2}$/.test(query.get('day') || '') ? query.get('day') : calc().companyToday();
    const items = [], missing = [];
    const runningIds = new Set(running().map((e) => e.user_id));
    const off = new Set(db.prepare("SELECT user_id FROM leave_requests WHERE status = 'approved' AND start_day <= ? AND end_day >= ?").all(day, day).map((r) => r.user_id));
    for (const u of team) {
      const c = db.prepare('SELECT * FROM checkins WHERE user_id = ? AND day = ?').get(u.id, day);
      if (c) items.push(ciOut(c, u));
      else if (u.tracks_time) {
        const h = hoursFor(u, day);
        if (h.worked_secs > 0 || runningIds.has(u.id) || off.has(u.id)) missing.push({ user: brief(u), state: off.has(u.id) ? 'off' : runningIds.has(u.id) ? 'running' : 'stopped', worked_secs: h.worked_secs });
      }
    }
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const moods = { smooth: 0, busy: 0, rough: 0 };
    for (const c of items) if (c.mood) moods[c.mood]++;
    // the week so far (Monday to this day): each day's moods, and who checked in on which days
    const mon = T.mondayOf(day), ids = team.map((u) => u.id);
    const wk = ids.length ? db.prepare(`SELECT user_id, day, mood FROM checkins WHERE day >= ? AND day <= ? AND user_id IN (${ids.map(() => '?').join(',')})`).all(mon, day, ...ids) : [];
    const week = { days: [], people: [] };
    for (let d = mon; d <= day; d = T.addDays(d, 1)) { const on = wk.filter((r) => r.day === d); week.days.push({ day: d, smooth: on.filter((r) => r.mood === 'smooth').length, busy: on.filter((r) => r.mood === 'busy').length, rough: on.filter((r) => r.mood === 'rough').length, none: on.filter((r) => !r.mood).length }); }
    for (const u of team) { if (!u.tracks_time) continue; const ds = new Set(wk.filter((r) => r.user_id === u.id).map((r) => r.day)); week.people.push({ user: brief(u), days: week.days.map((x) => ds.has(x.day)) }); }
    return { day, items, missing, week, counts: { checked: items.length, expected: items.length + missing.filter((m) => m.state !== 'off').length, tracked_secs: items.reduce((n, c) => n + c.tracked_secs, 0) + missing.reduce((n, m) => n + m.worked_secs, 0), blocked: items.filter((c) => c.blockers).length, moods } };
  });
  route('POST', '/api/checkins/nudge', ({ user, body }) => {
    staffOnly(user);
    need(isManager(user) && canSee(user, Number(body.user_id)), 403, 'Not allowed');
    ctx.notify.notify(Number(body.user_id), { kind: 'checkin_reminder', title: `${callName(user.name)} is asking for your check-in`, body: 'Two minutes: what you did and what’s next. Your hours fill in from the timer.', link: '#/checkin', actor: user, dedupe: `nudgeci:${body.user_id}:${clockNow() - (clockNow() % 3600000)}` });
    return { ok: true };
  });

  // =================================================================================================
  // announcements
  // =================================================================================================
  const annOut = (a, viewer) => {
    const total = db.prepare('SELECT COUNT(*) n FROM users WHERE active = 1').get().n;
    const read = db.prepare('SELECT COUNT(*) n FROM announcement_reads WHERE announcement_id = ? AND confirmed_at IS NOT NULL').get(a.id).n;
    const mine = db.prepare('SELECT * FROM announcement_reads WHERE announcement_id = ? AND user_id = ?').get(a.id, viewer.id);
    const author = a.author_id ? userRow(a.author_id) : null;
    return { id: a.id, title: a.title, body: a.body, confirm: !!a.confirm, author: author ? brief(author) : null, created_at: a.created_at, read, total, confirmed: !!(mine && mine.confirmed_at), seen: !!(mine && mine.seen_at), message_id: a.message_id };
  };
  route('GET', '/api/announcements', ({ user }) => {
    staffOnly(user);
    return db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 50').all().map((a) => annOut(a, user));
  });
  route('GET', '/api/announcements/pending', ({ user }) => {
    staffOnly(user);
    return db.prepare('SELECT a.* FROM announcements a WHERE a.confirm = 1 AND a.created_at >= ? AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = ? AND r.confirmed_at IS NOT NULL) ORDER BY a.id DESC LIMIT 3')
      .all(T.iso(clockNow() - 30 * 86400000), user.id).filter((a) => a.author_id !== user.id).map((a) => annOut(a, user));
  });
  route('GET', '/api/announcements/:id', ({ user, params }) => {
    staffOnly(user);
    const a = db.prepare('SELECT * FROM announcements WHERE id = ?').get(Number(params.id));
    need(a, 404, 'Announcement not found');
    const out = annOut(a, user);
    if (isManager(user)) {
      const rows = db.prepare('SELECT u.id, u.name, u.title, u.role, u.last_seen_at, r.seen_at, r.confirmed_at FROM users u LEFT JOIN announcement_reads r ON r.user_id = u.id AND r.announcement_id = ? WHERE u.active = 1 ORDER BY u.name').all(a.id);
      out.readers = rows.filter((r) => r.confirmed_at).map((r) => ({ ...brief(r), at: r.confirmed_at }));
      out.not_yet = rows.filter((r) => !r.confirmed_at && r.id !== a.author_id).map((r) => ({ ...brief(r), seen: !!r.seen_at, last_seen_at: r.last_seen_at }));
    }
    return out;
  });
  route('POST', '/api/announcements', ({ user, body }) => {
    staffOnly(user);
    need(isManager(user), 403, 'Only the owner and managers post announcements');
    const title = str(body.title, 'title', 160).trim(), text = str(body.body, 'message', 6000).trim();
    need(title && text, 400, 'Give it a title and a message');
    const remind = body.remind_after_h ? Math.max(1, Math.min(72, Number(body.remind_after_h))) : null;
    const id = Number(db.prepare('INSERT INTO announcements (title, body, author_id, confirm, remind_after_h, created_at) VALUES (?,?,?,?,?,?)').run(title, text, user.id, body.confirm === false ? 0 : 1, remind, nowIso()).lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, seen_at, confirmed_at) VALUES (?,?,?,?)').run(id, user.id, nowIso(), nowIso());
    const co = ctx.companyThread(), an = ctx.announcementsThread();
    const mid = ctx.teamPost(an, user, { body: `${title}\n\n${text}`, kind: 'announcement', meta: { announcement_id: id, title }, pinned: true });
    if (body.pin !== false) ctx.teamPost(co, user, { body: `${title}\n\n${text}`, kind: 'announcement', meta: { announcement_id: id, title }, pinned: true });
    db.prepare('UPDATE announcements SET message_id = ? WHERE id = ?').run(mid, id);
    const everyone = db.prepare('SELECT id FROM users WHERE active = 1').all().map((r) => r.id);
    ctx.notify.notify(everyone, { kind: 'announcement', title: `Announcement · ${title}`, body: text.slice(0, 200), link: `#/announcements?id=${id}`, actor: user, dedupe: `ann:${id}`, tag: `ann${id}` });
    ctx.emitUsers(everyone, 'announcement', { id });
    audit(user, 'team.announcement', null, title);
    return annOut(db.prepare('SELECT * FROM announcements WHERE id = ?').get(id), user);
  });
  const mark = (aid, uid, confirm) => db.prepare(`INSERT INTO announcement_reads (announcement_id, user_id, seen_at, confirmed_at) VALUES (?,?,?,?)
    ON CONFLICT(announcement_id, user_id) DO UPDATE SET seen_at = COALESCE(seen_at, excluded.seen_at), confirmed_at = COALESCE(confirmed_at, excluded.confirmed_at)`).run(aid, uid, nowIso(), confirm ? nowIso() : null);
  route('POST', '/api/announcements/:id/seen', ({ user, params }) => { staffOnly(user); need(db.prepare('SELECT 1 FROM announcements WHERE id = ?').get(Number(params.id)), 404, 'Not found'); mark(Number(params.id), user.id, false); return { ok: true }; });
  route('POST', '/api/announcements/:id/confirm', ({ user, params }) => {
    staffOnly(user);
    const a = db.prepare('SELECT * FROM announcements WHERE id = ?').get(Number(params.id));
    need(a, 404, 'Not found');
    mark(a.id, user.id, true);
    if (a.author_id) ctx.emitTo(a.author_id, 'announcement');
    return { ok: true };
  });
  route('POST', '/api/announcements/:id/remind', ({ user, params }) => {
    staffOnly(user);
    need(isManager(user), 403, 'Not allowed');
    const a = db.prepare('SELECT * FROM announcements WHERE id = ?').get(Number(params.id));
    need(a, 404, 'Not found');
    const not = db.prepare('SELECT u.id FROM users u WHERE u.active = 1 AND u.id != ? AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = ? AND r.user_id = u.id AND r.confirmed_at IS NOT NULL)').all(a.author_id || 0, a.id).map((r) => r.id);
    const n = ctx.notify.notify(not, { kind: 'announcement', title: `Read it: ${a.title}`, body: a.body.slice(0, 200), link: `#/announcements?id=${a.id}`, actor: user, dedupe: `annr:${a.id}:${clockNow() - (clockNow() % 3600000)}` });
    db.prepare('UPDATE announcements SET reminded_at = ? WHERE id = ?').run(nowIso(), a.id);
    return { reminded: n };
  });

  // =================================================================================================
  // the boost button (owner only)
  // =================================================================================================
  const VIBES = {
    chai: ['Two chais and a deadline. Let’s go, night shift.', 'Chai is brewing. So is greatness. Back to it.', 'Hydrate, caffeinate, dominate. In that order.'],
    liftoff: ['Basit pressed the big button. Your keyboard has been notified.', 'Night-shift power-up: +10 focus, +5 vibes, −1 yawn.', 'Engines on. Tampa wakes up in a few hours: let’s give them something to wake up to.'],
    lasthour: ['Last hour. Finish strong, then check in.', 'One more push. The weekend is closer than it looks.', 'Mandatory fun detected. Please look busy, enthusiastically.'],
    win: ['Big win tonight. Whoever closed it, the good chair is yours.', 'That’s how it’s done. Keep the streak going.', 'This is your CEO speaking: hydrate, stretch, then absolutely crush it.'],
  };
  const linesFor = (vibe) => [...(VIBES[vibe] || []), ...db.prepare('SELECT line FROM boost_lines WHERE vibe = ?').all(vibe).map((r) => r.line)];
  function lastBoost() {
    const b = db.prepare('SELECT * FROM boosts WHERE test = 0 ORDER BY id DESC LIMIT 1').get();
    if (!b) return null;
    const ans = db.prepare('SELECT ba.answer, u.id, u.name FROM boost_answers ba JOIN users u ON u.id = ba.user_id WHERE ba.boost_id = ? ORDER BY ba.at').all(b.id);
    return { id: b.id, vibe: b.vibe, line: b.line, created_at: b.created_at, sent_to: b.sent_to, boosted: ans.filter((a) => a.answer === 'boosted').map((a) => ({ id: a.id, name: a.name })), chai: ans.filter((a) => a.answer === 'chai').map((a) => ({ id: a.id, name: a.name })) };
  }
  route('GET', '/api/boost', ({ user }) => {
    staffOnly(user);
    const lines = {};
    for (const v of Object.keys(VIBES)) lines[v] = linesFor(v);
    const custom = db.prepare('SELECT id, vibe, line FROM boost_lines ORDER BY id').all();
    const working = [...new Set(running().map((e) => e.user_id))].filter((id) => id !== user.id);
    const clipReady = working.filter(clipOk).length;
    const clipUpdate = working.filter((uid) => !appCanClip(uid)).length;
    const workingSet = new Set(working);
    // the owner chooses who gets the show; everyone else is listed with their switch
    const people = user.role === 'owner'
      ? db.prepare("SELECT id, name, title, boost_quiet FROM users WHERE active = 1 AND id != ? ORDER BY name COLLATE NOCASE").all(user.id)
        .map((u) => ({ id: u.id, name: u.name, title: u.title || null, quiet: !!u.boost_quiet, working: workingSet.has(u.id), clip: clipWhy(u.id, workingSet) }))
      : undefined;
    const quietWorking = working.filter(isQuiet).length;
    // who it goes to: everyone working except the sender (the sender's own timer doesn't count)
    return { can_boost: user.role === 'owner', working_now: working.length, clip_ready: clipReady, clip_update: clipUpdate, quiet_working: quietWorking, people, lines, custom, last: lastBoost() };
  });
  route('POST', '/api/boost', ({ user, body }) => {
    staffOnly(user); needOwner(user);
    const vibe = Object.keys(VIBES).includes(body.vibe) ? body.vibe : 'chai';
    const prev = db.prepare('SELECT * FROM boosts WHERE test = 0 ORDER BY id DESC LIMIT 1').get();
    need(!prev || clockNow() - Date.parse(prev.created_at) > 5 * 60000, 429, 'One boost every 5 minutes. Let the last one land.');
    let line = optStr(body.line, 'line', 160);
    if (!line) { const pool = linesFor(vibe).filter((l) => !prev || l !== prev.line); line = pool[Math.floor(Math.random() * pool.length)] || VIBES.chai[0]; }
    const to = [...new Set(running().map((e) => e.user_id))].filter((id) => id !== user.id);
    need(to.length, 409, 'Nobody else is working right now.');
    const clip = !!body.clip;
    const id = Number(db.prepare('INSERT INTO boosts (author_id, vibe, line, sent_to, clip, created_at) VALUES (?,?,?,?,?,?)').run(user.id, vibe, line, to.length, clip ? 1 : 0, nowIso()).lastInsertRowid);
    const mid = ctx.teamPost(ctx.companyThread(), user, { body: line, kind: 'boost', meta: { boost_id: id, vibe, sent_to: to.length } });
    db.prepare('UPDATE boosts SET message_id = ? WHERE id = ?').run(mid, id);
    // the clip pops up in the corner of their laptop (the desktop app) for anyone whose timer runs, who
    // hasn't switched boosts to notifications only, and who hasn't had three already this shift
    const popup = clip ? to.filter(clipOk) : [];
    // people the owner switched the pop-up off for get the boost as an ordinary notification only
    for (const uid of popup) db.prepare('INSERT OR IGNORE INTO boost_popups (boost_id, user_id, at) VALUES (?,?,?)').run(id, uid, nowIso());
    const plain = to.filter((uid) => !popup.includes(uid));
    // everyone it goes to has their timer on, so it comes through even if their shift hours say otherwise
    const note = { title: `Boost from ${callName(user.name)}`, body: line, link: `#/?boost=${id}`, actor: user, dedupe: `boost:${id}`, tag: 'boost', urgent: true };
    if (popup.length) ctx.notify.notify(popup, { kind: 'boost_clip', ...note });
    if (plain.length) ctx.notify.notify(plain, { kind: 'boost', ...note });
    ctx.emitUsers(to.filter((uid) => !isQuiet(uid)), 'boost', { boost_id: id });
    audit(user, 'team.boost', null, clip ? `${line} (with the clip, popped up for ${popup.length})` : line);
    return { id, line, vibe, sent_to: to.length, popped_up: popup.length };
  });
  // the boost clip: at most this many pop-ups for one person in 12 hours (a shift); more arrive as notifications
  const POPUPS_PER_SHIFT = 3;
  // the clip needs desktop app 0.9.18 or later; older apps would only show a notification
  const CLIP_APP = [0, 9, 18];
  const appCanClip = (uid) => {
    const v = (db.prepare('SELECT app_version FROM users WHERE id = ?').get(uid) || {}).app_version;
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || ''); if (!m) return false;
    for (let i = 0; i < 3; i++) { const d = Number(m[i + 1]) - CLIP_APP[i]; if (d) return d > 0; }
    return true;
  };
  const isQuiet = (uid) => !!(db.prepare('SELECT boost_quiet FROM users WHERE id = ?').get(uid) || {}).boost_quiet;
  const clipOk = (uid) => (!ctx.featureOn || ctx.featureOn('boost_clip', uid)) && !isQuiet(uid) && appCanClip(uid) && popupsFor(uid) < POPUPS_PER_SHIFT && (db.prepare('SELECT boost_popup FROM users WHERE id = ?').get(uid) || {}).boost_popup !== 'note';
  // why the clip would or wouldn't pop up on someone's laptop right now (shown to the owner, so a boost that
  // "didn't work" can be explained: no timer, an old app, the show switched off, the limit for the shift...)
  function clipWhy(uid, workingSet) {
    const u = db.prepare('SELECT app_version, boost_popup FROM users WHERE id = ?').get(uid) || {};
    if (!workingSet.has(uid)) return { ok: false, why: 'not_working', text: 'Timer not running: boosts only go to people working' };
    if (ctx.featureOn && !ctx.featureOn('boost_clip', uid)) return { ok: false, why: 'feature_off', text: 'The clip is switched off in the developer tools' };
    if (isQuiet(uid)) return { ok: false, why: 'show_off', text: 'You switched the pop-up off for them' };
    if (!u.app_version) return { ok: false, why: 'no_app', text: 'Not using the desktop app' };
    if (!appCanClip(uid)) return { ok: false, why: 'old_app', text: `Desktop app ${u.app_version}: needs 0.9.18 or later` };
    if (u.boost_popup === 'note') return { ok: false, why: 'notes_only', text: 'They chose notifications only for boosts' };
    if (popupsFor(uid) >= POPUPS_PER_SHIFT) return { ok: false, why: 'limit', text: `Had ${POPUPS_PER_SHIFT} clips already this shift` };
    const p = ctx.notify.prefsOf(db.prepare('SELECT * FROM users WHERE id = ?').get(uid));
    const ch = (p.channels && p.channels.boost) || {};
    if (p.desktop === false || !ch.desktop) return { ok: false, why: 'desktop_off', text: 'Boost notifications are off for their desktop app' };
    return { ok: true, why: 'ok', text: 'The clip pops up on their laptop' };
  }
  ctx.clipWhy = clipWhy;
  const popupsFor = (uid) => db.prepare('SELECT COUNT(*) n FROM boost_popups bp JOIN boosts b ON b.id = bp.boost_id WHERE bp.user_id = ? AND bp.at > ? AND b.test = 0').get(uid, new Date(clockNow() - 12 * 3600000).toISOString()).n;
  // the owner turns the boost pop-up (the clip on their laptop and the full-screen show in the browser) off or
  // back on for one person; they still get the boost as an ordinary notification
  route('PUT', '/api/boost/quiet', ({ user, body }) => {
    staffOnly(user); needOwner(user);
    const uid = Number(body.user_id);
    const u = db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').get(uid);
    need(u && uid !== user.id, 404, 'That person isn’t on the team');
    const quiet = !!body.quiet;
    db.prepare('UPDATE users SET boost_quiet = ? WHERE id = ?').run(quiet ? 1 : 0, uid);
    audit(user, 'team.boost_quiet', uid, quiet ? `Boost pop-up off for ${u.name}` : `Boost pop-up back on for ${u.name}`);
    return { user_id: uid, quiet };
  });
  // each person's choice: the clip in a corner, or a plain notification
  route('GET', '/api/me/boost-prefs', ({ user }) => {
    staffOnly(user);
    const u = db.prepare('SELECT boost_popup, boost_corner FROM users WHERE id = ?').get(user.id);
    return { popup: u.boost_popup === 'note' ? 'note' : 'clip', corner: u.boost_corner === 'left' ? 'left' : 'right' };
  });
  route('PUT', '/api/me/boost-prefs', ({ user, body }) => {
    staffOnly(user);
    if ('popup' in body) db.prepare('UPDATE users SET boost_popup = ? WHERE id = ?').run(body.popup === 'note' ? 'note' : 'clip', user.id);
    if ('corner' in body) db.prepare('UPDATE users SET boost_corner = ? WHERE id = ?').run(body.corner === 'left' ? 'left' : 'right', user.id);
    const u = db.prepare('SELECT boost_popup, boost_corner FROM users WHERE id = ?').get(user.id);
    return { popup: u.boost_popup === 'note' ? 'note' : 'clip', corner: u.boost_corner === 'left' ? 'left' : 'right' };
  });
  route('GET', '/api/boost/:id', ({ user, params }) => {
    staffOnly(user);
    const b = db.prepare('SELECT * FROM boosts WHERE id = ?').get(Number(params.id));
    need(b, 404, 'Not found');
    const a = userRow(b.author_id) || { name: 'The owner' };
    const n = db.prepare("SELECT COUNT(*) n FROM boost_answers WHERE boost_id = ? AND answer = 'boosted'").get(b.id).n;
    const mine = db.prepare('SELECT answer FROM boost_answers WHERE boost_id = ? AND user_id = ?').get(b.id, user.id);
    const pop = db.prepare('SELECT 1 FROM boost_popups WHERE boost_id = ? AND user_id = ?').get(b.id, user.id);
    const corner = (db.prepare('SELECT boost_corner FROM users WHERE id = ?').get(user.id) || {}).boost_corner === 'left' ? 'left' : 'right';
    return { id: b.id, vibe: b.vibe, line: b.line, author: { id: a.id, name: a.name, first: callName(a.name) }, created_at: b.created_at, boosted: n, my_answer: mine ? mine.answer : null, clip: !!b.clip, popup: !!pop, corner, quiet: isQuiet(user.id) };
  });
  route('POST', '/api/boost/:id/answer', ({ user, params, body }) => {
    staffOnly(user);
    const b = db.prepare('SELECT * FROM boosts WHERE id = ?').get(Number(params.id));
    need(b, 404, 'Not found');
    const answer = body.answer === 'chai' ? 'chai' : 'boosted';
    db.prepare('INSERT INTO boost_answers (boost_id, user_id, answer, at) VALUES (?,?,?,?) ON CONFLICT(boost_id, user_id) DO UPDATE SET answer = excluded.answer, at = excluded.at').run(b.id, user.id, answer, nowIso());
    if (b.author_id) ctx.emitTo(b.author_id, 'boost_answer');
    ctx.emitUsers(ctx.teamMemberIds(ctx.companyThread()), 'chat', { thread_id: ctx.companyThread().id });
    return { ok: true, answer };
  });
  route('POST', '/api/boost/lines', ({ user, body }) => {
    staffOnly(user); needOwner(user);
    const vibe = Object.keys(VIBES).includes(body.vibe) ? body.vibe : 'chai';
    const id = Number(db.prepare('INSERT INTO boost_lines (vibe, line, created_by, created_at) VALUES (?,?,?,?)').run(vibe, str(body.line, 'line', 160).trim(), user.id, nowIso()).lastInsertRowid);
    return { id };
  });
  route('DELETE', '/api/boost/lines/:id', ({ user, params }) => { staffOnly(user); needOwner(user); db.prepare('DELETE FROM boost_lines WHERE id = ?').run(Number(params.id)); return { ok: true }; });

  // =================================================================================================
  // idle and low activity
  // =================================================================================================
  const RULES0 = { on: true, ask_min: 15, alert_min: 30, low_on: true, low_pct: 20, tell_lead: false };
  const rules = () => ({ ...RULES0, ...setting('idle_rules', {}) });
  route('GET', '/api/idle/rules', ({ user }) => { staffOnly(user); return rules(); });
  route('PUT', '/api/idle/rules', ({ user, body }) => {
    staffOnly(user); needOwner(user);
    const r = rules();
    if ('on' in body) r.on = !!body.on;
    if ('low_on' in body) r.low_on = !!body.low_on;
    if ('tell_lead' in body) r.tell_lead = !!body.tell_lead;
    if (body.ask_min != null) r.ask_min = Math.max(5, Math.min(120, Math.round(Number(body.ask_min))));
    if (body.alert_min != null) r.alert_min = Math.max(r.ask_min + 5, Math.min(240, Math.round(Number(body.alert_min))));
    if (body.low_pct != null) r.low_pct = Math.max(5, Math.min(60, Math.round(Number(body.low_pct))));
    saveSetting('idle_rules', r);
    audit(user, 'settings.idle_rules', null, JSON.stringify(r));
    return r;
  });
  // who hears about a flag: the owner, and the person's managers if the owner chose that
  const flagAudience = (userId) => [...new Set([...owners(), ...(rules().tell_lead ? managersOf(userId).filter((id) => id !== userId) : [])])];
  const canSeeFlags = (user, userId) => user.role === 'owner' || (rules().tell_lead && isManager(user) && canSee(user, userId));
  const activityLastHour = (uid) => { const r = db.prepare('SELECT COALESCE(SUM(tracked_secs),0) t, COALESCE(SUM(active_secs),0) a FROM activity_slots WHERE user_id = ? AND slot_start >= ?').get(uid, T.iso(clockNow() - 3600000)); return { tracked: r.t, pct: r.t > 0 ? Math.round((100 * r.a) / r.t) : null }; };
  const flagOut = (f) => {
    const u = userRow(f.user_id);
    const idle = f.idle_id ? db.prepare('SELECT * FROM idle_periods WHERE id = ?').get(f.idle_id) : null;
    const mins = idle && !idle.ended_at ? Math.round((clockNow() - Date.parse(idle.started_at)) / 60000) : null;
    return { id: f.id, kind: f.kind, user: brief(u), started_at: f.started_at, asked_at: f.asked_at, answer: f.answer, answered_at: f.answered_at, alerted: !!f.alerted_at, idle_min: mins, activity: activityLastHour(f.user_id).pct, detail: json(f.detail, null) };
  };
  route('GET', '/api/idle/board', ({ user }) => {
    staffOnly(user);
    need(user.role === 'owner' || (rules().tell_lead && isManager(user)), 403, 'Only the owner sees this');
    const flags = db.prepare('SELECT * FROM idle_flags WHERE cleared_at IS NULL ORDER BY id DESC').all().filter((f) => canSeeFlags(user, f.user_id)).map(flagOut);
    const people = running().filter((e) => canSeeFlags(user, e.user_id)).map((e) => {
      const u = userRow(e.user_id), i = db.prepare('SELECT * FROM idle_periods WHERE entry_id = ? AND ended_at IS NULL').get(e.id), a = activityLastHour(e.user_id);
      return { user: brief(u), idle_min: i ? Math.round((clockNow() - Date.parse(i.started_at)) / 60000) : 0, activity: a.pct, flagged: flags.some((f) => f.user.id === u.id) };
    }).sort((x, y) => (y.flagged - x.flagged) || ((x.activity ?? 100) - (y.activity ?? 100)));
    return { rules: rules(), flags, people };
  });
  route('GET', '/api/idle/mine', ({ user }) => {
    staffOnly(user);
    const f = db.prepare('SELECT * FROM idle_flags WHERE user_id = ? AND cleared_at IS NULL AND asked_at IS NOT NULL AND answer IS NULL ORDER BY id DESC LIMIT 1').get(user.id);
    return f ? { ...flagOut(f), rules: { alert_min: rules().alert_min } } : null;
  });
  route('POST', '/api/idle/flags/:id/answer', ({ user, params, body }) => {
    staffOnly(user);
    const f = db.prepare('SELECT * FROM idle_flags WHERE id = ? AND user_id = ?').get(Number(params.id), user.id);
    need(f, 404, 'Not found');
    const answer = ['back', 'break', 'meeting', 'reading'].includes(body.answer) ? body.answer : 'back';
    db.prepare('UPDATE idle_flags SET answer = ?, answered_at = ? WHERE id = ?').run(answer, nowIso(), f.id);
    if (answer === 'back') db.prepare('UPDATE idle_flags SET cleared_at = ? WHERE id = ?').run(nowIso(), f.id);
    // what they said is kept as a note on that stretch of their day, where their managers already look
    if (f.idle_id && answer !== 'back') {
      const i = db.prepare('SELECT * FROM idle_periods WHERE id = ?').get(f.idle_id);
      if (i) {
        const text = { break: 'I was on a break (answered “Still there?”)', meeting: 'I was in a call or a meeting (answered “Still there?”)', reading: 'I was reading or thinking, away from the keyboard (answered “Still there?”)' }[answer];
        const day = T.localDay(Date.parse(i.started_at), calc().dayTz(userRow(user.id)));
        db.prepare('INSERT INTO notes (user_id, day, kind, ref, text, created_at, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id, kind, ref) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at').run(user.id, day, 'idle', String(i.id), text, nowIso(), nowIso());
      }
    }
    for (const id of flagAudience(user.id)) ctx.emitTo(id, 'idle');
    return { ok: true };
  });
  function idleSweep() {
    const r = rules();
    if (!r.on) return 0;
    let n = 0;
    const now = clockNow();
    // idle stretches that ended clear their flags
    db.prepare("UPDATE idle_flags SET cleared_at = ? WHERE cleared_at IS NULL AND kind = 'idle' AND idle_id IN (SELECT id FROM idle_periods WHERE ended_at IS NOT NULL)").run(nowIso());
    for (const e of running()) {
      const u = userRow(e.user_id);
      if (!u || !u.tracks_time) continue;
      const i = db.prepare('SELECT * FROM idle_periods WHERE entry_id = ? AND ended_at IS NULL').get(e.id);
      if (i) {
        const mins = (now - Date.parse(i.started_at)) / 60000;
        let f = db.prepare("SELECT * FROM idle_flags WHERE idle_id = ? AND kind = 'idle'").get(i.id);
        if (!f && mins >= r.ask_min) {
          const id = Number(db.prepare("INSERT INTO idle_flags (user_id, kind, started_at, idle_id, asked_at) VALUES (?, 'idle', ?, ?, ?)").run(u.id, i.started_at, i.id, nowIso()).lastInsertRowid);
          n += ctx.notify.notify(u.id, { kind: 'idle_nudge', title: `Still there, ${callName(u.name)}?`, body: `No keyboard or mouse for ${Math.round(mins)} minutes while your timer runs. Tap to tell us what’s up.`, link: `#/?nudge=${id}`, dedupe: `idle:${i.id}`, tag: 'nudge' });
          ctx.emitTo(u.id, 'idle');
          f = db.prepare('SELECT * FROM idle_flags WHERE id = ?').get(id);
        }
        if (f && !f.alerted_at && (!f.answer || f.answer === 'back') && mins >= r.alert_min) {
          db.prepare('UPDATE idle_flags SET alerted_at = ? WHERE id = ?').run(nowIso(), f.id);
          const said = f.answer ? '' : ' No answer to “Still there?”.';
          n += ctx.notify.notify(flagAudience(u.id), { kind: 'idle_alert', title: `${u.name}: idle ${Math.round(mins)} min, timer on`, body: `Asked at ${new Date(Date.parse(f.asked_at)).toISOString().slice(11, 16)} UTC.${said}`, link: '#/?nudges=1', dedupe: `idlea:${f.id}` });
          for (const id of flagAudience(u.id)) ctx.emitTo(id, 'idle');
        }
        continue;
      }
      // low activity: a full hour on the clock, hardly any keyboard or mouse
      if (!r.low_on) continue;
      const a = activityLastHour(u.id);
      if (a.tracked < 50 * 60 || a.pct == null || a.pct >= r.low_pct) continue;
      const open = db.prepare("SELECT * FROM idle_flags WHERE user_id = ? AND kind = 'low' AND cleared_at IS NULL ORDER BY id DESC LIMIT 1").get(u.id);
      if (!open) {
        const id = Number(db.prepare("INSERT INTO idle_flags (user_id, kind, started_at, asked_at, detail) VALUES (?, 'low', ?, ?, ?)").run(u.id, T.iso(now - 3600000), nowIso(), JSON.stringify({ pct: a.pct })).lastInsertRowid);
        n += ctx.notify.notify(u.id, { kind: 'idle_nudge', title: 'Quiet hour on the keyboard', body: `${a.pct}% activity in the last hour. All good? Tap to say what you’re on.`, link: `#/?nudge=${id}`, dedupe: `low:${id}`, tag: 'nudge' });
        ctx.emitTo(u.id, 'idle');
      } else if (!open.alerted_at && !open.answer && now - Date.parse(open.asked_at) > 15 * 60000) {
        db.prepare('UPDATE idle_flags SET alerted_at = ? WHERE id = ?').run(nowIso(), open.id);
        n += ctx.notify.notify(flagAudience(u.id), { kind: 'idle_alert', title: `${u.name}: ${a.pct}% activity in the last hour`, body: 'They were asked and haven’t answered yet.', link: '#/?nudges=1', dedupe: `lowa:${open.id}` });
        for (const id of flagAudience(u.id)) ctx.emitTo(id, 'idle');
      } else if (open.answered_at && now - Date.parse(open.answered_at) > 3600000) db.prepare('UPDATE idle_flags SET cleared_at = ? WHERE id = ?').run(nowIso(), open.id);
    }
    // a stopped timer clears everything about that person
    db.prepare('UPDATE idle_flags SET cleared_at = ? WHERE cleared_at IS NULL AND user_id NOT IN (SELECT e.user_id FROM time_entries e WHERE e.ended_at IS NULL)').run(nowIso());
    return n;
  }

  // =================================================================================================
  // fun modes (god mode): the owner turns one on for someone; it only changes how things look for them
  // =================================================================================================
  const LEVEL = (xp) => { let l = 1, need_ = 0; while (need_ + 40 * l <= xp && l < 99) { need_ += 40 * l; l++; } return { level: l, floor: need_, next: need_ + 40 * l }; };
  function funOf(u) {
    if (!u.fun_mode || (u.fun_until && Date.parse(u.fun_until) < clockNow())) return null;
    const xpBase = Math.round(db.prepare('SELECT COALESCE(SUM(tracked_secs),0) s FROM activity_slots WHERE user_id = ?').get(u.id).s / 60);
    const day = calc().todayOf(u);
    const tonight = hoursFor(u, day).worked_secs;
    const double = u.fun_xp2_until && Date.parse(u.fun_xp2_until) > clockNow();
    const xp = xpBase + (double ? Math.round(tonight / 60) : 0);
    const lv = LEVEL(xp);
    // streak: nights in a row with a check-in, counting back from today or yesterday
    const days = new Set(db.prepare('SELECT day FROM checkins WHERE user_id = ? ORDER BY day DESC LIMIT 60').all(u.id).map((r) => r.day));
    let streak = 0, d = days.has(day) ? day : T.addDays(day, -1);
    while (days.has(d)) { streak++; d = T.addDays(d, -1); }
    const today = day;
    // the open ones first (up to six), then whatever was cleared in the last twelve hours
    const open = db.prepare("SELECT t.*, p.key FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.assignee_id = ? AND t.status != 'done' ORDER BY t.due_day IS NULL, t.due_day, t.id LIMIT 6").all(u.id);
    const cleared = db.prepare("SELECT t.*, p.key FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.assignee_id = ? AND t.status = 'done' AND t.completed_at >= ? ORDER BY t.completed_at DESC LIMIT 3").all(u.id, T.iso(clockNow() - 12 * 3600000));
    const quests = [...open, ...cleared]
      .map((t) => ({ id: t.id, ref: t.key && t.number ? `${t.key}-${t.number}` : null, title: t.title, status: t.status, xp: Math.max(20, Math.round(t.estimate_min || 60)), boss: !!(t.due_day && t.due_day <= today && t.status !== 'done'), due_day: t.due_day || null, early: !!(t.status === 'done' && t.due_day && t.completed_at && t.completed_at.slice(0, 10) < t.due_day) }));
    const done7 = db.prepare("SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status = 'done' AND completed_at >= ?").get(u.id, T.iso(clockNow() - 7 * 86400000)).n;
    const nights = db.prepare('SELECT COUNT(DISTINCT substr(slot_start, 1, 10)) n FROM activity_slots WHERE user_id = ?').get(u.id).n;
    const chai = db.prepare("SELECT COUNT(*) n FROM boost_answers WHERE user_id = ? AND answer = 'chai'").get(u.id).n;
    const calm3 = db.prepare("SELECT COUNT(*) n FROM checkins WHERE user_id = ? AND (blockers IS NULL OR blockers = '') AND day >= ?").get(u.id, T.addDays(day, -7)).n;
    const speed = db.prepare("SELECT COUNT(*) n FROM tasks t WHERE t.assignee_id = ? AND t.status = 'done' AND t.estimate_min > 0 AND (SELECT COALESCE(SUM((julianday(COALESCE(e.ended_at, ?)) - julianday(e.started_at)) * 1440), 0) FROM time_entries e WHERE e.task_id = t.id) < t.estimate_min").get(u.id, nowIso()).n;
    const boss = db.prepare("SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status = 'done' AND due_day IS NOT NULL AND substr(completed_at, 1, 10) <= due_day").get(u.id).n;
    const achievements = [
      { key: 'bug', name: 'Bug slayer', sub: `${done7} of 5 tasks closed this week`, got: done7 >= 5 },
      { key: 'owl', name: 'Night owl', sub: `${nights} of 30 nights on the clock`, got: nights >= 30 },
      { key: 'zero', name: 'Inbox zero', sub: `${calm3} of 3 nights, nothing blocking`, got: calm3 >= 3 },
      { key: 'chai', name: 'Chai overflow', sub: `Asked for more chai ${chai} of 4 times`, got: chai >= 4 },
      { key: 'speed', name: 'Speedrun', sub: 'Finish a task under its estimate', got: speed >= 1 },
      { key: 'boss', name: 'Boss fight', sub: 'Clear a task by its due date', got: boss >= 1 },
    ];
    // the boss: the most pressing open task (overdue, then due today, then urgent or high), its health
    // the share of its steps still to do
    const PRI = { urgent: 0, high: 1, normal: 2, low: 3 };
    const bossT = db.prepare("SELECT t.*, p.key FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.assignee_id = ? AND t.status != 'done' AND (t.due_day <= ? OR t.priority IN ('urgent','high'))").all(u.id, T.addDays(today, 1))
      .sort((a, b) => ((a.due_day || '9999') < today ? 0 : 1) - ((b.due_day || '9999') < today ? 0 : 1) || (a.due_day || '9999').localeCompare(b.due_day || '9999') || PRI[a.priority] - PRI[b.priority] || a.id - b.id)[0] || null;
    let bossOut = null;
    if (bossT) {
      const steps = db.prepare('SELECT title, done_at FROM task_steps WHERE task_id = ? ORDER BY position, id').all(bossT.id);
      const left = steps.filter((x) => !x.done_at);
      bossOut = { id: bossT.id, ref: bossT.key && bossT.number ? `${bossT.key}-${bossT.number}` : null, title: bossT.title, due_day: bossT.due_day, priority: bossT.priority,
        overdue: !!(bossT.due_day && bossT.due_day < today), steps: steps.length, steps_done: steps.length - left.length,
        hp: steps.length ? Math.round((100 * left.length) / steps.length) : bossT.status === 'in_review' ? 20 : bossT.status === 'in_progress' ? 70 : 100,
        next_step: left[0] ? left[0].title : null, xp: Math.max(20, Math.round(bossT.estimate_min || 60)) * 2 };
    }
    // the high score: the most tracked in one night, the last 30 nights
    const best = (db.prepare("SELECT MAX(s) m FROM (SELECT SUM(tracked_secs) s FROM activity_slots WHERE user_id = ? AND slot_start >= ? GROUP BY substr(slot_start, 1, 10))").get(u.id, T.iso(clockNow() - 30 * 86400000)) || {}).m || 0;
    // combo: tasks finished tonight since the last break ended
    const sinceBreak = (db.prepare("SELECT MAX(ended_at) t FROM pauses WHERE user_id = ? AND ended_at IS NOT NULL AND ended_at >= ?").get(u.id, T.iso(clockNow() - 12 * 3600000)) || {}).t || T.iso(clockNow() - 12 * 3600000);
    const combo = db.prepare("SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status = 'done' AND completed_at >= ?").get(u.id, sinceBreak).n;
    return { mode: u.fun_mode, calm: !!u.fun_calm, boss: bossOut, combo, best_secs: Math.max(best, tonight), intro: !u.fun_intro_seen, until: u.fun_until, double_xp: !!double, xp, level: lv.level, level_floor: lv.floor, level_next: lv.next, streak, tonight_secs: tonight, tonight_xp: Math.round(tonight / 60) * (double ? 2 : 1), quests, achievements };
  }
  ctx.funOf = funOf;
  route('GET', '/api/me/fun', ({ user }) => { staffOnly(user); return funOf(userRow(user.id)); });
  route('PUT', '/api/me/fun', ({ user, body }) => {
    staffOnly(user);
    if ('calm' in body) db.prepare('UPDATE users SET fun_calm = ? WHERE id = ?').run(body.calm ? 1 : 0, user.id);
    if (body.intro_seen) db.prepare('UPDATE users SET fun_intro_seen = 1 WHERE id = ?').run(user.id);
    return funOf(userRow(user.id));
  });
  route('GET', '/api/people/:id/fun', ({ user, params }) => {
    staffOnly(user); needOwner(user);
    const u = userRow(Number(params.id)); need(u, 404, 'Not found');
    return { mode: u.fun_mode || null, until: u.fun_until || null, xp2_until: u.fun_xp2_until || null, intro_seen: !!u.fun_intro_seen, calm: !!u.fun_calm };
  });
  route('PUT', '/api/people/:id/fun', ({ user, params, body }) => {
    staffOnly(user); needOwner(user);
    const u = userRow(Number(params.id)); need(u && u.active, 404, 'Not found');
    const mode = body.mode === 'god' ? 'god' : null;
    const until = mode && body.until ? new Date(body.until).toISOString() : null;
    const xp2 = mode && body.xp2_hours ? new Date(clockNow() + Math.min(72, Number(body.xp2_hours)) * 3600000).toISOString() : null;
    db.prepare('UPDATE users SET fun_mode = ?, fun_until = ?, fun_xp2_until = ?, fun_intro_seen = ? WHERE id = ?').run(mode, until, xp2, mode && body.intro !== false ? 0 : 1, u.id);
    audit(user, mode ? 'user.fun_on' : 'user.fun_off', u.id, mode || 'off');
    if (mode && body.announce) ctx.teamPost(ctx.companyThread(), user, { body: `${u.name} has entered god mode. Bugs, you have been warned.`, kind: 'system' });
    if (mode) ctx.notify.notify(u.id, { kind: 'fun_mode', title: 'Cheat code accepted', body: `${callName(user.name)} switched on god mode for you. Open your day to see it.`, link: u.role === 'manager' ? '#/me' : '#/', actor: user, dedupe: `fun:${u.id}:${nowIso().slice(0, 13)}` });
    ctx.emitTo(u.id, 'fun');
    return { mode, until, xp2_until: xp2 };
  });

  // =================================================================================================
  // the sweep: every minute
  // =================================================================================================
  ctx.shiftSweep = () => {
    let n = 0;
    try { n += idleSweep(); } catch (e) { console.error('idle sweep', e); }
    // check-in reminder: 15 minutes before the shift ends, for anyone whose timer is running
    for (const e of running()) {
      const u = userRow(e.user_id); if (!u) continue;
      const day = calc().todayOf(u);
      if (db.prepare('SELECT 1 FROM checkins WHERE user_id = ? AND day = ?').get(u.id, day)) continue;
      const end = T.hhmm(calc().hoursOn(u, day).shift_end);
      const local = Math.round(((clockNow() / 60000) + calc().userTz(u)) % 1440 + 1440) % 1440;
      const before = (end - local + 1440) % 1440;
      if (before <= 15) n += ctx.notify.notify(u.id, { kind: 'checkin_reminder', title: 'Time to check in', body: 'What you did and what’s next. Two minutes; your hours fill in from the timer.', link: '#/checkin', dedupe: `ci:${u.id}:${day}` });
    }
    // announcements that asked for a reminder
    for (const a of db.prepare('SELECT * FROM announcements WHERE remind_after_h IS NOT NULL AND reminded_at IS NULL').all()) {
      if (clockNow() - Date.parse(a.created_at) < a.remind_after_h * 3600000) continue;
      const not = db.prepare('SELECT u.id FROM users u WHERE u.active = 1 AND u.id != ? AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = ? AND r.user_id = u.id AND r.confirmed_at IS NOT NULL)').all(a.author_id || 0, a.id).map((r) => r.id);
      n += ctx.notify.notify(not, { kind: 'announcement', title: `Read it: ${a.title}`, body: a.body.slice(0, 200), link: `#/announcements?id=${a.id}`, dedupe: `annr:${a.id}:auto` });
      db.prepare('UPDATE announcements SET reminded_at = ? WHERE id = ?').run(nowIso(), a.id);
    }
    // fun modes that ran out
    db.prepare('UPDATE users SET fun_mode = NULL WHERE fun_mode IS NOT NULL AND fun_until IS NOT NULL AND fun_until < ?').run(nowIso());
    return n;
  };
};
