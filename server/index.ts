import express from 'express';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { TerminalManager, type TermNotification } from './terminals.ts';
import { descendants, gitInfo, listeningPorts, prInfo, processCwd, processTree, type GitInfo, type PrInfo } from './meta.ts';
import { findTranscript, importTranscript, listSessions, listSlashCommands, readActivity, readClaudeProcs, sessionInfo, transcriptExists, transcriptPath, type ClaudeProc } from './claude.ts';
import { customCommands, listDirs, loadWorkflows, loadWorkspaces, saveWorkflows, saveWorkspaces } from './store.ts';
import { installShellIntegration } from './shell.ts';
import { offices, toolStatus, type AgentState } from './offices.ts';
import { checkAccess, DEVICE_COOKIE, isAllowedOrigin, remoteConfig } from './access.ts';
import { claimCode, listDevices, newPairingCode, removeAllDevices, removeDevice } from './devices.ts';
import { enableRemote, releaseRemote } from './provision.ts';
import { pairPage } from './pair-page.ts';
import { createShare, getShare, listShares, revokeShare, updateShare } from './shares.ts';
import { guestPage } from './share-page.ts';
import { decodeInvite } from './invite.ts';
import { managed, startTunnel, stopTunnel, tunnelStatus } from './tunnel.ts';
import { DATA_DIR } from './store.ts';

installShellIntegration();

// Remote access only works while this Mac is awake, so don't let it idle-sleep while Studio runs with remote access set up.
// (Closing the lid on battery still sleeps it; on power with the lid open it stays reachable.)
if (remoteConfig() && process.platform === 'darwin') spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).unref();

const PORT = Number(process.env.PORT || 4600);
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;
// STUDIO_ROOT: where dist/ and a few assets live when the server runs bundled inside the Mac app.
const ROOT = process.env.STUDIO_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const terms = new TerminalManager(BASE_URL);
const paneTerms = new Map<string, string>(); // pane id → terminal id

type Notification = TermNotification & { id: string; at: number; read: boolean };
let notifications: Notification[] = [];

type TermMeta = {
  cwd: string;
  ports: number[];
  git: GitInfo;
  pr: PrInfo;
  claude: (Pick<ClaudeProc, 'sessionId' | 'status' | 'name' | 'pid'> & { cwd: string }) | null;
};
let meta: Record<string, TermMeta> = {};

// ── Event stream ────────────────────────────────────────────────────────────
const eventClients = new Set<WebSocket>();
function snapshot() {
  return { type: 'state', home: os.homedir(), terminals: terms.list(), meta, notifications: notifications.slice(0, 100) };
}
let lastSent = '';
function broadcast(force = false) {
  const msg = JSON.stringify(snapshot());
  if (!force && msg === lastSent) return;
  lastSent = msg;
  for (const ws of eventClients) if (ws.readyState === 1) ws.send(msg);
}

function pushNotification(n: TermNotification) {
  notifications.unshift({ ...n, id: randomUUID().slice(0, 8), at: Date.now(), read: false });
  notifications = notifications.slice(0, 200);
  broadcast();
}

terms.on('changed', () => broadcast());
terms.on('notification', pushNotification);

