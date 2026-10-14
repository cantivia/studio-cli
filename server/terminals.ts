import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { shellEnv } from './shell.ts';
import { DATA_DIR } from './store.ts';
import type { HostTerm } from './pty-host.ts';

const SCROLLBACK_BYTES = 512 * 1024;
const HOST_SOCK = path.join(DATA_DIR, 'pty.sock');

export type TermInfo = {
  id: string;
  cwd: string;
  command: string | null;
  title: string;
  pid: number;
  createdAt: number;
  exited: boolean;
};

type Term = TermInfo & {
  cols: number;
  rows: number;
  buffer: string;
  clients: Set<WebSocket>;
  parser: OscParser;
};

/**
 * Streaming parser for the escape sequences agents use to ask for attention:
 * a bare BEL, OSC 9 (iTerm2/ConEmu), OSC 777 (rxvt/ghostty) and OSC 99 (kitty).
 * It also picks up window titles (OSC 0/2) and cwd reports (OSC 7). State is
 * kept across chunks because a sequence can be split between two pty reads.
 */
class OscParser {
  private state: 'normal' | 'esc' | 'osc' | 'osc-esc' = 'normal';
  private osc = '';

  constructor(
    private onBell: () => void,
    private onOsc: (payload: string) => void,
  ) {}

  feed(chunk: string) {
    for (const ch of chunk) {
      switch (this.state) {
        case 'normal':
          if (ch === '\x1b') this.state = 'esc';
          else if (ch === '\x07') this.onBell();
          break;
        case 'esc':
          if (ch === ']') {
            this.state = 'osc';
            this.osc = '';
          } else this.state = ch === '\x1b' ? 'esc' : 'normal';
          break;
        case 'osc':
          if (ch === '\x07') this.finish();
          else if (ch === '\x1b') this.state = 'osc-esc';
          else if (this.osc.length < 4096) this.osc += ch;
          break;
        case 'osc-esc':
          if (ch === '\\') this.finish();
          else {
            this.state = 'osc';
            this.osc += '\x1b' + ch;
          }
          break;
      }
    }
  }

  private finish() {
    this.state = 'normal';
    this.onOsc(this.osc);
    this.osc = '';
  }
}

export type TermNotification = { termId: string; title: string; body: string; source: string };

type Msg = Record<string, any>;

/** Connection to the pty host (server/pty-host.ts), started on demand and left running across restarts. */
class PtyHost {
  private sock: net.Socket | null = null;
  private replies = new Map<string, (m: Msg) => void>();
  onMessage: (m: Msg) => void = () => {};
  onLost: () => void = () => {};

  async connect(): Promise<HostTerm[]> {
    for (let i = 0; i < 60 && !this.sock; i++) {
      try {
        await this.open();
      } catch {
        if (i === 0) startHost();
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    if (!this.sock) throw new Error(`pty host did not start (see ${path.join(DATA_DIR, 'pty-host.log')})`);
    const hello = await this.request({ op: 'hello' }, 'hello');
    return hello.terms;
  }

  private open() {
    return new Promise<void>((resolve, reject) => {
      const sock = net.connect(HOST_SOCK);
      sock.once('error', reject);
      sock.once('connect', () => {
        sock.off('error', reject);
        sock.on('error', () => {});
        this.sock = sock;
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('data', (chunk: string) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const msg = JSON.parse(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
            const key = msg.req || (msg.op === 'hello' ? 'hello' : '');
            const reply = key && this.replies.get(key);
            if (reply) {
              this.replies.delete(key);
              reply(msg);
            } else this.onMessage(msg);
          }
        });
        sock.on('close', () => {
          if (this.sock !== sock) return;
          this.sock = null;
          this.onLost();
        });
        resolve();
      });
    });
  }

  send(msg: Msg) {
    this.sock?.write(JSON.stringify(msg) + '\n');
  }

  request(msg: Msg, key: string = randomUUID()): Promise<Msg> {
    return new Promise((resolve) => {
      this.replies.set(key, resolve);
      this.send({ ...msg, req: key === 'hello' ? undefined : key });
    });
  }
}

function startHost() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(path.join(DATA_DIR, 'pty-host.log'), 'a');
  // In the Mac app the server is bundled (see scripts/build-app.mjs) and runs on Electron's own Node,
  // so the host is the bundled pty-host.mjs next to it instead of the .ts file run through tsx.
  const bundled = process.env.STUDIO_BUNDLED === '1';
  const script = fileURLToPath(new URL(bundled ? './pty-host.mjs' : './pty-host.ts', import.meta.url));
  const args = bundled ? [script, '--serve', HOST_SOCK] : ['--import', import.meta.resolve('tsx'), script, '--serve', HOST_SOCK];
  // Detached into its own session so a server restart (tsx watch) doesn't take it down.
  spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', log, log],
    env: bundled ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
  }).unref();
}

