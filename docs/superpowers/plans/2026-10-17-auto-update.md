# Automatic updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The unsigned Studio CLI Mac app updates itself from the website once nobody is using it, accepting only releases stamped with Studio's own key.

**Architecture:** Pure logic (versions, stamps, location, quiet rule) in `electron/update-core.cjs`, unit-tested with `node --test`. `electron/updater.cjs` runs in the Electron main process: check → download → verify → unpack → wait for quiet → swap bundle → relaunch, with a detached `/bin/sh` watchdog that rolls back. The server (`server/updates.ts`) is the go-between: quiet times, the "automatic" preference, the app's status for the UI. `scripts/release.mjs` builds, stamps and publishes.

**Tech Stack:** Electron 44 main process (CommonJS, Node 22 `fetch`), Node `crypto` Ed25519, `hdiutil`/`ditto`/`plutil`/`codesign`, Express server (TypeScript via tsx), React settings menu.

Spec: `docs/superpowers/specs/2026-10-17-auto-update-design.md`.

---

## File map

| File | Responsibility |
| --- | --- |
| `electron/update-core.cjs` (new) | versions, stamp sign/verify, file hash, can-this-copy-update, quiet rule |
| `electron/update-core.test.cjs` (new) | unit tests for the above |
| `electron/updater.cjs` (new) | the update loop in the main process |
| `electron/main.cjs` | wire the updater; `--start-hidden`; wait for port after update; own userData for test copies; `stopServer()` |
| `server/updates.ts` (new) | quiet times, preference (`updates.json`), app status, UI requests |
| `server/terminals.ts` | emit `input` when someone types or `/send` writes |
| `server/index.ts` | note busy Claude in the poller; routes |
| `src/components/SettingsMenu.tsx` | Updates rows |
| `scripts/build-app.mjs` | copy all of `electron/`; `--version`, `--out` |
| `scripts/release.mjs` (new) | `npm run release`, `npm run release:key` |
| `scripts/test-update.mjs` (new) | hidden end-to-end test of a real update, a bad stamp and a rollback |
| `package.json`, `site/downloads.json`, `AGENTS.md`, `docs/LAUNCH.md` | scripts, `sig` field, docs |

---

### Task 1: update-core (TDD)

**Files:** Create `electron/update-core.cjs`, `electron/update-core.test.cjs`; modify `package.json` (scripts).

- [ ] **Step 1: Write the failing tests** — `electron/update-core.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('./update-core.cjs');

test('compareVersions orders x.y.z numerically', () => {
  assert.equal(core.compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(core.compareVersions('0.1.3', '0.1.3'), 0);
  assert.equal(core.compareVersions('0.2.0', '1.0.0'), -1);
});

test('isVersion accepts only plain x.y.z', () => {
  assert.ok(core.isVersion('0.1.4'));
  for (const v of ['0.1', '0.1.4-beta', '', 'v0.1.4', undefined]) assert.ok(!core.isVersion(v), String(v));
});

test('a stamp verifies only for the same version, chip and file', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = core.publicKeyOf(privateKey);
  const sha = 'a'.repeat(64);
  const stamp = core.signStamp(privateKey, '0.1.5', 'arm64', sha);
  assert.ok(core.verifyStamp('0.1.5', 'arm64', sha, stamp, pub));
  assert.ok(!core.verifyStamp('0.1.6', 'arm64', sha, stamp, pub));
  assert.ok(!core.verifyStamp('0.1.5', 'x64', sha, stamp, pub));
  assert.ok(!core.verifyStamp('0.1.5', 'arm64', 'b'.repeat(64), stamp, pub));
  assert.ok(!core.verifyStamp('0.1.5', 'arm64', sha, 'not a stamp', pub));
  assert.ok(!core.verifyStamp('0.1.5', 'arm64', sha, undefined, pub));
});

test('a stamp from another key is refused', () => {
  const a = crypto.generateKeyPairSync('ed25519');
  const b = crypto.generateKeyPairSync('ed25519');
  const stamp = core.signStamp(a.privateKey, '0.1.5', 'arm64', 'c'.repeat(64));
  assert.ok(!core.verifyStamp('0.1.5', 'arm64', 'c'.repeat(64), stamp, core.publicKeyOf(b.privateKey)));
});

test('the built-in public key is an Ed25519 key', () => {
  const key = crypto.createPublicKey({ key: Buffer.from(core.PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
  assert.equal(key.asymmetricKeyType, 'ed25519');
});

test('sha256File hashes the whole file', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uc-')), 'x');
  fs.writeFileSync(f, 'hello');
  assert.equal(await core.sha256File(f), crypto.createHash('sha256').update('hello').digest('hex'));
});

test('updatableLocation refuses disk images, translocated copies and read-only folders', () => {
  const yes = () => true;
  assert.ok(core.updatableLocation('/Applications/Studio CLI.app', yes));
  assert.ok(!core.updatableLocation('/Volumes/Studio CLI/Studio CLI.app', yes));
  assert.ok(!core.updatableLocation('/private/var/folders/x/AppTranslocation/ABC/d/Studio CLI.app', yes));
  assert.ok(!core.updatableLocation('/Applications/Studio CLI.app', () => false));
  assert.ok(!core.updatableLocation('/usr/local/bin/node', yes));
});

test('isQuiet needs both a quiet Claude and quiet hands', () => {
  const q = { busy: 100, input: 200 };
  assert.ok(core.isQuiet({ sinceBusy: 100, sinceInput: 200 }, q));
  assert.ok(!core.isQuiet({ sinceBusy: 99, sinceInput: 999 }, q));
  assert.ok(!core.isQuiet({ sinceBusy: 999, sinceInput: 199 }, q));
});
```