// ── Background poller: cwd, ports, git, PR, Claude status per terminal ────
const prevClaudeStatus = new Map<string, string>();
let tick = 0;
async function poll() {
  tick++;
  const list = terms.list();
  if (!list.length) {
    meta = {};
    offices.update([], []);
    return broadcast();
  }
  const [{ children, comm }, procs, ports] = await Promise.all([
    processTree(),
    readClaudeProcs(),
    tick % 2 === 0 || !Object.keys(meta).length ? listeningPorts() : Promise.resolve(null),
  ]);
  const next: Record<string, TermMeta> = {};
  const gitCache = new Map<string, GitInfo>();
  const agents: AgentState[] = [];
  for (const t of list) {
    const prev = meta[t.id];
    const tree = descendants(t.pid, children);
    const cwd = (await processCwd(tree[tree.length - 1] ?? t.pid)) || (await processCwd(t.pid)) || t.cwd;
    terms.setCwd(t.id, cwd);

    let termPorts = prev?.ports || [];
    if (ports) termPorts = tree.flatMap((pid) => ports.get(pid) || []).sort((a, b) => a - b);

    if (!gitCache.has(cwd)) gitCache.set(cwd, await gitInfo(cwd));
    const git = gitCache.get(cwd)!;
    const pr = git ? await prInfo(cwd, git.branch) : null;

    const claudePid = tree.find((pid) => procs.has(pid));
    const cp = claudePid ? procs.get(claudePid)! : null;
    const claude = cp ? { sessionId: cp.sessionId, status: cp.status, name: cp.name, pid: cp.pid, cwd: cp.cwd } : null;

    // Contextful "Claude finished" notifications: cmux's main gap is that the
    // stock notification only says "Claude is waiting for your input".
    const before = prevClaudeStatus.get(t.id);
    if (claude) {
      if (before === 'busy' && claude.status !== 'busy') {
        const act = await readActivity(transcriptPath(claude.cwd, claude.sessionId), 5);
        const body = act.lastAssistantText.replace(/\s+/g, ' ').trim().slice(0, 220) || 'Waiting for your input';
        pushNotification({ termId: t.id, title: `Claude · ${path.basename(claude.cwd)}`, body, source: 'claude' });
      }
      prevClaudeStatus.set(t.id, claude.status);
    } else prevClaudeStatus.delete(t.id);

    next[t.id] = { cwd, ports: termPorts, git, pr, claude };
    agents.push(await agentState(t.id, cwd, claude, tree.slice(1), comm));
  }
  meta = next;
  offices.update(list, agents);
  broadcast();
}
setInterval(() => poll().catch((e) => console.error('[poll]', e)), 2000);

// What each terminal's office character is doing.
const wasActive = new Map<string, boolean>();
const doneFlag = new Map<string, boolean>();
const SHELLS = new Set(['zsh', '-zsh', 'bash', '-bash', 'fish', 'sh', 'login']);
async function agentState(
  termId: string,
  cwd: string,
  claude: TermMeta['claude'],
  childPids: number[],
  comm: Map<number, string>,
): Promise<AgentState> {
  const place = path.basename(cwd);
  let active = false;
  let tool: string | null = null;
  let status = 'Idle';
  if (claude) {
    active = claude.status === 'busy';
    if (active) {
      const act = await readActivity(transcriptPath(claude.cwd, claude.sessionId), 4);
      const last = act.events.at(-1);
      if (last?.kind === 'tool' && last.tool) {
        tool = last.tool;
        status = toolStatus(last.tool, last.text);
      } else {
        tool = 'Write';
        status = 'Thinking…';
      }
    }
  } else {
    // A shell is busy while something other than the shell itself runs in the foreground.
    const job = childPids.map((pid) => path.basename(comm.get(pid) || '')).find((c) => c && !SHELLS.has(c));
    if (job) {
      active = true;
      tool = 'Bash';
      status = `Running ${job}`;
    }
  }
  // Checkmark once a turn or a job finishes, until the next one starts.
  if (active) doneFlag.set(termId, false);
  else if (wasActive.get(termId)) doneFlag.set(termId, true);
  wasActive.set(termId, active);
  return { termId, label: claude ? `Claude · ${place}` : `Terminal · ${place}`, active, tool, status, done: !!doneFlag.get(termId) };
}

// ── HTTP API ────────────────────────────────────────────────────────────────
const app = express();
// Requests from this Mac pass; remote ones (Cloudflare Tunnel) need a valid Access login.
// Share links (/share/*) have their own, narrower rule: see access.ts.
app.use((req, res, next) => {
  checkAccess(req.headers, req.originalUrl.split('?')[0]).then((ok) => {
    if (ok) return next();
    // A phone that isn't paired (or was removed) opening the address lands on the pairing page, not a bare error.
    const wantsPage = req.method === 'GET' && String(req.headers.accept || '').includes('text/html') && !req.path.startsWith('/api');
    if (wantsPage && remoteConfig()?.mode === 'pairing') return res.redirect(302, '/pair');
    res.status(403).send('Forbidden');
  });
});
// Shared conversations arrive as one big JSON body; everything else is small.
const bigJson = express.json({ limit: '200mb' });
const smallJson = express.json({ limit: '2mb' });
app.use((req, res, next) => (req.path === '/api/session-import' ? next() : smallJson(req, res, next)));

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e) => res.status(500).json({ error: String(e?.message || e) }));

