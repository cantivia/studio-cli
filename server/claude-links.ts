import { execFile } from 'node:child_process';
import os from 'node:os';
import { WebSocket } from 'ws';
import { asPaste, Brake, incomingText, introText, peekText } from './links-core.ts';
import { createShare, getShare, listShares, revokeShare, updateShare, type Share } from './shares.ts';
import { readJson, writeJson } from './store.ts';

/**
 * Claude connections: your Claude and a teammate's Claude, each on its own Mac, talking to each other.
 *
 * You make a claude link for one of your Claude panes (a share link, kind "claude"). Your teammate's Studio opens it
 * and its server keeps a WebSocket open to /share/ws/<token>/claude on yours, so only you need phone access on.
 * Each Claude talks with `studio tell "…"` and `studio peek` (bin/studio → /api/claude-link/*); what one sends is
 * typed straight into the other. Brakes: a Pause switch (pausing pauses both sides) and an automatic pause after
 * BRAKE_AFTER messages with nobody typing in either pane.
 *
 * Wire messages (JSON): hello {name, pane, paused}, msg {text}, peek {id} / peek-reply {id, text},
 * pause {paused, by}, human, bye.
 */

type Entry = { at: number; dir: 'in' | 'out' | 'note'; text: string };
type Conn = {
  /** The link's token (the same on both sides). */
  id: string;
  /** host: we made the link; guest: we joined someone else's. */
  side: 'host' | 'guest';
  paneId: string;
  url?: string;
  partner: { name: string; pane: string } | null;
  ws: WebSocket | null;
  paused: boolean;
  pausedBy?: string;
  log: Entry[];
  brake: Brake;
  pending: Map<string, (text: string) => void>;
  introduced: boolean;
  retry?: NodeJS.Timeout;
  lastHuman?: number;
};
type Saved = { id: string; url: string; paneId: string; introduced?: boolean };

/** What claude-links needs from the rest of the server. */
export type LinkDeps = {
  termForPane: (paneId: string) => string | null;
  paneTitle: (paneId: string) => string;
  /** The Claude running in a terminal, if any. */
  claudeIn: (termId: string) => { cwd: string; sessionId: string } | null;
  recentEvents: (claude: { cwd: string; sessionId: string }) => Promise<{ kind: string; tool?: string | null; text: string }[]>;
  write: (termId: string, text: string) => void;
  notify: (title: string, body: string, termId: string) => void;
  changed: () => void;
};

const FILE = 'claude-links.json';
const conns = new Map<string, Conn>();
let deps: LinkDeps;
let myName = os.userInfo().username;
execFile('id', ['-F'], (err, out) => !err && out.trim() && (myName = out.trim()));

const send = (c: Conn, m: object) => c.ws?.readyState === WebSocket.OPEN && c.ws.send(JSON.stringify(m));
const note = (c: Conn, dir: Entry['dir'], text: string) => {
  c.log.push({ at: Date.now(), dir, text: text.slice(0, 4000) });
  if (c.log.length > 100) c.log.splice(0, c.log.length - 100);
  deps.changed();
};
const newConn = (id: string, side: Conn['side'], paneId: string, url?: string): Conn => ({
  id,
  side,
  paneId,
  url,
  partner: null,
  ws: null,
  paused: false,
  log: [],
  brake: new Brake(),
  pending: new Map(),
  introduced: false,
});

async function saveGuests() {
  const list: Saved[] = [...conns.values()].filter((c) => c.side === 'guest').map((c) => ({ id: c.id, url: c.url!, paneId: c.paneId, introduced: c.introduced }));
  await writeJson(FILE, list);
}

/** Type a message into our Claude, if the pane is running Claude. */
function deliver(c: Conn, text: string) {
  const term = deps.termForPane(c.paneId);
  if (!term || !deps.claudeIn(term)) {
    note(c, 'note', 'A message arrived but this pane isn’t running Claude, so it was held back.');
    if (term) deps.notify('Message from a teammate’s Claude held back', 'The pane it’s connected to isn’t running Claude.', term);
    return false;
  }
  deps.write(term, asPaste(text));
  setTimeout(() => deps.write(term, '\r'), 120);
  return true;
}

function setPaused(c: Conn, paused: boolean, by: string, tellPartner = true) {
  c.paused = paused;
  c.pausedBy = paused ? by : undefined;
  if (!paused) c.brake.human();
  if (tellPartner) send(c, { t: 'pause', paused, by });
  note(c, 'note', paused ? (by === 'auto' ? `Paused after ${c.brake.count} messages with nobody typing.` : `Paused by ${by}.`) : `Resumed by ${by}.`);
}

