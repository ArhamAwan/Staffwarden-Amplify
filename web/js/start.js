// The plain address's own pages: start a free trial (you, the code, your company), find your company by
// email, and forgot password. Each company lives at its own address, so these pages end by sending the
// person there: the new owner signed in by a one-time code, everyone else to their company's sign-in.
import { owl } from './util.js';

const root = document.getElementById('st');
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
const $ = (sel) => root.querySelector(sel);
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const MAIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v12H4z"/><path d="M4 7l8 6 8-6"/></svg>';
const CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const MINI = owl('still');

async function call(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch { throw new Error('Can’t reach Staffwarden. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Something went wrong (${res.status})`); e.status = res.status; throw e; }
  return data;
}
const store = {
  get() { try { return JSON.parse(sessionStorage.getItem('sw-signup') || 'null'); } catch { return null; } },
  set(v) { try { if (v) sessionStorage.setItem('sw-signup', JSON.stringify(v)); else sessionStorage.removeItem('sw-signup'); } catch { /* private window */ } },
};
const busy = (btn, on, label) => {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin" aria-hidden="true"></span>${esc(label || 'One moment')}`; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
};
const showErr = (msg) => { const e = $('.err'); if (e) e.textContent = msg || ''; };

let cfg = { base_domain: 'staffwarden.com', trial_days: 14, countries: [], plans: [] };
const cfgReady = call('GET', '/api/platform/config').then((c) => { cfg = c; }).catch(() => { /* the defaults do */ });

function page({ right, story, cardClass = '', foot = '' }) {
  root.innerHTML = `<header class="st-top"><a class="st-mark" href="/welcome" aria-label="Staffwarden home"><span class="ic">${MINI}</span><b>Staffwarden</b></a><span class="st-top-r">${right || ''}</span></header>
    <main class="st-main">${story}<section class="st-card st-in ${cardClass}">${cardHtml}</section></main>${foot ? `<p class="st-foot">${foot}</p>` : ''}`;
}
let cardHtml = '';
function show(opts, card) { cardHtml = card; page(opts); const f = root.querySelector('[autofocus]'); if (f && matchMedia('(min-width: 981px)').matches) f.focus(); }
const steps = (n) => `<ol class="steps" aria-label="Step ${n} of 3">${['You', 'Your company', 'Your people'].map((s, i) => `<li class="${i + 1 < n ? 'done' : i + 1 === n ? 'on' : ''}"${i + 1 === n ? ' aria-current="step"' : ''}><i></i>${s}</li>`).join('')}</ol>`;
const haveAccount = '<span class="opt">Already have an account? </span><a href="/signin">Sign in</a>';

// ---------------- start a free trial ----------------
function signupYou(prefill = {}) {
  document.title = 'Start a free trial · Staffwarden';
  show({
    right: haveAccount,
    story: `<section class="st-story"><h1>Your team, set up before your coffee cools.</h1>
      <p class="lede">Make your company’s space, invite your people and watch the first hours come in. Everything is open for ${cfg.trial_days || 14} days.</p>
      <ul class="checks hide-sm"><li class="check">${CHECK}No card until you decide to stay</li><li class="check">${CHECK}Every feature, every plan, during the trial</li><li class="check">${CHECK}Your company’s data kept apart in its own database</li></ul></section>`,
  }, `${steps(1)}
    <div><h2>Start your free trial</h2><p class="sub">You’ll be the owner. You can add other admins later.</p></div>
    <form id="f" novalidate style="display:contents">
      <div class="field"><label for="nm">Your name</label><input id="nm" class="inp" name="name" autocomplete="name" required maxlength="100" value="${esc(prefill.name || '')}" autofocus></div>
      <div class="field"><label for="em">Work email</label><input id="em" class="inp" name="email" type="email" autocomplete="email" required maxlength="200" value="${esc(prefill.email || '')}" aria-describedby="em-h"><small id="em-h">We send a 6-digit code here to check it’s yours.</small></div>
      <div class="field"><label for="pw">Password</label><div class="pw"><input id="pw" class="inp" name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="200" aria-describedby="pw-h"><button type="button" data-peek aria-controls="pw">Show</button></div><small id="pw-h">At least 10 characters.</small></div>
      <p class="err" role="alert"></p>
      <button class="btn pri wide big" type="submit">Continue</button>
    </form>
    <p class="note">${cfg.trial_days || 14} days free. No card needed.</p>`);
  peek();
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('[type=submit]');
    const name = f.name.value.trim(), email = f.email.value.trim(), password = f.password.value;
    if (name.length < 2) { f.name.focus(); return showErr('Type your name.'); }
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) { f.email.focus(); return showErr('That doesn’t look like an email address. Check the part after the @.'); }
    if (password.length < 10) { f.password.focus(); return showErr('Use at least 10 characters for the password.'); }
    showErr(''); busy(btn, true, 'Sending the code');
    try {
      const r = await call('POST', '/api/platform/signup/start', { name, email, password });
      store.set({ token: r.token, email: r.email, name, step: 'code', dev: r.dev_code || null, sentAt: Date.now() });
      signupCode();
    } catch (ex) { busy(btn, false); showErr(ex.message); }
  });
}
function peek() {
  root.querySelectorAll('[data-peek]').forEach((b) => b.addEventListener('click', () => {
    const i = document.getElementById(b.getAttribute('aria-controls'));
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; i.focus();
  }));
}