- [ ] **Step 2: Add the script and run, expecting failure** — in `package.json` scripts add
  `"test:update": "node --test electron/update-core.test.cjs"`. Run `npm run test:update`. Expected: FAIL, `Cannot find module './update-core.cjs'`.

- [ ] **Step 3: Implement** — `electron/update-core.cjs` (PUBLIC_KEY filled in Task 2):

```js
/**
 * The parts of automatic updates that don't need Electron, shared by electron/updater.cjs (which checks release
 * stamps) and scripts/release.mjs (which makes them). The Mac app isn't signed with an Apple Developer ID, so
 * macOS's own updater won't take it. Instead every release file is stamped with Studio's Ed25519 key, and the app
 * installs only files with a valid stamp: whoever controls the website or GitHub still can't push code to it.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Public half of the release key (Ed25519, SPKI DER, base64), printed by `npm run release:key`. */
const PUBLIC_KEY = '<from npm run release:key>';

const isVersion = (v) => /^\d+\.\d+\.\d+$/.test(String(v));

/** 1 if a is newer than b, -1 if older, 0 if the same. Plain x.y.z versions only (check with isVersion). */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

/** What a stamp signs. Naming the version and chip stops an older or wrong file being passed off as this one. */
const stampMessage = (version, arch, sha256) => Buffer.from(`studio-cli-update\n${version}\n${arch}\n${sha256}`);

const signStamp = (privateKey, version, arch, sha256) => crypto.sign(null, stampMessage(version, arch, sha256), privateKey).toString('base64');

function verifyStamp(version, arch, sha256, stamp, publicKey = PUBLIC_KEY) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, stampMessage(version, arch, sha256), key, Buffer.from(String(stamp), 'base64'));
  } catch {
    return false;
  }
}

/** The public half of a private key, in the form PUBLIC_KEY uses. */
const publicKeyOf = (privateKey) => crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
}

const canWrite = (p) => {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** Whether the app at bundlePath can replace itself. A copy run straight from the disk image, or from Downloads
 *  (macOS then runs it from a hidden read-only copy), has to be moved to Applications first. */
function updatableLocation(bundlePath, writable = canWrite) {
  if (!bundlePath.endsWith('.app') || bundlePath.includes('/AppTranslocation/') || bundlePath.startsWith('/Volumes/')) return false;
  return writable(path.dirname(bundlePath)) && writable(bundlePath);
}

/** Restart only when nobody will notice: no Claude busy for 2 minutes and nobody typing for 5. */
const QUIET = { busy: 2 * 60_000, input: 5 * 60_000 };
const isQuiet = ({ sinceBusy, sinceInput }, quiet = QUIET) => sinceBusy >= quiet.busy && sinceInput >= quiet.input;

module.exports = { PUBLIC_KEY, isVersion, compareVersions, stampMessage, signStamp, verifyStamp, publicKeyOf, sha256File, updatableLocation, QUIET, isQuiet };
```

- [ ] **Step 4: Run** `npm run test:update`. Expected: all pass except "the built-in public key is an Ed25519 key" (placeholder key). That one passes after Task 2.

### Task 2: release key and release script

