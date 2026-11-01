// Announcements: from the owner and managers to everyone, pinned in the company chat, with who has
// read each one. Everyone sees the list; managers also see who hasn't confirmed and can remind them.
import { html, raw, plural, initials, avColor, relTime } from '../util.js';
import { get, post } from '../api.js';
import { S, actions, toast, errMsg } from '../ui.js';
import { openAnnouncement } from '../v4.js';

const av = (u, size = 32) => html`<span class="cav" style="width:${size}px;height:${size}px;background:${avColor(u.id)};font-size:${Math.round(size * 0.38)}px" title="${u.name}" aria-hidden="true">${initials(u.name)}</span>`;
const when = (iso) => { const d = new Date(iso), t = new Date(); return d.toDateString() === t.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : t - d < 6 * 86400000 ? d.toLocaleDateString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
const mgr = () => S.me.role === 'owner' || S.me.role === 'manager';

export const announcementsPage = {
  title: 'Announcements',
  async load(q) {
    const list = await get('/api/announcements');
    const id = Number(q.get('id')) || (list[0] && list[0].id) || null;
    const one = id ? await get(`/api/announcements/${id}`).catch(() => null) : null;
    return { list, one };
  },
  render({ list, one }) {
    const m = mgr();
    const row = (a) => {
      const pct = a.total ? Math.round((100 * a.read) / a.total) : 0;
      return html`<li data-k="a${a.id}"><a class="an-r${one && one.id === a.id ? ' on' : ''}" href="#/announcements?id=${a.id}" ${one && one.id === a.id ? raw('aria-current="true"') : ''}>
        <span class="an-rt"><b>${a.title}</b><span>${when(a.created_at)}</span></span>
        ${a.confirm ? html`<span class="an-rb"><i><i style="width:${pct}%" class="${pct >= 100 ? 'full' : ''}"></i></i><span>${a.read} of ${a.total} read</span></span>` : html`<span class="an-rb muted small">No confirmation asked</span>`}
        ${!m && a.confirm && !a.confirmed ? html`<span class="an-need">Waiting for your “I’ve read it”</span>` : ''}</a></li>`;
    };
    const past = html`<section class="panel flush"><header><h2>${m ? 'Past announcements' : 'Announcements'}</h2></header>${list.length ? html`<ul class="an-l">${list.map(row)}</ul>` : html`<div class="body"><div class="empty"><b>Nothing announced yet</b>${m ? 'Post one with New announcement. It is pinned in the company chat and reaches every device.' : 'When the owner posts one, it shows here and in the company chat.'}</div></div>`}</section>`;
    let side = '';
    if (one) {
      side = html`<section class="panel an-one"><header><h2>${m ? 'Who has read it' : 'The announcement'}</h2>${one.confirm ? html`<span class="an-pill${one.read >= one.total ? ' full' : ''}">${one.read} of ${one.total}</span>` : ''}</header><div class="body">
        <div class="an-card"><b>${one.title}</b><p>${one.body.length > 220 ? `${one.body.slice(0, 220)}…` : one.body}</p><span>${one.author ? `${one.author.name} · ` : ''}${when(one.created_at)}</span>
          <button type="button" class="linkbtn" data-act="an-open" data-id="${one.id}">Read it all</button></div>
        ${!m && one.confirm ? (one.confirmed ? html`<p class="ac-ok mt">You’ve read it.</p>` : html`<button type="button" class="btn primary mt" data-act="an-ok" data-id="${one.id}">I’ve read it</button>`) : ''}
        ${m && one.readers ? html`<h3 class="an-h">Read and confirmed · ${one.readers.length}</h3>
          ${one.readers.length ? html`<div class="an-faces">${one.readers.slice(0, 12).map((r) => av(r))}${one.readers.length > 12 ? html`<span class="cav more" style="width:32px;height:32px">+${one.readers.length - 12}</span>` : ''}</div>` : html`<p class="muted small">Nobody yet.</p>`}
          ${one.not_yet.length ? html`<div class="an-nh"><h3 class="an-h">Not yet · ${one.not_yet.length}</h3><button type="button" class="btn sm primary" data-act="an-remind" data-id="${one.id}">Remind the ${one.not_yet.length}</button></div>
            <ul class="an-nl">${one.not_yet.map((r) => html`<li data-k="n${r.id}">${av(r)}<span><b>${r.name}</b><span>${r.seen ? 'Saw it, didn’t confirm' : 'Not opened'}${r.last_seen_at ? ` · last online ${relTime(r.last_seen_at)}` : ''}</span></span></li>`)}</ul>` : html`<p class="ac-ok mt">Everyone has read it.</p>`}` : ''}</div></section>`;
    }
    return html`<div class="page-h"><div><h1>Announcements</h1><p class="sub">From the owner to everyone. Pinned in the company chat${m ? ', and you can see who has read each one' : ''}.</p></div>
      ${m ? html`<div class="tools"><button class="btn primary" data-act="ann-new">New announcement</button></div>` : ''}</div>
      <div class="cols an-cols"><div>${past}</div><div>${side}</div></div>`;
  },
};
actions['an-open'] = (el) => openAnnouncement(Number(el.dataset.id));
actions['an-ok'] = async (el) => { el.disabled = true; try { await post(`/api/announcements/${el.dataset.id}/confirm`); toast('Thanks. Marked as read.'); S.refresh(); } catch (e) { el.disabled = false; toast(errMsg(e), true); } };
actions['an-remind'] = async (el) => { el.disabled = true; try { const r = await post(`/api/announcements/${el.dataset.id}/remind`); toast(r.reminded ? `Reminded ${plural(r.reminded, 'person', 'people')}` : 'Already reminded in the last hour'); } catch (e) { toast(errMsg(e), true); } finally { el.disabled = false; } };
