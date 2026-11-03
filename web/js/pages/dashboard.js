import { rel, relRange, nowMs, html, raw, dur, hoursText, pctText, dayLong, dayShort, plural, tod, minOfDayIn, todayIn, relTime, addDays, mondayOf, tzLabel, tzShort, reasonLabel, fmtMin, hhmmText, ATT } from '../util.js';
import { get, qs } from '../api.js';
import { S, actions, ring, kpis, tag, attTag, liveTag, stateTags, person, ribbon, ribbonAxis, ribbonLegend, windowFor, bars, meter, toneFor, empty, setShots, shotTile, dial } from '../ui.js';
import { initials, avColor, icon } from '../util.js';
import { hrPanel } from './hr.js';
import { isMgr, companyToday, dayNav, teamSelect, breaksPanel, dayRibbonBlock, zoneBadge } from '../parts.js';
import { dueChip, openTask } from './tasks.js';
import { teamNow } from './explain.js';
import { godBand, godPanels, nudgeBoard } from './fun.js';
import { funWatch, godIntro } from '../v4.js';

// ================= manager / owner =================
// Everyone sorts into one of these groups. Today they follow the live timer first, then attendance;
// on other days only attendance counts. `full` groups get a timeline row, the rest a compact name chip.
const GROUPS_TODAY = [
  ['working', 'Working now', true], ['break', 'On a break', true], ['idle', 'Idle', true], ['no_signal', 'No signal', true],
  ['not_started', 'Not started', false], ['upcoming', 'Shift starts later', false], ['done', 'Signed off', true],
  ['absent', 'Absent', false], ['leave', 'On leave', false], ['off', 'Not working today', false],
];
const GROUPS_PAST = [['done', 'Worked', true], ['absent', 'Absent', false], ['leave', 'On leave', false], ['off', 'Not working that day', false]];
const DOT = { working: 'working', break: 'break', idle: 'idle', no_signal: 'no_signal', not_started: 'late', upcoming: 'offline', done: 'offline', absent: 'late', leave: 'leave', off: 'offline' };
function groupOf(m, isToday) {
  if (isToday && ['working', 'break', 'idle', 'no_signal'].includes(m.state)) return m.state;
  const a = m.attendance;
  if (a === 'present' || a === 'late') return 'done';
  if (a === 'not_started') return isToday ? 'not_started' : 'absent';
  if (a === 'upcoming') return isToday ? 'upcoming' : 'off';
  if (a === 'absent') return 'absent';
  if (a === 'leave' || a === 'holiday') return 'leave';
  return m.worked_secs > 0 ? 'done' : 'off';
}
const avatarOf = (m, cls = '') => html`<span class="avatar ${cls}" style="background:${avColor(m.user_id)}">${initials(m.name)}</span>`;
// what the person is doing, in words
function nowLine(m, g, isToday) {
  const on = [m.project, m.task].filter(Boolean).join(' › ');
  if (g === 'working') return html`<span class="num" data-since="${m.since}"></span>${on ? html` · <span class="on">${on}</span>` : ' · no project chosen'}`;
  if (g === 'break') return html`${reasonLabel(m.reason)} · <span class="num" data-since="${m.since}"></span>`;
  if (g === 'idle') return html`No keyboard or mouse for <span class="num" data-since="${m.since}"></span>`;
  if (g === 'no_signal') return html`Nothing heard since ${tod(m.since, m.tz_offset_min ?? 0)}`;
  if (g === 'done') return m.first_start ? html`Started ${tod(m.first_start, m.tz_offset_min ?? 0)}${m.late_by_min > 0 ? html` · <span class="late-t">${m.late_by_min} min late</span>` : ''}` : 'Worked';
  return '';
}
function shiftBar(win, nowRel, brk, ds) {
  const [lo, hi] = win, span = Math.max(1, hi - lo), pos = (x) => Math.max(0, Math.min(100, ((x - lo) / span) * 100));
  const step = span > 600 ? 120 : 60, ticks = [];
  for (let t = Math.ceil((lo + ds) / step) * step - ds, i = 0; t <= hi; t += step, i++) { const x = pos(t); ticks.push(html`<span class="${x < 3 ? 'first' : x > 97 ? 'last' : ''}${i % 2 ? ' odd' : ''}" style="left:${x}%">${fmtMin((t + ds) % 1440).replace(':00', '')}</span>`); }
  const inShift = nowRel != null && nowRel >= lo && nowRel <= hi;
  return html`<div class="shl" role="img" aria-label="The shift, ${fmtMin((lo + ds) % 1440)} to ${fmtMin((hi + ds) % 1440)}">
    <div class="shl-t">${nowRel != null ? html`<i class="shl-done" style="width:${nowRel >= hi ? 100 : pos(nowRel)}%"></i>` : ''}${brk ? html`<i class="shl-brk" style="left:${pos(brk[0])}%;width:${pos(brk[1]) - pos(brk[0])}%" title="Scheduled break"></i>` : ''}${inShift ? html`<b class="shl-now" style="left:${pos(nowRel)}%"></b>` : ''}</div>
    <div class="shl-x">${ticks}</div></div>`;
}

