// The leaderboard: who worked the most this week, month or year, with their activity alongside. The owner
// and developers choose what it ranks by, what it shows and who can see it.
import { html, raw, icon, dur, plural, initials, avColor, dayLong, owl } from '../util.js';
import { get, put, qs } from '../api.js';
import { S, actions, toast, empty, openModal, qAttr, findPeople, findBox, longList, noMatch } from '../ui.js';

const RANK = { hours: 'Hours worked', activity: 'Activity', points: 'Points' };
const COLS = { hours: 'Hours', activity: 'Activity', tasks: 'Tasks done', points: 'Points' };
const MEDAL = ['#F7B544', '#CFCBE3', '#D79A6B'];

const valueOf = (r, by) => (by === 'hours' ? r.hours_secs : by === 'points' ? r.points : r.activity_pct);
const show = (r, c) => (c === 'hours' ? dur(r.hours_secs) : c === 'activity' ? (r.activity_pct == null ? '–' : `${r.activity_pct}%`) : c === 'tasks' ? String(r.tasks_done) : String(r.points));
const big = (r, by) => (by === 'hours' ? dur(r.hours_secs) : by === 'points' ? `${r.points}` : r.activity_pct == null ? '–' : `${r.activity_pct}%`);
const unit = (by) => (by === 'points' ? ' pts' : '');
const av = (r, size, ring) => html`<span class="lb-av" style="--s:${size}px;background:${avColor(r.id)}${ring ? `;--ring:${ring}` : ''}" aria-hidden="true">${initials(r.name)}</span>`;
// a short second line for the podium: the other things shown
const second = (r, s) => s.columns.filter((c) => c !== s.rank_by).map((c) => (c === 'activity' ? (r.activity_pct == null ? null : `${r.activity_pct}% activity`) : c === 'hours' ? `${dur(r.hours_secs)} worked` : c === 'tasks' ? plural(r.tasks_done, 'task') : `${r.points} pts`)).filter(Boolean).join(', ');
const moveTag = (r) => {
  if (r.place == null) return html`<span class="lb-mv" aria-hidden="true"></span>`;
  if (r.new_entry) return html`<span class="lb-mv new" title="New on the board">New</span>`;
  if (r.move == null || r.move === 0) return html`<span class="lb-mv same" aria-label="Same place as before">–</span>`;
  return r.move > 0 ? html`<span class="lb-mv up" aria-label="Up ${r.move}">${icon('up')}${r.move}</span>` : html`<span class="lb-mv down" aria-label="Down ${-r.move}">${icon('dn')}${-r.move}</span>`;
};

// the podium's number counts up from zero, drawn by CSS (a registered --n counted by the browser), so a
// live refresh of the page can never interrupt or replay it; the real number is there for screen readers
const counter = (r, by) => {
  if (by === 'hours') {
    const h = Math.floor((r.hours_secs || 0) / 3600), m = Math.floor(((r.hours_secs || 0) % 3600) / 60);
    if (!h && !m) return html`${big(r, by)}`;
    return html`<span class="sr">${big(r, by)}</span><span aria-hidden="true">${h ? html`<span class="lb-cnt" style="--to:${h}"></span>h ` : ''}<span class="lb-cnt${h ? ' z' : ''}" style="--to:${m}"></span>m</span>`;
  }
  const v = by === 'points' ? r.points : r.activity_pct;
  if (v == null) return html`–`;
  return html`<span class="sr">${big(r, by)}</span><span aria-hidden="true"><span class="lb-cnt" style="--to:${v}"></span>${by === 'activity' ? '%' : ''}</span>`;
};

