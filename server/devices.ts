import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readJson, writeJson } from './store.ts';

/**
 * Pairing: how a phone or iPad gets into your Studio without any email or account.
 *
 * On this computer you press "Add a phone", which makes a short single-use code (shown as text and a QR
 * code). On the phone you open your Studio address and enter it. The phone then holds a long random device
 * cookie; only a hash of it is kept here, and you can remove a device at any time. Codes expire after five
 * minutes, work once, and wrong guesses are rate-limited, so they can't be brute-forced.
 */
export type Device = { id: string; hash: string; name: string; createdAt: number; lastSeen: number };

const FILE = 'devices.json';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L lookalikes
const CODE_TTL = 5 * 60_000;

let devices: Device[] | null = null;
const all = async () => (devices ??= await readJson<Device[]>(FILE, []));
const save = async () => writeJson(FILE, await all());
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// Pending pairing codes live in memory only: a restart simply invalidates them.
const codes = new Map<string, number>(); // code → expiry
const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function newPairingCode() {
  const bytes = randomBytes(8);
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  for (const [c, exp] of codes) if (exp < Date.now()) codes.delete(c);
  codes.set(code, Date.now() + CODE_TTL);
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: Date.now() + CODE_TTL };
}

// Wrong guesses: a few per minute per address, and a global brake so spreading guesses across addresses doesn't help.
const byIp = new Map<string, number[]>();
let globalFails: number[] = [];
let lockedUntil = 0;
const recent = (list: number[], ms: number) => list.filter((t) => t > Date.now() - ms);

export type ClaimResult = { ok: true; token: string } | { ok: false; reason: 'bad' | 'slow-down' };

/** Turns a valid code into a device token. Every failure looks the same to the caller. */
export async function claimCode(raw: string, ip: string, userAgent: string): Promise<ClaimResult> {
  if (Date.now() < lockedUntil) return { ok: false, reason: 'slow-down' };
  const mine = recent(byIp.get(ip) || [], 60_000);
  if (mine.length >= 5) return { ok: false, reason: 'slow-down' };
  const code = normalize(raw);
  const exp = codes.get(code);
  if (!exp || exp < Date.now()) {
    byIp.set(ip, [...mine, Date.now()]);
    globalFails = [...recent(globalFails, 10 * 60_000), Date.now()];
    if (globalFails.length >= 30) lockedUntil = Date.now() + 10 * 60_000;
    return { ok: false, reason: 'bad' };
  }
  codes.delete(code); // single use
  const token = randomBytes(32).toString('base64url');
  const list = await all();
  list.push({ id: randomBytes(6).toString('hex'), hash: sha(token), name: deviceName(userAgent), createdAt: Date.now(), lastSeen: Date.now() });
  await save();
  return { ok: true, token };
}

function deviceName(ua: string) {
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac browser';
  if (/Windows/.test(ua)) return 'Windows browser';
  return 'Browser';
}

let lastTouch = 0;
/** True if this cookie value belongs to a paired device. */
export async function verifyDevice(token: string | undefined): Promise<boolean> {
  if (!token || token.length < 30 || token.length > 100) return false;
  const h = Buffer.from(sha(token));
  const list = await all();
  const hit = list.find((d) => {
    const x = Buffer.from(d.hash);
    return x.length === h.length && timingSafeEqual(x, h);
  });
  if (!hit) return false;
  if (Date.now() - hit.lastSeen > 60_000 && Date.now() - lastTouch > 5_000) {
    hit.lastSeen = lastTouch = Date.now();
    save().catch(() => {});
  }
  return true;
}

export const listDevices = async () => (await all()).map(({ hash: _h, ...d }) => d);

export async function removeDevice(id: string) {
  const list = await all();
  const i = list.findIndex((d) => d.id === id);
  if (i === -1) return false;
  list.splice(i, 1);
  await save();
  return true;
}

export async function removeAllDevices() {
  (await all()).length = 0;
  codes.clear();
  await save();
}
