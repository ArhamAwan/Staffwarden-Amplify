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
  if (m < 2) return 'just now'; if (m < 60) return `${m} min ago`; if (m < 1440) { const h = Math.round(m / 60); return h === 1 ? 'an hour ago' : `${h} hours ago`; }
  const d = Math.round(m / 1440); return d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : day(iso);
};
const left = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86400000));
const COLORS = ['#1D4ED8', '#0F766E', '#B45309', '#7C3AED', '#BE185D', '#15803D', '#C2410C', '#4338CA'];
const colorOf = (s) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const PLAN = { starter: 'Starter', business: 'Business', pro: 'Pro' };
function statusPill(c) {
  if (c.comped) return '<span class="pill violet"><i></i>Free</span>';
  if (c.due_for_deletion) return '<span class="pill red"><i></i>Past its keep date</span>';
  if (c.status === 'trial') return `<span class="pill amber"><i></i>Trial, ${left(c.trial_ends_at) === 1 ? '1 day' : `${left(c.trial_ends_at)} days`} left</span>`;
  if (c.status === 'past_due') return `<span class="pill red"><i></i>Card declined${c.failed_at ? ` ${ago(c.failed_at)}` : ''}</span>`;
  if (c.status === 'paused') return '<span class="pill idle"><i></i>Paused</span>';
  if (c.status === 'closed') return '<span class="pill idle"><i></i>Closed</span>';
  if (c.closing_at) return `<span class="pill amber"><i></i>Closing ${day(c.closing_at)}</span>`;
  return `<span class="pill green"><i></i>${c.manual_billing ? 'Paying by transfer' : 'Paying'}</span>`;
}
const ICN = {
  money: 'M12 3v18M16.5 7.5c0-1.9-2-3-4.5-3s-4.5 1.2-4.5 3.2 2 2.8 4.5 3.3 4.5 1.3 4.5 3.4-2 3.1-4.5 3.1-4.5-1.1-4.5-3',
  co: 'M4 21V7l8-4 8 4v14M9 21v-6h6v6M8 10h.01M12 10h.01M16 10h.01',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', ppl: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21c0-3.9 3.1-7 7-7s7 3.1 7 7M17 3.5a4 4 0 0 1 0 7.5M22 21c0-3-1.8-5.4-4.5-6.4',
  back: 'M15 6l-6 6 6 6', chev: 'M9 6l6 6-6 6', search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4', mail: 'M4 6h16v12H4zM4 7l8 6 8-6', plus: 'M12 5v14M5 12h14',
  gift: 'M4 11h16v10H4zM2 7h20v4H2zM12 7v14M12 7S10 3 7.5 3 5 5.5 7 7M12 7s2-4 4.5-4S19 5.5 17 7', bank: 'M3 10l9-5 9 5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18',
  out: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11', trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3', open: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  ok: 'M5 12.5l4.5 4.5L19 7.5', card: 'M3 6h18v12H3zM3 10h18', warn: 'M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', pause: 'M8 5h3v14H8zM13 5h3v14h-3z', star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
};
const ic = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICN[k]}"/></svg>`;
let env = null;
const top = (right) => `<header class="st-top cn-top"><a class="st-mark" href="#/"><span class="ic">${owl('still')}</span><b>Staffwarden</b></a><span class="cn-tag">Owner console</span><span class="sp"></span>${right || ''}</header>`;

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