app.get('/api/state', (_req, res) => res.json(snapshot()));

app.put('/api/offices', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'expected an array' });
  offices.setDefs(req.body);
  res.json({ ok: true });
});
// Clicking a character in an office jumps to its terminal in Studio.
offices.onFocus = (termId) => {
  const msg = JSON.stringify({ type: 'focus', termId });
  for (const ws of eventClients) if (ws.readyState === 1) ws.send(msg);
};

app.post(
  '/api/terminals',
  wrap(async (req, res) => {
    const { cwd, cols, rows, accent, resume, theme, paneId } = req.body || {};
    let { command } = req.body || {};
    // Every device shows the same panes: if two start one at once, both get the same terminal.
    const existing = paneId && terms.list().find((t) => t.id === paneTerms.get(paneId) && !t.exited);
    if (existing) return res.json(existing);
    if (cwd && !fs.existsSync(cwd)) return res.status(400).json({ error: `No such directory: ${cwd}` });
    // Respawning a Claude pane: resume its conversation only if one was actually saved.
    if (resume && typeof command === 'string' && command.startsWith('claude') && (await transcriptExists(resume)))
      command = `claude --resume ${resume}`;
    const term = await terms.create({ cwd, command, cols, rows, accent, theme });
    if (paneId) paneTerms.set(paneId, term.id);
    res.json(term);
  }),
);
app.delete('/api/terminals/:id', (req, res) => res.json({ ok: terms.kill(req.params.id) }));
app.post('/api/terminals/:id/send', (req, res) => {
  const { text = '', enter = false } = req.body || {};
  // Bracketed paste keeps multi-line prompts as one message in Claude Code.
  const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
  const ok = terms.write(req.params.id, payload);
  if (ok && enter) setTimeout(() => terms.write(req.params.id, '\r'), 120);
  res.json({ ok });
});

app.post('/api/notify', (req, res) => {
  const { title = 'Notification', body = '', termId = '' } = req.body || {};
  pushNotification({ termId, title, body, source: 'api' });
  res.json({ ok: true });
});
app.post('/api/notifications/read', (req, res) => {
  const { ids, termId, all } = req.body || {};
  for (const n of notifications) if (all || ids?.includes(n.id) || (termId && n.termId === termId)) n.read = true;
  broadcast();
  res.json({ ok: true });
});
app.post('/api/notifications/clear', (_req, res) => {
  notifications = [];
  broadcast();
  res.json({ ok: true });
});

app.get('/api/claude/sessions', wrap(async (_req, res) => res.json(await listSessions(80))));
app.get('/api/claude/commands', wrap(async (req, res) => res.json(await listSlashCommands(String(req.query.cwd || '')))));
app.get(
  '/api/claude/activity',
  wrap(async (req, res) => {
    const m = meta[String(req.query.termId)];
    if (!m?.claude) return res.json(null);
    const act = await readActivity(transcriptPath(m.claude.cwd, m.claude.sessionId));
    res.json({ ...act, sessionId: m.claude.sessionId, status: m.claude.status });
  }),
);

// Is Claude Code installed on this computer, and signed in? The Get started checklist and the new-workspace dialog use this.
// STUDIO_CLAUDE_BIN points detection at one specific program (used by tests).
let claudeStatus: { at: number; installed: boolean; loggedIn: boolean | null } | null = null;
const run = (cmd: string, args: string[], ms = 8000) =>
  new Promise<string>((resolve) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', () => resolve(out));
    c.on('error', () => resolve(''));
    setTimeout(() => (c.kill(), resolve(out)), ms);
  });
