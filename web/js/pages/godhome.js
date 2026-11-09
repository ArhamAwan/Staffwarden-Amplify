// God mode as someone's home: when the owner turns it on, their dashboard becomes this. The same hours,
// tasks and team as the normal view, shown as a game: an arcade clock, hearts for the shift left, a boss
// fight for the most pressing task, the team as a party, loot for achievements. It only changes the look:
// no new permissions, and the normal view is one click away ("Boring view").
import { html, raw, initials, avColor, callName, minOfDayIn, hhmmText, nowMs } from '../util.js';
import { get, put } from '../api.js';
import { S, actions, toast, errMsg } from '../ui.js';
import { openTask } from './tasks.js';
import { shield, pixels, hud, funWatch, godIntro, sfxOn, setSfx, sfx } from '../v4.js';

const n0 = (n) => Number(n || 0).toLocaleString();
const hm = (s) => { const m = Math.round((s || 0) / 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const hmS = (s) => { const m = Math.floor((s || 0) / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const hhmm = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); };

// a class for everyone, from their job title
const CLASSES = [
  [/clos/i, 'Closer Rogue'], [/call|dial|agent|telesales/i, 'Dialer Knight'], [/setter|appointment/i, 'Quest Giver'],
  [/dev|engineer|cto|code|program/i, 'Code Wizard'], [/design|creative|video|editor|art/i, 'Pixel Bard'],
  [/hr|finance|account|payroll/i, 'Gold Keeper'], [/market|ads|seo|social/i, 'Hype Mage'], [/bid|upwork|business|sales/i, 'Deal Hunter'],
  [/support|help/i, 'Shield Bearer'], [/ceo|coo|founder|owner|director|head|manager|lead/i, 'Party Leader'],
];
export const classOf = (title) => (CLASSES.find(([re]) => re.test(title || '')) || [null, 'Adventurer'])[1];
const EPITHETS = ['UNKILLABLE', 'UNSTOPPABLE', 'RELENTLESS', 'LEGENDARY'];
const TAUNTS = [
  'The bugs filed a complaint about you. HR ignored it.', 'Deadlines are checking under the bed for you.',
  'Your keyboard asked for a raise.', 'The task board just flinched.', 'Somewhere, a spreadsheet is nervous.', 'Chai levels: dangerously effective.',
];
const MONSTERS = ['The Lead Hydra', 'The Deadline Dragon', 'The Inbox Golem', 'The Bug King', 'The Spreadsheet Kraken'];
// the boss, drawn in pixels
const SPRITE = ['.g..gg..g.', 'gg.gggg.gg', '.gggggggg.', 'ggwkggwkgg', 'ggwkggwkgg', 'gggggggggg', 'gdrrrrrrdg', '.gdwdwdwg.'];
const SPRITE_C = { '.': 'transparent', g: '#5BD48A', d: '#2E8A55', w: '#FFFFFF', k: '#0B1020', r: '#FF5D73' };
const sprite = () => raw(`<div class="gh-mon" aria-hidden="true">${SPRITE.join('').split('').map((c) => `<i style="background:${SPRITE_C[c]}"></i>`).join('')}</div>`);
const heart = (on) => raw(`<svg class="gh-heart${on ? ' on' : ''}" width="18" height="16" viewBox="0 0 9 8" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="M1 1h3v1h1V1h3v3H7v1H6v1H5v1H4V6H3V5H2V4H1z"/></svg>`);
const crown = raw('<svg class="gh-crown" width="44" height="22" viewBox="0 0 8 4" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="M0 0h1v1h1v1h1V0h2v2h1V1h1V0h1v4H0z"/></svg>');
const stars = (n) => '★'.repeat(n) + '☆'.repeat(3 - n);
const diff = (xp) => (xp <= 40 ? 1 : xp <= 90 ? 2 : 3);

// how much of the shift is left: hearts, ten for a whole shift
function shiftLeft(u) {
  if (!u || !u.shift_start || !u.shift_end) return null;
  const s = hhmm(u.shift_start), e = hhmm(u.shift_end), len = ((e - s + 1440) % 1440) || 1440;
  const into = (minOfDayIn(u.tz_offset_min ?? 0) - s + 1440) % 1440;
  if (into >= len) return { left: len, len, on: false };
  return { left: len - into, len, on: true };
}

export const godHome = {
  title: 'Home',
  async load() {
    const [fun, d, team] = await Promise.all([get('/api/me/fun'), get('/api/dashboard/me'), get('/api/team/now').catch(() => null)]);
    return { fun, d, team };
  },
  after(root, data) {
    if (!data.fun) return;
    funWatch(data.fun);
    if (data.fun.intro) godIntro(data.fun);
  },
  render({ fun: f, d, team }) {
    if (!f) return html`<div class="page-h"><div><h1>God mode is off</h1><p class="sub">The owner switched it off. Your normal dashboard is back.</p></div></div><section class="panel"><div class="body"><a class="btn primary" href="#/me">Open your day</a></div></section>`;
    const me = S.me, k = d.kpis, lv = d.live || { state: 'offline' }, u = { ...S.me, ...(d.user || {}) };
    const firstName = callName(me.name).toUpperCase();
    const epithet = EPITHETS[me.id % EPITHETS.length];
    const taunt = TAUNTS[(new Date().getDate() + me.id) % TAUNTS.length];
    const pct = Math.round((100 * (f.xp - f.level_floor)) / Math.max(1, f.level_next - f.level_floor));
    const sh = shiftLeft(u);
    const hearts = sh ? Math.max(0, Math.min(10, Math.ceil((10 * sh.left) / sh.len))) : 10;
    const mgr = me.role === 'owner' || me.role === 'manager';

    // the arcade clock: tonight's time, ticking while the timer runs
    const working = lv.state === 'working' || (lv.state === 'idle' && lv.counted);
    const since = working ? new Date(nowMs() - (k.worked_secs || 0) * 1000).toISOString() : null;
    const status = working ? html`<span class="gh-st play"><b class="gm-blink">▶</b> PLAYING${lv.project ? html` · <span>${lv.project}</span>` : ''}</span>`
      : lv.state === 'break' || lv.state === 'idle' ? html`<span class="gh-st pause">❚❚ PAUSED · insert chai to continue</span>`
        : html`<span class="gh-st off">PRESS START in the desktop app</span>`;

    const band = html`<div class="page-h gh-band${f.calm ? ' calm' : ''}">${raw(pixels(14, 9))}
      <div class="gh-top"><span class="px gh-on"><i></i>GOD MODE ON${f.double_xp ? ' · XP ×2 TONIGHT' : ''}</span>
        <div class="tools"><button type="button" class="px gh-tool" data-act="gm-sound" aria-pressed="${String(sfxOn())}">8-BIT SOUNDS: ${sfxOn() ? 'ON' : 'OFF'}</button><a class="gh-boring" href="#/me">Boring view</a></div></div>
      <div class="gh-hero">
        <div class="gh-me"><div class="gh-ava gm-bob">${crown}<span style="background:${avColor(me.id)}">${initials(me.name)}</span></div>
          <div class="gh-who"><span class="px gh-cls">PLAYER 1 · ${classOf(me.title).toUpperCase()}</span><h1 class="px gm-shine">${firstName} THE<br>${epithet}</h1><p>${taunt}</p></div></div>
        <div class="gh-clock gm-glow"><div class="gh-cl-h"><span class="px">TIME ON THE CLOCK</span><span class="px">HI ${hmS(f.best_secs)}</span></div>
          <div class="px gh-time" ${since ? raw(`data-since="${since}"`) : ''}>${hmS(k.worked_secs)}</div>${status}</div>
      </div>
      <div class="gh-hud">
        <div class="gh-t hp"><span class="px">HP · SHIFT LEFT</span><span class="gh-hearts" role="img" aria-label="${hearts} of 10 hearts">${Array.from({ length: 10 }, (_, i) => heart(i < hearts))}</span><small>${sh ? (sh.on ? `${hm(sh.left * 60)} of the shift to go` : `Full health. Shift starts ${hhmmText(u.shift_start)}`) : 'No shift set'}</small></div>
        <div class="gh-t mana"><span class="px">MANA · ACTIVITY</span><span class="gh-bar"><i style="width:${k.activity_pct ?? 0}%"></i></span><small>${k.activity_pct == null ? 'Starts when the timer does' : `${k.activity_pct}% tonight`}</small></div>
        <div class="gh-t xp"><span class="px">XP · LV ${f.level} › ${f.level + 1}</span>${raw(hud(pct, 12))}<small>${n0(f.xp)} of ${n0(f.level_next)}${f.double_xp ? ' · double tonight' : ''}</small></div>
        <div class="gh-t combo"><span class="px">COMBO</span><b class="px${f.combo ? ' gm-shake' : ''}">×${f.combo}</b><small>${f.combo === 1 ? 'Task' : 'Tasks'} done since your last break</small></div>
        <div class="gh-t streak"><span class="px">STREAK</span><b class="px">${f.streak} ${f.streak === 1 ? 'NIGHT' : 'NIGHTS'}</b><small>Checked in every shift</small></div>
      </div></div>`;

    // the boss: the most pressing open task
    const b = f.boss;
    const boss = b ? html`<section class="gh-boss" aria-label="Boss fight">
      <div class="gm-bob">${sprite()}</div>
      <div class="gh-boss-b"><div class="gh-boss-h"><span class="px gm-blink">⚠ BOSS FIGHT${b.overdue ? ' · OVERDUE' : b.due_day ? ' · DUE SOON' : ` · ${String(b.priority).toUpperCase()}`}</span><span class="px gh-xp">+${b.xp} XP</span></div>
        <h2>${MONSTERS[b.id % MONSTERS.length]}: ${b.title}</h2>
        <div class="gh-hp"><span class="px">BOSS HP</span><span>${b.steps ? `${b.steps_done} of ${b.steps} steps done` : 'No steps yet: add some to chip away at it'}</span></div>
        <span class="gh-hpbar"><i style="width:${b.hp}%"></i></span>
        <div class="gh-atk"><button type="button" class="px gh-attack" data-act="gm-attack" data-id="${b.id}">ATTACK</button><span>${b.next_step ? `Next: ${b.next_step}` : 'Opens the task.'}</span></div></div></section>`
      : html`<section class="gh-boss clear"><div class="gh-boss-b"><span class="px">NO BOSS TONIGHT</span><h2>Nothing overdue or urgent on your board.</h2><p>Side quests below, or ask your lead for a worthy foe.</p></div></section>`;

    const LBL = { in_progress: ['IN BATTLE', 'b'], in_review: ['JUDGMENT', 'y'], done: ['LOOTED', 'g'], todo: ['NEXT UP', ''] };
    const quests = f.quests.filter((q) => !b || q.id !== b.id);
    const onBoard = f.quests.filter((q) => q.status !== 'done').reduce((n, q) => n + q.xp, 0);
    const log = html`<section class="gh-panel"><header><h2>Quest log</h2><span class="px gh-xp">${n0(onBoard)} XP ON THE BOARD</span></header>
      ${quests.length ? html`<ul class="gh-ql">${quests.map((q, i) => { const [t, c] = q.status === 'todo' && i > 0 ? ['SIDE QUEST', ''] : (LBL[q.status] || LBL.todo); return html`<li data-k="q${q.id}"><button type="button" class="gh-q${q.status === 'done' ? ' done' : ''}" data-act="open-task" data-id="${q.id}">
        <span class="px gh-qs ${c}">${t}</span><span class="gh-qt"><b>${q.title}</b><span>${q.ref || 'No project'} · difficulty ${stars(diff(q.xp))}</span></span><span class="px gh-qx${q.status === 'done' ? ' g' : ''}">+${q.early ? q.xp * 2 : q.xp} XP${q.early ? ' ×2' : ''}</span></button></li>`; })}</ul>`
        : html`<p class="gh-none">No quests on your board. Ask your lead for one, or add your own on Tasks.</p>`}</section>`;

    // the team as a party
    const members = team && team.members ? team.members.filter((m) => !m.me).slice(0, 8) : [];
    const ST = { working: ['IN BATTLE', 'g'], break: ['RESTING', 'y'], idle: ['AFK', ''], no_signal: ['LOST SIGNAL', ''] };
    const party = html`<section class="gh-panel"><header><h2>Your party</h2><a href="${mgr ? '#/team' : '#/me'}">${mgr ? 'Full team view' : 'Who’s on'}</a></header>
      ${members.length ? html`<ul class="gh-party">${members.map((m) => { const [t, c] = ST[m.state] || (m.attendance === 'not_started' || m.attendance === 'upcoming' ? ['RESPAWNING', ''] : ['OFFLINE', '']); const w = Math.min(100, Math.round(((m.worked_secs || 0) / (8 * 3600)) * 100)); return html`<li data-k="p${m.user_id}" class="${t === 'OFFLINE' || t === 'RESPAWNING' ? 'off' : ''}">
        <span class="gh-pav" style="background:${avColor(m.user_id)}">${initials(m.name)}</span><span class="gh-pm"><span class="gh-pn"><b>${callName(m.name)} · ${classOf(m.title)}</b><span class="px gh-ps ${c}">${t}</span></span><span class="gh-pbar ${c}"><i style="width:${w}%"></i></span></span></li>`; })}</ul>`
        : html`<p class="gh-none">Solo run tonight.</p>`}</section>`;

    const got = f.achievements.filter((a) => a.got).length;
    const loot = html`<section class="gh-panel"><header><h2>Loot</h2><span class="gh-sub">${got} of ${f.achievements.length}</span></header>
      <div class="gh-loot">${f.achievements.map((a) => html`<div class="gh-li${a.got ? ' got' : ''}" data-k="a${a.key}"><b class="px">${a.name.toUpperCase()}</b><span>${a.sub}</span></div>`)}</div></section>`;

    const foot = html`<div class="gh-foot"><div class="gh-fx"><span>Effects</span><div class="gh-seg" role="radiogroup" aria-label="Effects"><button type="button" data-act="gm-calm" data-v="0" aria-pressed="${String(!f.calm)}">Full power</button><button type="button" data-act="gm-calm" data-v="1" aria-pressed="${String(!!f.calm)}">Calm</button></div></div>
      <p>${raw(shield(18))}<span>Same hours, same numbers: god mode only changes how they look. Screenshots and tracking are still ${S.settings.owner_name ? callName(S.settings.owner_name) : 'the CEO'}’s settings. <a href="#/me">Boring view</a></span></p></div>`;

    return html`${band}<div class="gh-body${f.calm ? ' calm' : ''}"><div class="gh-main">${boss}${log}</div><div class="gh-side">${party}${loot}${foot}</div></div>`;
  },
};

actions['gm-attack'] = (el) => { sfx('hit'); openTask(Number(el.dataset.id)).catch(() => { location.hash = '#/tasks'; }); };
actions['gm-sound'] = () => { setSfx(!sfxOn()); if (sfxOn()) sfx('coin'); S.refresh(); toast(sfxOn() ? '8-bit sounds on' : '8-bit sounds off'); };
