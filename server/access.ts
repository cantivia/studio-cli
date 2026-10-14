import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import { DATA_DIR } from './store.ts';
import { verifyDevice } from './devices.ts';

/**
 * Remote access (e.g. from an iPad) goes through a Cloudflare Tunnel with Cloudflare Access in front.
 * Access already blocks strangers at the edge; this is the second lock: any request that didn't come
 * from this Mac must carry a valid Access token for an allowed account, or it gets a 403.
 * Without ~/.studio-cli/remote.json every non-local request is refused.
 *
 * There are two ways to be let in from outside, set by `mode` in remote.json:
 *  - "pairing" (the Mac app's default, no accounts or emails): a phone pairs once with a short code made on
 *    this computer and then carries a device cookie (devices.ts). Anyone can use it; nobody gets in unpaired.
 *  - "access" (the original): Cloudflare Access with an email allow-list, described below.
 *
 * Every person runs their own Studio on their own computer, with their own tunnel, hostname and
 * Access app, and `allow` lists only them. The one exception is share links (/share/*): a second
 * Access app covers just that path and lets colleagues in (`shareAllow`), and the server still
 * requires the link's secret token (shares.ts) before showing them anything.
 */
export type RemoteConfig = {
  /** "pairing" (default for the Mac app) or "access" (Cloudflare Access with an email allow-list). */
  mode?: 'access' | 'pairing';
  /** Public hostname, e.g. studio-cli.cantivia.com */
  host: string;
  /** Access mode: Zero Trust team domain, e.g. cantivia.cloudflareaccess.com */
  team?: string;
  /** Access mode: the Access application's AUD tag */
  aud?: string;
  /** Access mode: allowed accounts, full emails or "@domain.com". Normally just you. */
  allow?: string[];
  /** AUD tag of a second Access app that covers only <host>/share/* so others can open your share links. */
  shareAud?: string;
  /** Accounts that may open share links. Defaults to `allow`. */
  shareAllow?: string[];
};

const CONFIG = path.join(DATA_DIR, 'remote.json');

let cached: { mtime: number; cfg: RemoteConfig | null } | null = null;
export function remoteConfig(): RemoteConfig | null {
  try {
    const mtime = fs.statSync(CONFIG).mtimeMs;
    if (cached?.mtime !== mtime) {
      const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
      const ok =
        typeof c.host === 'string' &&
        (c.mode === 'pairing' ? /^[a-z0-9.-]+\.[a-z]{2,}$/.test(c.host) : c.team && c.aud && Array.isArray(c.allow) && c.allow.length);
      cached = { mtime, cfg: ok ? c : null };
    }
    return cached.cfg;
  } catch {
    return null;
  }
}

export const isAllowedOrigin = (origin: string) =>
  /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin) || origin === `https://${remoteConfig()?.host}`;

let certs: { at: number; keys: Map<string, crypto.KeyObject> } | null = null;
async function signingKey(team: string, kid: string) {
  const stale = !certs || Date.now() - certs.at > 3600_000;
  // Refetch for an unknown kid (Cloudflare rotates keys), but at most every 30s.
  const unknown = certs && !certs.keys.has(kid) && Date.now() - certs.at > 30_000;
  if (stale || unknown) {
    const r = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
    const { keys } = (await r.json()) as { keys: (crypto.webcrypto.JsonWebKey & { kid: string })[] };
    certs = { at: Date.now(), keys: new Map(keys.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })])) };
  }
  return certs!.keys.get(kid);
}

/**
 * Only plain share-link paths get the narrower rule: /share/<token>, /share/_/<file>, /share/api/<token>[/transcript]
 * and /share/ws/<token>/term/<id>. Anything odd (dot segments, encoded slashes, doubled slashes) is treated as an
 * ordinary path, so `/share/../api/state` can never ride on a share-link login.
 */
export function isSharePath(p: string) {
  let path = p;
  try {
    path = decodeURIComponent(p);
  } catch {
    return false;
  }
  if (path !== p && /[%\\]/.test(path)) return false;
  const parts = path.split('/');
  return parts[0] === '' && parts[1] === 'share' && parts.length >= 3 && parts.slice(2).every((seg) => /^[\w-]+(\.(js|css))?$/.test(seg));
}

async function verify(token: string, cfg: RemoteConfig & { team: string; aud: string; allow: string[] }, share: boolean): Promise<string | null> {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (header.alg !== 'RS256') return null;
  const key = await signingKey(cfg.team, header.kid);
  if (!key || !crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) return null;
  const c = JSON.parse(Buffer.from(p, 'base64url').toString());
  const now = Date.now() / 1000;
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== `https://${cfg.team}` || !(c.exp > now) || (c.nbf && c.nbf > now + 60)) return null;
  // Only the share-link app's token is accepted on /share/*, and it never works anywhere else.
  const owner = aud.includes(cfg.aud);
  if (!owner && !(share && cfg.shareAud && aud.includes(cfg.shareAud))) return null;
  const list = owner ? cfg.allow : cfg.shareAllow || cfg.allow;
  const email = String(c.email || '').toLowerCase();
  const allowed = list.some((a) => (a.startsWith('@') ? email.endsWith(a.toLowerCase()) : email === a.toLowerCase()));
  return allowed ? email : null;
}

export const DEVICE_COOKIE = 'studio_device';

/** Pages and files a not-yet-paired phone may fetch: the pairing page itself and the icons the install prompt needs. */
const PUBLIC_FILES = new Set([
  '/pair',
  '/pair/claim',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/favicon-16.png',
  '/favicon-64.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
]);

const cookie = (headers: IncomingHttpHeaders, name: string) =>
  headers.cookie?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

/** true for requests made on this Mac; otherwise needs a valid Cloudflare Access token. `urlPath` picks the share-link rules. */
export async function checkAccess(headers: IncomingHttpHeaders, urlPath = '/'): Promise<boolean> {
  const host = (headers.host || '').replace(/:\d+$/, '');
  // Anything Cloudflare forwarded is remote, whatever Host it claims.
  const viaCloudflare = Boolean(headers['cf-ray'] || headers['cf-connecting-ip']);
  if (!viaCloudflare && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(host)) return true;
  const cfg = remoteConfig();
  if (!cfg || host !== cfg.host) return false;
  if (cfg.mode === 'pairing') {
    // Share links are open to anyone holding the secret link (shares.ts checks it); the rest needs a paired device.
    if (PUBLIC_FILES.has(urlPath) || isSharePath(urlPath)) return true;
    return verifyDevice(cookie(headers, DEVICE_COOKIE));
  }
  if (!cfg.team || !cfg.aud || !cfg.allow) return false;
  const token = (headers['cf-access-jwt-assertion'] as string | undefined) || cookie(headers, 'CF_Authorization');
  if (!token) return false;
  try {
    return Boolean(await verify(token, cfg as RemoteConfig & { team: string; aud: string; allow: string[] }, isSharePath(urlPath)));
  } catch {
    return false;
  }
}