/** Counts a message for the brake; pauses both sides when it trips. */
function countMessage(c: Conn) {
  if (!c.brake.message()) return;
  setPaused(c, true, 'auto');
  const term = deps.termForPane(c.paneId);
  if (term) deps.notify('Claudes paused', `${c.partner?.name || 'Your teammate'}’s Claude and yours sent ${c.brake.count} messages with nobody typing. Resume them in the Claude panel → Teammate.`, term);
}

function onMessage(c: Conn, raw: string) {
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.t === 'hello') {
    c.partner = { name: String(m.name || 'Teammate').slice(0, 80), pane: String(m.pane || 'Claude').slice(0, 120) };
    if (c.side === 'host') send(c, { t: 'hello', name: myName, pane: deps.paneTitle(c.paneId), paused: c.paused });
    else if (typeof m.paused === 'boolean') c.paused = m.paused;
    if (!c.introduced) {
      c.introduced = true;
      deliver(c, introText(c.partner.name, c.partner.pane));
      note(c, 'note', `Connected to ${c.partner.name}’s Claude.`);
      if (c.side === 'host') updateShare(c.id, { introduced: true }).catch(() => {});
      else saveGuests().catch(() => {});
    }
    deps.changed();
  } else if (m.t === 'msg' && typeof m.text === 'string') {
    if (c.paused) return note(c, 'note', 'A message arrived while paused and was dropped.');
    note(c, 'in', m.text);
    countMessage(c);
    deliver(c, incomingText(c.partner?.name || 'Teammate', m.text.slice(0, 8000)));
  } else if (m.t === 'peek' && typeof m.id === 'string') {
    const term = deps.termForPane(c.paneId);
    const claude = term ? deps.claudeIn(term) : null;
    (claude ? deps.recentEvents(claude) : Promise.resolve([]))
      .then((events) => send(c, { t: 'peek-reply', id: m.id, text: claude ? peekText(myName, events) : `${myName}’s pane isn’t running Claude right now.` }))
      .catch(() => {});
  } else if (m.t === 'peek-reply' && typeof m.id === 'string') {
    c.pending.get(m.id)?.(String(m.text || ''));
    c.pending.delete(m.id);
  } else if (m.t === 'pause') {
    setPaused(c, !!m.paused, String(m.by || c.partner?.name || 'your teammate'), false);
    deps.changed();
  } else if (m.t === 'human') {
    c.brake.human();
  } else if (m.t === 'bye') {
    note(c, 'note', `${c.partner?.name || 'Your teammate'} disconnected.`);
    drop(c, false);
  }
}

function attach(c: Conn, ws: WebSocket) {
  c.ws?.close();
  c.ws = ws;
  ws.on('message', (d) => onMessage(c, d.toString()));
  ws.on('close', () => {
    if (c.ws === ws) c.ws = null;
    deps.changed();
  });
  deps.changed();
}

/** The host side: a teammate's Studio connecting through a claude link. */
export async function acceptHost(token: string, ws: WebSocket) {
  const share = await getShare(token);
  if (!share || share.kind !== 'claude') return ws.close(4404, 'no such link');
  let c = conns.get(token);
  if (!c) {
    c = newConn(token, 'host', share.ref);
    c.introduced = !!share.introduced;
    conns.set(token, c);
  }
  attach(c, ws);
}

/** The guest side: connect (and keep reconnecting) to the Studio that made the link. */
function dial(c: Conn, wait = 2000) {
  clearTimeout(c.retry);
  if (!conns.has(c.id)) return;
  const u = new URL(c.url!);
  const ws = new WebSocket(`${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}/share/ws/${c.id}/claude`);
  ws.on('open', () => {
    attach(c, ws);
    send(c, { t: 'hello', name: myName, pane: deps.paneTitle(c.paneId) });
    wait = 2000;
  });
  ws.on('close', (code) => {
    if (code === 4404) return note(c, 'note', 'The link was turned off by whoever made it.');
    if (conns.get(c.id) === c) c.retry = setTimeout(() => dial(c, Math.min(wait * 2, 60_000)), wait);
  });
  ws.on('error', () => {});
}

