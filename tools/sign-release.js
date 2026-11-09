#!/usr/bin/env node
'use strict';
// Signs desktop installers with the Staffwarden release key, so the app installs them.
//   node tools/sign-release.js <release-key.pem> <installer> [<installer> ...]
// Writes <installer>.sig next to each one. Upload the installers and their .sig files together on
// Developer › Desktop apps. Keep the key on your own computer: never in the repository or on the server.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { message } = require('../server/lib/release-key');

const [keyFile, ...files] = process.argv.slice(2);
if (!keyFile || !files.length) { console.error('usage: node tools/sign-release.js <release-key.pem> <installer> [...]'); process.exit(2); }
const key = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
for (const file of files) {
  const name = path.basename(file);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const sig = crypto.sign(null, message(name, sha), key).toString('base64');
  fs.writeFileSync(`${file}.sig`, sig + '\n');
  console.log(`signed ${name}  (sha256 ${sha.slice(0, 12)}…)`);
}
