#!/usr/bin/env node
/**
 * `npm run switch-to-app` — moves a Studio you run from the code (npm run dev) over to the Mac app, keeping every
 * terminal and Claude session running. `--dry-run` shows what it would do; `--undo` puts things back.
 *
 * Your terminals live in a background process that outlives the web server, so stopping the dev server and opening
 * the app reattaches to the same shells, with their history. Workspaces, Claude history and your shell setup
 * (~/.studio-cli, ~/.claude, ~/.zshrc) are shared by both, so nothing is copied or lost.
 *
 * What it does, in order:
 *   1. checks the app is installed and notes your running terminals
 *   2. stops the dev servers (only processes that really are Studio)
 *   3. turns off the old Cloudflare tunnel and moves its files to ~/.studio-cli/old-remote (reversible)
 *   4. opens the app and checks every terminal came across
 * It never deletes anything, and never touches Cloudflare.
 *
 * Test overrides: STUDIO_DATA_DIR, STUDIO_LAUNCH_AGENTS_DIR, STUDIO_NO_LAUNCHCTL=1, STUDIO_APP_EXE (run this binary
 * instead of `open -a`), STUDIO_APP_PORT (4600), STUDIO_DEV_PORTS ("4600,4610").
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const UNDO = args.includes('--undo');
const DATA = process.env.STUDIO_DATA_DIR || path.join(os.homedir(), '.studio-cli');
const AGENTS = process.env.STUDIO_LAUNCH_AGENTS_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
const APP_PORT = Number(process.env.STUDIO_APP_PORT || 4600);
const DEV_PORTS = (process.env.STUDIO_DEV_PORTS || '4600,4610').split(',').map(Number);
const OLD = path.join(DATA, 'old-remote');
const LABEL = 'com.studio-cli.tunnel';
const PLIST = path.join(AGENTS, `${LABEL}.plist`);
const APPS = ['/Applications/Studio CLI.app', path.join(os.homedir(), 'Applications', 'Studio CLI.app')];

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const step = (s) => console.log(`\n${bold(s)}`);
const done = (s) => console.log(`  ${green('✓')} ${s}`);
const would = (s) => console.log(`  ${dim('[dry run] ' + s)}`);
const die = (m) => (console.error(`\n  ✗ ${m}\n`), process.exit(1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, a) => {
  try {
    return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};
const move = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
};

async function state(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    return j?.type === 'state' ? j : null;
  } catch {
    return null;
  }
}

const appBinary = () => {
  if (process.env.STUDIO_APP_EXE) return process.env.STUDIO_APP_EXE;
  const app = APPS.find((a) => fs.existsSync(a));
  return app && path.join(app, 'Contents/MacOS/Studio CLI');
};

console.log(`\n${bold(UNDO ? 'Studio CLI · switch back to the code version' : 'Studio CLI · switch to the Mac app')}`);
if (DRY) console.log(green('  Dry run: nothing will be changed.'));

// ── Undo ────────────────────────────────────────────────────────────────────
if (UNDO) {
  step('1. Quitting the app');
  const exe = appBinary();
  if (exe && !DRY) sh('pkill', ['-f', exe]); // the exact program path, never the Chrome app of the same name
  else if (exe) would(`quit ${exe}`);
  done('App closed (your terminals keep running)');
  step('2. Putting the old remote settings back');
  if (!fs.existsSync(OLD)) die(`Nothing to restore: ${OLD} doesn't exist.`);
  for (const f of ['remote.json', 'tunnel-token']) {
    const from = path.join(OLD, f);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(path.join(DATA, f))) {
      console.log(`  ${dim(`${f} already exists in ${DATA}; left as is`)}`);
      continue;
    }
    DRY ? would(`restore ${f}`) : move(from, path.join(DATA, f));
    done(`restored ${f}`);
  }
  const plist = path.join(OLD, `${LABEL}.plist`);
  if (fs.existsSync(plist)) {
    if (DRY) would(`restore ${PLIST} and start it`);
    else {
      move(plist, PLIST);
      if (process.env.STUDIO_NO_LAUNCHCTL !== '1') sh('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST]);
    }
    done('old tunnel switched back on');
  }
  console.log(`\n${green(bold('Done.'))} Start the code version again with ${bold('npm run dev')} in the studio-cli folder.\n`);
  process.exit(0);
}

// ── Switch ──────────────────────────────────────────────────────────────────
step('1. Checking');
const exe = appBinary();
if (!exe || !fs.existsSync(exe)) die('The Studio CLI app isn’t installed. Open the downloaded file and drag Studio CLI to Applications first, then run this again.');
done(`App found: ${path.dirname(path.dirname(path.dirname(exe)))}`);
if (!fs.existsSync(DATA)) die(`${DATA} doesn't exist. Nothing to move.`);

// Which port has the current (code) Studio? Remember its terminals to prove they all come across.
let before = null;
for (const p of DEV_PORTS) before = before || (await state(p));
const ids = before ? before.terminals.map((t) => t.id) : [];
done(before ? `Your Studio is running with ${ids.length} terminal${ids.length === 1 ? '' : 's'}` : 'No code version is running right now');

// If the app's port isn't one the code version uses, anything on it is a stranger: say so before stopping anything.
if (!DEV_PORTS.includes(APP_PORT) && (await state(APP_PORT))) die(`Something is already serving Studio on port ${APP_PORT} (another Studio, or the app already open). Quit it, then run this again. Nothing has been changed.`);

step('2. Stopping the code version (your terminals keep running)');
const DEV = /concurrently|npm run dev|npm exec|tsx|vite|node .*server\/index\.ts/;
const listeners = new Set();
for (const p of DEV_PORTS) for (const pid of sh('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t']).split('\n').filter(Boolean).map(Number)) {
  // Only things that really are Studio: the API answers /api/state, or it's the Vite server in front of it.
  const cmd = sh('ps', ['-o', 'command=', '-p', String(pid)]).trim();
  if ((await state(p)) || /vite/.test(cmd)) listeners.add(pid);
}
const toStop = new Set(listeners);
for (const pid of listeners) {
  // Walk up to the commands that started them (npm run dev, tsx watch, concurrently), but never past those.
  let cur = pid;
  for (let i = 0; i < 6; i++) {
    const ppid = Number(sh('ps', ['-o', 'ppid=', '-p', String(cur)]).trim());
    const cmd = sh('ps', ['-o', 'command=', '-p', String(ppid)]).trim();
    if (!ppid || ppid === 1 || !DEV.test(cmd)) break;
    toStop.add(ppid);
    cur = ppid;
  }
}
if (!toStop.size) done('Nothing to stop');
else if (DRY) would(`stop ${[...toStop].join(', ')}`);
else {
  for (const pid of toStop) try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 20 && DEV_PORTS.some((p) => sh('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t']).trim()); i++) await sleep(250);
  const stuck = DEV_PORTS.filter((p) => sh('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t']).trim());
  if (stuck.length) die(`Something is still using port ${stuck.join(', ')}. Close it, then run this again. (Nothing else has been changed.)`);
  done(`Stopped ${toStop.size} process${toStop.size === 1 ? '' : 'es'}. Terminals live in a separate background process and are untouched.`);
}

// Whatever is on the app's port now would be mistaken for the app, so it has to be free.
if (!DRY && (await state(APP_PORT))) die(`Something is still serving Studio on port ${APP_PORT} after the code version was stopped (another Studio, or the app already open). Quit it, then run this again. Only the code version has been stopped so far: your terminals are fine, and ${bold('npm run dev')} starts it again.`);

step('3. Turning off the old Cloudflare tunnel');
const moved = [];
if (fs.existsSync(PLIST)) {
  if (DRY) would(`stop ${LABEL} and move its file to ${OLD}`);
  else {
    if (process.env.STUDIO_NO_LAUNCHCTL !== '1') sh('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
    move(PLIST, path.join(OLD, `${LABEL}.plist`));
  }
  moved.push(`${LABEL}.plist`);
}
for (const f of ['remote.json', 'tunnel-token']) {
  const from = path.join(DATA, f);
  if (!fs.existsSync(from)) continue;
  DRY ? would(`move ${f} to ${OLD}`) : move(from, path.join(OLD, f));
  moved.push(f);
}
done(moved.length ? `Moved aside (not deleted): ${moved.join(', ')}  →  ${OLD}` : 'No old tunnel settings found');

step('4. Opening the app');
if (DRY) would(`open the app and check ${ids.length} terminals appear`);
else {
  if (process.env.STUDIO_APP_EXE) spawn(exe, [], { detached: true, stdio: 'ignore', env: { ...process.env, STUDIO_PORT: String(APP_PORT) } }).unref();
  else spawn('open', ['-a', path.dirname(path.dirname(path.dirname(exe)))], { stdio: 'ignore' }).unref();
  let after = null;
  for (let i = 0; i < 80 && !after; i++) (await sleep(500), (after = await state(APP_PORT)));
  if (!after) die(`The app didn't come up on port ${APP_PORT}. Run ${bold('npm run switch-to-app -- --undo')} to go back.`);
  const have = new Set(after.terminals.map((t) => t.id));
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length) die(`The app is up, but ${missing.length} of your ${ids.length} terminals didn't come across (${missing.join(', ')}). Run ${bold('npm run switch-to-app -- --undo')} to go back.`);
  done(`App is up, and all ${ids.length} of your terminals are in it`);
}

console.log(`
${green(bold('Done.'))} You're now on the Mac app.
  • Phone and iPad: in the app, Settings → Phone & remote access → Turn on phone access.
  • The old "Studio CLI" Chrome app pointed at the code version, so you can delete it (Chrome → chrome://apps → right-click → Remove).
  • To go back: ${bold('npm run switch-to-app -- --undo')}, then ${bold('npm run dev')}.
`);