export default {
  title: 'Leaderboard',
  async load(q) {
    const period = ['month', 'year'].includes(q.get('period')) ? q.get('period') : 'week';
    return get(`/api/leaderboard${qs({ period: period === 'week' ? '' : period })}`);
  },
  render(d, q) {
    const s = d.settings, by = s.rank_by;
    const ranked = d.rows.filter((r) => r.place != null), unranked = d.rows.filter((r) => r.place == null);
    const sub = d.period === 'week' ? `${dayLong(d.from)} to ${dayLong(d.ends)}. Starts again on Monday.` : d.period === 'month' ? `${dayLong(d.from)} until today.` : `Since ${dayLong(d.from)}.`;
    const seg = html`<nav class="lb-seg" aria-label="Period">${[['week', 'This week'], ['month', 'This month'], ['year', 'This year']].map(([v, n]) => html`<button type="button" data-act="q" ${raw(qAttr('period', v === 'week' ? '' : v))} aria-pressed="${String(d.period === v)}">${n}</button>`)}</nav>`;
    const top = ranked.slice(0, 3);
    const podium = top.length ? html`<div class="lb-pod" data-n="${top.length}" data-k="pod-${d.period}-${by}">${top.map((r, i) => html`<div class="lb-step p${i + 1}" data-k="pod${r.id}">
        <div class="lb-who">${i === 0 ? html`<span class="lb-owl">${raw(owl('watch', 'Warden Owl, on top of the leader'))}</span>` : ''}${av(r, i === 0 ? 96 : 76, MEDAL[i])}
          <b>${r.name}</b><span>${r.team || r.title || ''}</span></div>
        <div class="lb-block"><i style="background:${MEDAL[i]}"></i><span class="lb-n" style="color:${MEDAL[i]}">${r.place}</span><span class="lb-v">${counter(r, by)}<small>${unit(by)}</small></span><span class="lb-s">${second(r, s) || RANK[by]}</span></div></div>`)}</div>`
      : html`<div class="lb-pod-empty">${raw(owl('doze'))}<b>Nobody on the board yet</b><span>${by === 'activity' ? 'People appear once they’ve worked two hours in this period.' : 'It fills up as soon as someone works.'}</span></div>`;
    const head = html`<div class="page-h lb-h"><div><h1>Leaderboard</h1><p class="sub">${sub}</p></div>
      <div class="tools">${seg}${d.can_change ? html`<button class="btn" data-act="lb-settings">${icon('sliders')} Change what it shows</button>` : ''}</div>${podium}</div>`;
    const maxV = Math.max(1, ...ranked.map((r) => valueOf(r, by) || 0));
    const row = (r) => {
      const me = r.id === d.me, i = r.place;
      const badge = i && i <= 3 ? html`<span class="lb-medal" style="background:${MEDAL[i - 1]}">${i}</span>` : html`<span class="lb-place">${i || ''}</span>`;
      return html`<tr class="${me ? 'me' : ''}${i ? '' : ' out'}" data-k="r${r.id}" style="--i:${Math.min(12, d.rows.indexOf(r))}">
        <td class="lb-pl">${badge}${moveTag(r)}</td>
        <td class="nm"><span class="person">${av(r, 36)}<span><b>${r.name}${me ? html` <em>(you)</em>` : ''}</b><span>${r.team || r.title || ''}</span></span></span></td>
        <td class="lb-barc">${i ? html`<span class="lb-bar"><i style="width:${Math.max(2, Math.round((100 * (valueOf(r, by) || 0)) / maxV))}%"></i></span>` : html`<span class="small muted">${by === 'activity' ? 'Under 2 hours worked' : by === 'points' ? 'No points yet' : 'Hasn’t worked yet'}</span>`}</td>
        ${s.columns.map((c) => html`<td class="r num ${c === by ? 'lb-main' : ''}">${show(r, c)}</td>`)}</tr>`;
    };
    // on a phone: one line per person, the main number on the right
    const item = (r) => {
      const me = r.id === d.me, i = r.place;
      const other = s.columns.filter((c) => c !== by).map((c) => `${COLS[c]} ${show(r, c)}`).join(' · ');
      return html`<li class="${me ? 'me' : ''}${i ? '' : ' out'}" data-k="l${r.id}" style="--i:${Math.min(12, d.rows.indexOf(r))}"><span class="lb-li-p">${i && i <= 3 ? html`<span class="lb-medal" style="background:${MEDAL[i - 1]}">${i}</span>` : html`<span class="lb-place">${i || '–'}</span>`}</span>
        ${av(r, 34)}<span class="lb-li-n"><b>${r.name}${me ? html` <em>(you)</em>` : ''}</b><span>${i ? other : (by === 'activity' ? 'Under 2 hours worked' : by === 'points' ? 'No points yet' : 'Hasn’t worked yet')}</span></span>
        <b class="lb-li-v">${i ? big(r, by) : ''}${i ? html`<small>${unit(by)}</small>` : ''}</b></li>`;
    };
    // a big company: find a person (their place stays), 25 at a time
    const found = findPeople([...ranked, ...unranked], q), pg = longList(found, q);
    const table = html`<section class="panel flush lb-table"><header><h2>Everyone</h2><span class="muted small">Ranked by ${RANK[by].toLowerCase()}</span>${d.rows.length > 8 ? findBox(q) : ''}</header>
      <div class="body">${d.rows.length && !found.length ? noMatch(q) : d.rows.length ? html`<div class="tbl-wrap lb-wide"><table class="t"><thead><tr><th>Place</th><th>Person</th><th class="lb-barc">${RANK[by]}</th>${s.columns.map((c) => html`<th class="r">${COLS[c]}</th>`)}</tr></thead>
        <tbody>${pg.items.map(row)}</tbody></table></div><ol class="lb-list">${pg.items.map(item)}</ol>${pg.more}` : empty('Nobody tracks time yet', 'People appear here once they track time with the desktop app.')}</div></section>`;
    // your spot
    const mine = d.rows.find((r) => r.id === d.me);
    let you = '';
    if (mine) {
      const ahead = mine.place ? ranked.filter((r) => r.place < mine.place).pop() : null;
      const gap = ahead ? valueOf(ahead, by) - valueOf(mine, by) : 0;
      const gapText = !ahead ? 'You’re in front. Nobody to catch.' : by === 'hours' ? `${dur(gap)} more to pass ${ahead.name.split(' ')[0]}` : by === 'points' ? `${gap} points to pass ${ahead.name.split(' ')[0]}` : `${gap} points of activity behind ${ahead.name.split(' ')[0]}`;
      you = html`<section class="lb-you"><span class="lb-you-l">Your ${d.period === 'week' ? 'week' : d.period === 'month' ? 'month' : 'year'}</span>
        <span class="lb-you-p"><span class="lb-you-n">${mine.place ? `#${mine.place}` : '–'}</span>${mine.place ? html`<span><b>${big(mine, by)}</b>${unit(by) || (by === 'hours' ? ' worked' : ' activity')}</span>` : html`<span><b>Not on the board yet</b></span>`}</span>
        ${mine.place ? html`<span class="lb-you-g">${gapText}</span>${ahead ? html`<span class="lb-you-bar"><i style="width:${Math.min(100, Math.round((100 * (valueOf(mine, by) || 0)) / Math.max(1, valueOf(ahead, by))))}%"></i></span>` : ''}` : html`<span class="lb-you-g">${by === 'activity' ? 'You’re ranked once you’ve worked two hours.' : 'You’re ranked once you start working.'}</span>`}
        <dl class="lb-you-d">${s.columns.filter((c) => c !== by).map((c) => html`<dt>${COLS[c]}</dt><dd>${show(mine, c)}</dd>`)}<dt>Days worked</dt><dd>${mine.days_worked}</dd></dl></section>`;
    }
    const teams = d.teams.length > 1 ? html`<section class="panel lb-teams"><header><h2>Team race</h2><span class="muted small">Average per person</span></header><div class="body">
      ${d.teams.map((t, i) => html`<div class="lb-tr"><span><b>${t.name}</b><span class="muted">${by === 'hours' ? dur(t.value) : by === 'points' ? `${t.value} pts` : `${t.value}%`} · ${plural(t.people, 'person', 'people')}</span></span><span class="lb-bar ${i ? 'soft' : ''}"><i style="width:${Math.max(3, Math.round((100 * t.value) / Math.max(1, d.teams[0].value)))}%"></i></span></div>`)}</div></section>` : '';
    const what = html`<section class="panel lb-what"><header><h2>What it shows</h2></header><div class="body">
      <p>Ranked by <b>${RANK[by].toLowerCase()}</b>${by === 'activity' ? ' (once someone has worked two hours)' : ''}. ${s.audience === 'everyone' ? 'Everyone on the team can see it.' : 'Only managers can see it.'}</p>
      <ul>${s.columns.map((c) => html`<li><b>${COLS[c]}</b>${c === 'hours' ? ': time tracked with the desktop app, breaks not included' : c === 'activity' ? ': how much of that time had keyboard or mouse use' : c === 'tasks' ? ': tasks finished in this period' : `: ${d.points.approved} for an approved task, ${d.points.on_time} more if on time, ${d.points.checkin} for a check-in, ${d.points.boost} for boosting back`}</li>`)}</ul>
      <p class="muted small">Never shown: screenshots, what was on screen, or why someone took a break.</p>
      ${d.can_change && d.not_tracked && d.not_tracked.length ? html`<p class="muted small lb-nt">Not on it, because they don’t track time: ${d.not_tracked.join(', ')}. To add someone, tick “Tracks their time” when editing them on the People page.</p>` : ''}</div></section>`;
    const total = d.rows.reduce((a, r) => a + (r.hours_secs || 0), 0), lead = ranked[0];
    const tiles = html`<div class="lb-tiles"><div class="lb-tile"><span>Team ${d.period === 'week' ? 'this week' : d.period === 'month' ? 'this month' : 'this year'}</span><b class="num">${total ? dur(total) : '–'}</b><small>${plural(d.rows.length, 'person', 'people')}</small></div>
      <div class="lb-tile warm"><span>Starts again</span><b>${d.period === 'week' ? 'Monday' : d.period === 'month' ? 'The 1st' : 'January'}</b><small>${d.period === 'week' ? 'Every week' : d.period === 'month' ? 'Every month' : 'Every year'}</small></div>
      <div class="lb-tile pink"><span>On the board</span><b class="num">${ranked.length}</b><small>${unranked.length ? `${unranked.length} haven’t worked yet` : 'Everyone has worked'}</small></div>
      <div class="lb-tile alt"><span>Out in front</span><b>${lead ? lead.name.split(' ')[0] : '–'}</b><small>${lead ? big(lead, by) + (unit(by) || '') : 'Nobody yet'}</small></div></div>`;
    return html`${head}<div class="cols lb-cols">${table}<div class="lb-side">${you}${tiles}${teams}${what}</div></div>`;
  },
};

actions['lb-settings'] = async () => {
  let s;
  try { s = (await get('/api/leaderboard')).settings; } catch { return; }
  const radio = (name, v, label, sub, on) => html`<label class="lb-opt"><input type="radio" name="${name}" value="${v}" ${raw(on ? 'checked' : '')}><span><b>${label}</b>${sub ? html`<span>${sub}</span>` : ''}</span></label>`;
  const check = (v, label, on) => html`<label class="chip lb-chip"><input type="checkbox" name="col" value="${v}" ${raw(on ? 'checked' : '')}> ${label}</label>`;
  openModal({
    title: 'What the leaderboard shows', submit: 'Save',
    body: html`<fieldset class="lb-fs"><legend>Rank people by</legend>
        ${radio('rank', 'hours', 'Hours worked', 'Time tracked with the desktop app', s.rank_by === 'hours')}
        ${radio('rank', 'activity', 'Activity', 'Keyboard and mouse use, once someone has worked two hours', s.rank_by === 'activity')}
        ${radio('rank', 'points', 'Points', 'From approved tasks, on-time work, check-ins and boosting back', s.rank_by === 'points')}</fieldset>
      <fieldset class="lb-fs"><legend>Show</legend><div class="chips">${Object.entries(COLS).map(([v, n]) => check(v, n, s.columns.includes(v)))}</div><p class="hint">What it ranks by is always shown.</p></fieldset>
      <fieldset class="lb-fs"><legend>Who can see it</legend>
        ${radio('aud', 'everyone', 'Everyone', 'People are told when it starts showing more about them', s.audience === 'everyone')}
        ${radio('aud', 'managers', 'Managers only', '', s.audience === 'managers')}</fieldset>`,
    onSubmit: async (fd) => {
      const columns = fd.getAll('col');
      if (!columns.length) throw new Error('Choose at least one thing to show');
      await put('/api/leaderboard/settings', { rank_by: fd.get('rank'), columns, audience: fd.get('aud') });
      toast('Leaderboard updated'); S.refresh();
    },
  });
};
