// The moments around the shift that are not a page of their own: the owner's boost (sending it, and
// the little show everyone working gets), the "Still there?" question when someone is idle, the
// announcement that waits for a "I've read it", and god mode's pop-ups (cheat code accepted, level up).
import { esc, initials, avColor, plural, callName, owl } from './util.js';
import { get, post, put } from './api.js';
import { S, actions, toast, errMsg, openModal } from './ui.js';

const IC = {
  rocket: '<path d="M12 3c3.5 2 5 5.5 5 9l-2 3H9l-2-3c0-3.5 1.5-7 5-9z"/><circle cx="12" cy="10" r="1.8"/><path d="M9 15l-2.5 3.5L9 18M15 15l2.5 3.5L15 18"/>',
  cup: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8.5 3.5c-.6 1 .6 1.6 0 2.6M12 3.5c-.6 1 .6 1.6 0 2.6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  mega: '<path d="M4 10v4h3l7 4V6L7 10z"/><path d="M17.5 9a4 4 0 0 1 0 6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  face: '<circle cx="12" cy="12" r="8.5"/><path d="M9 10h.01M15 10h.01M9 15h6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c.5-3.5 3-5.5 6.5-5.5s6 2 6.5 5.5"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18.5 14.8c1.8.7 2.8 2.4 3 5.2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  idcard: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16.2c.5-1.6 1.7-2.4 3.2-2.4s2.7.8 3.2 2.4M14.5 10h3.5M14.5 13.5h3.5"/>',
};
const ic = (n, s = 18) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n]}</svg>`;
const av = (p, size = 28) => `<span class="cav" style="width:${size}px;height:${size}px;background:${avColor(p.id)};font-size:${Math.round(size * 0.38)}px" aria-hidden="true">${esc(initials(p.name))}</span>`;
const overlay = () => document.getElementById('overlay');
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const first = (n) => callName(n);
const phone = () => matchMedia('(max-width: 640px)').matches;

// ============================== the boost ==============================
const VIBES = [['chai', 'Chai time', 'cup'], ['liftoff', 'Lift-off', 'rocket'], ['lasthour', 'Last hour', 'clock'], ['win', 'Big win', 'star']];
let bp = null;
function closeBoostPanel() { if (bp) { bp.remove(); bp = null; document.removeEventListener('keydown', bpKey, true); } }
function bpKey(e) {
  if (e.key !== 'Escape' || !bp) return;
  e.stopPropagation();
  if (bp.dataset.view === 'people') bp.querySelector('.bpp [data-b="who-back"]').click(); else closeBoostPanel();
}
actions['boost-open'] = async (el) => {
  if (bp) { closeBoostPanel(); return; }
  let d;
  try { d = await get('/api/boost'); } catch (e) { toast(errMsg(e), true); return; }
  const st = { vibe: 'chai', i: 0, clip: true };
  const lines = (v) => d.lines[v] || [];
  const lineNow = () => { const l = lines(st.vibe); return l.length ? l[st.i % l.length] : ''; };
  const last = d.last;
  const box = document.createElement('div');
  box.className = 'bp-wrap';
  box.innerHTML = `<div class="bp" role="dialog" aria-modal="false" aria-labelledby="bp-t">
    <div class="bp-h"><div><h2 id="bp-t">Boost the team</h2><p>One tap. Everyone working gets it on their phone and desktop, with a little show.</p></div><button type="button" class="bp-x" data-b="close" aria-label="Close">${ic('x', 18)}</button></div>
    <div class="bp-v" role="radiogroup" aria-label="What kind of boost">${VIBES.map(([k, l, i]) => `<button type="button" role="radio" data-b="vibe" data-v="${k}" aria-checked="${k === st.vibe}">${ic(i, 20)}<span>${l}</span></button>`).join('')}</div>
    <div class="bp-p"><span>They’ll see</span><b data-r="line"></b><button type="button" class="bp-more" data-b="another">${ic('refresh', 15)}Another line</button></div>
    <label class="bp-own"><span>Or write your own</span><input data-r="own" maxlength="160" placeholder="Whoever books the next tour picks dinner"></label>
    <div class="bp-clip"><span class="bp-clip-v" aria-hidden="true"></span>
      <span class="bp-clip-t"><b id="bp-clip-l">Pop up on their laptops with my clip</b><span>You power up in the corner of their screen for 8 seconds, your message above you. ${d.working_now ? `${plural(d.clip_ready ?? 0, 'laptop')} will show it; the rest get a notification.` : 'For people with the timer on.'}${missed(d)}</span><button type="button" class="bp-prev" data-b="preview">${ic('play', 14)}Preview on my screen</button></span>
      <label class="bp-sw"><input type="checkbox" data-r="clip" checked aria-labelledby="bp-clip-l"><span aria-hidden="true"></span></label></div>
    ${d.people ? `<button type="button" class="bp-who" data-b="who" aria-haspopup="true">${ic('users', 18)}<span class="bp-who-t"><b>Who sees the pop-up</b><span data-r="who-sum"></span></span>${ic('chev', 16)}</button>` : ''}
    <div class="bp-f"><button type="button" class="bp-send" data-b="send"${d.working_now ? '' : ' disabled'}>${ic('rocket', 17)}<span data-r="send-l">${sendLabel(d.working_now)}</span></button>
      ${last ? `<span class="bp-last">Last boost: ${esc(new Date(last.created_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))} · ${last.boosted.length} boosted back${last.chai.length ? ` · ${last.chai.length} want more chai` : ''}</span>` : ''}</div></div>`;
  // the people view: the owner turns the show off, or back on, for anyone
  const ppl = d.people || [];
  const whoSum = () => {
    const off = ppl.filter((p) => p.quiet);
    if (!off.length) return 'Everyone working sees your pop-up.';
    const names = off.map((p) => callName(p.name));
    return `Off for ${names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${plural(names.length - 2, 'other')}`}. They still get the notification.`;
  };
  const row = (p) => `<li class="bpp-r" data-k="${p.id}"><span class="bpp-av" style="background:${avColor(p.id)}">${esc(initials(p.name))}</span>
      <span class="bpp-n"><b id="bpp-n${p.id}">${esc(p.name)}</b><span>${p.working ? `<i class="bpp-on"></i>Working now${p.clip && !p.clip.ok && p.clip.why !== 'show_off' ? `<em class="bpp-why">${esc(p.clip.text)}</em>` : ''}` : esc(p.title || 'Not working right now')}</span></span>
      <label class="bp-sw"><input type="checkbox" data-r="show" data-id="${p.id}" ${p.quiet ? '' : 'checked'} aria-labelledby="bpp-n${p.id}" aria-describedby="bpp-sw-d"><span aria-hidden="true"></span></label></li>`;
  const pplView = document.createElement('div');
  pplView.className = 'bpp'; pplView.hidden = true;
  pplView.innerHTML = `<div class="bp-h"><button type="button" class="bp-x bpp-back" data-b="who-back" aria-label="Back to the boost">${ic('back', 18)}</button><div style="flex:1"><h2 id="bpp-t">Who sees the pop-up</h2><p id="bpp-sw-d">Switch someone off and you won’t pop up on their screen: no clip on their laptop, no full-screen show. They still get the boost as a normal notification. Saved for next time.</p></div><button type="button" class="bp-x" data-b="close" aria-label="Close">${ic('x', 18)}</button></div>
    ${ppl.length > 7 ? `<label class="bpp-s">${ic('search', 16)}<input data-r="find" type="text" enterkeyhint="search" autocomplete="off" placeholder="Find someone" aria-label="Find someone"></label>` : ''}
    <ul class="bpp-l" aria-labelledby="bpp-t">${ppl.map(row).join('')}</ul>
    <p class="bpp-none" data-r="none" hidden>Nobody by that name.</p>
    <div class="bp-f"><button type="button" class="bp-send" data-b="who-back">${ic('check', 17)}<span>Done</span></button><span class="bp-last" data-r="ppl-sum"></span></div>`;
  box.querySelector('.bp').appendChild(pplView);
  const main = [...box.querySelector('.bp').children].filter((c) => c !== pplView);
  const paintWho = () => {
    const sum = box.querySelector('[data-r="who-sum"]'); if (sum) sum.textContent = whoSum();
    const off = ppl.filter((p) => p.quiet).length;
    box.querySelector('[data-r="ppl-sum"]').textContent = off ? `Pop-up off for ${plural(off, 'person', 'people')}` : 'Everyone sees the pop-up';
  };
  const showPeople = (on) => {
    for (const c of main) c.hidden = on;
    pplView.hidden = !on; box.dataset.view = on ? 'people' : '';
    box.querySelector('.bp').scrollTop = 0;
    const f = on ? (pplView.querySelector('[data-r="find"]') || pplView.querySelector('[data-r="show"]')) : box.querySelector('[data-b="who"]');
    if (f) f.focus();
  };
  pplView.addEventListener('change', async (e) => {
    const t = e.target.closest('[data-r="show"]'); if (!t) return;
    const p = ppl.find((x) => x.id === Number(t.dataset.id)); if (!p) return;
    const quiet = !t.checked; p.quiet = quiet; paintWho(); t.disabled = true;
    try { await put('/api/boost/quiet', { user_id: p.id, quiet }); }
    catch (err) { p.quiet = !quiet; t.checked = !quiet; paintWho(); toast(errMsg(err), true); }
    finally { t.disabled = false; }
  });
  const find = pplView.querySelector('[data-r="find"]');
  if (find) find.addEventListener('input', () => {
    const q = find.value.trim().toLowerCase(); let n = 0;
    for (const li of pplView.querySelectorAll('.bpp-r')) { const hit = !q || li.textContent.toLowerCase().includes(q); li.hidden = !hit; if (hit) n++; }
    pplView.querySelector('[data-r="none"]').hidden = n > 0;
  });
  overlay().appendChild(box); bp = box;
  paintWho();
  clipEl('', '').then((v) => { v.removeAttribute('aria-label'); v.removeAttribute('role'); const slot = box.querySelector('.bp-clip-v'); if (slot && box.isConnected) { slot.appendChild(v); playClip(v); } });
  const paint = () => { box.querySelector('[data-r="line"]').textContent = box.querySelector('[data-r="own"]').value.trim() || lineNow(); for (const b of box.querySelectorAll('[data-b="vibe"]')) b.setAttribute('aria-checked', String(b.dataset.v === st.vibe)); };
  paint();
  // under the button when it fits; otherwise moved up just enough to show the whole panel (never cut to a sliver)
  if (!phone() && el && el.getBoundingClientRect) {
    const r = el.getBoundingClientRect(), p = box.querySelector('.bp');
    p.style.right = `${Math.max(12, Math.round(innerWidth - r.right))}px`;
    p.style.maxHeight = `calc(100dvh - 24px)`;
    const h = p.offsetHeight, below = Math.round(r.bottom + 8);
    p.style.top = `${Math.max(12, Math.min(below, innerHeight - h - 12))}px`;
  }
  box.addEventListener('mousedown', (e) => { if (e.target === box) closeBoostPanel(); });
  box.querySelector('[data-r="own"]').addEventListener('input', paint);
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-b]'); if (!b) return;
    if (b.dataset.b === 'close') return closeBoostPanel();
    if (b.dataset.b === 'who') return showPeople(true);
    if (b.dataset.b === 'who-back') return showPeople(false);
    if (b.dataset.b === 'vibe') { st.vibe = b.dataset.v; st.i = 0; return paint(); }
    if (b.dataset.b === 'another') { st.i++; box.querySelector('[data-r="own"]').value = ''; return paint(); }
    if (b.dataset.b === 'preview') { b.disabled = true; b.setAttribute('aria-busy', 'true'); await boostClipPreview(box.querySelector('[data-r="own"]').value.trim() || lineNow()); b.disabled = false; b.removeAttribute('aria-busy'); return; }
    if (b.dataset.b === 'send') {
      b.disabled = true;
      const own = box.querySelector('[data-r="own"]').value.trim();
      try { const r = await post('/api/boost', { vibe: st.vibe, line: own || lineNow(), clip: box.querySelector('[data-r="clip"]').checked }); closeBoostPanel(); toast(`Boost sent to ${plural(r.sent_to, 'person', 'people')}${r.popped_up ? `. Popping up on ${plural(r.popped_up, 'laptop')}.` : ''}`); S.refresh(); }
      catch (err) { b.disabled = false; toast(errMsg(err), true); }
    }
  });
  document.addEventListener('keydown', bpKey, true);
  setTimeout(() => { const f = box.querySelector('[aria-checked="true"]'); if (f) f.focus(); }, 30);
};

