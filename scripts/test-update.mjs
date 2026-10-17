#!/usr/bin/env node
/**
 * End-to-end test of automatic updates. Entirely hidden: nothing appears on screen, and the installed Studio, its
 * terminals and settings are never touched (own temp folder, port 4741, own data dir and Electron profile).
 *
 *   node scripts/build-app.mjs --version 0.1.5 --arch arm64 --out release/test-out
 *   node scripts/test-update.mjs release/out/Studio-CLI-0.1.4-arm64.dmg release/test-out/Studio-CLI-0.1.5-arm64.dmg
 *
 * Both installers must be for this Mac's chip, and the second must be newer and contain the updater.
 * In order it checks: a file with the wrong stamp is refused; a good one is installed and the app comes back as the
 * new version with its terminal still running; a version that can't start is rolled back by the watchdog and not
 * tried again; no test process ever showed a window.
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const core = createRequire(import.meta.url)('../electron/update-core.cjs');
const [OLD, NEW] = process.argv.slice(2).map((p) => path.resolve(p));
if (!OLD || !NEW) {
  console.error('usage: node scripts/test-update.mjs <old.dmg> <new.dmg>');
  process.exit(2);
}
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const PORT = 4741;
const SITE_PORT = 4798;
const API = `http://127.0.0.1:${PORT}`;
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'su-')); // kept short: the pty host's socket lives in here
const BUNDLE = path.join(T, 'Apps/Studio CLI.app');
const UPDATES = path.join(T, 'd/electron/updates'); // main.cjs gives test copies their profile under STUDIO_DATA_DIR
const SLEEP = 'sleep 987654'; // the test terminal's command, unique so it can be found (and cleaned up) by name

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(name);
  console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${name}${detail ? `  (${detail})` : ''}`);
}
const json = async (url, opts) => {
  try {
    return await (await fetch(url, opts)).json();
  } catch {
    return null;
  }
};
const post = (route, body) => json(API + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function until(what, fn, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    const v = await fn();
    if (v) return v;
  }
  console.log(`  … gave up waiting for ${what}`);
  return null;
}
const versionOf = (app) => {
  try {
    return sh('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(app, 'Contents/Info.plist')]);
  } catch {
    return null;
  }
};
function copyApp(dmg, dest) {
  const mnt = fs.mkdtempSync(path.join(T, 'mnt-'));
  sh('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmg]);
  try {
    sh('ditto', [path.join(mnt, 'Studio CLI.app'), dest]);
  } finally {
    sh('hdiutil', ['detach', mnt, '-force']);
    fs.rmdirSync(mnt);
  }
}
const notes = async () => ((await json(`${API}/api/state`))?.notifications || []).map((n) => n.title);
const shellAlive = () => sh('ps', ['-axo', 'command=']).split('\n').some((c) => c.trim() === SLEEP);

// Processes of this test: anything whose command line mentions the temp folder (the app copies, their servers, the
// pty host), plus watchdogs, which carry the folder only in their environment.
function testPids() {
  const pids = [];
  for (const line of sh('ps', ['-axo', 'pid=,command=']).split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || Number(m[1]) === process.pid) continue;
    if (m[2].includes(T)) pids.push(Number(m[1]));
    else if (m[2].startsWith('/bin/sh -c sleep "$WAIT"')) {
      try {
        if (sh('ps', ['-E', '-o', 'command=', '-p', m[1]]).includes(T)) pids.push(Number(m[1]));
      } catch {}
    }
  }
  return pids;
}

// Every 2 s: any on-screen window owned by a test process is a failure (tests must never show anything).
const seenWindows = [];
const windowWatch = setInterval(() => {
  const pids = new Set(testPids());
  if (!pids.size) return;
  const js =
    "ObjC.import('CoreGraphics'); JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0))).map((w) => [w.kCGWindowOwnerPID, w.kCGWindowOwnerName]))";
  try {
    for (const [pid, name] of JSON.parse(sh('osascript', ['-l', 'JavaScript', '-e', js]))) if (pids.has(pid)) seenWindows.push(`${name} (${pid})`);
  } catch {}
}, 2000);

// A fake website: offers one file with a stamp, like site/downloads.json + /download/<arch>.
const offer = { version: '0.0.0', file: null, stamp: null };
const site = http
  .createServer((req, res) => {
    if (req.url === '/downloads.json') return res.end(JSON.stringify({ version: offer.version, sig: { [ARCH]: offer.stamp } }));
    if (req.url === `/download/${ARCH}` && offer.file) {
      res.setHeader('content-length', fs.statSync(offer.file).size);
      return fs.createReadStream(offer.file).pipe(res);
    }
    res.statusCode = 404;
    res.end();
  })
  .listen(SITE_PORT, '127.0.0.1');
const testKey = crypto.generateKeyPairSync('ed25519').privateKey;
async function serve(dmg, version, key = testKey) {
  Object.assign(offer, { version, file: dmg, stamp: core.signStamp(key, version, ARCH, await core.sha256File(dmg)) });
}

async function cleanup() {
  clearInterval(windowWatch);
  // Twice: a server killed mid-start can still leave a pty host appearing a moment later.
  for (let pass = 0; pass < 2; pass++, await sleep(1000))
    for (const pid of testPids())
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
  for (const line of sh('ps', ['-axo', 'pid=,command=']).split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m && m[2] === SLEEP) process.kill(Number(m[1]), 'SIGKILL');
  }
  site.close();
  fs.rmSync(T, { recursive: true, force: true });
}

try {
  // The versions inside the two installers, and a third that can't start (its main process exits at once).
  const tmpApp = path.join(T, 'peek.app');
  copyApp(NEW, tmpApp);
  const newVersion = versionOf(tmpApp);
  const broken = newVersion.split('.').map(Number);
  broken[2]++;
  const brokenVersion = broken.join('.');
  const work = path.join(T, 'broken');
  fs.mkdirSync(work);
  fs.renameSync(tmpApp, path.join(work, 'Studio CLI.app'));
  const bApp = path.join(work, 'Studio CLI.app');
  fs.writeFileSync(path.join(bApp, 'Contents/Resources/app/electron/main.cjs'), "require('electron').app.exit(3);\n");
  sh('plutil', ['-replace', 'CFBundleShortVersionString', '-string', brokenVersion, path.join(bApp, 'Contents/Info.plist')]);
  sh('codesign', ['--force', '--deep', '-s', '-', bApp]);
  const brokenDmg = path.join(T, 'broken.dmg');
  sh('hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-srcfolder', work, '-volname', 'Studio CLI', '-format', 'UDZO', brokenDmg]);

  fs.mkdirSync(path.dirname(BUNDLE));
  copyApp(OLD, BUNDLE);
  const oldVersion = versionOf(BUNDLE);
  console.log(`Testing ${oldVersion} → ${newVersion} (and a broken ${brokenVersion}) in ${T}\n`);

  // 1. The first check finds the new version stamped with the wrong key.
  await serve(NEW, newVersion, crypto.generateKeyPairSync('ed25519').privateKey);
  const env = {
    HOME: os.homedir(),
    USER: os.userInfo().username,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    STUDIO_HIDDEN: '1',
    STUDIO_PORT: String(PORT),
    STUDIO_DATA_DIR: path.join(T, 'd'),
    STUDIO_CLAUDE_DIR: path.join(T, 'claude'),
    STUDIO_NO_LOGIN_PROMPT: '1',
    STUDIO_UPDATE_URL: `http://127.0.0.1:${SITE_PORT}`,
    STUDIO_UPDATE_PUBKEY: core.publicKeyOf(testKey),
    STUDIO_UPDATE_TEST: '1',
  };
  fs.mkdirSync(env.STUDIO_CLAUDE_DIR);
  spawn(path.join(BUNDLE, 'Contents/MacOS/Studio CLI'), [], { env, detached: true, stdio: 'ignore' }).unref();
  check('the old version starts hidden', !!(await until('the app to start', async () => (await json(`${API}/api/update`))?.inApp, 60_000)));
  const refused = await until('the wrong stamp to be refused', async () => {
    const u = await json(`${API}/api/update`);
    return u?.state === 'error' && u;
  }, 60_000);
  check('a wrong stamp is refused', !!refused && /stamp/.test(refused.error), refused?.error);
  check('…and nothing was installed', versionOf(BUNDLE) === oldVersion && !fs.existsSync(path.join(UPDATES, 'next.app')));

  // 2. A good stamp: installed while a terminal is running.
  const term = await post('/api/terminals', { cwd: T, command: SLEEP });
  await until('the terminal to start', async () => shellAlive(), 15_000);
  check('a test terminal is running', !!term?.id && shellAlive());
  await serve(NEW, newVersion);
  await post('/api/update', { check: true });
  const updated = await until('the new version to come up', async () => (await json(`${API}/api/update`))?.current === newVersion, 120_000);
  check(`the app came back as ${newVersion}`, !!updated && versionOf(BUNDLE) === newVersion);
  const confirmed = await until('the update to be confirmed', async () => (await notes()).includes(`Studio updated to ${newVersion}`), 20_000);
  check('it says "Studio updated"', !!confirmed);
  check('the old copy and the marker are cleaned up', !fs.existsSync(path.join(UPDATES, 'previous.app')) && !fs.existsSync(path.join(UPDATES, 'pending.json')));
  const t = (await json(`${API}/api/state`))?.terminals?.find((x) => x.id === term?.id);
  check('the terminal survived the restart', !!t && !t.exited && shellAlive());
  const settled = await until('the next check', async () => (await json(`${API}/api/update`))?.state === 'idle', 30_000);
  check('it then reports up to date', !!settled);

  // 3. A version that can't start: installed, then put back by the watchdog, then skipped.
  await serve(brokenDmg, brokenVersion);
  await post('/api/update', { check: true });
  const swapped = await until('the broken version to be swapped in', async () => versionOf(BUNDLE) === brokenVersion, 60_000);
  check(`the broken ${brokenVersion} was installed`, !!swapped);
  const back = await until('the watchdog to roll back', async () => (await notes()).includes(`Studio couldn't start ${brokenVersion}`), 120_000);
  check(`the watchdog put ${newVersion} back`, !!back && versionOf(BUNDLE) === newVersion && (await json(`${API}/api/update`))?.current === newVersion);
  let skip = null;
  try {
    skip = JSON.parse(fs.readFileSync(path.join(UPDATES, 'skip.json'), 'utf8'));
  } catch {}
  check(`${brokenVersion} is skipped from now on`, skip?.version === brokenVersion);
  await post('/api/update', { check: true });
  await sleep(4000);
  const after = await json(`${API}/api/update`);
  check('…and not installed again', after?.state === 'idle' && versionOf(BUNDLE) === newVersion, after?.state);
  check('the terminal survived the rollback too', shellAlive());

  check('no test process showed a window', seenWindows.length === 0, [...new Set(seenWindows)].join(', '));
} catch (e) {
  check('test ran to the end', false, e.message);
} finally {
  await cleanup();
}
console.log(failures.length ? `\n\x1b[31m${failures.length} failed\x1b[0m` : '\n\x1b[32mALL PASSED\x1b[0m');
process.exit(failures.length ? 1 : 0);
