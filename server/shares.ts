import { randomBytes } from 'node:crypto';
import { readJson, writeJson } from './store.ts';

/**
 * Share links. Everyone runs their own Studio, so sharing hands someone a link into yours:
 *   https://<your host>/share/<secret>
 * The link opens a small standalone page (share-page.ts) served by your Studio. For a Claude session
 * that page shows the conversation and hands it to the visitor's own Studio; for a workspace it shows
 * your live terminals, view-only unless you allow typing. The secret is the only thing a link grants:
 * it names one session or one workspace, expires, and can be revoked at any time.
 */
export type Share = {
  token: string;
  kind: 'session' | 'workspace';
  /** Session id or workspace id. */
  ref: string;
  title: string;
  createdAt: number;
  expiresAt: number;
  /** Workspace links only: guests may type, not just watch. */
  canType: boolean;
};

const DAY = 86_400_000;
const FILE = 'shares.json';
let shares: Share[] | null = null;

async function all(): Promise<Share[]> {
  return (shares ??= await readJson<Share[]>(FILE, []));
}
const save = async () => writeJson(FILE, await all());

export async function listShares() {
  const now = Date.now();
  const list = await all();
  // Drop expired links in place, so everything keeps working on the one real list.
  const live = list.filter((s) => s.expiresAt > now);
  if (live.length !== list.length) {
    list.splice(0, list.length, ...live);
    await save();
  }
  return list;
}

export async function createShare(kind: Share['kind'], ref: string, title: string, days = 7): Promise<Share> {
  const list = await listShares();
  // One link per thing: sharing again returns (and renews) the existing one.
  const same = list.find((s) => s.kind === kind && s.ref === ref);
  if (same) {
    same.title = title;
    same.expiresAt = Date.now() + days * DAY;
    await save();
    return same;
  }
  const share: Share = { token: randomBytes(24).toString('base64url'), kind, ref, title, createdAt: Date.now(), expiresAt: Date.now() + days * DAY, canType: false };
  list.push(share);
  await save();
  return share;
}

export async function getShare(token: string): Promise<Share | null> {
  if (!/^[\w-]{20,64}$/.test(token)) return null;
  const s = (await all()).find((x) => x.token === token);
  return s && s.expiresAt > Date.now() ? s : null;
}

export async function revokeShare(token: string) {
  const list = await all();
  const i = list.findIndex((s) => s.token === token);
  if (i === -1) return false;
  list.splice(i, 1);
  await save();
  return true;
}

export async function updateShare(token: string, patch: { canType?: boolean }) {
  const s = (await all()).find((x) => x.token === token);
  if (!s) return null;
  if (typeof patch.canType === 'boolean') s.canType = patch.canType;
  await save();
  return s;
}
