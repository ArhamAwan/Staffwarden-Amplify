'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Small JSON file that survives restarts (the tracker's own state). Writes are atomic.
class FileStore {
  constructor(file) { this.file = file; fs.mkdirSync(path.dirname(file), { recursive: true }); }
  load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; } }
  save(obj) { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, this.file); }
}
class MemoryStore {
  constructor() { this.v = null; }
  load() { return this.v ? JSON.parse(JSON.stringify(this.v)) : null; }
  save(obj) { this.v = JSON.parse(JSON.stringify(obj)); }
}
module.exports = { FileStore, MemoryStore };
