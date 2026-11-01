'use strict';
// In-app updates. The app asks the company server for the newest installer for this computer
// (GET /api/app/latest), tells the person when one is out, and on "Update" downloads it, checks its
// size and SHA-256 against what the server reported, and installs it:
//   Windows: runs the installer silently (it replaces the app and starts it again).
//   macOS:   unpacks the new Workhelm.app next to the download, then a small script waits for this
//            app to quit, swaps the new app in place of the old one and opens it.
// A running timer is saved first and carries on after the restart.
// Electron makes the normal fs treat .asar files as folders, which breaks deleting or copying a
// downloaded Workhelm.app (its Contents/Resources/app.asar). 'original-fs' is the untouched version.
const fs = (() => { try { return require('original-fs'); } catch { return require('node:fs'); } })();
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

function cmpVersion(a, b) {
  const x = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0), y = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

class Updater {
  constructor({ baseUrl, version, platform = process.platform, arch = process.arch, dir, fetchImpl = globalThis.fetch, onChange = () => {} }) {
    Object.assign(this, { baseUrl: String(baseUrl || '').replace(/\/+$/, ''), version, platform, arch, dir, fetch: fetchImpl, onChange });
    this.state = { status: 'idle', current: version, latest: null, notes: '', progress: 0, error: null, checkedAt: null };
    this.info = null; this.file = null; this.busy = null;
  }

  set(patch) { Object.assign(this.state, patch); try { this.onChange({ ...this.state }); } catch { /* listener problems are not ours */ } }
  supported() { return this.platform === 'win32' || this.platform === 'darwin'; }

