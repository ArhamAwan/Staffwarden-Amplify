// Your console at admin.<domain>: the companies on Staffwarden, what they pay and whether anything needs
// you. Signing in takes a code sent to an address listed in PLATFORM_ADMINS. It shows accounts and billing
// only: nothing inside a company (hours, screenshots, pay) is reachable from here.
import { owl } from './util.js';

const root = document.getElementById('st');
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
const $ = (s) => root.querySelector(s);
let token = null;
try { token = sessionStorage.getItem('sw-console'); } catch { /* private window */ }
const setToken = (t) => { token = t; try { if (t) sessionStorage.setItem('sw-console', t); else sessionStorage.removeItem('sw-console'); } catch { /* fine */ } };
async function call(method, url, body) {
  let res;
  try { res = await fetch(url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); }
  catch { throw new Error('Can’t reach the server.'); }
  const d = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith('/login')) { setToken(null); signIn(); throw new Error('Sign in again'); }
  if (!res.ok) { const e = new Error(d.error || `Something went wrong (${res.status})`); e.status = res.status; throw e; }
  return d;
}
const usd = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '–');
const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 2) return 'just now'; if (m < 60) return `${m} min ago`; if (m < 1440) return `${Math.round(m / 60)} hours ago`;
  const d = Math.round(m / 1440); return d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : day(iso);
};
const left = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86400000));
const COLORS = ['#1D4ED8', '#0F766E', '#B45309', '#7C3AED', '#BE185D', '#15803D', '#C2410C', '#4338CA'];
const colorOf = (s) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const PLAN = { starter: 'Starter', business: 'Business', pro: 'Pro' };
function statusPill(c) {
  if (c.comped) return '<span class="pill violet">Free</span>';
  if (c.due_for_deletion) return '<span class="pill red">Past its keep date</span>';
  if (c.status === 'trial') return `<span class="pill amber">Trial, ${left(c.trial_ends_at)} days left</span>`;
  if (c.status === 'past_due') return `<span class="pill red">Card declined${c.failed_at ? ` ${ago(c.failed_at)}` : ''}</span>`;
  if (c.status === 'paused') return '<span class="pill idle">Paused</span>';
  if (c.status === 'closed') return '<span class="pill idle">Closed</span>';
  if (c.closing_at) return `<span class="pill amber">Closing ${day(c.closing_at)}</span>`;
  return `<span class="pill green">${c.manual_billing ? 'Paying by transfer' : 'Paying'}</span>`;
}
const top = (right) => `<header class="st-top cn-top"><a class="st-mark" href="#/"><span class="ic">${owl('still')}</span><b>Staffwarden</b></a><span class="pill violet">Owner console</span><span class="sp"></span>${right || ''}</header>`;

// ---------------- signing in ----------------
function signIn(email = '') {
  document.title = 'Owner console · Staffwarden';
  root.innerHTML = `${top()}<main class="st-main" style="justify-content:center"><section class="st-card narrow st-in">
    <div><h2>Owner console</h2><p class="sub">For the people who run Staffwarden. We email a code to your address.</p></div>
    <form id="f" novalidate style="display:contents"><div class="field"><label for="em">Email</label><input id="em" class="inp" type="email" autocomplete="username" value="${esc(email)}" required autofocus></div>
    <p class="err" role="alert"></p><button class="btn pri wide big" type="submit">Email me a code</button></form></section></main>`;
  $('#em').focus();
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#em').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { $('.err').textContent = 'That doesn’t look like an email address.'; return; }
    try { await call('POST', '/api/console/code', { email: v }); code(v); } catch (ex) { $('.err').textContent = ex.message; }
  });
}
function code(email) {
  root.innerHTML = `${top()}<main class="st-main" style="justify-content:center"><section class="st-card narrow st-in">
    <div><h2>Enter the code</h2><p class="sub">If ${esc(email)} may open the console, a 6-digit code is on its way. It works for 10 minutes.</p></div>
    <form id="f" novalidate style="display:contents"><div class="field"><label for="cd">Code</label><input id="cd" class="inp" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required autofocus></div>
    <p class="err" role="alert"></p><button class="btn pri wide big" type="submit">Open the console</button></form>
    <button type="button" class="link" id="back" style="align-self:center">Use another email</button></section></main>`;
  $('#cd').focus();
  $('#back').addEventListener('click', () => signIn(email));
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await call('POST', '/api/console/login', { email, code: $('#cd').value }); setToken(r.token); location.hash = '#/'; route(); }
    catch (ex) { $('.err').textContent = ex.message; }
  });
}

