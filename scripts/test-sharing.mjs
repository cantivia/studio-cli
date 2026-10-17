#!/usr/bin/env node
/**
 * Two Studios side by side, as if on two Macs, testing share links and Claude connections over the API:
 * link lengths, pane links, who's watching, kick, guest messages, connect, tell, peek, pause, the automatic brake,
 * and disconnect.  `node scripts/test-sharing.mjs`
 *
 * Each Studio has its own port (4751, 4752), data dir and Claude dir, so the real Studio and ~/.claude are never
 * touched. The "Claude" panes are stand-ins (a `tee` that records what's typed into it, plus a fake
 * sessions/<pid>.json and transcript), so the test costs no Claude usage.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(name);
  console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${name}${detail ? `  (${detail})` : ''}`);
};
async function until(fn, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
}

function studio(name, port) {
  const dir = path.join(T, name);
  const claudeDir = path.join(T, `claude-${name}`);
  fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|NODE_ENV$)/.test(k)));
  Object.assign(env, { PORT: String(port), STUDIO_API_PORT: String(port), STUDIO_DATA_DIR: dir, STUDIO_CLAUDE_DIR: claudeDir });
  const proc = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(`[${name}] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, route, body, headers = {}) => {
    const r = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text };
  };
  return { name, port, base, dir, claudeDir, proc, call, get: (r) => call('GET', r), post: (r, b, h) => call('POST', r, b, h) };
}

/** A pane running a stand-in Claude: `tee` records what's typed; Studio sees a Claude session for it. */
async function fakeClaude(s, sessionId) {
  const proj = path.join(T, `proj-${s.name}`);
  fs.mkdirSync(proj, { recursive: true });
  const received = path.join(T, `received-${s.name}.txt`);
  const term = (await s.post('/api/terminals', { cwd: proj, command: `tee ${received}` })).json;
  const pid = await until(() => {
    const line = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .find((l) => l.trim().endsWith(`tee ${received}`));
    return line && Number(line.trim().split(/\s+/)[0]);
  });
  fs.writeFileSync(path.join(s.claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: proj, status: 'idle' }));
  const slug = proj.replace(/[^a-zA-Z0-9]/g, '-');
  fs.mkdirSync(path.join(s.claudeDir, 'projects', slug), { recursive: true });
  const rec = (type, content, extra = {}) => JSON.stringify({ type, uuid: Math.random().toString(36).slice(2), timestamp: new Date().toISOString(), message: { role: type, content }, ...extra });
  fs.writeFileSync(
    path.join(s.claudeDir, 'projects', slug, `${sessionId}.jsonl`),
    [
      rec('user', `please fix the ${s.name} build`),
      rec('assistant', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }]),
      rec('assistant', [{ type: 'text', text: `The ${s.name} build is fixed.` }]),
    ].join('\n') + '\n',
  );
  const ok = await until(async () => (await s.get('/api/state')).json?.meta?.[term.id]?.claude);
  return { term: term.id, received, proj, ok: !!ok };
}
const got = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

const A = studio('a', 4751);
const B = studio('b', 4752);
const cli = (s, term, ...args) => {
  try {
    return execFileSync(path.join(ROOT, 'bin/studio'), args, { encoding: 'utf8', env: { ...process.env, STUDIO_URL: s.base, STUDIO_TERMINAL_ID: term } });
  } catch (e) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
};

