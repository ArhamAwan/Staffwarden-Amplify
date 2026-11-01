'use strict';
// How the app reaches the server. It tries the browser-style connection first (Chromium's network
// stack: the computer's trusted certificates, proxies and VPNs, so antivirus HTTPS scanning does not
// break it). If that fails on a computer, the direct connection is tried, and whichever works is used
// from then on. Both reasons are logged.
const why = (e) => (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || String(e);

function makeFetch({ browserFetch = null, directFetch = globalThis.fetch, log = () => {} } = {}) {
  let preferDirect = !browserFetch;
  const fetchFn = async (url, opts = {}) => {
    const first = preferDirect ? directFetch : browserFetch;
    const second = preferDirect ? browserFetch : directFetch;
    try { return await first(url, opts); } catch (e1) {
      if ((opts.signal && opts.signal.aborted) || !second) throw e1;
      try {
        const r = await second(url, opts);
        preferDirect = !preferDirect;
        log(`${preferDirect ? 'browser-style' : 'direct'} connection failed (${why(e1)}); using the ${preferDirect ? 'direct' : 'browser-style'} connection from now on`);
        return r;
      } catch (e2) {
        log(`${url}: ${why(e1)}; then ${why(e2)}`);
        throw new Error(`${why(e1)}; ${why(e2)}`);
      }
    }
  };
  fetchFn.mode = () => (preferDirect ? 'direct' : 'browser');
  return fetchFn;
}

module.exports = { makeFetch };