async function detectClaude() {
  const forced = process.env.STUDIO_CLAUDE_BIN;
  const known = forced
    ? [forced]
    : ['.local/bin/claude', '.claude/local/claude', '.npm-global/bin/claude', '.bun/bin/claude'].map((p) => path.join(os.homedir(), p)).concat('/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  let bin = known.find((p) => fs.existsSync(p)) || '';
  // Not in a usual place: ask a login shell, which sees the user's PATH like a normal terminal does.
  if (!bin && !forced) {
    const out = await run(process.env.SHELL || '/bin/zsh', ['-l', '-i', '-c', 'command -v claude'], 6000);
    bin = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('/')) || '';
  }
  if (!bin) return { installed: false, loggedIn: null };
  const out = await run(bin, ['auth', 'status'], 10000);
  const j = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
  try {
    return { installed: true, loggedIn: JSON.parse(j).loggedIn === true };
  } catch {
    return { installed: true, loggedIn: null };
  }
}
app.get(
  '/api/doctor',
  wrap(async (_req, res) => {
    if (!claudeStatus || Date.now() - claudeStatus.at > 3_000) claudeStatus = { at: Date.now(), ...(await detectClaude()) };
    // `claude` kept for the new-workspace dialog; the email is deliberately not exposed.
    res.json({ claude: claudeStatus.installed, installed: claudeStatus.installed, loggedIn: claudeStatus.loggedIn });
  }),
);

// ── Share links ─────────────────────────────────────────────────────────────
// Owner side (needs your login): make, list, change and revoke links.
const linkBase = (req: express.Request) => {
  const cfg = remoteConfig();
  return cfg ? `https://${cfg.host}` : `${req.protocol}://${req.headers.host}`;
};
// Links can reach other people only when this Studio has a public address people can be let into.
const shareable = () => {
  const cfg = remoteConfig();
  return !!cfg && (cfg.mode === 'pairing' || !!cfg.shareAud);
};
const withUrl = (req: express.Request, s: Awaited<ReturnType<typeof createShare>>) => ({ ...s, url: `${linkBase(req)}/share/${s.token}` });

app.get(
  '/api/shares',
  // `remote` says whether links can work for other people: without remote access they only open on this computer.
  wrap(async (req, res) => res.json({ remote: shareable(), managed: managed(), links: (await listShares()).map((s) => withUrl(req, s)) })),
);
app.post(
  '/api/shares',
  wrap(async (req, res) => {
    const { kind, ref } = req.body || {};
    let title: string;
    if (kind === 'session') {
      const info = await sessionInfo(String(ref));
      if (!info) return res.status(404).json({ error: 'That conversation has no saved transcript yet' });
      title = info.title;
    } else if (kind === 'workspace') {
      const w = (shared.workspaces || []).find((x) => (x as { id: string }).id === ref) as { name?: string } | undefined;
      if (!w) return res.status(404).json({ error: 'No such workspace' });
      title = w.name || 'Workspace';
    } else return res.status(400).json({ error: 'kind must be session or workspace' });
    res.json(withUrl(req, await createShare(kind, String(ref), title)));
  }),
);
app.patch(
  '/api/shares/:token',
  wrap(async (req, res) => {
    const s = await updateShare(String(req.params.token), req.body || {});
    res.json(s ? withUrl(req, s) : { error: 'No such link' });
  }),
);
const guests = new Map<string, Set<WebSocket>>();
app.delete(
  '/api/shares/:token',
  wrap(async (req, res) => {
    const token = String(req.params.token);
    // Turning a link off also drops anyone watching through it.
    for (const ws of guests.get(token) || []) ws.close(4403, 'link revoked');
    res.json({ ok: await revokeShare(token) });
  }),
);
// A conversation someone shared with you arrives from your browser (see Shared.tsx) and lands in your own Claude history.
app.post(
  '/api/session-import',
  bigJson,
  wrap(async (req, res) => {
    const { sessionId, cwd, transcript } = req.body || {};
    if (typeof transcript !== 'string' || typeof sessionId !== 'string') return res.status(400).json({ error: 'expected sessionId and transcript' });
    const dir = typeof cwd === 'string' && cwd ? cwd : os.homedir();
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(400).json({ error: `No such folder: ${dir}` });
    const added = await importTranscript(sessionId, dir, transcript);
    res.json({ sessionId, cwd: dir, added });
  }),
);

