/**
 * Automatic updates for the Mac app (design: docs/superpowers/specs/2026-10-17-auto-update-design.md).
 *
 * Checks the website for a newer version, downloads it, checks its stamp (update-core.cjs), unpacks it beside the
 * app's data, and once nobody is using Studio (no Claude busy for 2 minutes, nobody typing for 5) swaps it in and
 * restarts. Terminals live in the pty host, a separate process, so they keep running. The old version is kept
 * until the new one has started; if it never does, a watchdog puts the old one back.
 *
 * Every few seconds it reports to the server (POST /api/update/report); the reply says whether updates are
 * automatic, whether you asked to check or install, and how long Studio has been quiet.
 */
const { execFile, execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const core = require('./update-core.cjs');

const BUNDLE_ID = 'com.cantivia.studio-cli';
// Automated tests (scripts/test-update.mjs) point the app at a fake website and a test key, and skip the waiting.
const TEST = process.env.STUDIO_UPDATE_TEST === '1';
const SITE = (process.env.STUDIO_UPDATE_URL || 'https://studio-cli.cantivia.com').replace(/\/$/, '');
const KEY = process.env.STUDIO_UPDATE_PUBKEY || core.PUBLIC_KEY;
const FIRST_CHECK = TEST ? 2_000 : 2 * 60_000;
const EVERY = 4 * 60 * 60_000;
const QUIET = TEST ? { busy: 0, input: 0 } : core.QUIET;
const ROLLBACK_AFTER = TEST ? 20 : 120; // seconds a new version has to start before the watchdog undoes it

const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(`${cmd}: ${String(stderr || err.message).trim()}`)) : resolve(String(stdout).trim()))),
  );

