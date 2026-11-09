import { setSkew, browserZone } from './util.js';
// this computer's time zone, offered to managers as a suggestion for the person's zone
const ZONE = browserZone();
// Talking to the server: JSON calls, the live event stream, and authenticated images.
let token = null;
try { token = localStorage.getItem('at_token'); } catch { /* storage blocked */ }
export const getToken = () => token;
export function setToken(t) {
  // a different sign-in (or none) never inherits what the last one left waiting to send
  if (t !== token) { try { for (const k of Object.keys(localStorage)) if (k.startsWith('wh-outbox-')) localStorage.removeItem(k); } catch { /* storage blocked */ } }
  token = t;
  try { if (t) localStorage.setItem('at_token', t); else localStorage.removeItem('at_token'); } catch { /* storage blocked */ }
}

let onUnauthorized = () => {};
// "See it as the client": the team's own sign-in, reading the portal as one client person would
let viewAs = null;
export const setViewAs = (id) => { viewAs = id ? String(id) : null; };
export const getViewAs = () => viewAs;
const auth = () => ({ ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(viewAs ? { 'X-Workhelm-View-As': viewAs } : {}) });

// The server says which version of the website it serves. When that changes while this page is open
// (an update was put live), the page offers a refresh, once.
let firstBuild = null, buildHandler = null, buildAnnounced = false;
export const setNewBuildHandler = (fn) => { buildHandler = fn; };
function noteBuild(b) {
  if (!b) return;
  if (!firstBuild) { firstBuild = b; return; }
  if (b !== firstBuild && !buildAnnounced && buildHandler) { buildAnnounced = true; buildHandler(); }
}
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Every request gives up after a while, so one answer lost on a bad connection never freezes the page
// (live updates and refreshes wait for the current load to finish). Reads are tried once more.
const TIMEOUT_MS = 20000;
export async function api(method, path, body, { tries = method === 'GET' ? 2 : 1 } = {}) {
  let res;
  for (let attempt = 1; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      res = await fetch(path, {
        method,
        headers: { ...auth(), ...(token && ZONE ? { 'X-Workhelm-Tz': ZONE } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: ctl.signal,
      });
      break;
    } catch {
      if (attempt < tries) continue;
      throw new ApiError(0, ctl.signal.aborted ? 'The server took too long to answer. Try again in a moment.' : 'Cannot reach the server. Check your connection.');
    } finally { clearTimeout(timer); }
  }
  const st = res.headers.get('x-server-time');
  if (st) setSkew(Date.parse(st) - Date.now());
  noteBuild(res.headers.get('x-workhelm-build'));
  if (res.status === 401 && path !== '/api/auth/login') { onUnauthorized(); throw new ApiError(401, 'Please sign in again'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : null;
  if (!res.ok) { const e = new ApiError(res.status, (data && data.error) || `Something went wrong (${res.status})`); e.data = data; throw e; }
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const put = (p, b) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);
export const qs = (o) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v != null && v !== '') u.set(k, v); const s = u.toString(); return s ? `?${s}` : ''; };

// CSV and other downloads need the auth header, so fetch the bytes and hand the browser a blob.
export async function download(path, filename) {
  const res = await fetch(path, { headers: auth(), cache: 'no-store' });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new ApiError(res.status, d.error || 'Download failed'); }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// a file behind sign-in (a receipt, a document), as a URL the page can show or open
export async function fileUrl(path) {
  const res = await fetch(path, { headers: auth(), cache: 'no-store' });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new ApiError(res.status, d.error || 'Could not open the file'); }
  // only kinds that can't hold a page open as themselves; anything else (HTML, SVG, scripts) is plain bytes
  const b = await res.blob();
  const safe = /^(image\/(png|jpeg|webp|gif)|application\/pdf|audio\/|video\/|text\/plain|text\/csv)/i.test(b.type || '');
  const u = URL.createObjectURL(safe ? b : new Blob([b], { type: 'application/octet-stream' }));
  blobShows.set(u, safe);
  return u;
}
// whether a file from fileUrl() can be opened in a tab (true) or should be saved (false)
export const blobShows = new Map();
// a file behind sign-in, as bytes (a PDF to draw a preview of)
export async function fileBytes(path) {
  const res = await fetch(path, { headers: auth(), cache: 'no-store' });
  if (!res.ok) throw new ApiError(res.status, 'Could not open the file');
  return res.arrayBuffer();
}
// a picked file, as base64 for an upload
export const fileBase64 = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = () => reject(new Error('Could not read the file')); r.readAsDataURL(file); });

