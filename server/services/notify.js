'use strict';
// Notifications: one row per person per event. They show in the dashboard bell, as phone and browser
// pop-ups (web push) and as pop-ups from the desktop app. Nobody is notified about their own actions.
// Each person chooses, per kind of thing, which of their devices it reaches (phone, desktop app,
// browser), and Staffwarden stays quiet outside their shift, except for announcements, nudges and direct
// messages marked urgent. Chat messages reach devices but never crowd the bell: the chat has its own
// badges.
const T = require('../lib/time');

// kind -> category (what people choose devices for)
const KINDS = {
  task_assigned: 'tasks', task_status: 'tasks', task_due_changed: 'deadlines', task_due: 'deadlines',
  task_review: 'reviews', task_approved: 'results', task_sent_back: 'results',
  task_comment: 'comments', task_file: 'comments', task_from_message: 'tasks',
  project_added: 'projects', project_lead: 'projects',
  timeoff_request: 'timeoff', timeoff_decision: 'timeoff',
  no_signal: 'team', policy: 'account', app_update: 'account',
  note_added: 'explain', time_request: 'explain',
  changed: 'account', time_request_decision: 'account',   // about the person themself: always delivered
  payslip: 'account', expense_decision: 'account', advance_decision: 'account', pay_answer: 'account',
  pay_question: 'pay', expense_request: 'pay', advance_request: 'pay', payroll_review: 'pay', hr_step: 'pay',
  client_message: 'clients', client_request: 'clients', client_approval: 'clients', client_visibility: 'account',
  chat_direct: 'chat_direct', chat_mention: 'chat_direct', chat_channel: 'chat_channel',
  announcement: 'announce', boost: 'boost', boost_clip: 'boost', checkin_reminder: 'checkin', checkin_blocked: 'checkin',
  idle_nudge: 'nudge', idle_alert: 'team', fun_mode: 'account',
};
const CATEGORIES = {
  chat_direct: 'Direct messages and mentions',
  chat_channel: 'Every message in my channels',
  announce: 'Announcements',
  boost: 'Boosts from the owner',
  tasks: 'Tasks assigned to me and changes to them',
  reviews: 'Tasks waiting for my review',
  results: 'My tasks approved or sent back',
  comments: 'Comments and files on my tasks',
  deadlines: 'Deadlines: due today, overdue, changed',
  projects: 'Added to a project',
  clients: 'Messages, requests and sign-offs from clients',
  checkin: 'Check-in reminder and blockers',
  timeoff: 'Time off requests and decisions',
  team: 'Team alerts: idle or silent timers',
  explain: 'Notes and time requests from my team',
  pay: 'Payroll, expenses and advances to look at (HR)',
  nudge: '“Still there?” when I’m idle',
};
const SUBS = {
  chat_direct: 'Someone writes to you or types @you',
  chat_channel: 'Muted channels never notify',
  announce: 'Always on: the owner needs everyone to read these',
  boost: 'The fun ones',
  tasks: 'Includes tasks made from messages',
  clients: 'Amber after 2 hours, red after 4',
  checkin: '15 minutes before your shift ends',
  nudge: 'Always on, so your hours stay right',
  team: 'For managers',
};
const MANAGER_ONLY = new Set(['reviews', 'team', 'explain', 'pay']);
const LOCKED = new Set(['announce', 'nudge']);                    // can't be switched off
const LOUD = new Set(['announce', 'nudge', 'account']);           // come through during quiet hours
const IN_BELL_NOT = new Set(['chat_direct', 'chat_channel']);     // chats have their own badges
const DEVICES = ['phone', 'desktop', 'browser'];
const DEFAULTS = {
  chat_direct: [1, 1, 1], chat_channel: [0, 1, 0], announce: [1, 1, 1], boost: [1, 1, 1], tasks: [1, 1, 0], reviews: [1, 1, 0], results: [1, 1, 0],
  comments: [1, 1, 0], deadlines: [1, 1, 0], projects: [1, 1, 0], clients: [1, 1, 1], checkin: [1, 1, 0], timeoff: [1, 1, 1], team: [1, 1, 1],
  explain: [1, 1, 1], pay: [1, 1, 1], nudge: [1, 1, 1], account: [1, 1, 1],
};
const isPhone = (device) => /^(iphone|ipad|android)/i.test(String(device || ''));

