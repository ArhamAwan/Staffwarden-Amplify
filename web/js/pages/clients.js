// The team's side of the client portal: the Clients page (who can sign in, what they see) and the
// Client tab on a project (the chat with them, what is waiting on them, their requests, the weekly
// update and milestones).
import { html, raw, esc, icon, plural, relTime, dayShort, initials, avColor, ICON } from '../util.js';
import { get, post, patch, put, del, fileBase64, fileUrl, liveFresh } from '../api.js';
import { S, actions, empty, toast, errMsg, openModal, confirmBox, qAttr } from '../ui.js';
import { isMgr, zoneOptions, readZone } from '../parts.js';
import { mountChat } from '../chat.js';

const SETTINGS = [
  ['tasks', 'Tasks', [['all', 'All tasks'], ['shared', 'Only shared tasks']], 'All: every task except ones marked team only. Shared: only tasks you mark as shared.'],
  ['people', 'Who is on each task', null, 'Names and roles of the people working on their tasks'],
  ['files', 'Files on tasks', null, 'Files attached to the tasks they can see'],
  ['on_it_now', '“On it now”', null, 'While someone’s timer runs on their project. The team is told when you turn this on.'],
  ['hours', 'Hours', [['off', 'Not shared'], ['total', 'Total only'], ['person', 'By person'], ['task', 'By person and task']]],
  ['messages', 'Group chat with the team', null, 'Everyone on the project, in one chat'],
  ['direct', 'Direct messages', null, 'One person at the client with one person on the team'],
  ['requests', 'Requests', null, 'They can ask for changes or new work'],
  ['approvals', 'Approvals and files', null, 'The team can ask them to approve things or send files'],
  ['presence', 'Online dots', null, 'A green dot by your team’s names while they have Staffwarden open. Never when or how long anyone works.'],
];
const NEVER = 'Screenshots, activity and apps, attendance and time off, pay and HR, other clients and team-only notes are never shared.';
const cav = (p, size = 30) => html`<span class="avatar${size < 30 ? ' sm' : ''}" style="background:${avColor(1000 + p.id)};${size !== 30 ? `width:${size}px;height:${size}px` : ''}" aria-hidden="true">${initials(p.name)}</span>`;
const marks = (n) => String(n || '?').split(/\s+/).filter((w) => /^[\p{L}\d]/u.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const short = (n) => { const s = String(n || '').replace(/\s+(Realty|Inc\.?|LLC|Ltd\.?|Limited|Group|Company|Co\.?)$/i, ''); return s.length > 18 ? s.split(' ')[0] : s; };

// ================= the Clients page =================
export const clientsPage = {
  title: 'Clients',
  async load(q) {
    const id = Number(q.get('id'));
    const [list, projects, health, inbox] = await Promise.all([get('/api/clients?all=1'), get('/api/projects'), id ? null : get('/api/client-health').catch(() => ({})), id ? null : get('/api/client-inbox').catch(() => null)]);
    return { list, projects, health, inbox, one: id ? await get(`/api/clients/${id}`) : null };
  },
  render({ list, projects, one, health, inbox }) {
    if (one) return clientPage(one, projects);
    const active = list.filter((c) => !c.archived);
    if (active.length && health && Object.keys(health).length) return healthPage(list, health, inbox);
    return html`<div class="page-h"><div><h1>Clients</h1><p class="sub">${active.length ? `${plural(active.length, 'client')}. Give people at a client a sign-in, and they follow their projects in the client portal.` : 'Give your clients a sign-in to follow their projects.'}</p></div>
      <div class="tools"><button class="btn primary" data-act="client-new">${raw('+')} New client</button></div></div>
      ${list.length ? html`<div class="clist">${list.map((c) => html`<a class="panel cl-card" href="#/clients?id=${c.id}" data-k="c${c.id}"><div class="cl-top"><span class="cl-mark" aria-hidden="true">${marks(c.name)}</span><div><h2>${c.name}</h2><span class="muted small">${[c.city, c.retainer_hours ? `${c.retainer_hours}h a month` : ''].filter(Boolean).join(' · ') || 'No details yet'}</span></div>${c.archived ? html`<span class="tag off"><i></i>Archived</span>` : ''}</div>
        <div class="cl-stats"><span><b class="num">${c.projects.length}</b> ${c.projects.length === 1 ? 'project' : 'projects'}</span><span><b class="num">${c.people_count}</b> can sign in</span></div>
        <div class="cl-proj">${c.projects.map((p) => html`<span class="pkey" style="background:${p.color}">${p.key}</span>`)}${c.projects.length ? html`<span class="muted small">${c.projects.map((p) => p.name).join(', ')}</span>` : html`<span class="faint small">No project linked yet</span>`}</div></a>`)}</div>`
        : html`<section class="panel">${empty('No clients yet', html`Add a client, link their project and invite the people there. They see progress, tasks and the team, and can chat, approve and request work.<div class="mt"><button class="btn primary" data-act="client-new">${raw('+')} Add the first client</button></div>`)}</section>`}
      <p class="small muted cl-never">${icon('lock')} ${NEVER}</p>`;
  },
};

// the Clients page as a table of how each client is doing, worst first
function healthPage(list, health, inbox) {
  const RANK = { risk: 0, watch: 1, good: 2 };
  const HL = { risk: 'At risk', watch: 'Watch', good: 'Good' };
  const rows = list.filter((c) => !c.archived && health[c.id]).sort((a, b) => RANK[health[a.id].health] - RANK[health[b.id].health] || health[b.id].oldest_min - health[a.id].oldest_min);
  const archived = list.filter((c) => c.archived);
  const lead = (c) => { const p = c.projects.find((x) => x.lead_name); return p ? p.lead_name.split(' ')[0] : null; };
  const tr = (c) => { const h = health[c.id]; return html`<tr data-act="go-client" data-id="${c.id}" data-k="c${c.id}"><td><span class="clh-n"><span class="cmark" style="width:36px;height:36px;font-size:13px;background:${avColor(1000 + c.id)}" aria-hidden="true">${marks(c.name)}</span><span><a href="#/clients?id=${c.id}"><b>${c.name}</b></a><span>${c.people_count ? plural(c.people_count, 'person', 'people') : 'Nobody invited'}${lead(c) ? ` · led by ${lead(c)}` : ''}</span></span></span></td>
    <td><span class="hpill ${h.health}"><i></i>${HL[h.health]}</span>${h.reasons.length ? html`<span class="clh-why">${h.reasons.join('. ')}</span>` : html`<span class="clh-why">Answered on time, signed in recently</span>`}</td>
    <td>${h.last_seen_at ? html`${relTime(h.last_seen_at)}${h.last_seen_by ? html`<span class="clh-why">${h.last_seen_by.split(' ')[0]}</span>` : ''}` : html`<span class="muted">Not yet</span>`}</td>
    <td>${h.waiting ? html`<span class="waitc ${h.level}">${icon('clock')}${h.waiting}, oldest ${waitText(h.oldest_min)}</span>` : html`<span class="muted">Nothing</span>`}</td>
    <td>${h.retainer_pct == null ? html`<span class="muted">No retainer</span>` : html`<b>${h.retainer_pct}%</b><span class="clh-bar"><i class="${h.retainer_pct >= 95 ? 'late' : h.retainer_pct >= 80 ? 'warn' : ''}" style="width:${Math.min(100, h.retainer_pct)}%"></i></span>`}</td>
    <td>${h.rating == null ? html`<span class="muted">None yet</span>` : html`<b class="stars">★ ${h.rating}</b><span class="clh-why">${plural(h.ratings, 'rating')}</span>`}</td></tr>`; };
  return html`<div class="page-h"><div><h1>Clients</h1><p class="sub">${plural(rows.length, 'client')} · ${plural(rows.reduce((n, c) => n + c.projects.length, 0), 'project')} · everyone who can sign in to a portal</p></div>
      <div class="tools"><a class="btn" href="#/inbox">${icon('chat')} Client inbox</a><button class="btn primary" data-act="client-new">${raw('+')} Add a client</button></div></div>
    ${clientBento(rows, health, inbox)}
    <section class="panel"><header><h2>All clients</h2><span class="muted small">Worst first</span></header><div class="body" style="overflow-x:auto"><table class="clh-t"><thead><tr><th>Client</th><th>Health</th><th>Last signed in</th><th>Waiting on us</th><th>Retainer this month</th><th>Milestone ratings</th></tr></thead><tbody>${rows.map(tr)}</tbody></table></div>
      <details class="clh-how"><summary>${icon('help')}How health is worked out</summary><div class="clh-how-b"><ul class="pdots">${['More than one reply waiting over 4 hours, or one over a day', 'Nobody has signed in for 10 days or more'].map((x) => html`<li class="late">${x}</li>`)}${['A reply past 4 hours', 'The last milestone rated 3 stars or less', 'Retainer past 95% with days left'].map((x) => html`<li class="warn">${x}</li>`)}</ul><p class="muted small">Red points make a client <b>At risk</b>, amber ones <b>Watch</b>. Only owners and managers see this. Clients never do.</p></div></details>
      ${archived.length ? html`<p class="clh-arch small muted">Archived: ${archived.map((c, i) => html`${i ? ', ' : ''}<a href="#/clients?id=${c.id}">${c.name}</a>`)}</p>` : ''}</section>
    <p class="small muted cl-never">${icon('lock')} ${NEVER}</p>`;
}
// four tiles over the table: what is waiting on us, how they rate us, who looked in, the retainers
function clientBento(rows, health, inbox) {
  const items = (inbox && inbox.items) || [], late = items.filter((i) => i.level === 'late').length;
  const rated = rows.filter((c) => health[c.id].rating != null), nRatings = rated.reduce((n, c) => n + health[c.id].ratings, 0);
  const avg = nRatings ? Math.round((rated.reduce((n, c) => n + health[c.id].rating * health[c.id].ratings, 0) / nRatings) * 10) / 10 : null;
  const seen = rows.flatMap((c) => (health[c.id].seen_week || []).map((p) => ({ ...p, client: c.name })));
  const ret = rows.filter((c) => health[c.id].retainer_hours);
  const used = ret.reduce((n, c) => n + health[c.id].month_secs, 0), of = ret.reduce((n, c) => n + health[c.id].retainer_hours * 3600, 0);
  const daysLeft = ret.length ? health[ret[0].id].days_left : null;
  const h = (secs) => `${Math.round(secs / 3600)}h`;
  return html`<section class="kpis bento cl-bento" aria-label="Clients at a glance">
    <div class="kpi bt-wt"><div class="l">${icon('chat')}Waiting on us${late ? html`<span class="bt-chip late">${late} past 4 hours</span>` : ''}</div>
      ${items.length ? html`<ul class="bt-list">${items.slice(0, 5).map((i) => html`<li><i class="d-${i.level}"></i><a href="#/inbox"><b>${i.client}</b>: ${i.text}</a><span class="num">${waitText(i.waited_min)}</span></li>`)}</ul>${items.length > 5 ? html`<a class="bt-foot" href="#/inbox">${items.length - 5} more in the client inbox</a>` : ''}`
        : html`<div class="bt-noshot">${icon('check')}<span>Nothing is waiting on the team. Every client message, request and change has an answer.</span></div>`}
      ${inbox && inbox.summary ? html`<div class="f bt-sum">${inbox.summary.typical_reply_min != null ? html`Typical reply this week <b>${waitText(inbox.summary.typical_reply_min)}</b> · ` : ''}<b>${inbox.summary.answered_today}</b> ${inbox.summary.answered_today === 1 ? 'reply' : 'replies'} to clients in the last day</div>` : ''}</div>
    <div class="kpi bt-rt"><div class="l">${icon('trophy')}Average rating</div>${avg == null ? html`<div class="v">–</div><div class="f">No milestone rated yet</div>` : html`<div class="bt-row"><div class="v">${avg}</div><span class="bt-stars" aria-label="${avg} out of 5">${[1, 2, 3, 4, 5].map((n) => html`<i class="${n <= Math.round(avg) ? 'on' : ''}">★</i>`)}</span></div><div class="f">From ${plural(nRatings, 'milestone rating')}</div>`}</div>
    <div class="kpi bt-sg"><div class="l">${icon('users')}Signed in this week</div>${seen.length ? html`<span class="stack bt-faces">${seen.slice(0, 6).map((p) => html`<span class="avatar sm" style="background:${avColor(2000 + p.id)}" title="${p.name}, ${p.client}">${initials(p.name)}</span>`)}${seen.length > 6 ? html`<span class="avatar sm more">+${seen.length - 6}</span>` : ''}</span>` : html`<div class="v">0</div>`}
      <div class="f">${seen.length ? `${plural(seen.length, 'person', 'people')} across ${plural(new Set(seen.map((p) => p.client)).size, 'client')}` : 'Nobody at a client has looked in'}</div></div>
    <div class="kpi bt-rn"><div class="l">${icon('clock')}Retainers this month${of && ret.length > 1 ? html`<span class="bt-r">${h(used)} of ${h(of)}</span>` : ''}</div>
      ${ret.length ? html`<div class="bt-row"><div class="v">${Math.round((100 * used) / of)}%</div><span class="bt-say">of the month's retainer hours used, ${h(Math.max(0, of - used))} left</span></div><ul class="bt-ret">${ret.slice(0, 4).map((c) => { const x = health[c.id], pct = Math.round((100 * x.month_secs) / (x.retainer_hours * 3600)); return html`<li><span><b>${c.name}</b><span class="num">${h(x.month_secs)} of ${x.retainer_hours}h</span></span><span class="clh-bar"><i class="${pct >= 95 ? 'late' : pct >= 80 ? 'warn' : ''}" style="width:${Math.min(100, pct)}%"></i></span></li>`; })}</ul>
        <div class="f">${daysLeft != null ? `${plural(daysLeft, 'day')} left this month` : ''}</div>`
        : html`<div class="bt-noshot">${icon('clock')}<span>No client has a monthly retainer. Set one in a client's details to see the hours used here.</span></div>`}</div>
  </section>`;
}
actions['go-client'] = (el, e) => { if (e.target.closest('a')) return; S.navigate(`#/clients?id=${el.dataset.id}`); };

function clientPage(c, projects) {
  const s = c.settings;
  const linked = new Set(c.projects.map((p) => p.id));
  const free = projects.filter((p) => !linked.has(p.id) && !p.archived && !p.client_id);
  const switchRow = ([k, label, choices, hint]) => html`<div class="cs-row" data-k="s${k}"><div><b>${label}</b>${hint ? html`<span>${hint}</span>` : ''}</div>
    ${choices ? html`<select data-cset="${k}" aria-label="${label}">${choices.map(([v, t]) => html`<option value="${v}" ${s[k] === v ? raw('selected') : ''}>${t}</option>`)}</select>`
      : html`<label class="switch"><input type="checkbox" data-cset="${k}" ${s[k] ? raw('checked') : ''} aria-label="${label}"><span></span></label>`}</div>`;
  return html`<div class="page-h"><a class="crumb" href="#/clients">${icon('left')}Clients</a><div><h1>${c.name}${c.archived ? html` <span class="tag off"><i></i>Archived</span>` : ''}</h1><p class="sub">${[c.city, c.tz_name ? `Their time: ${c.tz_name.split('/').pop().replace(/_/g, ' ')}` : '', c.retainer_hours ? `${c.retainer_hours}-hour monthly retainer` : 'No retainer'].filter(Boolean).join(' · ')}</p></div>
    <div class="tools"><button class="btn" data-act="client-edit" data-id="${c.id}">${icon('gear')} Details</button><button class="btn primary" data-act="client-invite" data-id="${c.id}">${raw('+')} Invite someone</button></div></div>
    <div class="cols"><div>
      <section class="panel flush"><header><h2>People who can sign in</h2><span class="muted small">They sign in at this same address with their email</span></header>
        ${c.people.length ? html`<ul class="cl-people">${c.people.map((p) => html`<li data-k="u${p.id}" class="${p.active ? '' : 'off'}">${cav(p)}<div><b>${p.name}</b><span>${p.email}${p.title ? ` · ${p.title}` : ''}</span><span class="faint">${!p.active ? 'Turned off' : p.last_seen_at ? `Last here ${relTime(p.last_seen_at)}` : p.joined_at ? `Joined ${relTime(p.joined_at)}` : 'Hasn’t signed in yet'}</span></div>
          <label class="check small"><input type="checkbox" data-cperson="can_approve" data-id="${p.id}" ${p.can_approve ? raw('checked') : ''} ${p.active ? '' : raw('disabled')}><span>Can approve</span></label>
          <div class="cl-pa"><button class="linkbtn" data-act="client-reset" data-id="${p.id}" data-name="${p.name}">New password</button><button class="linkbtn ${p.active ? 'danger-ink' : ''}" data-act="client-active" data-id="${p.id}" data-on="${p.active ? '' : '1'}" data-name="${p.name}">${p.active ? 'Turn off' : 'Turn on'}</button></div></li>`)}</ul>`
          : html`<div class="body">${empty('Nobody can sign in yet', html`Invite the people you work with there. They get a password to sign in with, which you pass on.<div class="mt"><button class="btn primary sm" data-act="client-invite" data-id="${c.id}">${raw('+')} Invite someone</button></div>`)}</div>`}</section>
      <section class="panel flush"><header><h2>Projects</h2>${free.length ? html`<label class="sr" for="cl-add">Link a project</label><select id="cl-add" data-clink="${c.id}" style="width:auto"><option value="">Link a project…</option>${free.map((p) => html`<option value="${p.id}">${p.key} · ${p.name}</option>`)}</select>` : ''}</header>
        ${c.projects.length ? html`<ul class="cl-projl">${c.projects.map((p) => html`<li data-k="p${p.id}"><span class="pkey" style="background:${p.color}">${p.key}</span><a href="#/project?id=${p.id}&tab=client"><b>${p.name}</b></a><span class="muted small">${p.lead_name ? `Led by ${p.lead_name}` : 'No lead'}</span><button class="linkbtn danger-ink" data-act="client-unlink" data-id="${c.id}" data-pid="${p.id}" data-name="${p.name}">Unlink</button></li>`)}</ul>`
          : html`<div class="body">${empty('No project linked', free.length ? 'Link the project you do for them. They only ever see linked projects.' : 'Create a project first, then link it here.')}</div>`}</section>
    </div><div>
      <section class="panel"><header><h2>What ${short(c.name)} sees</h2></header><div class="body"><div class="cs-list">${SETTINGS.map(switchRow)}</div>
        <p class="cl-never small">${icon('lock')} ${NEVER}</p></div></section>
      <section class="panel"><div class="body"><button class="btn ${c.archived ? '' : 'danger'} sm" data-act="client-archive" data-id="${c.id}" data-on="${c.archived ? '' : '1'}">${c.archived ? 'Bring back' : 'Archive this client'}</button><p class="hint">${c.archived ? 'Their people can sign in again.' : 'Nobody at the client can sign in while it is archived. Nothing is deleted.'}</p></div></section>
    </div></div>`;
}

function clientForm(c) {
  return html`<div class="field"><label class="f" for="cn">Name</label><input id="cn" name="name" required maxlength="100" value="${c ? c.name : ''}" placeholder="Harbor & Pine Realty"></div>
    <div class="grid2"><div class="field"><label class="f" for="cc">City <span class="muted">(optional)</span></label><input id="cc" name="city" maxlength="100" value="${(c && c.city) || ''}"></div>
      <div class="field"><label class="f" for="cr">Monthly retainer <span class="muted">(hours, optional)</span></label><input id="cr" name="retainer_hours" type="number" min="1" max="2000" value="${(c && c.retainer_hours) || ''}"></div></div>
    <div class="field"><label class="f" for="ctz">Their time zone</label><select id="ctz" name="tz">${zoneOptions(c && c.tz_name, { inherit: 'Not set' })}</select><p class="hint">So the team sees what time it is for them.</p></div>`;
}
const readClient = (fd) => { const z = readZone(fd.get('tz')); return { name: String(fd.get('name') || '').trim(), city: fd.get('city'), retainer_hours: fd.get('retainer_hours') || null, tz_name: z ? z.tz_name : undefined }; };
actions['client-new'] = () => openModal({ title: 'New client', submit: 'Add client', body: clientForm(null), onSubmit: async (fd) => { const c = await post('/api/clients', readClient(fd)); toast('Client added'); S.navigate(`#/clients?id=${c.id}`); } });
actions['client-edit'] = async (el) => { const c = await get(`/api/clients/${el.dataset.id}`); openModal({ title: `${c.name}: details`, body: clientForm(c), onSubmit: async (fd) => { await patch(`/api/clients/${c.id}`, readClient(fd)); toast('Saved'); S.refresh(); } }); };
function showPassword(name, email, password, again = false) {
  openModal({ title: again ? `New password for ${name}` : `${name} can sign in now`, footer: false,
    body: html`<p>Pass these on to ${name.split(' ')[0]}. The password is shown only now${again ? '; the old one no longer works' : ''}.</p>
      <dl class="cl-cred"><dt>Address</dt><dd>${location.origin}</dd><dt>Email</dt><dd>${email}</dd><dt>Password</dt><dd><code>${password}</code></dd></dl>
      <div class="cl-cred-a"><button type="button" class="btn primary" data-copy="${location.origin}\nEmail: ${email}\nPassword: ${password}">${icon('repeat')} Copy all three</button><button type="button" class="btn" data-close>Done</button></div>` });
  setTimeout(() => { const b = document.querySelector('[data-copy]'); if (b) b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { toast('Copy it by hand: your browser blocked copying', true); } }); }, 30);
}
actions['client-invite'] = (el) => openModal({
  title: 'Invite someone', sub: 'They get a sign-in for the client portal. You pass the password on.', submit: 'Create the sign-in',
  body: html`<div class="field"><label class="f" for="ivn">Name</label><input id="ivn" name="name" required maxlength="100"></div>
    <div class="field"><label class="f" for="ive">Email</label><input id="ive" name="email" type="email" required maxlength="200"></div>
    <div class="field"><label class="f" for="ivt">Role <span class="muted">(optional)</span></label><input id="ivt" name="title" maxlength="100" placeholder="Marketing director"></div>
    <label class="check"><input type="checkbox" name="can_approve" value="1"><span>Can approve things for their company<br><span class="hint">Others can see approvals and comment, but not sign off</span></span></label>`,
  onSubmit: async (fd) => { const r = await post(`/api/clients/${el.dataset.id}/people`, { name: fd.get('name'), email: fd.get('email'), title: fd.get('title'), can_approve: fd.get('can_approve') === '1' }); S.refresh(); setTimeout(() => showPassword(r.person.name, r.person.email, r.password), 200); },
});
actions['client-reset'] = async (el) => {
  if (!(await confirmBox({ title: `New password for ${el.dataset.name}?`, message: 'Their old password stops working and they are signed out everywhere.', confirm: 'Make a new password' }))) return;
  try { const r = await patch(`/api/client-people/${el.dataset.id}`, { reset_password: true }); showPassword(r.person.name, r.person.email, r.password, true); } catch (e) { toast(errMsg(e), true); }
};
actions['client-active'] = async (el) => {
  const on = !!el.dataset.on;
  if (!on && !(await confirmBox({ title: `Turn off ${el.dataset.name}?`, message: 'They are signed out and can’t sign in until you turn them back on. Their messages stay.', confirm: 'Turn off', danger: true }))) return;
  try { await patch(`/api/client-people/${el.dataset.id}`, { active: on }); toast(on ? 'Turned on' : 'Turned off'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
actions['client-unlink'] = async (el) => {
  if (!(await confirmBox({ title: `Unlink ${el.dataset.name}?`, message: 'The client no longer sees this project. The chat and approvals are kept, in case you link it again.', confirm: 'Unlink', danger: true }))) return;
  try { await put(`/api/clients/${el.dataset.id}/projects/${el.dataset.pid}`, { on: false }); toast('Unlinked'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
actions['client-archive'] = async (el) => {
  const on = !!el.dataset.on;
  if (on && !(await confirmBox({ title: 'Archive this client?', message: 'Nobody there can sign in until you bring them back. Nothing is deleted.', confirm: 'Archive', danger: true }))) return;
  try { await patch(`/api/clients/${el.dataset.id}`, { archived: on }); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
// linking a project that holds another client's chat and sign-offs asks before starting it fresh
async function linkProject(cid, pid, done) {
  try { await put(`/api/clients/${cid}/projects/${pid}`, { on: true }); }
  catch (e) {
    if (e.status !== 409 || !/Start fresh/.test(e.message)) throw e;
    if (!(await confirmBox({ title: 'Start this project fresh?', message: e.message, confirm: 'Start fresh', danger: true }))) { S.refresh(); return; }
    await put(`/api/clients/${cid}/projects/${pid}`, { on: true, fresh: true });
  }
  toast(done); S.refresh();
}
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.matches('[data-cset]')) {
    const id = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('id'));
    const v = t.type === 'checkbox' ? t.checked : t.value;
    try { await patch(`/api/clients/${id}`, { settings: { [t.dataset.cset]: v } }); toast(t.dataset.cset === 'on_it_now' && v ? 'Saved. The team has been told.' : 'Saved'); S.refresh(); } catch (err) { toast(errMsg(err), true); }
  } else if (t.matches('[data-cperson]')) {
    try { await patch(`/api/client-people/${t.dataset.id}`, { [t.dataset.cperson]: t.checked }); toast('Saved'); } catch (err) { toast(errMsg(err), true); }
  } else if (t.matches('[data-clink]') && t.value) {
    try { await linkProject(t.dataset.clink, t.value, 'Linked. They can see it now.'); } catch (err) { toast(errMsg(err), true); }
  }
});

// ================= the Client tab on a project =================
export async function loadClientTab(p, q) {
  if (!p.client_id) return { none: true, clients: isMgr() ? await get('/api/clients') : [] };
  // everything at once, so the tab opens in one round trip
  const opt = (u) => get(u).catch(() => null);
  const [pj, threads, approvals, requests, draft, meet, sched, inbox, presence, ret] = await Promise.all([get(`/api/portal/projects/${p.id}`), get(`/api/chat/projects/${p.id}/threads`), get(`/api/portal/projects/${p.id}/approvals`), get(`/api/portal/projects/${p.id}/requests`),
    p.can_manage ? get(`/api/portal/projects/${p.id}/update-draft`) : null, opt(`/api/portal/projects/${p.id}/meetings`), p.can_manage ? opt(`/api/portal/projects/${p.id}/update-schedule`) : null,
    opt(`/api/client-inbox?project=${p.id}`), opt(`/api/chat/projects/${p.id}/presence`), opt(`/api/portal/projects/${p.id}/retainer`)]);
  const withMsgs = requests.filter((r) => r.messages);
  const threadsR = await Promise.all(withMsgs.map((r) => get(`/api/portal/requests/${r.id}/messages`).catch(() => [])));
  const rmsgs = new Map(withMsgs.map((r, i) => [r.id, threadsR[i]]));
  const ct = Number(q.get('ct')) || null;
  return { pj, threads, approvals, requests, draft, meet, sched, inbox, presence, ret, rmsgs, ct, cv: q.get('cv') || '', ci: q.get('ci') || '' };
}
const AP = { waiting: ['late', 'Waiting on them'], changes: ['absent', 'Changes asked'], approved: ['present', 'Approved'], received: ['present', 'Received'] };
const REQ = { new: ['late', 'New'], planned: ['present', 'Taken on'], done: ['present', 'Done'], declined: ['off', 'Not doing'], cancelled: ['off', 'Cancelled'] };
const waitText = (m) => (m < 60 ? `${Math.max(1, m)}m` : m < 1440 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${Math.floor(m / 1440)}d`);
export const waitChip = (it) => html`<span class="waitc ${it.level}" title="Waiting ${waitText(it.waited_min)}">${icon('clock')}${waitText(it.waited_min)}</span>`;
const KIND = { msg: 'Message', req: 'Request', ok: 'Changes asked', cmt: 'Task comment' };
ICON.req = ICON.req || '<path d="M5 4.5h14v11H9.5L5 19.5z"/><path d="M12 7.5v5M9.5 10h5"/>';
ICON.cmt = ICON.cmt || '<path d="M6 4v9a3 3 0 0 0 3 3h10"/><path d="M15 12l4 4-4 4"/>';
ICON.okc = ICON.okc || '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.3l2.4 2.4 4.6-5"/>';
const GLY = { msg: 'chat', req: 'req', ok: 'okc', cmt: 'cmt' };
// a message in the middle pane (the queue item, its thread, our replies)
const pbub = (who, body, at, me, note) => html`<div class="pb ${me ? 'me' : ''}${note ? ' note' : ''}">${me ? '' : who ? cav(who, 28) : ''}<div><b>${me ? 'You' : who ? who.name : ''}</b><p>${body}</p>${at ? html`<span>${relTime(at)}</span>` : ''}</div></div>`;
// the middle of the Client tab when a request, a comment or an asked-for change is picked
function pickedPane(it, { pj, requests, approvals, rmsgs, cs, ret }) {
  const from = it.from ? { id: it.from.id || 0, name: it.from.name } : null;
  const head = (title, sub) => html`<header class="pp-h"><div class="pp-k"><span class="gly ${it.kind}">${icon(GLY[it.kind])}</span><b class="${it.kind}">${KIND[it.kind]}</b><span>${sub}</span>${it.answered ? html`<span class="waitc ok">${icon('check')}Answered</span>` : waitChip(it)}</div><h2>${title}</h2></header>`;
  const who = `${it.from ? `from ${it.from.name}` : ''}${it.answered ? '' : `${it.from ? ' · ' : ''}${it.owner ? `${it.owner.name.split(' ')[0]} to answer` : 'nobody on it yet'}`}`;
  if (it.kind === 'req') {
    const r = requests.find((x) => x.id === it.request_id);
    if (!r) return html`<div class="pp">${head(it.text, who)}<div class="pp-b"><p class="muted">This request was answered a moment ago.</p></div></div>`;
    const est = r.estimate;
    const st = r.status;
    const steps = [['Asked', true, false], ['Estimate', st !== 'new' || (est && est.answer), st === 'new' && !(est && est.answer)], ['Taken on', st === 'done', st === 'planned'], ['Done', st === 'done', false]];
    const m = rmsgs.get(r.id) || [];
    const left = ret && ret.retainer_hours ? Math.max(0, Math.round((ret.retainer_hours - ret.used_hours) * 10) / 10) : null;
    return html`<div class="pp">${head(r.title, who)}
      <ol class="pp-steps">${steps.map(([t, done, on], i) => html`<li class="${on ? 'on' : done ? 'done' : ''}"><i>${done && !on ? icon('check') : i + 1}</i>${t}</li>`)}</ol>
      <div class="pp-b">${pbub(from, r.detail || r.title, r.created_at, false)}${m.map((x) => pbub(x.mine ? null : { id: x.author.kind === 'client' ? x.author.id : x.author.id - 1000, name: x.author.name }, x.body, x.created_at, x.mine))}
        ${est ? html`<p class="pp-note ${est.answer === 'yes' ? 'ok' : ''}"><b>${est.answer === 'yes' ? `${String(r.by || 'They').split(' ')[0]} said go ahead` : est.answer === 'no' ? 'They said not now' : 'Estimate sent, waiting for their answer'}</b><br>About ${est.hours} h${est.note ? `. ${est.note.replace(/[.\s]+$/, '')}.` : '.'}</p>` : ''}
        ${r.file ? html`<button class="linkbtn small" data-act="client-file" data-url="${r.file.url}">${icon('clip')}${r.file.name}</button>` : ''}</div>
      <div class="pp-f">${['new', 'planned'].includes(st) ? html`<form class="pp-reply" data-submit="client-rmsg" data-id="${r.id}"><input name="body" maxlength="2000" placeholder="Reply to ${String(r.by || cs).split(' ')[0]} about this" aria-label="Reply about this request" required><button class="btn" type="submit">${icon('chat')} Reply</button></form>` : ''}
        ${st === 'new' && pj.manage ? html`<div class="pp-acts">${!est || est.answer ? html`<button class="btn primary" data-act="client-est" data-id="${r.id}" data-title="${r.title}">${icon('clock')} Send an estimate</button>` : ''}<button class="btn ${est && !est.answer ? 'primary' : ''}" data-act="client-req" data-id="${r.id}" data-s="planned" data-title="${r.title}">${icon('check')} Take it on</button><button class="btn quiet" data-act="client-req" data-id="${r.id}" data-s="declined" data-title="${r.title}">Not doing</button>${left != null ? html`<span class="pp-left">${left} h left this month</span>` : ''}</div>`
          : st === 'planned' && pj.manage ? html`<div class="pp-acts"><button class="btn" data-act="client-req" data-id="${r.id}" data-s="done" data-title="${r.title}">${icon('check')} Mark done</button>${r.task ? html`<a class="btn quiet" href="#/tasks?task=${r.task.id}">${icon('tasks')} ${r.task.ref}</a>` : ''}</div>`
            : !pj.manage ? html`<p class="muted small">The project lead or a manager answers requests.</p>` : ''}</div></div>`;
  }
  if (it.kind === 'ok') {
    const a = approvals.find((x) => x.id === it.approval_id);
    const v = a && a.versions[a.versions.length - 1];
    const pins = v && v.pins ? v.pins.filter((x) => !x.resolved) : [];
    return html`<div class="pp">${head(it.text, who)}<div class="pp-b">${pbub(from, v && v.decision_note ? `“${v.decision_note}”` : 'Asked for changes.', it.since, false)}
        ${pins.length ? html`<ol class="pp-pins">${pins.map((x) => html`<li><i>${x.n}</i>${x.body}</li>`)}</ol>` : ''}</div>
      <div class="pp-f"><div class="pp-acts">${a ? html`<button class="btn primary" data-act="client-version" data-id="${a.id}" data-n="${(v ? v.n : 0) + 1}" data-title="${a.title}">${icon('up')} Send version ${(v ? v.n : 0) + 1}</button>` : ''}<button class="btn quiet" data-act="q" ${raw(qAttr('cv', 'approvals'))}>All approvals</button></div></div></div>`;
  }
  // a comment on a task the client can see: the task is the title, the comment is the message
  const said = it.task && it.text.startsWith(`On “${it.task}”: `) ? it.text.slice(`On “${it.task}”: `.length) : it.text;
  return html`<div class="pp">${head(it.task || it.text, who)}<div class="pp-b">${pbub(from, it.detail || said, it.since, false)}</div>
    <div class="pp-f"><form class="pp-reply" data-submit="ibx-reply" data-kind="cmt" data-id="${it.task_id}"><input name="body" maxlength="4000" placeholder="Answer on the task" aria-label="Your comment" required><button class="btn primary" type="submit">${icon('chat')} Comment</button></form>
      <div class="pp-acts"><a class="btn quiet" href="#/tasks?task=${it.task_id}">${icon('tasks')} Open the task</a><span class="pp-left">${cs} sees your name and “Amplify” on the task.</span></div></div></div>`;
}
const tz = (c) => (c && c.tz_name) || undefined;
const when = (iso, c, o) => new Date(iso).toLocaleString('en-US', { timeZone: tz(c), ...o });
const stars = (n) => `${'★'.repeat(Math.round(n))}${'☆'.repeat(5 - Math.round(n))}`;
export function clientTab(p, d) {
  if (d.none) {
    return html`<section class="panel"><div class="body">${empty(`Not shared with a client`, isMgr() ? html`Link this project to a client and invite people there: they follow progress, chat with the team, approve work and send requests.<div class="mt cl-linkrow">${d.clients.length ? html`<label class="sr" for="cl-pick">Client</label><select id="cl-pick" data-plink="${p.id}" style="width:auto"><option value="">Share with…</option>${d.clients.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>` : ''}<a class="btn ${d.clients.length ? '' : 'primary'}" href="#/clients">${d.clients.length ? 'Manage clients' : html`${raw('+')} Add a client`}</a></div>` : 'A manager can share this project with a client from the Clients page.')}</div></section>`;
  }
  const { pj, threads, approvals, requests, draft, meet, sched, inbox, presence, ret, rmsgs } = d;
  const c = pj.client, cs = short(c.name), s = pj.settings;
  const group = threads.find((t) => t.kind === 'group');
  const cur = threads.find((t) => t.id === d.ct) || group;
  const clientPeople = (group && group.members ? group.members.filter((m) => m.kind === 'client') : []);
  const needs = inbox ? inbox.items : [];
  const oldest = needs.length ? needs.reduce((a, b) => (a.waited_min > b.waited_min ? a : b)) : null;
  const waitingThem = approvals.filter((a) => a.status === 'waiting');
  const ratings = pj.ratings || [];
  const avg = ratings.length ? Math.round((ratings.reduce((n, r) => n + r.stars, 0) / ratings.length) * 10) / 10 : null;
  const seen = presence && presence.clients ? presence.clients.filter((x) => x.last_seen_at).sort((a, b) => (a.last_seen_at < b.last_seen_at ? 1 : -1))[0] : null;
  const seenName = seen ? (clientPeople.find((m) => m.id === seen.id) || {}).name : null;
  const firstPerson = clientPeople[0];
  const unread = threads.reduce((n, t) => n + (t.unread || 0), 0);
  const view = ['requests', 'approvals', 'plan', 'access'].includes(d.cv) ? d.cv : '';
  let picked = d.ci ? needs.find((x) => x.key === d.ci && x.kind !== 'msg') : null;
  // a request that was just answered leaves the queue but stays open in the middle
  if (!picked && /^r\d+$/.test(d.ci || '')) { const r = requests.find((x) => x.id === Number(d.ci.slice(1))); if (r) picked = { kind: 'req', key: d.ci, request_id: r.id, text: r.title, from: r.by ? { id: r.client_user_id || 0, name: r.by } : null, owner: null, answered: true }; }
  const retPct = ret && ret.retainer_hours ? ret.used_hours / ret.retainer_hours : null;
  const tone = (x) => (x >= 0.95 ? 'late' : x >= 0.8 ? 'warn' : '');
  // ---------- one line about the client, on the page (not a card floating on the band) ----------
  const cell = (k, v, cls = '', extra = '') => html`<div class="cl-c"><span>${k}</span><b class="${cls}">${v}</b>${extra}</div>`;
  const cline = html`<div class="cline" role="region" aria-label="${c.name} at a glance"><div class="cl-id">${clientMark(c.name, c.id, 34)}<b>${cs}</b></div>
    ${cell('Waiting on us', needs.length ? `${needs.length} · oldest ${waitText(oldest.waited_min)}` : 'Nothing', oldest ? (oldest.level === 'ok' ? '' : oldest.level) : 'good')}
    ${cell('Waiting on them', waitingThem.length ? plural(waitingThem.length, 'approval') : 'Nothing')}
    ${retPct != null ? cell('Retainer', `${Math.round(ret.used_hours)} of ${ret.retainer_hours} h`, tone(retPct), html`<i class="cl-bar ${tone(retPct)}"><i style="width:${Math.min(100, Math.round(retPct * 100))}%"></i></i>`) : ''}
    ${cell('Happiness', avg == null ? 'No ratings yet' : `★ ${avg} from ${plural(ratings.length, 'rating')}`, avg == null ? '' : avg >= 4 ? 'good' : avg <= 3 ? 'late' : 'warn')}
    ${cell('Last signed in', seen ? `${String(seenName || '').split(' ')[0]}, ${relTime(seen.last_seen_at)}` : 'Not yet')}</div>`;
  // ---------- the client's own tabs ----------
  const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const t12 = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const subs = [['', 'Conversations', needs.length || unread || ''], ['requests', 'Requests', requests.filter((r) => r.status === 'new').length || ''], ['approvals', 'Approvals', waitingThem.length || ''], ['plan', 'Plan', ''], ['access', 'Access', '']];
  const subnav = html`<div class="csub"><nav class="cseg" aria-label="${cs}">${subs.map(([v, n, k]) => html`<button type="button" data-act="q" ${raw(qAttr('cv', v))} aria-current="${view === v ? 'page' : 'false'}">${n}${k !== '' ? html`<span>${k}</span>` : ''}</button>`)}</nav>
    <div class="csub-r">${pj.manage && sched && sched.on ? html`<span>${icon('cal')} Weekly update goes out ${DOWS[sched.dow]}, ${t12(sched.time)}</span>` : ''}${firstPerson && p.can_manage ? html`<button type="button" class="linkbtn" data-act="client-viewas" data-id="${firstPerson.id}">${icon('eye')} See it as ${firstPerson.name.split(' ')[0]}</button>` : ''}</div></div>`;
  // ---------- the queue: what needs us, then the chats ----------
  const preview = (t) => (!t.last ? (t.kind === 'group' ? 'No messages yet' : 'Start a chat') : t.last.deleted ? 'Message deleted' : `${t.last.mine ? 'You: ' : t.kind === 'group' ? `${String(t.last.author.name).split(' ')[0]}: ` : ''}${t.last.body || t.last.file || ''}`);
  const fresh = clientPeople.filter((m) => !threads.some((t) => t.with && t.with.id === m.id && t.with.kind === 'client'));
  const online = (id) => presence && presence.clients && presence.clients.some((x) => x.id === id && x.online);
  const qrow = (it) => { const on = picked && picked.key === it.key; return html`<li><button type="button" class="qr${on ? ' on' : ''}" data-act="${it.kind === 'msg' ? 'client-thread' : 'ct-pick'}" data-id="${it.kind === 'msg' ? it.thread_id : ''}" data-key="${it.key}" data-k="n${it.key}" ${on ? raw('aria-current="true"') : ''}>
      <span class="gly ${it.kind}">${icon(GLY[it.kind])}</span>
      <span class="qr-m"><b>${it.text}</b><span>${KIND[it.kind]}${it.from ? ` · ${it.from.name}` : ''}</span></span>
      <span class="qr-r">${waitChip(it)}${it.owner ? html`<span title="${it.owner.name} to answer">${staffAv(it.owner, 20)}</span>` : html`<span class="qr-none">Nobody yet</span>`}</span></button></li>`; };
  const trow = (t) => { const on = !picked && t.id === cur.id; return html`<li><button type="button" class="qr ct-ti${on ? ' on' : ''}" data-act="client-thread" data-id="${t.id}" ${on ? raw('aria-current="true"') : ''}>
      ${t.kind === 'group' ? html`<span class="ct-gav">${icon('users')}</span>` : html`<span class="ch-avw">${cav(t.with, 36)}${online(t.with.id) ? raw('<i class="ch-on"></i>') : ''}</span>`}
      <span class="qr-m"><b>${t.kind === 'group' ? 'Whole team' : t.name}</b><span>${t.kind === 'group' ? '' : 'Direct · '}${preview(t)}</span></span>
      <span class="qr-r qr-t">${t.last ? relTime(t.last.at).replace(' ago', '') : ''}${t.unread ? html`<i class="ct-un">${t.unread}</i>` : ''}</span></button></li>`; };
  const queue = html`<section class="wq" aria-label="Needs us and chats"><header><h2>Needs us <span>${needs.length || ''}</span></h2><span class="muted small">Oldest first</span></header>
    ${needs.length ? html`<ul class="wq-l">${needs.map(qrow)}</ul>` : html`<p class="wq-empty">Nothing from ${cs} is waiting. Messages, requests, comments and asked-for changes show up here until someone answers.</p>`}
    <div class="wq-h">Chats</div><ul class="wq-l chats">${threads.map(trow)}</ul>
    ${fresh.length ? html`<div class="wq-new">${fresh.map((m) => html`<button type="button" class="linkbtn" data-act="client-dm" data-pid="${p.id}" data-id="${m.id}">${icon('plus')} Message ${m.name.split(' ')[0]} directly</button>`)}</div>` : ''}</section>`;
  // ---------- the middle: the chat, or the thing picked from the queue ----------
  const center = picked ? pickedPane(picked, { pj, requests, approvals, rmsgs, cs, ret }) : html`<div class="chat-box" data-own="ct${cur.id}" data-thread="${cur.id}"></div>`;
  // ---------- the rail: who we are talking to and what is around them ----------
  const talk = (cur.kind !== 'group' && cur.with ? clientPeople.find((m) => m.id === cur.with.id) || cur.with : null) || (picked && picked.from ? clientPeople.find((m) => m.name === picked.from.name) : null) || firstPerson;
  const nextCall = meet && meet.upcoming[0];
  const curMile = pj.milestones.find((m) => !m.done_at);
  const rsec = (t, body, link = '') => html`<section class="wr-s"><header><h3>${t}</h3>${link}</header>${body}</section>`;
  const rail = html`<aside class="wr" aria-label="About ${cs}">
    ${talk ? rsec('Talking to', html`<div class="wr-who"><span class="ch-avw">${cav(talk, 40)}${online(talk.id) ? raw('<i class="ch-on"></i>') : ''}</span><div><b>${talk.name}</b><span>${[talk.title, talk.can_approve ? 'can approve' : ''].filter(Boolean).join(' · ') || cs}</span>${online(talk.id) ? html`<span class="on">Online now</span>` : ''}</div></div>`) : ''}
    ${retPct != null ? rsec('Retainer this month', html`<div class="wr-big"><b>${Math.round(ret.used_hours)}</b><span>of ${ret.retainer_hours} h · ${Math.max(0, Math.round(ret.retainer_hours - ret.used_hours))} left</span></div><i class="cl-bar wide ${tone(retPct)}"><i style="width:${Math.min(100, Math.round(retPct * 100))}%"></i></i>${retPct >= 0.8 ? html`<p class="wr-note">Past ${retPct >= 0.95 ? '95' : '80'}%. ${cs} has been told.</p>` : ''}`) : ''}
    ${rsec('Waiting on them', waitingThem.length ? html`<ul class="wr-l">${waitingThem.slice(0, 3).map((a) => html`<li><span>${a.title}</span><span class="muted">${relTime(a.created_at).replace(' ago', '')}</span>${s.approvals ? html`<button type="button" class="linkbtn" data-act="client-remind" data-id="${a.id}">Remind</button>` : ''}</li>`)}${waitingThem.length > 3 ? html`<li class="muted">and ${waitingThem.length - 3} more</li>` : ''}</ul>` : html`<p class="muted small">Nothing right now.</p>`, waitingThem.length > 3 ? html`<button type="button" class="linkbtn" data-act="q" ${raw(qAttr('cv', 'approvals'))}>All ${waitingThem.length}</button>` : '')}
    ${meet ? rsec('Next call', nextCall ? html`<div class="wr-call"><span class="wr-day"><small>${when(nextCall.starts_at, c, { weekday: 'short' }).toUpperCase()}</small>${when(nextCall.starts_at, c, { day: 'numeric' })}</span><div><b>${nextCall.title}</b><span>${when(nextCall.starts_at, c, { hour: 'numeric', minute: '2-digit' })} their time · ${nextCall.minutes}\u00a0min${nextCall.agenda.length ? ` · ${plural(nextCall.agenda.length, 'agenda item').replace(/ /g, '\u00a0')}` : ''}</span></div></div>` : html`<p class="muted small">No call booked.</p>`, html`<button type="button" class="linkbtn" data-act="q" ${raw(qAttr('cv', 'plan'))}>${nextCall ? 'Plan' : 'Book one'}</button>`) : ''}
    ${curMile ? rsec('Current milestone', html`<div class="wr-mile"><b>${curMile.title}</b><span>${curMile.tasks_total ? `${curMile.tasks_done} of ${curMile.tasks_total} tasks` : curMile.due_day ? `Due ${dayShort(curMile.due_day)}` : ''}</span></div>${curMile.tasks_total ? html`<i class="cl-bar wide good"><i style="width:${Math.round((curMile.tasks_done / curMile.tasks_total) * 100)}%"></i></i>` : ''}`) : ''}
  </aside>`;
  const ws = html`<div class="ws"><div class="ws-q">${queue}</div><div class="ws-c ct-main">${center}</div><div class="ws-r">${rail}</div></div>`;
  // ---------- the weekly update, with its schedule ----------
  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const zoneWord = c.tz_name ? `${c.tz_name.split('/').pop().replace(/_/g, ' ')} time` : 'company time';
  const schedCard = pj.manage && sched ? html`<form class="cu-sched" data-submit="client-sched" data-pid="${p.id}"><div class="field-stack">
      <label class="check"><input type="checkbox" name="on" value="1" ${sched.on ? raw('checked') : ''}><span><b>Send it every week</b><br><span class="hint">Staffwarden fills in what got done, what is next and what is waiting on ${cs}. The writer gets a reminder the day before.</span></span></label>
      <div class="grid2 mt"><div class="field"><label class="f" for="cs-d">Day</label><select id="cs-d" name="dow">${DOW.map((n, i) => html`<option value="${i}" ${sched.dow === i ? raw('selected') : ''}>${n}</option>`)}</select></div>
        <div class="field"><label class="f" for="cs-t">At (${zoneWord})</label><input id="cs-t" name="time" type="time" value="${sched.time}"></div></div>
      <div class="field"><label class="f" for="cs-i">A line from you for this week <span class="muted">(optional)</span></label><textarea id="cs-i" name="intro" rows="2" maxlength="3000" placeholder="Used once, then cleared">${sched.intro || ''}</textarea></div>
      <div class="cu-a"><button class="btn sm primary" type="submit">Save the schedule</button>${sched.on && sched.next_at ? html`<span class="muted small">Next one ${when(sched.next_at, c, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} their time</span>` : ''}</div></div>
    <div class="cu-prev"><span>What ${cs} will see${sched.on && sched.next_at ? ` on ${when(sched.next_at, c, { weekday: 'long' })}` : ''}</span><div><h4>This week on ${pj.project.name}</h4><p>${sched.intro || 'Here is where things stand this week, and what comes next.'}</p>
      <div class="chips">${sched.draft.done.slice(0, 2).map((x) => html`<span class="chip2 work">Done: ${x}</span>`)}${sched.draft.next.slice(0, 2).map((x) => html`<span class="chip2 blue">Next: ${x}</span>`)}${sched.draft.needed.slice(0, 2).map((x) => html`<span class="chip2 brass">From you: ${x}</span>`)}</div></div></div></form>` : '';
  const upd = pj.manage ? html`<section class="panel ct-upd" id="ct-upd"><header><h2>Weekly update</h2>${sched && sched.on ? html`<span class="tag present"><i></i>Scheduled · ${DOW[sched.dow]} ${(([h, m]) => `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`)(String(sched.time).split(':').map(Number))}</span>` : html`<span class="muted small">${pj.update ? `Last one ${relTime(pj.update.created_at)}` : 'None sent yet'}</span>`}</header>
    <div class="body">${schedCard}
    <details class="cu-now"${sched && sched.on ? '' : raw(' open')}><summary>Send one now instead</summary><form data-submit="client-update" data-pid="${p.id}"><p class="hint" style="margin-top:0">Ticked lines go in the update. It is pinned in the chat and shown on their overview.</p>
      <div class="field"><label class="f" for="cu-i">A few lines from you</label><textarea id="cu-i" name="intro" rows="3" maxlength="3000" required placeholder="What moved this week, in plain words"></textarea></div>
      ${[['done', 'Done this week', 'From tasks finished'], ['next', 'Next week', 'From tasks due or in progress'], ['needed', `Needed from ${cs}`, 'What is waiting on them']].map(([k, t, h]) => html`<fieldset class="cu-g"><legend><b>${t}</b><span>${h}</span></legend>${draft[k].length ? draft[k].map((x, i) => html`<label class="check"><input type="checkbox" name="${k}" value="${x}" checked data-k="${k}${i}"><span>${x}</span></label>`) : html`<span class="faint small">Nothing</span>`}</fieldset>`)}
      <div class="cu-a"><button class="btn primary" type="submit">${icon('check')} Send the update</button></div></form></details></div></section>` : '';
  // ---------- requests ----------
  const RK = { change: 'A change', new: 'Something new', problem: 'A problem', call: 'A call' };
  const reqThread = (r) => { const m = rmsgs.get(r.id) || []; return m.length ? html`<ol class="prt-l">${m.slice(-3).map((x) => html`<li class="${x.mine ? 'me' : ''}">${x.mine ? '' : cav({ id: x.author.kind === 'client' ? x.author.id : x.author.id - 1000, name: x.author.name }, 24)}<div><b>${x.mine ? 'You' : x.author.name}</b><p>${x.body}</p><span>${relTime(x.created_at)}</span></div></li>`)}</ol>` : ''; };
  const reqs = s.requests || requests.length ? html`<section class="panel flush" id="ct-reqs"><header><h2>Requests from ${cs} <span class="faint">${requests.filter((r) => r.status === 'new').length || ''}</span></h2>${!pj.manage && requests.some((r) => r.status === 'new') ? html`<span class="muted small">The project lead or a manager answers these</span>` : ''}</header>
    ${requests.length ? html`<ul class="ct-list">${requests.map((r) => { const [tone, label] = REQ[r.status] || REQ.new; const est = r.estimate; return html`<li data-k="r${r.id}"><div><span class="ct-kind ${r.kind}">${RK[r.kind] || 'Request'}</span><b>${r.title}</b><span class="muted small">${r.by || 'Someone'} · ${relTime(r.created_at)} · ${{ whenever: 'whenever there’s time', month: 'this month', week: 'this week' }[r.urgency] || ''}${r.seen_at ? ` · seen by ${String(r.seen_by_name || 'the team').split(' ')[0]}` : ''}</span>${r.detail ? html`<p class="ct-detail">${r.detail}</p>` : ''}${r.file ? html`<button class="linkbtn small" data-act="client-file" data-url="${r.file.url}">${icon('clip')}${r.file.name}</button>` : ''}
      ${est ? html`<p class="ct-note ${est.answer === 'yes' ? 'ok' : ''}">Estimate: about ${est.hours}h${est.note ? `. ${est.note}` : ''} · ${est.answer === 'yes' ? `${String(r.by || 'They').split(' ')[0]} said go ahead` : est.answer === 'no' ? 'They said not now' : 'Waiting for their answer'}</p>` : ''}
      ${r.reply ? html`<p class="ct-note ok">${r.decided_by_name ? r.decided_by_name.split(' ')[0] : 'You'}: ${r.reply}</p>` : ''}${r.task ? html`<a class="linkbtn small" href="#/tasks?task=${r.task.id}">${icon('tasks')}${r.task.ref} ${r.task.title}</a>` : ''}
      ${reqThread(r)}${['new', 'planned'].includes(r.status) ? html`<form class="prt-f" data-submit="client-rmsg" data-id="${r.id}"><input name="body" maxlength="2000" placeholder="Reply to ${String(r.by || cs).split(' ')[0]} about this" aria-label="Reply about this request" required><button class="btn sm" type="submit">Send</button></form>` : ''}</div>
      <span class="tag ${tone}"><i></i>${label}</span>
      ${r.status === 'new' && pj.manage ? html`<div class="ct-acts">${!est || est.answer ? html`<button class="btn sm" data-act="client-est" data-id="${r.id}" data-title="${r.title}">${icon('clock')} Estimate</button>` : ''}<button class="btn sm primary" data-act="client-req" data-id="${r.id}" data-s="planned" data-title="${r.title}">${icon('check')} Take it on</button><button class="btn sm" data-act="client-req" data-id="${r.id}" data-s="declined" data-title="${r.title}">Not doing</button></div>` : r.status === 'planned' && pj.manage ? html`<div class="ct-acts"><button class="btn sm" data-act="client-req" data-id="${r.id}" data-s="done" data-title="${r.title}">Mark done</button></div>` : ''}</li>`; })}</ul>`
      : html`<div class="body ct-empty"><p class="muted small">When ${cs} asks for a change, something new or reports a problem, it lands here. Estimate it, or take it on as a task they can follow.</p></div>`}</section>` : '';
  // ---------- approvals ----------
  const waiting = html`<section class="panel flush" id="ct-aps"><header><h2>Waiting on ${cs} <span class="faint">${waitingThem.length || ''}</span></h2>${s.approvals ? html`<div class="ct-btns"><button class="btn sm" data-act="client-ask" data-pid="${p.id}" data-kind="file">${icon('up')} Ask for a file</button><button class="btn sm primary" data-act="client-ask" data-pid="${p.id}" data-kind="approval">${icon('check')} Ask for approval</button></div>` : ''}</header>
    ${!s.approvals ? html`<div class="body"><p class="muted small">Approvals are switched off for ${cs}.</p></div>` : approvals.length ? html`<ul class="ct-list">${approvals.map((a) => { const v = a.versions[a.versions.length - 1]; const [tone, label] = AP[a.status]; const pins = v && v.pins ? v.pins.filter((x) => !x.resolved) : []; return html`<li data-k="a${a.id}"><div><b>${a.title}${a.kind === 'approval' && v ? html` <span class="muted">version ${v.n}</span>` : ''}</b><span class="muted small">${a.kind === 'file' ? 'File' : 'Approval'} · asked by ${a.by.split(' ')[0]} ${relTime(a.created_at)}${a.due_day ? ` · needed by ${dayShort(a.due_day)}` : ''}${a.reminded_at && a.status === 'waiting' ? ` · reminded ${relTime(a.reminded_at)}` : ''}</span>${a.status === 'changes' && v && v.decision_note ? html`<p class="ct-note">${v.decided_by || 'They'}: “${v.decision_note}”</p>` : ''}${pins.length ? html`<p class="ct-note">${plural(pins.length, 'comment')} on the picture: ${pins.map((x) => `${x.n}. ${x.body}`).join(' · ')}</p>` : ''}${a.status === 'received' && v && v.file ? html`<button class="linkbtn small" data-act="client-file" data-url="/api/portal/approval-files/${v.id}">${icon('clip')}${v.file.name}</button>` : ''}</div>
      <span class="tag ${tone}"><i></i>${label}</span>
      <div class="ct-acts">${a.status === 'waiting' ? html`<button class="linkbtn" data-act="client-remind" data-id="${a.id}">Remind them</button>` : ''}${a.kind === 'approval' && a.status !== 'approved' ? html`<button class="linkbtn" data-act="client-version" data-id="${a.id}" data-n="${(v ? v.n : 0) + 1}" data-title="${a.title}">Send version ${(v ? v.n : 0) + 1}</button>` : ''}${a.status !== 'approved' && a.status !== 'received' ? html`<button class="linkbtn danger-ink" data-act="client-ap-del" data-id="${a.id}" data-title="${a.title}">Remove</button>` : ''}</div></li>`; })}</ul>`
      : html`<div class="body">${empty('Nothing waiting on them', 'Ask them to approve wording, a design or a plan, or to send you a file. Every version and answer is kept, and they get a reminder after two days.')}</div>`}</section>`;
  // ---------- calls ----------
  const meetSec = meet ? html`<section class="panel" id="ct-meet"><header><h2>Calls with ${cs}</h2>${meet.manage ? html`<button class="btn sm primary" data-act="client-meet-new" data-pid="${p.id}">${icon('plus')} Book a call</button>` : ''}</header><div class="body ct-meet">
    ${meet.upcoming.length ? meet.upcoming.map((m) => html`<div class="ct-meet-i" data-k="m${m.id}"><div><b>${m.title}</b><span>${when(m.starts_at, c, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} their time · ${m.minutes} min${m.agenda.length ? ` · ${plural(m.agenda.length, 'agenda item')}` : ''}</span>${m.agenda.length ? html`<span>${m.agenda.map((x) => `${x.text} (${x.by.name.split(' ')[0]})`).join(' · ')}</span>` : ''}</div>${m.link ? html`<a class="btn sm" href="${m.link}" target="_blank" rel="noopener noreferrer">${icon('ext')} Join</a>` : ''}${meet.manage ? html`<button class="btn sm" data-act="client-meet-edit" data-id="${m.id}" data-pid="${p.id}">Change</button>` : ''}</div>`) : html`<p class="muted small">No call booked. ${cs} sees the next call on their overview, with an agenda they can add to.</p>`}
    ${meet.past.slice(0, 3).map((m) => html`<div class="ct-meet-i" data-k="mp${m.id}"><div><b>${when(m.starts_at, c, { month: 'short', day: 'numeric' })}: ${m.title}</b><span>${m.notes ? `Notes by ${String(m.notes.by || '').split(' ')[0]} · ${plural(m.notes.decided.length, 'decision')} · ${plural(m.notes.next.length, 'next step')}` : 'No notes yet'}</span></div>${meet.manage ? html`<button class="btn sm ${m.notes ? '' : 'primary'}" data-act="client-meet-notes" data-id="${m.id}" data-pid="${p.id}">${m.notes ? 'Edit notes' : 'Write the notes'}</button>` : ''}</div>`)}</div></section>` : '';
  // ---------- milestones and ratings ----------
  const miles = html`<section class="panel" id="ct-miles"><header><h2>Milestones</h2>${pj.manage ? html`<button class="btn sm" data-act="client-miles" data-pid="${p.id}">${icon('gear')} Edit</button>` : ''}</header><div class="body">
    ${pj.milestones.length ? html`<ol class="ct-miles">${pj.milestones.map((m) => { const r = ratings.filter((x) => x.milestone_id === m.id); return html`<li class="${m.done_at ? 'done' : ''}"><i>${m.done_at ? icon('check') : ''}</i><b>${m.title}</b><span class="muted small">${m.done_at ? `Done ${relTime(m.done_at)}` : m.due_day ? `Due ${dayShort(m.due_day)}` : ''}${m.tasks_total ? ` · ${m.tasks_done} of ${m.tasks_total} tasks` : ''}</span>${r.map((x) => html`<span class="small"><span class="stars">${stars(x.stars)}</span> ${x.by.split(' ')[0]}${x.note ? `: “${x.note}”` : ''}</span>`)}</li>`; })}</ol>` : html`<p class="muted small">Milestones show along the top of ${cs}’s overview. Put tasks under them from each task’s panel. When one is done, ${cs} is asked how it went.</p>`}</div></section>`;
  const hrsTxt = { off: 'no hours', total: 'the total hours', person: 'hours by person', task: 'hours by person and task' }[s.hours];
  const sees = html`<section class="panel ct-sees" id="ct-sees"><div class="body"><h3>${icon('eye')} What ${cs} sees of you</h3>
    <p>${s.people ? 'Your name and role on this project, and the tasks you are on' : 'Not who works on what'}${s.tasks === 'shared' ? ' (only tasks marked shared)' : ''}; comments and messages that aren’t team only; ${hrsTxt}.${s.on_it_now ? ' While your timer runs on this project they see “On it now”.' : ''}${s.presence ? ' A green dot while you have Staffwarden open.' : ''}</p>
    <p class="muted small">Never your screenshots, activity, other projects, attendance or time off.</p>${isMgr() ? html`<a class="linkbtn small" href="#/clients?id=${c.id}">Change what they see</a>` : ''}</div></section>`;
  const body = view === 'requests' ? (reqs || html`<section class="panel"><div class="body">${empty('Requests are off', `${cs} can’t send requests on this project. Turn them on from the Clients page.`)}</div></section>`)
    : view === 'approvals' ? waiting
    : view === 'plan' ? html`<div class="cplan"><div>${miles}</div><div>${meetSec}${upd}</div></div>`
    : view === 'access' ? sees : ws;
  return html`${cline}${subnav}${body}`;
}
// called after the page is drawn: starts the chat inside the tab
let seenKeys = null, seenFor = null;
// if the live connection goes quiet, the Client tab still keeps up by checking every few seconds
setInterval(() => { if (!document.hidden && /tab=client/.test(location.hash) && !liveFresh()) S.refresh(); }, 6000);
export function mountClientTab(root, d) {
  if (!d || d.none) return;
  tabData = d;
  // a request, approval or milestone that just arrived slides in once
  const keys = [...root.querySelectorAll('.ws [data-k]')].filter((x) => !x.closest('.chat'));
  if (seenFor === d.pj.project.id && seenKeys) for (const el of keys) if (!seenKeys.has(el.dataset.k)) { el.classList.add('arrive'); setTimeout(() => el.classList.remove('arrive'), 1600); }
  seenKeys = new Set(keys.map((x) => x.dataset.k)); seenFor = d.pj.project.id;
  for (const box of root.querySelectorAll('.chat-box[data-thread]')) {
    if (box.classList.contains('chat')) continue;
    const chat = mountChat(box, { threadId: Number(box.dataset.thread), clientName: short(d.pj.client.name), orgShort: String(S.settings.org_name || '').split(' ')[0], onRead: () => S.refresh() });
    if (d.presence) chat.setPresence({ staff: new Set(d.presence.staff.filter((x) => x.online).map((x) => x.id)), clients: new Map(d.presence.clients.map((x) => [x.id, x])) });
  }
}
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.matches('[data-plink]') && t.value) {
    try { await linkProject(t.value, t.dataset.plink, 'Shared. Invite people at the client from the Clients page.'); } catch (err) { toast(errMsg(err), true); }
  }
});
// switching chats happens right here: the address remembers it, nothing else reloads
let tabData = null;
function openThread(id) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const hadPick = q.has('ci') || q.has('cv');
  q.set('ct', id); q.delete('ci'); q.delete('cv');
  if (hadPick) { location.hash = `#/project?${q}`; return; }
  history.replaceState(null, '', `#/project?${q}`);
  const box = document.querySelector('.ct-main');
  if (!box) return;
  for (const b of document.querySelectorAll('.ws .qr')) { const on = b.classList.contains('ct-ti') && b.dataset.id === String(id); b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); }
  const own = box.querySelector('.chat-box');
  if (!own || own.dataset.thread !== String(id)) {
    box.innerHTML = `<div class="chat-box" data-own="ct${id}" data-thread="${id}"></div>`;
    if (tabData) mountClientTab(document.getElementById('view'), tabData);
  }
  toPane();
  S.refresh();
}
actions['ct-pick'] = (el) => {
  for (const b of document.querySelectorAll('.ws .qr.on')) b.classList.remove('on');
  el.classList.add('on');
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  q.set('ci', el.dataset.key); q.delete('cv');
  location.hash = `#/project?${q}`;
  toPane();
};
// on a phone the panes stack: picking something brings its pane into view
// and on any screen, if the workspace runs past the bottom of the window, it slides up to fill it
const toPane = () => setTimeout(() => {
  const narrow = matchMedia('(max-width: 760px)').matches;
  const el = document.querySelector(narrow ? '.ws-c' : '.ws'); if (!el) return;
  const r = el.getBoundingClientRect();
  if (narrow || r.bottom > innerHeight + 4) window.scrollBy({ top: r.top - 12, behavior: 'smooth' });
}, 120);
actions['client-thread'] = (el) => { openThread(Number(el.dataset.id)); };
actions['client-dm'] = async (el) => { el.disabled = true; try { const r = await post(`/api/chat/projects/${el.dataset.pid}/direct`, { client_user_id: Number(el.dataset.id) }); const q = new URLSearchParams(location.hash.split('?')[1] || ''); q.set('ct', r.id); q.delete('ci'); q.delete('cv'); location.hash = `#/project?${q}`; } catch (e) { el.disabled = false; toast(errMsg(e), true); } };
actions['client-file'] = async (el) => { const w = window.open('', '_blank'); try { const u = await fileUrl(el.dataset.url); if (w) w.location = u; } catch (e) { if (w) w.close(); toast(errMsg(e), true); } };
const pickFile = (f) => (f && f.size ? f : null);
const typeOf = (f) => f.type || (/\.docx$/i.test(f.name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : /\.xlsx$/i.test(f.name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : /\.csv$/i.test(f.name) ? 'text/csv' : '');
actions['client-ask'] = (el) => {
  const file = el.dataset.kind === 'file';
  openModal({
    title: file ? 'Ask them for a file' : 'Ask for approval', submit: file ? 'Ask for it' : 'Send for approval', wide: !file,
    sub: file ? 'They get a place to upload it. You hear when it arrives.' : 'They see this with every later version, and approve it or ask for changes.',
    body: html`<div class="field"><label class="f" for="ak-t">${file ? 'What file?' : 'What are they approving?'}</label><input id="ak-t" name="title" required maxlength="200" placeholder="${file ? 'Your Follow Up Boss export' : 'New-lead text message'}"></div>
      <div class="field"><label class="f" for="ak-d">${file ? 'What it’s for' : 'A line of context'} <span class="muted">(optional)</span></label><input id="ak-d" name="description" maxlength="2000"></div>
      ${file ? '' : html`<div class="field"><label class="f" for="ak-b">The wording or plan</label><textarea id="ak-b" name="body" rows="5" maxlength="8000" placeholder="Paste the text they should see, or attach a file below"></textarea></div>
      <div class="field"><label class="f" for="ak-f">A file <span class="muted">(optional, up to 5 MB)</span></label><input id="ak-f" name="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.docx,.xlsx,.csv,.txt,.zip"></div>`}
      <div class="field"><label class="f" for="ak-due">Needed by <span class="muted">(optional)</span></label><input id="ak-due" name="due_day" type="date" style="width:auto"></div>`,
    onSubmit: async (fd) => {
      const f = pickFile(fd.get('file'));
      if (f && f.size > 5 * 1024 * 1024) throw new Error('Files can be up to 5 MB');
      await post(`/api/portal/projects/${el.dataset.pid}/approvals`, { kind: file ? 'file' : 'approval', title: fd.get('title'), description: fd.get('description'), body: fd.get('body'), due_day: fd.get('due_day') || null, ...(f ? { file_base64: await fileBase64(f), file_type: typeOf(f), file_name: f.name } : {}) });
      toast(file ? 'Asked. They see it on their overview.' : 'Sent for approval'); S.refresh();
    },
  });
};
actions['client-version'] = (el) => openModal({
  title: `${el.dataset.title}: version ${el.dataset.n}`, submit: `Send version ${el.dataset.n}`, wide: true,
  body: html`<div class="field"><label class="f" for="av-c">What changed</label><textarea id="av-c" name="changes" rows="3" maxlength="2000" placeholder="One change per line. They see this next to the new version."></textarea></div>
    <div class="field"><label class="f" for="av-b">The new version</label><textarea id="av-b" name="body" rows="5" maxlength="8000"></textarea></div>
    <div class="field"><label class="f" for="av-f">A file <span class="muted">(optional)</span></label><input id="av-f" name="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.docx,.xlsx,.csv,.txt,.zip"></div>`,
  onSubmit: async (fd) => { const f = pickFile(fd.get('file')); await post(`/api/portal/approvals/${el.dataset.id}/versions`, { changes: fd.get('changes'), body: fd.get('body'), ...(f ? { file_base64: await fileBase64(f), file_type: typeOf(f), file_name: f.name } : {}) }); toast('New version sent'); S.refresh(); },
});
actions['client-ap-del'] = async (el) => {
  if (!(await confirmBox({ title: `Remove “${el.dataset.title}”?`, message: 'It disappears for the client too, with its versions.', confirm: 'Remove', danger: true }))) return;
  try { await del(`/api/portal/approvals/${el.dataset.id}`); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
actions['client-req'] = (el) => {
  const st = el.dataset.s;
  if (st === 'done') return post(`/api/portal/requests/${el.dataset.id}/decide`, { status: 'done' }).then(() => { toast('Marked done'); S.refresh(); }).catch((e) => toast(errMsg(e), true));
  openModal({
    title: st === 'planned' ? `Take on “${el.dataset.title}”` : `Not doing “${el.dataset.title}”`, submit: st === 'planned' ? 'Take it on' : 'Send', danger: st === 'declined',
    body: st === 'planned' ? html`<div class="field"><label class="f" for="rq-r">A reply <span class="muted">(optional)</span></label><input id="rq-r" name="reply" maxlength="1000" placeholder="Planned for next week"></div>
        <label class="check"><input type="checkbox" name="make_task" value="1" checked><span>Make it a task they can follow</span></label>
        <div class="field mt"><label class="f" for="rq-d">Due <span class="muted">(optional)</span></label><input id="rq-d" name="due_day" type="date" style="width:auto"></div>`
      : html`<div class="field"><label class="f" for="rq-r">Say why, so they understand</label><textarea id="rq-r" name="reply" rows="3" maxlength="1000" required></textarea></div>`,
    onSubmit: async (fd) => { await post(`/api/portal/requests/${el.dataset.id}/decide`, { status: st, reply: fd.get('reply'), make_task: fd.get('make_task') === '1', due_day: fd.get('due_day') || null }); toast(st === 'planned' ? 'Taken on. They can see it.' : 'Sent'); S.refresh(); },
  });
};
actions['client-update'] = async (f) => {
  const fd = new FormData(f), b = f.querySelector('button[type=submit]');
  b.disabled = true;
  try { await post(`/api/portal/projects/${f.dataset.pid}/updates`, { intro: fd.get('intro'), done: fd.getAll('done'), next: fd.getAll('next'), needed: fd.getAll('needed') }); f.intro.value = ''; delete f.intro.dataset.dirty; toast('Update sent. It is pinned in the chat.'); S.refresh(); }
  catch (e) { toast(errMsg(e), true); } finally { b.disabled = false; }
};
actions['client-miles'] = async (el) => {
  const pj = await get(`/api/portal/projects/${el.dataset.pid}`);
  const row = (m = {}) => `<li class="cm-row${m.done_at ? ' done' : ''}"><span class="cm-n" aria-hidden="true"></span>
    <label class="cm-f cm-t"><span>Milestone</span><input name="title" maxlength="120" placeholder="For example: Pipelines and automations" value="${esc(m.title || '')}"></label>
    <label class="cm-f"><span>Starts <i>optional</i></span><input name="start_day" type="date" value="${m.start_day || ''}"></label>
    <label class="cm-f"><span>Due</span><input name="due_day" type="date" value="${m.due_day || ''}"></label>
    <label class="cm-done"><input type="checkbox" name="done" ${m.done_at ? 'checked' : ''}><span>Done</span></label>
    <span class="cm-acts"><button type="button" class="btn icon sm" data-mv="-1" aria-label="Move up">${icon('up')}</button><button type="button" class="btn icon sm cm-down" data-mv="1" aria-label="Move down">${icon('up')}</button><button type="button" class="btn icon sm" data-rm aria-label="Remove this milestone">${icon('trash')}</button></span>
    <input type="hidden" name="id" value="${m.id || ''}"></li>`;
  const m = openModal({ title: 'Milestones', sub: 'The big steps of the project, in order. The client sees them along the top of their overview, with the current one highlighted.', submit: 'Save milestones', wide: true,
    body: raw(`<ol class="cm-list">${(pj.milestones.length ? pj.milestones : [{}, {}]).map(row).join('')}</ol>
      <div class="cm-foot"><button type="button" class="btn sm" data-add>${icon('plus')} Add a milestone</button><span class="hint">Tick <b>Done</b> when a step is finished. The first one not done shows as “happening now”.</span></div>`),
    onSubmit: async (_, form) => {
      const list = [...form.querySelectorAll('.cm-row')].map((r) => ({ id: Number(r.querySelector('[name=id]').value) || null, title: r.querySelector('[name=title]').value.trim(), start_day: r.querySelector('[name=start_day]').value || null, due_day: r.querySelector('[name=due_day]').value || null, done: r.querySelector('[name=done]').checked })).filter((x) => x.title);
      const bad = list.find((x) => x.start_day && x.due_day && x.start_day > x.due_day);
      if (bad) throw new Error(`“${bad.title}” starts after it is due`);
      await put(`/api/portal/projects/${el.dataset.pid}/milestones`, { milestones: list }); toast(list.length ? 'Milestones saved. The client sees them now.' : 'Milestones cleared'); S.refresh();
    } });
  m.form.classList.add('cm-modal');
  const listEl = m.form.querySelector('.cm-list');
  const add = () => { listEl.insertAdjacentHTML('beforeend', row()); listEl.lastElementChild.querySelector('input').focus(); };
  m.form.addEventListener('click', (e) => {
    if (e.target.closest('[data-add]')) return add();
    const rm = e.target.closest('[data-rm]'); if (rm) { rm.closest('.cm-row').remove(); if (!listEl.children.length) add(); return; }
    const mv = e.target.closest('[data-mv]');
    if (mv) { const li = mv.closest('.cm-row'); if (mv.dataset.mv === '-1' && li.previousElementSibling) li.parentNode.insertBefore(li, li.previousElementSibling); else if (mv.dataset.mv === '1' && li.nextElementSibling) li.parentNode.insertBefore(li.nextElementSibling, li); mv.focus(); }
  });
  m.form.addEventListener('change', (e) => { if (e.target.name === 'done') e.target.closest('.cm-row').classList.toggle('done', e.target.checked); });
  // Enter in a name adds the next milestone instead of saving
  m.form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.name === 'title') { e.preventDefault(); const li = e.target.closest('.cm-row'); if (li.nextElementSibling) li.nextElementSibling.querySelector('input').focus(); else add(); } });
};

// ================= portal v2, the team's side =================
actions['ct-jump'] = (el, e) => { e.preventDefault(); const t = document.getElementById(el.dataset.id); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); t.classList.add('arrive'); setTimeout(() => t.classList.remove('arrive'), 1400); } for (const a of document.querySelectorAll('.ctn-nav a')) a.classList.toggle('on', a === el); };
// "See it as the client": the portal as that person sees it, read only, in a new tab
actions['client-viewas'] = (el) => { window.open(`${location.origin}/#/client-view?cu=${el.dataset.id}`, '_blank', 'noopener'); };
actions['client-remind'] = async (el) => { el.disabled = true; try { await post(`/api/portal/approvals/${el.dataset.id}/remind`); toast('Reminder sent to their bell and phone'); S.refresh(); } catch (e) { el.disabled = false; toast(errMsg(e), true); } };
actions['client-est'] = (el) => openModal({
  title: `Estimate “${el.dataset.title}”`, submit: 'Send the estimate', sub: 'They see the hours against their retainer and say go ahead or not now. Go ahead makes it a task, with you on it.',
  body: html`<div class="grid2"><div class="field"><label class="f" for="es-h">About how many hours?</label><input id="es-h" name="hours" type="number" min="0.5" max="500" step="0.5" required></div></div>
    <div class="field"><label class="f" for="es-n">What it involves <span class="muted">(optional)</span></label><textarea id="es-n" name="note" rows="3" maxlength="1000" placeholder="Two new steps in the follow-up, plus testing with real leads"></textarea></div>`,
  onSubmit: async (fd) => { await post(`/api/portal/requests/${el.dataset.id}/estimate`, { hours: Number(fd.get('hours')), note: fd.get('note') }); toast('Estimate sent. You hear when they answer.'); S.refresh(); },
});
actions['client-rmsg'] = async (f) => { const b = f.querySelector('button'); b.disabled = true; try { await post(`/api/portal/requests/${f.dataset.id}/messages`, { body: f.body.value }); f.body.value = ''; toast('Sent'); S.refresh(); } catch (e) { toast(errMsg(e), true); } finally { b.disabled = false; } };
actions['client-sched'] = async (f) => {
  const fd = new FormData(f), b = f.querySelector('button[type=submit]'); b.disabled = true;
  try { await put(`/api/portal/projects/${f.dataset.pid}/update-schedule`, { on: fd.get('on') === '1', dow: Number(fd.get('dow')), time: fd.get('time'), intro: fd.get('intro') }); toast(fd.get('on') === '1' ? 'Scheduled. It goes out on its own.' : 'Schedule turned off'); S.refresh(); }
  catch (e) { toast(errMsg(e), true); } finally { b.disabled = false; }
};
function meetForm(m, c) {
  const z = c && c.tz_name ? c.tz_name.split('/').pop().replace(/_/g, ' ') : 'company';
  const loc = (iso, o) => new Date(iso).toLocaleString('en-CA', { timeZone: (c && c.tz_name) || undefined, ...o });
  const day = m ? loc(m.starts_at, { year: 'numeric', month: '2-digit', day: '2-digit' }) : '';
  const time = m ? loc(m.starts_at, { hour: '2-digit', minute: '2-digit', hour12: false }) : '15:00';
  return html`<div class="field"><label class="f" for="mt-t">What’s the call?</label><input id="mt-t" name="title" maxlength="120" required value="${m ? m.title : 'Weekly check-in'}"></div>
    <div class="grid2"><div class="field"><label class="f" for="mt-d">Day</label><input id="mt-d" name="day" type="date" required value="${day}"></div><div class="field"><label class="f" for="mt-h">Time, in ${z} time</label><input id="mt-h" name="time" type="time" required value="${time}"></div></div>
    <div class="grid2"><div class="field"><label class="f" for="mt-m">How long</label><select id="mt-m" name="minutes">${[15, 30, 45, 60, 90].map((n) => html`<option value="${n}" ${(m ? m.minutes : 30) === n ? raw('selected') : ''}>${n} minutes</option>`)}</select></div>
      <div class="field"><label class="f" for="mt-l">Call link <span class="muted">(optional)</span></label><input id="mt-l" name="link" type="url" maxlength="500" placeholder="https://meet.google.com/…" value="${(m && m.link) || ''}"></div></div>
    ${m ? '' : html`<div class="field"><label class="f" for="mt-a">Agenda <span class="muted">(one per line, optional)</span></label><textarea id="mt-a" name="agenda" rows="3" maxlength="2000" placeholder="They can add to it from their overview"></textarea></div>`}`;
}
actions['client-meet-new'] = async (el) => {
  const pj = await get(`/api/portal/projects/${el.dataset.pid}`);
  openModal({ title: 'Book a call', sub: `${pj.client.name} sees it on their overview, can add to the agenda, and gets a reminder an hour before.`, submit: 'Book it', wide: true, body: meetForm(null, pj.client),
    onSubmit: async (fd) => { await post(`/api/portal/projects/${el.dataset.pid}/meetings`, { title: fd.get('title'), day: fd.get('day'), time: fd.get('time'), minutes: Number(fd.get('minutes')), link: fd.get('link') || null, agenda: String(fd.get('agenda') || '').split('\n').map((x) => x.trim()).filter(Boolean) }); toast('Booked. They can see it now.'); S.refresh(); } });
};
actions['client-meet-edit'] = async (el) => {
  const [pj, list] = await Promise.all([get(`/api/portal/projects/${el.dataset.pid}`), get(`/api/portal/projects/${el.dataset.pid}/meetings`)]);
  const m = list.upcoming.find((x) => x.id === Number(el.dataset.id)); if (!m) return;
  const md = openModal({ title: `Change “${m.title}”`, submit: 'Save', wide: true, body: html`${meetForm(m, pj.client)}<p class="hint"><button type="button" class="linkbtn danger-ink" data-cancel-meet>Cancel this call</button></p>`,
    onSubmit: async (fd) => { await patch(`/api/portal/meetings/${m.id}`, { title: fd.get('title'), day: fd.get('day'), time: fd.get('time'), minutes: Number(fd.get('minutes')), link: fd.get('link') || null }); toast('Saved. They’re told if the time moved.'); S.refresh(); } });
  md.form.querySelector('[data-cancel-meet]').addEventListener('click', async () => { if (!(await confirmBox({ title: 'Cancel this call?', message: 'They’re told it is cancelled.', confirm: 'Cancel the call', danger: true }))) return; await patch(`/api/portal/meetings/${m.id}`, { cancelled: true }); md.close(); toast('Cancelled'); S.refresh(); });
};
actions['client-meet-notes'] = async (el) => {
  const list = await get(`/api/portal/projects/${el.dataset.pid}/meetings`);
  const m = list.past.find((x) => x.id === Number(el.dataset.id)) || list.upcoming.find((x) => x.id === Number(el.dataset.id)); if (!m) return;
  const n = m.notes || { decided: [], next: [], from_client: [], text: '' };
  const picked = new Set(n.next.filter((x) => x.task).map((x) => x.task.id));
  const freeNext = n.next.filter((x) => !x.task).map((x) => x.text).join('\n');
  openModal({ title: `Notes: ${m.title}`, sub: 'The client sees these on Meetings, and hears they’re up the first time you save.', submit: 'Save the notes', wide: true,
    body: html`<div class="field"><label class="f" for="mn-t">In a line or two <span class="muted">(optional)</span></label><textarea id="mn-t" name="text" rows="2" maxlength="3000">${n.text || ''}</textarea></div>
      <div class="field"><label class="f" for="mn-d">Decided <span class="muted">(one per line)</span></label><textarea id="mn-d" name="decided" rows="3">${n.decided.join('\n')}</textarea></div>
      <fieldset class="cu-g"><legend><b>Next steps</b><span>Tasks they can follow</span></legend><div class="mn-tasks">${list.tasks.map((t) => html`<label class="check"><input type="checkbox" name="task" value="${t.id}" ${picked.has(t.id) ? raw('checked') : ''}><span>${t.ref} ${t.title}</span></label>`)}</div></fieldset>
      <div class="field"><label class="f" for="mn-x">Other next steps <span class="muted">(one per line)</span></label><textarea id="mn-x" name="next_text" rows="2">${freeNext}</textarea></div>
      <div class="field"><label class="f" for="mn-c">From them <span class="muted">(one per line)</span></label><textarea id="mn-c" name="from_client" rows="2">${n.from_client.join('\n')}</textarea></div>`,
    onSubmit: async (fd) => {
      const lines = (k) => String(fd.get(k) || '').split('\n').map((x) => x.trim()).filter(Boolean);
      await put(`/api/portal/meetings/${m.id}/notes`, { text: fd.get('text'), decided: lines('decided'), from_client: lines('from_client'), next: [...fd.getAll('task').map((id) => ({ task_id: Number(id) })), ...lines('next_text').map((text) => ({ text }))] });
      toast('Notes saved. They can read them now.'); S.refresh();
    } });
};

// ================= one inbox across clients =================
export const inboxPage = {
  title: 'Client inbox',
  async load(q) {
    const r = await get('/api/client-inbox');
    const sel = q.get('i') || (r.items[0] && r.items[0].key) || null;
    const it = r.items.find((x) => x.key === sel) || null;
    let thread = null;
    if (it && it.kind === 'msg') thread = await get(`/api/chat/threads/${it.thread_id}/messages`).catch(() => null);
    if (it && it.kind === 'req') thread = { req: await get(`/api/portal/requests/${it.request_id}/messages`).catch(() => []) };
    return { ...r, sel, it, thread };
  },
  render({ items, summary, it, thread }, q) {
    const mine = q.get('f') === 'mine', late = q.get('f') === 'late', cf = Number(q.get('c')) || null;
    const shown = items.filter((x) => (!mine || x.mine) && (!late || x.level === 'late') && (!cf || x.client_id === cf));
    const clientsList = [...new Map(items.map((x) => [x.client_id, x.client])).entries()];
    const st = (l, v, f, cls = '') => html`<div class="ibx-st"><span>${l}</span><b class="${cls}">${v}</b><small>${f}</small></div>`;
    const stats = html`<div class="ibx-stats">${st('Waiting on us', String(summary.waiting), summary.waiting ? `across ${plural(summary.clients, 'client')}` : 'all caught up')}${st('Late', String(summary.late), summary.late_clients.length ? summary.late_clients.join(', ') : 'past 4 hours', summary.late ? 'bad' : '')}${st('Typical first reply', summary.typical_reply_min == null ? '–' : waitText(summary.typical_reply_min), 'this week')}${st('Answered today', String(summary.answered_today), summary.answered_by ? `by ${plural(summary.answered_by, 'person', 'people')}` : 'nothing yet')}</div>`;
    const seg = (label, on, k, v) => html`<button type="button" data-act="q" ${raw(qAttr(k, v))} aria-current="${on ? 'page' : 'false'}">${label}</button>`;
    const filters = html`<div class="csub"><nav class="cseg" aria-label="Show">${seg(html`Everything <span>${items.length || ''}</span>`, !mine && !late, 'f', '')}${seg(html`Mine <span>${items.filter((x) => x.mine).length || ''}</span>`, mine, 'f', 'mine')}${seg(html`Late <span>${items.filter((x) => x.level === 'late').length || ''}</span>`, late, 'f', 'late')}</nav>
      ${clientsList.length > 1 ? html`<nav class="cseg" aria-label="Clients">${seg('All clients', !cf, 'c', '')}${clientsList.map(([id, n]) => seg(html`${clientMark(n, id, 18)}${short(n)}`, cf === id, 'c', String(id)))}</nav>` : ''}</div>`;
    const row = (x) => { const on = it && it.key === x.key; return html`<li><button type="button" class="qr${on ? ' on' : ''}" data-act="ibx-pick" data-key="${x.key}" data-k="ib${x.key}" ${on ? raw('aria-current="true"') : ''}>
      <span class="gly ${x.kind}">${icon(GLY[x.kind])}</span>
      <span class="qr-m"><b>${x.text}</b><span class="qr-c">${clientMark(x.client, x.client_id, 18)}${x.from ? `${x.from.name} · ` : ''}${short(x.client)}</span></span>
      <span class="qr-r">${waitChip(x)}${x.owner ? html`<span title="${x.owner.name} to answer">${staffAv(x.owner, 20)}</span>` : html`<span class="qr-none">Nobody yet</span>`}</span></button></li>`; };
    const queue = html`<section class="wq" aria-label="Waiting on us"><header><h2>Waiting on us <span>${shown.length || ''}</span></h2><span class="muted small">Oldest first</span></header>
      ${shown.length ? html`<ul class="wq-l">${shown.map(row)}</ul>` : html`<p class="wq-empty">${items.length ? 'Nothing here with these filters.' : 'Every message, request, comment and asked-for change from clients has an answer. New ones show up here as they come in.'}</p>`}
      <p class="wq-foot">Amber after 2 hours, red after 4. Answering clears it for everyone.</p></section>`;
    let center = html`<div class="pp pp-none">${empty('Nothing picked', 'Pick something on the left to answer it here.')}</div>`, rail = html`<aside class="wr"></aside>`;
    if (it) {
      const from = it.from ? { id: it.from.id || 0, name: it.from.name } : null;
      const msgs = thread && thread.messages ? thread.messages.slice(-8) : [];
      const reqm = thread && thread.req ? thread.req.slice(-8) : [];
      const staff = (m) => (m.mine ? null : m.author.kind === 'client' ? { id: m.author.id, name: m.author.name } : { id: m.author.id - 1000, name: m.author.name });
      const conv = it.kind === 'msg' ? msgs.map((m) => pbub(staff(m), m.body || (m.file ? m.file.name : ''), m.created_at, m.mine, m.team_only))
        : it.kind === 'req' ? html`${pbub(from, it.detail ? `${it.text}\n${it.detail}` : it.text, it.since, false)}${reqm.map((m) => pbub(staff(m), m.body, m.created_at, m.mine))}`
          : it.kind === 'cmt' && it.task && it.text.startsWith(`On “${it.task}”: `) ? pbub(from, it.text.slice(`On “${it.task}”: `.length), it.since, false)
            : pbub(from, it.detail ? `“${it.detail}”` : it.text, it.since, false);
      const first = it.from ? it.from.name.split(' ')[0] : short(it.client);
      const reply = it.kind === 'msg' ? html`<form class="pp-reply" data-submit="ibx-reply" data-kind="msg" data-id="${it.thread_id}"><input name="body" maxlength="4000" placeholder="Reply to ${first}" aria-label="Your reply" required><button class="btn primary" type="submit">${icon('chat')} Send</button></form>`
        : it.kind === 'req' ? html`<form class="pp-reply" data-submit="ibx-reply" data-kind="req" data-id="${it.request_id}"><input name="body" maxlength="2000" placeholder="Reply to ${first} about this request" aria-label="Your reply" required><button class="btn primary" type="submit">${icon('chat')} Send</button></form>`
          : it.kind === 'cmt' ? html`<form class="pp-reply" data-submit="ibx-reply" data-kind="cmt" data-id="${it.task_id}"><input name="body" maxlength="4000" placeholder="Answer on the task" aria-label="Your comment" required><button class="btn primary" type="submit">${icon('chat')} Comment</button></form>` : '';
      const where = `#/project?id=${it.project_id}&tab=client${it.kind === 'msg' ? `&ct=${it.thread_id}` : `&ci=${it.key}`}`;
      center = html`<div class="pp"><header class="pp-h"><div class="pp-k"><span class="gly ${it.kind}">${icon(GLY[it.kind])}</span><b class="${it.kind}">${it.kind === 'msg' ? (it.direct ? 'Direct message' : 'Whole team chat') : KIND[it.kind]}</b><span>${it.from ? `${it.from.name} · ` : ''}${short(it.client)} · ${it.project}</span>${waitChip(it)}</div><h2>${it.kind === 'cmt' && it.task ? it.task : it.text}</h2></header>
        <div class="pp-b">${conv}</div>
        <div class="pp-f">${reply}<div class="pp-acts"><a class="btn" href="${where}">${icon('folder')} Open in the project</a>${it.kind === 'ok' ? html`<button class="btn primary" data-act="client-version" data-id="${it.approval_id}" data-n="" data-title="${it.text}">${icon('up')} Send a new version</button>` : ''}<span class="pp-left">${it.kind === 'cmt' ? 'They see your name and “Amplify” on the task.' : `${first} sees your name and “Amplify”.`}</span></div></div></div>`;
      const also = items.filter((x) => x.client_id === it.client_id && x.key !== it.key);
      rail = html`<aside class="wr" aria-label="About this">
        ${it.from ? html`<section class="wr-s"><header><h3>Who sent it</h3></header><div class="wr-who">${cav(from, 40)}<div><b>${it.from.name}</b><span>${it.client}</span></div></div></section>` : ''}
        <section class="wr-s"><header><h3>${short(it.client)}</h3><a class="linkbtn" href="#/project?id=${it.project_id}&tab=client">Client tab</a></header><dl class="wr-dl"><dt>Project</dt><dd>${it.project}</dd><dt>Answered by</dt><dd>${it.owner ? it.owner.name : 'Nobody yet'}</dd><dt>Waiting</dt><dd>${waitText(it.waited_min)}</dd></dl></section>
        <section class="wr-s"><header><h3>Also from ${short(it.client)}</h3></header>${also.length ? html`<ul class="wr-l">${also.slice(0, 4).map((x) => html`<li><button type="button" class="linkbtn" data-act="ibx-pick" data-key="${x.key}">${x.text}</button><span class="muted">${waitText(x.waited_min)}</span></li>`)}</ul>` : html`<p class="muted small">Nothing else is waiting.</p>`}</section>
      </aside>`;
    }
    return html`<div class="page-h ibx-h"><div><h1>Client inbox</h1><p class="sub">Everything clients sent that still needs someone from Amplify, oldest first.</p></div>${stats}</div>
      ${filters}<div class="ws ws-ibx${it ? '' : ' none'}"><div class="ws-q">${queue}</div><div class="ws-c">${center}</div>${it ? html`<div class="ws-r">${rail}</div>` : ''}</div>`;
  },
};
actions['ibx-pick'] = (el) => {
  for (const b of document.querySelectorAll('.ws .qr.on')) b.classList.remove('on');
  const row = document.querySelector(`.ws .qr[data-key="${CSS.escape(el.dataset.key)}"]`); if (row) row.classList.add('on');
  const q = new URLSearchParams(location.hash.split('?')[1] || ''); q.set('i', el.dataset.key);
  location.hash = `#/inbox?${q}`;
  toPane();
};
const clientMark = (name, id, size) => html`<span class="cmark" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.36)}px;background:${avColor(1000 + id)}" aria-hidden="true">${marks(name)}</span>`;
const staffAv = (p, size) => html`<span class="avatar sm" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px;background:${avColor(p.id)}" aria-hidden="true">${initials(p.name)}</span>`;
actions['ibx-reply'] = async (f) => {
  const b = f.querySelector('button'); b.disabled = true;
  const body = f.body.value.trim(); if (!body) { b.disabled = false; return; }
  try {
    if (f.dataset.kind === 'msg') await post(`/api/chat/threads/${f.dataset.id}/messages`, { body });
    else if (f.dataset.kind === 'req') await post(`/api/portal/requests/${f.dataset.id}/messages`, { body });
    else await post(`/api/tasks/${f.dataset.id}/comments`, { body });
    f.body.value = ''; toast('Sent'); S.refresh();
  } catch (e) { toast(errMsg(e), true); } finally { b.disabled = false; }
};