// Remote access settings (Mac app). Changing them is only allowed from this computer, never through the tunnel.
const onThisComputer = (req: express.Request) => !req.headers['cf-ray'] && !req.headers['cf-connecting-ip'];
const remoteInfo = async () => {
  const cfg = remoteConfig();
  return { ...tunnelStatus(), configured: !!cfg, mode: cfg?.mode || (cfg ? 'access' : null), host: cfg?.host || null, allow: cfg?.allow || [], devices: (await listDevices()).length };
};
app.get(
  '/api/remote',
  wrap(async (_req, res) => res.json(await remoteInfo())),
);
// One press of "Turn on": get an address from the connection service, save it, start the tunnel. Phones then pair (below).
app.post(
  '/api/remote/enable',
  wrap(async (req, res) => {
    if (!managed()) return res.status(400).json({ error: 'This Studio doesn’t manage its own tunnel.' });
    if (!onThisComputer(req)) return res.status(403).json({ error: 'Do this on the computer itself.' });
    const { host, tunnelToken } = await enableRemote();
    writeRemote({ host, mode: 'pairing' }, tunnelToken);
    startTunnel();
    res.json(await remoteInfo());
  }),
);
// "Add a phone": a short single-use code, made only on this computer.
app.post('/api/remote/pair', (req, res) => {
  const cfg = remoteConfig();
  if (!onThisComputer(req) || cfg?.mode !== 'pairing') return res.status(403).json({ error: 'Not allowed' });
  const { code, expiresAt } = newPairingCode();
  res.json({ code, expiresAt, url: `https://${cfg.host}/pair#${code.replace('-', '')}` });
});
app.get(
  '/api/remote/devices',
  wrap(async (req, res) => (onThisComputer(req) ? res.json(await listDevices()) : res.status(403).json({ error: 'Not allowed' }))),
);
app.delete(
  '/api/remote/devices/:id',
  wrap(async (req, res) => (onThisComputer(req) ? res.json({ ok: await removeDevice(String(req.params.id)) }) : res.status(403).json({ error: 'Not allowed' }))),
);
app.post(
  '/api/remote/join',
  wrap(async (req, res) => {
    if (!managed()) return res.status(400).json({ error: 'This Studio doesn’t manage its own tunnel. Use `npm run setup` instead.' });
    if (!onThisComputer(req)) return res.status(403).json({ error: 'Do this on the computer itself.' });
    const inv = decodeInvite(String(req.body?.code || ''));
    writeRemote({ mode: 'access', host: inv.host, team: inv.team, aud: inv.aud, allow: inv.allow, shareAud: inv.shareAud, shareAllow: inv.shareAllow }, inv.tunnelToken);
    startTunnel();
    res.json({ ...(await remoteInfo()), email: inv.email });
  }),
);
app.delete(
  '/api/remote',
  wrap(async (req, res) => {
    if (!managed() || !onThisComputer(req)) return res.status(403).json({ error: 'Not allowed' });
    const was = remoteConfig();
    stopTunnel();
    // Pairing-mode addresses are handed back to the connection service and every paired phone is signed out.
    if (was?.mode === 'pairing') await releaseRemote();
    await removeAllDevices();
    for (const f of ['remote.json', 'tunnel-token']) fs.rmSync(path.join(DATA_DIR, f), { force: true });
    res.json(await remoteInfo());
  }),
);

function writeRemote(cfg: Record<string, unknown>, tunnelToken: string) {
  const file = path.join(DATA_DIR, 'remote.json');
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  fs.writeFileSync(path.join(DATA_DIR, 'tunnel-token'), tunnelToken, { mode: 0o600 });
}

// Guest side (a link's visitor): a standalone page, its data, and its terminals. Nothing else is reachable.
const guestHeaders = (res: express.Response) => {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src data:",
  });
};
// The page a phone uses to pair, and the endpoint that turns a code into a device cookie.
app.get('/pair', (_req, res) => {
  guestHeaders(res);
  res.type('html').send(pairPage());
});
app.post(
  '/pair/claim',
  wrap(async (req, res) => {
    const viaCloudflare = !!(req.headers['cf-ray'] || req.headers['cf-connecting-ip']);
    const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
    const r = await claimCode(String(req.body?.code || ''), ip, String(req.headers['user-agent'] || ''));
    if (!r.ok) return res.status(r.reason === 'slow-down' ? 429 : 400).json({ error: r.reason });
    res.cookie(DEVICE_COOKIE, r.token, { httpOnly: true, secure: viaCloudflare, sameSite: 'lax', maxAge: 365 * 86_400_000, path: '/' });
    res.json({ ok: true });
  }),
);
const XTERM = path.join(ROOT, 'node_modules/@xterm/xterm');
app.get('/share/_/xterm.js', (_req, res) => res.sendFile(path.join(XTERM, 'lib/xterm.js')));
app.get('/share/_/xterm.css', (_req, res) => res.sendFile(path.join(XTERM, 'css/xterm.css')));
app.get('/share/:token', (_req, res) => {
  guestHeaders(res);
  res.type('html').send(guestPage());
});