export class TerminalManager extends EventEmitter {
  private terms = new Map<string, Term>();
  private lastBell = new Map<string, number>();
  private host = new PtyHost();

  constructor(private baseUrl: string) {
    super();
    this.host.onMessage = (msg) => {
      const term = this.terms.get(msg.id);
      if (!term) return;
      if (msg.op === 'data') this.output(term, msg.data);
      else if (msg.op === 'exit') this.exited(term);
    };
    // The host itself died (rare): its terminals went with it. Panes see 'gone' and respawn.
    this.host.onLost = () => {
      for (const t of this.terms.values()) for (const ws of t.clients) ws.close(4404, 'no such terminal');
      this.terms.clear();
      this.emit('changed');
      this.start().catch((e) => console.error('[studio]', e.message));
    };
  }

  /** Connects to the pty host (starting it if needed) and picks up terminals that outlived the last server. */
  async start() {
    for (const h of await this.host.connect()) {
      const { buffer, ...info } = h;
      this.terms.set(h.id, { ...info, exited: false, buffer, clients: new Set(), parser: this.parser(h.id) });
    }
    this.emit('changed');
  }

  private parser(id: string) {
    return new OscParser(
      () => this.bell(id),
      (payload) => this.handleOsc(id, payload),
    );
  }

  private output(term: Term, data: string) {
    term.buffer += data;
    if (term.buffer.length > SCROLLBACK_BYTES) term.buffer = term.buffer.slice(-SCROLLBACK_BYTES);
    term.parser.feed(data);
    for (const ws of term.clients) if (ws.readyState === 1) ws.send(data);
  }

  private exited(term: Term) {
    term.exited = true;
    for (const ws of term.clients) ws.close(1000, 'exited');
    this.terms.delete(term.id);
    this.emit('changed');
  }

  private resize(term: Term, cols: number, rows: number) {
    term.cols = cols;
    term.rows = rows;
    this.host.send({ op: 'resize', id: term.id, cols, rows });
  }

  list(): TermInfo[] {
    return [...this.terms.values()].map(strip);
  }

  get(id: string) {
    const t = this.terms.get(id);
    return t ? strip(t) : undefined;
  }

