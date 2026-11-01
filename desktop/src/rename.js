'use strict';
// The app used to be called Workhelm. Its own saved data (the sign-in, settings, a running timer and work
// not yet sent) lives under that name, and on a Mac the key that protects the sign-in is in the keychain
// under it too, so the app keeps using "Workhelm" on the inside. Everything people see says Staffwarden.
const INTERNAL_NAME = 'Workhelm';
const NAME = 'Staffwarden';

// On a Mac, the old app's updater puts the new version in place of the old bundle, so it is still called
// Workhelm.app. The first time it starts, Staffwarden renames its own bundle to Staffwarden.app (when it
// may, and nothing is there already) and opens again from the new place. Returns what to rename, or null.
function macBundleRename(execPath, { exists, writable }) {
  const m = /^(.*\/)Workhelm\.app(\/Contents\/MacOS\/[^/]+)$/.exec(String(execPath || ''));
  if (!m) return null;
  const from = `${m[1]}Workhelm.app`, to = `${m[1]}${NAME}.app`;
  if (/\/AppTranslocation\//.test(from)) return null;    // opened from a download: macOS runs a temporary copy
  if (exists(to) || !writable(m[1].replace(/\/$/, '')) || !writable(from)) return null;
  return { from, to, execPath: `${to}${m[2]}` };
}

module.exports = { INTERNAL_NAME, NAME, macBundleRename };