// The clip is a video with a see-through background where the browser can play one (Chrome, Edge and the
// desktop app); Safari and Firefox get the animated image. Either way it is downloaded whole before it plays,
// so it never crawls along while it is still arriving.
const CLIP_VIDEO = /Chrome\//.test(navigator.userAgent) && !!document.createElement('video').canPlayType('video/webm; codecs="vp9"');
let clipUrl = null;
function clipSrc() {
  if (!clipUrl) {
    clipUrl = fetch(CLIP_VIDEO ? '/img/boost-clip.webm' : '/img/boost-clip.webp')
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
      .then((b) => URL.createObjectURL(b))
      .catch(() => { clipUrl = null; return CLIP_VIDEO ? '/img/boost-clip.webm' : '/img/boost-clip.webp'; });
  }
  return clipUrl;
}
// resolves once the clip can play from the first frame
async function clipEl(cls, alt) {
  const src = await clipSrc();
  if (!CLIP_VIDEO) {
    const im = new Image(); im.className = cls; im.alt = alt; im.src = src;
    try { await im.decode(); } catch { /* shown anyway */ }
    return im;
  }
  const v = document.createElement('video');
  v.className = cls; v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('aria-label', alt); v.setAttribute('role', 'img');
  v.src = src;
  await new Promise((ok) => { if (v.readyState >= 3) return ok(); v.addEventListener('canplaythrough', ok, { once: true }); v.addEventListener('error', ok, { once: true }); setTimeout(ok, 2500); });
  return v;
}
const playClip = (el) => { if (el && el.tagName === 'VIDEO') { el.currentTime = 0; el.play().catch(() => {}); } };

