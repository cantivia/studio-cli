#!/usr/bin/env node
/**
 * `npm run invite -- --email them@company.com` — for whoever runs the company's Cloudflare.
 *
 * Makes a teammate's own secure address (tunnel + DNS + an Access app locked to their email + the share-link
 * app) and prints a one-time invite code. They paste it into the Studio Mac app (Settings → Phone & remote
 * access) and that's their whole setup: no Cloudflare account, no token, no terminal. The code holds the
 * tunnel's secret, so send it privately. Safe to run again: it reuses what exists and prints the same invite.
 *
 *   --email them@company.com   --token <cloudflare api token>   --host studio-them.company.com   --dry-run
 */
import { execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { createCloudflare, TOKEN_HELP } from './lib/cloudflare.mjs';

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i !== -1 ? args[i + 1] : undefined;
};
const DRY = args.includes('--dry-run');
const API = process.env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4';
// The Mac app serves Studio on this port; the tunnel is pointed at it.
const PORT = 4600;
const INVITE_PREFIX = 'studio-invite:';

const die = (m) => {
  console.error(`\n  ✗ ${m}\n`);
  process.exit(1);
};
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on('close', () => (closed = true));
const ask = (q, def) => (closed ? Promise.resolve(def || '') : new Promise((res) => rl.question(`  ${q}${def ? ` (${def})` : ''}: `, (a) => res(a.trim() || def || ''))));
const askSecret = (q) =>
  closed
    ? Promise.resolve('')
    : new Promise((res) => {
        const write = rl._writeToOutput;
        rl.question(`  ${q}: `, (a) => ((rl._writeToOutput = write), rl.output.write('\n'), res(a.trim())));
        rl._writeToOutput = () => {};
      });

console.log('\n\x1b[1mStudio CLI · invite a teammate\x1b[0m');
if (DRY) console.log('  Dry run: nothing will be changed.');
let email = (opt('email') || '').toLowerCase();
if (!email) email = (await ask('Their work email')).toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) die('That doesn’t look like an email address.');
const name = email.split('@')[0].replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const mailDomain = email.split('@')[1];

console.log(TOKEN_HELP);
let token = opt('token') || process.env.CLOUDFLARE_API_TOKEN || '';
if (!token) token = await askSecret('Paste the token');
if (!token) die('No token given.');
const CF = createCloudflare({ token, api: API, dry: DRY, die, say: (m) => console.log(`  \x1b[2m${m}\x1b[0m`) });

const account = await CF.pickAccount(async (accounts) => {
  accounts.forEach((a, i) => console.log(`    ${i + 1}. ${a.name}`));
  return accounts[Number(await ask('Which account is your company’s', '1')) - 1] || accounts[0];
});
const A = `/accounts/${account.id}`;
const team = await CF.teamDomain(A);
if (!team) die('Cloudflare Zero Trust isn’t set up on this account yet. Open https://one.dash.cloudflare.com once, pick a team name, then run this again.');
const host = (opt('host') || `studio-${name}.${mailDomain}`).toLowerCase();
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) die('That doesn’t look like a web address.');
const zone = await CF.findZone(account, host);
if (!zone) die(`${host} isn’t on this Cloudflare account. Pass --host with an address under a domain you manage here.`);

console.log(`\n  Creating ${host} for ${email}…`);
const tunnelToken = await CF.provisionTunnel(A, { name: `studio-${name}`, host, zone, port: PORT });
const { aud, shareAud } = await CF.provisionAccess(A, { name, host, email, mailDomain });

const invite = { v: 1, email, host, team, aud, allow: [email], shareAud, shareAllow: CF.shareAudience(email).allow, tunnelToken };
const code = INVITE_PREFIX + Buffer.from(JSON.stringify(invite)).toString('base64url');
try {
  if (!DRY) execFileSync('pbcopy', { input: code });
} catch {}
console.log(`
  \x1b[32m\x1b[1mInvite ready${DRY ? ' (dry run, not usable)' : ' (copied to your clipboard)'}.\x1b[0m
  Send this to ${email} privately (it contains a secret, like a password):

${code}

  They then: install the Studio app, open it, press Settings → Phone & remote access, paste the code.
  Their address will be https://${host}
`);
rl.close();
