'use strict';
// The shift report: once everyone's shift has ended, one page per work day saying what each person did,
// the hours they kept, their breaks, the tasks they finished and their check-in. The owner and managers
// hear when it's ready and can download it as a PDF. It is worked out from the same facts as every other
// page whenever it's opened, so a time request approved later shows up in it too.
const { need } = require('../lib/http');
const T = require('../lib/time');
const { Pdf, width, PAGE_W, PAGE_H } = require('../lib/pdf');
const smtp = require('../lib/smtp');

const READY_AFTER_MIN = 15;          // the report is ready this long after the last shift of the day ends
const NOTIFY_WITHIN_H = 18;          // a report older than this is never announced (no backlog after a deploy)

module.exports = (ctx) => {
  const { db, cfg, route, nowIso, clockNow, needManager, visibleUsers, audit } = ctx;
  const calc = () => ctx.calc;

  const teamName = (id) => (id ? (db.prepare('SELECT name FROM teams WHERE id = ?').get(id) || {}).name || null : null);
  const hm = (iso, tz) => { if (!iso) return null; const m = T.localMinOfDay(Date.parse(iso), tz); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const dur = (s) => { const m = Math.round((s || 0) / 60); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
  const clock12 = (t) => { const [h, m] = String(t).split(':').map(Number); return `${(h % 12) || 12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const isWorkDay = (u, day) => calc().workDaySet(u).has(T.dow(day));
  const companyDays = () => new Set(String(cfg.workDays).split(',').filter(Boolean).map(Number));

  // when one person's shift on a work day ends, as a moment in time
  function shiftEndAt(u, day) {
    const [ws] = T.dayWindow(day, calc().dayTz(u, day));
    const end = calc().relMin(u, calc().shiftEndMin(u, day)) || 1440;
    return ws + end * 60000;
  }
  // the report for a day is ready once the last of the team's shifts that day has ended
  function readyAt(people, day) {
    const ends = people.filter((u) => isWorkDay(u, day)).map((u) => shiftEndAt(u, day));
    return ends.length ? Math.max(...ends) + READY_AFTER_MIN * 60000 : null;
  }
  const tracked = () => db.prepare('SELECT * FROM users WHERE active = 1 AND tracks_time = 1').all().filter((u) => !ctx.notJoined(u));

  // ---------- building it ----------
  function personReport(u, day, cal) {
    const m = calc().computeDay(u, day, { detail: true });
    const att = calc().attendanceFor(u, day, m, cal);
    const tz = calc().tzOn(u, day);
    const [ws, we] = T.dayWindow(day, calc().dayTz(u, day));
    const h = calc().hoursOn(u, day);
    // tasks this person moved forward during the day
    const tasks = db.prepare(`SELECT ev.kind, ev.at, ev.detail, t.id, t.title, t.status, p.name AS project FROM task_events ev
      JOIN tasks t ON t.id = ev.task_id LEFT JOIN projects p ON p.id = t.project_id
      WHERE ev.at >= ? AND ev.at < ? AND ev.kind IN ('completed','approved','submitted')
        AND (t.assignee_id = ? OR (t.assignee_id IS NULL AND ev.user_id = ?)) ORDER BY ev.at`).all(T.iso(ws), T.iso(we), u.id, u.id);
    const seen = new Map();
    for (const t of tasks) seen.set(t.id, { id: t.id, title: t.title, project: t.project || null, status: t.status, done: t.status === 'done', sent_for_review: t.kind === 'submitted' && t.status !== 'done', at: hm(t.at, tz) });
    const ci = db.prepare('SELECT did, next, blockers, mood, created_at FROM checkins WHERE user_id = ? AND day = ?').get(u.id, day) || null;
    const reqs = db.prepare('SELECT start_at, end_at, reason, status FROM time_requests WHERE user_id = ? AND day = ? ORDER BY start_at').all(u.id, day)
      .map((r) => ({ from: hm(r.start_at, tz), to: hm(r.end_at, tz), secs: Math.round((Date.parse(r.end_at) - Date.parse(r.start_at)) / 1000), reason: r.reason, status: r.status }));
    const out = {
      id: u.id, name: u.name, title: u.title || null, team: teamName(u.team_id),
      status: att.status, late_by_min: att.late_by_min || 0, expected_secs: att.expected_secs || 0, expected_done_secs: att.expected_done_secs || 0,
      shift: `${h.shift_start}–${h.shift_end}`, tz_offset_min: tz,
      // the day on a ribbon: minutes from the start of the work day ('w' work, 'b' break, 'i' idle, 'o' computer away)
      segs: m.segs.map(([a, b, k]) => [Math.round(a), Math.round(b), k]),
      shift_min: (() => { const a = calc().relMin(u, calc().shiftStartMin(u, day)); const b = a + (((calc().shiftEndMin(u, day) - calc().shiftStartMin(u, day)) + 1440) % 1440 || 1440); return [a, b]; })(),
      day_start_min: calc().dayStart(u),
      first_start: hm(m.first_start, tz), last_end: m.running ? null : hm(m.last_end, tz), running: !!m.running,
      worked_secs: m.worked_secs, break_secs: m.break_secs, idle_secs: m.idle_secs, away_secs: m.away_secs,
      break_count: m.break_count, idle_count: m.idle_count, sessions: m.sessions,
      activity_pct: m.activity_pct, shots: m.shots,
      projects: m.by_project.filter((p) => p.secs >= 60).sort((a, b) => b.secs - a.secs).map((p) => ({ name: p.name, secs: p.secs })),
      breaks: m.breaks.filter((b) => b.type === 'break' && b.secs >= 60).map((b) => ({ from: hm(b.started_at, tz), to: b.open ? null : hm(b.ended_at, tz), secs: b.secs, reason: b.reason && b.reason !== 'break' ? ((ctx.PAUSE_REASONS || []).find((x) => x.id === b.reason) || { label: b.reason }).label.toLowerCase() : null })),
      away_count: m.breaks.filter((b) => b.type === 'away' && b.secs >= 60).length,
      tasks: [...seen.values()],
      checkin: ci ? { did: ci.did || '', next: ci.next || '', blockers: ci.blockers || '', mood: ci.mood || null } : null,
      time_requests: reqs,
    };
    out.flags = flagsFor(u, day, m, att, out);
    out.level = out.flags.some((f) => f.level === 'red') ? 'red' : out.flags.some((f) => f.level === 'amber') ? 'amber' : out.flags.length ? 'blue' : null;
    return out;
  }

  // ---------- what's unusual ----------
  // red: needs someone to act; amber: worth a look; blue: out of the ordinary but not a problem
  const FLAG_ORDER = { red: 0, amber: 1, blue: 2 };
  function flagsFor(u, day, m, att, p) {
    const f = [];
    const add = (level, key, label) => f.push({ level, key, label });
    const now = clockNow(), endAt = shiftEndAt(u, day), over = now >= endAt;
    const worked = p.worked_secs, planned = p.expected_secs;
    const missing = ['absent', 'not_started'].includes(att.status);
    if (missing) add('red', 'absent', att.status === 'absent' ? 'Absent: no work and no leave' : `Hasn’t started; the shift began at ${clock12(calc().hoursOn(u, day).shift_start)}`);
    if (att.status === 'late') add(att.late_by_min >= 30 ? 'red' : 'amber', 'late', `Late by ${dur(att.late_by_min * 60)}`);
    if (worked > 0 && over && !m.running && m.last_end) {
      const early = Math.round((endAt - Date.parse(m.last_end)) / 60000);
      if (early >= 15) add(early >= 60 ? 'red' : 'amber', 'early', `Left ${dur(early * 60)} before the shift ended`);
    }
    if (planned && over && !missing && worked < planned * 0.9) add(worked < planned * 0.75 ? 'red' : 'amber', 'short', `Short by ${dur(planned - worked)}: worked ${dur(worked)} of ${dur(planned)}`);
    if (planned && worked > planned + 3600) add('blue', 'overtime', `Overtime: ${dur(worked - planned)} more than planned`);
    if (!planned && worked > 0) add('blue', 'dayoff', att.status === 'leave' ? `Worked ${dur(worked)} while on leave` : `Worked ${dur(worked)} on a day off`);
    const b = calc().breakOf(u, day), allowed = b ? ((b[1] - b[0] + 1440) % 1440) * 60 : 3600;
    if (p.break_secs > allowed + 15 * 60) add(p.break_secs > allowed * 1.5 ? 'red' : 'amber', 'breaks', `Breaks ${dur(p.break_secs)}, allowed ${dur(allowed)}`);
    if (p.idle_secs >= 30 * 60) add(p.idle_secs >= 60 * 60 ? 'red' : 'amber', 'idle', `Idle ${dur(p.idle_secs)} with the timer on`);
    if (p.activity_pct != null && worked >= 1800 && p.activity_pct < 40) add(p.activity_pct < 25 ? 'red' : 'amber', 'activity', `Low activity: ${p.activity_pct}%`);
    if (p.away_secs >= 30 * 60) add(p.away_secs >= 60 * 60 ? 'red' : 'amber', 'away', `Computer away ${dur(p.away_secs)} while the timer was on`);
    if (m.running && now - endAt > 30 * 60) add('amber', 'running', `Timer still on ${dur((now - endAt) / 1000)} after the shift ended`);
    if (p.checkin && p.checkin.blockers.trim()) add('amber', 'blocked', `Blocked: ${p.checkin.blockers.trim()}`);
    if (!p.checkin && worked >= 3600 && over) add('amber', 'checkin', 'No check-in written');
    const pend = p.time_requests.filter((q) => q.status === 'pending');
    if (pend.length) add('amber', 'request', `Asked for ${dur(pend.reduce((n, q) => n + q.secs, 0))} of missing time, waiting for a decision`);
    return f.sort((a, c) => FLAG_ORDER[a.level] - FLAG_ORDER[c.level]);
  }

  const ORDER = { late: 0, present: 1, not_started: 2, absent: 2, leave: 3, holiday: 4, off: 5, upcoming: 6, before: 7 };
  function build(user, day) {
    const list = visibleUsers(user, { tracking: true });
    const cal = calc().loadCalendar(list.map((u) => u.id), day, day);
    const people = list.map((u) => personReport(u, day, cal))
      .filter((p) => p.status !== 'before' && !(p.status === 'off' && !p.worked_secs) && !(p.status === 'upcoming' && !p.worked_secs));
    people.sort((a, b) => (b.worked_secs > 0) - (a.worked_secs > 0) || (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.name.localeCompare(b.name));
    const ready = readyAt(list, day);
    const worked = people.filter((p) => p.worked_secs > 0);
    const act = worked.filter((p) => p.activity_pct != null);
    const totals = {
      people: people.length,
      present: people.filter((p) => ['present', 'late'].includes(p.status)).length,
      late: people.filter((p) => p.status === 'late').length,
      absent: people.filter((p) => ['absent', 'not_started'].includes(p.status)).length,
      on_leave: people.filter((p) => p.status === 'leave').length,
      worked_secs: people.reduce((n, p) => n + p.worked_secs, 0),
      expected_secs: people.reduce((n, p) => n + p.expected_secs, 0),
      expected_done_secs: people.reduce((n, p) => n + p.expected_done_secs, 0),
      break_secs: people.reduce((n, p) => n + p.break_secs, 0),
      idle_secs: people.reduce((n, p) => n + p.idle_secs, 0),
      activity_pct: act.length ? Math.round(act.reduce((n, p) => n + p.activity_pct, 0) / act.length) : null,
      tasks_done: people.reduce((n, p) => n + p.tasks.filter((t) => t.done).length, 0),
      tasks_review: people.reduce((n, p) => n + p.tasks.filter((t) => t.sent_for_review).length, 0),
      checked_in: people.filter((p) => p.checkin).length,
      blockers: people.filter((p) => p.checkin && p.checkin.blockers.trim()).length,
      still_running: people.filter((p) => p.running).length,
      flags_red: people.reduce((n, p) => n + p.flags.filter((x) => x.level === 'red').length, 0),
      flags_amber: people.reduce((n, p) => n + p.flags.filter((x) => x.level === 'amber').length, 0),
      flagged_people: people.filter((p) => p.level === 'red' || p.level === 'amber').length,
    };
    return { day, org: cfg.orgName || 'Staffwarden', ready_at: ready ? T.iso(ready) : null, final: ready != null && clockNow() >= ready, generated_at: nowIso(), totals, people };
  }

  // what needs attention right now, for the dashboard: the same flags as the report, the serious ones only
  ctx.attentionNow = (user, day) => {
    const list = visibleUsers(user, { tracking: true });
    const cal = calc().loadCalendar(list.map((u) => u.id), day, day);
    const out = [];
    for (const u of list) {
      const p = personReport(u, day, cal);
      if (['before', 'off', 'leave', 'holiday', 'upcoming'].includes(p.status) && !p.worked_secs) continue;
      const f = p.flags.filter((x) => x.level !== 'blue');
      if (f.length) out.push({ id: p.id, name: p.name, level: p.level, label: f[0].label, more: f.length - 1 });
    }
    return out.sort((a, b) => FLAG_ORDER[a.level] - FLAG_ORDER[b.level] || a.name.localeCompare(b.name));
  };

  // the recent work days, newest first, with whether each one's report is ready
  function recentDays(user, n = 21) {
    const list = visibleUsers(user, { tracking: true });
    const work = companyDays();
    const out = [];
    let d = calc().companyToday();
    // days before the company was on Staffwarden have no report
    const since = String((db.prepare('SELECT MIN(created_at) f FROM users').get() || {}).f || '').slice(0, 10);
    for (let i = 0; i < 60 && out.length < n; i++, d = T.addDays(d, -1)) {
      if (since && d < T.addDays(since, -1) && i > 0) break;   // a day of slack: created_at is UTC
      const anyone = list.some((u) => isWorkDay(u, d));
      if (!anyone && !work.has(T.dow(d))) continue;
      const r = readyAt(list, d);
      out.push({ day: d, ready_at: r ? T.iso(r) : null, final: r != null && clockNow() >= r, today: i === 0 });
    }
    return out;
  }

  const dayOf = (params) => { need(T.isDay(params.day), 400, 'day must look like 2026-10-24'); need(params.day <= calc().companyToday(), 400, 'That day hasn’t happened yet'); return params.day; };

  // the email settings (registered before /:day so "email" isn't read as a day)
  // the owner's own mailbox: only the owner (not a developer) decides where its password is sent
  const needOwnerHere = (user) => need(ctx.isRealOwner(user), 403, 'Only the owner can do this');
  route('GET', '/api/shift-reports/email', ({ user }) => { needOwnerHere(user); const c = mailCfg(); const o = ownerUser(); return { ...publicMail(c), owner_email: o ? o.email : null }; });
  route('PUT', '/api/shift-reports/email', ({ user, body }) => {
    needOwnerHere(user);
    const c = mailCfg();
    const to = (Array.isArray(body.to) ? body.to : String(body.to || '').split(/[,;\s]+/)).map((x) => String(x).trim()).filter(Boolean);
    need(to.length <= 10, 400, 'Up to 10 addresses');
    need(to.every(smtp.validAddr), 400, `That doesn’t look like an email address: ${to.find((x) => !smtp.validAddr(x)) || ''}`);
    const host = String(body.host || '').trim().toLowerCase();
    need(!host || /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host), 400, 'The mail server looks like smtp.hostinger.com');
    const port = Number(body.port || 587);
    need([25, 465, 587, 2525].includes(port), 400, 'The port is usually 465 or 587');
    const userName = String(body.user || '').trim().slice(0, 200);
    const from = String(body.from || '').trim();
    need(!from || smtp.validAddr(from), 400, 'The "send from" address doesn’t look like an email address');
    const on = !!body.on;
    // a saved password only ever goes to the server and username it was typed for: change either and it
    // has to be typed again
    const same = host === (c.host || '') && userName === (c.user || '');
    const pass = body.pass != null && String(body.pass) !== '' ? String(body.pass).slice(0, 300) : (same ? c.pass : '');
    if (on) { need(to.length, 400, 'Add who gets the report'); need(host && userName && pass, 400, 'Fill in the mail server, username and password to switch it on'); }
    const next = { ...c, on, to, host, port, user: userName, from, pass };
    saveMail(next);
    audit(user, 'reports.email', null, on ? `Shift report emailed to ${to.join(', ')}` : 'Shift report email off');
    return publicMail(next);
  });
  route('POST', '/api/shift-reports/email/test', async ({ user }) => {
    needOwnerHere(user);
    const c = mailCfg();
    need(c.host && c.user && c.pass && (c.to || []).length, 400, 'Save the mail server, login and who gets it first');
    // the newest report that's final, else today's so far
    const people = tracked(), today = calc().companyToday();
    let day = today;
    for (let i = 0; i < 14; i++) { const d = T.addDays(today, -i); const r = readyAt(people, d); if (r != null && clockNow() >= r) { day = d; break; } }
    try { const res = await mailReport(day, { test: true, cfg: c }); return { ok: true, to: res.to, day }; }
    catch (e) { need(false, 400, e.message); }
  });

  route('GET', '/api/shift-reports', ({ user }) => { needManager(user); return { days: recentDays(user), today: calc().companyToday() }; });
  route('GET', '/api/shift-reports/:day', ({ user, params }) => { needManager(user); return build(user, dayOf(params)); });
  route('GET', '/api/shift-reports/:day/pdf', ({ user, params }) => {
    needManager(user);
    const r = build(user, dayOf(params));
    return { raw: pdfOf(r), type: 'application/pdf', headers: { 'Content-Disposition': `attachment; filename="shift-report-${r.day}.pdf"`, 'Cache-Control': 'private, no-store' } };
  });

  // ---------- the PDF ----------
  // Built to be read top down: what needs attention first, then everyone on one table with anything
  // unusual coloured where it is, then the details person by person.
  const LABEL = { present: 'On time', late: 'Late', absent: 'Absent', leave: 'On leave', holiday: 'Holiday', off: 'Day off', upcoming: 'Not yet', not_started: 'Not started' };
  const INK = '#151A2D', SOFT = '#6B7280', FAINT = '#9CA3AF', RULE = '#E5E7EB', ZEBRA = '#F8F9FB', ACCENT = '#5B47D6';
  const LV = { red: '#B91C1C', amber: '#B45309', blue: '#1D4ED8', green: '#15803D' };
  const TINT = { red: '#FDECEC', amber: '#FEF4E6', blue: '#EBF2FE', green: '#E8F6EE' };
  const STATUS_LV = { present: 'green', late: 'amber', absent: 'red', not_started: 'red' };
  const longDay = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const lvOf = (p, ...keys) => { const f = p.flags.find((x) => keys.includes(x.key)); return f ? f.level : null; };

  function pdfOf(r) {
    const doc = new Pdf();
    const L = 40, R = PAGE_W - 40, CW = R - L, BOTTOM = PAGE_H - 50;
    let y = 0, pageNo = 1;
    const t = r.totals;
    const made = new Date(Date.parse(r.generated_at) + calc().companyTz() * 60000).toISOString().slice(11, 16);
    const foot = () => {
      doc.line(L, PAGE_H - 34, R, PAGE_H - 34, { color: RULE });
      doc.text(L, PAGE_H - 22, `${r.org}  ·  Shift report  ·  ${longDay(r.day)}`, { size: 7.5, color: FAINT });
      doc.text(R, PAGE_H - 22, `Page ${pageNo}`, { size: 7.5, color: FAINT, align: 'right' });
    };
    const newPage = () => { foot(); doc.page(); pageNo++; y = 48; };
    const room = (h) => { if (y + h > BOTTOM) { newPage(); return true; } return false; };
    const dot = (x, yy, lv) => doc.rect(x, yy - 5.5, 5, 5, { fill: LV[lv] || FAINT });
    const wrap = (s, size, maxW, bold = false) => {
      const out = [];
      for (const para of String(s || '').split(/\n+/)) {
        let line = '';
        for (const w of para.split(/\s+/).filter(Boolean)) { const next = line ? `${line} ${w}` : w; if (width(next, size, bold) > maxW && line) { out.push(line); line = w; } else line = next; }
        if (line) out.push(line);
      }
      return out;
    };

    // ---- header ----
    doc.rect(0, 0, PAGE_W, 4, { fill: ACCENT });
    doc.text(L, 38, r.org, { size: 9, bold: true, color: SOFT });
    doc.text(L, 64, 'Shift report', { size: 22, bold: true, color: INK });
    doc.text(L, 84, longDay(r.day), { size: 11, color: SOFT });
    const st = r.final ? ['Final', 'green'] : ['In progress', 'amber'];
    const pw = width(st[0], 9, true) + 26;
    doc.rect(R - pw, 46, pw, 20, { fill: TINT[st[1]] });
    dot(R - pw + 10, 59, st[1]);
    doc.text(R - pw + 19, 59.5, st[0], { size: 9, bold: true, color: LV[st[1]] });
    doc.text(R, 84, r.final ? `Made at ${made}, after the last shift` : `Numbers so far, as of ${made}`, { size: 8.5, color: SOFT, align: 'right' });
    doc.line(L, 100, R, 100, { color: INK, w: 1.2 });

    // ---- the day in six numbers ----
    y = 112;
    const cells = [
      ['Worked', dur(t.worked_secs), t.expected_secs ? `of ${dur(t.expected_secs)} planned` : 'nothing planned', t.expected_secs && r.final && t.worked_secs < t.expected_secs * 0.9 ? 'amber' : null],
      ['In today', `${t.present} of ${t.people}`, t.on_leave ? `${t.on_leave} on leave` : 'scheduled', null],
      ['Late', String(t.late), t.late ? 'after the grace period' : 'nobody', t.late ? 'amber' : null],
      ['Absent', String(t.absent), t.absent ? 'no work, no leave' : 'nobody', t.absent ? 'red' : null],
      ['Activity', t.activity_pct == null ? '-' : `${t.activity_pct}%`, 'average while working', t.activity_pct != null && t.activity_pct < 40 ? 'amber' : null],
      ['Needs attention', String(t.flagged_people), t.flagged_people ? `${t.flagged_people === 1 ? 'person' : 'people'}, ${t.flags_red} serious` : 'nothing unusual', t.flags_red ? 'red' : t.flags_amber ? 'amber' : 'green'],
    ];
    const cw = CW / cells.length;
    cells.forEach(([k, v, sub, lv], i) => {
      const x = L + i * cw;
      if (i) doc.line(x, y + 2, x, y + 46, { color: RULE });
      const px = x + (i ? 10 : 0);
      doc.text(px, y + 12, k, { size: 7.5, color: SOFT });
      doc.text(px, y + 32, v, { size: 16, bold: true, color: lv ? LV[lv] : INK });
      doc.text(px, y + 44, sub, { size: 7, color: FAINT, maxW: cw - 14 });
    });
    y += 58;
    doc.line(L, y, R, y, { color: RULE });
    y += 26;

    // ---- needs attention ----
    const flagged = r.people.filter((p) => p.flags.length).sort((a, b) => FLAG_ORDER[a.level] - FLAG_ORDER[b.level]);
    doc.text(L, y, 'Needs attention', { size: 13, bold: true, color: INK });
    const issues = flagged.reduce((n, p) => n + p.flags.filter((f) => f.level !== 'blue').length, 0);
    doc.text(R, y, issues ? `${issues} ${issues === 1 ? 'thing' : 'things'} to look at` : '', { size: 8.5, color: SOFT, align: 'right' });
    y += 14;
    if (!flagged.length) {
      doc.rect(L, y, CW, 30, { fill: TINT.green });
      dot(L + 12, y + 19, 'green');
      doc.text(L + 24, y + 19, 'Nothing unusual. Everyone kept to their hours.', { size: 10, bold: true, color: LV.green });
      y += 44;
    } else {
      for (const p of flagged) {
        const lines = p.flags.map((f) => ({ f, ls: wrap(f.label, 9, CW - 170) }));
        const h = lines.reduce((n, x) => n + x.ls.length * 12, 0) + 12;
        room(h + 4);
        doc.rect(L, y, CW, h, { fill: TINT[p.level] || ZEBRA });
        doc.rect(L, y, 3, h, { fill: LV[p.level] || FAINT });
        doc.text(L + 12, y + 15, p.name, { size: 9.5, bold: true, color: INK, maxW: 140 });
        let yy = y + 15;
        for (const { f, ls } of lines) {
          dot(L + 160, yy, f.level);
          ls.forEach((ln, i) => { doc.text(L + 170, yy, ln, { size: 9, bold: i === 0 && f.level === 'red', color: f.level === 'blue' ? LV.blue : f.level === 'red' ? LV.red : '#7C3E06' }); yy += 12; });
        }
        y += h + 4;
      }
      y += 8;
      dot(L, y + 6, 'red'); doc.text(L + 8, y + 6, 'Act on it', { size: 7.5, color: SOFT });
      dot(L + 62, y + 6, 'amber'); doc.text(L + 70, y + 6, 'Worth a look', { size: 7.5, color: SOFT });
      dot(L + 136, y + 6, 'blue'); doc.text(L + 144, y + 6, 'Unusual but fine', { size: 7.5, color: SOFT });
      y += 26;
    }

    // ---- everyone ----
    room(80);
    doc.text(L, y, 'Everyone', { size: 13, bold: true, color: INK });
    doc.text(R, y, "Times are each person's local time", { size: 8.5, color: SOFT, align: 'right' });
    y += 12;
    const C = { name: L + 8, status: L + 136, in: L + 204, out: L + 240, worked: L + 316, planned: L + 360, breaks: L + 402, idle: L + 438, act: L + 474, flags: R - 6 };
    const head = () => {
      doc.rect(L, y, CW, 18, { fill: '#EEF0F4' });
      [['Name', C.name, 'left'], ['Status', C.status, 'left'], ['In', C.in, 'left'], ['Out', C.out, 'left'], ['Worked', C.worked, 'right'], ['Planned', C.planned, 'right'], ['Breaks', C.breaks, 'right'], ['Idle', C.idle, 'right'], ['Active', C.act, 'right'], ['Flags', C.flags, 'right']]
        .forEach(([c, x, a]) => doc.text(x, y + 12, c, { size: 7.5, bold: true, color: SOFT, align: a }));
      y += 18;
    };
    head();
    r.people.forEach((p, i) => {
      if (y + 18 > BOTTOM) { newPage(); head(); }
      const rowLv = p.level === 'red' || p.level === 'amber' ? p.level : null;
      if (rowLv) doc.rect(L, y, CW, 18, { fill: TINT[rowLv] }); else if (i % 2) doc.rect(L, y, CW, 18, { fill: ZEBRA });
      if (rowLv) doc.rect(L, y, 2.5, 18, { fill: LV[rowLv] });
      const by = y + 12;
      const c = (lv) => (lv ? LV[lv] : INK);
      doc.text(C.name, by, p.name, { size: 8.5, bold: true, color: INK, maxW: 124 });
      const sl = STATUS_LV[p.status];
      doc.text(C.status, by, p.status === 'late' ? `Late ${p.late_by_min}m` : LABEL[p.status] || p.status, { size: 8, bold: true, color: sl ? LV[sl] : SOFT });
      doc.text(C.in, by, p.first_start || '-', { size: 8.5, color: c(lvOf(p, 'late')) });
      doc.text(C.out, by, p.running ? 'on' : p.last_end || '-', { size: 8.5, color: c(lvOf(p, 'early', 'running')) });
      doc.text(C.worked, by, p.worked_secs ? dur(p.worked_secs) : '-', { size: 8.5, bold: true, align: 'right', color: c(lvOf(p, 'short', 'overtime', 'dayoff')) });
      doc.text(C.planned, by, p.expected_secs ? dur(p.expected_secs) : '-', { size: 8.5, align: 'right', color: SOFT });
      doc.text(C.breaks, by, p.break_secs >= 60 ? dur(p.break_secs) : '-', { size: 8.5, align: 'right', color: c(lvOf(p, 'breaks')) });
      doc.text(C.idle, by, p.idle_secs >= 60 ? dur(p.idle_secs) : '-', { size: 8.5, align: 'right', color: c(lvOf(p, 'idle')) });
      doc.text(C.act, by, p.activity_pct == null ? '-' : `${p.activity_pct}%`, { size: 8.5, align: 'right', color: c(lvOf(p, 'activity')) });
      const nf = p.flags.length;
      if (nf) { doc.text(C.flags, by, String(nf), { size: 8.5, bold: true, align: 'right', color: LV[p.level] }); dot(C.flags - width(String(nf), 8.5, true) - 9, by, p.level); }
      else doc.text(C.flags, by, '-', { size: 8.5, align: 'right', color: FAINT });
      y += 18;
    });
    if (!r.people.length) { doc.text(L + 8, y + 14, 'Nobody was scheduled or worked on this day.', { size: 9.5, color: SOFT }); y += 24; }
    doc.line(L, y, R, y, { color: RULE });

    // ---- each person ----
    const detail = r.people.filter((p) => p.worked_secs || p.running || p.checkin || p.flags.some((f) => f.level !== 'blue'));
    if (detail.length) {
      y += 34;
      if (y > PAGE_H * 0.62) newPage();
      doc.text(L, y, 'Each person', { size: 13, bold: true, color: INK });
      y += 18;
    }
    const kv = (label, text, color = INK) => {
      const ls = wrap(text, 9, CW - 96);
      if (!ls.length) return;
      room(Math.min(ls.length, 3) * 12 + 4);
      doc.text(L + 10, y, label, { size: 8, bold: true, color: SOFT });
      for (const ln of ls) { if (y + 12 > BOTTOM) newPage(); doc.text(L + 96, y, ln, { size: 9, color }); y += 12; }
      y += 4;
    };
    for (const p of detail) {
      room(120);
      doc.line(L, y, R, y, { color: INK, w: 0.8 });
      y += 18;
      doc.text(L, y, p.name, { size: 12, bold: true, color: INK, maxW: 330 });
      const sl = STATUS_LV[p.status];
      doc.text(R, y, p.status === 'late' ? `Late by ${p.late_by_min} min` : LABEL[p.status] || p.status, { size: 9, bold: true, color: sl ? LV[sl] : SOFT, align: 'right' });
      y += 13;
      doc.text(L, y, [p.title, p.team, `Shift ${p.shift}`].filter(Boolean).join('  ·  '), { size: 8.5, color: SOFT, maxW: 360 });
      doc.text(R, y, p.first_start ? `${p.first_start} to ${p.running ? 'still working' : p.last_end}` : 'Did not start', { size: 8.5, color: SOFT, align: 'right' });
      y += 14;
      // the flags, in their colours
      for (const f of p.flags) {
        for (const [i, ln] of wrap(f.label, 9, CW - 30).entries()) {
          room(14);
          if (!i) { doc.rect(L, y - 1, CW, 14, { fill: TINT[f.level] }); dot(L + 8, y + 9.5, f.level); }
          else doc.rect(L, y - 1, CW, 14, { fill: TINT[f.level] });
          doc.text(L + 19, y + 9.5, ln, { size: 9, bold: f.level === 'red' && !i, color: f.level === 'blue' ? LV.blue : f.level === 'red' ? LV.red : '#7C3E06' });
          y += 14;
        }
        y += 2;
      }
      y += 6;
      // the numbers
      const nums = [
        ['Worked', p.worked_secs ? dur(p.worked_secs) : '-', lvOf(p, 'short', 'overtime', 'dayoff')], ['Planned', p.expected_secs ? dur(p.expected_secs) : '-', null],
        ['Breaks', p.break_secs >= 60 ? `${dur(p.break_secs)} (${p.break_count})` : '-', lvOf(p, 'breaks')], ['Idle', p.idle_secs >= 60 ? dur(p.idle_secs) : '-', lvOf(p, 'idle')],
        ['Activity', p.activity_pct == null ? '-' : `${p.activity_pct}%`, lvOf(p, 'activity')], ['Computer away', p.away_secs >= 60 ? dur(p.away_secs) : '-', lvOf(p, 'away')],
        ['Screenshots', String(p.shots || 0), null], ['Tasks done', String(p.tasks.filter((x) => x.done).length || '-'), null],
      ];
      room(30);
      const nw = CW / nums.length;
      nums.forEach(([k, v, lv], i) => {
        doc.text(L + i * nw, y + 8, k, { size: 7.5, color: SOFT });
        doc.text(L + i * nw, y + 22, v, { size: 10, bold: true, color: lv ? LV[lv] : INK, maxW: nw - 6 });
      });
      y += 36;
      if (p.projects.length) kv('Time on', p.projects.map((x) => `${x.name} ${dur(x.secs)}`).join('   ·   '));
      if (p.breaks.length) kv('Breaks', p.breaks.map((b) => `${b.from}–${b.to || 'now'} ${dur(b.secs)}${b.reason ? ` ${b.reason}` : ''}`).join('   ·   '), lvOf(p, 'breaks') ? LV[lvOf(p, 'breaks')] : INK);
      if (p.tasks.length) kv('Tasks', p.tasks.map((x) => `${x.done ? 'Done' : 'For review'}: ${x.title}${x.project ? ` (${x.project})` : ''}`).join('\n'));
      if (p.checkin) {
        kv('Did', p.checkin.did); kv('Next', p.checkin.next);
        if (p.checkin.blockers.trim()) kv('Blocked by', p.checkin.blockers, LV.amber);
        if (p.checkin.mood) kv('Felt', { smooth: 'Smooth', busy: 'Busy', rough: 'Rough' }[p.checkin.mood] || p.checkin.mood, p.checkin.mood === 'rough' ? LV.amber : INK);
      }
      if (p.time_requests.length) kv('Missing time', p.time_requests.map((q) => `${q.from}–${q.to} ${dur(q.secs)}: ${q.reason} (${q.status})`).join('\n'));
      y += 10;
    }
    foot();
    return doc.toBuffer({ title: `Shift report ${r.day}`, author: r.org });
  }

  // ---------- emailing it ----------
  // The owner sets a mailbox for Staffwarden to send from and who gets the report. The password is stored
  // on the server and never sent back to the browser.
  const MAIL_KEY = 'report_mail';
  const mailCfg = () => { try { return JSON.parse((db.prepare('SELECT value FROM settings WHERE key = ?').get(MAIL_KEY) || {}).value || '{}') || {}; } catch { return {}; } };
  const saveMail = (c) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(MAIL_KEY, JSON.stringify(c));
  const publicMail = (c) => ({ on: !!c.on, to: c.to || [], host: c.host || '', port: c.port || 587, user: c.user || '', from: c.from || '', has_pass: !!c.pass,
    last_day: c.last_day || null, last_sent_at: c.last_sent_at || null, last_error: c.last_error || null, last_error_at: c.last_error_at || null });
  const ownerUser = () => db.prepare("SELECT * FROM users WHERE active = 1 AND role = 'owner' ORDER BY id LIMIT 1").get();
  const escH = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function mailBody(r) {
    const t = r.totals, link = ctx.publicUrl ? `${String(ctx.publicUrl).replace(/\/+$/, '')}/#/shift-report?day=${r.day}` : null;
    const flagged = r.people.filter((p) => p.level === 'red' || p.level === 'amber').sort((a, b) => FLAG_ORDER[a.level] - FLAG_ORDER[b.level]);
    const nums = [['Worked', `${dur(t.worked_secs)}${t.expected_secs ? ` of ${dur(t.expected_secs)} planned` : ''}`], ['In', `${t.present} of ${t.people}`], ['Late', String(t.late)], ['Absent', String(t.absent)], ['Activity', t.activity_pct == null ? '-' : `${t.activity_pct}%`]];
    const text = [`Shift report for ${longDay(r.day)}`, '', ...nums.map(([k, v]) => `${k}: ${v}`), '',
      flagged.length ? 'Needs attention:' : 'Nothing unusual. Everyone kept to their hours.',
      ...flagged.map((p) => `- ${p.name}: ${p.flags.filter((f) => f.level !== 'blue').map((f) => f.label).join('; ')}`), '',
      'The full report is attached as a PDF.', link ? `Open it in Staffwarden: ${link}` : ''].join('\n');
    const C = { red: '#B91C1C', amber: '#B45309' };
    const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f8;font-family:Arial,Helvetica,sans-serif;color:#151a2d">
<table role="presentation" width="100%" style="max-width:620px;margin:0 auto;background:#fff;border-radius:10px;border-top:4px solid #5b47d6" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 28px">
<div style="font-size:12px;color:#6b7280;font-weight:bold">${escH(r.org)}</div>
<h1 style="margin:6px 0 2px;font-size:22px">Shift report</h1><div style="font-size:14px;color:#6b7280">${escH(longDay(r.day))}</div>
<table role="presentation" width="100%" style="margin:18px 0;border-collapse:collapse"><tr>${nums.map(([k, v]) => `<td style="padding:8px 6px;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb"><div style="font-size:11px;color:#6b7280">${escH(k)}</div><div style="font-size:15px;font-weight:bold">${escH(v)}</div></td>`).join('')}</tr></table>
<h2 style="font-size:15px;margin:0 0 8px">${flagged.length ? 'Needs attention' : 'Nothing unusual'}</h2>
${flagged.length ? flagged.map((p) => `<div style="margin:0 0 8px;padding:10px 12px;border-left:3px solid ${C[p.level]};background:${p.level === 'red' ? '#fdecec' : '#fef4e6'}"><b>${escH(p.name)}</b><br>${p.flags.filter((f) => f.level !== 'blue').map((f) => `<span style="color:${C[f.level]};font-size:13px">${escH(f.label)}</span>`).join('<br>')}</div>`).join('') : '<p style="color:#15803d;margin:0">Everyone kept to their hours.</p>'}
<p style="font-size:13px;color:#6b7280;margin:18px 0 0">The full report, person by person, is attached as a PDF.${link ? ` <a href="${escH(link)}" style="color:#5b47d6">Open it in Staffwarden</a>.` : ''}</p>
</td></tr></table></body></html>`;
    const subject = `Shift report, ${T.human(r.day)}: ${flagged.length ? `${flagged.length} ${flagged.length === 1 ? 'person needs' : 'people need'} attention` : 'nothing unusual'}`;
    return { subject, text, html };
  }
  async function mailReport(day, { test = false, cfg: c = mailCfg() } = {}) {
    if (!test && !c.on) return { skipped: true };
    const owner = ownerUser(); if (!owner) throw new Error('No owner account');
    const r = build(owner, day);
    const { subject, text, html } = mailBody(r);
    try {
      const res = await smtp.sendMail({ host: c.host, port: c.port, user: c.user, pass: c.pass, from: c.from || c.user, fromName: `${r.org} · Staffwarden`, to: c.to,
        subject: test ? `[Test] ${subject}` : subject, text, html, attachments: [{ filename: `shift-report-${r.day}.pdf`, type: 'application/pdf', content: pdfOf(r) }] }, ctx.smtpOptions || {});
      const now = mailCfg(); if (!test) now.last_day = day; now.last_sent_at = nowIso(); now.last_error = null; saveMail(now);
      return res;
    } catch (e) {
      const now = mailCfg(); now.last_error = e.message; now.last_error_at = nowIso(); saveMail(now);
      console.error('shift report email', e.message);
      throw e;
    }
  }
  ctx.mailShiftReport = mailReport;
  // ---------- telling the owner and managers it's ready ----------
  const lastKey = 'shift_report_last';
  ctx.shiftReportSweep = () => {
    if (!ctx.notify) return 0;
    const people = tracked();
    if (!people.length) return 0;
    const now = clockNow();
    const last = (db.prepare('SELECT value FROM settings WHERE key = ?').get(lastKey) || {}).value || '';
    let n = 0;
    // yesterday's and today's company work day: a night shift's report comes the morning after it began
    const today = calc().companyToday();
    for (const day of [T.addDays(today, -1), today]) {
      if (day <= last) continue;
      const r = readyAt(people, day);
      if (r == null || now < r) continue;
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(lastKey, day);
      if (now - r > NOTIFY_WITHIN_H * 3600000) continue;
      const bosses = db.prepare("SELECT * FROM users WHERE active = 1 AND role IN ('owner','manager')").all();
      let mailTried = false;
      for (const b of bosses) {
        const mine = visibleUsers(b, { tracking: true });
        const worked = mine.filter((u) => { const m = calc().computeDay(u, day); return m.worked_secs > 0; });
        if (!worked.length) continue;
        const secs = worked.reduce((s, u) => s + calc().computeDay(u, day).worked_secs, 0);
        if (b.role === 'owner' && !mailTried) { mailTried = true; mailReport(day).catch(() => {}); }
        n += ctx.notify.notify(b.id, {
          kind: 'shift_report', title: `Shift report for ${T.human(day)} is ready`,
          body: `${worked.length} ${worked.length === 1 ? 'person' : 'people'} worked ${dur(secs)} in all. Open it to read or download the PDF.`,
          link: `#/shift-report?day=${day}`, dedupe: `shiftrep:${day}`, tag: `shiftrep${day}`,
        });
      }
    }
    return n;
  };
};