// ---------------- a few helpers for the pages ----------------
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// numbers count up from zero once, as the page arrives
function countUp(scope) {
  for (const el of scope.querySelectorAll('[data-count]')) {
    const to = Number(el.dataset.count), fmt = el.dataset.fmt === 'usd' ? usd : (n) => Math.round(n).toLocaleString('en-US');
    if (reduced() || !to) { el.textContent = fmt(to); continue; }
    const t0 = performance.now(), dur = 900;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(el.dataset.fmt === 'usd' ? Math.round(to * e) : to * e); if (k < 1) requestAnimationFrame(step); };
    el.textContent = fmt(0); requestAnimationFrame(step);
  }
}
function enter(main) { main.classList.remove('cn-in'); void main.offsetWidth; main.classList.add('cn-in'); setTimeout(() => main.classList.remove('cn-in'), 2200); countUp(main); }
function toast(msg, bad = false) {
  document.querySelectorAll('.cn-toast').forEach((t) => t.remove());
  const t = document.createElement('div'); t.className = `cn-toast${bad ? ' bad' : ''}`; t.setAttribute('role', 'status'); t.innerHTML = `<i></i>${esc(msg)}`;
  document.body.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 2800);
}
function confirmDlg({ title, text, word, action }) {
  return new Promise((resolve) => {
    const s = document.createElement('div'); s.className = 'cn-scrim';
    s.innerHTML = `<form class="cn-dlg" role="dialog" aria-modal="true" aria-labelledby="dl-h"><h2 id="dl-h">${esc(title)}</h2><p>${text}</p>
      ${word ? `<label class="faint" for="dl-w" style="font-size:13px">Type <b style="color:#fff">${esc(word)}</b> to confirm</label><input id="dl-w" autocomplete="off" autocapitalize="off" spellcheck="false">` : ''}
      <div class="row"><button type="button" class="cn-btn" data-no>Cancel</button><button type="submit" class="cn-btn danger" ${word ? 'disabled' : ''}>${esc(action)}</button></div></form>`;
    document.body.appendChild(s);
    const f = s.querySelector('form'), go = f.querySelector('[type=submit]'), w = f.querySelector('#dl-w');
    const done = (v) => { s.remove(); document.removeEventListener('keydown', esc_); resolve(v); };
    const esc_ = (e) => { if (e.key === 'Escape') done(false); };
    document.addEventListener('keydown', esc_);
    if (w) { w.focus(); w.addEventListener('input', () => { go.disabled = w.value.trim().toLowerCase() !== word; }); } else go.focus();
    f.querySelector('[data-no]').addEventListener('click', () => done(false));
    s.addEventListener('mousedown', (e) => { if (e.target === s) done(false); });
    f.addEventListener('submit', (e) => { e.preventDefault(); done(true); });
  });
}
const envChips = () => (env ? `<span class="cn-env${env.mail ? '' : ' off'}" title="${env.mail ? 'Sign-up codes, invites and receipts are emailed' : 'Set SMTP_HOST in /etc/workhelm.env to send email'}"><i></i>${env.mail ? 'Email on' : 'Email not set up'}</span><span class="cn-env${env.payments ? '' : ' off'}" title="${env.payments ? 'Card payments through Stripe' : 'Set the Stripe keys in /etc/workhelm.env'}"><i></i>${env.payments ? 'Cards on' : 'Cards not set up'}</span>` : '');
const signOut = '<button class="cn-btn" type="button" id="out" aria-label="Sign out">' + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/></svg>Sign out</button>';
// signing out ends the session on the server too, not just in this tab
function wireOut() { const b = $('#out'); if (b) b.addEventListener('click', () => { const t = token; setToken(null); if (t) fetch('/api/console/logout', { method: 'POST', headers: { Authorization: `Bearer ${t}` }, keepalive: true }).catch(() => {}); signIn(); }); }
function skeleton(detail) {
  root.innerHTML = `${top(signOut)}<main class="cn-wrap" aria-busy="true">${detail ? '<div class="sk" style="height:126px;border-radius:24px"></div>' : '<div class="sk" style="height:56px;width:320px"></div>'}
    <div class="kp">${'<div class="sk" style="height:132px;border-radius:20px"></div>'.repeat(4)}</div><div class="sk" style="height:${detail ? 140 : 420}px;border-radius:22px"></div></main>`;
}
const mon = (m) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
const hello = () => { const h = new Date().getHours(); return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

// ---------------- every company ----------------
let filter = 'all', find = '', sort = { key: 'created', dir: -1 }, lastOverview = null;
const SORTS = {
  name: (c) => c.name.toLowerCase(), status: (c) => (c.due_for_deletion ? 0 : c.status === 'past_due' ? 1 : c.status === 'trial' ? 2 : c.status === 'active' ? 3 : 4),
  people: (c) => c.seats || 0, month: (c) => c.monthly_cents || c.after_trial_cents || 0, created: (c) => c.created_at || '', used: (c) => c.last_used_at || '',
};
async function overview() {
  if (!lastOverview) skeleton(false);
  let d;
  try { d = await call('GET', '/api/console/overview'); } catch { return; }
  const first = !lastOverview; lastOverview = d; env = { mail: d.mail, payments: d.payments };
  document.title = 'Owner console · Staffwarden';
  const diff = d.paid_30d_cents - d.paid_prev_30d_cents;
  const groups = { all: d.companies, paying: d.companies.filter((c) => ['active', 'past_due'].includes(c.status) && !c.comped), trial: d.companies.filter((c) => c.status === 'trial'), attention: d.companies.filter((c) => c.status === 'past_due' || c.due_for_deletion) };
  const plans = {}; for (const c of groups.paying) plans[c.plan] = (plans[c.plan] || 0) + (c.seats || 0);
  const most = Object.entries(plans).sort((a, b) => b[1] - a[1])[0];
  const peak = Math.max(1, ...d.months.map((m) => m.paid_cents));
  const bars = `<div class="bars" aria-label="Paid each month">${d.months.map((m, i) => `<span class="${i === d.months.length - 1 ? 'now' : ''}" title="${mon(m.month)}: ${usd(m.paid_cents)}, ${m.signups} sign-up${m.signups === 1 ? '' : 's'}"><i class="${m.paid_cents ? '' : 'zero'}" style="height:${Math.max(3, Math.round((m.paid_cents / peak) * 50))}px;--i:${i}"></i>${mon(m.month)[0]}</span>`).join('')}</div>`;
  const signupsMonth = d.months[d.months.length - 1].signups;
  root.innerHTML = `${top(envChips() + signOut)}<main class="cn-wrap">
    <div class="cn-head rise" style="--i:0"><div><h1>${hello()}</h1><p>${d.companies.length === 1 ? 'One company is' : `${d.companies.length} companies are`} on Staffwarden. ${signupsMonth ? `${signupsMonth} signed up this month.` : 'No sign-ups yet this month.'}</p></div><span class="sp"></span><span class="cn-fresh"><i></i>Updated <span id="ago">just now</span></span><button class="cn-btn" type="button" id="reload">Refresh</button></div>
    <div class="kp">
      <div class="rise" style="--i:1"><div class="kp-h"><span class="cn-ic g">${ic('money')}</span>Money coming in each month</div><div class="money"><div><b class="num" data-count="${d.mrr_cents}" data-fmt="usd">${usd(d.mrr_cents)}</b>
        <div class="kp-s">${diff ? `<span class="${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '+' : '−'}${usd(Math.abs(diff))}</span> paid vs the 30 days before` : `${usd(d.paid_30d_cents)} paid in the last 30 days`}</div></div>${bars}</div></div>
      <div class="rise" style="--i:2"><div class="kp-h"><span class="cn-ic">${ic('co')}</span>Paying companies</div><b class="num" data-count="${d.paying}">${d.paying}</b><span class="kp-s">${d.attention ? `<span class="down">${d.attention} need${d.attention === 1 ? 's' : ''} you</span>` : 'Nothing needs you'}</span></div>
      <div class="rise" style="--i:3"><div class="kp-h"><span class="cn-ic a">${ic('clock')}</span>On a trial</div><b class="num" data-count="${d.trials}">${d.trials}</b><span class="kp-s">${d.trials_ending_week ? `${d.trials_ending_week} end${d.trials_ending_week === 1 ? 's' : ''} this week` : 'None end this week'}</span></div>
      <div class="rise" style="--i:4"><div class="kp-h"><span class="cn-ic b">${ic('ppl')}</span>People paid for</div><b class="num" data-count="${d.people}">${d.people}</b><span class="kp-s">${most ? `Most on ${PLAN[most[0]]}` : 'None yet'}</span></div>
    </div>
    <section class="panel rise" style="--i:5">
      <div class="pn-h"><h2>Companies</h2><div class="seg" role="group" aria-label="Show"><span class="ind" aria-hidden="true"></span>${[['all', 'All'], ['paying', 'Paying'], ['trial', 'Trial'], ['attention', 'Needs attention']].map(([k, t]) => `<button type="button" data-f="${k}" aria-pressed="${filter === k}" class="${k === 'attention' && groups[k].length ? 'hot' : ''}">${t}<i>${groups[k].length}</i></button>`).join('')}</div>
        <span class="sp"></span><label class="cn-search">${ic('search')}<span class="sr">Find a company</span><input id="find" type="search" placeholder="Find a company or owner" value="${esc(find)}" autocomplete="off"></label></div>
      <div class="tw" id="list"></div>
      <p class="cn-note">You see each company’s account and billing only. Their people’s hours, screenshots and pay can’t be opened from here.</p>
    </section></main>`;
  wireOut();
  const main = $('.cn-wrap');
  const draw = (animate) => {
    const q = find.trim().toLowerCase();
    const mark = (t) => (q ? esc(t).replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>') : esc(t));
    const list = groups[filter].filter((c) => !q || `${c.name} ${c.slug} ${c.owner_email} ${c.owner_name}`.toLowerCase().includes(q))
      .sort((a, b) => { const x = SORTS[sort.key](a), y = SORTS[sort.key](b); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; });
    const th = (k, t, cls = '') => `<th class="${cls}"><button type="button" data-sort="${k}"${sort.key === k ? ` aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${t}${sort.key === k ? `<em>${sort.dir > 0 ? '▲' : '▼'}</em>` : ''}</button></th>`;
    $('#list').innerHTML = list.length ? `<table class="t"><thead><tr>${th('name', 'Company')}<th>Plan</th>${th('status', 'Status')}${th('people', 'People', 'r')}${th('month', 'A month', 'r')}${th('created', 'Signed up')}${th('used', 'Last used')}<th></th></tr></thead><tbody>${list.map((c, i) => {
      const trialPct = c.status === 'trial' && c.trial_ends_at ? Math.min(100, Math.max(4, 100 - (left(c.trial_ends_at) / (c.trial_days || 14)) * 100)) : null;
      return `<tr class="go" data-slug="${esc(c.slug)}" tabindex="0" style="--i:${Math.min(i, 14)}">
      <td><div class="co"><span class="lg" style="background:${colorOf(c.slug)}">${esc((c.name.trim()[0] || '?').toUpperCase())}</span><div><b>${mark(c.name)}</b><span>${mark(c.address)}${c.owner_name ? `, ${mark(c.owner_name)}` : ''}</span></div></div></td>
      <td><span class="plan ${c.plan}">${c.comped ? 'Free' : PLAN[c.plan] || ''}${c.interval === 'month' && !c.comped ? ', monthly' : ''}</span></td>
      <td><span class="cn-st">${statusPill(c)}${trialPct != null ? `<span class="tbar" aria-hidden="true"><i style="width:${trialPct}%"></i></span>` : ''}</span></td>
      <td class="r num">${c.seats || 0}</td>
      <td class="r num">${c.monthly_cents ? usd(c.monthly_cents) : c.after_trial_cents ? `<span class="faint">${usd(c.after_trial_cents)} after trial</span>` : '<span class="faint">nothing</span>'}</td>
      <td>${day(c.created_at)}</td><td>${esc(ago(c.last_used_at))}</td><td class="ch">${ic('chev')}</td></tr>`; }).join('')}</tbody></table>`
      : `<div class="empty"><b>${q ? `Nothing matches “${esc(find)}”` : filter === 'attention' ? 'Nothing needs you' : filter === 'paying' ? 'No paying companies yet' : filter === 'trial' ? 'No trials right now' : 'No companies yet'}</b>${q ? 'Check the spelling, or clear the search.' : filter === 'all' ? 'Companies appear here as soon as they sign up.' : ''}</div>`;
    // a new filter: only the rows settle in again; the rest of the page stays still
    if (animate) { const l = $('#list'); l.classList.remove('rows-in'); void l.offsetWidth; l.classList.add('rows-in'); setTimeout(() => l.classList.remove('rows-in'), 900); }
  };
  const slide = () => { const on = root.querySelector('.seg [aria-pressed="true"]'), ind = root.querySelector('.seg .ind'); if (on && ind) { ind.style.left = `${on.offsetLeft}px`; ind.style.width = `${on.offsetWidth}px`; } };
  draw(false); slide();
  if (first) enter(main); else countUp(main);
  root.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; root.querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); slide(); draw(true); }));
  $('#find').addEventListener('input', (e) => { find = e.target.value; draw(false); });
  $('#list').addEventListener('click', (e) => {
    const s = e.target.closest('[data-sort]'); if (s) { sort = sort.key === s.dataset.sort ? { key: s.dataset.sort, dir: -sort.dir } : { key: s.dataset.sort, dir: s.dataset.sort === 'name' ? 1 : -1 }; draw(false); return; }
    const r = e.target.closest('[data-slug]'); if (r) location.hash = `#/c/${r.dataset.slug}`;
  });
  $('#list').addEventListener('keydown', (e) => { const r = e.target.closest('[data-slug]'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); location.hash = `#/c/${r.dataset.slug}`; } });
  $('#reload').addEventListener('click', () => overview());
  const t0 = Date.now(); clearInterval(window.cnAgo); window.cnAgo = setInterval(() => { const a = $('#ago'); if (!a) return clearInterval(window.cnAgo); const m = Math.floor((Date.now() - t0) / 60000); a.textContent = m < 1 ? 'just now' : `${m} min ago`; }, 30000);
}

