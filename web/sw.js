// Staffwarden's service worker: shows phone and browser notifications, and opens the right page when one
// is tapped. It caches nothing, so the website and the portal are always the newest version.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data ? e.data.text() : 'Staffwarden' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Staffwarden', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', data: { link: d.link || '#/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || '#/';
  const url = new URL(`/${link.startsWith('#') ? link : `#${link}`}`, self.location.origin).toString();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) { await c.focus(); try { await c.navigate(url); } catch { c.postMessage({ type: 'open', link }); } return; }
    }
    await self.clients.openWindow(url);
  })());
});

// pages ask the worker nothing; a fetch handler is not needed and none is installed, so every request
// goes straight to the server as before
