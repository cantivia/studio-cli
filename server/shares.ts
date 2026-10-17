import { randomBytes } from 'node:crypto';
import { deviceName } from './devices.ts';
import { expiryFor, isLasts, isLive } from './links-core.ts';
import { readJson, writeJson } from './store.ts';

/**
 * Share links. Everyone runs their own Studio, so sharing hands someone a link into yours:
 *   https://<your host>/share/<secret>
 * The link opens a small standalone page (share-page.ts) served by your Studio. For a Claude session
 * that page shows the conversation and hands it to the visitor's own Studio; for a workspace it shows
 * your live terminals, view-only unless you allow typing; a pane link shows just one terminal. A claude link
 * connects a teammate's Claude to one of yours (claude-links.ts). The secret is the only thing a link grants:
 * it names one thing, expires (or not, if you chose no end date), and can be revoked at any time.
 */
export type Share = {
  token: string;
  kind: 'session' | 'workspace' | 'pane' | 'claude';
  /** Session id, workspace id, or pane id (pane and claude links). */
  ref: string;
  title: string;
  createdAt: number;
  /** null: no end date. */
  expiresAt: number | null;
  /** Workspace and pane links: guests may type, not just watch. */
  canType: boolean;
  /** Workspace and pane links: guests may send messages to the Claude panes. */
  canMessage?: boolean;
  /** The last 30 times someone opened the link. */
  opens?: Open[];
  /** Claude links: both Claudes have been told how to talk to each other. */
  introduced?: boolean;
};
export type Open = { at: number; visitor: string; device: string; country: string | null };

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
  const live = list.filter((s) => isLive(s, now));
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
    if (same.expiresAt !== null) same.expiresAt = Date.now() + days * DAY;
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
  return s && isLive(s) ? s : null;
}

export async function revokeShare(token: string) {
  const list = await all();
  const i = list.findIndex((s) => s.token === token);
  if (i === -1) return false;
  list.splice(i, 1);
  await save();
  return true;
}

export async function updateShare(token: string, patch: { canType?: unknown; canMessage?: unknown; lasts?: unknown; introduced?: unknown }) {
  const s = (await all()).find((x) => x.token === token);
  if (!s) return null;
  if (typeof patch.canType === 'boolean') s.canType = patch.canType;
  if (typeof patch.canMessage === 'boolean') s.canMessage = patch.canMessage;
  if (isLasts(patch.lasts)) s.expiresAt = expiryFor(patch.lasts);
  if (patch.introduced === true) s.introduced = true;
  await save();
  return s;
}

// ── Who's watching ────────────────────────────────────────────────────────
// Each guest page has a random visitor id and says hello every few seconds. Watching now = seen in the last 15 s.
// Kicked visitors are refused on that link until Studio restarts (a new tab gets a new id: turning the link off is
// the way to keep someone out).
const presence = new Map<string, Map<string, { seen: number; device: string; country: string | null }>>();
const kicked = new Map<string, Set<string>>();
const WATCHING = 15_000;

export const isKicked = (token: string, visitor: string) => !!kicked.get(token)?.has(visitor);

/** A guest page checking in. False if this visitor was kicked from the link. */
export async function hello(token: string, visitor: string, userAgent: string, country: string | null) {
  if (!/^[\w-]{8,64}$/.test(visitor) || isKicked(token, visitor)) return false;
  const here = presence.get(token) || presence.set(token, new Map()).get(token)!;
  const device = deviceName(userAgent);
  if (!here.has(visitor)) {
    const s = (await all()).find((x) => x.token === token);
    if (s) {
      s.opens = [{ at: Date.now(), visitor, device, country }, ...(s.opens || [])].slice(0, 30);
      await save();
    }
  }
  here.set(visitor, { seen: Date.now(), device, country });
  return true;
}

export function watching(token: string) {
  const now = Date.now();
  return [...(presence.get(token) || new Map()).entries()].filter(([, p]) => now - p.seen < WATCHING).map(([visitor, p]) => ({ visitor, ...p }));
}

export function kick(token: string, visitor: string) {
  (kicked.get(token) || kicked.set(token, new Set()).get(token)!).add(visitor);
  presence.get(token)?.delete(visitor);
}