export const teamPage = {
  title: 'Dashboard',
  async load(q) {
    const [d, teams, idle, boost] = await Promise.all([get(`/api/dashboard/team${qs({ day: q.get('day'), team_id: q.get('team') })}`), get('/api/teams'), S.me.role === 'owner' || (S.me.role === 'manager' && S.settings.idle_tell_lead) ? get('/api/idle/board').catch(() => null) : null,
      S.me.role === 'owner' && !q.get('day') ? get('/api/boost').catch(() => null) : null]);
    S.teams = teams;
    return { ...d, idle, boost };
  },
  render(d, q) {
    const k = d.kpis, today = companyToday(), isToday = d.day === today;
    // one time axis for everyone, from the company's work day; each person's segments are moved onto it
    const ds = S.settings.day_start_min || 0;
    const onAxis = (m) => { const off = (m.day_start_min || 0) - ds; return off ? m.segs.map(([s, e, t]) => [s + off, e + off, t]) : m.segs; };
    const win = windowFor(d.members.map(onAxis), relRange(S.settings.shift_start, S.settings.shift_end, ds) || undefined);
    const shiftWin = relRange(S.settings.shift_start, S.settings.shift_end, ds) || win;   // equals win when no shift is set
    const nowMsg = [];
    // a break is "long" after 45 minutes, or 15 minutes past the scheduled break if that is longer
    const sb = relRange(S.settings.break_start, S.settings.break_end);
    const longBreak = Math.max(45, sb ? sb[1] - sb[0] + 15 : 0);
    for (const m of d.members) {
      const mins = m.last_seen_at ? Math.round((nowMs() - Date.parse(m.last_seen_at)) / 60000) : null;
      if (isToday && m.state === 'no_signal') nowMsg.push({ k: `n${m.user_id}`, tone: 'bad', text: html`<b>${m.name}</b>: timer is running but nothing has been heard for ${mins == null ? 'a while' : mins + ' min'}. The app may be closed or offline.` });
      else if (isToday && m.attendance === 'not_started') nowMsg.push({ k: `n${m.user_id}`, tone: 'late', text: html`<b>${m.name}</b> hasn't started the timer yet.` });
      else if (isToday && m.state === 'idle') nowMsg.push({ k: `n${m.user_id}`, tone: 'idle', text: html`<b>${m.name}</b> has been idle since ${tod(m.since, m.tz_offset_min)} with the timer running.` });
      else if (isToday && m.state === 'break' && nowMs() - Date.parse(m.since) > longBreak * 60000) nowMsg.push({ k: `n${m.user_id}`, tone: 'break', text: html`<b>${m.name}</b> has been on a ${reasonLabel(m.reason).toLowerCase()} break for over ${Math.round((nowMs() - Date.parse(m.since)) / 60000)} min.` });
      else if (m.late_by_min > 0) nowMsg.push({ k: `n${m.user_id}`, tone: 'late', text: html`<b>${m.name}</b> started ${m.late_by_min} min late.` });
    }
    const groups = (isToday ? GROUPS_TODAY : GROUPS_PAST).map(([g, label, full]) => [g, label, full, d.members.filter((m) => groupOf(m, isToday) === g)]);
    const anyFull = groups.some(([, , full, list]) => full && list.length);
    const count = (g) => (groups.find((x) => x[0] === g) || [0, 0, 0, []])[3].length;
    const n = d.members.length, sbr = relRange(S.settings.break_start, S.settings.break_end, ds);
    const nowRel = rel(minOfDayIn(S.settings.tz_offset_min || 0), ds);
    const sh = (m) => fmtMin((m + ds) % 1440);
    const inMin = (x) => dur(Math.max(0, x) * 60);
    let headline, subline;
    if (!isToday) {
      headline = `${count('done')} of ${n} worked`;
      subline = `${dur(k.worked_secs)} tracked by the team`;
    } else {
      headline = n ? `${count('working')} of ${n} working now` : 'Nobody here yet';
      if (shiftWin && shiftWin !== win && nowRel < shiftWin[0]) subline = `Shift starts at ${sh(shiftWin[0])}, in ${inMin(shiftWin[0] - nowRel)}`;
      else if (shiftWin && shiftWin !== win && nowRel <= shiftWin[1]) subline = `Shift ends at ${sh(shiftWin[1])}, in ${inMin(shiftWin[1] - nowRel)}`;
      else if (shiftWin && shiftWin !== win) subline = `Shift ended at ${sh(shiftWin[1])} · ${dur(k.worked_secs)} tracked`;
      else subline = `${dur(k.worked_secs)} tracked today`;
    }
    // the owner's bento already has "Needs attention now"; the panel lower down would say it twice
    const dupAttn = S.me.role === 'owner' && Array.isArray(d.attention);
    return html`
      <div class="page-h"><div><h1>Team activity</h1><p class="sub">${dayLong(d.day)}${isToday ? ' · live' : ''} · ${plural(k.members, 'person', 'people')}</p></div>
        <div class="tools">${S.me.fun_mode && isToday ? html`<a class="btn gm-go" href="#/">Back to god mode</a>` : ''}${teamSelect(q.get('team'))}${dayNav(d.day, today)}${boostTop(d, isToday)}</div>
        <div class="hero hero-team">
          <div class="ht-top">
            <div class="ht-say"><b>${headline}</b><span>${subline}</span></div>
            ${isToday && shiftWin && shiftWin !== win ? shiftBar(shiftWin, nowRel, sbr, ds) : ''}
          </div>
          <div class="ht-groups">${groups.filter(([g, , , list]) => list.length || g === (isToday ? 'working' : 'done')).map(([g, label, , list]) => html`
            <button type="button" class="ht-g g-${g}" data-k="g${g}" data-act="lane" data-id="${g}" ${list.length ? '' : 'disabled'}>
              <span class="ht-n"><i class="sw s-${DOT[g]}"></i><b class="num">${list.length}</b></span><span class="ht-l">${label}</span>
              <span class="stack" aria-hidden="true">${list.slice(0, list.length > 4 ? 3 : 4).map((m) => avatarOf(m))}${list.length > 4 ? html`<span class="avatar more">+${list.length - 3}</span>` : ''}</span></button>`)}</div>
        </div></div>
      ${k.pending_timeoff ? html`<div class="banner info"><span><b>${plural(k.pending_timeoff, 'time-off request')}</b> waiting for a decision.</span><a class="btn sm" href="#/timeoff">Review</a></div>` : ''}
      ${k.pending_requests ? html`<div class="banner info"><span><b>${plural(k.pending_requests, 'request')}</b> to add missing time waiting for a decision.</span><a class="btn sm" href="#/requests">Review</a></div>` : ''}
      ${isToday && d.idle ? nudgeBoard(d.idle) : ''}
      ${dashBento(k, d, isToday, shiftWin, d.members.map(onAxis), nowRel)}
      <section class="panel flush roster"><header><h2>Everyone</h2><div class="legend"><span><i class="sw s-working"></i>Working</span><span><i class="sw s-break"></i>Break</span><span><i class="sw s-idle"></i>Idle</span></div></header>
        <div class="body">${d.members.length ? html`<div class="tbl-wrap"><table class="t">${anyFull ? html`<thead><tr><th>Person</th><th class="th-rib" style="min-width:230px"><span class="sr">${isToday ? 'Today' : 'That day'}, by hour</span>${ribbonAxis(win, { maxLabels: 5, ds })}</th><th>Started</th><th class="r">Worked</th><th class="r">Breaks</th><th class="r">Activity</th><th>This week</th><th class="r">Last screenshot</th></tr></thead>` : ''}
          ${groups.filter(([, , , list]) => list.length).map(([g, label, full, list]) => html`<tbody class="lane" id="lane-${g}" data-k="l${g}">
            <tr class="lane-h"><th colspan="8"><i class="sw s-${DOT[g]}"></i>${label}<span class="lane-c num">${list.length}</span></th></tr>
            ${full ? list.map((m) => {
              const wk = m.week_target_secs ? Math.round((100 * m.week_secs) / m.week_target_secs) : 0;
              const nm = m.attendance && isToday ? rel(minOfDayIn(m.tz_offset_min), ds) : null;
              return html`<tr class="link" data-k="m${m.user_id}" data-act="go" data-href="#/timeline?user=${m.user_id}&day=${d.day}" tabindex="0">
                <td class="nm"><span class="who-cell">${avatarOf(m, 'st-' + DOT[g])}<span class="pc"><b>${m.name}${zoneBadge(m)}</b><span class="small muted">${nowLine(m, g, isToday)}</span></span></span></td>
                <td>${ribbon(onAxis(m), win, { nowMin: nm, ds })}</td>
                <td class="nowrap">${m.first_start ? html`<b class="num">${tod(m.first_start, m.tz_offset_min)}</b><br><span class="small ${m.late_by_min ? 'late-t' : 'muted'}">${m.late_by_min ? `${dur(m.late_by_min * 60)} late` : 'On time'}</span>` : html`<span class="faint">–</span>`}</td>
                <td class="r num"><b>${dur(m.worked_secs)}</b></td>
                <td class="r num">${m.break_count ? html`${m.break_count} · ${dur(m.break_secs)}` : html`<span class="faint">None</span>`}${m.idle_secs ? html`<br><span class="small muted">${dur(m.idle_secs)} idle</span>` : ''}</td>
                <td class="r">${m.activity_pct == null ? html`<span class="faint">–</span>` : html`<span class="pct">${meter(m.activity_pct, toneFor(m.activity_pct, 35, 50))}<span class="num">${m.activity_pct}%</span></span>`}</td>
                <td style="min-width:150px"><span class="num small">${dur(m.week_secs)} <span class="muted">of ${hoursText(m.week_target_secs)}</span></span>${meter(wk)}</td>
                <td class="r muted small num">${m.last_shot_at ? relTime(m.last_shot_at) : html`<span class="faint">None</span>`}</td></tr>`;
            }) : html`<tr class="lane-chips"><td colspan="8"><div class="pgrid2">${sortLane(list, g).map((m) => personTile(m, g, d.day, isToday))}</div></td></tr>`}
          </tbody>`)}</table></div>
` : empty('Nobody to show yet', html`Add people on the <a href="#/people">People</a> page.`)}</div></section>
      <div class="cols${dupAttn ? ' cols-one' : ''}">
        <section class="panel"><header><h2>Last 7 days</h2><span class="muted small">Team hours worked</span></header><div class="body">
          ${bars(d.trend.map((t) => ({ label: t.day === d.day ? 'Today' : dayShort(t.day).split(',')[0], sub: t.attendance_rate == null ? '' : t.attendance_rate + '% in', value: t.worked_secs, today: t.day === d.day, title: dayLong(t.day) })), { fmt: hoursText })}</div></section>
        ${dupAttn ? '' : html`<section class="panel"><header><h2>Needs attention</h2></header><div class="body">
          ${nowMsg.length ? html`<ul class="steps" style="list-style:none;margin:0;padding:0">${nowMsg.slice(0, 8).map((n) => html`<li data-k="${n.k}" style="display:flex;gap:10px;align-items:flex-start"><i class="sw s-${n.tone === 'bad' ? 'no_signal' : n.tone === 'late' ? 'late' : n.tone}" style="margin-top:6px"></i><span>${n.text}</span></li>`)}</ul>` : html`<p class="muted">Nothing needs attention right now.</p>`}</div></section>`}
      </div>`;
  },
};

