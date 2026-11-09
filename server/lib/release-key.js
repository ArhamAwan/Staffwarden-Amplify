'use strict';
// Desktop releases are signed offline with the Staffwarden release key (tools/sign-release.js). The public half
// lives in keys/update-key.pub and inside the desktop app. A signature covers the installer's file name and
// SHA-256, so neither the bytes nor the version in the name can be swapped.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const message = (file, sha256) => Buffer.from(`staffwarden-release\n${file}\n${String(sha256).toLowerCase()}`);

function loadKey(file = process.env.WORKHELM_UPDATE_KEY_FILE || path.join(__dirname, '..', '..', 'keys', 'update-key.pub')) {
  try { return crypto.createPublicKey(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function verify(key, file, sha256, sigB64) {
  if (!key || typeof sigB64 !== 'string' || !/^[A-Za-z0-9+/=]{40,400}$/.test(sigB64.trim())) return false;
  try { return crypto.verify(null, message(file, sha256), key, Buffer.from(sigB64.trim(), 'base64')); } catch { return false; }
}

module.exports = { message, loadKey, verify };
