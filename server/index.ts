import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { TerminalManager, type TermNotification } from './terminals.ts';
import { descendants, gitInfo, listeningPorts, prInfo, processCwd, processTree, type GitInfo, type PrInfo } from './meta.ts';
import { listSessions, listSlashCommands, readActivity, readClaudeProcs, transcriptExists, transcriptPath, type ClaudeProc } from './claude.ts';
import { customCommands, listDirs, loadWorkflows, loadWorkspaces, saveWorkflows, saveWorkspaces } from './store.ts';
import { installShellIntegration } from './shell.ts';
import { offices, toolStatus, type AgentState } from './offices.ts';
import { checkAccess, isAllowedOrigin, remoteConfig } from './access.ts';

installShellIntegration();

const PORT = Number(process.env.PORT || 4600);
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
app.use((req, res, next) => {
  checkAccess(req.headers).then((ok) => (ok ? next() : res.status(403).send('Forbidden')));
});
app.use(express.json({ limit: '2mb' }));

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
  if (!(await checkAccess(req.headers))) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  // Same-origin only: a page on another site must not be able to type into a shell.
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) return socket.destroy();
  const url = new URL(req.url || '/', BASE_URL);
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
  .then(() => server.listen(PORT, HOST, () => console.log(`[studio] server on ${BASE_URL}`)))
  .catch((e) => {
    console.error('[studio]', e.message);
    process.exit(1);
  });

const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