function signupCode() {
  const s = store.get();
  if (!s) return signupYou();
  document.title = 'Check your email · Staffwarden';
  show({
    right: haveAccount,
    story: `<section class="st-story"><div class="env hide-sm" aria-hidden="true">${MAIL}</div><h1>Check your inbox.</h1>
      <p class="lede">We sent a 6-digit code to <b>${esc(s.email)}</b>. It proves the email is yours${s.kind === 'request' ? ', so your setup link reaches the right person' : ', so invoices and password resets reach the right person'}.</p></section>`,
  }, `${s.kind === 'request' ? RSTEPS(1) : steps(1)}
    <div><h2>Enter the code</h2><p class="sub">It works for 15 minutes. Pasting the whole code fills every box.</p></div>
    ${s.dev ? `<p class="devcode">No mail server is set up on this server, so here is the code: <b>${esc(s.dev)}</b></p>` : ''}
    <form id="f" novalidate style="display:contents">
      <fieldset class="code" id="code"><legend class="sr">6-digit code</legend>${[1, 2, 3, 4, 5, 6].map((i) => `<input aria-label="Digit ${i}" inputmode="numeric" autocomplete="${i === 1 ? 'one-time-code' : 'off'}" maxlength="${i === 1 ? 6 : 1}" pattern="[0-9]*"${i === 1 ? ' autofocus' : ''}>`).join('')}</fieldset>
      <p class="err" role="alert"></p>
      <button class="btn pri wide big" type="submit">Continue</button>
    </form>
    <p class="muted" style="margin:0;font-size:14px;line-height:1.6;text-align:center">Nothing yet? Check spam. You can <button type="button" class="link" id="again">send it again</button>, or <button type="button" class="link" id="other">use another email</button>.</p>`);
  const boxes = [...root.querySelectorAll('.code input')];
  if (!matchMedia('(min-width: 981px)').matches) boxes[0].focus({ preventScroll: true });
  const value = () => boxes.map((b) => b.value).join('');
  const fill = (digits, from = 0) => {
    digits.split('').forEach((d, k) => { if (boxes[from + k]) boxes[from + k].value = d; });
    const next = boxes[Math.min(5, from + digits.length)];
    next.focus();
    if (value().length === 6) submit();
  };
  boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
      const d = b.value.replace(/\D/g, '');
      b.value = '';
      if (d) fill(d, i);
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !b.value && i > 0) { boxes[i - 1].value = ''; boxes[i - 1].focus(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' && i > 0) { boxes[i - 1].focus(); e.preventDefault(); }
      else if (e.key === 'ArrowRight' && i < 5) { boxes[i + 1].focus(); e.preventDefault(); }
    });
    b.addEventListener('paste', (e) => { const d = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6); if (d) { e.preventDefault(); boxes.forEach((x) => { x.value = ''; }); fill(d, 0); } });
    b.addEventListener('focus', () => b.select());
  });
  let sending = false;
  async function submit() {
    if (sending) return;
    const code = value();
    if (code.length < 6) { boxes[code.length].focus(); return showErr('The code has 6 digits.'); }
    sending = true; showErr('');
    const btn = root.querySelector('#f [type=submit]');
    busy(btn, true, 'Checking');
    try {
      if (s.kind === 'request') {
        await call('POST', '/api/platform/request/verify', { token: s.token, code });
        mine.set({ token: s.token, email: s.email, name: s.name, company: s.company });
        store.set(null);
        return requestStatus();
      }
      await call('POST', '/api/platform/signup/verify', { token: s.token, code });
      store.set({ ...s, step: 'company', dev: null });
      signupCompany();
    } catch (ex) {
      sending = false; busy(btn, false);
      if (ex.status === 404) { store.set(null); return s.kind === 'request' ? requestForm(s.form || {}) : signupYou({ name: s.name, email: s.email }); }
      if (ex.status === 409 && s.kind === 'request') { store.set(null); return requestForm({ ...(s.form || {}) }); }
      showErr(ex.message);
      const fs = $('#code'); fs.classList.remove('shake'); void fs.offsetWidth; fs.classList.add('shake');
      boxes.forEach((x) => { x.value = ''; }); boxes[0].focus();
    }
  }
  $('#f').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  // send again: after 45 seconds, with the wait shown
  const again = $('#again');
  const tick = () => {
    const left = Math.ceil((45000 - (Date.now() - (store.get() || s).sentAt)) / 1000);
    if (left > 0) { again.disabled = true; again.textContent = `send it again in 0:${String(left).padStart(2, '0')}`; setTimeout(tick, 500); }
    else { again.disabled = false; again.textContent = 'send it again'; }
  };
  tick();
  again.addEventListener('click', async () => {
    again.disabled = true;
    try {
      const r = await call('POST', s.kind === 'request' ? '/api/platform/request/resend' : '/api/platform/signup/resend', { token: s.token });
      store.set({ ...store.get(), sentAt: Date.now(), dev: r.dev_code || null });
      showErr('');
      if (r.dev_code) { const d = root.querySelector('.devcode b'); if (d) d.textContent = r.dev_code; }
      tick();
      again.insertAdjacentHTML('afterend', '<span class="sr" role="status">A new code is on its way.</span>');
    } catch (ex) { showErr(ex.message); again.disabled = false; if (ex.status === 404) { store.set(null); if (s.kind === 'request') requestForm(s.form || {}); else signupYou({ name: s.name, email: s.email }); } }
  });
  $('#other').addEventListener('click', () => { store.set(null); if (s.kind === 'request') requestForm({ ...(s.form || {}), email: '' }); else signupYou({ name: s.name }); });
}

