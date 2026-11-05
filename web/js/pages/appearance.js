// Profile › Appearance: each person picks the colours of the whole app for themselves. The owner also
// picks the theme everyone starts with. Status colours (working, on break, late) never change.
import { html, raw } from '../util.js';
import { put } from '../api.js';
import { S, actions, toast, errMsg } from '../ui.js';
import { THEMES, applyTheme, swatches, previewStyle } from '../theme.js';

// a small picture of the app in a theme; its colours come from that theme's own variables
function mini(id, brand) {
  return html`<span class="ap-mini" style="${previewStyle(id, brand)}" aria-hidden="true"><span class="ap-mn"><i></i><i class="on"></i><i></i><i></i></span><span class="ap-mc">
    <span class="ap-h"><b>Today</b><u></u></span>
    <span class="ap-k"><span><s></s><em></em></span><span><s></s><em></em></span><span><s></s><em></em></span></span>
    <span class="ap-l"><span><i class="ok"></i><s></s><em></em></span><span><i class="warn"></i><s></s><em></em></span><span><i class="ok"></i><s></s><em></em></span></span></span></span>`;
}

export function appearanceTab(me, tabs) {
  const cur = me.theme || 'night', own = me.theme_own, def = me.theme_default || 'night';
  const owner = me.role === 'owner';
  const defName = (THEMES.find((t) => t.id === def) || THEMES[0]).name;
  return html`<div class="page-h"><div><h1>Appearance</h1><p class="sub">The colours of Staffwarden, for you</p></div>${tabs}</div>
  <div class="ap">
    <div class="ap-col">
      <section class="panel" aria-labelledby="ap-th"><header><h2 id="ap-th">Colour theme</h2></header><div class="body">
        <p class="muted ap-lead">Changes the colours of the whole app, for you only. It applies straight away, on every computer and phone you sign in on.</p>
        <div class="ap-gal" role="radiogroup" aria-labelledby="ap-th">
          ${THEMES.map((t) => { const on = t.id === cur; const sw = swatches(t.id, me.brand); return html`<button type="button" class="ap-c" role="radio" aria-checked="${on ? 'true' : 'false'}" tabindex="${on ? '0' : '-1'}" data-act="ap-pick" data-id="${t.id}" data-k="ap-${t.id}">
            ${mini(t.id, me.brand)}
            <span class="ap-nm">${on ? html`<span class="ap-ck" aria-hidden="true">${raw('<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>')}</span>` : ''}<b>${t.name}</b><span class="ap-sw" aria-hidden="true">${sw.map((c) => html`<i style="background:${c}"></i>`)}</span></span>
            <span class="ap-ds">${t.id === 'company' && !me.brand ? 'Teal, until your company adds a logo' : t.desc}${!own && t.id === def ? ' · everyone’s default' : ''}</span>
          </button>`; })}
        </div>
        ${own ? html`<p class="small muted ap-follow">You chose ${(THEMES.find((t) => t.id === own) || {}).name}. <button type="button" class="linkbtn" data-act="ap-pick" data-id="">Use everyone’s default (${defName})</button></p>` : ''}
      </div></section>
      ${owner ? html`<section class="panel" aria-labelledby="ap-ev"><div class="body ap-ev"><div class="ap-evt"><h2 id="ap-ev">For everyone</h2><p class="muted small">New people, and anyone who hasn’t picked a theme, start with this one. People can still choose their own.</p></div>
        <label class="sr" for="ap-def">Everyone’s theme</label><select id="ap-def" data-ap-def>${THEMES.map((t) => html`<option value="${t.id}" ${raw(t.id === def ? 'selected' : '')}>${t.name}</option>`)}</select></div></section>` : ''}
    </div>
    <aside class="ap-side">
      <section class="panel" aria-labelledby="ap-nc"><header><h2 id="ap-nc">These never change</h2></header><div class="body">
        <p class="muted small ap-lead">Status colours look the same in every theme, so everyone reads the team the same way.</p>
        <div class="ap-st"><span class="tag present"><i></i>Working</span><span class="muted small">On the timer, done, approved</span>
          <span class="tag pending"><i></i>On break</span><span class="muted small">Breaks, waiting, nothing planned</span>
          <span class="tag absent"><i></i>Late</span><span class="muted small">Late, overdue, absent</span></div></div></section>
      <section class="panel" aria-labelledby="ap-fy"><header><h2 id="ap-fy">Follows you</h2></header><div class="body"><p class="muted small" style="margin:0;line-height:1.5">Saved to your account, so the app matches on every computer and phone you sign in on. Payslips, PDFs and the client portal keep your company’s own look, and the desktop app keeps Night Glass for now.</p></div></section>
    </aside>
  </div>`;
}

async function pick(id) {
  const prev = S.me.theme;
  const t = THEMES.find((x) => x.id === (id || S.me.theme_default)) || THEMES[0];
  // straight away (a short cross-fade, unless the person asked for less motion), then saved
  const root = document.documentElement;
  root.classList.add('th-fade'); setTimeout(() => root.classList.remove('th-fade'), 450);
  applyTheme(t.id, S.me.brand);
  try {
    const r = await put('/api/me/theme', { theme: id || null });
    Object.assign(S.me, r);
    applyTheme(S.me.theme, S.me.brand);
    toast(id ? `${t.name} is on` : `Back to everyone’s default, ${t.name}`);
    S.refresh();
  } catch (e) { applyTheme(prev, S.me.brand); toast(errMsg(e), true); }
}
actions['ap-pick'] = (el) => pick(el.dataset.id);

// arrow keys move between themes, as in any set of radio buttons
document.addEventListener('keydown', (e) => {
  const c = e.target.closest && e.target.closest('.ap-c');
  if (!c || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  const all = [...document.querySelectorAll('.ap-c')], i = all.indexOf(c);
  const n = all[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length];
  n.focus(); pick(n.dataset.id);
});
document.addEventListener('change', async (e) => {
  if (!e.target.matches || !e.target.matches('[data-ap-def]')) return;
  try { await put('/api/theme-default', { theme: e.target.value }); S.me = await (await import('../api.js')).get('/api/me'); applyTheme(S.me.theme, S.me.brand); toast('Everyone’s default theme saved'); S.refresh(); } catch (err) { toast(errMsg(err), true); }
});
