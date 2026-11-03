// The team's own chat, like WhatsApp for work: everyone at the company, channels, groups and direct
// messages. The list on the left, the chat in the middle (the same live chat the client chats use), and
// replies to one message on the right. On a phone it is one pane at a time.
import { html, raw, esc, plural, owl } from '../util.js';
import { get, post } from '../api.js';
import { S, actions, toast, errMsg, openModal } from '../ui.js';
import { morph } from '../morph.js';
import { mountChat, chatAvatar as av, chatIcon as ic, chatTime, chatDay, chatTicks } from '../chat.js';

let last = null;                 // the latest list, for drawing the list again without a reload
let search = { q: '', hits: null, busy: false };
const narrow = () => matchMedia('(max-width: 760px)').matches;
const hashQ = () => new URLSearchParams(location.hash.split('?')[1] || '');
const go = (k, v) => { const q = hashQ(); if (v == null || v === '') q.delete(k); else q.set(k, v); if (k === 't') q.delete('r'); location.hash = `#/chat${q.toString() ? `?${q}` : ''}`; };

const when = (iso) => {
  if (!iso) return '';
  const d = chatDay(iso);
  return d === 'Today' ? chatTime(iso) : d === 'Yesterday' ? 'Yesterday' : d.length > 9 ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.slice(0, 3);
};
function glyph(t, size = 36) {
  if (t.special === 'company') return raw(`<span class="tch-g co" style="width:${size}px;height:${size}px">${owl('still')}</span>`);
  if (t.special === 'announcements') return raw(`<span class="tch-g ann" style="width:${size}px;height:${size}px">${ic('mega', 18)}</span>`);
  if (t.kind === 'channel') return raw(`<span class="tch-g ch" style="width:${size}px;height:${size}px">${ic(t.private ? 'lock' : 'hash', 18)}</span>`);
  if (t.kind === 'team_group') return raw(`<span class="tch-g gr" style="width:${size}px;height:${size}px">${ic('users', 18)}</span>`);
  const w = t.with || { kind: 'staff', id: 0, name: t.name };
  return raw(`<span class="ch-avw">${av(w, size)}${w.online ? '<i class="ch-on" aria-label="Online"></i>' : ''}</span>`);
}
const title = (t) => (t.kind === 'channel' && !t.special ? t.name : t.name);
function preview(t) {
  if (!t.last) return t.topic || (t.kind === 'channel' ? 'No messages yet' : 'Say hello');
  const first = t.last.mine ? 'You' : t.last.author.name.split(' ')[0];
  const k = t.last.kind;
  if (k === 'boost') return `🚀 ${first} sent a boost: ${t.last.body}`;
  if (k === 'announcement') return `📣 ${t.last.body}`;
  if (k === 'checkin') return `${first} checked in`;
  if (k === 'system') return `${first} ${t.last.body.replace(/^Made it/, 'made it')}`;
  // your own last message shows its ticks instead of "You:", like WhatsApp
  const who = t.last.mine ? (t.last.ticks ? '' : 'You') : t.kind === 'dm' ? '' : first;
  const what = t.last.deleted ? 'Message deleted' : t.last.body || (t.last.file && /\.gif$/i.test(t.last.file) ? 'GIF' : t.last.file) || '';
  return `${who ? `${who}: ` : ''}${what}`;
}
function row(t, on) {
  const badge = (t.mentions ? `<span class="tch-at" aria-label="${t.mentions} mentions you">@</span>` : '') + (t.unread ? `<span class="tch-n${t.muted ? ' muted' : ''}" aria-label="${t.unread} unread">${t.unread > 99 ? '99+' : t.unread}</span>` : '');
  return html`<li data-k="t${t.id}"><a class="qr tch-r${on ? ' on' : ''}${t.unread && !t.muted ? ' unread' : ''}" href="#/chat?t=${t.id}" ${on ? raw('aria-current="true"') : ''}>
    ${glyph(t)}
    <span class="qr-m"><b>${t.kind === 'channel' && !t.special ? raw(`<span class="tch-hash">#</span>${esc(t.name)}`) : t.name}${t.muted ? raw(`<span class="tch-mu" aria-label="Muted">${ic('mute', 13)}</span>`) : ''}</b><span>${t.last && t.last.mine && t.last.ticks && !t.last.deleted ? raw(`<span class="tch-tk">${chatTicks(t.last.ticks)}</span>`) : ''}${preview(t)}</span></span>
    <span class="tch-meta"><span>${when(t.last && t.last.at)}</span><span class="tch-b">${raw(badge)}</span></span></a></li>`;
}

function listHtml(d, sel, f) {
  if (search.q.length >= 2 && search.hits) {
    const hits = search.hits;
    return html`<div class="tch-sec">Messages with “${search.q}”</div>${hits.length ? html`<ul class="wq-l tch-l">${hits.map((h) => html`<li data-k="h${h.id}"><a class="qr tch-hit" href="#/chat?t=${h.thread_id}${h.parent_id ? `&r=${h.parent_id}` : ''}&m=${h.id}">${raw(av(h.author, 30))}<span class="qr-m"><b>${h.author.name} <span class="muted">in ${h.kind === 'channel' ? '#' : ''}${h.thread}</span></b><span>${h.body || h.file || ''}</span></span><span class="tch-meta"><span>${when(h.at)}</span></span></a></li>`)}</ul>` : html`<p class="wq-empty">No messages with that.</p>`}`;
  }
  const qn = search.q.toLowerCase();
  const fit = (t) => (!qn || t.name.toLowerCase().includes(qn)) && (f !== 'unread' || t.unread) && (f !== 'mentions' || t.mentions) && (f !== 'groups' || t.kind === 'team_group' || t.kind === 'channel');
  const ts = d.threads.filter(fit);
  const sec = (label, list) => (list.length ? html`<div class="tch-sec">${label}</div><ul class="wq-l tch-l">${list.map((t) => row(t, t.id === sel))}</ul>` : '');
  const co = ts.filter((t) => t.special), chans = ts.filter((t) => !t.special && t.kind === 'channel'), dms = ts.filter((t) => t.kind === 'dm' || t.kind === 'team_group');
  const open = !f ? d.open.filter((c) => !qn || c.name.includes(qn)) : [];
  const people = qn ? d.people.filter((p) => p.name.toLowerCase().includes(qn) && !d.threads.some((t) => t.with && t.with.id === p.id)) : [];
  const empty = !co.length && !chans.length && !dms.length && !open.length && !people.length;
  return html`${sec('Company', co)}${sec('Channels', chans)}${sec('Direct and groups', dms)}
    ${people.length ? html`<div class="tch-sec">People</div><ul class="wq-l tch-l">${people.map((p) => html`<li data-k="p${p.id}"><button type="button" class="qr tch-r" data-act="tch-dm" data-id="${p.id}">${raw(`<span class="ch-avw">${av(p, 36)}${p.online ? '<i class="ch-on"></i>' : ''}</span>`)}<span class="qr-m"><b>${p.name}</b><span>${p.title || 'Start a chat'}</span></span></button></li>`)}</ul>` : ''}
    ${open.length ? html`<div class="tch-sec">Channels you can join</div><ul class="wq-l tch-l">${open.map((c) => html`<li data-k="o${c.id}"><a class="qr tch-r dim${c.id === sel ? ' on' : ''}" href="#/chat?t=${c.id}"><span class="tch-g ch light">${raw(ic('hash', 18))}</span><span class="qr-m"><b><span class="tch-hash">#</span>${c.name}</b><span>${c.topic || plural(c.count, 'person', 'people')}</span></span><span class="tch-meta"><span class="tch-join">View</span></span></a></li>`)}</ul>` : ''}
    ${empty ? html`<p class="wq-empty">${f === 'unread' ? 'You’ve read everything.' : f === 'mentions' ? 'Nobody has mentioned you lately.' : 'No chats match.'}</p>` : ''}`;
}
function drawList() {
  const box = document.querySelector('.tch-list');
  if (!box || !last) return;
  const q = hashQ();
  morph(box, listHtml(last, Number(q.get('t')) || defaultThread(last), q.get('f') || '').toString());
}
const defaultThread = (d) => (narrow() ? null : (d.threads.find((t) => t.special === 'company') || {}).id || null);

export const teamChatPage = {
  title: 'Chat',
  async load() {
    const d = await get('/api/team/threads');
    last = d;
    return d;
  },
  render(d, q) {
    const sel = Number(q.get('t')) || defaultThread(d);
    const rep = Number(q.get('r')) || null;
    const f = q.get('f') || '';
    const owner = S.me.role === 'owner', mgr = owner || S.me.role === 'manager';
    const chip = (label, v, n) => html`<button type="button" data-act="q" data-q="f" data-v="${v}" aria-pressed="${f === v ? 'true' : 'false'}">${label}${n ? html` <span>${n}</span>` : ''}</button>`;
    const unreadN = d.threads.filter((x) => x.unread && !x.muted).length;
    const list = html`<section class="tch-q" aria-label="Chats">
      <div class="tch-top"><label class="tch-find">${raw(ic('search', 16))}<input type="search" id="tch-find" placeholder="Search" aria-label="Search chats and messages" autocomplete="off" value="${search.q}"></label>
        <button type="button" class="tch-new" data-act="tch-new" aria-label="New chat" aria-haspopup="menu">${raw(ic('plus', 18))}</button></div>
      <div class="tch-chips" role="group" aria-label="Show">${chip('All', '')}${chip('Unread', 'unread', unreadN)}${chip('Mentions', 'mentions', d.mentions)}${chip('Groups', 'groups')}</div>
      <div class="tch-list">${listHtml(d, sel, f)}</div></section>`;
    const center = sel ? html`<div class="tch-c"><div class="chat-box" data-own="tc${sel}" data-thread="${sel}"></div></div>`
      : html`<div class="tch-c tch-none"><div><span class="tch-g co big">${raw(owl('watch'))}</span><b>Pick a chat</b><span>Everyone at ${String(S.settings.org_name || 'the company').split(' ')[0]}, your channels and direct messages.</span></div></div>`;
    const right = rep && sel ? html`<aside class="tch-rp" aria-label="Replies"><div class="chat-box" data-own="tr${rep}" data-thread="${sel}" data-parent="${rep}"></div></aside>` : '';
    const cls = `tch${rep && sel ? ' with-r' : ''}${sel && q.get('t') ? ' picked' : ''}${rep ? ' rep' : ''}`;
    return html`<div class="page-h tch-h"><div><h1>Chat</h1><p class="sub">Everyone at ${String(S.settings.org_name || 'the company').split(' ')[0]}, your channels and direct messages. Work talk lives here now, not on WhatsApp.</p></div>
      <div class="tools tch-tools">${mgr ? html`<button class="btn" data-act="ann-new">${raw(ic('mega', 17))} New announcement</button>` : ''}${owner ? html`<button class="btn primary" data-act="boost-open">${raw(ic('rocket', 17))} Boost the team</button>` : ''}</div></div>
      <div class="${cls}" data-sel="${sel || ''}">${list}${center}${right}</div>
`;
  },
  after(root, d) {
    fit();
    const q = hashQ();
    const sel = Number(q.get('t')) || defaultThread(d);
    const rep = Number(q.get('r')) || null;
    const presence = { staff: new Set(d.online || []), clients: new Map() };
    const main = root.querySelector('.tch-c .chat-box[data-thread]');
    if (main && !main.classList.contains('chat')) {
      const c = mountChat(main, { threadId: sel, orgShort: String(S.settings.org_name || '').split(' ')[0], onRead: () => { S.refresh(); bumpBadge(); },
        focusMsg: !rep ? Number(q.get('m')) || null : null, backHref: '#/chat', headExtra: headActions(),
        onThread: (m) => go('r', m.id), onChange: (left) => { if (left) go('t', ''); else S.refresh(); },
        onAddPeople: (tid, have) => pickPeople({ title: 'Add people', submit: 'Add', exclude: have, onPick: async (ids) => { await post(`/api/team/threads/${tid}/members`, { ids }); toast(`Added ${plural(ids.length, 'person', 'people')}`); S.refresh(); } }) });
      c.setPresence(presence);
    }
    const rbox = root.querySelector('.tch-rp .chat-box[data-parent]');
    if (rbox && !rbox.classList.contains('chat')) {
      const c = mountChat(rbox, { threadId: sel, parentId: rep, focus: true, focusMsg: Number(q.get('m')) || null, onClose: () => go('r', ''), orgShort: String(S.settings.org_name || '').split(' ')[0] });
      c.setPresence(presence);
    }
    const inp = root.querySelector('#tch-find');
    if (inp && !inp.dataset.wired) {
      inp.dataset.wired = '1';
      let tm = null;
      inp.addEventListener('input', () => {
        search.q = inp.value.trim(); search.hits = null; drawList();
        clearTimeout(tm);
        if (search.q.length >= 2) tm = setTimeout(async () => { const want = search.q; try { const hits = await get(`/api/team/search?q=${encodeURIComponent(want)}`); if (search.q === want) { search.hits = hits; drawList(); } } catch { /* the names still filter */ } }, 350);
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Escape' && inp.value) { inp.value = ''; search = { q: '', hits: null }; drawList(); } });
    }
  },
};
// the chat fills the window below the band, so the box to type in is always in sight
// New announcement and Boost the team sit in the chat's own bar, so the chat gets the whole window
function headActions() {
  const owner = S.me.role === 'owner', mgr = owner || S.me.role === 'manager';
  return (mgr ? `<button type="button" class="ch-hb" data-act="ann-new" title="New announcement" aria-label="New announcement">${ic('mega', 17)}<span>Announce</span></button>` : '')
    + (owner ? `<button type="button" class="ch-hb boost" data-act="boost-open" title="Boost the team" aria-label="Boost the team">${ic('rocket', 17)}<span>Boost</span></button>` : '');
}
function fit() {
  const tc = document.querySelector('#view .tch'); if (!tc) return;
  const top = tc.getBoundingClientRect().top + scrollY;
  // on a phone a chat is the whole screen, like a messenger; the list sits under the band
  // desktop: down to the bottom of the window, whatever its size; only a very short window scrolls
  const h = narrow() ? innerHeight - 16 : Math.max(380, innerHeight - top - 16);
  tc.style.setProperty('--tc-h', `${Math.round(h)}px`);
  if (narrow() && tc.classList.contains('picked') && Math.abs(scrollY - (top - 8)) > 4) window.scrollTo(0, top - 8);
}
addEventListener('resize', () => { if (/^#\/chat/.test(location.hash)) fit(); });
// names match first; message results show once typed for a moment. Matching names stay listed above them.
const bumpBadge = () => { if (S.chatBadge) S.chatBadge(); };

// ---------- starting chats ----------
actions['tch-dm'] = async (el) => { el.disabled = true; try { const r = await post('/api/team/dm', { user_id: Number(el.dataset.id) }); search = { q: '', hits: null }; go('t', r.id); } catch (e) { el.disabled = false; toast(errMsg(e), true); } };
actions['tch-new'] = () => {
  const md = openModal({ title: 'New chat', footer: false, body: { toString: () => `<div class="ms-list">
    <button type="button" data-nw="dm">${ic('user', 19)}<span>Message someone</span><small>Just the two of you</small></button>
    <button type="button" data-nw="group">${ic('users', 19)}<span>New group</span><small>A few people, invite only</small></button>
    <button type="button" data-nw="channel">${ic('hash', 19)}<span>New channel</span><small>For a team or a topic. Anyone can join unless it’s private.</small></button></div>` } });
  md.form.classList.add('ms-sheet');
  md.form.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-nw]'); if (!b) return;
    md.close();
    if (b.dataset.nw === 'dm') pickPeople({ title: 'Message someone', single: true, onPick: async ([id]) => { const r = await post('/api/team/dm', { user_id: id }); go('t', r.id); } });
    else newChannel(b.dataset.nw);
  });
};
function newChannel(kind) {
  const ch = kind === 'channel';
  const mgr = S.me.role === 'owner' || S.me.role === 'manager';
  const people = (last && last.people) || [];
  const md = openModal({ title: ch ? 'New channel' : 'New group', submit: ch ? 'Make the channel' : 'Make the group',
    body: { toString: () => `<div class="field"><label class="f" for="nc-n">${ch ? 'Channel name' : 'Group name'}</label>${ch ? '<div class="tch-hashin"><span>#</span>' : ''}<input id="nc-n" name="name" required maxlength="60" placeholder="${ch ? 'sales-floor' : 'Closers'}" autocomplete="off">${ch ? '</div>' : ''}</div>
      <div class="field"><label class="f" for="nc-t">What it’s for <span class="muted">(optional)</span></label><input id="nc-t" name="topic" maxlength="200" placeholder="${ch ? 'Bookings, follow-ups and wins' : ''}"></div>
      ${ch ? `<label class="check"><input type="checkbox" name="private" value="1"><span>Private: only people you add can see it</span></label>${mgr ? '<label class="check"><input type="checkbox" name="managers" value="1"><span>Only managers post; everyone else reads</span></label>' : ''}` : ''}
      <div class="field"><span class="f">Add people <span class="muted">(optional)</span></span><input type="search" class="pk-find" placeholder="Search people" aria-label="Search people"><ul class="pk-l">${people.map((p) => `<li><label><input type="checkbox" name="m" value="${p.id}">${pkRow(p)}</label></li>`).join('')}</ul></div>` },
    onSubmit: async (fd) => {
      const r = await post('/api/team/channels', { kind: ch ? 'channel' : 'group', name: fd.get('name'), topic: fd.get('topic') || null, private: fd.get('private') === '1', post_policy: fd.get('managers') === '1' ? 'managers' : 'all', members: fd.getAll('m').map(Number) });
      toast(ch ? 'Channel made' : 'Group made'); go('t', r.id);
    } });
  wireFind(md.form);
}
const pkRow = (p) => `${av(p, 34)}<span class="pk-t"><b>${esc(p.name)}</b><small>${esc(p.title || 'Team member')}</small></span>${p.online ? '<span class="pk-on">Online</span>' : ''}`;
function pickPeople({ title, submit = 'Start', single = false, exclude = [], onPick }) {
  const people = ((last && last.people) || []).filter((p) => !exclude.includes(p.id));
  const md = openModal({ title, submit, footer: !single, onSubmit: single ? null : async (fd) => { const ids = fd.getAll('m').map(Number); if (!ids.length) throw new Error('Pick at least one person'); await onPick(ids); },
    body: { toString: () => `<input type="search" class="pk-find" placeholder="Search people" aria-label="Search people" autofocus><ul class="pk-l">${people.map((p) => single ? `<li><button type="button" data-pk="${p.id}">${pkRow(p)}</button></li>` : `<li><label><input type="checkbox" name="m" value="${p.id}">${pkRow(p)}</label></li>`).join('') || '<li class="muted">Everyone is already here.</li>'}</ul>` } });
  wireFind(md.form);
  if (single) md.form.addEventListener('click', async (ev) => { const b = ev.target.closest('[data-pk]'); if (!b) return; b.disabled = true; try { await onPick([Number(b.dataset.pk)]); md.close(); } catch (e) { b.disabled = false; md.setError(errMsg(e)); } });
}
function wireFind(form) {
  const f = form.querySelector('.pk-find'); if (!f) return;
  f.addEventListener('input', () => { const v = f.value.trim().toLowerCase(); for (const li of form.querySelectorAll('.pk-l li')) li.hidden = !!v && !li.textContent.toLowerCase().includes(v); });
}
