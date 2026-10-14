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
let TOKEN = '';
async function cf(method, route, body) {
  if (DRY && method !== 'GET') {
    console.log(`  ${dim(`[dry run] ${method} ${route}`)}${body ? dim(' ' + JSON.stringify(body).slice(0, 140)) : ''}`);
    return { id: 'dry-run-id', aud: 'dry-run-aud', token: 'dry-run-token' };
  }
  let r;
  try {
    r = await fetch(API + route, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    die(`Couldn't reach Cloudflare (${e.message}). Check your internet connection.`);
  }
  const j = await r.json().catch(() => null);
  if (!j?.success) {
    const m = j?.errors?.map((e) => e.message).join('; ') || `${r.status} ${r.statusText}`;
    const hint = /auth|permission|forbidden|unauthori/i.test(m) ? '\n    The token is missing a permission. Re-create it using the list shown above.' : '';
    die(`Cloudflare said no: ${m} (${method} ${route})${hint}`);
  }
  return j.result;
}

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
console.log(`  I need a Cloudflare API token, used once and never saved. Make one at:
    ${bold('https://dash.cloudflare.com/profile/api-tokens')} → Create Token → Create Custom Token, with these permissions:
      • Account · Cloudflare Tunnel · Edit
      • Account · Access: Apps and Policies · Edit
      • Account · Access: Organizations, Identity Providers, and Groups · Read
      • Account · Account Settings · Read
      • Zone · DNS · Edit`);
TOKEN = opt('token') || process.env.CLOUDFLARE_API_TOKEN || '';
if (!TOKEN) TOKEN = await askSecret('Paste the token');
if (!TOKEN) die('No token given.');
const accounts = await cf('GET', '/accounts?per_page=50');
if (!accounts.length) die('That token can’t see any Cloudflare account.');
let account = accounts[0];
if (accounts.length > 1) {
  accounts.forEach((a, i) => console.log(`    ${i + 1}. ${a.name}`));
  account = accounts[Number(await ask('Which account is your company’s', '1')) - 1] || accounts[0];
}
const A = `/accounts/${account.id}`;
const org = await cf('GET', `${A}/access/organizations`).catch(() => null);
const team = org?.auth_domain || existing?.team;
if (!team) die('Cloudflare Zero Trust isn’t set up on this account yet. Open https://one.dash.cloudflare.com once, pick a team name (free plan is fine), then run this again.');
done(`${account.name} · ${team}`);

// What Cloudflare returns for an app includes read-only fields it won't accept back on an update.
const writable = ({ id, uid, aud, created_at, updated_at, ...rest }) => rest;
const policyFor = (include, label) => [{ name: label, decision: 'allow', include, precedence: 1 }];
const emailRule = [{ email: { email } }];
const domainRule = [{ email_domain: { domain: mailDomain } }];

/** Finds or creates an Access app by its exact domain, always (re)setting who may enter. */
async function ensureApp(appName, domain, include, label) {
  const apps = (await cf('GET', `${A}/access/apps?per_page=100`)) || [];
  const hit = apps.find((a) => a.domain === domain);
  const body = { name: appName, domain, type: 'self_hosted', session_duration: '168h', policies: policyFor(include, label) };
  if (hit) return { ...(await cf('PUT', `${A}/access/apps/${hit.id}`, { ...writable(hit), ...body })), aud: hit.aud, reused: true };
  return cf('POST', `${A}/access/apps`, body);
}

let host = existing?.host;
let aud = existing?.aud;
let tunnelToken = '';

if (!update) {
  step('3. Your address');
  const domainGuess = mailDomain.includes('.') ? mailDomain : 'example.com';
  host = (opt('host') || process.env.STUDIO_HOST || (await ask('Address to use', `studio-${name}.${domainGuess}`))).toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) die('That doesn’t look like a web address.');
  // The zone is the part of the address Cloudflare manages (e.g. company.com).
  let zone = null;
  for (let parts = host.split('.'); parts.length >= 2 && !zone; parts = parts.slice(1)) {
    zone = (await cf('GET', `/zones?name=${parts.join('.')}&account.id=${account.id}`))?.[0] || null;
  }
  if (!zone) die(`${host} isn’t on this Cloudflare account. Pick an address under a domain you manage there.`);
  done(host);

  step('4. Tunnel to this computer');
  const tName = `studio-${name}`;
  const tunnels = (await cf('GET', `${A}/cfd_tunnel?name=${tName}&is_deleted=false`)) || [];
  const tunnel = tunnels[0] || (await cf('POST', `${A}/cfd_tunnel`, { name: tName, config_src: 'cloudflare' }));
  await cf('PUT', `${A}/cfd_tunnel/${tunnel.id}/configurations`, {
    config: { ingress: [{ hostname: host, service: `http://127.0.0.1:${PORT}` }, { service: 'http_status:404' }] },
  });
  tunnelToken = await cf('GET', `${A}/cfd_tunnel/${tunnel.id}/token`);
  const dns = (await cf('GET', `/zones/${zone.id}/dns_records?name=${host}`)) || [];
  const record = { type: 'CNAME', name: host, content: `${tunnel.id}.cfargotunnel.com`, proxied: true };
  if (dns[0]) await cf('PUT', `/zones/${zone.id}/dns_records/${dns[0].id}`, record);
  else await cf('POST', `/zones/${zone.id}/dns_records`, record);
  done(`${tName} → ${host}`);
}

step(update ? '3. Lock it to you' : '5. Lock it to you');
const main = update
  ? await (async () => {
      const apps = (await cf('GET', `${A}/access/apps?per_page=100`)) || [];
      const hit = apps.find((a) => a.aud === existing.aud) || apps.find((a) => a.domain === existing.host);
      if (!hit) die(`I couldn't find the Cloudflare Access app for ${existing.host}. Open Zero Trust → Access → Applications and check it exists.`);
      return { ...(await cf('PUT', `${A}/access/apps/${hit.id}`, { ...writable(hit), policies: policyFor(emailRule, `Only ${email}`) })), aud: hit.aud };
    })()
  : await ensureApp(`Studio CLI (${name})`, host, emailRule, `Only ${email}`);
aud = main.aud || aud;
done(`Only ${email} can open ${host}`);

step(update ? '4. Share links' : '6. Share links');
const share = await ensureApp(`Studio CLI share links (${name})`, `${host}/share/*`, domainRule, `Anyone at @${mailDomain}`);
done(`Colleagues at @${mailDomain} can open links you make (and nothing else)`);

step(update ? '5. Save settings' : '7. Save settings');
const remote = { host, team, aud, allow: [email], shareAud: share.aud, shareAllow: [`@${mailDomain}`] };
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
  step('8. Keep it running');
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