const offsetOf = (tz) => {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
    return p ? p.value.replace('GMT', 'UTC').replace(/^UTC$/, 'UTC') : '';
  } catch { return ''; }
};
const cityOf = (tz) => (tz === 'UTC' ? 'UTC' : tz.split('/').pop().replace(/_/g, ' '));
function guessCountry() {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* old browser */ }
  const exact = cfg.countries.find((c) => c.tz === tz);
  if (exact) return exact.code;
  const alias = { 'Asia/Calcutta': 'IN', 'Asia/Dacca': 'BD', 'Asia/Saigon': 'OTHER', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Phoenix': 'US', 'America/Anchorage': 'US', 'Pacific/Honolulu': 'US', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA', 'America/Winnipeg': 'CA', 'America/Halifax': 'CA', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU', 'Australia/Perth': 'AU', 'Australia/Adelaide': 'AU', 'Asia/Muscat': 'AE' };
  return alias[tz] || (cfg.countries.find((c) => c.code === 'OTHER') ? 'OTHER' : 'US');
}
const SIZES = [['1-10', 'Up to 10'], ['11-50', '11 to 50'], ['51-200', '51 to 200'], ['200+', 'More']];

function signupCompany() {
  const s = store.get();
  if (!s) return signupYou();
  document.title = 'Your company · Staffwarden';
  const base = cfg.base_domain || 'staffwarden.com';
  const country = s.country || guessCountry();
  show({
    right: `<span class="pill green">${CHECK}<span>${esc(s.email)} checked</span></span>`,
    story: `<section class="st-story"><h1>This is where your team will sign in.</h1>
      <div class="bar" aria-hidden="true"><i></i><i></i><i></i><span class="u">https://<b id="pv">${esc(s.slug || 'your-company')}</b>.${esc(base)}</span></div>
      <p class="lede hide-sm" style="font-size:16px">Your people get this address in their invite and type it once in the desktop app. It can’t be changed later without everyone signing in again, so pick one you’ll keep.</p>
      <div class="hide-sm"><p class="muted" style="margin:0 0 10px;font-size:13.5px;font-weight:650">Set up from your country, change any of it in Settings</p><div class="sets" id="sets"></div></div></section>`,
  }, `${steps(2)}
    <h2>Your company</h2>
    <form id="f" novalidate style="display:contents">
      <div class="field"><label for="cn">Company name</label><input id="cn" class="inp" name="company" autocomplete="organization" required maxlength="80" value="${esc(s.company || '')}" autofocus></div>
      <div class="field"><label for="ad">Address your team signs in at</label>
        <div class="addr" id="addr"><input id="ad" name="slug" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="32" value="${esc(s.slug || '')}" aria-describedby="ad-h"><span>.${esc(base)}</span></div>
        <small id="ad-h">Letters, numbers and dashes.</small></div>
      <div class="field"><label for="co">Country</label><select id="co" class="sel" name="country" aria-describedby="co-h">${cfg.countries.map((c) => `<option value="${esc(c.code)}"${c.code === country ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select><small id="co-h" class="co-h"></small></div>
      <div class="field"><span class="lab" id="sz-l">About how many people?</span>
        <div class="size" role="group" aria-labelledby="sz-l">${SIZES.map(([v, l]) => `<button type="button" data-size="${v}" aria-pressed="${s.size === v}">${l}</button>`).join('')}</div>
        <small>Only to suggest a plan. You pay for the people you actually add.</small></div>
      <p class="err" role="alert"></p>
      <button class="btn pri wide big" type="submit" id="go">Create your company’s space</button>
    </form>
    <p class="note">${cfg.trial_days || 14} days free. No card needed.</p>`);
  const f = $('#f'), ad = $('#ad'), addr = $('#addr'), hint = $('#ad-h'), go = $('#go');
  let edited = !!s.slugEdited, timer = null, last = null, seq = 0;
  root.querySelector('#addr').addEventListener('click', () => ad.focus());
  // the address box is as wide as what's typed, so the domain sits right after it
  const meas = document.createElement('canvas').getContext('2d');
  const fitAddr = () => {
    meas.font = getComputedStyle(ad).font;
    ad.style.width = `${Math.ceil(meas.measureText(ad.value || 'abc').width) + 16}px`;
    $('#pv').textContent = ad.value || 'your-company';
  };
  fitAddr();
  const setHint = (state, text) => { hint.className = state || ''; hint.innerHTML = state === 'ok' ? `${CHECK}${esc(text)}` : esc(text); addr.classList.toggle('bad', state === 'bad'); ad.setAttribute('aria-invalid', state === 'bad' ? 'true' : 'false'); };
  const save = () => store.set({ ...store.get(), company: f.company.value, slug: ad.value, slugEdited: edited, country: f.country.value, size: s.size || null });
  async function check(q) {
    const n = ++seq;
    try {
      const r = await call('GET', `/api/platform/signup/address?${q}`);
      if (n !== seq) return;
      last = r;
      if (!edited && r.slug) { ad.value = r.slug; fitAddr(); }
      if (!r.slug) setHint('', 'Letters, numbers and dashes.');
      else if (r.free) setHint('ok', 'Free to use. Letters, numbers and dashes.');
      else setHint('bad', `${r.why}.`.replace(/\.\.$/, '.'));
      save();
    } catch { /* checked again on submit */ }
  }
  const later = (q) => { clearTimeout(timer); timer = setTimeout(() => check(q), 260); };
  f.company.addEventListener('input', () => {
    go.textContent = f.company.value.trim() ? `Create ${f.company.value.trim().slice(0, 40)}’s space` : 'Create your company’s space';
    if (!edited) later(`name=${encodeURIComponent(f.company.value)}`); else save();
  });
  ad.addEventListener('input', () => {
    const clean = ad.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
    if (clean !== ad.value) ad.value = clean;
    edited = !!clean; fitAddr();
    if (clean.length >= 3) later(`slug=${encodeURIComponent(clean)}`); else { last = null; setHint(clean ? 'bad' : '', clean ? 'Use at least 3 characters.' : 'Letters, numbers and dashes.'); if (!clean) later(`name=${encodeURIComponent(f.company.value)}`); }
  });
  const showCountry = () => {
    const c = cfg.countries.find((x) => x.code === f.country.value);
    if (!c) return;
    const zone = `${cityOf(c.tz)}${offsetOf(c.tz) && c.tz !== 'UTC' ? `, ${offsetOf(c.tz)}` : ''}`;
    $('.co-h').textContent = `Sets ${c.money}, ${zone} time${c.holidays ? ` and ${c.name}’s public holidays` : ''}. Change them later.`;
    const sets = $('#sets');
    if (sets) sets.innerHTML = `<div class="set"><small>Pay in</small><b>${esc(c.money.replace(/^\w/, (x) => x.toUpperCase()))}</b></div><div class="set"><small>Time zone</small><b>${esc(zone)}</b></div><div class="set"><small>Days off</small><b>${c.holidays ? `${esc(c.name)}’s public holidays` : 'Add your own in Time off'}</b></div>`;
    save();
  };
  f.country.addEventListener('change', showCountry);
  showCountry();
  root.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('[data-size]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    s.size = b.dataset.size; save();
  }));
  if (f.company.value.trim()) { f.company.dispatchEvent(new Event('input')); if (edited) check(`slug=${encodeURIComponent(ad.value)}`); }
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const company = f.company.value.trim(), slug = ad.value.trim();
    if (company.length < 2) { f.company.focus(); return showErr('Type the company’s name.'); }
    if (slug.length < 3) { ad.focus(); return showErr('Choose an address of at least 3 characters.'); }
    if (last && last.slug === slug && !last.free) { ad.focus(); return showErr(`${last.why}.`); }
    showErr(''); busy(go, true, 'Making your space');
    try {
      const r = await call('POST', '/api/platform/signup/company', { token: s.token, company, slug, country: f.country.value, size: s.size || null });
      store.set(null);
      location.href = `${r.url}/#handoff?c=${encodeURIComponent(r.handoff)}`;
    } catch (ex) {
      busy(go, false); showErr(ex.message);
      if (ex.status === 409) { store.set(null); location.href = '/signin'; }
      else if (/address/i.test(ex.message)) { setHint('bad', ex.message); ad.focus(); }
    }
  });
}