**Files:** Create `scripts/release.mjs`; modify `package.json`, `electron/update-core.cjs` (PUBLIC_KEY), `site/downloads.json` (note).

- [ ] **Step 1:** Write `scripts/release.mjs`:

```js
#!/usr/bin/env node
/**
 * Publishes a new version of the Mac app.
 *
 *   npm run release -- --notes "What changed"   build, stamp, publish on GitHub, update the website
 *   npm run release -- --skip-build ...         reuse the installers already in release/out
 *   npm run release -- --dry-run                build and stamp, publish nothing
 *   npm run release:key                         make the stamp key (once) and print its public half
 *
 * Before: bump "version" in package.json, commit, be on main with nothing uncommitted.
 * It builds both installers, stamps each with the release key (electron/update-core.cjs says why), pushes main,
 * creates the GitHub release (Studio-CLI-arm64.dmg / -x64.dmg, which the website serves), writes the version and
 * stamps into site/downloads.json (commit + push) and redeploys the website. Installed apps (0.1.4 and later) see
 * it within a few hours and install it when nobody is using Studio.
 *
 * The key is ~/.studio-cli-release/update-signing-key.pem (or STUDIO_UPDATE_SIGNING_KEY). Back it up: without it no
 * installed app accepts another update, and everyone has to download one version by hand.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = createRequire(import.meta.url)('../electron/update-core.cjs');
const KEY_FILE = process.env.STUDIO_UPDATE_SIGNING_KEY || path.join(os.homedir(), '.studio-cli-release/update-signing-key.pem');
const SITE = 'https://studio-cli.cantivia.com';
const REPO = 'cantivia/studio-cli';
const ARCHS = ['arm64', 'x64'];
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: ROOT, encoding: 'utf8', ...opts });
const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const die = (m) => {
  console.error(`\n\x1b[31m${m}\x1b[0m`);
  process.exit(1);
};

if (args[0] === 'key') {
  if (!fs.existsSync(KEY_FILE)) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY_FILE, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    console.log(`Made ${KEY_FILE}. Back it up (a password manager is fine).`);
  }
  console.log(`Public key (PUBLIC_KEY in electron/update-core.cjs):\n${core.publicKeyOf(fs.readFileSync(KEY_FILE))}`);
  process.exit(0);
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const dry = flag('--dry-run');
step(`Releasing Studio CLI ${version}${dry ? ' (dry run)' : ''}`);
if (!fs.existsSync(KEY_FILE)) die(`No release key at ${KEY_FILE}. Restore your backup, or run npm run release:key.`);
const key = fs.readFileSync(KEY_FILE);
if (core.publicKeyOf(key) !== core.PUBLIC_KEY) die("That key doesn't match PUBLIC_KEY in electron/update-core.cjs, so installed apps would refuse the update.");
if (!dry) {
  if (sh('git', ['status', '--porcelain']).trim()) die('Commit or stash your changes first.');
  if (sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim() !== 'main') die('Release from main.');
  let released = true;
  try {
    sh('gh', ['release', 'view', `v${version}`, '-R', REPO], { stdio: 'pipe' });
  } catch {
    released = false;
  }
  if (released) die(`v${version} is already out. Bump "version" in package.json first.`);
}

if (!flag('--skip-build')) {
  step('Building the installers');
  sh('node', ['scripts/build-app.mjs'], { stdio: 'inherit' });
}

step('Stamping');
const sig = {};
const files = {};
for (const arch of ARCHS) {
  const file = path.join(ROOT, `release/out/Studio-CLI-${version}-${arch}.dmg`);
  if (!fs.existsSync(file)) die(`Missing ${file}. Build it, or drop --skip-build.`);
  const sha = await core.sha256File(file);
  sig[arch] = core.signStamp(key, version, arch, sha);
  if (!core.verifyStamp(version, arch, sha, sig[arch])) die(`The ${arch} stamp didn't verify.`);
  files[arch] = file;
  console.log(`  ${arch}: ${sha.slice(0, 16)}… stamped`);
}
if (dry) {
  console.log('\nDry run: nothing published.');
  process.exit(0);
}

step('Publishing the GitHub release');
sh('git', ['push', 'origin', 'main'], { stdio: 'inherit' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-release-'));
const assets = ARCHS.map((arch) => {
  const out = path.join(tmp, `Studio-CLI-${arch}.dmg`);
  fs.copyFileSync(files[arch], out);
  return out;
});
const notes = opt('--notes') || `Studio CLI ${version}.`;
sh('gh', ['release', 'create', `v${version}`, ...assets, '-R', REPO, '--target', 'main', '--title', `Studio CLI ${version}`, '--notes', notes], { stdio: 'inherit' });
fs.rmSync(tmp, { recursive: true, force: true });

step('Updating the website');
const dlFile = path.join(ROOT, 'site/downloads.json');
const dl = JSON.parse(fs.readFileSync(dlFile, 'utf8'));
Object.assign(dl, { version, sig });
fs.writeFileSync(dlFile, JSON.stringify(dl, null, 2) + '\n');
sh('git', ['commit', '-q', '-m', `Release ${version}: website download and update stamps`, 'site/downloads.json']);
sh('git', ['push', 'origin', 'main'], { stdio: 'inherit' });
sh('npx', ['--yes', 'wrangler', 'deploy'], { cwd: path.join(ROOT, 'site-worker'), stdio: 'inherit' });

let live = {};
try {
  live = await (await fetch(`${SITE}/downloads.json`, { cache: 'no-store' })).json();
} catch {}
console.log(
  live.version === version
    ? `\n\x1b[32mDone.\x1b[0m ${SITE} offers ${version}; installed apps will pick it up.`
    : `\nPublished, but ${SITE}/downloads.json says ${live.version}. Check the website deploy.`,
);
```

- [ ] **Step 2:** `package.json` scripts: `"release": "node scripts/release.mjs"`, `"release:key": "node scripts/release.mjs key"`.
- [ ] **Step 3:** Run `npm run release:key`. Paste the printed key into `PUBLIC_KEY`. Run `npm run test:update`: all pass.
- [ ] **Step 4:** In `site/downloads.json` extend `note` with: `sig holds the release stamps installed apps check before updating (scripts/release.mjs writes them).`
- [ ] **Step 5:** Commit `electron/update-core*.cjs scripts/release.mjs package.json site/downloads.json`.

### Task 3: server go-between

**Files:** Create `server/updates.ts`; modify `server/terminals.ts`, `server/index.ts`.

- [ ] **Step 1:** `server/updates.ts`:

```ts
import { readJson, writeJson } from './store.ts';

/**
 * Automatic updates are done by the Mac app (electron/updater.cjs). The server is the go-between: it knows when
 * someone last typed and when a Claude was last busy (the app restarts only when both have been quiet a while),
 * keeps the "update automatically" choice, and passes the app's status to Settings and Settings' requests to the app.
 */
export type UpdateStatus = { state: string; current: string; latest?: string; progress?: number; error?: string; checkedAt?: number };

let lastInput = Date.now();
let lastBusy = Date.now();
let status: (UpdateStatus & { at: number }) | null = null;
let asked = { check: false, install: false };
let prefs: { auto: boolean } | null = null;

export const noteInput = () => void (lastInput = Date.now());
export const noteBusy = () => void (lastBusy = Date.now());
const loadPrefs = async () => (prefs ??= await readJson('updates.json', { auto: true }));

/** The app's report (every few seconds). The reply says what it should do next. */
export async function appReport(s: UpdateStatus) {
  const reply = { auto: (await loadPrefs()).auto, ...asked, sinceBusy: Date.now() - lastBusy, sinceInput: Date.now() - lastInput };
  status = { ...s, at: Date.now() };
  // Settings shouldn't flick back to "Up to date" while the app picks up the request.
  if (asked.install) status.state = 'installing';
  else if (asked.check && status.state === 'idle') status.state = 'checking';
  asked = { check: false, install: false };
  return reply;
}

/** What Settings shows. inApp is false in `npm run dev`, where there's no app to update. */
export async function updateInfo() {
  const inApp = !!status && Date.now() - status.at < 30_000;
  return { inApp, auto: (await loadPrefs()).auto, ...(inApp ? status : {}) };
}

export async function updateRequest(body: { auto?: unknown; check?: unknown; install?: unknown }) {
  if (typeof body.auto === 'boolean') {
    (await loadPrefs()).auto = body.auto;
    await writeJson('updates.json', prefs);
  }
  if (body.check) {
    asked.check = true;
    if (status?.state === 'idle' || status?.state === 'error') status.state = 'checking';
  }
  if (body.install && status?.state === 'ready') {
    asked.install = true;
    status.state = 'installing';
  }
}
```

- [ ] **Step 2:** `server/terminals.ts`: in `attach()`'s message handler, just before `this.host.send({ op: 'write', id, data: msg });` add `this.emit('input');`. In `write()` before `this.host.send(...)` add `this.emit('input');`.
- [ ] **Step 3:** `server/index.ts`:
  - import: `import { appReport, noteBusy, noteInput, updateInfo, updateRequest } from './updates.ts';`
  - after `terms.on('notification', pushNotification);` add `terms.on('input', noteInput);` with a comment `// Typing (any device) and Claude being busy hold back automatic updates (updates.ts).`
  - in `poll()` right after `const claude = …;` add `if (claude?.status === 'busy') noteBusy();`
  - after the `/api/remote/devices/:id` delete route add:

```ts
// Automatic updates (server/updates.ts): the Mac app reports here; Settings reads and asks.
app.post(
  '/api/update/report',
  wrap(async (req, res) => (onThisComputer(req) ? res.json(await appReport(req.body || {})) : res.status(403).json({ error: 'Not allowed' }))),
);
app.get('/api/update', wrap(async (_req, res) => res.json(await updateInfo())));
app.post(
  '/api/update',
  wrap(async (req, res) => {
    await updateRequest(req.body || {});
    res.json(await updateInfo());
  }),
);
```

- [ ] **Step 4:** `npx tsc --noEmit` → no errors. Commit.

### Task 4: the updater in the app

**Files:** Create `electron/updater.cjs`; modify `electron/main.cjs`, `scripts/build-app.mjs`.

- [ ] **Step 1:** `electron/updater.cjs`:

```js
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
```

- [ ] **Step 2:** `electron/main.cjs`:
  - require: `const { createUpdater } = require('./updater.cjs');`
  - after `const HIDDEN = …`: 
    ```js
    // After an automatic update the app restarts with --start-hidden if its window was hidden, so it stays out of the way.
    const START_HIDDEN = process.argv.includes('--start-hidden');
    ```
  - `createWindow`: `show: !HIDDEN && !START_HIDDEN,`
  - add after `waitForServer`:
    ```js
    // Stops the server and waits until it has let go of the port (an update does this before restarting the app).
    function stopServer() {
      quitting = true;
      const s = server;
      if (!s) return Promise.resolve();
      return new Promise((resolve) => {
        const t = setTimeout(() => (s.kill('SIGKILL'), resolve()), 5000);
        s.once('exit', () => (clearTimeout(t), resolve()));
        s.kill();
      });
    }
    ```
  - before `if (!app.requestSingleInstanceLock())`:
    ```js
    // Test copies (they set STUDIO_DATA_DIR) get their own Electron profile, so they never share the installed app's
    // single-instance lock, which would bring its window forward.
    if (process.env.STUDIO_DATA_DIR) app.setPath('userData', path.join(process.env.STUDIO_DATA_DIR, 'electron'));
    ```
  - in `whenReady`: create the updater first, wait for the port after an update, start it after `createWindow()`:
    ```js
    const updater = createUpdater({ app, origin: ORIGIN, windowHidden: () => !win || !win.isVisible(), stopServer });
    // Right after an update the old server can take a moment to let go of the port.
    for (let i = updater.justUpdated() ? 60 : 0; i > 0 && (await portInUse()); i--) await new Promise((r) => setTimeout(r, 250));
    if (await portInUse()) { …existing fail + quit… }
    …
    createWindow();
    updater.start();
    ```
- [ ] **Step 3:** `scripts/build-app.mjs`: `VERSION` from `--version` (else package.json), `OUT` from `--out` (else `release/out`); stage `package.json` uses `VERSION`; `directories.output: OUT`; copy the whole `electron/` dir except `*.test.cjs`:
    ```js
    fs.cpSync(path.join(ROOT, 'electron'), path.join(STAGE, 'electron'), { recursive: true, filter: (f) => !f.endsWith('.test.cjs') });
    ```
- [ ] **Step 4:** `node --check electron/updater.cjs electron/main.cjs`; `npm run test:update`; commit.

### Task 5: Settings rows

**Files:** Modify `src/components/SettingsMenu.tsx`.

- [ ] **Step 1:** add `<Updates />` after the desktop-notifications `Toggle`, and:

```tsx
type UpdateInfo = { inApp: boolean; auto: boolean; state?: string; current?: string; latest?: string; progress?: number; error?: string };

/** Version and automatic updates (done by the Mac app, see electron/updater.cjs). */
function Updates() {
  const [u, setU] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    const load = () => fetch('/api/update').then((r) => r.json()).then(setU).catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);
  const send = (body: object) =>
    fetch('/api/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .then(setU)
      .catch(() => {});
  if (!u) return null;
  if (!u.inApp) return <div className="px-3 py-2 text-[12px] text-muted">Updates come with the Mac app</div>;
  const line =
    u.state === 'checking' ? 'Checking for updates…'
    : u.state === 'downloading' ? `Downloading ${u.latest}${u.progress ? ` · ${u.progress}%` : ''}`
    : u.state === 'ready' ? `${u.latest} is ready${u.auto ? ' · installs when you’re idle' : ''}`
    : u.state === 'installing' ? `Installing ${u.latest}…`
    : u.state === 'move' ? 'Move Studio CLI to Applications to get updates'
    : u.state === 'error' ? `Couldn’t update: ${u.error}`
    : 'Up to date';
  const busy = u.state === 'checking' || u.state === 'downloading' || u.state === 'installing';
  return (
    <>
      <div className="flex items-center gap-3 rounded-xl px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink">Studio {u.current}</div>
          <div className="truncate text-[12px] text-muted" title={line}>{line}</div>
        </div>
        {u.state === 'ready' ? (
          <button onClick={() => send({ install: true })} className="shrink-0 rounded-full bg-violet px-3 py-1 text-[12px] font-medium text-white">
            Update now
          </button>
        ) : (
          u.state !== 'move' && (
            <button disabled={busy} onClick={() => send({ check: true })} className="shrink-0 rounded-full border border-[var(--line)] px-3 py-1 text-[12px] font-medium text-ink hover:bg-fill disabled:opacity-50">
              Check now
            </button>
          )
        )}
      </div>
      <Toggle label="Update automatically" hint="Restarts Studio when you’re idle; terminals keep running" on={u.auto} onClick={() => send({ auto: !u.auto })} />
    </>
  );
}
```

- [ ] **Step 2:** `npx tsc --noEmit`; commit.

### Task 6: end-to-end test (hidden)

**Files:** Create `scripts/test-update.mjs`.

Usage: `node scripts/test-update.mjs <old.dmg> <new.dmg>` (arm64, new is a higher version). It never touches the installed app: own temp folder, port 4741, `STUDIO_HIDDEN=1`, own data dir and Electron profile.

- [ ] **Step 1:** write the script (full code in the file; phases):
  1. Temp dir `T` under `os.tmpdir()`; test Ed25519 key; a broken copy of `new.dmg` (its `electron/main.cjs` replaced by one that exits, version bumped one patch, re-signed ad hoc, rebuilt with `hdiutil create`).
  2. Fake site on 127.0.0.1:4798 serving `/downloads.json` and `/download/arm64` from a mutable `offer` object.
  3. Install `old.dmg` into `T/Apps`, start it hidden with `STUDIO_UPDATE_URL/PUBKEY/TEST`.
  4. **Bad stamp:** offer `new` stamped by another key → `/api/update` state `error`, bundle still old.
  5. Open a terminal (`POST /api/terminals`, command `sleep 100000`).
  6. **Update:** offer `new` with a good stamp, `POST /api/update {check:true}` → server comes back as new version, the terminal is still there and alive, notification "Studio updated to …", `previous.app` and `pending.json` gone.
  7. **Rollback:** offer the broken build → after the watchdog, server back on the new version, notification "couldn't start", `skip.json` names the broken version, a further check stays `idle`.
  8. No on-screen windows for any test process (JXA `CGWindowListCopyWindowInfo` by owner pid).
  9. Cleanup: kill only processes whose command line contains `T`; delete `T`.
- [ ] **Step 2:** Build: `node scripts/build-app.mjs` (0.1.4 both chips) and `node scripts/build-app.mjs --version 0.1.5 --arch arm64 --out release/test-out`; run the script; expect `ALL PASSED`. Commit.

### Task 7: docs, release

- [ ] `AGENTS.md`: Run-it lines (`npm run test:update`, `npm run release`, `node scripts/test-update.mjs`); a bullet "Automatic updates" under how the pieces work; mention `release/test-out` is not committed (check `.gitignore`).
- [ ] `docs/LAUNCH.md` "New versions" → `npm run release -- --notes "…"`.
- [ ] Bump `version` to 0.1.4, merge `auto-update` into `main`, `npm run release -- --skip-build --notes "…"` (0.1.4 already built and tested), confirm the website serves 0.1.4 with stamps.
