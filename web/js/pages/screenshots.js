import { html, dayLong, plural, todayIn, shiftText } from '../util.js';
import { get, qs } from '../api.js';
import { S, empty, shotGroups, setShots } from '../ui.js';
import { isMgr, loadPeople, dayNav, select, companyToday, myToday } from '../parts.js';

export default {
  title: 'Screenshots',
  async load(q) {
    const day = q.get('day') || (isMgr() ? companyToday() : myToday());
    let who = 'me';
    if (isMgr()) { await loadPeople(); who = q.get('user') || 'all'; }
    const list = await get(`/api/screenshots${qs({ day, user_id: who })}`);
    return { day, who, list };
  },
  render({ day, who, list: raw }) {
    // grouped by person on screen, so the viewer's next/previous follows the same order
    const list = who === 'all' ? [...raw].sort((a, b) => a.user_name.localeCompare(b.user_name) || (a.taken_at < b.taken_at ? -1 : 1)) : raw;
    setShots(list);
    const today = isMgr() ? companyToday() : myToday();
    const all = who === 'all';
    return html`
      <div class="page-h"><div><h1>Screenshots</h1><p class="sub">Work day ${dayLong(day)}${S.settings.shift_start ? ` · shift ${shiftText(S.settings.shift_start, S.settings.shift_end)}` : ''} · ${plural(list.length, 'screenshot')}</p></div>
        <div class="tools">${isMgr() ? select({ q: 'user', value: who, label: 'Person', options: [['all', 'Everyone'], ...S.people.map((p) => [p.id, p.name])] }) : ''}${dayNav(day, today)}</div></div>
      <div class="banner info"><span>${isMgr() ? `By default ${S.settings.shots_per_10 === 0 ? 'screenshots are off' : `${S.settings.shots_per_10 === 1 ? 'one screenshot is' : S.settings.shots_per_10 + ' screenshots are'} taken at random moments in every 10 minutes`} while a timer runs (each team or person can differ). Nothing is captured while paused or idle, and private windows are blacked out on the employee's computer.` : 'These are your screenshots. Only you and your managers can see them, and you can delete any of them. Nothing is captured while your timer is paused or stopped.'}</span></div>
      ${list.length ? (all ? shotGroups(list, { byPerson: true, day }) : html`<section class="panel"><div class="body">${shotGroups(list, { day })}</div></section>`) : html`<section class="panel">${empty('No screenshots for this day', 'They appear here within a minute of being taken.')}</section>`}`;
  },
};