function move(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // On different disks: copy (ditto keeps an app intact), then remove the original.
    execFileSync('ditto', [from, to]);
    fs.rmSync(from, { recursive: true, force: true });
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const friendly = (e) => (e?.name === 'TypeError' ? "couldn't reach the update site" : String(e?.message || e));

function createUpdater({ app, origin, windowHidden, stopServer }) {
  const DIR = path.join(app.getPath('userData'), 'updates');
  const NEXT = path.join(DIR, 'next.app');
  const PREV = path.join(DIR, 'previous.app');
  const PENDING = path.join(DIR, 'pending.json');
  const ROLLED_BACK = path.join(DIR, 'rolled-back.json');
  const SKIP = path.join(DIR, 'skip.json');
  const BUNDLE = path.resolve(process.execPath, '../../..'); // …/Studio CLI.app/Contents/MacOS/Studio CLI → …/Studio CLI.app
  const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';

  const status = { state: 'idle', current: app.getVersion() };
  let staged = null; // the version waiting in next.app
  let working = false;
  let installing = false;
  const set = (patch) => Object.assign(status, { error: undefined }, patch);

  const notify = (title, body) =>
    fetch(`${origin}/api/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, body }) }).catch(() => {});

  /** Once the server answers: finish an update that just happened, or report one that was rolled back. */
  function confirm() {
    const done = readJson(PENDING);
    if (done && done.to === app.getVersion()) {
      fs.rmSync(PENDING, { force: true });
      fs.rmSync(PREV, { recursive: true, force: true });
      notify(`Studio updated to ${done.to}`, 'Your terminals kept running.');
    } else if (done && Date.now() - done.at > 10 * 60_000) fs.rmSync(PENDING, { force: true });
    const back = readJson(ROLLED_BACK);
    if (back) {
      fs.rmSync(ROLLED_BACK, { force: true });
      // Don't fetch that version again; the next one is tried as normal.
      fs.writeFileSync(SKIP, JSON.stringify({ version: back.to }));
      notify(`Studio couldn't start ${back.to}`, `It went back to ${app.getVersion()}. The next version will be tried when it's out.`);
    }
  }

  /** True just after an update restarted the app, while the old server may still be letting go of the port. */
  const justUpdated = () => {
    const p = readJson(PENDING);
    return !!p && Date.now() - p.at < 2 * 60_000;
  };

  async function check() {
    if (working || installing) return;
    if (!core.updatableLocation(BUNDLE)) return set({ state: 'move' });
    working = true;
    try {
      set({ state: 'checking' });
      const r = await fetch(`${SITE}/downloads.json`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`the update site answered ${r.status}`);
      const d = await r.json();
      const stamp = d.sig?.[ARCH];
      const newer = core.isVersion(d.version) && core.compareVersions(d.version, app.getVersion()) > 0 && !!stamp && d.version !== readJson(SKIP)?.version;
      if (!newer) {
        staged = null;
        fs.rmSync(NEXT, { recursive: true, force: true });
        return set({ state: 'idle', latest: d.version, checkedAt: Date.now() });
      }
      if (staged !== d.version) await download(d.version, stamp);
      set({ state: 'ready', latest: d.version, checkedAt: Date.now() });
    } catch (e) {
      set({ state: 'error', error: friendly(e) });
    } finally {
      working = false;
    }
  }

  async function download(version, stamp) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.rmSync(NEXT, { recursive: true, force: true });
    staged = null;
    const dmg = path.join(DIR, `Studio-CLI-${version}-${ARCH}.dmg`);
    try {
      set({ state: 'downloading', latest: version, progress: 0 });
      const r = await fetch(`${SITE}/download/${ARCH}`);
      if (!r.ok || !r.body) throw new Error(`the download failed (${r.status})`);
      const total = Number(r.headers.get('content-length')) || 0;
      const hash = crypto.createHash('sha256');
      let got = 0;
      const count = new Transform({
        transform(chunk, _enc, done) {
          hash.update(chunk);
          got += chunk.length;
          if (total) status.progress = Math.floor((got / total) * 100);
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(r.body), count, fs.createWriteStream(dmg));
      if (!core.verifyStamp(version, ARCH, hash.digest('hex'), stamp, KEY)) throw new Error("the download's stamp didn't match, so it wasn't installed");
      await unpack(dmg, version);
      staged = version;
    } catch (e) {
      fs.rmSync(NEXT, { recursive: true, force: true });
      throw e;
    } finally {
      fs.rmSync(dmg, { force: true });
    }
  }

  async function unpack(dmg, version) {
    const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-update-'));
    try {
      await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-noverify', '-mountpoint', mnt, dmg]);
      try {
        await run('ditto', [path.join(mnt, 'Studio CLI.app'), NEXT]);
      } finally {
        await run('hdiutil', ['detach', mnt, '-force']).catch(() => {});
      }
    } finally {
      try {
        fs.rmdirSync(mnt);
      } catch {}
    }
    const plist = path.join(NEXT, 'Contents/Info.plist');
    const id = await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist]);
    const v = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]);
    if (id !== BUNDLE_ID || v !== version) throw new Error(`the download held ${id} ${v}, not Studio CLI ${version}`);
    await run('codesign', ['--verify', '--deep', '--strict', NEXT]);
    // The app downloaded it itself, so macOS shouldn't have flagged it; make sure it won't ask "are you sure?".
    await run('xattr', ['-dr', 'com.apple.quarantine', NEXT]).catch(() => {});
  }

  async function install() {
    if (!staged || working || installing) return;
    installing = true;
    set({ state: 'installing' });
    try {
      fs.rmSync(PREV, { recursive: true, force: true });
      move(BUNDLE, PREV);
      try {
        move(NEXT, BUNDLE);
      } catch (e) {
        move(PREV, BUNDLE);
        throw e;
      }
    } catch (e) {
      installing = false;
      staged = null;
      return set({ state: 'error', error: `couldn't swap in the new version (${e.message})` });
    }
    const hidden = windowHidden();
    fs.writeFileSync(PENDING, JSON.stringify({ from: app.getVersion(), to: staged, hidden, at: Date.now() }));
    watchdog(hidden);
    await stopServer();
    app.relaunch({ args: hidden ? ['--start-hidden'] : [] });
    app.exit(0);
  }

  // Runs on its own after this app exits. If the new version hasn't confirmed it started (PENDING still there)
  // after ROLLBACK_AFTER seconds, the old version goes back in place and is started again.
  function watchdog(hidden) {
    const script = [
      'sleep "$WAIT"',
      '[ -f "$PENDING" ] || exit 0',
      'rm -rf "$FAILED" && mv "$BUNDLE" "$FAILED" && mv "$PREV" "$BUNDLE" || exit 1',
      'mv "$PENDING" "$ROLLED_BACK"',
      'rm -rf "$FAILED"',
      'exec "$BUNDLE/Contents/MacOS/Studio CLI" $ARGS',
    ].join('\n');
    spawn('/bin/sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, WAIT: String(ROLLBACK_AFTER), PENDING, ROLLED_BACK, PREV, BUNDLE, FAILED: path.join(DIR, 'failed.app'), ARGS: hidden ? '--start-hidden' : '' },
    }).unref();
  }

  async function tick() {
    let reply;
    try {
      const r = await fetch(`${origin}/api/update/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(status) });
      reply = await r.json();
    } catch {
      return;
    }
    if (reply.check) check();
    if (status.state === 'ready' && staged && (reply.install || (reply.auto && core.isQuiet(reply, QUIET)))) install();
  }

  function start() {
    confirm();
    setTimeout(check, FIRST_CHECK);
    setInterval(check, EVERY);
    setInterval(tick, TEST ? 1_000 : 5_000);
    tick();
  }

  return { start, justUpdated };
}

module.exports = { createUpdater };