// the owner's boost, at the top of the page: the button and whether one went out this shift
function boostTop(d, isToday) {
  if (S.me.role !== 'owner' || !isToday || !d.boost) return '';
  const b = d.boost.last, sent = b && nowMs() - Date.parse(b.created_at) < 14 * 3600000;
  return html`<span class="boost-top"><button type="button" class="bt-go" data-act="boost-open">${icon('rocket')}Boost the team</button><span class="bt-st${sent ? ' sent' : ''}">${sent ? `Sent ${relTime(b.created_at)}` : 'Not sent this shift'}</span></span>`;
}
const NA_DOT = { red: 'r', amber: 'a' };

// The numbers as a bento: the day's hours, attendance as a ring, the latest screenshots, the boost.
const ATT_DOT = { present: 'ok', late: 'late', not_started: 'wait', absent: 'bad', leave: 'leave', holiday: 'leave', upcoming: 'off', off: 'off' };
function dashBento(k, d, isToday, win, segsList, nowRel) {
  const tile = (area, label, ic, body, tone = '', extra = '') => html`<div class="kpi ${tone} bt-${area}" data-k="${label}"${raw(extra)}><div class="l">${icon(ic)}${label}</div>${body}</div>`;
  const v = (val, unit) => html`<div class="v">${val}${unit ? html` <small>${unit}</small>` : ''}</div>`;
  const f = (t) => (t ? html`<div class="f">${t}</div>` : '');
  const m = (pct, tone) => (pct == null ? '' : html`<div class="meter ${tone || ''}"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`);
  // the team's worked minutes in each hour of the shift; hours still to come stay as faint stubs
  const [lo, hi] = win || [0, 1440], hours = Math.max(1, Math.min(24, Math.round((hi - lo) / 60)));
  const worked = Array.from({ length: hours }, (_, i) => { const a = lo + i * 60, z = a + 60; let n = 0; for (const segs of segsList) for (const [s0, e0, t] of segs) if (t === 'w') n += Math.max(0, Math.min(z, e0) - Math.max(a, s0)); return n; });
  const wmax = Math.max(1, ...worked), later = (i) => isToday && nowRel != null && lo + i * 60 > nowRel;
  const started = d.members.filter((x) => x.first_start).length;
  const attn = S.me.role === 'owner' && Array.isArray(d.attention) ? d.attention : null;
  const shots = d.recent_shots || [];
  const tAtt = toneFor(k.attendance_rate, 70, 90);
  return html`<section class="kpis bento dash-bento no-boost" aria-label="Key numbers">
    ${tile('wk', 'Worked today', 'clock', html`<div class="bt-row">${v(dur(k.worked_secs))}<span class="bt-say">${isToday ? `${plural(k.working, 'person', 'people')} working now` : `${plural(k.members, 'person', 'people')} tracked`}</span></div>
      <div class="bt-bars" aria-hidden="true">${worked.map((x, i) => html`<i class="${later(i) ? 'later' : x ? '' : 'zero'}" style="height:${x ? Math.max(10, Math.round((100 * x) / wmax)) : 8}%"></i>`)}</div>`)}
    ${tile('at', 'Attendance', 'cal', html`<div class="bt-ringw">${ring(k.attendance_rate, tAtt)}<span class="bt-rv ${tAtt}"><b class="num">${pctText(k.attendance_rate)}</b><small>${started} of ${k.members}</small></span></div>
      ${f(k.late_count ? `${k.late_count} started late` : 'Nobody late')}
      <div class="bt-dots" role="img" aria-label="${started} of ${k.members} started">${d.members.slice(0, 18).map((x) => html`<i class="d-${ATT_DOT[x.attendance] || 'off'}" title="${x.name}"></i>`)}</div>`, tAtt)}
    ${tile('ac', 'Activity', 'pulse', html`${v(pctText(k.activity_pct))}${m(k.activity_pct, toneFor(k.activity_pct, 35, 50))}${f('Keyboard and mouse')}`, toneFor(k.activity_pct, 35, 50))}
    ${tile('sh', isToday ? 'Screenshots today' : 'Screenshots', 'camera', html`<a class="bt-more" href="#/screenshots${isToday ? '' : `?day=${d.day}`}">See all</a>
      <div class="bt-row">${v(String(k.shots))}<span class="bt-say">${S.settings.shots_per_10 === 0 ? 'Off by default' : `${S.settings.shots_per_10} per 10 min, private windows hidden`}</span></div>
      <div class="bt-shots">${shots.length ? shots.map((s) => html`<a class="bt-shot" href="#/screenshots?user=${s.user_id}${isToday ? '' : `&day=${d.day}`}" title="${s.user_name}, ${relTime(s.taken_at)}">${s.privacy === 'full' ? html`<span class="bt-priv">${icon('lock')}</span>` : html`<img data-shot="${s.id}" alt="Screenshot by ${s.user_name}" decoding="async">`}<span class="bt-who">${s.user_name.split(' ')[0]}</span></a>`)
        : html`<span class="bt-noshot">${icon('camera')}<span>The latest screenshots show here once someone is working.</span></span>`}</div>`)}
    ${tile('wp', 'Week pace', 'chart', html`<div class="bt-row">${v(pctText(k.week_pace_pct))}<span class="bt-say">${dur(k.week_secs)} of ${dur(k.week_expected_secs)} expected by now</span></div>${m(k.week_pace_pct, toneFor(k.week_pace_pct, 60, 85))}`, toneFor(k.week_pace_pct, 60, 85))}
    ${tile('ot', 'On time', 'check', html`${v(pctText(k.punctuality_rate))}${f('Of those who started')}`, toneFor(k.punctuality_rate, 70, 90))}
    ${tile('ab', 'Average break', 'pause', html`${v(dur(k.avg_break_secs))}${f('Per person who worked')}`)}
    ${tile('id', 'Idle time', 'sun', html`${v(dur(k.idle_secs))}${f('Still counted as work')}`)}
    ${tile('tk', 'Tasks', 'tasks', html`${v(String(k.tasks.open), 'open')}${f(`${k.tasks.overdue} overdue · ${k.tasks.in_review} in review${attn && k.tasks.completion_pct != null ? ` · ${k.tasks.completion_pct}% done on time` : ''}`)}`, k.tasks.overdue ? 'bad' : '')}
    ${tile('ta', 'Task accuracy', 'check', html`${v(pctText(k.tasks.accuracy_pct))}${m(k.tasks.accuracy_pct, toneFor(k.tasks.accuracy_pct, 60, 85))}${f('Approved first time')}`, toneFor(k.tasks.accuracy_pct, 60, 85))}
    ${attn ? tile('tc', isToday ? 'Needs attention now' : 'Needed attention', 'alert', html`<a class="bt-more" href="#/shift-report?day=${d.day}">Shift report</a>
        ${attn.length ? html`<ul class="na-l">${attn.slice(0, 3).map((a) => html`<li class="na-${NA_DOT[a.level] || 'a'}"><i></i><a href="#/timeline?user=${a.id}&day=${d.day}"><b>${a.name}</b></a><span>${a.label}${a.more ? html` <em>+${a.more}</em>` : ''}</span></li>`)}</ul>${attn.length > 3 ? f(`and ${plural(attn.length - 3, 'more person', 'more people')}`) : ''}`
        : html`<div class="na-ok">${icon('check')}<span>Nothing unusual${isToday ? ' so far' : ''}. Everyone is keeping to their hours.</span></div>`}`, attn.some((a) => a.level === 'red') ? 'na-bad' : attn.length ? 'na-warn' : '')
      : tile('tc', 'Task completion', 'tasks', html`<div class="bt-row">${v(pctText(k.tasks.completion_pct))}<span class="bt-say">Tasks due in 30 days that were done (${k.tasks.done_30} done)</span></div>${m(k.tasks.completion_pct, toneFor(k.tasks.completion_pct, 60, 85))}`, toneFor(k.tasks.completion_pct, 60, 85))}
  </section>`;
}