  async check() {
    if (!this.supported() || !this.baseUrl) return this.state;
    if (['downloading', 'installing'].includes(this.state.status)) return this.state;
    let info;
    try {
      const res = await this.fetch(`${this.baseUrl}/api/app/latest?platform=${this.platform}&arch=${this.arch}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      info = await res.json();
    } catch (e) {
      // offline or an older server: say nothing new, try again later
      this.set({ checkedAt: Date.now(), reached: false, error: this.state.status === 'error' ? this.state.error : null });
      return this.state;
    }
    const newer = info && info.version && info.url && /^[0-9a-f]{64}$/.test(String(info.sha256 || '')) && cmpVersion(info.version, this.version) > 0;
    if (!newer) { this.info = null; this.set({ status: 'current', latest: info && info.version || null, notes: '', checkedAt: Date.now(), reached: true, error: null }); return this.state; }
    const same = this.info && this.info.version === info.version && this.info.sha256 === info.sha256;
    this.info = info;
    if (same && this.state.status === 'ready') { this.set({ checkedAt: Date.now(), reached: true }); return this.state; }
    this.file = null;
    this.set({ status: 'available', latest: info.version, notes: info.notes || '', progress: 0, error: null, checkedAt: Date.now(), reached: true });
    return this.state;
  }

  // Downloads the installer and checks it. Resolves with the file path.
  download() {
    if (this.busy) return this.busy;
    this.busy = this._download().finally(() => { this.busy = null; });
    return this.busy;
  }

  // A plain log of what the updater did, kept next to the downloads (not inside them), for when an
  // update does not go through.
  log(msg) {
    try {
      const f = path.join(path.dirname(this.dir), 'update.log');
      try { if (fs.statSync(f).size > 200000) fs.renameSync(f, f + '.old'); } catch { /* new log */ }
      fs.appendFileSync(f, `${new Date().toISOString()} ${msg}\n`);
    } catch { /* logging must never break an update */ }
  }

  async _download() {
    const info = this.info;
    if (!info) throw new Error('No update is available');
    if (this.file && this.state.status === 'ready' && fs.existsSync(this.file)) return this.file;
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir)) { try { fs.rmSync(path.join(this.dir, f), { recursive: true, force: true }); } catch { /* in use */ } }
    const name = path.basename(String(info.file || info.url)).replace(/[^\w.\-]/g, '_');
    const dest = path.join(this.dir, name), part = dest + '.part';
    const url = /^https?:\/\//i.test(info.url) ? info.url : this.baseUrl + info.url;
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {      // one automatic retry
      this.set({ status: 'downloading', progress: 0, got: 0, total: Number(info.size) || 0, error: null });
      this.log(`download ${info.version} attempt ${attempt}: ${url}`);
      try {
        await this._fetchTo(url, part, info);
        fs.renameSync(part, dest);
        this.file = dest;
        this.log(`downloaded and checked ${dest}`);
        this.set({ status: 'ready', progress: 100 });
        return dest;
      } catch (e) {
        lastErr = e;
        this.log(`download failed: ${e.message}`);
        try { fs.rmSync(part, { force: true }); } catch { /* gone */ }
      }
    }
    this.set({ status: 'error', error: `Could not download the update: ${lastErr.message}. Check your internet connection and press Try again.` });
    throw lastErr;
  }

  async _fetchTo(url, part, info) {
    const ctl = new AbortController();
    let stalled = false, timer = null;
    const STALL_MS = this.stallMs || 45000;
    const poke = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; ctl.abort(); }, STALL_MS); };
    poke();
    let fd = null;
    try {
      const res = await this.fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
      const total = Number(info.size) || Number(res.headers.get('content-length')) || 0;
      const hash = crypto.createHash('sha256');
      fd = fs.openSync(part, 'w');
      let got = 0, shown = -1, shownAt = 0;
      for await (const chunk of res.body) {
        poke();
        const b = Buffer.from(chunk);
        fs.writeSync(fd, b); hash.update(b); got += b.length;
        const pct = total ? Math.min(99, Math.floor((100 * got) / total)) : 0;
        if (pct !== shown || Date.now() - shownAt > 1000) { shown = pct; shownAt = Date.now(); this.set({ progress: pct, got, total }); }
      }
      if (info.size && got !== Number(info.size)) throw new Error(`the download was incomplete (${got} of ${info.size} bytes)`);
      if (hash.digest('hex') !== String(info.sha256).toLowerCase()) throw new Error('the download did not match the server\'s checksum');
    } catch (e) {
      if (stalled) throw new Error(`the download stopped (nothing arrived for ${Math.round(STALL_MS / 1000)} seconds)`);
      throw e;
    } finally {
      clearTimeout(timer);
      if (fd != null) fs.closeSync(fd);
    }
  }
}

// ---------- installing ----------
const run = (cmd, args, timeout = 5 * 60000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout))));
});

// The .app bundle this app runs from, e.g. /Applications/Workhelm.app (null when not packaged).
function macBundleOf(execPath) {
  const p = path.resolve(execPath, '..', '..', '..');
  return /\.app$/i.test(p) ? p : null;
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// The script that swaps the app once this one has quit. If anything goes wrong the old app is put back.
function macSwapScript({ pid, oldApp, newApp, log }) {
  const backup = oldApp.replace(/\.app$/i, '') + '.previous.app';
  return `#!/bin/sh
exec >>${q(log)} 2>&1
echo "update $(date)"
i=0; while kill -0 ${Number(pid)} 2>/dev/null && [ $i -lt 120 ]; do sleep 0.5; i=$((i+1)); done
rm -rf ${q(backup)}
if { [ ! -e ${q(oldApp)} ] || mv ${q(oldApp)} ${q(backup)}; } && mv ${q(newApp)} ${q(oldApp)}; then
  rm -rf ${q(backup)}
  xattr -dr com.apple.quarantine ${q(oldApp)} 2>/dev/null
  echo "installed"
else
  [ -d ${q(oldApp)} ] || mv ${q(backup)} ${q(oldApp)}
  echo "failed, kept the old app"
fi
open ${q(oldApp)}
`;
}

// Gets the update ready to swap in. Returns { launch(pid) } which starts the hand-over; the caller quits right after.
// Where the new app goes. Normally where the old one is. But when the old one cannot be replaced (opened
// straight from a download, so macOS runs it from a protected temporary copy, or a folder this account
// cannot write to), the new one is put in Applications (or the person's own Applications folder) instead.
const writable = (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };
function macTarget(running, { home = require('node:os').homedir() } = {}) {
  const translocated = /\/AppTranslocation\//.test(running);
  if (!translocated && writable(path.dirname(running)) && writable(running)) return running;
  const name = path.basename(running);
  for (const dir of ['/Applications', path.join(home, 'Applications')]) {
    const target = path.join(dir, name);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* checked below */ }
    if (writable(dir) && (!fs.existsSync(target) || writable(target))) return target;
  }
  return null;
}

async function prepareInstall({ platform = process.platform, file, execPath = process.execPath, workDir, home, log = null }) {
  if (platform === 'win32') {
    return {
      launch: () => {
        // /S: silent. --updated: an update, keep the person's shortcuts. --force-run: start Workhelm when done.
        const child = spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
      },
    };
  }
  if (platform === 'darwin') {
    const running = macBundleOf(execPath);
    if (!running) throw new Error('Updates work in the installed app only');
    const oldApp = macTarget(running, { home });
    if (!oldApp) {
      const e = new Error(`Staffwarden can't install the update in Applications with this account's permissions.`);
      e.code = 'not-writable'; throw e;
    }
    if (log) log(`install: running from ${running}, installing to ${oldApp}`);
    const out = path.join(workDir, 'unpacked');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    await run('/usr/bin/ditto', ['-x', '-k', file, out]);
    const name = fs.readdirSync(out).find((f) => /\.app$/i.test(f));
    if (!name) throw new Error('the update did not contain the app');
    const newApp = path.join(out, name);
    // the new app sits next to the old one first, so the final swap is a quick rename on the same disk
    const staged = path.join(path.dirname(oldApp), '.Workhelm-update.app');
    fs.rmSync(staged, { recursive: true, force: true });
    await run('/usr/bin/ditto', [newApp, staged]);
    fs.rmSync(out, { recursive: true, force: true });
    return {
      newApp: staged, oldApp,
      launch: (pid) => {
        const script = path.join(workDir, 'swap.sh');
        fs.writeFileSync(script, macSwapScript({ pid, oldApp, newApp: staged, log: path.join(workDir, 'update.log') }), { mode: 0o755 });
        const child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' });
        child.unref();
      },
    };
  }
  throw new Error('Updates are not available on this system');
}

// Leftovers from an update that did not finish (older versions could stop half way on a Mac): the hidden
// staged app next to Workhelm.app and the unpacked copy. Removed when the app starts.
function cleanupLeftovers({ platform = process.platform, execPath = process.execPath, workDir }) {
  const gone = [];
  const rm = (p) => { try { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); gone.push(p); } } catch { /* try next time */ } };
  if (workDir) rm(path.join(workDir, 'unpacked'));
  if (platform === 'darwin') {
    const bundle = macBundleOf(execPath);
    if (bundle) { rm(path.join(path.dirname(bundle), '.Workhelm-update.app')); rm(path.join('/Applications', '.Workhelm-update.app')); }
  }
  return gone;
}

module.exports = { Updater, cmpVersion, macBundleOf, macSwapScript, macTarget, prepareInstall, cleanupLeftovers };