// ---------------- every company ----------------
let filter = 'all', find = '';
async function overview() {
  let d;
  try { d = await call('GET', '/api/console/overview'); } catch { return; }
  document.title = 'Owner console · Staffwarden';
  const diff = d.paid_30d_cents - d.paid_prev_30d_cents;
  const groups = { all: d.companies, paying: d.companies.filter((c) => ['active', 'past_due'].includes(c.status) && !c.comped), trial: d.companies.filter((c) => c.status === 'trial'), attention: d.companies.filter((c) => c.status === 'past_due' || c.due_for_deletion) };
  const plans = {}; for (const c of groups.paying) plans[c.plan] = (plans[c.plan] || 0) + (c.seats || 0);
  const most = Object.entries(plans).sort((a, b) => b[1] - a[1])[0];
  root.innerHTML = `${top(`<span class="muted" style="font-size:13.5px">${esc(location.host)}${d.mail ? '' : ', email not set up'}${d.payments ? '' : ', card payments not set up'}</span><button class="btn sm" type="button" id="out">Sign out</button>`)}
  <main class="cn-main">
    <div class="kp">
      <div><small>Money coming in each month</small><b class="num">${usd(d.mrr_cents)}</b><span>${diff ? `<span class="${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '+' : '−'}${usd(Math.abs(diff))}</span> paid in the last 30 days vs the 30 before` : `${usd(d.paid_30d_cents)} paid in the last 30 days`}</span></div>
      <div><small>Paying companies</small><b class="num">${d.paying}</b><span>${d.attention ? `${d.attention} need${d.attention === 1 ? 's' : ''} attention` : 'Nothing needs you'}</span></div>
      <div><small>On a trial</small><b class="num">${d.trials}</b><span>${d.trials_ending_week} end${d.trials_ending_week === 1 ? 's' : ''} this week</span></div>
      <div><small>People paid for</small><b class="num">${d.people}</b><span>${most ? `Most on ${PLAN[most[0]]}` : 'None yet'}</span></div>
    </div>
    <section class="panel">
      <div class="pn-h"><h2>Companies</h2><div class="seg" role="group" aria-label="Show">${[['all', 'All'], ['paying', 'Paying'], ['trial', 'Trial'], ['attention', 'Needs attention']].map(([k, t]) => `<button type="button" data-f="${k}" aria-pressed="${filter === k}">${t} <i>${groups[k].length}</i></button>`).join('')}</div><span class="sp"></span><input class="find" id="find" type="search" placeholder="Find a company" aria-label="Find a company" value="${esc(find)}"></div>
      <div class="tw" id="list"></div>
      <p class="faint" style="margin:0;font-size:13px">You see each company’s account and billing only. Their people’s hours, screenshots and pay can’t be opened from here.</p>
    </section>
  </main>`;
  const draw = () => {
    const q = find.trim().toLowerCase();
    const list = groups[filter].filter((c) => !q || `${c.name} ${c.slug} ${c.owner_email}`.toLowerCase().includes(q));
    $('#list').innerHTML = list.length ? `<table class="t"><thead><tr><th>Company</th><th>Plan</th><th>Status</th><th class="r">People</th><th class="r">A month</th><th>Signed up</th><th>Last used</th></tr></thead><tbody>${list.map((c) => `<tr class="go" data-slug="${esc(c.slug)}" tabindex="0">
      <td><div class="co"><span class="lg" style="background:${colorOf(c.slug)}">${esc((c.name.trim()[0] || '?').toUpperCase())}</span><div><b>${esc(c.name)}</b><span>${esc(c.address)}</span></div></div></td>
      <td>${PLAN[c.plan] || ''}${c.interval === 'month' ? ', monthly' : ''}</td><td>${statusPill(c)}</td><td class="r num">${c.seats || 0}</td>
      <td class="r num">${c.monthly_cents ? usd(c.monthly_cents) : c.after_trial_cents ? `<span class="faint">${usd(c.after_trial_cents)} after trial</span>` : '<span class="faint">nothing</span>'}</td>
      <td>${day(c.created_at)}</td><td>${esc(ago(c.last_used_at))}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No companies here.</p>';
  };
  draw();
  root.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; root.querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); draw(); }));
  $('#find').addEventListener('input', (e) => { find = e.target.value; draw(); });
  $('#list').addEventListener('click', (e) => { const r = e.target.closest('[data-slug]'); if (r) location.hash = `#/c/${r.dataset.slug}`; });
  $('#list').addEventListener('keydown', (e) => { const r = e.target.closest('[data-slug]'); if (r && e.key === 'Enter') location.hash = `#/c/${r.dataset.slug}`; });
  $('#out').addEventListener('click', () => { setToken(null); signIn(); });
}

// ---------------- one company ----------------
const EVENT = { created: 'Signed up', 'checkout.started': 'Opened checkout', 'card.added': 'Added a card', active: 'Active', paused: 'Paused', past_due: 'Card declined', closed: 'Closed', closing: 'Asked to close', reopened: 'Kept the account', 'plan.chosen': 'Chose a plan', 'plan.scheduled': 'Moving plan at renewal', 'plan.changed': 'Changed plan', seats: 'People paid for', extended: 'Given more days', flags: 'Billing changed', removed: 'Removed', renamed: 'Renamed', 'owner.changed': 'New owner' };
async function company(slug) {
  let c;
  try { c = await call('GET', `/api/console/companies/${encodeURIComponent(slug)}`); } catch (e) { root.innerHTML = `${top('<a href="#/">All companies</a>')}<main class="cn-main"><p class="err-l">${esc(e.message)}</p></main>`; return; }
  document.title = `${c.name} · Owner console`;
  const paid = c.payments.filter((p) => p.status === 'paid').length, waiting = c.payments.filter((p) => p.status !== 'paid').length;
  const canExtend = c.status === 'trial' || c.status === 'past_due' || (c.status === 'paused' && !c.comped);
  root.innerHTML = `${top('<a href="#/" style="font-weight:650;text-decoration:none">All companies</a>')}
  <main class="cn-main">
    <section class="cn-head"><span class="lg" style="background:${colorOf(c.slug)}">${esc((c.name.trim()[0] || '?').toUpperCase())}</span>
      <div class="t"><h1>${esc(c.name)}</h1><p>${esc(c.address)}, owner ${esc(c.owner_name || '')}, ${esc(c.owner_email || '')}, ${esc(c.country || '')}</p></div>
      ${statusPill(c)}<a class="btn sm" href="mailto:${esc(c.owner_email)}">Email ${esc((c.owner_name || 'the owner').split(' ')[0])}</a>
      ${canExtend ? '<button class="btn sm" type="button" id="ext">Give 7 more days</button>' : ''}
      <button class="btn sm" type="button" id="comp">${c.comped ? 'Stop it being free' : 'Make it free'}</button>
      <button class="btn sm" type="button" id="man">${c.manual_billing ? 'Stop bank transfer' : 'Paid by bank transfer'}</button>
      ${c.due_for_deletion ? '<button class="btn sm" type="button" id="rm" style="color:#FF9B85">Remove</button>' : ''}</section>
    <p class="err-l" role="alert" id="err"></p>
    <div class="kp">
      <div><small>Plan</small><b class="w">${c.comped ? 'Free' : PLAN[c.plan]}</b><span>${c.comped ? 'Every feature' : `Paid ${c.interval}ly`}</span></div>
      <div><small>People paid for</small><b class="num">${c.seats || 0}</b><span>${c.monthly_cents ? `${usd(c.monthly_cents)} a month` : 'Nothing charged now'}</span></div>
      <div><small>Paid so far</small><b class="num">${usd(c.paid_total_cents)}</b><span>${paid} payment${paid === 1 ? '' : 's'}${waiting ? `, ${waiting} waiting` : ''}</span></div>
      <div><small>Last used</small><b class="w">${esc(ago(c.last_used_at))}</b><span>${c.tracked_today} tracked in the last day</span></div>
    </div>
    <div class="cn-cols">
      <section class="panel"><h2>Payments</h2>${c.payments.length ? `<div class="tw"><table class="t"><thead><tr><th>Date</th><th>What</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>${c.payments.map((p) => `<tr><td>${day(p.at)}</td><td>${esc(p.description || '')}</td><td class="r num">${usd(p.amount_cents)}</td><td>${p.status === 'paid' ? '<span class="pill green">Paid</span>' : '<span class="pill red">Declined</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No payments yet.</p>'}
        <h2>Emails sent</h2>${c.mail.length ? `<ol class="log">${c.mail.map((m) => `<li><time>${day(m.at)}</time><span>${esc(m.kind.replace(/_/g, ' '))} to ${esc(m.to_addr)}${m.ok ? '' : `, failed: ${esc(m.error || '')}`}</span></li>`).join('')}</ol>` : '<p class="empty">None yet.</p>'}</section>
      <div style="display:flex;flex-direction:column;gap:18px">
        <section class="panel"><h2>What happened</h2><ol class="log">${c.events.map((e) => `<li><time>${day(e.at)}</time><span>${esc(EVENT[e.kind] || e.kind)}${e.detail ? `: ${esc(e.detail)}` : ''}</span></li>`).join('')}</ol></section>
        <section class="panel"><h2>Their data</h2><p class="muted" style="margin:0;line-height:1.55">You see usage and billing only. ${esc(c.name)}’s hours, screenshots, pay and messages stay in their own database and can’t be opened from this console.</p>
          ${c.delete_after ? `<p class="muted" style="margin:0">Kept until ${day(c.delete_after)}${c.due_for_deletion ? '. Past that date: removing moves its folder out of the service; it isn’t erased here.' : '.'}</p>` : ''}</section>
      </div>
    </div>
  </main>`;
  const act = async (path, body) => { try { await call('POST', `/api/console/companies/${encodeURIComponent(slug)}/${path}`, body); company(slug); } catch (e) { $('#err').textContent = e.message; } };
  if ($('#ext')) $('#ext').addEventListener('click', () => act('extend', { days: 7 }));
  $('#comp').addEventListener('click', () => act('flags', { comped: !c.comped }));
  $('#man').addEventListener('click', () => act('flags', { manual_billing: !c.manual_billing }));
  if ($('#rm')) $('#rm').addEventListener('click', () => { const v = prompt(`Type ${c.slug} to remove ${c.name} from the service`); if (v) act('remove', { confirm: v }).then(() => { location.hash = '#/'; }); });
}

function route() {
  if (!token) return signIn();
  const m = /^#\/c\/([a-z0-9-]+)/.exec(location.hash);
  return m ? company(m[1]) : overview();
}
window.addEventListener('hashchange', route);
route();