// people who aren't on a timeline row: one even tile each, saying the one thing that matters about them
const hhmm = (t) => { const [h, mm] = String(t || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (mm || 0) : null; };
const until = (m) => { const sh = hhmm(m.shift_start); if (sh == null) return null; const ds = m.day_start_min || 0; return rel(sh, ds) - rel(minOfDayIn(m.tz_offset_min ?? 0), ds); };
function sortLane(list, g) {
  if (g === 'upcoming' || g === 'not_started') return [...list].sort((a, b) => (until(a) ?? 9e9) - (until(b) ?? 9e9) || a.name.localeCompare(b.name));
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}
function personTile(m, g, day, isToday) {
  const u = until(m), start = hhmm(m.shift_start);
  const at = start == null ? '' : fmtMin(start);
  let tag = '', tone = '';
  if (g === 'upcoming') { tag = u != null && u > 0 ? `in ${dur(u * 60)}` : 'soon'; tone = u != null && u <= 60 ? 'soon' : ''; }
  else if (g === 'not_started') { tag = u != null && u < 0 ? `${dur(-u * 60)} late` : 'not started'; tone = 'late'; }
  else if (g === 'absent') { tag = 'absent'; tone = 'bad'; }
  else if (g === 'leave') { tag = m.attendance === 'holiday' ? 'holiday' : 'on leave'; tone = 'leave'; }
  else tag = 'day off';
  const sub = g === 'upcoming' || g === 'not_started' ? (at ? `${g === 'upcoming' ? 'Starts' : 'Due'} ${at}` : 'No shift set') : (m.title || '');
  return html`<div class="ptile t-${tone || 'plain'}" data-k="p${m.user_id}" data-act="go" data-href="#/timeline?user=${m.user_id}&day=${day}" role="link" tabindex="0" title="${m.name}${m.title ? ', ' + m.title : ''}">
    ${avatarOf(m)}<span class="pt-m"><span class="pt-r1"><b>${m.name}</b><span class="pt-tag">${tag}</span></span><small>${g === 'upcoming' || g === 'not_started' ? html`${sub}${m.title ? html` · <span class="pt-role">${m.title}</span>` : ''}` : sub}</small></span>${g === 'not_started' && isToday ? html`<button type="button" class="pt-nudge" data-act="ci-reply" data-id="${m.user_id}" aria-label="Message ${m.name}" title="Message ${m.name}">${icon('chat')}</button>` : ''}</div>`;
}

function myTasks(sum) {
  if (!sum.next.length) return empty('Nothing assigned to you', html`<a href="#/tasks">Add a task</a> to keep track of your own work.`);
  return html`<ul class="blist">${sum.next.slice(0, 6).map((t) => html`<li data-k="t${t.id}" class="clickable" data-act="open-task" data-id="${t.id}" tabindex="0"><i class="dotbox" style="background:${t.overdue ? 'var(--bad)' : t.due_today ? 'var(--brk)' : 'var(--line)'}"></i>
    <span class="what">${t.title}</span><span class="len">${dueChip(t)}</span><span class="when">${t.project || 'No project'}${t.status === 'in_progress' ? ' · in progress' : ''}${t.review_rounds && t.status === 'in_progress' ? ' · changes requested' : ''}</span></li>`)}</ul>`;
}

// row click / Enter navigates
actions.go = (el) => { location.hash = el.dataset.href; };
// a status card in the band jumps to that group in the list
actions.lane = (el) => { const t = document.getElementById('lane-' + el.dataset.id); if (t) t.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); };
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr[data-act="go"], .ptile[data-act="go"]')) { e.preventDefault(); location.hash = e.target.dataset.href; }
});