// ---------------- ask for access (when this server approves companies first) ----------------
const RSTEPS = (n) => `<ol class="steps" aria-label="Step ${n} of 3">${['Ask', 'We approve', 'Set up'].map((s, i) => `<li class="${i + 1 < n ? 'done' : i + 1 === n ? 'on' : ''}"${i + 1 === n ? ' aria-current="step"' : ''}><i></i>${s}</li>`).join('')}</ol>`;
const mine = {
  get() { try { return JSON.parse(localStorage.getItem('sw-request') || 'null'); } catch { return null; } },
  set(v) { try { if (v) localStorage.setItem('sw-request', JSON.stringify(v)); else localStorage.removeItem('sw-request'); } catch { /* private window */ } },
};
const RSIZES = [['1-10', '1–10'], ['11-50', '11–50'], ['51-200', '51–200'], ['200+', 'More than 200']];

function requestForm(prefill = {}) {
  document.title = 'Request access · Staffwarden';
  const country = prefill.country || guessCountry();
  show({
    right: haveAccount,
    story: `<section class="st-story"><h1>Tell us about your team. We’ll open the doors.</h1>
      <p class="lede">Staffwarden opens to companies one at a time, so every new team gets a working setup and a person to ask. Send a request and we’ll reply within one working day.</p>
      <ol class="how hide-sm"><li><span><b>Request access.</b> Two minutes, no card.</span></li><li><span><b>We approve it.</b> You get an email with your setup link.</span></li><li><span><b>Bring your team in.</b> Invite them by email, or create their logins yourself.</span></li></ol></section>`,
  }, `${RSTEPS(1)}
    <div><h2>Request access</h2><p class="sub">You’ll be the owner of your company’s account.</p></div>
    <form id="f" novalidate style="display:contents">
      <div class="pair">
        <div class="field"><label for="nm">Your name</label><input id="nm" class="inp" name="name" autocomplete="name" required maxlength="100" value="${esc(prefill.name || '')}" autofocus></div>
        <div class="field"><label for="cn">Company</label><input id="cn" class="inp" name="company" autocomplete="organization" required maxlength="80" value="${esc(prefill.company || '')}"></div>
      </div>
      <div class="field"><label for="em">Work email</label><input id="em" class="inp" name="email" type="email" autocomplete="email" required maxlength="200" value="${esc(prefill.email || '')}" aria-describedby="em-h"><small id="em-h">We send a 6-digit code here to check it’s yours.</small></div>
      <div class="field"><span class="lab" id="sz-l">Team size</span>
        <div class="size" role="group" aria-labelledby="sz-l">${RSIZES.map(([v, l]) => `<button type="button" data-size="${v}" aria-pressed="${prefill.size === v}">${l}</button>`).join('')}</div></div>
      <div class="field"><label for="co">Country</label><select id="co" class="sel" name="country">${cfg.countries.map((c) => `<option value="${esc(c.code)}"${c.code === country ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="nt">What do you want to use it for? <span class="opt-l">Optional</span></label><textarea id="nt" class="inp ta" name="note" rows="3" maxlength="600">${esc(prefill.note || '')}</textarea></div>
      <p class="err" role="alert"></p>
      <button class="btn pri wide big" type="submit">Request access</button>
    </form>
    <p class="note">We’ll send a code to confirm your email. Nothing is set up until your request is approved.</p>`);
  let size = prefill.size || null;
  root.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('[data-size]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    size = b.dataset.size;
  }));
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('[type=submit]');
    const v = { name: f.name.value.trim(), company: f.company.value.trim(), email: f.email.value.trim(), country: f.country.value, size, note: f.note.value.trim() };
    if (v.name.length < 2) { f.name.focus(); return showErr('Type your name.'); }
    if (v.company.length < 2) { f.company.focus(); return showErr('Type the company’s name.'); }
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v.email)) { f.email.focus(); return showErr('That doesn’t look like an email address. Check the part after the @.'); }
    showErr(''); busy(btn, true, 'Sending the code');
    try {
      const r = await call('POST', '/api/platform/request/start', v);
      store.set({ kind: 'request', token: r.token, email: r.email, name: v.name, company: v.company, step: 'code', dev: r.dev_code || null, sentAt: Date.now(), form: v });
      signupCode();
    } catch (ex) { busy(btn, false); showErr(ex.message); }
  });
}

const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
async function requestStatus() {
  const m = mine.get();
  if (!m) return requestForm();
  document.title = 'Your request · Staffwarden';
  let r;
  try { r = await call('POST', '/api/platform/request/status', { token: m.token }); }
  catch (ex) { if (ex.status === 404) { mine.set(null); return requestForm(); } r = { status: 'waiting', ...m }; }
  const first = (r.name || '').split(' ')[0];
  const STATE = {
    waiting: ['amber', 'Waiting for review'], approved: ['green', 'Approved'], done: ['green', 'Set up'],
    declined: ['red', 'Not approved'], withdrawn: ['grey', 'Withdrawn'],
  }[r.status] || ['amber', 'Waiting for review'];
  const sent = r.created_at ? new Date(r.created_at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const stepRow = (state, title, sub) => `<li class="${state}"><span class="dot" aria-hidden="true">${state === 'done' ? TICK : ''}</span><span><b>${esc(title)}</b><small>${esc(sub)}</small></span></li>`;
  const review = r.status === 'waiting' ? 'now' : ['approved', 'done'].includes(r.status) ? 'done' : 'off';
  const setup = r.status === 'done' ? 'done' : r.status === 'approved' ? 'now' : 'off';
  const head = {
    waiting: `Thanks, ${first}. ${r.company} is in the queue.`,
    approved: `${r.company} is approved.`,
    done: `${r.company} is set up.`,
    declined: 'We can’t open Staffwarden for you right now.',
    withdrawn: 'You withdrew the request.',
  }[r.status] || `Thanks, ${first}.`;
  const lede = {
    waiting: `We read every request ourselves. When ${esc(r.company)} is approved, a setup link goes to <b>${esc(r.email)}</b>. You can close this page.`,
    approved: `The setup link is in your inbox at <b>${esc(r.email)}</b>. It works once, for 7 days.`,
    done: 'Sign in at your company’s address, or find it by email.',
    declined: 'We sent the reason to your email. You can ask again 30 days after the decision.',
    withdrawn: 'Nothing was kept running. You can send a new request any time.',
  }[r.status] || '';
  show({
    right: haveAccount,
    story: `<section class="st-story"><h1>${esc(head)}</h1><p class="lede">${lede}</p>
      <p class="muted" style="margin:0;font-size:14.5px;line-height:1.55">Wrong email, or a question first? Write to <a href="mailto:hello@staffwarden.com">hello@staffwarden.com</a>.</p></section>`,
  }, `<div class="rq-h"><h2>Your request</h2><span class="pill ${STATE[0]}">${esc(STATE[1])}</span></div>
    <ol class="tl">${stepRow('done', 'Request sent', sent)}${stepRow(r.verified_at ? 'done' : 'now', 'Email confirmed', r.email)}${['declined', 'withdrawn'].includes(r.status) ? stepRow('off', r.status === 'declined' ? 'Not approved' : 'Withdrawn', r.status === 'declined' ? 'The reason is in your email' : 'You can ask again any time') : `${stepRow(review, 'Review', review === 'done' ? 'Approved' : 'Usually within one working day')}${stepRow(setup, 'Set up your company', setup === 'done' ? 'Done' : 'Pick your address and password from the email')}`}</ol>
    <dl class="rq-facts"><div><dt>Company</dt><dd>${esc(r.company)}</dd></div><div><dt>Team size</dt><dd>${esc(r.size_text || 'Not given')}</dd></div></dl>
    <p class="err" role="alert"></p>
    ${r.status === 'waiting' ? '<button type="button" class="btn" id="wd" style="align-self:flex-start">Withdraw the request</button>'
      : r.status === 'done' ? '<a class="btn pri wide" href="/signin">Sign in</a>'
      : ['declined', 'withdrawn'].includes(r.status) ? '<button type="button" class="btn" id="new" style="align-self:flex-start">Start a new request</button>' : ''}`);
  const wd = $('#wd');
  if (wd) wd.addEventListener('click', async () => {
    if (wd.dataset.sure !== '1') { wd.dataset.sure = '1'; wd.textContent = 'Withdraw it: are you sure?'; wd.classList.add('warn'); return; }
    busy(wd, true, 'Withdrawing');
    try { await call('POST', '/api/platform/request/withdraw', { token: m.token }); requestStatus(); } catch (ex) { busy(wd, false); showErr(ex.message); }
  });
  const nw = $('#new');
  if (nw) nw.addEventListener('click', () => { mine.set(null); requestForm({ name: r.name, email: r.email, company: r.company, size: r.size, country: r.country }); });
}

// the setup link from the approval email: the company's address and the owner's password
async function setupPage() {
  document.title = 'Set up your company · Staffwarden';
  const fromHash = /^#t=([^&]+)/.exec(location.hash);
  if (fromHash) { try { sessionStorage.setItem('sw-setup', decodeURIComponent(fromHash[1])); } catch { /* private window */ } history.replaceState(null, '', '/setup'); }
  let t = null; try { t = sessionStorage.getItem('sw-setup'); } catch { /* private window */ }
  const dead = (msg) => show({ right: haveAccount, story: moonArt, cardClass: 'narrow' },
    `<div><h2>This link doesn’t work</h2><p class="sub">${esc(msg)}</p></div><a class="btn wide" href="mailto:hello@staffwarden.com?subject=A%20new%20setup%20link">Ask for a new link</a>`);
  if (!t) return dead('Open the link from your approval email again.');
  let info;
  try { info = await call('POST', '/api/platform/setup/check', { t }); } catch (ex) { return dead(ex.message); }
  const base = cfg.base_domain || 'staffwarden.com';
  let here = ''; try { here = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* old browser */ }
  const zones = [...new Set([info.tz, here].filter(Boolean))];
  show({
    right: `<span class="opt">Setting up as ${esc(info.email)}</span>`,
    story: `<section class="st-story"><span class="pill green" style="align-self:flex-start">${CHECK}<span>Approved</span></span><h1>This is where your team will sign in.</h1>
      <p class="lede">Pick a short address for ${esc(info.company)} and a password for yourself. Your ${info.trial_days}-day trial starts the moment you finish.</p></section>`,
  }, `${RSTEPS(3)}
    <h2>Your company</h2>
    <dl class="rq-facts box"><div><dt>Company</dt><dd>${esc(info.company)}</dd></div><div><dt>Money and holidays</dt><dd>${esc(info.money.replace(/^\w/, (x) => x.toUpperCase()))}${info.holidays ? `, ${esc(info.country_name)} holidays` : ''}</dd></div></dl>
    <form id="f" novalidate style="display:contents">
      <div class="field"><label for="ad">Your address</label>
        <div class="addr" id="addr"><input id="ad" name="slug" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="32" value="${esc(info.slug || '')}" aria-describedby="ad-h"><span>.${esc(base)}</span></div>
        <small id="ad-h">Letters, numbers and dashes.</small></div>
      <div class="field"><label for="pw">Your password</label><div class="pw"><input id="pw" class="inp" name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="200" aria-describedby="pw-h"><button type="button" data-peek aria-controls="pw">Show</button></div><small id="pw-h">At least 10 characters.</small></div>
      <div class="field"><label for="tz">Time zone</label><select id="tz" class="sel" name="tz">${zones.map((z) => `<option value="${esc(z)}">${esc(cityOf(z))}${offsetOf(z) && z !== 'UTC' ? ` (${esc(offsetOf(z))})` : ''}</option>`).join('')}</select></div>
      <p class="err" role="alert"></p>
      <button class="btn pri wide big" type="submit" id="go">Create ${esc(info.company.slice(0, 40))}</button>
    </form>
    <p class="note">The address can’t be changed later. You can rename the company any time.</p>`);
  peek();
  const f = $('#f'), ad = $('#ad'), addr = $('#addr'), hint = $('#ad-h'), go = $('#go');
  addr.addEventListener('click', () => ad.focus());
  const meas = document.createElement('canvas').getContext('2d');
  const fit = () => { meas.font = getComputedStyle(ad).font; ad.style.width = `${Math.ceil(meas.measureText(ad.value || 'abc').width) + 16}px`; };
  fit();
  const setHint = (state, text) => { hint.className = state || ''; hint.innerHTML = state === 'ok' ? `${CHECK}${esc(text)}` : esc(text); addr.classList.toggle('bad', state === 'bad'); ad.setAttribute('aria-invalid', state === 'bad' ? 'true' : 'false'); };
  let last = null, seq = 0, timer = null;
  const check = async () => {
    const n = ++seq, slug = ad.value;
    if (slug.length < 3) { last = null; return setHint(slug ? 'bad' : '', slug ? 'Use at least 3 characters.' : 'Letters, numbers and dashes.'); }
    try { const r = await call('GET', `/api/platform/signup/address?slug=${encodeURIComponent(slug)}`); if (n !== seq) return; last = r; if (r.free) setHint('ok', `${slug}.${base} is free`); else setHint('bad', `${r.why}.`.replace(/\.\.$/, '.')); } catch { /* checked on submit */ }
  };
  ad.addEventListener('input', () => {
    const clean = ad.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
    if (clean !== ad.value) ad.value = clean;
    fit(); clearTimeout(timer); timer = setTimeout(check, 260);
  });
  check();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const slug = ad.value.trim(), password = f.password.value;
    if (slug.length < 3) { ad.focus(); return showErr('Choose an address of at least 3 characters.'); }
    if (last && last.slug === slug && !last.free) { ad.focus(); return showErr(`${last.why}.`); }
    if (password.length < 10) { f.password.focus(); return showErr('Use at least 10 characters for the password.'); }
    showErr(''); busy(go, true, 'Making your company');
    try {
      const r = await call('POST', '/api/platform/setup', { t, slug, password, tz: f.tz.value });
      try { sessionStorage.removeItem('sw-setup'); } catch { /* fine */ }
      const m = mine.get(); if (m) mine.set(null);
      location.href = `${r.url}/#handoff?c=${encodeURIComponent(r.handoff)}&to=add-team`;
    } catch (ex) {
      busy(go, false); showErr(ex.message);
      if (/address/i.test(ex.message)) { setHint('bad', ex.message); ad.focus(); }
      if (ex.status === 404 || ex.status === 410) dead(ex.message);
    }
  });
}