/** What a pasted link is, asked of the Studio that made it (server to server, so the browser's rules don't apply). */
export async function inspect(url: string) {
  const u = new URL(url);
  const token = u.pathname.split('/')[2];
  if (!/^\/share\/[\w-]+\/?$/.test(u.pathname) || !/^https?:$/.test(u.protocol)) throw new Error('That isn’t a Studio share link.');
  const r = await fetch(`${u.origin}/share/api/${token}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('That link doesn’t work any more (it may have expired or been turned off).');
  return { token, ...((await r.json()) as { kind: string; title: string; name?: string; pane?: string }) };
}

export async function join(url: string, paneId: string) {
  const info = await inspect(url);
  if (info.kind !== 'claude') throw new Error('That isn’t a Claude connection link.');
  const term = deps.termForPane(paneId);
  if (!term || !deps.claudeIn(term)) throw new Error('Pick a pane that is running Claude.');
  if (conns.has(info.token)) throw new Error('You’re already connected through that link.');
  const c = newConn(info.token, 'guest', paneId, new URL(url).origin + `/share/${info.token}`);
  c.partner = { name: info.name || 'Teammate', pane: info.pane || 'Claude' };
  conns.set(c.id, c);
  await saveGuests();
  dial(c, 500);
  return c.id;
}

/** Make (or reuse) the claude link for one of your Claude panes. */
export async function invite(paneId: string) {
  return createShare('claude', paneId, deps.paneTitle(paneId));
}

export async function startLinks(d: LinkDeps) {
  deps = d;
  for (const s of await readJson<Saved[]>(FILE, [])) {
    const c = newConn(s.id, 'guest', s.paneId, s.url);
    c.introduced = !!s.introduced;
    conns.set(c.id, c);
    dial(c, 500);
  }
}

/** The connection a terminal belongs to (one per pane). */
const connOf = (termId: string) => [...conns.values()].find((c) => deps.termForPane(c.paneId) === termId);

/** `studio tell`: send a message from this terminal's Claude. Returns [status, text for the terminal]. */
export function tell(termId: string, text: string): [number, string] {
  const c = connOf(termId);
  if (!c) return [404, 'This Claude isn’t connected to a teammate’s Claude. In Studio: Claude panel → Teammate → Connect.'];
  if (!text.trim()) return [400, 'Nothing to send. Usage: studio tell "your message"'];
  if (c.paused) return [409, `The connection is paused${c.pausedBy === 'auto' ? ' after many messages with nobody typing' : ` by ${c.pausedBy}`}. A person can resume it in Studio.`];
  if (!c.ws || c.ws.readyState !== WebSocket.OPEN) return [503, `${c.partner?.name || 'Your teammate'}’s Studio is offline right now. Try again later.`];
  send(c, { t: 'msg', text: text.slice(0, 8000) });
  note(c, 'out', text);
  countMessage(c);
  return [200, `Sent to ${c.partner?.name || 'your teammate'}’s Claude.`];
}

/** `studio peek`: what the connected Claude has been doing. */
export async function peek(termId: string): Promise<[number, string]> {
  const c = connOf(termId);
  if (!c) return [404, 'This Claude isn’t connected to a teammate’s Claude.'];
  if (!c.ws || c.ws.readyState !== WebSocket.OPEN) return [503, `${c.partner?.name || 'Your teammate'}’s Studio is offline right now.`];
  const id = Math.random().toString(36).slice(2);
  const text = await new Promise<string | null>((resolve) => {
    c.pending.set(id, resolve);
    send(c, { t: 'peek', id });
    setTimeout(() => (c.pending.delete(id), resolve(null)), 8000);
  });
  return text === null ? [504, 'No answer from your teammate’s Studio.'] : [200, text];
}

/** Someone typed in a pane: reset the brake on its connection, and tell the other side (at most every 5 s). */
export function human(termId: string) {
  const c = connOf(termId);
  if (!c) return;
  c.brake.human();
  if (!c.lastHuman || Date.now() - c.lastHuman > 5000) {
    c.lastHuman = Date.now();
    send(c, { t: 'human' });
  }
}

export function pause(id: string, paused: boolean) {
  const c = conns.get(id);
  if (!c) return false;
  setPaused(c, paused, myName);
  return true;
}

function drop(c: Conn, tellPartner: boolean) {
  if (tellPartner) send(c, { t: 'bye' });
  clearTimeout(c.retry);
  conns.delete(c.id);
  c.ws?.close();
  if (c.side === 'guest') saveGuests().catch(() => {});
  else revokeShare(c.id).catch(() => {});
  deps.changed();
}

export async function disconnect(id: string) {
  const c = conns.get(id);
  if (c) return drop(c, true), true;
  // A link nobody has joined yet.
  return revokeShare(id);
}

/** Everything the Claude panel and the Shared page show. Includes links nobody has joined yet. */
export async function listLinks() {
  const out = [...conns.values()].map((c) => ({
    id: c.id,
    side: c.side,
    paneId: c.paneId,
    termId: deps.termForPane(c.paneId),
    partner: c.partner,
    online: !!c.ws && c.ws.readyState === WebSocket.OPEN,
    paused: c.paused,
    pausedBy: c.pausedBy || null,
    log: c.log,
  }));
  for (const s of (await listShares()).filter((x: Share) => x.kind === 'claude' && !conns.has(x.token)))
    out.push({ id: s.token, side: 'host', paneId: s.ref, termId: deps.termForPane(s.ref), partner: null, online: false, paused: false, pausedBy: null, log: [] });
  return out;
}

export const ownerName = () => myName;
