// God mode on someone's dashboard (only ever a look: the same numbers, no new permissions), the
// owner's switch for it, and the owner's "Needs a nudge" board for idle or barely active timers.
import { html, raw, esc, initials, avColor, plural, callName } from '../util.js';
import { get, post, put } from '../api.js';
import { S, actions, toast, errMsg, openModal } from '../ui.js';
import { openTask } from './tasks.js';
import { shield, pixels, hud } from '../v4.js';

const PIC = {
  bolt: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>', task: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12.5l2.5 2.5 4.5-5.5"/>',
  moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>', inbox: '<path d="M3.5 13.5l2.5-8h12l2.5 8v5h-17z"/><path d="M3.5 13.5h5l1 2h5l1-2h5"/>',
  cup: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16"/>', clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  shieldo: '<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z"/>', lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  msg: '<path d="M4 5h16v11H9l-5 4z"/>',
};
const pi = (n, s = 18) => raw(`<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PIC[n]}</svg>`);
const av = (u, size = 36) => html`<span class="cav" style="width:${size}px;height:${size}px;background:${avColor(u.id)};font-size:${Math.round(size * 0.38)}px" aria-hidden="true">${initials(u.name)}</span>`;
const n0 = (n) => Number(n || 0).toLocaleString();
const hm = (s) => { const m = Math.round((s || 0) / 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const first = (n) => callName(n);

// ---------- god mode: the band ----------
export function godBand(f, d) {
  const pct = Math.round((100 * (f.xp - f.level_floor)) / Math.max(1, f.level_next - f.level_floor));
  const next = f.quests.find((q) => q.status !== 'done');
  const quips = ['The bugs heard you were coming.', 'Deadlines are nervous.', 'The board fears you.', 'Respawn complete. Let’s go.'];
  const quip = quips[(new Date().getDate() + S.me.id) % quips.length];
  return html`<div class="page-h gm-band${f.calm ? ' calm' : ''}">${raw(pixels(16, 5))}
    <div class="gm-bt"><div><div class="px gm-k">${raw(shield(20))}<span>GOD MODE ACTIVE</span></div><h1>Welcome back, ${first(S.me.name)}. ${quip}</h1></div>
      <div class="tools">${next ? html`<button type="button" class="px gm-press" data-act="gm-start" data-id="${next.id}">▸ PRESS START</button>` : html`<a class="px gm-press" href="#/tasks">▸ PRESS START</a>`}</div></div>
    <div class="gm-hudc">
      <div class="gm-p1"><span class="gm-av">${av({ id: S.me.id, name: S.me.name }, 50)}<span class="px">LV ${f.level}</span></span><span><span class="px gm-pl">PLAYER 1</span><b>${S.me.name}</b></span></div>
      <div class="gm-xp"><div class="gm-xph"><span class="px">XP TO LEVEL ${f.level + 1}</span><span class="px gm-xpn">${n0(f.xp)} / ${n0(f.level_next)}</span></div>${raw(hud(pct, 20))}<span class="gm-xps">1 minute tracked = 1 XP.${f.double_xp ? ' Double tonight.' : ''}</span></div>
      <div class="gm-st"><span class="px">HP</span><b class="gm-inf">∞</b></div>
      <div class="gm-st"><span class="px">STREAK</span><b class="px gm-streak">${f.streak}</b><small>${f.streak === 1 ? 'night' : 'nights'} checked in</small></div>
    </div></div>`;
}
// ---------- god mode: quests, tonight, effects, achievements ----------
const ACH = { bug: ['bolt', 'y'], owl: ['moon', 'b'], zero: ['inbox', 'g'], chai: ['cup', 'p'], speed: ['clock', 'y'], boss: ['shieldo', 'p'] };
export function godPanels(f, d) {
  const k = d.kpis;
  const onBoard = f.quests.filter((q) => q.status !== 'done').reduce((n, q) => n + q.xp, 0);
  const label = { in_progress: ['IN PROGRESS', 'ip'], in_review: ['IN REVIEW', 'ir'], done: ['CLEARED', 'ok'], todo: ['NEXT', ''] };
  const quests = html`<section class="panel gm-q"><header><h2>Tonight’s quests</h2><span class="px gm-qx">${onBoard} XP ON THE BOARD</span></header>
    ${f.quests.length ? html`<ul class="gm-ql">${f.quests.map((q) => { const [t, c] = label[q.status] || ['NEXT', '']; return html`<li data-k="q${q.id}"><button type="button" class="gm-qr${q.status === 'done' ? ' done' : ''}" data-act="open-task" data-id="${q.id}">
      <span class="gm-qi${q.boss ? ' boss' : ''}">${pi(q.boss ? 'bolt' : 'task', 17)}</span><span class="gm-qt"><b>${q.title}</b><span>${q.ref || 'No project'}${q.boss ? ' · Boss level: due tonight' : ''}</span></span>
      <span class="px gm-qs ${c}">${t}</span><span class="px gm-qp">+${q.xp} XP</span></button></li>`; })}</ul>` : html`<div class="body"><p class="muted">No quests on your board. Ask your lead for one, or add your own on Tasks.</p></div>`}</section>`;
  const tonight = html`<section class="panel"><header><h2>Tonight</h2></header><div class="body">
    <div class="gm-ton"><b class="num">${hm(k.worked_secs)}</b><span>tracked · <span class="gm-plus">+${n0(f.tonight_xp)} XP</span></span></div>
    <span class="gm-tbar"><i style="width:${Math.min(100, Math.round((100 * k.worked_secs) / Math.max(1, k.daily_target_secs)))}%"></i></span>
    <div class="gm-two"><div><span>Activity</span><b>${k.activity_pct == null ? '–' : `${k.activity_pct}%`}</b></div><div><span>Breaks</span><b>${hm(k.break_secs)}</b></div></div>
    <p class="hint">Same numbers as always. God mode only changes how they look. <a href="#/${S.me.role === 'owner' || S.me.role === 'manager' ? 'me' : ''}?day=${d.day}">See the normal view</a></p></div></section>`;
  const effects = html`<section class="panel gm-fx"><div class="body"><div><b>Effects</b><span>Too much? Keep the look and stop the moving parts.</span></div>
    <div class="cseg" role="radiogroup" aria-label="Effects"><button type="button" data-act="gm-calm" data-v="0" aria-current="${f.calm ? 'false' : 'page'}">Full power</button><button type="button" data-act="gm-calm" data-v="1" aria-current="${f.calm ? 'page' : 'false'}">Calm</button></div></div></section>`;
  const got = f.achievements.filter((a) => a.got).length;
  const ach = html`<section class="panel gm-a"><header><h2>Achievements</h2><span class="muted small">${got} of ${f.achievements.length} unlocked</span></header><div class="gm-ag">
    ${f.achievements.map((a) => { const [i, c] = ACH[a.key] || ['bolt', 'y']; return html`<div class="gm-ac ${a.got ? `got ${c}` : ''}" data-k="a${a.key}"><span class="gm-ai">${pi(i, 19)}</span><b class="px">${a.name.toUpperCase()}</b><span>${a.sub}</span></div>`; })}</div></section>`;
  const lock = html`<p class="gm-lock">${pi('lock', 16)}<span>Screenshots, tracking and who sees what are still ${S.settings.owner_name ? first(S.settings.owner_name) : 'the owner'}’s settings. God mode can’t touch them, however powerful it feels.</span></p>`;
  return html`<div class="cols gm-cols"><div>${quests}</div><div>${tonight}${effects}${lock}</div></div>${ach}`;
}
actions['gm-start'] = (el) => openTask(Number(el.dataset.id)).catch(() => { location.hash = '#/tasks'; });
actions['gm-calm'] = async (el) => { try { await put('/api/me/fun', { calm: el.dataset.v === '1' }); S.refresh(); } catch (e) { toast(errMsg(e), true); } };

// ---------- the owner's switch, from People ----------
actions['fun-edit'] = async (el) => {
  const id = Number(el.dataset.id), name = el.dataset.name;
  let cur;
  try { cur = await get(`/api/people/${id}/fun`); } catch (e) { toast(errMsg(e), true); return; }
  const on = cur.mode === 'god';
  const fn = first(name);
  const md = openModal({ title: `Fun modes for ${fn}`, submit: on ? 'Save' : 'Turn on god mode', wide: true, sub: `Only changes how Staffwarden looks for ${fn}. ${fn} gets no new permissions, and can calm the animations down.`,
    body: { toString: () => `<div class="gm-sw"><span class="gm-swi">${shield(44)}</span><span class="gm-swt"><b class="px">GOD MODE</b><span>Arcade look on their dashboard: XP from tracked minutes, quests from their tasks, achievements, and a level-up when they finish a task.</span></span>
        <span class="switch"><input type="checkbox" name="on" value="1" aria-label="God mode" checked><span></span></span></div>
      <div class="grid2"><div class="field"><label class="f" for="fm-u">How long</label><select id="fm-u" name="until"><option value="">Until I turn it off</option><option value="shift">Tonight only (till the shift ends)</option><option value="week">For a week</option></select></div>
        <div class="field"><label class="f" for="fm-x">Double XP</label><select id="fm-x" name="xp2"><option value="">No</option><option value="10">Tonight only</option><option value="72">For three days</option></select></div></div>
      <label class="check"><input type="checkbox" name="intro" value="1" ${on ? '' : 'checked'}><span>Show the “cheat code accepted” screen once</span></label>
      <label class="check"><input type="checkbox" name="announce" value="1"><span>Post it in the company chat</span></label>
      <ul class="gm-same"><li>${'Screenshots, time tracking, other-device mode and their role stay exactly as they are'}</li><li>Only you can turn it on or off</li></ul>` },
    onSubmit: async (fd) => {
      const want = fd.get('on') === '1';
      let until = null;
      if (fd.get('until') === 'week') until = new Date(Date.now() + 7 * 86400000).toISOString();
      if (fd.get('until') === 'shift') { const t = new Date(); t.setHours(t.getHours() + 12); until = t.toISOString(); }
      await put(`/api/people/${id}/fun`, want ? { mode: 'god', until, xp2_hours: fd.get('xp2') ? Number(fd.get('xp2')) : null, intro: fd.get('intro') === '1', announce: fd.get('announce') === '1' } : { mode: null });
      toast(want ? `God mode is on for ${fn}` : `God mode is off for ${fn}`); S.refresh();
    } });
  void md;
};

// ---------- the owner's "Needs a nudge" board ----------
const t12 = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const SAID = { break: 'On a break', meeting: 'In a meeting', reading: 'Reading or thinking', back: 'Back to work' };
export function nudgeBoard(b) {
  const owner = S.me.role === 'owner';
  const r = b.rules;
  const card = (f) => {
    const idle = f.kind === 'idle';
    const line = idle ? `Idle ${f.idle_min ?? '?'} min${f.answer && f.answer !== 'back' ? '' : ', timer still running'}` : `${f.activity ?? f.detail?.pct ?? 0}% activity in the last hour`;
    const said = f.answer ? `Said “${SAID[f.answer]}” at ${t12(f.answered_at)}.` : `Asked “Still there?” at ${t12(f.asked_at)}. No answer yet.`;
    const tone = !f.answer && f.alerted ? 'bad' : 'warn';
    return html`<article class="nb-c ${tone}" data-k="f${f.id}"><div class="nb-h">${av(f.user, 38)}<span><b>${f.user.name}</b><span class="nb-l">${line}</span></span></div><p>${said}</p>
      <div class="nb-a"><button type="button" class="btn sm" data-act="ci-reply" data-id="${f.user.id}">${pi('msg', 15)} Message</button><a class="linkbtn" href="#/timeline?user=${f.user.id}">See the day</a></div></article>`;
  };
  const board = html`<section class="panel nb"><header><h2>Needs a nudge</h2>${b.flags.length ? html`<span class="an-pill bad">${plural(b.flags.length, 'person', 'people')}</span>` : ''}</header><div class="body">
    ${b.flags.length ? html`<div class="nb-g">${b.flags.map(card)}</div>` : html`<p class="muted">Nobody right now. People are asked first; you hear if it goes on${r.on ? '' : ', but the rules are off'}.</p>`}</div></section>`;
  if (!owner) return b.flags.length ? board : '';
  const sel = (name, val, opts, unit) => html`<select class="nb-sel" data-idle="${name}" aria-label="${unit}">${opts.map((o) => html`<option value="${o}" ${o === val ? raw('selected') : ''}>${o}</option>`)}</select>`;
  const rules = html`<section class="panel nb-r"><header><h2>When Staffwarden flags someone</h2></header><div class="body"><ul class="nb-rl">
    <li><span class="switch"><input type="checkbox" data-idle="on" aria-label="Ask when idle" ${r.on ? raw('checked') : ''}><span></span></span><span>Ask “Still there?” after <span class="nowrap">${sel('ask_min', r.ask_min, [10, 15, 20, 30], 'minutes idle')} min</span> idle</span></li>
    <li><span class="switch"><input type="checkbox" disabled checked aria-label="Tell me"><span></span></span><span>Tell me after <span class="nowrap">${sel('alert_min', r.alert_min, [20, 30, 45, 60, 90], 'minutes idle before I hear')} min</span> idle with the timer on</span></li>
    <li><span class="switch"><input type="checkbox" data-idle="low_on" aria-label="Low activity" ${r.low_on ? raw('checked') : ''}><span></span></span><span>Tell me when activity is under <span class="nowrap">${sel('low_pct', r.low_pct, [10, 15, 20, 30, 40], 'percent activity')}%</span> for an hour</span></li>
    <li><span class="switch"><input type="checkbox" data-idle="tell_lead" aria-label="Tell their team lead" ${r.tell_lead ? raw('checked') : ''}><span></span></span><span>Also tell their team lead</span></li></ul>
    <p class="hint">People are always asked first, and see the same rules you set. Breaks, time off and “In a meeting” don’t count. HR never sees this.</p></div></section>`;
  if (!b.flags.length) {
    // nobody to nudge: one quiet line, with the rules folded inside
    return html`<details class="panel nb-mini" data-k="nbmini"><summary><span class="nb-ok"></span><b>Nobody needs a nudge</b><span class="muted">${r.on ? `People are asked after ${r.ask_min} min idle; you hear after ${r.alert_min}` : 'Idle nudges are off'}</span><span class="linkbtn">Rules</span></summary><div class="nb-mb">${rules}</div></details>`;
  }
  return html`<div class="cols nb-cols"><div>${board}</div><div>${rules}</div></div>`;
}
document.addEventListener('change', async (e) => {
  const el = e.target.closest && e.target.closest('[data-idle]');
  if (!el) return;
  const k = el.dataset.idle;
  const body = el.type === 'checkbox' ? { [k]: el.checked } : { [k]: Number(el.value) };
  try { await put('/api/idle/rules', body); toast('Saved'); S.refresh(); } catch (err) { toast(errMsg(err), true); }
});
void esc; void post;
