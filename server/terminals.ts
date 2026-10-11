import { EventEmitter } from 'node:events';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { shellEnv } from './shell.ts';

const SCROLLBACK_BYTES = 512 * 1024;

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
  proc: pty.IPty;
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

export class TerminalManager extends EventEmitter {
  private terms = new Map<string, Term>();
  private lastBell = new Map<string, number>();

  constructor(private baseUrl: string) {
    super();
  }

  list(): TermInfo[] {
    return [...this.terms.values()].map(strip);
  }

  get(id: string) {
    const t = this.terms.get(id);
    return t ? strip(t) : undefined;
  }

  create(opts: { cwd?: string; command?: string | null; cols?: number; rows?: number; accent?: string; theme?: string }): TermInfo {
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
      Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(k)),
    );
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols || 100,
      rows: opts.rows || 30,
      cwd,
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
      } as Record<string, string>,
    });

    const term: Term = {
      id,
      cwd,
      command: opts.command || null,
      title: opts.command ? opts.command.split(' ')[0] : shell.split('/').pop()!,
      pid: proc.pid,
      createdAt: Date.now(),
      exited: false,
      proc,
      buffer: '',
      clients: new Set(),
      parser: new OscParser(
        () => this.bell(id),
        (payload) => this.handleOsc(id, payload),
      ),
    };
    this.terms.set(id, term);

    proc.onData((data) => {
      term.buffer += data;
      if (term.buffer.length > SCROLLBACK_BYTES) term.buffer = term.buffer.slice(-SCROLLBACK_BYTES);
      term.parser.feed(data);
      for (const ws of term.clients) if (ws.readyState === 1) ws.send(data);
    });
    proc.onExit(() => {
      term.exited = true;
      for (const ws of term.clients) ws.close(1000, 'exited');
      this.terms.delete(id);
      this.emit('changed');
    });

    this.emit('changed');
    return strip(term);
  }

  attach(id: string, ws: WebSocket) {
    const term = this.terms.get(id);
    if (!term) {
      ws.close(4404, 'no such terminal');
      return;
    }
    term.clients.add(ws);
    if (term.buffer) ws.send(term.buffer);
    ws.on('message', (raw) => {
      const msg = raw.toString();
      if (msg.startsWith('\x00')) {
        // Control frame: \x00{"t":"resize","cols":..,"rows":..}
        try {
          const ctl = JSON.parse(msg.slice(1));
          if (ctl.t === 'resize' && ctl.cols > 0 && ctl.rows > 0) term.proc.resize(ctl.cols, ctl.rows);
        } catch {}
        return;
      }
      term.proc.write(msg);
    });
    ws.on('close', () => term.clients.delete(ws));
  }

  write(id: string, text: string) {
    const term = this.terms.get(id);
    if (!term) return false;
    term.proc.write(text);
    return true;
  }

  kill(id: string) {
    const term = this.terms.get(id);
    if (!term) return false;
    term.proc.kill();
    return true;
  }

  setCwd(id: string, cwd: string) {
    const term = this.terms.get(id);
    if (term && term.cwd !== cwd) {
      term.cwd = cwd;
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

  dispose() {
    for (const t of this.terms.values()) t.proc.kill();
  }
}

function strip(t: Term): TermInfo {
  const { id, cwd, command, title, pid, createdAt, exited } = t;
  return { id, cwd, command, title, pid, createdAt, exited };
}
