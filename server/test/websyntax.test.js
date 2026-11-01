'use strict';
// Every script the website loads must parse: one syntax error anywhere and the whole site shows a blank page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..', 'web', 'js');
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (e.name.endsWith('.js')) files.push(p); } })(root);

test('every website script parses', () => {
  assert.ok(files.length > 10);
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(f) });
    assert.equal(r.status, 0, `${path.relative(root, f)}: ${String(r.stderr).split('\n').slice(0, 5).join('\n')}`);
  }
});