  async create(opts: { cwd?: string; command?: string | null; cols?: number; rows?: number; accent?: string; theme?: string }): Promise<TermInfo> {
    const id = randomUUID().slice(0, 8);
    const cwd = opts.cwd || os.homedir();
    const shell = process.env.SHELL || '/bin/zsh';
    // A command runs inside a login shell so PATH, nvm, etc. match a normal
    // terminal; when it exits the user lands back in that shell.
    const args = opts.command ? ['-l', '-i', '-c', `${opts.command}; exec ${shell} -l`] : ['-l'];
    // If Studio itself was launched from inside Claude Code, its session vars
    // would make every Claude in a pane think it is a child session (no
    // transcript, no ~/.claude/sessions entry), which blinds status tracking.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) =>
          !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(k) &&
          // The Mac app starts the server with its own settings; they must not leak into your shells
          // (NODE_ENV=production or PORT=4600 would break every dev server you start there).
          !/^(ELECTRON_RUN_AS_NODE|NODE_ENV|PORT|STUDIO_(BUNDLED|ROOT|MANAGE_TUNNEL|CLOUDFLARED|PORT))$/.test(k),
      ),
    );
    const cols = opts.cols || 100;
    const rows = opts.rows || 30;
    const title = opts.command ? opts.command.split(' ')[0] : shell.split('/').pop()!;
    // Registered before the host replies: its first output can arrive in the same read as the reply.
    const term: Term = {
      id,
      cwd,
      command: opts.command || null,
      title,
      pid: 0,
      createdAt: Date.now(),
      exited: false,
      cols,
      rows,
      buffer: '',
      clients: new Set(),
      parser: this.parser(id),
    };
    this.terms.set(id, term);
    const created = await this.host.request({
      op: 'create',
      id,
      shell,
      args,
      cwd,
      cols,
      rows,
      command: opts.command || null,
      title,
      env: {
        ...env,
        ...shellEnv(shell, opts.accent, opts.theme),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'studio-cli',
        // Claude Code scrolls 3 lines per wheel step in xterm.js terminals it recognises, but it can't
        // recognise ours (xterm.js doesn't answer XTVERSION), so it falls back to a sluggish 1. A notch above 3, since 3 still felt slow.
        CLAUDE_CODE_SCROLL_SPEED: process.env.CLAUDE_CODE_SCROLL_SPEED || '4',
        STUDIO_URL: this.baseUrl,
        STUDIO_TERMINAL_ID: id,
      },
    });
    if (created.error) {
      this.terms.delete(id);
      throw new Error(created.error);
    }
    term.pid = created.pid;
    this.emit('changed');
    return strip(term);
  }

  /** `guest` is for share-link visitors: they never resize the pty, and can type only while `canType()` says so. */
  attach(id: string, ws: WebSocket, guest?: { canType: () => boolean }) {
    const term = this.terms.get(id);
    if (!term) {
      ws.close(4404, 'no such terminal');
      return;
    }
    term.clients.add(ws);
    if (term.buffer) ws.send(term.buffer);
    // Ends the replay and tells this viewer the pty's size (another device may have set it).
    ws.send('\x00' + JSON.stringify({ t: 'size', cols: term.cols, rows: term.rows }));
    ws.on('message', (raw) => {
      const msg = raw.toString();
      if (guest && (msg.startsWith('\x00') || !guest.canType())) return;
      if (msg.startsWith('\x00')) {
        // Control frame: \x00{"t":"resize","cols":..,"rows":..}
        try {
          const ctl = JSON.parse(msg.slice(1));
          if (ctl.t === 'resize' && ctl.cols > 0 && ctl.rows > 0) {
            if (ctl.redraw) {
              // Replayed output of a full-screen app (Claude) usually starts mid-frame, and a resize to the
              // same size doesn't make it repaint. Nudge the height so it redraws everything.
              this.resize(term, ctl.cols, Math.max(2, ctl.rows - 1));
              setTimeout(() => !term.exited && this.resize(term, ctl.cols, ctl.rows), 50);
            } else this.resize(term, ctl.cols, ctl.rows);
            // Every viewer learns the new size, so another device can take it back when it's used.
            const size = '\x00' + JSON.stringify({ t: 'size', cols: ctl.cols, rows: ctl.rows });
            for (const c of term.clients) if (c.readyState === 1) c.send(size);
          }
        } catch {}
        return;
      }
      this.host.send({ op: 'write', id, data: msg });
    });
    ws.on('close', () => term.clients.delete(ws));
  }

  write(id: string, text: string) {
    const term = this.terms.get(id);
    if (!term) return false;
    this.host.send({ op: 'write', id, data: text });
    return true;
  }

  kill(id: string) {
    const term = this.terms.get(id);
    if (!term) return false;
    this.host.send({ op: 'kill', id });
    return true;
  }

  setCwd(id: string, cwd: string) {
    const term = this.terms.get(id);
    if (term && term.cwd !== cwd) {
      term.cwd = cwd;
      this.host.send({ op: 'meta', id, cwd });
      this.emit('changed');
    }
  }

  private bell(id: string) {
    const now = Date.now();
    if (now - (this.lastBell.get(id) || 0) < 3000) return;
    this.lastBell.set(id, now);
    this.notify({ termId: id, title: this.terms.get(id)?.title || 'Terminal', body: 'Bell', source: 'bell' });
  }

  private handleOsc(id: string, payload: string) {
    const term = this.terms.get(id);
    if (!term) return;
    const sep = payload.indexOf(';');
    const code = sep === -1 ? payload : payload.slice(0, sep);
    const rest = sep === -1 ? '' : payload.slice(sep + 1);
    if (code === '0' || code === '2') {
      if (rest && rest !== term.title) {
        term.title = rest;
        this.host.send({ op: 'meta', id, title: rest });
        this.emit('changed');
      }
    } else if (code === '7') {
      try {
        this.setCwd(id, decodeURIComponent(new URL(rest).pathname));
      } catch {}
    } else if (code === '9' && !rest.startsWith('4;')) {
      // OSC 9;4 is a progress report, not a notification.
      this.notify({ termId: id, title: term.title, body: rest, source: 'osc9' });
    } else if (code === '777') {
      const [kind, title, ...body] = rest.split(';');
      if (kind === 'notify') this.notify({ termId: id, title: title || term.title, body: body.join(';'), source: 'osc777' });
    } else if (code === '99') {
      const body = rest.slice(rest.indexOf(';') + 1);
      if (body) this.notify({ termId: id, title: term.title, body, source: 'osc99' });
    }
  }

  notify(n: TermNotification) {
    this.emit('notification', n);
  }

}

function strip(t: Term): TermInfo {
  const { id, cwd, command, title, pid, createdAt, exited } = t;
  return { id, cwd, command, title, pid, createdAt, exited };
}
