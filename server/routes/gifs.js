'use strict';
const https = require('node:https');
const { need } = require('../lib/http');

// GIFs in chat, searched on GIPHY or Tenor. The owner pastes a free API key from either one in
// Settings; a Tenor key is a Google key (it starts with "AIza"), anything else is taken as GIPHY.
// The page's rules only allow pictures from Staffwarden itself, so the GIFs come through here: only from
// those two services' own picture hosts, never anywhere else. A picked GIF is sent like any other
// picture, so it is kept with the chat and still shows long after.
const MEDIA_HOSTS = /^(media\d*\.giphy\.com|i\.giphy\.com|media\d*\.tenor\.com|c\.tenor\.com)$/;
const MAX_GIF = 5 * 1024 * 1024;

module.exports = (ctx) => {
  const { db, route, audit } = ctx;
  const C = { client: true };
  const keyOf = () => (db.prepare("SELECT value FROM settings WHERE key = 'gif_key'").get() || {}).value || '';
  const providerOf = (key) => (!key ? null : key.startsWith('AIza') ? 'tenor' : 'giphy');

  // a GET to a fixed https host; tests pass their own (opts.gifFetch)
  function get(url, { json = true, max = MAX_GIF } = {}) {
    if (ctx.gifFetch) return ctx.gifFetch(url);
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 6000, headers: { 'User-Agent': 'Staffwarden/1.0', Accept: json ? 'application/json' : 'image/*' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(Object.assign(new Error(`status ${res.statusCode}`), { status: res.statusCode })); return; }
        let size = 0; const chunks = [];
        res.on('data', (c) => { size += c.length; if (size > max) { req.destroy(new Error('too big')); return; } chunks.push(c); });
        res.on('end', () => { const buf = Buffer.concat(chunks); if (!json) { resolve({ buf, type: String(res.headers['content-type'] || '').split(';')[0] }); return; } try { resolve(JSON.parse(buf.toString('utf8'))); } catch (e) { reject(e); } });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }
  const proxied = (u) => `/api/chat/gifs/img?u=${encodeURIComponent(u)}`;
  const okMedia = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && MEDIA_HOSTS.test(x.hostname) && !x.port; } catch { return false; } };

  function fromGiphy(j) {
    return (j.data || []).map((g) => {
      const im = g.images || {};
      const pv = im.fixed_width_downsampled || im.fixed_width || im.preview_gif || {}, full = im.downsized || im.fixed_width || {};
      return { id: `g${g.id}`, title: g.title || 'GIF', preview: pv.url, full: full.url, w: Number(pv.width) || 200, h: Number(pv.height) || 150 };
    });
  }
  function fromTenor(j) {
    return (j.results || []).map((g) => {
      const f = g.media_formats || {}, pv = f.tinygif || f.nanogif || {}, full = f.mediumgif || f.gif || pv;
      const [w, h] = Array.isArray(pv.dims) ? pv.dims : [200, 150];
      return { id: `t${g.id}`, title: g.content_description || 'GIF', preview: pv.url, full: full.url, w, h };
    });
  }

  // search (or what's popular when there is nothing typed)
  route('GET', '/api/chat/gifs', async ({ query, user }) => {
    const key = keyOf(), provider = providerOf(key);
    if (!provider || (ctx.featureOn && user && user.kind !== 'client' && !ctx.featureOn('gifs', user.id))) return { enabled: false, items: [] };
    const q = String(query.get('q') || '').trim().slice(0, 60);
    const url = provider === 'giphy'
      ? `https://api.giphy.com/v1/gifs/${q ? 'search' : 'trending'}?api_key=${encodeURIComponent(key)}&limit=24&rating=pg-13${q ? `&q=${encodeURIComponent(q)}` : ''}`
      : `https://tenor.googleapis.com/v2/${q ? 'search' : 'featured'}?key=${encodeURIComponent(key)}&client_key=workhelm&limit=24&contentfilter=medium&media_filter=tinygif,mediumgif,gif${q ? `&q=${encodeURIComponent(q)}` : ''}`;
    let items;
    try { items = (provider === 'giphy' ? fromGiphy : fromTenor)(await get(url)); }
    catch (e) { need(false, 502, e && (e.status === 401 || e.status === 403) ? 'The GIF key was not accepted. The owner can check it in Settings.' : 'GIF search isn’t answering right now. Try again in a moment.'); }
    items = items.filter((g) => okMedia(g.preview) && okMedia(g.full)).map((g) => ({ ...g, preview: proxied(g.preview), full: proxied(g.full) }));
    return { enabled: true, provider, items, credit: provider === 'giphy' ? 'Powered by GIPHY' : 'Search Tenor' };
  }, C);

  // the pictures themselves, kept for a while so scrolling the picker stays quick
  const cache = new Map();
  route('GET', '/api/chat/gifs/img', async ({ query }) => {
    const u = String(query.get('u') || '');
    need(okMedia(u), 400, 'Not a GIF from GIPHY or Tenor');
    let hit = cache.get(u);
    if (!hit) {
      let r;
      try { r = await get(u, { json: false }); } catch { need(false, 502, 'That GIF didn’t load'); }
      need(/^image\/(gif|webp)$/.test(r.type) && r.buf.length > 0, 502, 'That GIF didn’t load');
      hit = { raw: r.buf, type: r.type };
      cache.set(u, hit);
      let total = 0; for (const v of cache.values()) total += v.raw.length;
      while (total > 40 * 1024 * 1024 && cache.size > 1) { const k = cache.keys().next().value; total -= cache.get(k).raw.length; cache.delete(k); }
    }
    return { raw: hit.raw, type: hit.type, headers: { 'Cache-Control': 'private, max-age=86400' } };
  }, C);

  // the owner's key: which service, and whether one is set (the key itself is never sent back)
  route('GET', '/api/chat/gifs/setup', ({ user }) => {
    need(user.role === 'owner', 403, 'Only the owner can do this');
    const key = keyOf();
    return { provider: providerOf(key), has_key: !!key, hint: key ? `…${key.slice(-4)}` : null };
  });
  route('PUT', '/api/chat/gifs/setup', ({ user, body }) => {
    need(user.role === 'owner', 403, 'Only the owner can do this');
    const key = String(body.key || '').trim();
    need(!key || /^[\w-]{20,80}$/.test(key), 400, 'That doesn’t look like a GIPHY or Tenor key');
    if (key) db.prepare("INSERT INTO settings (key, value) VALUES ('gif_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key);
    else db.prepare("DELETE FROM settings WHERE key = 'gif_key'").run();
    audit(user, key ? 'gifs.key_set' : 'gifs.key_removed', null, key ? providerOf(key) : '');
    return { provider: providerOf(key), has_key: !!key, hint: key ? `…${key.slice(-4)}` : null };
  });
};