// ---------------- one company ----------------
const EVENT = {
  created: ['Signed up', 'star', ''], 'checkout.started': ['Opened checkout', 'card', ''], 'card.added': ['Added a card', 'card', 'g'], active: ['Active', 'ok', 'g'], paused: ['Paused', 'pause', 'r'],
  past_due: ['Card declined', 'warn', 'r'], closed: ['Closed', 'out', 'r'], closing: ['Asked to close', 'out', 'a'], reopened: ['Kept the account', 'ok', 'g'], 'plan.chosen': ['Chose a plan', 'star', ''],
  'plan.scheduled': ['Moving plan at renewal', 'clock', 'a'], 'plan.changed': ['Changed plan', 'star', ''], seats: ['People paid for', 'ppl', ''], extended: ['Given more days', 'gift', 'a'],
  flags: ['Billing changed', 'bank', ''], removed: ['Removed', 'trash', 'r'], renamed: ['Renamed', 'co', ''], 'owner.changed': ['New owner', 'ppl', ''],
};
function lifecycle(c) {
  // the account's life on one line: signed up, the trial or what's paid, and when data would go
  const pts = [{ at: c.created_at, label: 'Signed up', cls: 'past' }];
  if (c.status === 'trial' && c.trial_ends_at) pts.push({ at: c.trial_ends_at, label: 'Trial ends', cls: 'warn' });
  if (c.paused_at) pts.push({ at: c.paused_at, label: 'Paused', cls: 'bad past' });
  if (c.closing_at) pts.push({ at: c.closing_at, label: 'Closes', cls: 'warn' });
  if (c.delete_after) pts.push({ at: c.delete_after, label: 'Data deleted', cls: 'bad' });
  if (pts.length < 2) return '';
  const t = pts.map((p) => Date.parse(p.at)), lo = Math.min(...t, Date.now()), hi = Math.max(...t, Date.now() + 86400000), pos = (x) => ((x - lo) / (hi - lo)) * 100;
  const nowPos = pos(Date.now());
  return `<section class="panel life rise" style="--i:2"><h2>The account so far</h2><div class="life-line" role="img" aria-label="${esc(pts.map((p) => `${p.label} ${day(p.at)}`).join(', '))}">
    <span class="life-fill" style="width:${nowPos}%"></span>
    ${pts.map((p, i) => `<span class="life-pt ${p.cls} ${Date.parse(p.at) <= Date.now() ? 'past' : ''} ${i === 0 ? 'first' : i === pts.length - 1 && pos(Date.parse(p.at)) > 88 ? 'last' : ''}" style="left:${pos(Date.parse(p.at))}%"><i></i><span><b>${p.label}</b>${day(p.at)}</span></span>`).join('')}
    ${nowPos > 4 && nowPos < 96 ? `<span class="life-now" style="left:${nowPos}%"></span>` : ''}</div></section>`;
}
async function company(slug, again = false) {
  if (!again) skeleton(true);
  let c;
  try { c = await call('GET', `/api/console/companies/${encodeURIComponent(slug)}`); } catch (e) { root.innerHTML = `${top(signOut)}<main class="cn-wrap"><a class="cn-back" href="#/">${ic('back')}All companies</a><div class="empty"><b>${esc(e.message)}</b></div></main>`; wireOut(); return; }
  document.title = `${c.name} · Owner console`;
  const paid = c.payments.filter((p) => p.status === 'paid').length, waiting = c.payments.filter((p) => p.status !== 'paid').length;
  const canExtend = c.status === 'trial' || c.status === 'past_due' || (c.status === 'paused' && !c.comped);
  const first = (c.owner_name || 'the owner').split(' ')[0];
  root.innerHTML = `${top(envChips() + signOut)}<main class="cn-wrap">
    <a class="cn-back rise" style="--i:0" href="#/">${ic('back')}All companies</a>
    <section class="hero rise" style="--i:1"><span class="lg" style="background:${colorOf(c.slug)}">${esc((c.name.trim()[0] || '?').toUpperCase())}</span>
      <div class="t"><h1>${esc(c.name)} ${statusPill(c)}</h1><p class="meta"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.address)}</a><span>${esc(c.owner_name || '')}, ${esc(c.owner_email || '')}</span><span>${esc(c.country || '')}</span></p></div>
      <div class="acts"><a class="cn-btn pri" href="mailto:${esc(c.owner_email)}">${ic('mail')}Email ${esc(first)}</a>
        ${canExtend ? `<button class="cn-btn" type="button" data-a="extend">${ic('plus')}Give 7 more days</button>` : ''}
        <button class="cn-btn" type="button" data-a="comp">${ic('gift')}${c.comped ? 'Stop it being free' : 'Make it free'}</button>
        <button class="cn-btn" type="button" data-a="man">${ic('bank')}${c.manual_billing ? 'Stop bank transfer' : 'Paid by bank transfer'}</button>
        ${c.due_for_deletion ? `<button class="cn-btn danger" type="button" data-a="remove">${ic('trash')}Remove</button>` : ''}</div></section>
    <div class="kp">
      <div class="rise" style="--i:2"><div class="kp-h"><span class="cn-ic">${ic('star')}</span>Plan</div><b class="w">${c.comped ? 'Free' : PLAN[c.plan]}</b><span class="kp-s">${c.comped ? 'Every feature, nothing charged' : `Paid ${c.interval}ly`}</span></div>
      <div class="rise" style="--i:3"><div class="kp-h"><span class="cn-ic b">${ic('ppl')}</span>People paid for</div><b class="num" data-count="${c.seats || 0}">${c.seats || 0}</b><span class="kp-s">${c.monthly_cents ? `${usd(c.monthly_cents)} a month` : c.after_trial_cents ? `${usd(c.after_trial_cents)} a month after the trial` : 'Nothing charged now'}</span></div>
      <div class="rise" style="--i:4"><div class="kp-h"><span class="cn-ic g">${ic('money')}</span>Paid so far</div><b class="num" data-count="${c.paid_total_cents}" data-fmt="usd">${usd(c.paid_total_cents)}</b><span class="kp-s">${paid} payment${paid === 1 ? '' : 's'}${waiting ? `, ${waiting} declined` : ''}</span></div>
      <div class="rise" style="--i:5"><div class="kp-h"><span class="cn-ic a">${ic('clock')}</span>Last used</div><b class="w">${esc(ago(c.last_used_at).replace(/^./, (x) => x.toUpperCase()))}</b><span class="kp-s">${c.tracked_today ? `${c.tracked_today} tracked time in the last day` : 'Nobody tracked time in the last day'}</span></div>
    </div>
    ${lifecycle(c)}
    <div class="cn-cols">
      <div class="cn-col">
        <section class="panel rise" style="--i:6"><h2>Payments</h2>${c.payments.length ? `<div class="tw"><table class="t"><thead><tr><th>Date</th><th>What</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>${c.payments.map((p) => `<tr><td>${day(p.at)}</td><td>${esc(p.description || '')}</td><td class="r num">${usd(p.amount_cents)}</td><td>${p.status === 'paid' ? '<span class="pill green"><i></i>Paid</span>' : '<span class="pill red"><i></i>Declined</span>'}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty" style="padding:18px 8px"><b>No payments yet</b>${c.status === 'trial' ? `Their first bill comes when the trial ends, ${day(c.trial_ends_at)}.` : ''}</div>`}</section>
        <section class="panel rise" style="--i:7"><h2>Emails sent</h2>${c.mail.length ? `<ul class="mails">${c.mail.map((m) => `<li class="${m.ok ? '' : 'bad'}"><span class="cn-ev ${m.ok ? '' : 'r'}">${ic('mail')}</span><span class="k">${esc(m.kind.replace(/_/g, ' '))}</span><span class="to">${esc(m.to_addr)}${m.ok ? '' : `, failed: ${esc(m.error || '')}`}</span><time>${day(m.at)}</time></li>`).join('')}</ul>` : '<p class="cn-note">None yet.</p>'}</section>
      </div>
      <div class="cn-col">
        <section class="panel rise" style="--i:6"><h2>What happened</h2><ol class="tl">${c.events.map((e, i) => { const [label, icon, tone] = EVENT[e.kind] || [e.kind, 'star', '']; return `<li style="--i:${Math.min(i, 12)}"><span class="cn-ev ${tone}">${ic(icon)}</span><div><b>${esc(label)}</b>${e.detail ? `<small>${esc(e.detail)}</small>` : ''}</div><time>${day(e.at)}</time></li>`; }).join('')}</ol></section>
        <section class="panel rise" style="--i:7"><h2>Their data</h2><p class="cn-note" style="font-size:14px;color:var(--ink2)">You see usage and billing only. ${esc(c.name)}’s hours, screenshots, pay and messages stay in their own database and can’t be opened from this console.</p>
          ${c.delete_after ? `<p class="cn-note">Kept until ${day(c.delete_after)}.${c.due_for_deletion ? ' Past that date: Remove moves its folder out of the service; nothing is erased here.' : ''}</p>` : ''}</section>
      </div>
    </div></main>`;
  wireOut();
  const main = $('.cn-wrap');
  if (!again) enter(main); else countUp(main);
  const act = async (btn, path, body, done) => {
    btn.disabled = true;
    try { await call('POST', `/api/console/companies/${encodeURIComponent(slug)}/${path}`, body); toast(done); lastOverview = null; await company(slug, true); }
    catch (e) { btn.disabled = false; toast(e.message, true); }
  };
  root.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', async () => {
    const a = b.dataset.a;
    if (a === 'extend') return act(b, 'extend', { days: 7 }, `${c.name} has 7 more days`);
    if (a === 'comp') return act(b, 'flags', { comped: !c.comped }, c.comped ? `${c.name} pays again from its next bill` : `${c.name} is free now`);
    if (a === 'man') return act(b, 'flags', { manual_billing: !c.manual_billing }, c.manual_billing ? `${c.name} pays by card again` : `${c.name} pays by bank transfer`);
    if (a === 'remove' && await confirmDlg({ title: `Remove ${c.name}?`, text: `Its folder moves out of the service, to <b>removed/</b> on the server. It isn’t erased: you can still restore it by hand.`, word: c.slug, action: 'Remove the company' })) {
      b.disabled = true;
      try { await call('POST', `/api/console/companies/${encodeURIComponent(slug)}/remove`, { confirm: c.slug }); toast(`${c.name} was removed`); lastOverview = null; location.hash = '#/'; }
      catch (e) { b.disabled = false; toast(e.message, true); }
    }
  }));
}

function route() {
  if (!token) return signIn();
  const m = /^#\/c\/([a-z0-9-]+)/.exec(location.hash);
  window.scrollTo(0, 0);
  return m ? company(m[1]) : overview();
}
window.addEventListener('hashchange', route);
document.getElementById('st').classList.add('cn');
route();