/** Live terminals of a shared workspace, in layout order. */
function sharedPanes(workspaceId: string) {
  const w = (shared.workspaces || []).find((x) => (x as { id: string }).id === workspaceId) as { name?: string; root?: unknown } | undefined;
  if (!w) return null;
  const out: { id: string; title: string; cwd: string }[] = [];
  const walk = (n: any) => {
    if (n?.type === 'pane') {
      const t = n.pane?.termId && terms.get(n.pane.termId);
      if (t && !t.exited) out.push({ id: t.id, title: n.pane.name || (n.pane.command?.startsWith('claude') ? 'Claude' : t.title), cwd: meta[t.id]?.cwd || t.cwd });
    } else if (n?.type === 'split') walk(n.a), walk(n.b);
  };
  walk(w.root);
  return { name: w.name || 'Workspace', panes: out };
}

app.get(
  '/share/api/:token',
  wrap(async (req, res) => {
    guestHeaders(res);
    const s = await getShare(String(req.params.token));
    if (!s) return res.status(404).json({ error: 'No such link' });
    if (s.kind === 'session') {
      const info = await sessionInfo(s.ref);
      if (!info) return res.status(404).json({ error: 'That conversation is gone' });
      return res.json({ kind: 'session', title: info.title, sessionId: info.sessionId, project: info.project, expiresAt: s.expiresAt });
    }
    const w = sharedPanes(s.ref);
    if (!w) return res.status(404).json({ error: 'That workspace is closed' });
    res.json({ kind: 'workspace', title: w.name, canType: s.canType, panes: w.panes, expiresAt: s.expiresAt });
  }),
);
app.get(
  '/share/api/:token/transcript',
  wrap(async (req, res) => {
    guestHeaders(res);
    const s = await getShare(String(req.params.token));
    if (!s || s.kind !== 'session') return res.status(404).json({ error: 'No such link' });
    const file = await findTranscript(s.ref);
    if (!file) return res.status(404).json({ error: 'That conversation is gone' });
    if (req.query.download) res.attachment(`${s.ref}.jsonl`);
    res.type('text/plain').send(await fs.promises.readFile(file, 'utf8'));
  }),
);

// Can this URL be shown inside a browser pane? Many sites (Google, GitHub…) send
// X-Frame-Options or CSP frame-ancestors that forbid embedding in other apps.
app.get(
  '/api/frame-check',
  wrap(async (req, res) => {
    let url: URL;
    try {
      url = new URL(String(req.query.url || ''));
    } catch {
      return res.json({ embeddable: false, reason: 'invalid' });
    }
    if (!/^https?:$/.test(url.protocol)) return res.json({ embeddable: false, reason: 'invalid' });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 Studio-CLI' } });
      r.body?.cancel().catch(() => {});
      const xfo = (r.headers.get('x-frame-options') || '').toLowerCase();
      const fa = /frame-ancestors([^;]*)/i.exec(r.headers.get('content-security-policy') || '')?.[1]?.trim().toLowerCase();
      const remote = remoteConfig()?.host;
      const allowsUs = (v: string) =>
        v.split(/\s+/).some((t) => t === '*' || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+|:\*)?$/.test(t) || (!!remote && t === `https://${remote}`));
      const blocked = (xfo && /deny|sameorigin/.test(xfo)) || (fa !== undefined && !allowsUs(fa));
      res.json({ embeddable: !blocked, finalUrl: r.url });
    } catch {
      // Unreachable (e.g. a dev server that isn't running): let the pane try and show the browser's own error.
      res.json({ embeddable: true, unreachable: true });
    } finally {
      clearTimeout(timer);
    }
  }),
);

