'use strict';
// The shift report: once everyone's shift has ended, one page per work day saying what each person did,
// the hours they kept, their breaks, the tasks they finished and their check-in. The owner and managers
// hear when it's ready and can download it as a PDF. It is worked out from the same facts as every other
// page whenever it's opened, so a time request approved later shows up in it too.
const { need } = require('../lib/http');
const T = require('../lib/time');
const { Pdf, width, PAGE_W, PAGE_H } = require('../lib/pdf');

const READY_AFTER_MIN = 15;          // the report is ready this long after the last shift of the day ends
const NOTIFY_WITHIN_H = 18;          // a report older than this is never announced (no backlog after a deploy)

module.exports = (ctx) => {
  const { db, cfg, route, nowIso, clockNow, needManager, visibleUsers } = ctx;
  const calc = () => ctx.calc;

  const teamName = (id) => (id ? (db.prepare('SELECT name FROM teams WHERE id = ?').get(id) || {}).name || null : null);
  const hm = (iso, tz) => { if (!iso) return null; const m = T.localMinOfDay(Date.parse(iso), tz); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
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
  const tracked = () => db.prepare('SELECT * FROM users WHERE active = 1 AND tracks_time = 1').all();

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
    return {
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
    };
    return { day, org: cfg.orgName || 'Staffwarden', ready_at: ready ? T.iso(ready) : null, final: ready != null && clockNow() >= ready, generated_at: nowIso(), totals, people };
  }

  // the recent work days, newest first, with whether each one's report is ready
  function recentDays(user, n = 21) {
    const list = visibleUsers(user, { tracking: true });
    const work = companyDays();
    const out = [];
    let d = calc().companyToday();
    for (let i = 0; i < 60 && out.length < n; i++, d = T.addDays(d, -1)) {
      const anyone = list.some((u) => isWorkDay(u, d));
      if (!anyone && !work.has(T.dow(d))) continue;
      const r = readyAt(list, d);
      out.push({ day: d, ready_at: r ? T.iso(r) : null, final: r != null && clockNow() >= r, today: i === 0 });
    }
    return out;
  }

  const dayOf = (params) => { need(T.isDay(params.day), 400, 'day must look like 2026-10-24'); need(params.day <= calc().companyToday(), 400, 'That day hasn’t happened yet'); return params.day; };

  route('GET', '/api/shift-reports', ({ user }) => { needManager(user); return { days: recentDays(user), today: calc().companyToday() }; });
  route('GET', '/api/shift-reports/:day', ({ user, params }) => { needManager(user); return build(user, dayOf(params)); });
  route('GET', '/api/shift-reports/:day/pdf', ({ user, params }) => {
    needManager(user);
    const r = build(user, dayOf(params));
    return { raw: pdfOf(r), type: 'application/pdf', headers: { 'Content-Disposition': `attachment; filename="shift-report-${r.day}.pdf"`, 'Cache-Control': 'private, no-store' } };
  });

  // ---------- the PDF ----------
  const dur = (s) => { const m = Math.round((s || 0) / 60); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
  const LABEL = { present: 'On time', late: 'Late', absent: 'Absent', leave: 'On leave', holiday: 'Holiday', off: 'Day off', upcoming: 'Not yet', not_started: 'Not started' };
  const TONE = { present: '#1F8A5B', late: '#B7791F', absent: '#C0392B', not_started: '#C0392B', leave: '#5B6B78', holiday: '#5B6B78', off: '#5B6B78', upcoming: '#5B6B78' };
  const INK = '#0B1D2A', SOFT = '#5B6B78', RULE = '#E2E7EC', BAND = '#F3F5F8', ACCENT = '#6A4BE0';
  const longDay = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  function pdfOf(r) {
    const doc = new Pdf();
    const L = 44, R = PAGE_W - 44, BOTTOM = PAGE_H - 56;
    let y = 0, pageNo = 1;
    const foot = () => {
      doc.line(L, PAGE_H - 36, R, PAGE_H - 36, { color: RULE });
      doc.text(L, PAGE_H - 22, `${r.org} · Shift report · ${longDay(r.day)}`, { size: 8, color: SOFT });
      doc.text(R, PAGE_H - 22, `Page ${pageNo}`, { size: 8, color: SOFT, align: 'right' });
    };
    const newPage = () => { foot(); doc.page(); pageNo++; y = 52; };
    const room = (h) => { if (y + h > BOTTOM) newPage(); };

    // header band
    doc.rect(0, 0, PAGE_W, 118, { fill: '#10162B' });
    doc.rect(0, 118, PAGE_W, 3, { fill: ACCENT });
    doc.text(L, 50, r.org, { size: 19, bold: true, color: '#FFFFFF' });
    doc.text(L, 74, 'Shift report', { size: 11, color: '#B9C2E0' });
    doc.text(R, 50, longDay(r.day), { size: 13, bold: true, color: '#E9C77B', align: 'right' });
    const asOf = new Date(Date.parse(r.generated_at) + calc().companyTz() * 60000).toISOString().slice(11, 16);
    doc.text(R, 74, r.final ? `Final · made ${asOf}` : `In progress · so far, as of ${asOf}`, { size: 10, color: '#B9C2E0', align: 'right' });
    doc.text(L, 98, `${r.totals.people} ${r.totals.people === 1 ? 'person' : 'people'} · times are each person's local time`, { size: 9, color: '#8F9AC0' });
    y = 150;

    // summary tiles
    const t = r.totals;
    const tiles = [
      ['Hours worked', dur(t.worked_secs), t.expected_secs ? `of ${dur(t.expected_secs)} planned` : 'nothing planned'],
      ['Attendance', `${t.present}/${t.people}`, [t.late ? `${t.late} late` : null, t.absent ? `${t.absent} absent` : null, t.on_leave ? `${t.on_leave} on leave` : null].filter(Boolean).join(', ') || 'everyone in on time'],
      ['Breaks', dur(t.break_secs), `idle ${dur(t.idle_secs)}`],
      ['Activity', t.activity_pct == null ? '-' : `${t.activity_pct}%`, 'average while working'],
      ['Tasks', String(t.tasks_done), `done${t.tasks_review ? `, ${t.tasks_review} sent for review` : ''}`],
      ['Check-ins', `${t.checked_in}/${t.present || t.people}`, t.blockers ? `${t.blockers} with blockers` : 'no blockers'],
    ];
    const gap = 10, tw = (R - L - gap * 2) / 3, th = 58;
    tiles.forEach(([k, v, s], i) => {
      const x = L + (i % 3) * (tw + gap), ty = y + Math.floor(i / 3) * (th + gap);
      doc.rect(x, ty, tw, th, { fill: BAND });
      doc.text(x + 12, ty + 17, k, { size: 8.5, color: SOFT });
      doc.text(x + 12, ty + 38, v, { size: 17, bold: true, color: INK });
      doc.text(x + 12, ty + 51, s, { size: 7.5, color: SOFT, maxW: tw - 24 });
    });
    y += th * 2 + gap + 30;

    // the team at a glance
    doc.text(L, y, 'The team at a glance', { size: 12, bold: true }); y += 16;
    const cols = [
      ['Name', L, 'left'], ['Status', L + 150, 'left'], ['In', L + 222, 'left'], ['Out', L + 262, 'left'],
      ['Worked', L + 336, 'right'], ['Break', L + 384, 'right'], ['Idle', L + 426, 'right'], ['Active', L + 470, 'right'], ['Tasks', R, 'right'],
    ];
    const head = () => { doc.rect(L - 6, y - 2, R - L + 12, 18, { fill: '#E8EBF3' }); cols.forEach(([c, x, a]) => doc.text(x, y + 10, c, { size: 8, bold: true, color: SOFT, align: a })); y += 24; };
    head();
    r.people.forEach((p, i) => {
      if (y + 18 > BOTTOM) { newPage(); head(); }
      if (i % 2) doc.rect(L - 6, y - 11, R - L + 12, 18, { fill: '#FAFBFC' });
      doc.text(L, y + 1, p.name, { size: 9, bold: true, maxW: 142 });
      doc.text(L + 150, y + 1, p.status === 'late' ? `Late ${p.late_by_min}m` : LABEL[p.status] || p.status, { size: 8.5, bold: true, color: TONE[p.status] || SOFT, maxW: 68 });
      doc.text(L + 222, y + 1, p.first_start || '-', { size: 9, color: INK });
      doc.text(L + 262, y + 1, p.running ? 'working' : p.last_end || '-', { size: 9, color: p.running ? ACCENT : INK });
      doc.text(L + 336, y + 1, p.worked_secs ? dur(p.worked_secs) : '-', { size: 9, bold: true, align: 'right' });
      doc.text(L + 384, y + 1, p.break_secs ? dur(p.break_secs) : '-', { size: 9, align: 'right' });
      doc.text(L + 426, y + 1, p.idle_secs ? dur(p.idle_secs) : '-', { size: 9, align: 'right' });
      doc.text(L + 470, y + 1, p.activity_pct == null ? '-' : `${p.activity_pct}%`, { size: 9, align: 'right' });
      doc.text(R, y + 1, String(p.tasks.filter((x) => x.done).length || '-'), { size: 9, align: 'right' });
      y += 18;
    });
    if (!r.people.length) { doc.text(L, y, 'Nobody was scheduled or worked on this day.', { size: 10, color: SOFT }); y += 18; }
    y += 22;

    // one section per person who was meant to work or did
    const wrapLines = (s, size, maxW, bold = false) => {
      const out = [];
      for (const para of String(s || '').split(/\n+/)) {
        let line = '';
        for (const w of para.split(/\s+/).filter(Boolean)) { const next = line ? `${line} ${w}` : w; if (width(next, size, bold) > maxW && line) { out.push(line); line = w; } else line = next; }
        if (line) out.push(line);
      }
      return out;
    };
    const block = (label, text, color = INK) => {
      const lines = wrapLines(text, 9, R - L - 96);
      if (!lines.length) return;
      room(14 * Math.min(lines.length, 3) + 6);
      doc.text(L + 8, y, label, { size: 8.5, bold: true, color: SOFT });
      for (const ln of lines) { if (y + 12 > BOTTOM) { newPage(); } doc.text(L + 96, y, ln, { size: 9, color }); y += 12.5; }
      y += 5;
    };
    for (const p of r.people) {
      if (!p.worked_secs && !p.running && !p.checkin) continue;     // in the table above; nothing more to say
      room(96);
      doc.rect(L - 6, y - 4, 3, 30, { fill: TONE[p.status] || ACCENT });
      doc.text(L + 4, y + 8, p.name, { size: 12.5, bold: true });
      doc.text(L + 4, y + 22, [p.title, p.team, `shift ${p.shift}`].filter(Boolean).join(' · '), { size: 8.5, color: SOFT, maxW: 300 });
      doc.text(R, y + 8, p.status === 'late' ? `Late by ${p.late_by_min} min` : LABEL[p.status] || p.status, { size: 9.5, bold: true, color: TONE[p.status] || SOFT, align: 'right' });
      doc.text(R, y + 22, p.first_start ? `${p.first_start} – ${p.running ? 'still working' : p.last_end}` : 'Did not start', { size: 8.5, color: SOFT, align: 'right' });
      y += 40;
      // numbers row
      const nums = [['Worked', dur(p.worked_secs)], ['Planned', p.expected_secs ? dur(p.expected_secs) : '-'], ['Breaks', p.break_secs >= 60 ? `${dur(p.break_secs)} (${p.break_count})` : '-'], ['Idle', p.idle_secs ? dur(p.idle_secs) : '-'], ['Away', p.away_secs ? dur(p.away_secs) : '-'], ['Activity', p.activity_pct == null ? '-' : `${p.activity_pct}%`], ['Screenshots', String(p.shots || 0)]];
      const nw = (R - L) / nums.length;
      doc.rect(L - 6, y - 4, R - L + 12, 34, { fill: BAND });
      nums.forEach(([k, v], i) => { doc.text(L + 4 + i * nw, y + 8, k, { size: 7.5, color: SOFT }); doc.text(L + 4 + i * nw, y + 22, v, { size: 10, bold: true }); });
      y += 44;
      if (p.projects.length) block('Time on', p.projects.map((x) => `${x.name} ${dur(x.secs)}`).join('   ·   '));
      if (p.breaks.length) block('Breaks', p.breaks.map((b) => `${b.from}–${b.to || 'now'} ${dur(b.secs)}${b.reason ? ` (${b.reason})` : ''}`).join('   ·   '));
      if (p.away_secs >= 60) block('Computer away', `${dur(p.away_secs)} in ${p.away_count || 1} ${p.away_count === 1 ? 'stretch' : 'stretches'}: asleep, restarting or off while the timer was on`, SOFT);
      if (p.tasks.length) {
        room(18);
        doc.text(L + 8, y, 'Tasks', { size: 8.5, bold: true, color: SOFT });
        for (const tk of p.tasks) {
          if (y + 12 > BOTTOM) newPage();
          doc.text(L + 96, y, `${tk.done ? 'Done' : 'For review'}`, { size: 8.5, bold: true, color: tk.done ? '#1F8A5B' : '#B7791F' });
          doc.text(L + 152, y, `${tk.title}${tk.project ? ` (${tk.project})` : ''}`, { size: 9, maxW: R - L - 200 });
          doc.text(R, y, tk.at || '', { size: 8.5, color: SOFT, align: 'right' });
          y += 12.5;
        }
        y += 5;
      }
      if (p.checkin) {
        block('Did', p.checkin.did);
        block('Next', p.checkin.next);
        if (p.checkin.blockers.trim()) block('Blockers', p.checkin.blockers, '#C0392B');
        if (p.checkin.mood) block('Felt', { smooth: 'Smooth', busy: 'Busy', rough: 'Rough' }[p.checkin.mood] || p.checkin.mood);
      } else if (p.worked_secs) block('Check-in', 'No check-in written.', SOFT);
      if (p.time_requests.length) block('Missing time', p.time_requests.map((q) => `${q.from}–${q.to} ${dur(q.secs)}: ${q.reason} (${q.status})`).join('   ·   '));
      y += 4; room(10); doc.line(L, y, R, y, { color: RULE }); y += 20;
    }
    foot();
    return doc.toBuffer({ title: `Shift report ${r.day}`, author: r.org });
  }

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
      for (const b of bosses) {
        const mine = visibleUsers(b, { tracking: true });
        const worked = mine.filter((u) => { const m = calc().computeDay(u, day); return m.worked_secs > 0; });
        if (!worked.length) continue;
        const secs = worked.reduce((s, u) => s + calc().computeDay(u, day).worked_secs, 0);
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
