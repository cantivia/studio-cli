import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.ts';

/**
 * The Mac app keeps its own Cloudflare tunnel running (so a phone can reach this computer) with the
 * cloudflared program bundled inside the app. Only when STUDIO_MANAGE_TUNNEL=1, which the app sets: a
 * Studio started from the repo with `npm run setup` has its tunnel run by a LaunchAgent instead.
 */
const TOKEN_FILE = path.join(DATA_DIR, 'tunnel-token');

export const managed = () => process.env.STUDIO_MANAGE_TUNNEL === '1';

function binary(): string | null {
  if (process.env.STUDIO_CLOUDFLARED && fs.existsSync(process.env.STUDIO_CLOUDFLARED)) return process.env.STUDIO_CLOUDFLARED;
  const which = spawnSync('which', ['cloudflared'], { encoding: 'utf8' }).stdout.trim();
  return which || null;
}

let child: ChildProcess | null = null;
let wanted = false;
let retry: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

function launch() {
  const bin = binary();
  if (!wanted || child || !bin || !fs.existsSync(TOKEN_FILE)) return;
  const log = fs.openSync(path.join(DATA_DIR, 'tunnel.log'), 'a');
  const started = Date.now();
  child = spawn(bin, ['tunnel', '--no-autoupdate', 'run', '--token-file', TOKEN_FILE], { stdio: ['ignore', log, log] });
  child.on('exit', () => {
    child = null;
    // Quick repeated failures back off (up to a minute) so a bad token doesn't spin.
    failures = Date.now() - started > 30_000 ? 0 : failures + 1;
    if (wanted) retry = setTimeout(launch, Math.min(60_000, 2000 * 2 ** failures));
  });
}

/** Starts (or restarts, after new settings) the tunnel if this Studio manages one and has a token. */
export function startTunnel() {
  if (!managed()) return;
  stopTunnel();
  wanted = true;
  failures = 0;
  launch();
}

export function stopTunnel() {
  wanted = false;
  clearTimeout(retry);
  child?.kill();
  child = null;
}

export const tunnelStatus = () => ({ managed: managed(), running: !!child, hasBinary: !!binary(), hasToken: fs.existsSync(TOKEN_FILE) });

process.on('exit', () => child?.kill());