// Workspaces are shared by the Mac, iPad and phone so you can switch devices and carry on.
const shared = await loadWorkspaces();
// Terminals outlive this process, so relearn which pane owns which terminal from the saved layout.
const rememberPanes = (node: any) => {
  if (node?.type === 'pane') node.pane?.termId && paneTerms.set(node.pane.id, node.pane.termId);
  else if (node?.type === 'split') rememberPanes(node.a), rememberPanes(node.b);
};
for (const w of shared.workspaces || []) rememberPanes((w as { root?: unknown }).root);
app.get('/api/workspaces', (_req, res) => res.json(shared));
app.put('/api/workspaces', (req, res) => {
  const { workspaces, from } = req.body || {};
  if (!Array.isArray(workspaces)) return res.status(400).json({ error: 'expected a workspaces array' });
  const ids = new Set(workspaces.map((w: { id: string }) => w.id));
  const closed = (shared.workspaces || []).map((w) => (w as { id: string }).id).filter((id) => !ids.has(id));
  shared.deleted = [...new Set([...shared.deleted, ...closed])].filter((id) => !ids.has(id)).slice(-500);
  shared.workspaces = workspaces;
  for (const w of workspaces) rememberPanes(w.root);
  saveWorkspaces(shared);
  const msg = JSON.stringify({ type: 'workspaces', workspaces, from });
  for (const ws of eventClients) if (ws.readyState === 1) ws.send(msg);
  res.json({ ok: true });
});

app.get('/api/workflows', wrap(async (_req, res) => res.json(await loadWorkflows())));
app.put(
  '/api/workflows',
  wrap(async (req, res) => {
    if (!Array.isArray(req.body)) return res.status(400).json({ error: 'expected an array' });
    await saveWorkflows(req.body);
    res.json({ ok: true });
  }),
);

app.get('/api/custom-commands', wrap(async (req, res) => res.json(await customCommands(String(req.query.cwd || '')))));
app.get('/api/fs/dirs', wrap(async (req, res) => res.json(await listDirs(String(req.query.path || '~')))));
app.get(
  '/api/fs/recent',
  wrap(async (_req, res) => {
    const seen = new Set<string>();
    const dirs = (await listSessions(80)).map((s) => s.cwd).filter((d) => !seen.has(d) && seen.add(d) && fs.existsSync(d));
    res.json(dirs.slice(0, 12));
  }),
);

const dist = path.join(ROOT, 'dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ── WebSockets ──────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  if (!(await checkAccess(req.headers, (req.url || '/').split('?')[0]))) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  // Same-origin only: a page on another site must not be able to type into a shell.
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) return socket.destroy();
  const url = new URL(req.url || '/', BASE_URL);
  // A share-link visitor's terminal: only panes of the workspace the link names, never resizing, typing only if allowed.
  const g = url.pathname.match(/^\/share\/ws\/([\w-]+)\/term\/([\w-]+)$/);
  if (g) {
    const share = await getShare(g[1]);
    const ok = share?.kind === 'workspace' && sharedPanes(share.ref)?.panes.some((p) => p.id === g[2]);
    return wss.handleUpgrade(req, socket, head, (ws) => {
      if (!share || !ok) return ws.close(4404, 'not found');
      const set = guests.get(share.token) || guests.set(share.token, new Set()).get(share.token)!;
      set.add(ws);
      ws.on('close', () => set.delete(ws));
      terms.attach(g[2], ws, { canType: () => share.canType });
    });
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const m = url.pathname.match(/^\/ws\/term\/([\w-]+)$/);
    if (m) return terms.attach(m[1], ws);
    if (url.pathname === '/ws/office') return offices.attach(ws, url.searchParams.get('office') || 'all');
    if (url.pathname === '/ws/events') {
      eventClients.add(ws);
      ws.send(JSON.stringify(snapshot()));
      ws.on('close', () => eventClients.delete(ws));
      return;
    }
    ws.close(4404, 'not found');
  });
});

// Terminals live in the pty host, so they outlive this process: connect (and pick them up) before serving.
terms
  .start()
  .then(() =>
    server.listen(PORT, HOST, () => {
      console.log(`[studio] server on ${BASE_URL}`);
      startTunnel();
      // Tell the connection service this install is still in use, so its address isn't cleaned up as abandoned.
      if (managed() && remoteConfig()?.mode === 'pairing') enableRemote().catch(() => {});
    }),
  )
  .catch((e) => {
    console.error('[studio]', e.message);
    process.exit(1);
  });

const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
