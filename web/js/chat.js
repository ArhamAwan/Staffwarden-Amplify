// The live chat, shared by the client portal and the team's project page. It runs itself inside its
// box (marked data-own, so page refreshes leave it alone): messages arrive and update live, people
// see each other typing, and replies, reactions, emoji, files, voice messages, edits and reads all
// work like a phone messenger.
import { esc, initials, avColor, owl } from './util.js';
import { get, post, patch, put, del, fileUrl, fileBytes, fileBase64, liveFresh } from './api.js';
import { S, toast, errMsg, confirmBox, openModal } from './ui.js';
import { morph } from './morph.js';
// voice messages can be switched off (or tried with a few people first) from the developer tools
const voiceOn = () => !S.me || S.me.kind === 'client' || !Array.isArray(S.me.features) || S.me.features.includes('voice_notes');

// ---------- icons (stroke, 24px grid) ----------
const IC = {
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  clip: '<path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  send: '<path d="M4 12l16-8-6 16-3-7z"/><path d="M11 13l9-9"/>',
  reply: '<path d="M10 8L5 12.5 10 17"/><path d="M5 12.5h9a5 5 0 0 1 5 5V19"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  pin: '<path d="M9 4h6l-1 5 3 3H7l3-3z"/><path d="M12 12v8"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  trash: '<path d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  play: '<path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .7 3.5 2.7 3.5 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  wifi0: '<path d="M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0"/><path d="M12 19h.01M3 3l18 18"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  hash: '<path d="M9 4L7 20M17 4l-2 16M4.5 9h16M3.5 15h16"/>',
  helm: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M5.3 5.3l2.8 2.8M15.9 15.9l2.8 2.8M5.3 18.7l2.8-2.8M15.9 8.1l2.8-2.8"/>',
  thread: '<path d="M4.5 5.5h15v10h-9l-4.5 4v-4h-1.5z"/><path d="M8 9.5h8M8 12.5h5"/>',
  task: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12.5l2.5 2.5 4.5-5.5"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  mute: '<path d="M6 16.5V11a6 6 0 0 1 9.5-4.9M18 11v5.5l1.5 2h-12"/><path d="M4 4l16 16"/>',
  rocket: '<path d="M12 3c3.5 2 5 5.5 5 9l-2 3H9l-2-3c0-3.5 1.5-7 5-9z"/><circle cx="12" cy="10" r="1.8"/><path d="M9 15l-2.5 3.5L9 18M15 15l2.5 3.5L15 18"/>',
  mega: '<path d="M4 10v4h3l7 4V6L7 10z"/><path d="M17.5 9a4 4 0 0 1 0 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
};
const ic = (n, s = 18) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n]}</svg>`;
const ticks = (state) => {
  // one grey tick: sent. Two grey: it reached their device. Two blue: seen (everyone, in a group)
  const two = state === 'delivered' || state === 'read', col = state === 'read' ? 'var(--chat-read)' : 'currentColor';
  const lab = state === 'read' ? 'Seen' : state === 'delivered' ? 'Delivered' : 'Sent';
  return `<svg class="tk" width="${two ? 17 : 12}" height="11" viewBox="0 0 ${two ? 17 : 12} 11" role="img" aria-label="${lab}"><g fill="none" stroke="${col}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6l3 3 7-8"/>${two ? '<path d="M7.5 8.6L8 9l7-8"/>' : ''}</g></svg>`;
};

// ---------- emoji ----------
// name words make the search work ("fire", "thanks", "laugh")
const EMOJI = [
  ['Smileys', '😀 grin|😃 smile|😄 happy|😁 beam|😅 sweat relief|😂 laugh tears|🤣 rofl|🙂 slight smile|😉 wink|😊 blush|😇 angel|🥰 love|😍 heart eyes|🤩 star struck|😘 kiss|😋 yum|😎 cool|🤓 nerd|🧐 monocle|🤔 thinking|🤨 eyebrow|😐 neutral|😑 expressionless|😶 silent|🙄 eye roll|😏 smirk|😬 grimace|😮 wow surprised|😯 hushed|😲 astonished|😳 flushed|🥺 pleading|😢 cry|😭 sob|😤 huff|😠 angry|😡 rage|🤯 mind blown|😱 scream|🥳 party|😴 sleep|🤗 hug|🤫 shush|🤭 oops|😷 mask|🤒 sick|🤠 cowboy|🥲 smile tear|🫡 salute|🫠 melting'],
  ['People', '👍 thumbs up yes ok|👎 thumbs down no|👌 ok perfect|🙏 thanks please pray|👏 clap well done|🙌 raise hands celebrate|🤝 deal handshake|👋 wave hello bye|✌️ peace|🤞 fingers crossed|💪 strong|👀 eyes look|🫶 heart hands|✋ hand stop|👉 point right|👈 point left|☝️ point up|👇 point down|🤙 call me|🙋 raise hand|🤷 shrug|🙆 ok gesture|🙅 no gesture|💁 info|🧑‍💻 developer|📞 call phone'],
  ['Symbols', '❤️ heart love|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|💯 hundred|✅ done check|☑️ checkbox|✔️ tick|❌ cross no|⭕ circle|❗ exclamation important|❓ question|⚠️ warning|🔥 fire hot|✨ sparkles|⭐ star|🌟 glowing star|💥 boom|💡 idea|🎯 target goal|📌 pin|🔔 bell|🚀 rocket launch|⏰ alarm|⌛ hourglass|♻️ recycle|🆗 ok button|🆕 new'],
  ['Things', '🎉 party popper congrats|🎊 confetti|🏆 trophy win|🥇 gold medal|📈 chart up growth|📉 chart down|📊 bar chart|💰 money bag|💵 dollar|🏠 house home|🏡 house garden|🏢 office building|🔑 key|📅 calendar date|📝 memo note|📎 paperclip|📁 folder|📄 page document|💻 laptop|📱 phone mobile|✉️ envelope email|📧 email|🗓️ schedule|🧾 receipt|🛠️ tools|⚙️ settings gear|🔒 lock|☕ coffee|🍕 pizza|🍰 cake'],
  ['Nature', '☀️ sun|🌤️ sun cloud|🌧️ rain|⛈️ storm|🌈 rainbow|🌙 moon night|🌴 palm|🌸 blossom|🌻 sunflower|🍀 clover luck|🐶 dog|🐱 cat|🦁 lion|🐝 bee|🦋 butterfly|🌊 wave sea|🏖️ beach|🌍 earth world'],
];
const ALL_EMOJI = EMOJI.flatMap(([, list]) => list.split('|').map((x) => { const i = x.indexOf(' '); return [x.slice(0, i), x.slice(i + 1)]; }));
const QUICK = ['👍', '❤️', '😂', '😮', '🙏', '🔥'];
const recent = () => { try { const r = JSON.parse(localStorage.getItem('wh-emoji') || '[]'); return Array.isArray(r) ? r.slice(0, 16) : []; } catch { return []; } };
const remember = (e) => { try { localStorage.setItem('wh-emoji', JSON.stringify([e, ...recent().filter((x) => x !== e)].slice(0, 16))); } catch { /* fine */ } };

// ---------- text ----------
const AV = (p) => avColor(p.kind === 'client' ? 1000 + p.id : p.id);
const avatarHtml = (p, size = 30) => `<span class="cav" style="width:${size}px;height:${size}px;background:${AV(p)};font-size:${Math.round(size * 0.38)}px" aria-hidden="true">${esc(initials(p.name))}</span>`;
const NAMECOL = ['#127A57', '#B45309', '#6D4AE8', '#0F766E', '#BE185D', '#4F46E5', '#C2410C', '#6B55D6'];
const nameCol = (p) => NAMECOL[(p.kind === 'client' ? 1000 + p.id : p.id) % NAMECOL.length];
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '\u00a0');
function dayLabel(iso) {
  const d = new Date(iso), t = new Date();
  const k = (x) => x.toDateString();
  if (k(d) === k(t)) return 'Today';
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (k(d) === k(y)) return 'Yesterday';
  if (t - d < 6 * 86400000) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
}
function richText(s, members, hit) {
  let h = esc(s);
  // mentions first, so a link is never cut open by one
  for (const m of members || []) { const n = esc(m.name); h = h.split(`@${n}`).join(`<span class="mention">@${n}</span>`); }
  h = h.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"']/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  if (hit) { const q = esc(hit).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); h = h.replace(new RegExp(`(${q})(?![^<]*>)`, 'gi'), '<mark>$1</mark>'); }
  return h.replace(/\n/g, '<br>');
}
const kb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
const secs = (n) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
const bars = (id, n = 32) => { let x = (id * 9301 + 49297) % 233280; return Array.from({ length: n }, () => { x = (x * 9301 + 49297) % 233280; return 4 + Math.round((x / 233280) * 16); }); };

// ---------- link previews and PDF first pages, kept for the session ----------
const previews = new Map();   // url -> { ok, title, description, site } | 'wait'
const firstUrl = (s) => { const m = /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"']/.exec(s || ''); return m ? m[0] : null; };
function preview(url, done) {
  if (previews.has(url)) return previews.get(url);
  previews.set(url, 'wait');
  get(`/api/chat/preview?url=${encodeURIComponent(url)}`).then((p) => { previews.set(url, p); done(); }).catch(() => previews.set(url, { ok: false }));
  return 'wait';
}
const pdfPics = new Map();    // message id -> data URL of page 1
let pdfLibP = null;
function pdfLib() {
  if (!pdfLibP) pdfLibP = new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = '/vendor/pdf/pdf.min.js'; sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf/pdf.worker.min.js'; res(window.pdfjsLib); }; sc.onerror = rej; document.head.appendChild(sc); });
  return pdfLibP;
}
async function pdfFirstPage(m) {
  if (pdfPics.has(m.id)) return pdfPics.get(m.id);
  pdfPics.set(m.id, null);
  try {
    const L = await pdfLib();
    const doc = await L.getDocument({ data: new Uint8Array(await fileBytes(m.file.url)) }).promise;
    const pg = await doc.getPage(1);
    const v0 = pg.getViewport({ scale: 1 }), scale = 120 / v0.width, v = pg.getViewport({ scale });
    const c = document.createElement('canvas'); c.width = Math.ceil(v.width); c.height = Math.ceil(v.height);
    await pg.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
    const d = c.toDataURL('image/png');
    pdfPics.set(m.id, d);
    return d;
  } catch { return null; }
}

// ---------- messages waiting to send (the phone was offline) ----------
const outKey = (tid) => `wh-outbox-${tid}`;
const readOut = (tid) => { try { const v = JSON.parse(localStorage.getItem(outKey(tid)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const saveOut = (tid, list) => { try { if (list.length) localStorage.setItem(outKey(tid), JSON.stringify(list)); else localStorage.removeItem(outKey(tid)); } catch { /* fine */ } };
const newKey = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

// ---------- the chats on the page ----------
const live = new Set();
// every chat on the page reloads (after the live connection comes back)
export function chatReloadAll() { for (const c of [...live]) { if (!document.contains(c.el)) c.stop(); else c.reload(); } }
export function chatEvent(ev) {
  for (const c of [...live]) {
    if (!document.contains(c.el)) { c.stop(); continue; }
    if (ev.thread_id !== c.tid) continue;
    if (ev.type === 'typing') c.typing(ev.who);
    else if (ev.type === 'chat' || ev.type === 'chat_read') c.reload();
  }
}

// opts: { threadId, onRead(), header: true }
export function mountChat(el, opts) {
  for (const c of [...live]) if (c.el === el) c.stop();
  // every listener on the box goes away with this chat, so mounting again never doubles a send
  const ac = new AbortController(), sig = { signal: ac.signal };
  const st = { data: null, reply: null, teamOnly: false, typing: new Map(), search: '', editing: null, rec: null, lastTyping: 0, readSent: 0, loadingOlder: false, older: [], audio: null, urls: new Map(), firstUnread: null, outbox: readOut(opts.threadId), presence: null, focus: opts.focusMsg || null };
  const tid = opts.threadId;
  el.classList.add('chat');
  el.innerHTML = `<div class="ch-head" data-r="head"></div><div class="ch-pin" data-r="pin" hidden></div>
    <div class="ch-search" data-r="searchbar" hidden><span>${ic('search', 16)}</span><input type="search" placeholder="Search this chat" aria-label="Search this chat" data-r="searchin"><button type="button" class="ch-ib" data-c="search-close" aria-label="Close search">${ic('x', 16)}</button></div>
    <div class="ch-list" data-r="list" role="log" aria-live="polite" aria-label="Messages"><div class="ch-loading">Loading messages…</div></div>
    <button type="button" class="ch-jump" data-r="jump" data-c="jump" hidden aria-label="Go to the newest messages">${ic('down', 18)}<span data-r="jumpn"></span></button>
    <div class="ch-offline" data-r="offline" hidden role="status"></div>
    <div class="ch-comp" data-r="comp">
      <div class="ch-replybar" data-r="replybar" hidden></div>
      <div class="ch-mention" data-r="mention" hidden role="listbox" aria-label="People"></div>
      <div class="ch-row" data-r="row">
        <div class="ch-field">
          <button type="button" class="ch-ib" data-c="emoji" aria-label="Emoji" aria-expanded="false">${ic('smile', 21)}</button>
          <button type="button" class="ch-ib ch-gifb" data-c="gif" aria-label="GIFs" aria-expanded="false">GIF</button>
          <textarea rows="1" data-r="input" placeholder="Message" aria-label="Message" maxlength="4000"></textarea>
          <label class="ch-ib" aria-label="Attach a file or photo" title="Attach a file or photo">${ic('clip', 20)}<input type="file" data-r="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/csv,text/plain,.docx,.xlsx,.zip"></label>
        </div>
        <button type="button" class="ch-send" data-r="send" data-c="send" aria-label="${voiceOn() ? 'Record a voice message' : 'Send'}">${ic(voiceOn() ? 'mic' : 'send', 20)}</button>
      </div>
      <div class="ch-rec" data-r="rec" hidden><span class="ch-recdot"></span><b data-r="rectime">0:00</b><span class="ch-rechint">Recording. Send it, or bin it.</span><button type="button" class="ch-ib" data-c="rec-cancel" aria-label="Discard the recording">${ic('trash', 19)}</button><button type="button" class="ch-send" data-c="rec-send" aria-label="Send the voice message">${ic('send', 19)}</button></div>
      <div class="ch-team" data-r="teambar" hidden></div>
      <div class="ch-join" data-r="joinbar" hidden></div>
    </div>
    <div class="ch-pop" data-r="picker" hidden role="dialog" aria-label="Emoji and GIFs"></div>`;
  const $ = (r) => el.querySelector(`[data-r="${r}"]`);
  const input = $('input'), list = $('list');

  // ---------- loading ----------
  async function load({ keepScroll = false } = {}) {
    let d;
    try { d = await get(`/api/chat/threads/${tid}/messages${opts.parentId ? `?parent=${opts.parentId}` : ''}`); } catch (e) { list.innerHTML = `<div class="ch-loading">${esc(errMsg(e))}</div>`; return; }
    const first = !st.data;
    if (first && d.last_read) { const f = d.messages.find((m) => m.id > d.last_read && !m.mine); st.firstUnread = f ? f.id : null; }
    st.data = d;
    // someone who just sent a message has stopped typing
    for (const [k, t] of st.typing) if (d.messages.some((m) => `${m.author.kind}:${m.author.id}` === k && Date.parse(m.created_at) >= t.at - 1500)) st.typing.delete(k);
    renderHead(); renderPin(); renderTeam(); renderPostable();
    const near = list.scrollHeight - list.scrollTop - list.clientHeight < 140;
    renderList();
    if (first && st.focus) { goTo(st.focus); st.focus = null; }
    else if (first) { const u = st.firstUnread && list.querySelector('.ch-unread'); if (u) centerIn(u); else list.scrollTop = list.scrollHeight; }
    else if (near && !keepScroll) list.scrollTop = list.scrollHeight;
    else { const n = d.messages.filter((m) => !m.mine && m.id > st.readSent).length; showJump(n); }
    markRead();
  }
  let reloadT = null;
  const reload = () => { clearTimeout(reloadT); reloadT = setTimeout(() => load(), 120); };
  function markRead() {
    const d = st.data; if (!d || !d.messages.length || document.hidden) return;
    const last = d.messages[d.messages.length - 1].id;
    if (last <= st.readSent) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight > 200) return;   // not looking at the bottom yet
    st.readSent = last;
    post(`/api/chat/threads/${tid}/read`, { last_id: last }).then(() => opts.onRead && opts.onRead()).catch(() => {});
  }
  function showJump(n) { const j = $('jump'); j.hidden = !n; $('jumpn').textContent = n ? String(n) : ''; }

  // ---------- head, pinned, team-only switch ----------
  function renderHead() {
    if (opts.header === false) { $('head').hidden = true; return; }
    const t = st.data.thread;
    if (opts.parentId) {
      $('head').innerHTML = `<span class="ch-gav light">${ic('thread', 19)}</span><div class="ch-ht"><b>Replies</b><span>in ${esc(t.kind === 'channel' ? `#${t.name}` : t.name)}</span></div>${opts.onClose ? `<button type="button" class="ch-ib" data-c="close-replies" aria-label="Close the replies">${ic('x', 18)}</button>` : ''}`;
      return;
    }
    const groupish = t.kind === 'group' || t.kind === 'company' || t.kind === 'channel' || t.kind === 'team_group';
    const who = t.kind === 'company' ? `<span class="ch-gav">${owl('still')}</span>` : t.kind === 'channel' ? `<span class="ch-gav light">${ic('hash', 19)}</span>` : groupish ? `<span class="ch-gav">${ic('users', 19)}</span>` : `<span class="ch-avw">${avatarHtml(t.with, 40)}${isOnline(t.with) ? '<i class="ch-on" aria-label="Online"></i>' : ''}</span>`;
    const teamBtns = t.team ? `<button type="button" class="ch-ib" data-c="tpeople" aria-label="People in this chat">${ic('users', 18)}</button><button type="button" class="ch-ib${t.mute && t.mute !== 'none' ? ' on' : ''}" data-c="tmute" aria-label="Notifications for this chat">${ic(t.mute && t.mute !== 'none' ? 'mute' : 'bell', 18)}</button>` : '';
    const faces = groupish && t.kind !== 'company' ? `<span class="ch-faces">${(t.members || []).slice(0, 6).map((m) => `<span class="ch-avw">${avatarHtml(m, 26)}${isOnline(m) ? '<i class="ch-on sm"></i>' : ''}</span>`).join('')}${t.members && t.members.length > 6 ? `<span class="cav more">+${t.members.length - 6}</span>` : ''}</span>` : '';
    const back = opts.backHref ? `<a class="ch-ib ch-back" href="${opts.backHref}" aria-label="All chats">${ic('left', 18)}</a>` : '';
    $('head').innerHTML = `${back}${who}<div class="ch-ht"><b>${esc(t.kind === 'channel' ? `#${t.name}` : t.name)}</b><span data-r="sub">${subText()}</span></div>${faces}${teamBtns}<button type="button" class="ch-ib" data-c="search" aria-label="Search this chat">${ic('search', 18)}</button>${opts.headExtra ? `<span class="ch-hx">${opts.headExtra}</span>` : ''}${opts.onGallery ? `<button type="button" class="ch-ib" data-c="gallery" aria-label="Photos and files" aria-pressed="${String(opts.galleryOpen ? 'true' : 'false')}">${ic('grid', 18)}</button>` : ''}`;
  }
  function subText() {
    const names = [...st.typing.values()].filter((x) => x.until > Date.now()).map((x) => x.name.split(' ')[0]);
    if (names.length) return `<i class="ch-typingtxt">${esc(names.join(' and '))} ${names.length > 1 ? 'are' : 'is'} typing…</i>`;
    const t = st.data.thread;
    if (t.kind !== 'direct' && t.kind !== 'dm') {
      const on = (t.members || []).filter((m) => isOnline(m) && !(m.kind === st.data.me.kind && m.id === st.data.me.id)).map((m) => m.name.split(' ')[0]);
      const onTxt = t.kind === 'company' && on.length > 2 ? `<b class="ch-ontxt">${on.length} online</b> · ` : on.length ? `<b class="ch-ontxt">${esc(on.length > 2 ? `${on.slice(0, 2).join(', ')} and ${on.length - 2} more online` : `${on.join(' and ')} online`)}</b> · ` : '';
      const nn = t.member_count || (t.members || []).length;
      return `${onTxt}${esc(`${nn} ${nn === 1 ? 'person' : 'people'}`)}${t.topic ? ` · ${esc(t.topic)}` : ''}`;
    }
    if (t.with && isOnline(t.with)) return '<b class="ch-ontxt">Online now</b>';
    const ls = t.with && lastSeen(t.with);
    return esc(ls ? `Last here ${ls}` : t.with && t.with.title ? t.with.title : t.with && t.with.kind === 'client' ? 'Client' : 'On the team');
  }
  // the page passes who is online (only when the client's settings allow it)
  function isOnline(p) { const pr = st.presence; if (!pr || !p) return false; return p.kind === 'client' ? !!(pr.clients.get(p.id) || {}).online : pr.staff.has(p.id); }
  function lastSeen(p) { const pr = st.presence; if (!pr || !p || p.kind !== 'client') return null; const x = pr.clients.get(p.id); if (!x || !x.last_seen_at) return null; const m = Math.round((Date.now() - Date.parse(x.last_seen_at)) / 60000); return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; }
  function renderPin() {
    const p = opts.parentId ? null : st.data.pinned, box = $('pin');
    box.hidden = !p;
    if (p) box.innerHTML = `<span class="ch-pinic">${ic('pin', 15)}</span><span class="ch-pintx"><b>Pinned</b> · ${esc(p.body.replace(/\n+/g, ' · '))}</span><button type="button" class="ch-link" data-c="goto" data-id="${p.id}">Show</button>`;
  }
  function renderPostable() {
    const t = st.data.thread, row = $('row'), bar = $('joinbar');
    if (!t.team || t.can_post !== false) { bar.hidden = true; if (!st.rec) row.hidden = false; return; }
    row.hidden = true; bar.hidden = false;
    bar.innerHTML = t.member === false ? `<span>You can read #${esc(t.name)}. Join to post and hear about it.</span><button type="button" class="btn sm primary" data-c="tjoin">Join #${esc(t.name)}</button>` : `<span>${ic('lock', 15)} Only the owner and managers post here.</span>`;
  }
  function renderTeam() {
    const box = $('teambar');
    if (opts.parentId) {
      box.hidden = false;
      box.innerHTML = `<label class="ch-also"><input type="checkbox" data-r="also"${st.also ? ' checked' : ''}> Also send to ${esc(st.data.thread.kind === 'channel' ? `#${st.data.thread.name}` : st.data.thread.name)}</label>`;
      return;
    }
    if (!st.data.can_team_only) { box.hidden = true; return; }
    box.hidden = false;
    const cn = st.data.thread.kind === 'direct' && st.data.thread.with && st.data.thread.with.kind === 'client' ? st.data.thread.with.name.split(' ')[0] : (st.clientName || 'The client');
    box.innerHTML = `<div role="radiogroup" aria-label="Who sees this" class="ch-aud"><button type="button" role="radio" aria-checked="${String(!st.teamOnly)}" data-c="aud" data-v="all">${ic('eye', 14)}${esc(cn)} sees it</button><button type="button" role="radio" aria-checked="${String(st.teamOnly)}" data-c="aud" data-v="team">${ic('lock', 14)}Team only</button></div>${st.teamOnly ? `<span class="ch-audnote">${ic('lock', 13)}${esc(cn)} never sees this. It stays with your team.</span>` : ''}`;
    el.classList.toggle('team-only', st.teamOnly);
    const inp = $('input'); if (inp) inp.placeholder = st.teamOnly ? 'Only your team sees this' : `Message ${cn}${st.data.thread.kind === 'group' ? ' and the team' : ''}`;
  }

  // ---------- the messages ----------
  function specialHtml(m) {
    const meta = m.meta || {};
    if (m.kind === 'system') return `<div class="ch-sys" data-k="m${m.id}" id="msg-${tid}-${m.id}"><span>${m.task ? ic('task', 14) : ''}<b>${esc(m.author.name.split(' ')[0])}</b> ${esc(m.body.replace(/^Made it a task/, 'made it a task'))}${m.task ? ` <a href="#/tasks?task=${m.task.id}">Open</a>` : ''}</span></div>`;
    if (m.kind === 'boost') {
      const mine = meta.my_answer;
      return `<div class="msg them first boostm" data-k="m${m.id}" data-mid="${m.id}" id="msg-${tid}-${m.id}">${avatarHtml(m.author)}<div class="boost-card"><div class="bc-top"><span class="bc-k">${ic('rocket', 15)}Boost from ${esc(m.author.name.split(' ')[0])}</span><b>${esc(m.body)}</b><span class="bc-t">${timeOf(m.created_at)} · sent to ${meta.sent_to || 0} working</span></div>
        <div class="bc-foot"><span>${meta.boosted || 0} boosted back${meta.chai ? ` · ${meta.chai} asked for more chai` : ''}</span>${m.author.id === d0().me.id && d0().me.kind === 'staff' ? '' : mine ? `<span class="bc-done">${mine === 'chai' ? 'More chai, noted' : 'Boosted'}</span>` : `<button type="button" class="bc-go" data-c="boost" data-id="${m.id}" data-b="${meta.boost_id}" data-a="boosted">Boosted</button><button type="button" class="bc-alt" data-c="boost" data-id="${m.id}" data-b="${meta.boost_id}" data-a="chai">More chai</button>`}</div></div></div>`;
    }
    if (m.kind === 'announcement') {
      const [title, ...rest] = m.body.split('\n\n');
      return `<div class="msg them first annm" data-k="m${m.id}" data-mid="${m.id}" id="msg-${tid}-${m.id}">${avatarHtml(m.author)}<div class="ann-card"><span class="ac-k">${ic('mega', 15)}Announcement · ${esc(m.author.name)}</span><b>${esc(title)}</b><p>${richText(rest.join('\n\n'), [])}</p><div class="ac-foot"><span>${timeOf(m.created_at)}</span>${m.mine ? `<a href="#/announcements?id=${meta.announcement_id}">Who has read it</a>` : meta.confirmed ? `<span class="ac-ok">${ic('check', 14)}You’ve read it</span>` : `<button type="button" class="btn sm primary" data-c="annok" data-id="${m.id}" data-a="${meta.announcement_id}">I’ve read it</button>`}</div></div></div>`;
    }
    if (m.kind === 'checkin') {
      const [did, ...more] = m.body.split('\n');
      const blk = more.find((x) => /^Blocked:/.test(x)), nxt = more.find((x) => /^Next:/.test(x));
      return `<div class="msg them first cim" data-k="m${m.id}" data-mid="${m.id}" id="msg-${tid}-${m.id}">${avatarHtml(m.author)}<div class="ci-card"><div class="cc-h"><b>${esc(m.author.name)}</b><span>${esc(meta.hours || '')} tracked${meta.mood ? ` · ${esc(meta.mood)}` : ''}</span></div><p><b>Did</b> · ${esc(did.replace(/^Did:\s*/, ''))}</p>${nxt ? `<p><b>Next</b> · ${esc(nxt.replace(/^Next:\s*/, ''))}</p>` : ''}${blk ? `<p class="cc-blk"><b>Blocked</b> · ${esc(blk.replace(/^Blocked:\s*/, ''))}</p>` : ''}<span class="cc-t">${timeOf(m.created_at)}</span></div></div>`;
    }
    return null;
  }
  const d0 = () => st.data;
  function msgHtml(m, prev) {
    const d = st.data;
    if (m.kind && !m.deleted) { const sp = specialHtml(m); if (sp) return sp; }
    const first = !prev || prev.author.kind !== m.author.kind || prev.author.id !== m.author.id || dayLabel(prev.created_at) !== dayLabel(m.created_at) || Date.parse(m.created_at) - Date.parse(prev.created_at) > 6 * 60000 || prev.team_only !== m.team_only;
    const cls = ['msg', m.mine ? 'me' : 'them', first ? 'first' : '', m.team_only ? 'note' : '', !m.mine && m.author.kind === 'client' && d.me.kind !== 'client' ? 'fromclient' : '', m.deleted ? 'gone' : '', st.search && !(`${m.body} ${m.file ? m.file.name : ''}`.toLowerCase().includes(st.search.toLowerCase())) ? 'dim' : ''].filter(Boolean).join(' ');
    const tag = m.author.kind === 'client' ? `<span class="ch-tag client">${esc(st.clientName || 'Client')}</span>` : m.author.kind === 'staff' && d.me.kind === 'client' ? `<span class="ch-tag team">${esc(st.orgShort || 'Team')}</span>` : '';
    const name = !m.mine && first ? `<div class="bub-name"><b style="color:${nameCol(m.author)}">${esc(m.author.name)}</b>${tag}${m.team_only ? `<span class="ch-tag note">${ic('lock', 11)}Team only</span>` : ''}</div>` : (m.mine && m.team_only && first ? `<div class="bub-name"><span class="ch-tag note">${ic('lock', 11)}Team only</span></div>` : '');
    const quote = m.reply ? `<button type="button" class="bub-quote" data-c="goto" data-id="${m.reply.id}" style="--qc:${nameCol(m.reply.author)}"><b>${esc(m.reply.author.name)}</b><span>${m.reply.deleted ? 'This message was deleted' : esc(m.reply.body || m.reply.file || '')}</span></button>` : '';
    let file = '';
    if (m.file && m.file.voice_secs != null) file = voiceHtml(m);
    else if (m.file && /^image\//.test(m.file.type)) file = `<button type="button" class="bub-img" data-c="open" data-id="${m.id}"><img alt="${esc(m.file.name)}" data-img="${m.id}" ${st.urls.has(m.id) ? `src="${st.urls.get(m.id)}"` : ''}></button>`;
    else if (m.file && m.file.type === 'application/pdf') {
      const pic = pdfPics.get(m.id);
      if (!pdfPics.has(m.id)) pdfFirstPage(m).then((d) => { if (d) { const el2 = list.querySelector(`[data-pdf="${m.id}"]`); if (el2) el2.innerHTML = `<img alt="" src="${d}">`; } });
      file = `<div class="bub-pdf"><button type="button" class="bp-pic" data-c="open" data-id="${m.id}" data-pdf="${m.id}" aria-label="Open ${esc(m.file.name)}">${pic ? `<img alt="" src="${pic}">` : '<span class="bp-lines"><i></i><i></i><i></i><i></i><i></i></span>'}</button>
        <span class="bp-t"><b>${esc(m.file.name)}</b><span>PDF${m.file.pages ? ` · ${m.file.pages} ${m.file.pages === 1 ? 'page' : 'pages'}` : ''} · ${esc(kb(m.file.size))}</span><span class="bp-a"><button type="button" class="ch-link" data-c="open" data-id="${m.id}">Open</button><button type="button" class="ch-link" data-c="save" data-id="${m.id}">Download</button></span></span></div>`;
    }
    else if (m.file) file = `<button type="button" class="bub-file" data-c="open" data-id="${m.id}"><span class="bf-ic">${ic('file', 18)}</span><span class="bf-t"><b>${esc(m.file.name)}</b><span>${esc(kb(m.file.size))}</span></span></button>`;
    // the first link in a message gets a card with the page's title
    const url = !m.deleted && !m.file && firstUrl(m.body);
    if (url) {
      const pv = preview(url, () => renderList());
      if (pv && pv !== 'wait' && pv.ok) { let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = ''; } file = `<a class="bub-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><span class="bl-band" aria-hidden="true">${ic('link', 16)}</span><span class="bl-t"><b>${esc(pv.title)}</b>${pv.description ? `<span>${esc(pv.description)}</span>` : ''}<i>${esc(pv.site || host)}</i></span></a>`; }
    }
    const body = m.deleted ? `<span class="bub-del">${m.mine ? 'You deleted this message' : 'This message was deleted'}</span>` : m.body ? `<span class="bub-txt">${richText(m.body, d.thread.members, st.search)}</span>` : '';
    const meta = `<span class="bub-meta">${m.edited_at && !m.deleted ? '<span>Edited</span>' : ''}${timeOf(m.created_at)}${m.mine && !m.deleted ? ticks(m.ticks) : ''}</span>`;
    const rx = m.reactions.length ? `<span class="bub-rx">${m.reactions.map((r) => `<button type="button" class="rx${r.mine ? ' mine' : ''}" data-c="react" data-id="${m.id}" data-e="${esc(r.emoji)}" title="${esc(r.who.join(', '))}" aria-label="${esc(r.emoji)} ${r.count}: ${esc(r.who.join(', '))}">${r.emoji}${r.count > 1 ? `<span>${r.count}</span>` : ''}</button>`).join('')}</span>` : '';
    const acts = m.deleted ? '' : `<span class="msg-acts" role="toolbar" aria-label="Message actions">${QUICK.map((e) => `<button type="button" data-c="react" data-id="${m.id}" data-e="${e}" aria-label="React ${e}">${e}</button>`).join('')}<i></i><button type="button" data-c="react-more" data-id="${m.id}" aria-label="More reactions">${ic('smile', 17)}</button><button type="button" data-c="reply" data-id="${m.id}" aria-label="Reply">${ic('reply', 17)}</button>${opts.onThread && !opts.parentId ? `<button type="button" data-c="thread" data-id="${m.id}" aria-label="Reply in thread">${ic('thread', 17)}</button>` : ''}${d.me.kind === 'staff' && !m.task ? `<button type="button" data-c="mktask" data-id="${m.id}" aria-label="Make it a task">${ic('task', 17)}</button>` : ''}<button type="button" data-c="menu" data-id="${m.id}" aria-label="More">${ic('more', 17)}</button></span>`;
    const taskChip = m.task ? `<a class="bub-task" href="#/tasks?task=${m.task.id}">${ic('task', 14)}<span>${esc(m.task.ref ? `${m.task.ref} ` : '')}${esc(m.task.title)}</span></a>` : '';
    const reps = m.replies && !opts.parentId ? `<button type="button" class="bub-reps" data-c="thread" data-id="${m.id}">${m.replies.people.map((p) => avatarHtml(p, 18)).join('')}<b>${m.replies.count} ${m.replies.count === 1 ? 'reply' : 'replies'}</b><span>last ${esc(timeOf(m.replies.last_at))}</span></button>` : '';
    const av = !m.mine ? (first ? avatarHtml(m.author) : '<span class="cav-sp"></span>') : '';
    const unread = st.firstUnread === m.id ? '<div class="ch-unread" data-k="unread"><span>New messages</span></div>' : '';
    return `${unread}<div class="${cls}" data-k="m${m.id}" data-mid="${m.id}" id="msg-${tid}-${m.id}">${av}<div class="bubw"><div class="bub" data-c="bubble" data-id="${m.id}">${name}${quote}${file}${body}${taskChip}${meta}${rx}${acts}</div>${reps}</div></div>`;
  }
  function voiceHtml(m) {
    const b = bars(m.id);
    const playing = st.audio && st.audio.mid === m.id;
    const pct = playing ? st.audio.pct : 0;
    return `<div class="bub-voice"><button type="button" class="bv-play" data-c="play" data-id="${m.id}" aria-label="${playing && !st.audio.el.paused ? 'Pause' : 'Play'} the voice message, ${secs(m.file.voice_secs)}">${ic(playing && !st.audio.el.paused ? 'pause' : 'play', 16)}</button>
      <span class="bv-wave" aria-hidden="true">${b.map((h, i) => `<i style="height:${h}px" class="${i / b.length < pct ? 'on' : ''}"></i>`).join('')}</span>
      <span class="bv-t">${playing ? secs(st.audio.el.currentTime || 0) : secs(m.file.voice_secs)}</span>
      <button type="button" class="bv-rate" data-c="rate" data-id="${m.id}" aria-label="Playback speed">${playing ? st.audio.rate : 1}×</button></div>`;
  }
  function renderList() {
    const d = st.data;
    if (!d.messages.length && !st.outbox.length) { list.innerHTML = `<div class="ch-empty" data-k="empty"><span class="ch-owl">${owl('watch')}</span><b>Say hello</b><span>${opts.parentId ? 'Replies to this message show here.' : d.thread.kind === 'channel' ? `${d.thread.private ? 'Only people added to' : 'Everyone in'} #${esc(d.thread.name)} sees messages here.` : d.thread.kind === 'team_group' ? 'Everyone in this group sees messages here.' : d.thread.kind === 'company' ? 'Everyone at the company sees messages here.' : d.thread.kind === 'group' ? 'Everyone on the project sees messages here.' : `Only you and ${esc(d.thread.name.split(' ')[0])} see this chat.`}</span></div>`; return; }
    let h = d.more ? '<div class="ch-older" data-k="older"><button type="button" class="ch-link" data-c="older">Show earlier messages</button></div>' : '', prev = null, day = null;
    for (const m of d.messages) {
      const dl = dayLabel(m.created_at);
      if (dl !== day) { h += `<div class="ch-day" data-k="d${esc(dl)}"><span>${dl}</span></div>`; day = dl; prev = null; }
      h += msgHtml(m, prev); prev = m;
    }
    for (const o of st.outbox) h += `<div class="msg me first pending" data-k="o${esc(o.key)}"><div class="bub"><span class="bub-txt">${richText(o.body, d.thread.members)}</span><span class="bub-meta">${ic('clock', 12)}Waiting to send</span></div></div>`;
    h += `<div class="ch-typing" data-k="typing">${typingRow()}</div>`;
    // patched in place, so a message under the pointer (its reaction bar, a playing voice note) stays put
    // new messages slide in; the ones already there stay put
    const had = new Set([...list.querySelectorAll('.msg[data-k]')].map((x) => x.dataset.k));
    morph(list, h);
    if (st.drawn) for (const m of list.querySelectorAll('.msg[data-k]')) if (!had.has(m.dataset.k)) { m.classList.add('arrive'); setTimeout(() => m.classList.remove('arrive'), 600); }
    st.drawn = true;
    for (const m of d.messages) if (m.file && /^image\//.test(m.file.type) && !st.urls.has(m.id)) loadImg(m);
  }
  async function loadImg(m) {
    try { const u = await fileUrl(m.file.url); st.urls.set(m.id, u); const img = list.querySelector(`[data-img="${m.id}"]`); if (img) { const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 160; img.onload = () => { if (atEnd) list.scrollTop = list.scrollHeight; }; img.src = u; } } catch { /* shows the name */ }   // a photo that loads in late doesn't push the newest messages out of view
  }

  // ---------- typing ----------
  let typingT = null;
  function typing(who) {
    const d = st.data; if (!d || (who.kind === d.me.kind && who.id === d.me.id)) return;
    st.typing.set(`${who.kind}:${who.id}`, { ...who, at: Date.now(), until: Date.now() + 6000 });
    refreshTyping();
    clearTimeout(typingT); typingT = setTimeout(refreshTyping, 6200);
  }
  function typingRow() {
    const typers = [...st.typing.values()].filter((x) => x.until > Date.now());
    return typers.length ? `<div class="msg them first"><span class="cav" style="background:${AV(typers[0])};width:30px;height:30px;font-size:11px">${esc(initials(typers[0].name))}</span><div class="bub ch-dots" role="status" aria-label="${esc(typers[0].name)} is typing"><i></i><i></i><i></i></div></div>` : '';
  }
  function refreshTyping() {
    const sub = el.querySelector('[data-r="sub"]'); if (sub) sub.innerHTML = subText();
    const near = list.scrollHeight - list.scrollTop - list.clientHeight < 140;
    const row = list.querySelector('.ch-typing'); if (row) row.innerHTML = typingRow();
    if (near) list.scrollTop = list.scrollHeight;
  }
  input.addEventListener('input', () => {
    input.style.height = 'auto'; input.style.height = `${Math.min(140, input.scrollHeight)}px`;
    setSendIcon();
    mentionCheck();
    if (Date.now() - st.lastTyping > 3000 && input.value.trim()) { st.lastTyping = Date.now(); post(`/api/chat/threads/${tid}/typing`, { team_only: st.teamOnly }).catch(() => {}); }
  });
  input.addEventListener('keydown', (e) => {
    const men = $('mention');
    if (!men.hidden && (e.key === 'Enter' || e.key === 'Tab')) { const f = men.querySelector('button'); if (f) { e.preventDefault(); f.click(); return; } }
    if (e.key === 'Escape') { if (st.reply || st.editing) { e.preventDefault(); cancelReply(); } }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    if (e.key === 'ArrowUp' && !input.value) { const mine = st.data && [...st.data.messages].reverse().find((m) => m.mine && m.can_edit); if (mine) { e.preventDefault(); startEdit(mine); } }
  });
  function setSendIcon() {
    const b = $('send'), has = !!input.value.trim() || st.editing || !voiceOn();
    b.innerHTML = ic(has ? 'send' : 'mic', 20);
    b.setAttribute('aria-label', st.editing ? 'Save the change' : has ? 'Send' : 'Record a voice message');
    b.classList.toggle('mic', !has);
  }

  // ---------- @mentions ----------
  function mentionCheck() {
    const men = $('mention'), v = input.value.slice(0, input.selectionStart), m = /(?:^|\s)@([^\s@]{0,20})$/.exec(v);
    const people = (st.data && st.data.thread.members) || [];
    if (!m || !people.length) { men.hidden = true; return; }
    const q = m[1].toLowerCase(), hits = people.filter((p) => !(p.kind === st.data.me.kind && p.id === st.data.me.id) && p.name.toLowerCase().includes(q)).slice(0, 6);
    if (!hits.length) { men.hidden = true; return; }
    men.hidden = false;
    men.innerHTML = hits.map((p) => `<button type="button" role="option" data-c="mention" data-name="${esc(p.name)}">${avatarHtml(p, 24)}<span>${esc(p.name)}</span></button>`).join('');
  }
  function insertMention(name) {
    const pos = input.selectionStart, before = input.value.slice(0, pos).replace(/@([^\s@]{0,20})$/, `@${name} `);
    input.value = before + input.value.slice(pos);
    input.setSelectionRange(before.length, before.length);
    $('mention').hidden = true; input.focus(); setSendIcon();
  }

  // ---------- replying and editing ----------
  function startReply(m) {
    st.editing = null; st.reply = m;
    const bar = $('replybar'); bar.hidden = false;
    bar.style.setProperty('--qc', nameCol(m.author));
    bar.innerHTML = `<span class="rb-ic">${ic('reply', 16)}</span><span class="rb-t"><b>Replying to ${esc(m.mine ? 'yourself' : m.author.name)}</b><span>${esc(m.body || (m.file ? (m.file.voice_secs != null ? 'Voice message' : m.file.name) : ''))}</span></span><button type="button" class="ch-ib" data-c="reply-cancel" aria-label="Cancel the reply">${ic('x', 15)}</button>`;
    input.focus();
  }
  function startEdit(m) {
    st.reply = null; st.editing = m;
    const bar = $('replybar'); bar.hidden = false;
    bar.style.setProperty('--qc', 'var(--blue)');
    bar.innerHTML = `<span class="rb-ic">${ic('edit', 16)}</span><span class="rb-t"><b>Editing your message</b><span>${esc(m.body)}</span></span><button type="button" class="ch-ib" data-c="reply-cancel" aria-label="Stop editing">${ic('x', 15)}</button>`;
    input.value = m.body; input.dispatchEvent(new Event('input')); input.focus();
  }
  function cancelReply() { const wasEdit = !!st.editing; st.reply = null; st.editing = null; $('replybar').hidden = true; if (wasEdit) { input.value = ''; input.dispatchEvent(new Event('input')); } }

  // ---------- sending ----------
  async function send(extra = {}) {
    const text = input.value.trim();
    if (st.editing) {
      const m = st.editing;
      if (!text) return;
      try { await patch(`/api/chat/messages/${m.id}`, { body: text }); input.value = ''; cancelReply(); input.dispatchEvent(new Event('input')); load(); } catch (e) { toast(errMsg(e), true); }
      return;
    }
    if (!text && !extra.file_base64) { if (voiceOn()) startRecording(); return; }
    const body = { body: text, reply_to: st.reply ? st.reply.id : null, team_only: st.teamOnly, client_key: newKey(), ...(opts.parentId ? { parent_id: opts.parentId, also_channel: !!(el.querySelector('[data-r="also"]') || {}).checked } : {}), ...extra };
    const keep = input.value;
    input.value = ''; input.dispatchEvent(new Event('input'));
    const rep = st.reply; cancelReply();
    try { await post(`/api/chat/threads/${tid}/messages`, body); await load(); list.scrollTop = list.scrollHeight; }
    catch (e) {
      // no connection: a written message waits here and goes as soon as the phone is back online
      if (e.status === 0 && !extra.file_base64 && text) { st.outbox.push({ key: body.client_key, body: text, reply_to: body.reply_to, team_only: body.team_only, at: Date.now() }); saveOut(tid, st.outbox); renderList(); list.scrollTop = list.scrollHeight; renderOffline(); return; }
      toast(errMsg(e), true); if (!extra.file_base64) { input.value = keep; input.dispatchEvent(new Event('input')); if (rep) startReply(rep); }
    }
  }
  let flushing = false;
  async function flushOutbox() {
    if (flushing || !st.outbox.length) return;
    flushing = true;
    try {
      while (st.outbox.length) {
        const o = st.outbox[0];
        try { await post(`/api/chat/threads/${tid}/messages`, { body: o.body, reply_to: o.reply_to, team_only: o.team_only, client_key: o.key }); }
        catch (e) { if (e.status === 0) break; toast(`Couldn’t send “${o.body.slice(0, 40)}”: ${errMsg(e)}`, true); }
        st.outbox.shift(); saveOut(tid, st.outbox);
      }
    } finally { flushing = false; renderOffline(); if (st.data) load(); }
  }
  function renderOffline() {
    const box = $('offline'), off = !navigator.onLine, n = st.outbox.length;
    box.hidden = !off && !n;
    if (box.hidden) return;
    box.innerHTML = `<span class="co-ic">${ic('wifi0', 16)}</span><span class="co-t"><b>${off ? 'You’re offline.' : 'Not sent yet.'}</b> ${n ? `${n === 1 ? '1 message' : `${n} messages`} will send as soon as you’re back.` : 'Messages you write will send when you’re back.'}</span>${n ? '<button type="button" class="ch-link" data-c="retry">Try now</button>' : ''}`;
  }
  const onNet = () => { renderOffline(); if (navigator.onLine) flushOutbox(); };
  window.addEventListener('online', onNet, sig); window.addEventListener('offline', onNet, sig);
  $('file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('Files can be up to 5 MB', true); return; }
    let type = f.type;
    if (!type) type = /\.docx$/i.test(f.name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : /\.xlsx$/i.test(f.name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : /\.csv$/i.test(f.name) ? 'text/csv' : '';
    try { await send({ file_base64: await fileBase64(f), file_type: type, file_name: f.name }); } catch (err) { toast(errMsg(err), true); }
  });

  // ---------- voice messages ----------
  async function startRecording() {
    if (st.rec) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('This browser can’t record voice messages', true); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { toast('Allow the microphone to record a voice message', true); return; }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : {});
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    st.rec = { rec, stream, chunks, start: Date.now(), send: false };
    let sent = false;
    rec.onstop = async () => {
      if (sent) return; sent = true;
      stream.getTracks().forEach((t) => t.stop());
      const r = st.rec; st.rec = null; clearInterval(recT);
      $('rec').hidden = true; $('row').hidden = false;
      if (!r.send || !chunks.length) return;
      const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' });
      const secsN = Math.max(1, Math.round((Date.now() - r.start) / 1000));
      const ft = (blob.type || 'audio/webm').split(';')[0];
      try { await send({ file_base64: await fileBase64(blob), file_type: ft, file_name: `Voice message.${ft === 'audio/mp4' ? 'm4a' : ft === 'audio/ogg' ? 'ogg' : 'webm'}`, voice_secs: secsN }); } catch (e) { toast(errMsg(e), true); }
    };
    rec.start();
    $('row').hidden = true; $('rec').hidden = false;
    const recT = setInterval(() => { const s = (Date.now() - st.rec.start) / 1000; $('rectime').textContent = secs(s); if (s > 300) stopRecording(true); }, 250);
  }
  function stopRecording(sendIt) { if (!st.rec) return; st.rec.send = sendIt; st.rec.rec.stop(); }

  async function play(m) {
    if (st.audio && st.audio.mid === m.id) { if (st.audio.el.paused) st.audio.el.play(); else st.audio.el.pause(); renderList(); return; }
    if (st.audio) st.audio.el.pause();
    try {
      if (!st.urls.has(m.id)) st.urls.set(m.id, await fileUrl(m.file.url));
      const a = new Audio(st.urls.get(m.id));
      st.audio = { mid: m.id, el: a, pct: 0, rate: 1 };
      a.ontimeupdate = () => { st.audio.pct = a.duration && isFinite(a.duration) ? a.currentTime / a.duration : a.currentTime / (m.file.voice_secs || 1); const v = list.querySelector(`[data-mid="${m.id}"] .bub-voice`); if (v) v.outerHTML = voiceHtml(m); };
      a.onended = () => { st.audio = null; renderList(); };
      await a.play();
      renderList();
    } catch (e) { toast(errMsg(e), true); }
  }

  // ---------- emoji picker ----------
  function openPicker(anchor, onPick, startMode = 'emoji') {
    const box = $('picker');
    const tabs = [['Recent', '🕘'], ...EMOJI.map(([n, l]) => [n, l.split(' ')[0]])];
    let cur = recent().length ? 'Recent' : 'Smileys', q = '', mode = startMode;
    const modes = () => `<div class="ep-modes" role="tablist" aria-label="Emoji or GIFs"><button type="button" role="tab" data-mode="emoji" aria-selected="${String(mode === 'emoji')}">Emoji</button><button type="button" role="tab" data-mode="gif" aria-selected="${String(mode === 'gif')}">GIF</button></div>`;
    const draw = () => {
      if (mode === 'gif') { drawGifs(box, modes()); return; }
      const listFor = q ? ALL_EMOJI.filter(([, n]) => n.includes(q.toLowerCase())).map(([e]) => e) : cur === 'Recent' ? recent() : ALL_EMOJI.filter(([e]) => EMOJI.find(([n]) => n === cur)[1].includes(e)).map(([e]) => e);
      box.innerHTML = `${modes()}<label class="ep-search">${ic('search', 15)}<input type="search" placeholder="Search emoji" aria-label="Search emoji" value="${esc(q)}"></label>
        <div class="ep-h">${q ? 'Results' : esc(cur)}</div><div class="ep-grid">${listFor.length ? listFor.map((e) => `<button type="button" data-pick="${e}" aria-label="${e}">${e}</button>`).join('') : '<span class="ep-none">No emoji found</span>'}</div>
        <div class="ep-tabs" role="tablist">${tabs.map(([n, e]) => `<button type="button" role="tab" aria-selected="${String(!q && n === cur)}" aria-label="${n}" data-tab="${n}">${e}</button>`).join('')}</div>`;
      const si = box.querySelector('input'); si.addEventListener('input', () => { q = si.value; const pos = si.selectionStart; draw(); const n = box.querySelector('input'); n.focus(); n.setSelectionRange(pos, pos); });
    };
    draw();
    box.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    box.onclick = (e) => {
      const md = e.target.closest('[data-mode]'); if (md) { if (md.dataset.mode !== mode) { mode = md.dataset.mode; draw(); focusSearch(); } return; }
      const g = e.target.closest('[data-gif]'); if (g) { const item = gif.items[Number(g.dataset.gif)]; if (item) { close(); sendGif(item); } return; }
      const t = e.target.closest('[data-tab]'); if (t) { cur = t.dataset.tab; q = ''; draw(); return; }
      const p = e.target.closest('[data-pick]'); if (p) { remember(p.dataset.pick); onPick(p.dataset.pick); }
    };
    const close = (e) => { if (e && (box.contains(e.target) || anchor.contains(e.target))) return; box.hidden = true; anchor.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', close, true); };
    setTimeout(() => document.addEventListener('mousedown', close, true), 0);
    st.closePicker = () => close();
    const focusSearch = () => { if (matchMedia('(min-width: 700px)').matches) setTimeout(() => { const si = box.querySelector('input'); if (si) si.focus(); }, 30); };
    focusSearch();
  }

  // ---------- GIFs: searched on GIPHY or Tenor through Staffwarden, sent as a picture ----------
  const gif = { q: '', items: [], state: 'idle', msg: '', credit: '', timer: null, seq: 0 };
  function drawGifs(box, head) {
    box.innerHTML = `${head}<label class="ep-search">${ic('search', 15)}<input type="search" placeholder="Search GIFs" aria-label="Search GIFs" value="${esc(gif.q)}"></label><div class="gp-grid" data-r="gifs"></div><div class="gp-foot" data-r="gifcredit"></div>`;
    const si = box.querySelector('input');
    si.addEventListener('input', () => { gif.q = si.value; clearTimeout(gif.timer); gif.timer = setTimeout(() => findGifs(box), 350); });
    if (gif.state === 'idle' || !gif.items.length) findGifs(box); else drawGifGrid(box);
  }
  async function findGifs(box) {
    const my = ++gif.seq;
    gif.state = 'loading'; drawGifGrid(box);
    try {
      const r = await get(`/api/chat/gifs?q=${encodeURIComponent(gif.q.trim())}`);
      if (my !== gif.seq) return;
      if (!r.enabled) { gif.state = 'off'; gif.items = []; }
      else { gif.state = 'ok'; gif.items = r.items; gif.credit = r.credit || ''; }
    } catch (e) { if (my !== gif.seq) return; gif.state = 'error'; gif.msg = errMsg(e); gif.items = []; }
    drawGifGrid(box);
  }
  function drawGifGrid(box) {
    const grid = box.querySelector('[data-r="gifs"]'), foot = box.querySelector('[data-r="gifcredit"]');
    if (!grid) return;
    const owner = !!(S.me && S.me.kind !== 'client' && S.me.role === 'owner');
    if (gif.state === 'loading' && !gif.items.length) grid.innerHTML = '<span class="gp-none">Finding GIFs…</span>';
    else if (gif.state === 'off') grid.innerHTML = `<span class="gp-none"><b>GIF search isn’t on yet</b>${owner ? 'Add a free GIPHY or Tenor key in Settings, under Chat.<a href="#/settings" class="gp-set">Open Settings</a>' : 'The owner can turn it on in Settings.'}</span>`;
    else if (gif.state === 'error') grid.innerHTML = `<span class="gp-none">${esc(gif.msg)}</span>`;
    else if (!gif.items.length) grid.innerHTML = '<span class="gp-none">No GIFs for that. Try another word.</span>';
    else {
      // two columns, each GIF going to the shorter one, so the picker scrolls down and never sideways
      const cols = [[], []], hs = [0, 0];
      gif.items.forEach((g, i) => { const c = hs[0] <= hs[1] ? 0 : 1; cols[c].push(`<button type="button" class="gp-i" data-gif="${i}" aria-label="Send GIF: ${esc(g.title)}" style="aspect-ratio:${g.w}/${g.h}"><img alt="" data-gsrc="${esc(g.preview)}"></button>`); hs[c] += g.h / g.w; });
      grid.innerHTML = cols.map((c) => `<div class="gp-col">${c.join('')}</div>`).join('');
    }
    if (foot) foot.textContent = gif.state === 'ok' ? gif.credit : '';
    for (const img of grid.querySelectorAll('img[data-gsrc]')) loadGif(img);
  }
  const gifUrls = new Map();
  async function loadGif(img) {
    const src = img.dataset.gsrc;
    try {
      if (!gifUrls.has(src)) { gifUrls.set(src, fileUrl(src)); if (gifUrls.size > 120) { const [k, v] = gifUrls.entries().next().value; gifUrls.delete(k); v.then((u) => URL.revokeObjectURL(u)).catch(() => {}); } }
      img.src = await gifUrls.get(src);
    } catch { img.closest('.gp-i')?.classList.add('broken'); }
  }
  async function sendGif(g) {
    toast('Sending the GIF…');
    try {
      const buf = await fileBytes(g.full);
      const b64 = await fileBase64(new Blob([buf], { type: 'image/gif' }));
      await send({ file_base64: b64, file_type: 'image/gif', file_name: `${String(g.title || 'GIF').replace(/[^\w .-]/g, '').trim().slice(0, 60) || 'GIF'}.gif` });
    } catch (e) { toast(errMsg(e), true); }
  }
  function insertEmoji(e) {
    const a = input.selectionStart ?? input.value.length, b = input.selectionEnd ?? a;
    input.value = input.value.slice(0, a) + e + input.value.slice(b);
    input.setSelectionRange(a + e.length, a + e.length);
    input.dispatchEvent(new Event('input'));
  }

  // ---------- the message menu (also what a long press opens) ----------
  const msgById = (id) => st.data && st.data.messages.find((m) => m.id === Number(id));
  async function react(m, e) { try { await post(`/api/chat/messages/${m.id}/react`, { emoji: e }); remember(e); load({ keepScroll: true }); } catch (err) { toast(errMsg(err), true); } }
  function menu(m) {
    const d = st.data, canPin = d.me.kind === 'staff' || d.thread.kind === 'direct';
    const items = [['reply', 'Reply', ''], ...(opts.onThread && !opts.parentId ? [['thread', 'Reply in thread', '']] : []), ...(d.me.kind === 'staff' && !m.task ? [['task', 'Make it a task', '']] : []), ['copy', 'Copy', ''], ...(m.can_edit ? [['edit', 'Edit', '']] : []), ...(canPin ? [['pin', m.pinned ? 'Unpin' : 'Pin', '']] : []), ...(m.mine ? [['info', 'Info', m.seen ? `Seen by ${m.seen.length}` : '']] : []), ...(m.mine ? [['trash', 'Delete for everyone', '']] : [])];
    const sheet = openModal({
      title: 'Message', footer: false, sub: m.body ? m.body.slice(0, 120) : m.file ? m.file.name : '',
      body: { toString: () => `<div class="ms-rx" role="toolbar" aria-label="React">${QUICK.map((e) => `<button type="button" data-mx="react" data-e="${e}" aria-label="React ${e}">${e}</button>`).join('')}<button type="button" data-mx="react-more" aria-label="More reactions">${ic('plus', 18)}</button></div>
        <div class="ms-list">${items.map(([i, l, x]) => `<button type="button" data-mx="${i}" class="${i === 'trash' ? 'bad' : ''}">${ic(i, 19)}<span>${l}</span><small>${esc(x)}</small></button>`).join('')}</div>` },
    });
    sheet.form.classList.add('ms-sheet');
    sheet.form.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-mx]'); if (!b) return;
      const a = b.dataset.mx; sheet.close();
      if (a === 'react') react(m, b.dataset.e);
      else if (a === 'react-more') openPicker(el.querySelector(`[data-mid="${m.id}"] .bub`) || $('row'), (e) => { st.closePicker && st.closePicker(); react(m, e); });
      else if (a === 'reply') startReply(m);
      else if (a === 'thread') opts.onThread(m);
      else if (a === 'task') makeTask(m);
      else if (a === 'copy') { try { await navigator.clipboard.writeText(m.body); toast('Copied'); } catch { toast('Copy it by hand: your browser blocked copying', true); } }
      else if (a === 'edit') startEdit(m);
      else if (a === 'pin') { try { await post(`/api/chat/messages/${m.id}/pin`, { on: !m.pinned }); load({ keepScroll: true }); } catch (e) { toast(errMsg(e), true); } }
      else if (a === 'info') info(m);
      else if (a === 'trash') {
        if (!(await confirmBox({ title: 'Delete for everyone?', message: 'Everyone in the chat sees that a message was deleted.', confirm: 'Delete', danger: true }))) return;
        try { await del(`/api/chat/messages/${m.id}`); load({ keepScroll: true }); } catch (e) { toast(errMsg(e), true); }
      }
    });
  }
  // ---------- a message becomes a task ----------
  async function makeTask(m) {
    let projects = [];
    try { projects = (await get('/api/projects')).filter((p) => !p.archived); } catch { projects = []; }
    const d = st.data;
    const here = d.thread.project_id || null;
    const opt = (v, t, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(t)}</option>`;
    const md = openModal({
      title: 'Make it a task', submit: 'Make the task', sub: 'The message stays linked to the task, and the chat shows who it went to.',
      body: { toString: () => `<div class="mt-msg">${avatarHtml(m.author, 26)}<span><b>${esc(m.author.name)}</b> · ${esc(timeOf(m.created_at))}<br>${esc((m.body || (m.file ? m.file.name : '')).slice(0, 300))}</span></div>
        <div class="field"><label class="f" for="mt-title">Task</label><input id="mt-title" name="title" maxlength="200" required value="${esc((m.body || (m.file ? m.file.name : '')).split('\n')[0].slice(0, 120))}"></div>
        <div class="grid2"><div class="field"><label class="f" for="mt-proj">Project</label><select id="mt-proj" name="project_id">${opt('', 'No project')}${projects.map((p) => opt(p.id, `${p.key ? `${p.key} · ` : ''}${p.name}`, p.id === here)).join('')}</select></div>
          <div class="field"><label class="f" for="mt-who">Who does it</label><select id="mt-who" name="assignee_id">${opt(d.me.id, 'Me')}</select></div>
          <div class="field"><label class="f" for="mt-due">Due <span class="muted">(optional)</span></label><input id="mt-due" name="due_day" type="date"></div>
          <div class="field"><label class="f" for="mt-pri">Priority</label><select id="mt-pri" name="priority">${opt('normal', 'Normal', true)}${opt('high', 'High')}${opt('urgent', 'Urgent')}${opt('low', 'Low')}</select></div></div>
        ${d.thread.team ? '<label class="check"><input type="checkbox" name="announce" value="1" checked><span>Tell the chat it’s now a task</span></label>' : ''}` },
      onSubmit: async (fd) => {
        const t = await post(`/api/chat/messages/${m.id}/task`, { title: fd.get('title'), project_id: fd.get('project_id') || null, assignee_id: fd.get('assignee_id') || null, due_day: fd.get('due_day') || null, priority: fd.get('priority'), announce: fd.get('announce') === '1' });
        toast(`${t.key ? `${t.key} made` : 'Task made'}${t.assignee_id !== d.me.id && t.assignee ? ` for ${t.assignee}` : ''}`); load({ keepScroll: true });
      },
    });
    const ps = md.form.querySelector('#mt-proj'), who = md.form.querySelector('#mt-who');
    const fill = async () => {
      const pid = ps.value;
      let people = [];
      if (pid) { try { people = (await get(`/api/projects/${pid}`)).members || []; } catch { people = []; } }
      else people = (d.thread.members || []).filter((x) => x.kind === 'staff');
      who.innerHTML = opt(d.me.id, 'Me') + people.filter((x) => x.id !== d.me.id).map((x) => opt(x.id, x.name, x.id === m.author.id && m.author.kind === 'staff' && false)).join('');
    };
    ps.addEventListener('change', fill); fill();
  }
  // ---------- team chats: mute and people ----------
  function muteMenu() {
    const t = st.data.thread;
    const choices = [['none', 'Every message', 'You hear about everything here'], ['mentions', 'Only when someone mentions me', 'Quiet unless @you'], ['60', 'Mute for an hour', ''], ['480', 'Mute until tomorrow', 'Eight hours'], ['all', 'Mute', 'Nothing, until you turn it back on']];
    const md = openModal({ title: `Notifications for ${t.kind === 'channel' ? `#${t.name}` : t.name}`, footer: false,
      body: { toString: () => `<div class="ms-list">${choices.map(([k, l, sub]) => `<button type="button" data-mu="${k}" class="${(t.mute === k && !t.muted_until) ? 'on' : ''}">${ic(k === 'none' ? 'bell' : 'mute', 19)}<span>${esc(l)}</span><small>${esc(sub)}</small></button>`).join('')}</div>` } });
    md.form.classList.add('ms-sheet');
    md.form.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-mu]'); if (!b) return;
      const k = b.dataset.mu; md.close();
      try { await put(`/api/team/threads/${tid}/mute`, /^\d+$/.test(k) ? { minutes: Number(k) } : { mode: k }); toast(k === 'none' ? 'You’ll hear about everything here' : 'Muted'); load({ keepScroll: true }); if (opts.onChange) opts.onChange(); } catch (e) { toast(errMsg(e), true); }
    });
  }
  async function peopleSheet() {
    const t = st.data.thread;
    let r;
    try { r = await get(`/api/team/threads/${tid}/people`); } catch (e) { toast(errMsg(e), true); return; }
    const canAdd = t.kind === 'channel' || t.kind === 'team_group';
    const md = openModal({ title: `${t.kind === 'channel' ? `#${t.name}` : t.name}: ${r.people.length} ${r.people.length === 1 ? 'person' : 'people'}`, footer: false,
      body: { toString: () => `<ul class="ms-seen">${r.people.map((p) => `<li>${avatarHtml({ kind: 'staff', id: p.id, name: p.name }, 28)}<b>${esc(p.name)}</b><span>${p.online ? 'Online' : esc(p.title || '')}${p.role === 'admin' ? ' · admin' : ''}</span></li>`).join('')}</ul>
        ${canAdd ? '<div class="mt"><button type="button" class="btn sm" data-pp="add">Add people</button> ' + (t.member ? '<button type="button" class="btn sm quiet" data-pp="leave">Leave this chat</button>' : '') + '</div>' : ''}` } });
    md.form.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-pp]'); if (!b) return;
      if (b.dataset.pp === 'leave') { md.close(); if (!(await confirmBox({ title: 'Leave this chat?', message: 'You stop hearing about it. You can join a public channel again later.', confirm: 'Leave' }))) return; try { await post(`/api/team/threads/${tid}/leave`); if (opts.onChange) opts.onChange(true); } catch (e) { toast(errMsg(e), true); } return; }
      md.close(); if (opts.onAddPeople) opts.onAddPeople(tid, r.people.map((p) => p.id));
    });
  }
  function info(m) {
    const seen = m.seen || [];
    openModal({ title: 'Message info', footer: false, sub: `Sent ${new Date(m.created_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`,
      body: { toString: () => (seen.length ? `<ul class="ms-seen">${seen.map((p) => `<li>${avatarHtml(p, 28)}<b>${esc(p.name)}</b><span>${esc(timeOf(p.at))}</span></li>`).join('')}</ul>` : '<p class="muted">Nobody has read it yet.</p>') } });
  }

  // ---------- clicks ----------
  let pressT = null, pressed = false;
  el.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.bub[data-c="bubble"]');
    if (!b || e.pointerType === 'mouse' || e.target.closest('button,a')) return;
    pressed = false;
    pressT = setTimeout(() => { pressed = true; const m = msgById(b.dataset.id); if (m && !m.deleted) { if (navigator.vibrate) navigator.vibrate(12); menu(m); } }, 450);
  }, sig);
  ['pointerup', 'pointercancel', 'pointermove'].forEach((ev) => el.addEventListener(ev, (e) => { if (ev !== 'pointermove' || Math.abs(e.movementY) > 4) clearTimeout(pressT); }, sig));
  el.addEventListener('contextmenu', (e) => { const b = e.target.closest('.bub[data-c="bubble"]'); if (b && matchMedia('(pointer: coarse)').matches) e.preventDefault(); }, sig);
  el.addEventListener('click', async (e) => {
    if (pressed) { pressed = false; e.preventDefault(); return; }
    const b = e.target.closest('[data-c]'); if (!b || !el.contains(b)) return;
    const c = b.dataset.c, m = b.dataset.id ? msgById(b.dataset.id) : null;
    if (c === 'bubble') return;
    if (c === 'send') return send();
    if (c === 'emoji') { if (!$('picker').hidden) { st.closePicker(); return; } openPicker(b, insertEmoji); return; }
    if (c === 'gif') { if (!$('picker').hidden) { st.closePicker(); return; } openPicker(b, insertEmoji, 'gif'); return; }
    if (c === 'react' && m) return react(m, b.dataset.e);
    if (c === 'react-more' && m) return openPicker(b, (em) => { st.closePicker(); react(m, em); });
    if (c === 'reply' && m) return startReply(m);
    if (c === 'menu' && m) return menu(m);
    if (c === 'reply-cancel') return cancelReply();
    if (c === 'thread' && m && opts.onThread) return opts.onThread(m);
    if (c === 'close-replies' && opts.onClose) return opts.onClose();
    if (c === 'mktask' && m) return makeTask(m);
    if (c === 'boost') { try { await post(`/api/boost/${b.dataset.b}/answer`, { answer: b.dataset.a }); load({ keepScroll: true }); } catch (err) { toast(errMsg(err), true); } return; }
    if (c === 'annok') { try { await post(`/api/announcements/${b.dataset.a}/confirm`); toast('Thanks. Marked as read.'); load({ keepScroll: true }); } catch (err) { toast(errMsg(err), true); } return; }
    if (c === 'tjoin') { try { await post(`/api/team/threads/${tid}/join`); load(); if (opts.onChange) opts.onChange(); } catch (err) { toast(errMsg(err), true); } return; }
    if (c === 'tmute') return muteMenu();
    if (c === 'tpeople') return peopleSheet();
    if (c === 'mention') return insertMention(b.dataset.name);
    if (c === 'rec-cancel') return stopRecording(false);
    if (c === 'rec-send') return stopRecording(true);
    if (c === 'play' && m) return play(m);
    if (c === 'rate' && st.audio && m && st.audio.mid === m.id) { st.audio.rate = st.audio.rate === 1 ? 1.5 : st.audio.rate === 1.5 ? 2 : 1; st.audio.el.playbackRate = st.audio.rate; b.textContent = `${st.audio.rate}×`; return; }
    if (c === 'open' && m) { try { window.open(st.urls.get(m.id) || await fileUrl(m.file.url), '_blank', 'noopener'); } catch (err) { toast(errMsg(err), true); } return; }
    if (c === 'goto') { const t = document.getElementById(`msg-${tid}-${b.dataset.id}`); if (t) { centerIn(t, true); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1400); } else toast('That message is further back. Show earlier messages to find it.'); return; }
    if (c === 'jump') { list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' }); showJump(0); return; }
    if (c === 'aud') { st.teamOnly = b.dataset.v === 'team'; renderTeam(); input.focus(); return; }
    if (c === 'search') { $('searchbar').hidden = false; $('searchin').focus(); return; }
    if (c === 'search-close') { $('searchbar').hidden = true; st.search = ''; $('searchin').value = ''; renderList(); return; }
    if (c === 'older') return older();
    if (c === 'gallery' && opts.onGallery) { opts.galleryOpen = !opts.galleryOpen; b.setAttribute('aria-pressed', String(opts.galleryOpen)); return opts.onGallery(opts.galleryOpen); }
    if (c === 'retry') return flushOutbox();
    if (c === 'save' && m) { try { const u = st.urls.get(m.id) || await fileUrl(m.file.url); const a = document.createElement('a'); a.href = u; a.download = m.file.name; document.body.appendChild(a); a.click(); a.remove(); } catch (err) { toast(errMsg(err), true); } return; }
  }, sig);
  $('searchin').addEventListener('input', (e) => { st.search = e.target.value.trim(); renderList(); const hit = list.querySelector('.msg:not(.dim) mark'); if (hit) centerIn(hit); });
  list.addEventListener('scroll', () => { if (list.scrollHeight - list.scrollTop - list.clientHeight < 60) { showJump(0); markRead(); } });
  // scrolls the messages, never the page around them
  function centerIn(node, smooth = false) {
    const lr = list.getBoundingClientRect(), nr = node.getBoundingClientRect();
    list.scrollTo({ top: list.scrollTop + (nr.top - lr.top) - (list.clientHeight - nr.height) / 2, behavior: smooth ? 'smooth' : 'auto' });
  }
  // a message from a search: shown in place, with earlier messages loaded until it is there
  async function goTo(id) {
    for (let i = 0; i < 6 && !document.getElementById(`msg-${tid}-${id}`) && st.data && st.data.more; i++) await older();
    const t = document.getElementById(`msg-${tid}-${id}`);
    if (t) { centerIn(t); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1600); } else list.scrollTop = list.scrollHeight;
  }
  async function older() {
    const d = st.data; if (!d || !d.messages.length) return;
    try {
      const o = await get(`/api/chat/threads/${tid}/messages?before=${d.messages[0].id}`);
      const h0 = list.scrollHeight;
      d.messages = [...o.messages, ...d.messages]; d.more = o.more;
      renderList();
      list.scrollTop = list.scrollHeight - h0;
    } catch (e) { toast(errMsg(e), true); }
  }
  // Escape closes the emoji picker first, then a reply or an edit
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('picker').hidden) { e.preventDefault(); e.stopPropagation(); st.closePicker(); const b = el.querySelector('[data-c="emoji"]'); if (b) b.focus(); } }, { capture: true, signal: ac.signal });
  const onVis = () => { if (!document.hidden) markRead(); };
  document.addEventListener('visibilitychange', onVis);

  // if the live connection goes quiet (a proxy holding events back, a flaky network), check every few seconds
  const poll = setInterval(() => { if (!document.contains(el)) { self.stop(); return; } if (!document.hidden && !liveFresh()) load(); if (st.outbox.length && navigator.onLine) flushOutbox(); }, 5000);
  const self = { el, tid, reload, typing, goTo, setPresence(p) { st.presence = p; if (st.data) { renderHead(); } }, stop() { ac.abort(); live.delete(self); clearInterval(poll); document.removeEventListener('visibilitychange', onVis); if (st.audio) st.audio.el.pause(); for (const u of st.urls.values()) URL.revokeObjectURL(u); if (st.rec) stopRecording(false); } };
  st.clientName = opts.clientName; st.orgShort = opts.orgShort;
  live.add(self);
  load();
  renderOffline();
  if (st.outbox.length && navigator.onLine) setTimeout(flushOutbox, 600);
  if (opts.focus) setTimeout(() => input.focus(), 50);
  return self;
}
export { avatarHtml as chatAvatar, ic as chatIcon, timeOf as chatTime, dayLabel as chatDay, ticks as chatTicks };