function createNotify(ctx) {
  const { db, nowIso, emitTo } = ctx;

  function prefsOf(u) {
    let p = {};
    try { p = u.notify_prefs ? JSON.parse(u.notify_prefs) : {}; } catch { p = {}; }
    const out = { categories: {}, channels: {}, desktop: p.desktop !== false, quiet: p.quiet !== false };
    for (const c of Object.keys(DEFAULTS)) {
      const d = DEFAULTS[c], have = (p.channels && p.channels[c]) || {};
      const offAll = p.categories && p.categories[c] === false;   // the older on/off switch
      out.channels[c] = {};
      DEVICES.forEach((dev, i) => { out.channels[c][dev] = LOCKED.has(c) ? true : offAll ? false : (dev in have ? !!have[dev] : !!d[i]); });
      out.categories[c] = DEVICES.some((dev) => out.channels[c][dev]);
    }
    if (!out.desktop) for (const c of Object.keys(out.channels)) if (!LOCKED.has(c)) out.channels[c].desktop = false;
    return out;
  }

  // Is it inside this person's shift (with half an hour either side)? Outside it, phones stay quiet.
  function inShift(u, at = ctx.now()) {
    try {
      const day = ctx.calc.todayOf(u);
      const h = ctx.calc.hoursOn(u, day);
      const local = Math.round(((at / 60000) + ctx.calc.userTz(u, at)) % 1440 + 1440) % 1440;
      const s = (T.hhmm(h.shift_start) - 30 + 1440) % 1440, e = (T.hhmm(h.shift_end) + 30) % 1440;
      return s <= e ? local >= s && local <= e : local >= s || local <= e;
    } catch { return true; }
  }

  const ins = db.prepare(`INSERT OR IGNORE INTO notifications (user_id, kind, title, body, link, actor_id, dedupe, created_at, desktop, in_bell)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  // to: user ids (duplicates, nulls and the actor are dropped). Returns how many were created.
  // urgent: a direct message marked urgent comes through quiet hours too.
  function notify(to, { kind, title, body = null, link = null, actor = null, dedupe = null, urgent = false, tag = null }) {
    const cat = KINDS[kind] || 'account';
    const actorId = actor ? actor.id : null;
    let n = 0;
    for (const id of new Set((Array.isArray(to) ? to : [to]).filter((x) => x != null).map(Number))) {
      if (id === actorId) continue;
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!u || !u.active) continue;
      const p = prefsOf(u), ch = p.channels[cat] || p.channels.account;
      if (!DEVICES.some((d) => ch[d])) continue;
      const quiet = p.quiet && !LOUD.has(cat) && !urgent && !inShift(u);
      const inBell = IN_BELL_NOT.has(cat) ? 0 : 1;
      const r = ins.run(id, kind, String(title).slice(0, 200), body == null ? null : String(body).slice(0, 500), link, actorId, dedupe, nowIso(), ch.desktop && !quiet ? 1 : 0, inBell);
      if (!r.changes) continue;
      n++;
      emitTo(id, 'notify');
      if (quiet || !ctx.pnotify) continue;
      const want = (s) => (isPhone(s.device) ? ch.phone : ch.browser);
      if (ch.phone || ch.browser) ctx.pnotify.pushTo('staff', id, { title: String(title).slice(0, 120), body: body ? String(body).slice(0, 200) : '', link: link || '#/', tag: tag || `s${kind}` }, want);
    }
    return n;
  }

  return { notify, prefsOf, inShift, isPhone, KINDS, CATEGORIES, SUBS, MANAGER_ONLY, LOCKED, DEVICES };
}

module.exports = { createNotify, KINDS, CATEGORIES, MANAGER_ONLY };
