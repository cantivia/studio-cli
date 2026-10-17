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
