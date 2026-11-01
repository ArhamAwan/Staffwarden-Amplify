'use strict';
// Transparency: whenever something about a person's tracking, schedule or time changes, they are told
// what changed, who changed it and (for time) why, and the change is kept on their profile.
//
// Settings are compared as a "view": everything that applies to the person, in words, after inheritance
// (company -> team -> person). A change anywhere up the chain is therefore noticed for exactly the people
// it reaches, without each route having to know who inherits what.

const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function clock(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function daysText(wd) {
  const d = String(wd || '').split(',').filter(Boolean).map(Number).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (!d.length) return 'None';
  const idx = d.map((x) => (x + 6) % 7);
  const run = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  return run && d.length > 2 ? `${DAY_SHORT[d[0]]} to ${DAY_SHORT[d[d.length - 1]]}` : d.map((x) => DAY_SHORT[x]).join(', ');
}
const tzText = (m) => `UTC${m >= 0 ? '+' : '-'}${Math.floor(Math.abs(m) / 60)}${Math.abs(m) % 60 ? ':' + String(Math.abs(m) % 60).padStart(2, '0') : ''}`;
const zoneText = (z) => { const city = z.split('/').pop().replace(/_/g, ' '); return z === 'UTC' ? 'UTC' : city; };
const hoursText = (min) => { const h = min / 60; return `${Number.isInteger(h) ? h : h.toFixed(1)} hours`; };
const shotsText = (n) => (n === 0 ? 'Off' : `${n} every 10 minutes`);

// What a person agreed to be captured. Compared with today's to show what changed since they agreed,
// and they are asked to agree again only when more would be captured than before.
const TERM_KEYS = ['shots', 'screens', 'blur', 'retention', 'del', 'hidden', 'device', 'seen'];
const SEEN_RANK = { off: 0, team: 1, everyone: 2 };
function moreThan(old, cur) {
  const reasons = [];
  if (cur.shots > old.shots) reasons.push('shots');
  if (old.screens !== 'all' && cur.screens === 'all') reasons.push('screens');
  if (old.blur && !cur.blur) reasons.push('blur');
  if (cur.retention > old.retention) reasons.push('retention');
  if (old.del && !cur.del) reasons.push('del');
  if ((old.hidden || []).some((a) => !(cur.hidden || []).some((b) => b.toLowerCase() === a.toLowerCase()))) reasons.push('hidden');
  if (old.device && !cur.device) reasons.push('device');
  if ((SEEN_RANK[cur.seen] ?? 2) > (SEEN_RANK[old.seen] ?? 2)) reasons.push('seen');
  return reasons;
}

function createChanges(ctx) {
  const { db, cfg, nowIso } = ctx;
  const calc = () => ctx.calc;
  const nameOf = (id) => (id ? (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || 'Someone' : 'Staffwarden');
  const fresh = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  // raw terms, for consent
  function termsOf(u) {
    return {
      shots: ctx.shotPolicy(u).per_10, screens: cfg.captureScreens === 'all' ? 'all' : 'active', blur: !!cfg.blurShots,
      retention: cfg.retentionDays, del: !!cfg.employeesCanDeleteShots, hidden: [...(cfg.blackoutApps || ['WhatsApp'])], device: !!u.other_device,
      seen: ['off', 'team', 'everyone'].includes(cfg.teamVisibility) ? cfg.teamVisibility : 'everyone',
    };
  }
  const termText = {
    shots: (t) => shotsText(t.shots), screens: (t) => (t.screens === 'all' ? 'Every screen' : 'Only the screen you are working on'),
    blur: (t) => (t.blur ? 'Blurred on your computer before sending' : 'Not blurred'), retention: (t) => `${t.retention} days`,
    del: (t) => (t.del ? 'Allowed' : 'Not allowed'), hidden: (t) => (t.hidden || []).join(', ') || 'None',
    device: (t) => (t.device ? 'Yes: activity is not measured' : 'No'),
    seen: (t) => (t.seen === 'off' ? 'Only managers' : t.seen === 'team' ? 'Managers and people in your team' : 'Managers and everyone in the company'),
  };
  const LABEL = {
    shots: 'Screenshots', screens: 'Screens captured', blur: 'Screenshot blur', retention: 'Screenshots kept for',
    del: 'Deleting your own screenshots', hidden: 'Apps always blacked out', device: 'Works on another device',
    seen: 'Who can see your status and hours today',
    idle: 'Marked idle after', shift: 'Shift', brk: 'Scheduled break', days: 'Working days', target: 'Weekly target',
    grace: 'Counted late after', tz: 'Time zone', team: 'Team',
  };

  // everything about one person's tracking and schedule, in words
  function viewOf(u) {
    const t = termsOf(u), v = {};
    for (const k of TERM_KEYS) v[k] = termText[k](t);
    v.idle = `${cfg.idleLimitMin} minutes without keyboard or mouse`;
    const sh = { start: u.shift_start || cfg.shiftStart, end: u.shift_end || cfg.shiftEnd, bs: u.break_start || cfg.breakStart, be: u.break_end || cfg.breakEnd };
    v.shift = `${clock(sh.start)} to ${clock(sh.end)}`;
    v.brk = sh.bs && sh.be ? `${clock(sh.bs)} to ${clock(sh.be)}` : 'None';
    v.days = daysText(u.work_days || cfg.workDays);
    v.target = hoursText(u.weekly_target_min ?? cfg.weeklyTargetMin);
    v.grace = `${cfg.graceMin} minutes past the shift start`;
    { const z = calc().zoneOf(u); v.tz = tzText(calc().userTz(u)) + (z ? ` (${zoneText(z)})` : ''); }
    v.team = u.team_id ? (db.prepare('SELECT name FROM teams WHERE id = ?').get(u.team_id) || {}).name || 'No team' : 'No team';
    const dh = calc().dayHours(u);
    for (const [d, h] of Object.entries(dh)) v[`dh${d}`] = `${clock(h.shift_start)} to ${clock(h.shift_end)}${h.break_start && h.break_end ? `, break ${clock(h.break_start)} to ${clock(h.break_end)}` : ''}`;
    return v;
  }
  const labelOf = (k) => (k.startsWith('dh') ? `Hours on ${DAY_LONG[Number(k.slice(2))]}` : LABEL[k] || k);
  function diff(a, b) {
    const lines = [], keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    const order = (k) => { const i = Object.keys(LABEL).indexOf(k); return i < 0 ? 100 + Number(k.slice(2)) : i; };
    for (const k of keys.sort((x, y) => order(x) - order(y))) {
      if (a[k] === b[k]) continue;
      // the same offset, now named by place (UTC+5 -> UTC+5 (Karachi)): nothing changes for the person
      if (k === 'tz' && a[k] && b[k] && a[k].split(' (')[0] === b[k].split(' (')[0] && (!a[k].includes(' (') || !b[k].includes(' ('))) continue;
      const from = a[k] ?? (k.startsWith('dh') ? 'your usual hours' : 'not set'), to = b[k] ?? (k.startsWith('dh') ? 'your usual hours' : 'not set');
      lines.push({ key: k, text: `${labelOf(k)}: ${from} → ${to}` });
    }
    return lines;
  }

  // Keeps a change and tells the person (always; this category cannot be switched off).
  function log(userId, actor, { area, title, lines = [], reason = null, link = '#/profile?changes=1' }) {
    const actorId = actor ? actor.id : null;
    db.prepare('INSERT INTO changes (user_id, actor_id, area, title, lines, reason, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(userId, actorId, area, title, JSON.stringify(lines), reason, nowIso());
    const by = actorId && actorId !== userId ? `By ${nameOf(actorId)}. ` : '';
    const body = by + (reason ? `Reason: ${reason}. ` : '') + lines.slice(0, 3).join('. ') + (lines.length > 3 ? ` and ${lines.length - 3} more` : '');
    ctx.notify.notify(userId, { kind: 'changed', title, body, link, actor });
  }

  // Runs `fn` (which changes settings) and tells everyone among `users` whose view changed.
  function track(users, actor, fn) {
    const before = new Map(users.map((u) => [u.id, viewOf(u)]));
    const out = fn();
    for (const u of users) {
      const now = fresh(u.id);
      if (!now || !now.active) continue;
      const lines = diff(before.get(u.id), viewOf(now));
      if (!lines.length) continue;
      const tracking = lines.some((l) => TERM_KEYS.includes(l.key) || l.key === 'idle');
      const title = tracking ? 'What Staffwarden captures for you has changed' : 'Your schedule has changed';
      log(u.id, actor, { area: tracking ? 'tracking' : 'schedule', title, lines: lines.map((l) => l.text) });
    }
    return out;
  }
  const trackingPeople = () => db.prepare('SELECT * FROM users WHERE active = 1').all();

  // ---- consent ----
  function parseTerms(u) { try { return u.consent_terms ? JSON.parse(u.consent_terms) : null; } catch { return null; } }
  // { lines: what changed since they agreed (in words), more: true when more is captured now }
  function termsState(u) {
    let old = parseTerms(u);
    const cur = termsOf(u);
    if (!old && u.consented_at) {   // agreed before this was recorded: what applies now is what they agreed to
      db.prepare('UPDATE users SET consent_terms = ? WHERE id = ?').run(JSON.stringify(cur), u.id);
      old = cur;
    }
    if (!old) return { lines: [], more: false, current: cur };
    const lines = [];
    for (const k of TERM_KEYS) {
      const a = termText[k](old), b = termText[k](cur);
      if (a !== b) lines.push({ key: k, label: LABEL[k], from: a, to: b, more: moreThan(old, cur).includes(k) });
    }
    return { lines, more: lines.some((l) => l.more), current: cur };
  }
  function acceptTerms(u) { db.prepare('UPDATE users SET consent_terms = ? WHERE id = ?').run(JSON.stringify(termsOf(u)), u.id); }

  return { viewOf, diff, log, track, trackingPeople, termsOf, termsState, acceptTerms, clock, DAY_LONG, DAY_SHORT, nameOf };
}

module.exports = { createChanges, moreThan, TERM_KEYS };