try {
  for (const s of [A, B]) check(`studio ${s.name} starts`, !!(await until(async () => (await s.get('/api/state').catch(() => ({}))).status === 200, 30_000)));
  const ca = await fakeClaude(A, 'sess-a');
  const cb = await fakeClaude(B, 'sess-b');
  check('stand-in Claudes are recognised', ca.ok && cb.ok);
  const shell = (await A.post('/api/terminals', { cwd: T, command: 'sleep 876543' })).json;
  await A.call('PUT', '/api/workspaces', {
    workspaces: [
      {
        id: 'wa',
        name: 'proj-a',
        root: { type: 'split', a: { type: 'pane', pane: { id: 'pa', termId: ca.term, command: 'claude', name: 'Claude' } }, b: { type: 'pane', pane: { id: 'ps', termId: shell.id, command: 'sleep 876543' } } },
      },
    ],
  });
  await B.call('PUT', '/api/workspaces', { workspaces: [{ id: 'wb', name: 'proj-b', root: { type: 'pane', pane: { id: 'pb', termId: cb.term, command: 'claude', name: 'Claude' } } }] });

  // 1. Link lengths.
  const w = (await A.post('/api/shares', { kind: 'workspace', ref: 'wa' })).json;
  const never = (await A.call('PATCH', `/api/shares/${w.token}`, { lasts: 'never' })).json;
  check('a link can have no end date', never.expiresAt === null);
  const hour = (await A.call('PATCH', `/api/shares/${w.token}`, { lasts: '1h' })).json;
  check('…or last an hour from now', Math.abs(hour.expiresAt - (Date.now() + 3_600_000)) < 10_000);

  // 2. One pane.
  const p = (await A.post('/api/shares', { kind: 'pane', ref: 'pa' })).json;
  const pv = (await A.get(`/share/api/${p.token}`)).json;
  check('a pane link shows just that pane', pv?.kind === 'pane' && pv.panes.length === 1 && pv.panes[0].id === ca.term && pv.panes[0].claude, JSON.stringify(pv?.panes));
  const wv = (await A.get(`/share/api/${w.token}`)).json;
  check('a workspace link shows both panes', wv?.panes?.length === 2);

  // 3. Who's watching.
  await A.post(`/share/api/${w.token}/hello`, { v: 'visitor-1234' }, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
  const listed = (await A.get('/api/shares')).json.links.find((l) => l.token === w.token);
  check('the link shows who is watching', listed.watching.length === 1 && listed.watching[0].device === 'iPhone');
  check('…and when it was opened', listed.opens?.length === 1 && listed.opens[0].visitor === 'visitor-1234');

  // 4. Kick.
  const ws = new WebSocket(`ws://127.0.0.1:${A.port}/share/ws/${w.token}/term/${ca.term}?v=visitor-1234`);
  await new Promise((r) => ws.on('open', r).on('error', r));
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  await A.post(`/api/shares/${w.token}/kick`, { visitor: 'visitor-1234' });
  check('kick closes their terminals', (await Promise.race([closed, sleep(3000)])) === 4403);
  check('…and refuses their page', (await A.post(`/share/api/${w.token}/hello`, { v: 'visitor-1234' })).status === 403 && (await A.get(`/share/api/${w.token}?v=visitor-1234`)).status === 403);

  // 5. Guests message Claude.
  const msg = { pane: ca.term, text: 'hello from a guest', name: 'Sam', v: 'visitor-5678' };
  check('messages are off unless the link allows them', (await A.post(`/share/api/${w.token}/message`, msg)).status === 403);
  await A.call('PATCH', `/api/shares/${w.token}`, { canMessage: true });
  check('a guest message is accepted', (await A.post(`/share/api/${w.token}/message`, msg)).json?.ok);
  check('…and typed into Claude', !!(await until(() => /Message from Sam \(a guest on your share link\)[\s\S]*hello from a guest/.test(got(ca.received)))));
  check('only Claude panes take messages', (await A.post(`/share/api/${w.token}/message`, { ...msg, pane: shell.id })).status === 400);

  // 6. Connect two Claudes.
  const inv = (await A.post('/api/claude-links/invite', { paneId: 'pa' })).json;
  const seen = (await B.get(`/api/claude-links/inspect?url=${encodeURIComponent(inv.url)}`)).json;
  check("the teammate's Studio recognises a Claude link", seen?.kind === 'claude' && !!seen.name, JSON.stringify(seen));
  const joined = (await B.post('/api/claude-links/join', { url: inv.url, paneId: 'pb' })).json;
  check('it joins with one of its Claude panes', !!joined?.id, JSON.stringify(joined));
  const online = await until(async () => {
    const [la, lb] = [(await A.get('/api/claude-links')).json, (await B.get('/api/claude-links')).json];
    return la?.[0]?.online && la[0].partner && lb?.[0]?.online && lb[0].partner && [la[0], lb[0]];
  });
  check('both sides show the connection online', !!online);
  check('both Claudes are told how to talk', !!(await until(() => /You're now connected to/.test(got(ca.received)) && /You're now connected to/.test(got(cb.received)))));

  // 7. Tell, through the real bin/studio.
  const sent = cli(B, cb.term, 'tell', 'what are you working on?');
  check('studio tell sends', /Sent to/.test(sent), sent.trim());
  check("…and it arrives in the other Claude", !!(await until(() => /Message from .*'s Claude \(reply with: studio tell[\s\S]*what are you working on\?/.test(got(ca.received)))));
  check('a pane with no connection is told so', /isn’t connected/.test(cli(A, shell.id, 'tell', 'hi')));

  // 8. Peek.
  const peeked = cli(B, cb.term, 'peek');
  check("studio peek shows the other Claude's work", /has been doing[\s\S]*please fix the a build[\s\S]*\(Bash\) npm test[\s\S]*The a build is fixed/.test(peeked), peeked.slice(0, 120));

  // 9. Pause from one side pauses both.
  await B.post(`/api/claude-links/${joined.id}`, { paused: true });
  const pausedA = await until(async () => (await A.get('/api/claude-links')).json?.[0]?.paused);
  check('pausing on one side pauses the other', !!pausedA);
  check('…and tell is refused while paused', /paused/.test(cli(A, ca.term, 'tell', 'still there?')));
  await A.post(`/api/claude-links/${joined.id}`, { paused: false });
  check('resume works from the other side', !!(await until(async () => !(await B.get('/api/claude-links')).json?.[0]?.paused)));

  // 10. The brake: 20 messages with nobody typing pause the connection.
  let last = '';
  for (let i = 0; i < 20; i++) last = cli(i % 2 ? A : B, i % 2 ? ca.term : cb.term, 'tell', `ping ${i}`);
  const auto = await until(async () => {
    const l = (await A.get('/api/claude-links')).json?.[0];
    return l?.paused && l.pausedBy === 'auto' && l;
  });
  check('20 messages with nobody typing pause it', !!auto && /Sent to/.test(last));
  check('…and the next tell explains why', /after many messages/.test(cli(B, cb.term, 'tell', 'one more')));

  // 11. Disconnect from the joining side: the link is gone on both.
  await B.call('DELETE', `/api/claude-links/${joined.id}`);
  const gone = await until(async () => (await A.get('/api/claude-links')).json?.length === 0 && (await B.get('/api/claude-links')).json?.length === 0);
  check('disconnecting removes it on both sides', !!gone);
  check("…and turns off the inviter's link", !(await A.get('/api/shares')).json.links.some((l) => l.kind === 'claude'));
} catch (e) {
  check('test ran to the end', false, e.stack);
} finally {
  for (const s of [A, B]) s.proc.kill('SIGKILL');
  await sleep(500);
  for (let pass = 0; pass < 2; pass++, await sleep(800))
    for (const line of execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')) {
      const [pid, ...cmd] = line.trim().split(/\s+/);
      const c = cmd.join(' ');
      if (Number(pid) !== process.pid && (c.includes(T) || c === 'sleep 876543'))
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch {}
    }
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(failures.length ? `\n\x1b[31m${failures.length} failed\x1b[0m` : '\n\x1b[32mALL PASSED\x1b[0m');
process.exit(failures.length ? 1 : 0);
