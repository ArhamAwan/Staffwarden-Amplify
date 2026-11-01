// Workhelm through Cloudflare, without a domain: paste this into a Cloudflare Worker (free workers.dev
// address). People connect to Cloudflare's nearby network; the Worker fetches from the Workhelm server
// over HTTPS. Set two things in the Worker's Settings -> Variables and Secrets:
//   ORIGIN        (text)    the address printed by deploy/cloudflare.sh, e.g. https://185-205-244-24.sslip.io
//   PROXY_SECRET  (secret)  the secret printed by deploy/cloudflare.sh
export default {
  async fetch(request, env) {
    if (!env.ORIGIN || !env.PROXY_SECRET) return new Response('Workhelm proxy is not set up yet (ORIGIN and PROXY_SECRET).', { status: 500 });
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, env.ORIGIN);
    const headers = new Headers(request.headers);
    headers.set('X-Workhelm-Proxy', env.PROXY_SECRET);
    headers.set('X-Workhelm-Client-IP', request.headers.get('CF-Connecting-IP') || '');
    headers.set('X-Forwarded-Proto', 'https');
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    // streamed both ways: uploads, 100 MB installer downloads and the live updates all pass straight through
    return fetch(target, { method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual' });
  },
};
