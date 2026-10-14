#!/usr/bin/env node
/**
 * One-command setup for remote access: `npm run setup`.
 *
 * Gives you your own address (https://studio-<you>.<domain>) that reaches Studio on THIS computer,
 * locked to your email, plus a second rule so colleagues can open the share links you make.
 * It does the Cloudflare steps through Cloudflare's API (the token you paste is used once and never saved),
 * writes ~/.studio-cli/remote.json, and keeps the tunnel (and Studio) running in the background.
 *
 * Safe to re-run, and safe on a Studio that is already set up: if remote.json exists it only tightens
 * the lock to your email and adds the share-link rule. It never touches a Studio that is already running.
 *
 * Flags (all optional; it asks for anything missing):
 *   --email you@company.com   --host studio-you.company.com   --token <cloudflare api token>
 *   --no-service  don't install background services     --dry-run  show what would change, change nothing
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCloudflare, TOKEN_HELP } from './lib/cloudflare.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.STUDIO_DATA_DIR || path.join(os.homedir(), '.studio-cli');
const AGENTS = process.env.STUDIO_LAUNCH_AGENTS_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
const API = process.env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4';
const PORT = Number(process.env.PORT || 4600);

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i !== -1 ? args[i + 1] : undefined;
};
const DRY = flag('dry-run');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const step = (s) => console.log(`\n${bold(s)}`);
const done = (s) => console.log(`  ${green('✓')} ${s}`);
const note = (s) => console.log(`  ${dim(s)}`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// With no keyboard attached (a pipe, or CI) questions quietly take their default answer.
let closed = false;
rl.on('close', () => (closed = true));
const ask = (q, def) =>
  closed
    ? Promise.resolve(def || '')
    : new Promise((res) => rl.question(`  ${q}${def ? dim(` (${def})`) : ''}: `, (a) => res(a.trim() || def || '')));
const askSecret = (q) =>
  closed ? Promise.resolve('') : new Promise((res) => {
    const write = rl._writeToOutput;
    rl.question(`  ${q}: `, (a) => {
      rl._writeToOutput = write;
      rl.output.write('\n');
      res(a.trim());
    });
    // The prompt is already on screen; hide what's typed after it (the token is a password).
    rl._writeToOutput = () => {};
  });
const confirm = async (q, def = true) => {
  if (flag('yes')) return def;
  const a = (await ask(`${q} ${def ? '[Y/n]' : '[y/N]'}`)).toLowerCase();
  return a ? a.startsWith('y') : def;
};
const die = (msg) => {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
};

// ── Cloudflare API ──────────────────────────────────────────────────────────
let CF;
const portBusy = () =>
  new Promise((res) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.once('connect', () => (s.destroy(), res(true)));
    s.once('error', () => res(false));
  });

// ── Steps ───────────────────────────────────────────────────────────────────
console.log(`\n${bold('Studio CLI · remote access setup')}\n  Your own address for Studio on this computer, so your phone or iPad can reach it.`);
console.log(dim('  Only you can open it. Share links you make can be opened by your colleagues.'));
if (DRY) console.log(green('\n  Dry run: nothing will be changed.'));

if (Number(process.versions.node.split('.')[0]) < 20) die(`Node 20 or newer is needed (you have ${process.versions.node}).`);
if (!fs.existsSync(path.join(ROOT, 'node_modules'))) die('Run `npm install` first, then `npm run setup`.');

const existing = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'remote.json'), 'utf8'));
  } catch {
    return null;
  }
})();
const update = !!existing?.host && !!existing?.aud;

step('1. Who are you?');
let email = (opt('email') || process.env.STUDIO_EMAIL || '').toLowerCase();
if (!email) {
  let guess = '';
  try {
    guess = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim();
  } catch {}
  email = (await ask('Your work email (the one you sign in with)', /@/.test(guess) ? guess : '')).toLowerCase();
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) die('That doesn’t look like an email address.');
const name = email.split('@')[0].replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const mailDomain = email.split('@')[1];
done(email);
if (update) note(`Remote access is already set up at ${existing.host}. I'll lock it to just you and add share links; nothing else changes.`);

step('2. Cloudflare access');
console.log(TOKEN_HELP);
let TOKEN;
TOKEN = opt('token') || process.env.CLOUDFLARE_API_TOKEN || '';
if (!TOKEN) TOKEN = await askSecret('Paste the token');
if (!TOKEN) die('No token given.');
CF = createCloudflare({ token: TOKEN, api: API, dry: DRY, die, say: (m) => console.log(`  ${dim(m)}`) });
const { cf } = CF;
const account = await CF.pickAccount(async (accounts) => {
  accounts.forEach((a, i) => console.log(`    ${i + 1}. ${a.name}`));
  return accounts[Number(await ask('Which account is your company’s', '1')) - 1] || accounts[0];
});
const A = `/accounts/${account.id}`;
const team = (await CF.teamDomain(A)) || existing?.team;
if (!team) die('Cloudflare Zero Trust isn’t set up on this account yet. Open https://one.dash.cloudflare.com once, pick a team name (free plan is fine), then run this again.');
done(`${account.name} · ${team}`);

let host = existing?.host;
let aud = existing?.aud;
let shareAud;
let tunnelToken = '';

if (update) {
  step('3. Lock it to you');
  const apps = (await cf('GET', `${A}/access/apps?per_page=100`)) || [];
  const hit = apps.find((a) => a.aud === existing.aud) || apps.find((a) => a.domain === existing.host);
  if (!hit) die(`I couldn't find the Cloudflare Access app for ${existing.host}. Open Zero Trust → Access → Applications and check it exists.`);
  await cf('PUT', `${A}/access/apps/${hit.id}`, { ...CF.writable(hit), policies: CF.policyFor([{ email: { email } }], `Only ${email}`) });
  aud = hit.aud;
  done(`Only ${email} can open ${host}`);
  step('4. Share links');
  const share = await CF.ensureApp(A, { name: `Studio CLI share links (${name})`, domain: `${host}/share/*`, include: CF.shareAudience(email).include, label: CF.shareAudience(email).label });
  shareAud = share.aud;
  done(`${CF.shareAudience(email).describe} can open links you make (and nothing else)`);
} else {
  step('3. Your address');
  const domainGuess = mailDomain.includes('.') ? mailDomain : 'example.com';
  host = (opt('host') || process.env.STUDIO_HOST || (await ask('Address to use', `studio-${name}.${domainGuess}`))).toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) die('That doesn’t look like a web address.');
  const zone = await CF.findZone(account, host);
  if (!zone) die(`${host} isn’t on this Cloudflare account. Pick an address under a domain you manage there.`);
  done(host);

  step('4. Tunnel to this computer');
  tunnelToken = await CF.provisionTunnel(A, { name: `studio-${name}`, host, zone, port: PORT });
  done(`studio-${name} → ${host}`);

  step('5. Lock it to you, and open share links to your company');
  ({ aud, shareAud } = await CF.provisionAccess(A, { name, host, email, mailDomain }));
  done(`Only ${email} can open ${host}; ${CF.shareAudience(email).describe} can open links you make (and nothing else)`);
}

step(update ? '5. Save settings' : '6. Save settings');
const remote = { host, team, aud, allow: [email], shareAud, shareAllow: CF.shareAudience(email).allow };
if (!DRY) {
  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, 'remote.json');
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, JSON.stringify(remote, null, 2) + '\n');
  if (tunnelToken) fs.writeFileSync(path.join(DATA, 'tunnel-token'), tunnelToken, { mode: 0o600 });
}
done(`${path.join(DATA, 'remote.json')}${update ? dim(' (old one kept as remote.json.bak)') : ''}`);

// ── Background services (new setups only) ───────────────────────────────────
const plist = (label, program, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${program.map((a) => `<string>${a}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DATA}/${label.split('.').pop()}.log</string>
  <key>StandardErrorPath</key><string>${DATA}/${label.split('.').pop()}.log</string>${extra}
</dict></plist>
`;
function load(label, file) {
  if (process.env.STUDIO_NO_LAUNCHCTL === '1') return;
  const uid = String(process.getuid());
  spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, file], { encoding: 'utf8' });
  if (r.status !== 0) note(`Couldn't start ${label} (${r.stderr.trim()}). Load it later with: launchctl bootstrap gui/${uid} ${file}`);
}

let serverNote = '';
if (!update && !flag('no-service') && process.platform === 'darwin') {
  step('7. Keep it running');
  let cloudflared = spawnSync('which', ['cloudflared'], { encoding: 'utf8' }).stdout.trim();
  if (!cloudflared && !DRY && !flag('no-install')) {
    if (spawnSync('which', ['brew']).status === 0 && (await confirm('cloudflared (the tunnel program) isn’t installed. Install it with Homebrew?'))) {
      spawnSync('brew', ['install', 'cloudflared'], { stdio: 'inherit' });
      cloudflared = spawnSync('which', ['cloudflared'], { encoding: 'utf8' }).stdout.trim();
    }
  }
  if (!cloudflared && !DRY) {
    note('Install cloudflared (brew install cloudflared), then run: cloudflared tunnel run --token-file ~/.studio-cli/tunnel-token');
  } else {
    const file = path.join(AGENTS, 'com.studio-cli.tunnel.plist');
    if (!DRY) {
      fs.mkdirSync(AGENTS, { recursive: true });
      fs.writeFileSync(file, plist('com.studio-cli.tunnel', [cloudflared, 'tunnel', '--no-autoupdate', 'run', '--token-file', path.join(DATA, 'tunnel-token')]));
      load('com.studio-cli.tunnel', file);
    }
    done('Tunnel runs in the background, and starts at login');
  }
  if (await portBusy()) {
    serverNote = `Studio is already running on this computer (port ${PORT}), so I left it alone.`;
    note(serverNote);
  } else if (!DRY) {
    note('Building Studio (about 20 seconds)…');
    const b = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
    if (b.status !== 0) note('The build failed. Run `npm run build` to see why, then `npm run setup` again.');
    else {
      const file = path.join(AGENTS, 'com.studio-cli.server.plist');
      const env = `\n  <key>WorkingDirectory</key><string>${ROOT}</string>\n  <key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string><key>PATH</key><string>${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>`;
      fs.writeFileSync(file, plist('com.studio-cli.server', [process.execPath, path.join(ROOT, 'node_modules/.bin/tsx'), 'server/index.ts'], env));
      load('com.studio-cli.server', file);
      done('Studio runs in the background, and starts at login');
    }
  }
}

console.log(`\n${green(bold('All set.'))}
  ${bold(`https://${host}`)}  ← open this on your phone or iPad and sign in with ${email}
  ${dim('Your computer has to be on and awake. Studio keeps it from idle-sleeping while it runs.')}
${update ? `  ${dim('Restart Studio\'s web server (Vite) once so it picks up the settings.')}\n` : ''}
  Share something: ${bold('Share link')} on a conversation (Sessions tab) or the link icon on a workspace.
  Open something shared with you: Shared tab → paste the link.
`);
rl.close();