// what the boost clip looks like on someone's laptop, played in the corner of this page
export async function boostClipPreview(line) {
  const old = document.querySelector('.bcp-stage'); if (old) old.remove();
  const him = await clipEl('bcp-him', 'You, powering up');
  const st = document.createElement('div');
  st.className = 'bcp-stage';
  st.setAttribute('role', 'dialog'); st.setAttribute('aria-label', 'Preview of the boost clip');
  st.innerHTML = `<span class="bcp-slot"></span>
    <div class="bcp-bubble"><div class="bcp-top"><span class="bcp-who">BOOST FROM ${esc(callName(S.me.name).toUpperCase())}</span><span>preview</span></div><p class="bcp-line">${esc(line)}</p>
      <div class="bcp-acts"><span class="bcp-back">BOOST BACK</span><span class="bcp-later">Later</span><button type="button" class="bcp-close">Close preview</button></div><div class="bcp-bar"><i></i></div></div>`;
  st.querySelector('.bcp-slot').replaceWith(him);
  document.body.appendChild(st);
  playClip(him);
  let done = false;
  const end = () => { if (done) return; done = true; st.classList.add('out'); setTimeout(() => { if (him.pause) him.pause(); st.remove(); }, 450); };
  st.querySelector('.bcp-close').addEventListener('click', end);
  requestAnimationFrame(() => { st.classList.add('in'); setTimeout(() => st.classList.add('talk'), 300); });
  setTimeout(end, 8600);
}

