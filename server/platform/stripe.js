'use strict';
// A small Stripe client: the handful of calls billing needs, over Stripe's REST API, and the check that a
// webhook really came from Stripe. Card numbers never touch this server: people type them on Stripe's own
// pages (Checkout, the billing portal).
const crypto = require('node:crypto');

// Stripe's form encoding: { a: { b: 1 }, items: [{ price: 'x' }] } -> a[b]=1&items[0][price]=x
function encode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

function createStripe({ secretKey, webhookSecret, fetchImpl = fetch, now = Date.now }) {
  const ready = !!secretKey;
  async function call(method, path, params = null, idem = null) {
    if (!ready) { const e = new Error('Payments aren’t set up on this server yet'); e.status = 503; throw e; }
    const qs = method === 'GET' && params ? `?${encode(params)}` : '';
    const res = await fetchImpl(`https://api.stripe.com/v1${path}${qs}`, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20', ...(idem ? { 'Idempotency-Key': idem } : {}) },
      body: method === 'GET' || !params ? undefined : encode(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error((data.error && data.error.message) || `Stripe said ${res.status}`); e.status = res.status >= 500 ? 502 : 400; e.stripe = data.error || null; throw e; }
    return data;
  }
  // Stripe signs each webhook: "t=<time>,v1=<hmac of `${t}.${body}`>". Older than 5 minutes is refused.
  function verify(rawBody, header) {
    if (!webhookSecret) return false;
    const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2));
    const t = Number(parts.t);
    if (!t || Math.abs(now() / 1000 - t) > 300) return false;
    const want = crypto.createHmac('sha256', webhookSecret).update(`${t}.${rawBody}`).digest('hex');
    const sigs = String(header).split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
    return sigs.some((s) => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
  }
  return { ready, call, verify, encode };
}

module.exports = { createStripe, encode };
