// Developer access: run and fix Staffwarden. A developer also has the owner's view of everything else; these
// pages add server health, the notice at the top of every screen, the desktop apps and their releases,
// error reports, feature switches and test tools.
import { html, raw, esc, icon, relTime, plural, initials, avColor, nowMs } from '../util.js';
import { get, post, put, patch } from '../api.js';
import { S, actions, toast, errMsg, kpis, tag, empty, openModal, confirmBox, qAttr } from '../ui.js';
import { boostClipPreview } from '../v4.js';

// ---------- small helpers
const bytes = (n) => (n == null ? '–' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const upFor = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${plural(d, 'day')} ${plural(h, 'hour')}` : h ? `${plural(h, 'hour')} ${m} min` : `${m} min`; };
const t12 = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const when = (iso) => {
  const d = new Date(iso), now = new Date(nowMs());
  if (d.toDateString() === now.toDateString()) return t12(iso);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday ${t12(iso)}`;
  return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const av = (p, cls = '') => html`<span class="avatar sm ${cls}" style="background:${avColor(p.id)}" title="${p.name}" aria-hidden="true">${initials(p.name)}</span>`;
const SRC = { web: 'Website', desktop: 'Desktop app', server: 'Server', portal: 'Client portal' };
const PLAT = (p) => (!p ? '' : /^win32/.test(p) ? 'Windows' : /^darwin arm64/.test(p) ? 'Mac, Apple chip' : /^darwin/.test(p) ? 'Mac, Intel' : p);
const where = (g) => [SRC[g.source] || g.source, g.version ? g.version : '', PLAT(g.platform) ? `on ${PLAT(g.platform)}` : ''].filter(Boolean).join(' ');
const errTag = (g) => (g.status === 'fixed' ? tag('approved', g.fixed_in ? `Fixed in ${g.fixed_in}` : 'Fixed')
  : g.status === 'ignored' ? tag('off', 'Ignored')
    : nowMs() - Date.parse(g.first_at) < 86400000 ? tag('absent', 'New') : g.count > 1 ? tag('pending', 'Keeps happening') : tag('idle', 'Once'));
const devTabs = (cur) => html`<nav class="dv-nav" aria-label="Developer pages">${[['dev', 'Overview', 'code'], ['dev-apps', 'Desktop apps', 'laptop'], ['dev-errors', 'Error reports', 'alert'], ['dev-tools', 'Switches and tools', 'sliders']].map(([r, n, ic]) => html`<a class="btn" href="#/${r}" ${raw(cur === r ? 'aria-current="page"' : '')}>${icon(ic)} ${n}</a>`)}</nav>`;
const head = (cur, title, sub) => html`<div class="page-h dv-h"><div><h1>${title}${cur !== 'dev' ? html` <span class="dv-chip">${icon('code')} Developer</span>` : ''}</h1><p class="sub">${sub}</p></div>${devTabs(cur)}</div>`;
const ownerName = () => (S.me.role === 'owner' && !S.me.dev_owner ? 'you' : 'the CEO');

const backupAge = (ms) => { const h = Math.round(ms / 3600e3); return h < 1 ? 'Just now' : h === 1 ? '1 hour ago' : h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`; };
// ============================== Developer home ==============================
export const devHome = {
  title: 'Developer',
  async load() {
    const [h, e] = await Promise.all([get('/api/dev/health'), get('/api/dev/errors?status=open')]);
    return { h, e };
  },
  render({ h, e }) {
    const b = h.backups, last = b.files && b.files[0];
    const bAge = last ? nowMs() - Date.parse(last.at) : null;
    const cells = [
      { ic: 'server', label: 'Server', value: html`<span class="dv-dot good"></span>Running`, foot: `Up ${upFor(h.uptime_s)}, website ${String(h.build).slice(0, 7)}` },
      { ic: 'db', label: 'Database', value: h.db_bytes ? bytes(h.db_bytes) : 'In memory', foot: `Schema ${h.schema}, ${plural(h.people.active, 'person', 'people')}` },
      b.shared ? { ic: 'shield', label: 'Backups', value: 'Handled for you', foot: 'Staffwarden backs up every company each night' } : { ic: 'shield', label: 'Backups', value: !b.found ? 'Not here' : last ? html`<span class="dv-dot ${bAge < 30 * 3600e3 ? 'good' : 'bad'}"></span>${backupAge(bAge)}` : 'None yet',
        foot: !b.found ? 'This server keeps none' : `${last ? `${when(last.at)}. ` : ''}${b.offsite ? (b.offsite.ok ? 'Off-site copy made' : 'Off-site copy failed') : 'No off-site copy'}, ${b.count} kept`, tone: !b.found || !last || bAge > 30 * 3600e3 ? 'warn' : '' },
      { ic: 'pulse', label: 'Live right now', value: String(h.live.staff + h.live.clients), foot: `${plural(h.live.staff, 'staff screen')}, ${plural(h.live.clients, 'client')}; ${h.people.working} working` },
    ];
    const open = e.groups.slice(0, 5);
    const look = html`<section class="panel flush dv-look"><header><h2>Needs a look</h2><a class="dv-more" href="#/dev-errors">All error reports${e.counts.open ? ` (${e.counts.open})` : ''}</a></header>
      ${open.length ? html`<ul class="dv-rows">${open.map((g) => html`<li><a href="#/dev-errors?sig=${g.sig}"><span class="dv-r1"><b>${g.title}</b><span>${where(g)}</span></span>
        <span class="dv-r2">${g.people_count ? plural(g.people_count, 'person', 'people') : 'No one signed in'}</span><span class="dv-r3">${plural(g.count, 'time')}, last ${when(g.last_at)}</span>${errTag(g)}</a></li>`)}</ul>`
        : html`<div class="body">${empty('Nothing needs a look', 'When something goes wrong in the apps, the website or the server, it shows up here.')}</div>`}</section>`;
    const pct = (a, b2) => (b2 ? Math.round((a / b2) * 100) : 0);
    const used = h.disk ? h.disk.total - h.disk.free : 0, memUsed = h.memory ? h.memory.total - h.memory.free : 0;
    const loadPct = h.load ? Math.min(100, Math.round((h.load[0] / Math.max(1, h.cpus)) * 100)) : 0;
    const bar = (label, right, p) => html`<div class="dv-bar"><div><b>${label}</b><span>${right}</span></div><span class="meter ${p > 90 ? 'bad' : p > 75 ? 'warn' : ''}"><i style="width:${Math.max(2, p)}%"></i></span></div>`;
    const server = !h.memory ? html`<section class="panel dv-srv"><header><h2>The server</h2></header><div class="body"><p class="muted">Staffwarden runs and watches the server that your company is on. Running for ${upFor(h.uptime_s)}.</p></div></section>` : html`<section class="panel dv-srv"><header><h2>The server</h2></header><div class="body">
      ${h.disk ? bar('Disk', `${bytes(used)} of ${bytes(h.disk.total)}`, pct(used, h.disk.total)) : ''}
      ${bar('Memory', `${bytes(memUsed)} of ${bytes(h.memory.total)}`, pct(memUsed, h.memory.total))}
      ${bar('Load', loadPct < 30 ? 'Quiet' : loadPct < 70 ? 'Busy' : 'Very busy', loadPct)}
      <p class="small muted">Staffwarden itself uses ${bytes(h.memory.process)}. The machine has been on for ${upFor(h.host_uptime_s)}; Node ${h.node}.</p></div></section>`;
    return html`${head('dev', 'Developer', `Run and fix Staffwarden. Only ${ownerName()} can give this access, and everyone can see who has it.`)}${kpis(cells)}
      <div class="cols dv-cols">${look}${server}</div>${bannerPanel(h.banner)}${b.shared ? '' : backupPanel(b)}`;
  },
  after(view) { wireBanner(view); },
};

// ---------- the notice at the top of every screen
const localInput = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function bannerPanel(b) {
  const state = !b ? null : b.ended ? 'Ended' : b.scheduled ? `Shows from ${when(b.from)}` : 'Showing now';
  return html`<section class="panel dv-ban"><div class="body dv-ban-g">
    <form class="dv-ban-f" id="banform" novalidate>
      <h2>Notice at the top</h2>
      <p class="muted">A line across the top of Staffwarden for everyone, on the website and in the client portal. For updates and planned downtime.</p>
      ${b ? html`<p class="dv-ban-now">${tag(b.ended ? 'off' : b.scheduled ? 'pending' : 'working', state)}${b.until && !b.ended ? html` <span class="muted small">until ${when(b.until)}</span>` : ''}</p>` : ''}
      <div class="field"><label class="f" for="bn-t">Message</label><textarea id="bn-t" name="text" rows="2" maxlength="200" placeholder="Staffwarden updates at 11 PM. Back in about 2 minutes.">${b ? b.text : ''}</textarea></div>
      <div class="grid2"><div class="field"><label class="f" for="bn-f">Show from <span class="muted">(blank: now)</span></label><input id="bn-f" name="from" type="datetime-local" value="${localInput(b && b.from)}"></div>
        <div class="field"><label class="f" for="bn-u">Until <span class="muted">(blank: until taken down)</span></label><input id="bn-u" name="until" type="datetime-local" value="${localInput(b && b.until)}"></div></div>
      <div class="field"><span class="f">Colour</span><div class="seg-tabs dv-tone" role="radiogroup" aria-label="Colour">${[['info', 'Calm'], ['warn', 'Important']].map(([v, n]) => html`<label><input type="radio" name="tone" value="${v}" ${raw((b ? b.tone : 'warn') === v ? 'checked' : '')}><span>${n}</span></label>`)}</div></div>
      <p class="err" role="alert"></p>
      <div class="dv-ban-a"><button class="btn primary" type="submit">${icon('mega')} ${b && !b.ended ? 'Update the notice' : 'Show the notice'}</button>${b ? html`<button class="btn" type="button" data-act="dv-banner-off">Take it down</button>` : ''}</div>
    </form>
    <div class="dv-ban-p" aria-hidden="true"><span class="f">What people see</span><div class="dv-ban-shot"><div class="sysban ${b ? b.tone : 'warn'}" id="bn-prev">${icon('clock')}<b>${b ? b.text : 'Staffwarden updates at 11 PM. Back in about 2 minutes.'}</b><u>Got it</u></div><div class="dv-ban-mock"><i></i><i></i><i></i></div></div></div>
  </div></section>`;
}
function wireBanner(view) {
  const f = view.querySelector('#banform');
  if (!f || f.dataset.wired) return;
  f.dataset.wired = '1';
  const prev = view.querySelector('#bn-prev');
  const sync = () => {
    const t = f.text.value.trim() || 'Staffwarden updates at 11 PM. Back in about 2 minutes.';
    prev.querySelector('b').textContent = t;
    prev.className = `sysban ${f.tone.value}`;
  };
  f.addEventListener('input', sync); f.addEventListener('change', sync);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = f.querySelector('.err'), btn = f.querySelector('[type=submit]');
    err.textContent = '';
    if (!f.text.value.trim()) { err.textContent = 'Write the message people will see.'; f.text.focus(); return; }
    btn.disabled = true;
    try {
      const iso = (v) => (v ? new Date(v).toISOString() : null);
      await put('/api/dev/banner', { text: f.text.value.trim(), from: iso(f.from.value), until: iso(f.until.value), tone: f.tone.value });
      toast(f.from.value && new Date(f.from.value) > new Date() ? 'Notice scheduled' : 'Notice showing to everyone');
      refreshSysBanner(); S.refresh();
    } catch (ex) { err.textContent = errMsg(ex); } finally { btn.disabled = false; }
  });
}
actions['dv-banner-off'] = async () => {
  try { await put('/api/dev/banner', { text: '' }); toast('Notice taken down'); refreshSysBanner(); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
function backupPanel(b) {
  if (!b.found) return html`<section class="panel"><header><h2>Backups</h2></header><div class="body">${empty('No backups on this server', html`Staffwarden looks for them in <code>${b.dir}</code>. The install script sets up a nightly copy there.`)}</div></section>`;
  return html`<section class="panel flush"><header><h2>Backups</h2><span class="muted small">${b.dir}${b.offsite ? html` · off-site: ${b.offsite.ok ? 'last copy fine' : 'last copy failed'}, ${when(b.offsite.at)}` : ''}</span></header>
    <div class="body"><div class="tbl-wrap"><table class="t stack"><thead><tr><th>File</th><th>Made</th><th class="r">Size</th></tr></thead><tbody>
    ${b.files.slice(0, 7).map((f) => html`<tr><td><b>${f.file}</b></td><td>${when(f.at)}</td><td class="r num">${bytes(f.size)}</td></tr>`)}</tbody></table></div></div></section>`;
}

// ============================== Desktop apps ==============================
const KINDN = { windows: 'Windows', 'mac-arm': 'Mac (Apple chip)', 'mac-intel': 'Mac (Intel)' };
let upload = null;       // { files: [File], sums: [hex], progress, busy }
export const devApps = {
  title: 'Desktop apps',
  async load() {
    const [f, r] = await Promise.all([get('/api/dev/fleet'), get('/api/dev/releases')]);
    return { f, r };
  },
  render({ f, r }) {
    const withApp = f.people.filter((p) => p.version), cur = withApp.filter((p) => p.state === 'current'), old = withApp.filter((p) => p.state === 'old'), none = f.people.filter((p) => p.state === 'none');
    const cells = [
      { ic: 'check', label: 'On the latest', value: html`<span class="dv-dot good"></span>${cur.length} of ${withApp.length}`, foot: r.version ? `Staffwarden ${r.version}` : 'No installers on the server' },
      { ic: 'alert', label: 'Behind', value: html`${old.length ? html`<span class="dv-dot warn"></span>` : ''}${old.length}`, foot: old.length ? 'Their app offers the update' : 'Everyone is up to date', tone: old.length ? 'warn' : '' },
      { ic: 'laptop', label: 'No desktop app', value: String(none.length), foot: 'Signed in on the website only' },
      { ic: 'repeat', label: 'Versions kept', value: String(r.archive.length), foot: r.archive[0] ? `Can go back to ${r.archive[0].version}` : 'Nothing to go back to yet' },
    ];
    const rank = { old: 0, current: 1, none: 2 };
    const rows = [...f.people].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
    const table = html`<section class="panel flush"><header><h2>Everyone’s app</h2>${old.length ? html`<button class="btn" data-act="dv-remind">${icon('bell')} Remind everyone behind</button>` : ''}</header>
      <div class="body"><div class="tbl-wrap"><table class="t stack dv-fleet"><thead><tr><th>Person</th><th>Computer</th><th>Version</th><th>Last seen</th></tr></thead><tbody>
      ${rows.map((p) => html`<tr data-k="p${p.id}"><td class="nm"><span class="person">${av(p)}<span><b>${p.name}</b><span>${p.role === 'owner' ? 'Owner' : p.role === 'manager' ? 'Manager' : ''}</span></span></span></td>
        <td>${p.platform ? PLAT(p.platform) : html`<span class="muted">–</span>`}</td>
        <td>${p.version ? html`<b class="num">${p.version}</b> ${p.state === 'old' ? tag('pending', 'Behind') : tag('working', 'Latest')}` : tag('off', 'No desktop app')}</td>
        <td>${p.last_seen_at ? relTime(p.last_seen_at) : 'Never'}</td></tr>`)}</tbody></table></div></div></section>`;
    return html`${head('dev-apps', 'Desktop apps', 'Who is on which version, and new releases straight from your browser. No copying files to the server.')}${kpis(cells)}
      <div class="cols dv-cols">${table}${releasePanel(r)}</div>`;
  },
  after(view) { wireUpload(view); },
};
// "Mac (Apple chip) and Windows. Mac (Intel) stays on 0.9.21."
function kindsLine(cur, top) {
  const seen = new Set(), at = [], other = [];
  for (const d of cur) { if (seen.has(d.kind)) continue; seen.add(d.kind); (d.version === top ? at : other).push(d); }
  const list = (a) => a.map((d) => KINDN[d.kind]).join(a.length > 2 ? ', ' : ' and ').replace(/, ([^,]*)$/, ' and $1');
  return `${list(at)}${other.length ? `. ${other.map((d) => `${KINDN[d.kind]} stays on ${d.version}`).join(', ')}` : ''}`;
}
function releasePanel(r) {
  if (!r.can_publish) {
    return html`<section class="panel dv-rel"><header><h2>Releases</h2></header><div class="body">
      ${r.version ? html`<div class="dv-live"><div><b>Staffwarden ${r.version}</b>${tag('working', 'Live')}</div><p>${kindsLine(r.current, r.version)}. Out since ${when(r.current[0].updated_at)}. ${r.on_current ? `${plural(r.on_current, 'person', 'people')} here on it.` : 'No one here on it yet.'}</p></div>` : html`<div class="dv-live none"><b>No installers yet</b></div>`}
      <p class="small muted">Staffwarden publishes new versions of the desktop app for every company. Everyone’s app offers each one within the hour.</p></div></section>`;
  }
  const files = upload ? upload.files : [];
  const ver = files.length ? (/(\d+\.\d+\.\d+)/.exec(files[0].name) || [])[1] : null;
  const busy = upload && upload.busy;
  // with a release key in place, every installer needs its signature before it can go out
  const unsigned = r.signed && upload ? files.filter((f) => !upload.sigs[f.name]) : [];
  return html`<section class="panel dv-rel"><header><h2>Releases</h2></header><div class="body">
    ${r.version ? html`<div class="dv-live"><div><b>Staffwarden ${r.version}</b>${tag('working', 'Live')}</div>
      <p>${kindsLine(r.current, r.version)}. Out since ${when(r.current[0].updated_at)}. ${r.on_current ? `${plural(r.on_current, 'person', 'people')} on it.` : 'No one on it yet.'}</p>
      ${r.notes ? html`<p class="dv-notes">${r.notes}</p>` : ''}</div>` : html`<div class="dv-live none"><b>No installers yet</b><p>Upload the first version below.</p></div>`}
    <div class="dv-drop ${files.length ? 'has' : ''}" id="dropzone" tabindex="-1">
      ${files.length ? html`<ul class="dv-files">${files.map((fl, i) => { const pct = upload.progress ? upload.progress[i] : 0; return html`<li><span class="dv-fic">${icon('file')}</span><span><b>${fl.name}</b><span>${bytes(fl.size)}${upload.sums[i] ? ' · checked' : ' · checking…'}${r.signed ? (upload.sigs[fl.name] ? ' · signed' : ' · no .sig file') : ''}</span>${busy ? html`<span class="meter"><i style="width:${pct}%"></i></span>` : ''}</span>${busy ? '' : html`<button class="btn icon sm" type="button" data-act="dv-rmfile" data-i="${i}" aria-label="Remove ${fl.name}">${icon('x')}</button>`}</li>`; })}</ul>`
        : html`<span class="dv-up">${icon('upload')}</span><b>Drop the new installers here</b><p>The two Mac zips and the Windows setup, with the version in their names, and the .sig file tools/sign-release.js made for each. Apps only install releases signed with the release key.</p>`}
      <label class="btn ${busy ? 'disabled' : ''}"><input type="file" id="relfiles" multiple accept=".zip,.exe,.sig" hidden ${raw(busy ? 'disabled' : '')}>${files.length ? 'Choose different files' : 'Choose files'}</label>
    </div>
    <div class="field"><label class="f" for="rel-notes">What’s new</label><textarea id="rel-notes" rows="3" maxlength="1500" placeholder="One line per change, in plain words">${upload ? upload.notes || '' : ''}</textarea></div>
    <button class="btn primary dv-pub" type="button" data-act="dv-publish" ${raw(!files.length || busy || unsigned.length || (upload && upload.sums.some((s) => !s)) ? 'disabled' : '')}>${busy ? 'Uploading…' : ver ? `Publish ${ver}` : 'Publish'}</button>
    <p class="small muted">${unsigned.length ? `Add the .sig file for ${unsigned.length === 1 ? unsigned[0].name : `${unsigned.length} installers`}. Make it with tools/sign-release.js on your computer.` : `Everyone’s app offers it within the hour.${r.version ? ` You can go back to ${r.version} from here.` : ''}`}</p>
    ${r.archive.length ? html`<h3 class="dv-h3">Earlier versions</h3><ul class="dv-arch">${r.archive.map((a) => html`<li><span><b>${a.version}</b><span>${plural(a.files.length, 'installer')}, replaced ${when(a.at)}${a.on ? `, ${plural(a.on, 'person', 'people')} still on it` : ''}</span></span><button class="btn sm" data-act="dv-rollback" data-v="${a.version}">Go back to ${a.version}</button></li>`)}</ul>` : ''}
  </div></section>`;
}
async function sha256(file) {
  const h = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function pickFiles(list) {
  const all = [...list];
  const files = all.filter((f) => /\.(zip|exe)$/i.test(f.name)).slice(0, 6);
  if (!files.length) { toast('Choose the .zip and .exe installers, with their .sig files', true); return; }
  const sigs = {};
  for (const f of all.filter((x) => /\.(zip|exe)\.sig$/i.test(x.name) && x.size < 2000)) { try { sigs[f.name.replace(/\.sig$/i, '')] = (await f.text()).trim(); } catch { /* unreadable */ } }
  upload = { files, sigs, sums: files.map(() => null), progress: files.map(() => 0), busy: false, notes: document.getElementById('rel-notes') ? document.getElementById('rel-notes').value : '' };
  S.refresh();
  files.forEach(async (f, i) => { try { upload.sums[i] = await sha256(f); } catch { toast(`Couldn’t read ${f.name}`, true); } if (upload && upload.files === files) S.refresh(); });
}
function wireUpload(view) {
  const z = view.querySelector('#dropzone'), inp = view.querySelector('#relfiles'), notes = view.querySelector('#rel-notes');
  if (!z || z.dataset.wired) return;
  z.dataset.wired = '1';
  inp.addEventListener('change', () => { if (inp.files.length) pickFiles(inp.files); });
  notes.addEventListener('input', () => { if (upload) upload.notes = notes.value; });
  z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', (e) => { e.preventDefault(); z.classList.remove('over'); if (!(upload && upload.busy)) pickFiles(e.dataTransfer.files); });
}
actions['dv-rmfile'] = (b) => {
  const i = Number(b.dataset.i);
  upload.files.splice(i, 1); upload.sums.splice(i, 1); upload.progress.splice(i, 1);
  if (!upload.files.length) upload = null;
  S.refresh();
};
actions['dv-publish'] = async (btn) => {
  if (!upload || upload.busy) return;
  const notes = (document.getElementById('rel-notes') || {}).value || '';
  upload.notes = notes; upload.busy = true; S.refresh();
  try {
    const st = await post('/api/dev/releases/start', { files: upload.files.map((f, i) => ({ name: f.name, size: f.size, sha256: upload.sums[i] })) });
    for (let i = 0; i < upload.files.length; i++) {
      const f = upload.files[i];
      for (let off = 0; off < f.size; off += st.chunk) {
        const buf = new Uint8Array(await f.slice(off, off + st.chunk).arrayBuffer());
        let bin = ''; for (let k = 0; k < buf.length; k += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(k, k + 0x8000));
        await post(`/api/dev/releases/${st.id}/chunk`, { name: f.name, offset: off, data: btoa(bin) });
        upload.progress[i] = Math.round(((off + buf.length) / f.size) * 100);
        const bar = document.querySelectorAll('.dv-files .meter i')[i]; if (bar) bar.style.width = `${upload.progress[i]}%`;
      }
    }
    const out = await post(`/api/dev/releases/${st.id}/publish`, { notes, signatures: upload.sigs });
    upload = null;
    toast(`Staffwarden ${out.version} is live${out.previous ? `. ${out.previous} is kept for going back.` : ''}`);
  } catch (e) {
    if (upload) upload.busy = false;
    toast(errMsg(e), true);
  }
  S.refresh(); void btn;
};
actions['dv-rollback'] = async (b) => {
  const v = b.dataset.v;
  if (!(await confirmBox({ title: `Go back to ${v}?`, message: `The current installers are kept, so you can come forward again. Apps already updated stay on their version; anyone not yet updated gets ${v}.`, confirm: `Go back to ${v}` }))) return;
  try { await post('/api/dev/releases/rollback', { version: v }); toast(`${v} is live again`); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
actions['dv-remind'] = async () => {
  try { const r = await post('/api/dev/fleet/remind'); toast(r.reminded ? `Reminded ${plural(r.reminded, 'person', 'people')}` : 'Everyone is up to date'); } catch (e) { toast(errMsg(e), true); }
};

// ============================== Error reports ==============================
export const devErrors = {
  title: 'Error reports',
  async load(q) {
    const status = ['fixed', 'ignored'].includes(q.get('status')) ? q.get('status') : 'open';
    const e = await get(`/api/dev/errors?status=${status}`);
    return { e, status, sig: q.get('sig') };
  },
  render({ e, status, sig }) {
    const tabs = html`<nav class="seg-tabs dv-seg" aria-label="Show">${[['open', 'Open'], ['fixed', 'Fixed'], ['ignored', 'Ignored']].map(([v, n]) => html`<button type="button" data-act="q" ${raw(qAttr('status', v === 'open' ? '' : v))} aria-pressed="${String(status === v)}">${n}${e.counts[v] ? html` <i>${e.counts[v]}</i>` : ''}</button>`)}</nav>`;
    const g = e.groups.find((x) => x.sig === sig) || e.groups[0];
    const list = html`<section class="panel flush dv-elist"><div class="body pad">${tabs}</div>
      ${e.groups.length ? html`<ul>${e.groups.map((x) => html`<li><button type="button" data-act="q" ${raw(qAttr('sig', x.sig))} aria-current="${String(g && x.sig === g.sig)}"><span class="dv-e1"><b>${x.title}</b>${errTag(x)}</span><span class="dv-e2">${plural(x.count, 'time')}${x.people_count ? `, ${x.people_count === 1 ? x.people[0].name : plural(x.people_count, 'person', 'people')}` : ''} · ${relTime(x.last_at)}</span></button></li>`)}</ul>`
        : html`<div class="body">${empty(status === 'open' ? 'Nothing open' : status === 'fixed' ? 'Nothing marked fixed yet' : 'Nothing ignored', status === 'open' ? 'Errors from the apps, the website and the server appear here as they happen.' : '')}</div>`}</section>`;
    const detail = !g ? html`<section class="panel dv-edet">${empty('No error picked', '')}</section>` : html`<section class="panel dv-edet" data-k="${g.sig}"><div class="body">
      <div class="dv-eh"><div><h2>${g.title}</h2><p class="muted">${where(g)}. First seen ${when(g.first_at)}, last ${when(g.last_at)}.</p></div>
        <div class="dv-ea">${g.status === 'open' ? html`<button class="btn" data-act="dv-err" data-s="ignored" data-sig="${g.sig}">Ignore</button><button class="btn primary" data-act="dv-err" data-s="fixed" data-sig="${g.sig}">${icon('check')} Mark fixed</button>` : html`<button class="btn" data-act="dv-err" data-s="open" data-sig="${g.sig}">Open again</button>`}</div></div>
      <div class="dv-stats"><div><span>Happened</span><b>${plural(g.count, 'time')}</b></div>
        <div><span>People</span>${g.people_count ? html`<span class="dv-avs">${g.people.slice(0, 6).map((p) => av(p))}${g.people_count > 6 ? html`<i>+${g.people_count - 6}</i>` : ''}</span>` : html`<b>None signed in</b>`}</div>
        <div><span>Where</span><b>${SRC[g.source] || g.source}</b></div></div>
      ${g.people_count ? html`<p class="small muted dv-names">${g.people.map((p) => p.name).join(', ')}${g.people_count > g.people.length ? ` and ${g.people_count - g.people.length} more` : ''}</p>` : ''}
      <span class="f">What was reported</span>
      <pre class="dv-pre">${g.detail || g.title}</pre>
      <p class="small muted">Reports never include screenshots, window titles or anything typed. Only what went wrong and where in the code.</p>
    </div></section>`;
    return html`${head('dev-errors', 'Error reports', 'What went wrong in the desktop apps, on the website and on the server, grouped, newest first.')}
      <div class="dv-ecols">${list}${detail}</div>`;
  },
};
actions['dv-err'] = async (b) => {
  const s = b.dataset.s, sig = b.dataset.sig;
  let fixed_in = null;
  if (s === 'fixed') {
    const ok = await new Promise((resolve) => {
      openModal({ title: 'Mark it fixed', submit: 'Mark fixed', body: html`<div class="field"><label class="f" for="fx-v">Fixed in <span class="muted">(optional)</span></label><input id="fx-v" name="v" maxlength="20" placeholder="0.9.22 or web33"><p class="small muted">If it happens again, it opens again by itself.</p></div>`,
        onSubmit: (fd) => { fixed_in = String(fd.get('v') || '').trim() || null; resolve(true); } });
      setTimeout(() => { const sc = document.querySelector('.scrim:last-child'); if (sc) sc.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === sc) resolve(false); }); }, 0);
    });
    if (!ok) return;
  }
  try { await patch(`/api/dev/errors/${sig}`, { status: s, fixed_in }); toast(s === 'fixed' ? 'Marked fixed' : s === 'ignored' ? 'Ignored' : 'Open again'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};

// ============================== Switches and tools ==============================
export const devTools = {
  title: 'Switches and tools',
  async load() {
    const [features, timers, fleet, targets] = await Promise.all([get('/api/dev/features'), get('/api/dev/timers'), get('/api/dev/fleet'), get('/api/dev/test-targets')]);
    return { features, timers, people: fleet.people, targets };
  },
  after(view) {
    // remember the picks, so a refresh of the page never resets them
    for (const id of ['tn-to', 'tn-dev', 'tn-kind', 'tc-to']) {
      const el = view.querySelector(`#${id}`);
      if (el && !el.dataset.wired) { el.dataset.wired = '1'; el.addEventListener('change', () => { tsel[id] = el.value; const rid = id === 'tc-to' ? 'tc-res' : 'tn-res'; delete tres[rid]; const r = view.querySelector(`#${rid}`); if (r) r.textContent = ''; }); }
    }
  },
  render({ features, timers, targets }) {
    const rows = features.map((f) => html`<li data-k="${f.key}"><div class="dv-fn"><b>${f.name}</b><span>${f.desc}</span></div>
      <div class="dv-fc"><div class="dv-mode" role="radiogroup" aria-label="${f.name}">${[['off', 'Off'], ['beta', 'A few people'], ['everyone', 'Everyone']].map(([m, n]) => html`<button type="button" role="radio" aria-checked="${String(f.mode === m)}" data-act="dv-mode" data-key="${f.key}" data-m="${m}">${n}</button>`)}</div>
      ${f.mode === 'beta' ? html`<span class="dv-avs">${f.beta.slice(0, 4).map((p) => av(p))}${f.beta.length > 4 ? html`<i>+${f.beta.length - 4}</i>` : ''}</span><button class="btn sm" data-act="dv-beta" data-key="${f.key}">${f.beta.length ? 'Change' : 'Choose people'}</button>` : ''}</div></li>`);
    const card = (ic, title, text, controls, cls = '') => html`<div class="dv-tool ${cls}"><span class="dv-tic">${icon(ic)}</span><b>${title}</b><p>${text}</p><div class="dv-tc">${controls}</div></div>`;
    const sel = (id, v) => raw((tsel[id] || '') === String(v) ? 'selected' : '');
    const opts = (list, id) => list.map(([v, n]) => html`<option value="${v}" ${sel(id, v)}>${n}</option>`);
    const reach = (t) => { const a = []; if (t.phones) a.push(t.phones === 1 ? 'phone' : `${t.phones} phones`); if (t.browsers) a.push(t.browsers === 1 ? 'browser' : `${t.browsers} browsers`); if (t.desktop) a.push(`app ${t.desktop_version}`); return a.length ? a.join(', ') : 'no devices'; };
    const who = (list, id) => list.sort((a, b) => (b.me - a.me)).map((t) => html`<option value="${t.me ? 'me' : t.id}" ${sel(id, t.me ? 'me' : t.id)}>${t.me ? 'Me' : t.name} (${reach(t)})</option>`);
    const field = (label, id, inner) => html`<label class="dv-fl" for="${id}"><span>${label}</span><select id="${id}">${inner}</select></label>`;
    const tools = html`<section class="panel dv-tools"><header><h2>Test tools</h2></header><div class="body"><div class="dv-tgrid">
      ${card('bell', 'Send a test notification', 'To you or to one person, on all their devices or just one. It says it’s a test, and who sent it.', html`<div class="dv-tf">
        ${field('To', 'tn-to', who(targets, 'tn-to'))}
        ${field('Where', 'tn-dev', opts([['all', 'All their devices'], ['phone', 'Phone'], ['browser', 'Browser'], ['desktop', 'Desktop app']], 'tn-dev'))}
        ${field('What', 'tn-kind', opts([['message', 'A chat message'], ['boost', 'A boost'], ['checkin', 'A check-in reminder'], ['urgent', 'An urgent notice']], 'tn-kind'))}
        <button class="btn" data-act="dv-notify">${icon('bell')} Send</button></div><p class="dv-res${tres["tn-res"] && tres["tn-res"].bad ? ' bad' : ''}" id="tn-res" role="status">${tres["tn-res"] ? tres["tn-res"].text : ''}</p>`, 'wide')}
      ${card('rocket', 'Test the boost clip', 'Play it on this screen, or send a test clip to someone’s desktop app (their timer has to be on). It isn’t posted in the chat and doesn’t count towards their three a shift.', html`<div class="dv-tf">
        ${field('To', 'tc-to', who(targets, 'tc-to'))}
        <button class="btn" data-act="dv-clip-app">${icon('rocket')} Send</button><button class="btn" data-act="dv-clip">Play here</button></div><p class="dv-res${tres["tc-res"] && tres["tc-res"].bad ? ' bad' : ''}" id="tc-res" role="status">${tres["tc-res"] ? tres["tc-res"].text : ''}</p>`, 'wide')}
      ${card('timer', 'Fix a stuck timer', 'Closes it at the last sign of life from their computer. They’re told, and it’s in the audit log.', timers.length ? html`<select id="tm-pick" aria-label="Running timer">${timers.map((t) => html`<option value="${t.entry_id}">${t.name}, ${t.silent_min >= 10 ? `silent ${t.silent_min} min` : `since ${t12(t.started_at)}`}</option>`)}</select><button class="btn" data-act="dv-close-timer">Close it</button>` : html`<span class="muted small dv-none">No timers running right now.</span>`)}
      ${card('alert', 'Check error reports', 'Sends a test error from this browser, so you can see a report arrive.', html`<button class="btn" data-act="dv-test-err">Send a test error</button>`)}
    </div></div></section>`;
    return html`${head('dev-tools', 'Switches and tools', 'Try features with a few people first, switch them off at once if they misbehave, and test safely.')}
      <section class="panel flush dv-feat"><header><div><h2>Feature switches</h2><p class="muted small">Off hides it for everyone. A few people: only those you choose get it.</p></div></header><ul>${rows}</ul></section>${tools}`;
  },
};
actions['dv-mode'] = async (b) => {
  const key = b.dataset.key, mode = b.dataset.m;
  if (b.getAttribute('aria-checked') === 'true') return;
  if (mode === 'beta') return pickBeta(key, true);
  try { await put(`/api/dev/features/${key}`, { mode }); toast(mode === 'off' ? 'Switched off for everyone' : 'On for everyone'); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
actions['dv-beta'] = (b) => pickBeta(b.dataset.key, false);
async function pickBeta(key, switching) {
  let features, fleet;
  try { [features, fleet] = await Promise.all([get('/api/dev/features'), get('/api/dev/fleet')]); } catch (e) { toast(errMsg(e), true); return; }
  const f = features.find((x) => x.key === key), chosen = new Set(f.beta.map((p) => p.id));
  if (!chosen.size) chosen.add(S.me.id);
  openModal({ title: `${f.name}: who gets it`, sub: 'Only these people get it while it’s being tried. Everyone else doesn’t see it.', submit: switching ? 'Turn on for them' : 'Save',
    body: html`<div class="dv-pick">${fleet.people.map((p) => html`<label class="check"><input type="checkbox" name="p" value="${p.id}" ${raw(chosen.has(p.id) ? 'checked' : '')}><span class="person">${av(p)}<b>${p.name}</b></span></label>`)}</div>`,
    onSubmit: async (fd) => {
      const ids = fd.getAll('p').map(Number);
      if (!ids.length) throw new Error('Choose at least one person');
      await put(`/api/dev/features/${key}`, { mode: 'beta', beta: ids });
      toast(`On for ${plural(ids.length, 'person', 'people')}`); S.refresh();
    } });
}
const tsel = {};
const pick = (id) => (document.getElementById(id) || {}).value;
const tres = {};
const say = (id, text, bad = false) => { tres[id] = { text, bad }; const r = document.getElementById(id); if (r) { r.textContent = text; r.classList.toggle('bad', bad); } };
actions['dv-notify'] = async (b) => {
  b.disabled = true;
  try {
    const r = await post('/api/dev/test-notify', { kind: pick('tn-kind') || 'message', user_id: pick('tn-to') || 'me', device: pick('tn-dev') || 'all' });
    const who = r.mine ? 'you' : r.to;
    say('tn-res', r.reached.length ? `Sent to ${who}: ${r.reached.join(', ')}. It’s in the bell too.` : `In ${who === 'you' ? 'your' : `${who}’s`} bell. No ${r.device === 'all' ? 'phone, browser or desktop app' : r.device === 'desktop' ? 'desktop app' : r.device} is set up to get pushes, so nothing popped up.`, !r.reached.length);
  } catch (e) { say('tn-res', errMsg(e), true); } finally { b.disabled = false; }
};
actions['dv-clip'] = async (b) => { b.disabled = true; try { await boostClipPreview('Last hour. Let’s finish strong!'); } finally { b.disabled = false; } };
actions['dv-clip-app'] = async (b) => {
  b.disabled = true;
  try { const r = await post('/api/dev/test-clip', { user_id: pick('tc-to') || 'me' }); say('tc-res', r.sent ? r.text : `Not sent: ${r.text}`, !r.sent); } catch (e) { say('tc-res', errMsg(e), true); } finally { b.disabled = false; }
};
actions['dv-close-timer'] = async () => {
  const sel = document.getElementById('tm-pick'); if (!sel) return;
  const name = sel.options[sel.selectedIndex].text.split(',')[0];
  if (!(await confirmBox({ title: `Close ${name}’s timer?`, message: 'It’s closed at the last sign of life from their computer, the same as the server does by itself after a long silence. They’re told who closed it.', confirm: 'Close it' }))) return;
  try { const r = await post(`/api/dev/timers/${sel.value}/close`); toast(`Closed at ${t12(r.closed_at)}`); S.refresh(); } catch (e) { toast(errMsg(e), true); }
};
actions['dv-test-err'] = async () => {
  try { await post('/api/errors', { message: 'Test error from the developer tools', stack: `Error: Test error from the developer tools\n    at testButton (dev.js)\n    sent by ${S.me.name}` }); toast('Sent. It’s in Error reports now.'); } catch (e) { toast(errMsg(e), true); }
};

// ============================== the notice at the top, for everyone ==============================
let banTimer = null;
export async function refreshSysBanner() {
  const main = document.getElementById('main');
  if (!main || !S.me) return;
  let b = null;
  try { b = (await get('/api/banner')).banner; } catch { return; }
  let el = document.getElementById('sysban');
  let gone = null; try { gone = localStorage.getItem('wh-ban-ok'); } catch { /* private window */ }
  if (!b || gone === b.id) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'sysban'; el.setAttribute('role', 'status'); main.prepend(el); }
  el.className = `sysban ${b.tone}`;
  el.innerHTML = `${icon(b.tone === 'warn' ? 'clock' : 'mega')}<b>${esc(b.text)}</b><button type="button" class="sysban-ok">Got it</button>`;
  el.querySelector('.sysban-ok').addEventListener('click', () => { try { localStorage.setItem('wh-ban-ok', b.id); } catch { /* ok */ } el.remove(); });
  clearTimeout(banTimer);
  if (b.until) banTimer = setTimeout(refreshSysBanner, Math.max(1000, Date.parse(b.until) - Date.now() + 500));
}