// what everyone working sees: once per boost
const seenBoost = new Set();
function confetti(n = 26) {
  if (reduced()) return '';
  const cols = ['#F7B544', '#F7B544', '#7BE0B3', '#F4A28C', '#B9D6E6', '#FFFFFF'];
  let x = 7, out = '';
  for (let i = 0; i < n; i++) { x = (x * 9301 + 49297) % 233280; const r = x / 233280; out += `<i style="left:${Math.round(r * 96 + 2)}%;animation-delay:-${(r * 5).toFixed(2)}s;animation-duration:${(4 + r * 3).toFixed(2)}s;background:${cols[i % cols.length]};width:${6 + (i % 3) * 2}px;height:${6 + (i % 3) * 2}px;transform:rotate(${Math.round(r * 90)}deg)"></i>`; }
  return `<div class="bo-cf" aria-hidden="true">${out}</div>`;
}
// working people who would get only a notification, and why (an old app, the limit for the shift...)
const sendLabel = (n) => (n ? `Send to ${plural(n, 'person', 'people')} working` : 'Nobody else is working right now');
function missed(d) {
  const no = (d.people || []).filter((p) => p.working && !p.quiet && p.clip && !p.clip.ok && p.clip.why !== 'show_off');
  if (!no.length) return '';
  return `<span class="bp-miss">${no.slice(0, 4).map((p) => `<span><b>${esc(p.name.split(' ')[0])}</b>: ${esc(p.clip.text.charAt(0).toLowerCase() + p.clip.text.slice(1))}</span>`).join('')}${no.length > 4 ? `<span>and ${no.length - 4} more</span>` : ''}</span>`;
}
export async function showBoost(id) {
  if (!id || seenBoost.has(Number(id)) || document.querySelector('.bo')) return;
  seenBoost.add(Number(id));
  let b;
  try { b = await get(`/api/boost/${id}`); } catch { return; }
  if (b.author.id === S.me.id || b.quiet) return;
  const icon = { chai: 'cup', liftoff: 'rocket', lasthour: 'clock', win: 'star' }[b.vibe] || 'rocket';
  const box = document.createElement('div');
  box.className = 'bo'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'bo-t');
  box.innerHTML = `${confetti()}<div class="bo-in"><span class="bo-ic">${ic(icon, 44)}</span>
    <span class="bo-from">${av(b.author, 26)}<b>Boost from ${esc(first(b.author.name))}</b> · ${esc(new Date(b.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span>
    <h2 id="bo-t">${esc(b.line)}</h2><p>${b.boosted ? `${plural(b.boosted, 'person', 'people')} boosted back already.` : 'Be the first to boost back.'}</p>
    <div class="bo-a">${b.my_answer ? `<button type="button" class="bo-go" data-a="close">${b.my_answer === 'chai' ? 'More chai, noted' : 'Boosted'}</button>` : `<button type="button" class="bo-go" data-a="boosted">Boosted</button><button type="button" class="bo-alt" data-a="chai">I need more chai first</button>`}</div></div>`;
  overlay().appendChild(box);
  const close = () => { box.classList.add('out'); setTimeout(() => box.remove(), 220); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  box.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-a]'); if (!t) return;
    if (t.dataset.a !== 'close') { try { await post(`/api/boost/${b.id}/answer`, { answer: t.dataset.a }); } catch (err) { toast(errMsg(err), true); } }
    close();
  });
  setTimeout(() => { const f = box.querySelector('.bo-go'); if (f) f.focus(); }, 40);
}

