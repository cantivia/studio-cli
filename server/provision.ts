import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.ts';

/**
 * Self-serve remote access: the app asks a small provisioning service (provisioner/worker.mjs, run on the
 * Cloudflare account that owns the domain) for its own address and tunnel. The service never sees terminals or
 * traffic. It only creates the tunnel and the DNS record, and hands back the tunnel token. This computer is
 * identified to it by a random install id that never leaves it except in these calls.
 */
const PROVISIONER = (process.env.STUDIO_PROVISIONER || 'https://studio-api.cantivia.com').replace(/\/$/, '');
const ID_FILE = path.join(DATA_DIR, 'install-id');

function installId() {
  try {
    return fs.readFileSync(ID_FILE, 'utf8').trim();
  } catch {
    const id = randomBytes(32).toString('hex');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ID_FILE, id, { mode: 0o600 });
    return id;
  }
}

async function call(route: string, body: unknown) {
  let r: Response;
  try {
    r = await fetch(`${PROVISIONER}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('Couldn’t reach the Studio connection service. Check your internet connection and try again.');
  }
  const j: any = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || `The connection service said no (${r.status}). Try again in a minute.`);
  return j;
}

/** Gets (or re-fetches) this computer's address and tunnel token. Safe to call again: the same address comes back. */
export async function enableRemote(): Promise<{ host: string; tunnelToken: string }> {
  const j = await call('/v1/register', { installId: installId() });
  if (typeof j?.host !== 'string' || typeof j?.tunnelToken !== 'string') throw new Error('The connection service sent something unexpected.');
  return { host: j.host, tunnelToken: j.tunnelToken };
}

/** Gives the address back. Best effort: disconnecting still works if the service is unreachable. */
export async function releaseRemote() {
  await call('/v1/release', { installId: installId() }).catch(() => {});
}