// ================= employee =================
export const mePage = {
  title: 'Your day',
  async load(q) {
    const day = q.get('day') || undefined;
    const d = await get(`/api/dashboard/me${qs({ day })}`);
    const [shots, tasks, team, hr, fun] = await Promise.all([get(`/api/screenshots${qs({ day: d.day, user_id: 'me' })}`), get('/api/tasks/summary'), get('/api/team/now').catch(() => null), S.me.hr ? get('/api/hr/overview').catch(() => null) : null, null /* god mode has its own home page now; this is the normal view */]);
    return { d, shots, tasks, team, hr, fun };
  },
  after(root, data) {
    if (!data.fun) return;
    funWatch(data.fun);
    if (data.fun.intro) godIntro(data.fun);
  },
  render({ d, shots, tasks, team, hr, fun }, q) {
    const k = d.kpis, tz = d.user.tz_offset_min, ds = d.user.day_start_min || 0, today = todayIn(tz - ds), isToday = d.day === today;
    const shift = relRange(d.user.shift_start || S.me.shift_start, d.user.shift_end || S.me.shift_end, ds), brk = relRange(d.user.break_start, d.user.break_end, ds);
    const lv = d.live || { state: 'offline' };
    const att = d.attendance;
    const win = windowFor([d.today.segs], shift || undefined);
    const recent = shots.slice(-6);
    const base = shots.length - recent.length;
    setShots(shots);
    let status;
    if (!isToday) status = html`<div class="body"><b>${attTag(att.status)}</b> ${att.first_in ? html`<span class="muted">Started ${tod(att.first_in, tz)}${att.last_out ? ', stopped ' + tod(att.last_out, tz) : ''}</span>` : html`<span class="muted">No time tracked.</span>`}</div>`;
    else if (lv.state === 'working') status = html`<div class="body"><p><b style="font-size:17px">Your timer is running</b> ${tag('working', 'Tracking')}</p><p class="muted">${lv.project ? lv.project + ' · ' : ''}Running for <span class="num" data-since="${lv.since}"></span>. ${(S.me.shots_per_10 ?? S.settings.shots_per_10) === 0 ? 'Screenshots are off for you.' : `A screenshot is taken ${(S.me.shots_per_10 ?? S.settings.shots_per_10) === 1 ? 'once' : `${S.me.shots_per_10 ?? S.settings.shots_per_10} times`} every 10 minutes at random moments.`}</p></div>`;
    else if (lv.state === 'idle' && lv.counted) status = html`<div class="body"><p><b style="font-size:17px">You seem to be away</b> ${tag('idle', 'Idle')} <span class="num muted" data-since="${lv.since}"></span></p><p class="muted">Your timer is still running. This time is marked idle and <b>no screenshots are taken</b> until you use your keyboard or mouse.</p></div>`;
    else if (lv.state === 'break' || lv.state === 'idle') status = html`<div class="body"><p><b style="font-size:17px">${lv.state === 'idle' ? 'Paused: no activity' : 'You are on ' + reasonLabel(lv.reason).toLowerCase()}</b> ${tag(lv.state === 'idle' ? 'idle' : 'break', 'Paused')} <span class="num muted" data-since="${lv.since}"></span></p><p class="muted"><b>No screenshots are being taken</b> and this time isn't counted as work. Press Resume in the desktop app when you are back.</p></div>`;
    else if (lv.state === 'no_signal') status = html`<div class="body"><p><b style="font-size:17px">We can't reach your timer</b> ${tag('no_signal', 'No signal')}</p><p class="muted">Last heard from the desktop app at ${tod(lv.last_seen_at, tz)}. Open the app and check your connection. If it stays silent the session is closed automatically at that time.</p></div>`;
    else status = html`<div class="body"><p><b style="font-size:17px">Your timer is off</b>${att.status === 'not_started' ? '' : html` ${tag('offline', 'Stopped')}`}</p><p class="muted">Open the Staffwarden desktop app and press <b>Start</b>. Screenshots are only taken while the timer is running, never while it is paused or stopped.</p></div>`;

    const cells = [
      { label: 'Task completion', value: pctText(k.tasks.completion_pct), tone: toneFor(k.tasks.completion_pct, 60, 85), meter: k.tasks.completion_pct, foot: 'Tasks due in 30 days that you finished' },
      { label: 'My tasks', value: String(k.tasks.open), unit: 'open', tone: k.tasks.overdue ? 'bad' : '', foot: k.tasks.overdue ? `${k.tasks.overdue} overdue` : `${k.tasks.in_review} waiting for review` },
      { label: 'On-time streak', value: String(k.on_time_streak), unit: k.on_time_streak === 1 ? 'day' : 'days', foot: `${pctText(k.punctuality_30)} on time in 30 days` },
      { label: 'Attendance', value: pctText(k.attendance_30), tone: toneFor(k.attendance_30, 70, 90), foot: 'Last 30 days' },
      { label: 'Task accuracy', value: pctText(k.tasks.accuracy_pct), tone: toneFor(k.tasks.accuracy_pct, 60, 85), foot: `Approved first time, 30 days · ${k.tasks.done_30} done` },
      { label: 'Time off left', value: String(k.leave_left), unit: 'days', foot: `${k.leave_taken} of ${k.leave_allowance} used this year` },
    ];
    const god = fun && isToday;
    return html`
      ${god ? godBand(fun, d) : ''}${god ? godPanels(fun, d) : ''}
      ${god ? '' : html`      <div class="page-h"><div><h1>${isToday ? 'Your day' : 'Your day, ' + dayShort(d.day)}</h1><p class="sub">${dayLong(d.day)} · ${tzShort(d.user.tz_name, tz)}</p></div>
        <div class="tools">${dayNav(d.day, today)}</div>
        <div class="hero hero-day">${dial(d.today.segs, shift || win, { size: 232, stroke: 14, ticks: true, now: isToday ? rel(minOfDayIn(tz), ds) : null, brk, ping: lv.state === 'working', key: 'me', center: html`<span class="cap">Worked</span><b class="big num">${dur(k.worked_secs)}</b><span class="cap">of ${dur(k.daily_target_secs)}</span>` })}
          <div class="hero-side"><div class="hero-tags">${isToday ? stateTags({ ...lv, tz_offset_min: tz }, att.status) : attTag(att.status)}</div>
            <div class="hero-stats"><div><span>Breaks</span><b class="num">${dur(k.break_secs)}</b><small>${k.break_count ? plural(k.break_count, 'break') : 'None yet'}</small></div><div><span>Activity</span><b class="num">${pctText(k.activity_pct)}</b><small>Keyboard and mouse</small></div><div><span>This week</span><b class="num">${dur(k.week_secs)}</b><small>${pctText(k.week_pace_pct)} of pace · ${hoursText(k.week_target_secs)}</small></div></div>
            <div class="hero-legend"><span><i class="sw s-working"></i>Working</span><span><i class="sw s-break"></i>Break</span><span><i class="sw s-idle"></i>Idle</span>${brk ? html`<span><i class="sw sched"></i>Scheduled break</span>` : ''}</div></div></div></div>`}
      <section class="panel" aria-label="Timer status"><header><h2>${att.status ? 'Today: ' + (ATT[att.status] || att.status) : 'Status'}${att.late_by_min ? ` (${att.late_by_min} min late)` : ''}</h2>${att.expected_secs ? html`<span class="muted small">Expected ${dur(att.expected_secs)}</span>` : ''}</header>${status}</section>
      ${S.me.policy_changes && S.me.policy_changes.reaccept ? html`<div class="banner warn"><span><b>What Staffwarden captures has changed.</b> Read what changed and agree before your next start.</span><a class="btn sm" href="#/profile">See what changed</a></div>` : ''}
      ${hr ? hrPanel(hr) : ''}
      ${isToday ? teamNow(team) : ''}
      ${kpis(cells)}
      <div class="cols">
        <section class="panel"><header><h2>Timeline</h2><span class="muted small">${d.today.first_start ? 'First start ' + tod(d.today.first_start, tz) : 'Nothing tracked'}${d.today.last_end && !d.live?.since ? ' · last stop ' + tod(d.today.last_end, tz) : ''}</span></header>
          <div class="body">${dayRibbonBlock(d.today.segs, win, { nowMin: isToday ? rel(minOfDayIn(tz), ds) : null, shift, brk, ds })}</div></section>
        <section class="panel flush"><header><h2>Your breaks</h2></header><div class="body">${breaksPanel(d.today.breaks, tz, d.day)}</div></section>
      </div>
      <section class="panel flush"><header><h2>My tasks</h2><a href="#/tasks">All tasks</a></header><div class="body">${myTasks(tasks)}</div></section>
      <section class="panel"><header><h2>Last 7 days</h2><span class="muted small">Hours worked</span></header><div class="body">
        ${bars(d.trend.map((t) => ({ label: t.day === d.day ? 'Today' : dayShort(t.day).split(',')[0], sub: t.expected_secs ? 'of ' + hoursText(t.expected_secs) : '', value: t.worked_secs, today: t.day === d.day, title: dayLong(t.day) })), { fmt: hoursText })}</div></section>
      <section class="panel"><header><h2>Your screenshots</h2><a href="#/screenshots?day=${d.day}">See all ${shots.length}</a></header><div class="body">
        ${recent.length ? html`<div class="shots" style="margin-bottom:0">${recent.map((s, i) => shotTile(s, base + i))}</div><p class="small muted mt">Only you and your managers can see these. You can open any of them and delete it.</p>` : empty('No screenshots yet', 'They appear here a minute after they are taken, only while your timer is running.')}</div></section>`;
  },
};