// ============================== "Still there?" ==============================
let nudgeOpen = null;
// god mode's idle: a pixel ghost
const GHOST = (() => {
  const rows = ['..wwww..', '.wwwwww.', 'wwkwwkww', 'wwkwwkww', 'wwwwwwww', 'wwwbbwww', 'wwwwwwww', 'w.ww.ww.'], c = { w: '#D7DDF0', k: '#0B1020', b: '#8FD3FF' };
  return `<svg class="nd-ghost gm-bob" width="64" height="64" viewBox="0 0 8 8" shape-rendering="crispEdges" role="img" aria-label="A pixel ghost">${rows.map((r, y) => [...r].map((ch, x) => (ch === '.' ? '' : `<rect x="${x}" y="${y}" width="1" height="1" fill="${c[ch]}"/>`)).join('')).join('')}</svg>`;
})();
export async function checkNudge(id = null) {
  if (!S.me || S.me.kind === 'client' || nudgeOpen) return;
  let f;
  try { f = await get('/api/idle/mine'); } catch { return; }
  if (!f || (id && f.id !== Number(id))) return;
  const low = f.kind === 'low';
  const mins = f.idle_min || 15;
  const opts = low
    ? [['back', 'All good, I’m on it', 'Keep going'], ['meeting', 'In a call or a meeting', 'Counts as work. Your manager can see you said so.'], ['reading', 'Reading or thinking', 'Away from the keyboard, still working']]
    : [['back', 'I’m back', 'Keep the timer going'], ['break', 'I was on a break', 'Noted on your day, so your manager sees why'], ['meeting', 'In a call or a meeting', 'Counts as work. Your manager can see you said so.']];
  const who = first(S.me.name);
  const owner = S.settings.owner_name ? { name: S.settings.owner_name } : null;
  const god = !!S.me.fun_mode;
  nudgeOpen = openModal({
    title: god ? (low ? 'A QUIET HOUR APPEARED!' : 'A WILD IDLE APPEARED!') : low ? 'Quiet hour on the keyboard' : `Still there, ${who}?`, footer: false,
    body: { toString: () => `<div class="nd">${god ? GHOST : `<span class="nd-ic nd-owl">${owl('doze', 'The owl, dozing off')}</span>`}
      <p>${low ? `${(f.detail && f.detail.pct) ?? f.activity ?? 0}% keyboard and mouse in the last hour while your timer runs. All good? Tell us what you’re on so your hours stay right.` : `No keyboard or mouse for ${mins} minutes while your timer runs. Tell us what’s up so your hours stay right.`}</p>
      <div class="nd-l">${opts.map(([k, t, s], i) => `<button type="button" data-nd="${k}" class="${i === 0 ? 'on' : ''}"><b>${god && i === 0 ? `<span class="px">FIGHT:</span> ${t}` : t}</b><span>${s}</span></button>`).join('')}</div>
      <p class="nd-foot">${f.alerted ? `${owner ? esc(first(owner.name)) : 'The CEO'} has been told you were quiet. Answering adds your reason.` : `If there’s no answer soon, ${owner ? esc(first(owner.name)) : 'the CEO'} is told. Your timer keeps running either way.`}</p></div>` },
  });
  nudgeOpen.form.classList.add('nd-sheet');
  if (god) { nudgeOpen.form.classList.add('nd-god'); sfx('hit'); }
  const done = () => { nudgeOpen = null; };
  const md = nudgeOpen;
  const obs = new MutationObserver(() => { if (!document.contains(md.form)) { obs.disconnect(); done(); } });
  obs.observe(overlay(), { childList: true });
  md.form.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-nd]'); if (!b) return;
    b.disabled = true;
    try { await post(`/api/idle/flags/${f.id}/answer`, { answer: b.dataset.nd }); md.close(); toast(b.dataset.nd === 'back' ? 'Welcome back' : 'Thanks. It’s noted on your day.'); }
    catch (err) { b.disabled = false; md.setError(errMsg(err)); }
  });
}