// ---------------- find your company ----------------
const COLORS = ['#1D4ED8', '#0F766E', '#B45309', '#7C3AED', '#BE185D', '#15803D', '#C2410C', '#4338CA'];
const colorOf = (s) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const when = (iso) => {
  if (!iso) return 'not used yet';
  const t = Date.parse(String(iso).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(iso) ? '' : 'Z'));
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return 'used today'; if (days === 1) return 'used yesterday';
  return `used ${new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
};
const moonArt = `<section class="st-art" aria-hidden="true"><div class="st-moon">${owl('still')}</div><p class="st-tag">Keeping watch, so<br>you don’t have to.</p></section>`;
const trustLine = 'Time is tracked only while you choose to, and private windows never leave your computer.';
const goTo = (c, email) => { location.href = `${c.url}/#signin?email=${encodeURIComponent(email)}`; };

function signin(prefill = '') {
  document.title = 'Sign in · Staffwarden';
  show({ right: `<a class="btn sm" href="/signup" style="color:var(--ink)">${cfg.signup === 'approval' ? 'Request access' : 'Start a free trial'}</a>`, story: moonArt, cardClass: 'narrow', foot: trustLine },
    `<div><h2>Welcome back</h2><p class="sub">Start with your work email. We’ll find your company.</p></div>
    <form id="f" novalidate style="display:contents">
      <div class="field"><label for="em">Email</label><input id="em" class="inp" name="email" type="email" autocomplete="username" required value="${esc(prefill)}" autofocus></div>
      <p class="err" role="alert"></p>
      <button class="btn pri wide big" type="submit">Continue</button>
    </form>
    <p class="muted" style="margin:0;font-size:14px;text-align:center">Forgot your password? <a href="/forgot">Reset it</a></p>`);
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]'), email = e.target.email.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { e.target.email.focus(); return showErr('That doesn’t look like an email address.'); }
    showErr(''); busy(btn, true, 'Looking');
    try {
      const r = await call('POST', '/api/platform/find', { email });
      if (r.companies.length === 1) { goTo(r.companies[0], email); return; }
      busy(btn, false);
      pick(email, r.companies);
    } catch (ex) { busy(btn, false); showErr(ex.message); }
  });
}
function pick(email, list) {
  document.title = list.length ? 'Which company? · Staffwarden' : 'Sign in · Staffwarden';
  show({ right: `<a class="btn sm" href="/signup" style="color:var(--ink)">${cfg.signup === 'approval' ? 'Request access' : 'Start a free trial'}</a>`, story: moonArt, cardClass: 'narrow', foot: trustLine },
    list.length ? `<div><h2>Which company?</h2><p class="sub">This email is in ${list.length === 2 ? 'two' : list.length} companies. Each has its own password.</p></div>
      <div class="fake"><span>${esc(email)}</span><button type="button" id="chg">Change</button></div>
      <ul class="cos">${list.map((c, i) => `<li><a href="${esc(c.url)}/#signin?email=${encodeURIComponent(email)}"${i === 0 ? ' autofocus' : ''}><span class="lg" style="background:${colorOf(c.slug)}">${esc((c.name.trim()[0] || '?').toUpperCase())}</span><span class="t"><b>${esc(c.name)}</b><span class="s">${esc(c.address)} · ${c.kind === 'client' ? 'client portal' : 'team'}</span></span>${CHEV}</a></li>`).join('')}</ul>
      <p class="faint" style="margin:0;font-size:13px;line-height:1.5">Missing one? Its owner may have removed you, or invited a different email.</p>`
      : `<div><h2>No company found</h2><p class="sub">We couldn’t find a company with this email.</p></div>
      <div class="fake"><span>${esc(email)}</span><button type="button" id="chg">Change</button></div>
      <div class="none">Check the email in your invite. It may be a different address, or the invite hasn’t been sent yet. Ask whoever runs Staffwarden at your company.</div>
      <a class="btn wide" href="/signup">${cfg.signup === 'approval' ? 'Request access for your own company' : 'Start a free trial for your own company'}</a>`);
  $('#chg').addEventListener('click', () => signin(email));
}