// ---- images need the auth header, so they are fetched and cached as blob URLs
const thumbs = new Map();   // id -> blob URL (small, kept for the session)
const fulls = new Map();    // id -> blob URL (LRU)
const inflight = new Map();
async function fetchBlob(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status, 'Image unavailable');
  return URL.createObjectURL(await res.blob());
}
// Thumbnails asked for close together are fetched together (up to 30 in one request, three requests at
// a time): over a far-away connection each request costs a round trip, so one per image was slow.
const thumbWait = new Map();   // id -> [resolve, reject][]
let thumbTimer = null, thumbBusy = 0, batchOk = true;
function queueThumb(id) {
  return new Promise((resolve, reject) => {
    if (!thumbWait.has(id)) thumbWait.set(id, []);
    thumbWait.get(id).push([resolve, reject]);
    if (!thumbTimer) thumbTimer = setTimeout(flushThumbs, 12);
  });
}
async function flushThumbs() {
  thumbTimer = null;
  while (thumbWait.size && thumbBusy < 3) {
    const ids = [...thumbWait.keys()].slice(0, 30);
    const waiting = ids.map((id) => [id, thumbWait.get(id)]);
    ids.forEach((id) => thumbWait.delete(id));
    thumbBusy++;
    fetchThumbs(ids).then((got) => {
      for (const [id, ws] of waiting) {
        const u = got.get(id);
        if (u) { thumbs.set(id, u); ws.forEach(([ok]) => ok(u)); }
        else fetchBlob(`/api/screenshots/${id}/thumb`).then((x) => { thumbs.set(id, x); ws.forEach(([ok]) => ok(x)); }, (e) => ws.forEach(([, no]) => no(e)));
      }
    }).finally(() => { thumbBusy--; if (thumbWait.size) flushThumbs(); });
  }
}
async function fetchThumbs(ids) {
  const out = new Map();
  if (!batchOk || ids.length < 2) return out;   // one image: the single request is just as quick
  try {
    const res = await fetch(`/api/screenshots/thumbs?ids=${ids.join(',')}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404 || res.status === 400) { batchOk = res.status !== 404; return out; }   // an older server
    if (!res.ok) return out;
    const buf = await res.arrayBuffer();
    const n = new DataView(buf).getUint32(0);
    const index = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
    const base = 4 + n;
    for (const it of index) out.set(it.id, URL.createObjectURL(new Blob([new Uint8Array(buf, base + it.offset, it.length)], { type: it.type })));
  } catch { /* each falls back to its own request */ }
  return out;
}
export function shotUrl(id, kind = 'thumb') {
  const cache = kind === 'thumb' ? thumbs : fulls;
  if (cache.has(id)) { const v = cache.get(id); if (kind === 'full') { cache.delete(id); cache.set(id, v); } return Promise.resolve(v); }
  const key = `${kind}:${id}`;
  if (!inflight.has(key)) {
    inflight.set(key, (kind === 'thumb' ? queueThumb(id) : fetchBlob(`/api/screenshots/${id}/image`)).then((u) => {
      cache.set(id, u);
      if (kind === 'full' && fulls.size > 12) { const old = fulls.keys().next().value; URL.revokeObjectURL(fulls.get(old)); fulls.delete(old); }
      return u;
    }).finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}
export const cachedThumb = (id) => thumbs.get(id) || null;
export function forgetShot(id) {
  for (const c of [thumbs, fulls]) if (c.has(id)) { URL.revokeObjectURL(c.get(id)); c.delete(id); }
}
export function clearImages() { for (const c of [thumbs, fulls]) { for (const u of c.values()) URL.revokeObjectURL(u); c.clear(); } }

// ---- live events (Server-Sent Events over fetch so the auth header can be sent)
// when the live connection last delivered anything; pages poll as a fallback when it goes quiet
let lastLive = 0;
export const liveFresh = () => Date.now() - lastLive < 35000;
export function startLive({ onEvent, onState }) {
  let stop = false, ctl = null, delay = 1000, watchdog = null;
  const decoder = new TextDecoder();
  async function run() {
    while (!stop) {
      ctl = new AbortController();
      try {
        const res = await fetch('/api/events', { headers: { ...auth(), Accept: 'text/event-stream' }, signal: ctl.signal, cache: 'no-store' });
        if (res.status === 401) { onUnauthorized(); return; }
        if (!res.ok || !res.body) throw new Error('no stream');
        onState('live'); delay = 1000;
        const kick = () => { clearTimeout(watchdog); watchdog = setTimeout(() => ctl.abort(), 40000); };
        kick();
        const reader = res.body.getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          kick();
          buf += decoder.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data:')) { try { const ev = JSON.parse(line.slice(5)); lastLive = Date.now(); if (ev.type !== 'ping') onEvent(ev); } catch { /* ignore */ } }
            }
          }
        }
      } catch { /* fall through to retry */ }
      clearTimeout(watchdog);
      if (stop) return;
      onState('down');
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  }
  run();
  return () => { stop = true; clearTimeout(watchdog); if (ctl) ctl.abort(); };
}