// ============================== announcements ==============================
actions['ann-new'] = async () => {
  let n = 0;
  try { n = (await get('/api/team/threads')).threads.find((t) => t.special === 'company').count; } catch { /* the count is optional */ }
  const md = openModal({
    title: 'New announcement', submit: n ? `Post to all ${n} people` : 'Post it', wide: true,
    sub: 'Pinned in the company chat, sent to every device, even during quiet hours.',
    body: { toString: () => `<div class="field"><label class="f" for="an-t">Title</label><input id="an-t" name="title" maxlength="160" required placeholder="New shift timings from Monday"></div>
      <div class="field"><label class="f" for="an-b">Message</label><textarea id="an-b" name="body" rows="5" maxlength="6000" required></textarea></div>
      <label class="check"><input type="checkbox" name="confirm" value="1" checked><span>Ask everyone to confirm they’ve read it</span></label>
      <label class="check"><input type="checkbox" name="pin" value="1" checked><span>Pin it in the company chat</span></label>
      <label class="check"><input type="checkbox" name="remind" value="1"><span>Remind people who haven’t read it after 12 hours</span></label>` },
    onSubmit: async (fd) => {
      const a = await post('/api/announcements', { title: fd.get('title'), body: fd.get('body'), confirm: fd.get('confirm') === '1', pin: fd.get('pin') === '1', remind_after_h: fd.get('remind') === '1' ? 12 : null });
      toast('Announcement posted'); location.hash = `#/announcements?id=${a.id}`;
    },
  });
  void md;
};
let annHidden = new Set();
export async function refreshAnnBar() {
  const bar = document.getElementById('annbar');
  if (!bar || !S.me || S.me.kind === 'client') return;
  let list = [], det = null;
  try {
    const [l, d] = await Promise.all([get('/api/announcements/pending'), get('/api/me/details-request').catch(() => ({ request: null }))]);
    list = l.filter((a) => !annHidden.has(a.id)); det = d.request;
  } catch { return; }
  // HR asked you to update your details: stays here, on every page, until you send them (not on Profile, where the form is)
  const detPill = det && !/^#\/profile(\?|$)/.test(location.hash) ? `<button type="button" class="ab-pill det" data-ab="det" title="${esc(det.by || 'HR')} asked you${det.note ? `: ${esc(det.note)}` : ''}">${ic('idcard', 16)}<span class="ab-l">HR request</span><b>Update your ${esc(det.label)}</b><span class="ab-go">Update</span></button>` : '';
  const a = /^#\/announcements/.test(location.hash) ? null : list[0];
  const annPill = a ? `<button type="button" class="ab-pill" data-ab="read" data-id="${a.id}" title="Announcement from ${esc(a.author ? a.author.name : 'the CEO')}">${ic('mega', 16)}<span class="ab-l">Announcement</span><b>${esc(a.title)}</b>${list.length > 1 ? `<i>+${list.length - 1}</i>` : ''}<span class="ab-go">Read it</span></button>` : '';
  if (!detPill && !annPill) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = detPill + annPill;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('#annbar [data-ab]'); if (!b) return;
  if (b.dataset.ab === 'det') { location.hash = '#/profile?details=1'; return; }
  if (b.dataset.ab === 'later') { const id = Number(document.querySelector('#annbar [data-ab="read"]').dataset.id); annHidden.add(id); refreshAnnBar(); return; }
  openAnnouncement(Number(b.dataset.id));
});
export async function openAnnouncement(id) {
  let a;
  try { a = await get(`/api/announcements/${id}`); post(`/api/announcements/${id}/seen`).catch(() => {}); } catch (e) { toast(errMsg(e), true); return; }
  const md = openModal({ title: a.title, footer: false,
    body: { toString: () => `<p class="an-by">${a.author ? `${av(a.author, 24)}<b>${esc(a.author.name)}</b> · ` : ''}${esc(new Date(a.created_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</p>
      <div class="an-body">${esc(a.body).replace(/\n/g, '<br>')}</div>
      <div class="an-f">${a.confirmed ? `<span class="ac-ok">${ic('check', 15)}You’ve read it</span>` : a.confirm ? '<button type="button" class="btn primary" data-an="ok">I’ve read it</button>' : ''}<a class="btn" href="#/announcements?id=${a.id}" data-an="open">${S.me.role === 'owner' || S.me.role === 'manager' ? 'See who has read it' : 'All announcements'}</a></div>` } });
  md.form.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-an]'); if (!b) return;
    if (b.dataset.an === 'open') { md.close(); return; }
    b.disabled = true;
    try { await post(`/api/announcements/${a.id}/confirm`); md.close(); toast('Thanks. Marked as read.'); refreshAnnBar(); S.refresh(); } catch (err) { b.disabled = false; md.setError(errMsg(err)); }
  });
}

// ============================== god mode ==============================
// a shield drawn in pixels, with a lightning bolt on it
const SHIELD = ['..XXXXXXXX..', '.XGGGGGGGGX.', 'XGGYYYYYYGGX', 'XGYYYYWWYYGX', 'XGYYYWWYYYGX', 'XGYYWWWWYYGX', 'XGYYYYWWYYGX', '.XGYYYWYYGX.', '.XGGYWYYGGX.', '..XGGYYGGX..', '...XGGGGX...', '....XXXX....'];
export function shield(size = 120) {
  const col = { X: '#3A2A00', G: '#C99A1A', Y: '#FFD84D', W: '#FFFFFF' }, c = size / 12;
  const rects = SHIELD.flatMap((row, y) => [...row].map((ch, x) => (ch === '.' ? '' : `<rect x="${(x * c).toFixed(1)}" y="${(y * c).toFixed(1)}" width="${(c + 0.3).toFixed(1)}" height="${(c + 0.3).toFixed(1)}" fill="${col[ch]}"/>`))).join('');
  return `<svg class="gm-shield" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="God mode shield">${rects}</svg>`;
}
export function pixels(n = 20, seed = 3) {
  if (reduced()) return '';
  const cols = ['#FFD84D', '#FFD84D', '#7BE0B3', '#FF7AD9', '#8FD3FF'];
  let x = seed, out = '';
  for (let i = 0; i < n; i++) { x = (x * 9301 + 49297) % 233280; const r = x / 233280; x = (x * 9301 + 49297) % 233280; const r2 = x / 233280; const s = [4, 6, 8][i % 3]; out += `<i style="left:${Math.round(r * 94 + 3)}%;top:${Math.round(40 + r2 * 60)}%;width:${s}px;height:${s}px;background:${cols[i % cols.length]};animation-delay:-${(r2 * 4).toFixed(1)}s"></i>`; }
  return `<div class="gm-px" aria-hidden="true">${out}</div>`;
}
export function hud(pct, segs = 20) {
  const on = Math.max(pct > 0 ? 1 : 0, Math.round((segs * Math.max(0, Math.min(100, pct))) / 100));
  return `<span class="gm-hud" aria-hidden="true">${Array.from({ length: segs }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</span>`;
}
export function godIntro(fun) {
  if (document.querySelector('.gm-on')) return;
  const until = fun.until ? new Date(fun.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
  const owner = S.settings.owner_name ? { name: S.settings.owner_name } : null;
  const box = document.createElement('div');
  box.className = `gm-on${fun.calm ? ' calm' : ''}`; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'gm-on-t');
  box.innerHTML = `<div class="gm-scan"></div>${pixels(26, 7)}<div class="gm-on-in">
    <div class="px gm-code">&gt; CHEAT CODE ACCEPTED: IDDQD</div>
    <div class="gm-pop">${shield(150)}</div>
    <h1 id="gm-on-t" class="px gm-shine">GOD MODE</h1>
    <p>${esc(first(S.me.name))} is now invincible${until ? ` until ${esc(until)}` : ''}. Bugs fear you. Deadlines take half damage. ${owner ? esc(first(owner.name)) : 'The CEO'} approved this.</p>
    <div class="gm-tags"><span class="px t-y">HP <b>∞</b></span>${fun.double_xp ? '<span class="px t-g">XP ×2 TONIGHT</span>' : ''}<span class="px t-p">BUG SLAYER +1</span></div>
    <button type="button" class="px gm-start" data-gm="start">PRESS START</button>
    <span class="gm-note">Only you see this. Nothing about your access changes.</span></div>`;
  overlay().appendChild(box);
  const close = async () => { document.removeEventListener('keydown', onKey, true); box.classList.add('out'); setTimeout(() => box.remove(), 260); try { await put('/api/me/fun', { intro_seen: true }); } catch { /* shows again next time */ } };
  const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  box.addEventListener('click', (e) => { if (e.target.closest('[data-gm="start"]')) close(); });
  setTimeout(() => { const b = box.querySelector('[data-gm="start"]'); if (b) b.focus(); }, 60);
}
// ---------- god mode: 8-bit sounds (off until the person turns them on, for their own browser) ----------
let actx = null;
export const sfxOn = () => { try { return localStorage.getItem('wh-gm-sfx') === '1'; } catch { return false; } };
export const setSfx = (on) => { try { localStorage.setItem('wh-gm-sfx', on ? '1' : '0'); } catch { /* private window: stays off */ } };
const TUNES = { coin: [[988, 0.07], [1319, 0.18]], hit: [[196, 0.05], [98, 0.09]], up: [[523, 0.08], [659, 0.08], [784, 0.08], [1047, 0.24]],
  start: [[392, 0.12], [0, 0.48], [392, 0.12], [0, 0.48], [392, 0.12], [0, 0.48], [784, 0.32]], pause: [[784, 0.08], [523, 0.14]], save: [[659, 0.1], [784, 0.1], [988, 0.26]], crit: [[1047, 0.06], [1319, 0.06], [1568, 0.22]] };