function forgot(prefill = '') {
  document.title = 'Forgot your password · Staffwarden';
  show({ right: '<a href="/signin">Back to sign in</a>', story: moonArt, cardClass: 'narrow', foot: trustLine },
    `<div><h2>Forgot your password?</h2><p class="sub">Type your work email. If it belongs to a company here, we’ll send a link to set a new one.</p></div>
    <form id="f" novalidate style="display:contents">
      <div class="field"><label for="em">Email</label><input id="em" class="inp" name="email" type="email" autocomplete="username" required value="${esc(prefill)}" autofocus></div>
      <p class="err" role="alert"></p>
      <button class="btn pri wide big" type="submit">Email me a link</button>
    </form>
    <p class="faint" style="margin:0;font-size:13px;line-height:1.5">Forgot which email? Ask whoever runs Staffwarden at your company; they can reset it from People.</p>`);
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]'), email = e.target.email.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { e.target.email.focus(); return showErr('That doesn’t look like an email address.'); }
    showErr(''); busy(btn, true, 'Sending');
    try {
      await call('POST', '/api/platform/forgot', { email });
      show({ right: '<a href="/signin">Back to sign in</a>', story: moonArt, cardClass: 'narrow', foot: trustLine },
        `<div><h2>Check your email</h2></div>
        <div class="sent" role="status">${MAIL}<span>If <b>${esc(email)}</b> belongs to a company here, a link is on its way. It works for 30 minutes, once.</span></div>
        <p class="muted" style="margin:0;font-size:14px;line-height:1.55">Nothing after a few minutes? Check spam, or <button type="button" class="link" id="retry">try another email</button>.</p>
        <a class="btn wide" href="/signin">Back to sign in</a>`);
      $('#retry').addEventListener('click', () => forgot(email));
    } catch (ex) { busy(btn, false); showErr(ex.message); }
  });
}

// ---------------- which page ----------------
cfgReady.then(() => {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  const email = new URLSearchParams(location.search).get('email') || '';
  if (p === '/signin') return signin(email);
  if (p === '/forgot') return forgot(email);
  if (p === '/setup') return setupPage();
  const s = store.get();
  if (cfg.signup === 'approval') {
    if (s && s.kind === 'request' && s.step === 'code') return signupCode();
    if (mine.get()) return requestStatus();
    return requestForm();
  }
  if (s && s.step === 'company') return signupCompany();
  if (s && s.step === 'code') return signupCode();
  return signupYou();
});
