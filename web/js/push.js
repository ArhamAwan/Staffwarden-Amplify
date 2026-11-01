// Phone notifications and "add to home screen", shared by the portal and the team's website.
// The service worker (/sw.js) only shows notifications and opens the right page when one is tapped;
// it never caches the app, so nobody is ever stuck on an old copy.
import { get, post } from './api.js';

let reg = null, installEvt = null;
const listeners = new Set();
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; listeners.forEach((f) => f()); });
window.addEventListener('appinstalled', () => { installEvt = null; listeners.forEach((f) => f()); });
export const onInstallChange = (f) => { listeners.add(f); return () => listeners.delete(f); };

export async function registerSW() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try { reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { reg = null; }
  return reg;
}
export const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isPhone = () => window.matchMedia('(max-width: 760px)').matches || /android|iphone|ipod/i.test(navigator.userAgent);
// 'prompt': the browser can install it in a tap; 'ios': Safari, done from the Share menu; 'installed'; 'no'
export function installMode() {
  if (standalone()) return 'installed';
  if (installEvt) return 'prompt';
  if (isIOS()) return 'ios';
  return 'no';
}
export async function install() {
  if (!installEvt) return false;
  installEvt.prompt();
  const r = await installEvt.userChoice.catch(() => ({ outcome: 'dismissed' }));
  installEvt = null; listeners.forEach((f) => f());
  return r.outcome === 'accepted';
}

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined' && window.isSecureContext;
// 'unsupported' (iPhone outside the home-screen app, older browsers), 'denied', 'off' or 'on'
export async function pushState() {
  if (!supported()) return isIOS() && !standalone() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const r = reg || await navigator.serviceWorker.getRegistration('/').catch(() => null);
  if (!r) return 'off';
  const sub = await r.pushManager.getSubscription().catch(() => null);
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}
const keyBytes = (b64) => { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
export async function enablePush() {
  if (!supported()) throw new Error(isIOS() ? 'On an iPhone, add the portal to your home screen first, then turn this on from there.' : 'This browser can’t show notifications.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in the browser’s settings.');
  const r = reg || await registerSW();
  if (!r) throw new Error('Couldn’t set up notifications on this device.');
  await navigator.serviceWorker.ready;
  const { key } = await get('/api/push/key');
  let sub = await r.pushManager.getSubscription();
  if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  const j = sub.toJSON();
  await post('/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys, device: deviceName() });
  return true;
}
export async function disablePush() {
  const r = reg || await navigator.serviceWorker.getRegistration('/').catch(() => null);
  const sub = r && await r.pushManager.getSubscription().catch(() => null);
  if (sub) { try { await post('/api/push/unsubscribe', { endpoint: sub.endpoint }); } catch { /* gone */ } await sub.unsubscribe().catch(() => {}); }
}
function deviceName() {
  const u = navigator.userAgent;
  const os = /iphone/i.test(u) ? 'iPhone' : /ipad/i.test(u) ? 'iPad' : /android/i.test(u) ? 'Android' : /mac/i.test(u) ? 'Mac' : /windows/i.test(u) ? 'Windows' : 'Computer';
  const br = /edg\//i.test(u) ? 'Edge' : /chrome|crios/i.test(u) ? 'Chrome' : /firefox|fxios/i.test(u) ? 'Firefox' : /safari/i.test(u) ? 'Safari' : 'Browser';
  return `${os} · ${br}`;
}