export function sfx(kind) {
  if (!sfxOn() || !S.me || !S.me.fun_mode) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    let t = actx.currentTime;
    for (const [f, d] of TUNES[kind] || []) {
      if (f) { const o = actx.createOscillator(), g = actx.createGain(); o.type = 'square'; o.frequency.value = f; g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d); o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d); }
      t += d;
    }
  } catch { /* no sound on this browser */ }
}

// ---------- god mode: the moments ----------
// a full-screen moment that closes on a click, Esc or Enter, or by itself
function moment(cls, inner, { ms = 0, focus = '[data-gm]' } = {}) {
  const box = document.createElement('div');
  box.className = `gm-mo ${cls}`; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
  box.innerHTML = inner;
  overlay().appendChild(box);
  let timer = null;
  const close = () => { clearTimeout(timer); document.removeEventListener('keydown', onKey, true); box.classList.add('out'); setTimeout(() => box.remove(), 260); };
  const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  box.addEventListener('click', (e) => { if (e.target === box || e.target.closest('[data-gm]')) close(); });
  if (ms) timer = setTimeout(close, ms);
  setTimeout(() => { const b = box.querySelector(focus); if (b) b.focus(); }, 60);
  return { box, close };
}
// the timer just started: a three-second countdown (the timer is already running; it is only for show)
export function readyGo(fun) {
  if (document.querySelector('.gm-mo')) return;
  const boss = fun && fun.boss ? fun.boss.title : null;
  const { box } = moment(`gm-ready${fun && fun.calm ? ' calm' : ''}`, `<div class="gm-mo-in"><span class="px gm-mo-k">PLAYER 1</span><h2 class="px gm-shine">READY?</h2><b class="px gm-count" aria-live="polite">3</b>
    ${boss ? `<div class="gm-mo-boss"><span class="px">TONIGHT’S BOSS</span><span>${esc(boss)}</span></div>` : ''}<button type="button" class="px gm-start solid" data-gm="go">GO!</button></div>`, { ms: 4200, focus: '[data-gm="go"]' });
  sfx('start');
  const n = box.querySelector('.gm-count');
  [2, 1, 'GO!'].forEach((v, i) => setTimeout(() => { if (n.isConnected) { n.textContent = String(v); n.classList.remove('tick'); void n.offsetWidth; n.classList.add('tick'); } }, 600 * (i + 1) + 400 * i));
}
// on a break: a small card, gone by itself
export function pausedCard() {
  if (document.querySelector('.gm-paused')) return;
  const box = document.createElement('div');
  box.className = 'gm-paused'; box.setAttribute('role', 'status');
  box.innerHTML = '<b class="px gm-blink">PAUSED</b><span>Insert chai to continue.</span>';
  document.body.appendChild(box);
  sfx('pause');
  setTimeout(() => { box.classList.add('out'); setTimeout(() => box.remove(), 300); }, 4500);
}
// after the end-of-shift check-in: the night as a save screen
export function gameSaved(fun) {
  if (!fun || document.querySelector('.gm-mo')) return;
  const looted = fun.quests.filter((q) => q.status === 'done').length;
  const m = Math.round((fun.tonight_secs || 0) / 60);
  const row = (k, v, c = '') => `<div class="gm-sv-r"><span class="px">${k}</span><b class="px ${c}">${v}</b></div>`;
  moment(`gm-saved${fun.calm ? ' calm' : ''}`, `<div class="gm-mo-in"><h2 class="px gm-shine">GAME<br>SAVED</h2><div class="gm-sv">
    ${row('PLAYED', `${Math.floor(m / 60)}H ${String(m % 60).padStart(2, '0')}M`, 'g')}${row('XP', `+${Number(fun.tonight_xp || 0).toLocaleString()}`, 'y')}${row('QUESTS', `${looted} LOOTED`)}${fun.boss ? row('BOSS HP', `${fun.boss.hp}% LEFT`, 'r') : ''}</div>
    <p>Check-in sent. See you next shift, ${esc(first(S.me.name))}.</p><button type="button" class="px gm-start solid" data-gm="ok">CONTINUE</button></div>`);
  sfx('save');
}

export function levelUp(fun, quest, before) {
  if (document.querySelector('.gm-lv')) return;
  const up = before && fun.level > before.level;
  const pct = Math.round((100 * (fun.xp - fun.level_floor)) / Math.max(1, fun.level_next - fun.level_floor));
  const box = document.createElement('div');
  box.className = `gm-lv${fun.calm ? ' calm' : ''}`; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'gm-lv-t');
  box.innerHTML = `${pixels(14, 11)}<div class="gm-lv-in">
    <div class="px gm-code">QUEST CLEARED: ${esc(`${quest.ref ? `${quest.ref} ` : ''}${quest.title}`.toUpperCase().slice(0, 48))}</div>
    <h2 id="gm-lv-t" class="px gm-shine">${quest.early ? 'CRITICAL HIT!' : up ? 'LEVEL UP!' : 'NICE ONE!'}</h2>
    ${up ? `<div class="px gm-lvn"><span>${before.level}</span> <i>›</i> <b>${fun.level}</b></div>` : `<div class="px gm-lvn"><b>LV ${fun.level}</b></div>`}
    ${hud(pct)}
    <div class="gm-tags"><span class="px t-y">+${quest.early ? quest.xp * 2 : quest.xp} XP</span>${quest.early ? '<span class="px t-g">×2 FINISHED EARLY</span>' : ''}${quest.boss ? '<span class="px t-p">BOSS DEFEATED</span>' : ''}</div>
    <p>${quest.early ? 'Done before its due date. Double XP.' : quest.boss ? 'Cleared by its due date.' : 'One more off the board.'} ${fun.level_next - fun.xp} XP to level ${fun.level + 1}: every tracked minute counts.</p>
    <button type="button" class="px gm-start solid" data-gm="next">NEXT QUEST</button></div>`;
  overlay().appendChild(box);
  sfx(quest.early ? 'crit' : 'up');
  const close = () => { document.removeEventListener('keydown', onKey, true); box.classList.add('out'); setTimeout(() => box.remove(), 240); };
  const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  box.addEventListener('click', (e) => { if (e.target === box || e.target.closest('[data-gm="next"]')) close(); });
  setTimeout(() => { const b = box.querySelector('[data-gm="next"]'); if (b) b.focus(); }, 60);
}
// god mode: my own timer started or paused, from anywhere (the desktop app); the moment plays here
let lastTimer = null;
export async function godTimer() {
  if (!S.me || !S.me.fun_mode) { lastTimer = null; return; }
  let t;
  try { t = await get('/api/timer/current'); } catch { return; }
  const now = t.running ? 'run' : t.paused ? 'pause' : 'stop';
  const was = lastTimer; lastTimer = now;
  if (was === null) return;
  if (now === 'run' && was === 'stop') { let f = null; try { f = await get('/api/me/fun'); } catch { /* the countdown without the boss */ } readyGo(f); }
  else if (now === 'pause' && was === 'run') pausedCard();
}

// quests that just became done get the level-up screen
let lastFun = null;
export async function funWatch(fresh = null) {
  if (!S.me || S.me.kind === 'client' || !S.me.fun_mode) { lastFun = null; return null; }
  let f = fresh;
  if (!f) { try { f = await get('/api/me/fun'); } catch { return null; } }
  if (!f) { lastFun = null; return null; }
  if (lastFun) {
    const was = new Map(lastFun.quests.map((q) => [q.id, q.status]));
    const cleared = f.quests.find((q) => q.status === 'done' && was.has(q.id) && was.get(q.id) !== 'done');
    if (cleared) levelUp(f, cleared, lastFun);
  }
  lastFun = f;
  return f;
}
