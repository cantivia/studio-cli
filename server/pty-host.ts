/**
 * Owns every terminal process, in its own long-lived process, so restarting Studio's server (any edit
 * under server/ in dev) no longer kills your shells and Claude sessions. The server connects over a
 * unix socket with newline-delimited JSON; when it comes back it gets the live terminals and their
 * recent output and carries on. Keep this file small and stable: changing it means restarting the
 * host, which does end every terminal.
 */
import fs from 'node:fs';
import net from 'node:net';
import * as pty from 'node-pty';

export const HOST_VERSION = 1;
const SCROLLBACK_BYTES = 512 * 1024;
// With no server connected for this long (Studio was quit), end the terminals and exit.
const IDLE_MS = 15 * 60 * 1000;

export type HostTerm = {
  id: string;
  cwd: string;
  command: string | null;
  title: string;
  pid: number;
  createdAt: number;
  cols: number;
  rows: number;
  buffer: string;
};

type Msg = Record<string, any>;

function main(sock: string) {
  const terms = new Map<string, HostTerm & { proc: pty.IPty }>();
  let server: net.Socket | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const send = (msg: Msg) => server?.writable && server.write(JSON.stringify(msg) + '\n');
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      for (const t of terms.values()) t.proc.kill();
      process.exit(0);
    }, IDLE_MS);
  };

  const handle = (msg: Msg) => {
    const t = terms.get(msg.id);
    switch (msg.op) {
      case 'hello': {
        const list = [...terms.values()].map(({ proc: _p, ...rest }) => rest);
        return send({ op: 'hello', version: HOST_VERSION, terms: list });
      }
      case 'create': {
        try {
          const proc = pty.spawn(msg.shell, msg.args, { name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.cwd, env: msg.env });
          const term = { id: msg.id, cwd: msg.cwd, command: msg.command, title: msg.title, pid: proc.pid, createdAt: Date.now(), cols: msg.cols, rows: msg.rows, buffer: '', proc };
          terms.set(msg.id, term);
          // Sent before any output, so the server knows the terminal before its data arrives.
          send({ op: 'created', req: msg.req, id: msg.id, pid: proc.pid });
          proc.onData((data) => {
            term.buffer += data;
            if (term.buffer.length > SCROLLBACK_BYTES) term.buffer = term.buffer.slice(-SCROLLBACK_BYTES);
            send({ op: 'data', id: msg.id, data });
          });
          proc.onExit(() => {
            terms.delete(msg.id);
            send({ op: 'exit', id: msg.id });
          });
        } catch (e) {
          send({ op: 'created', req: msg.req, id: msg.id, error: String((e as Error)?.message || e) });
        }
        return;
      }
      case 'write':
        return t?.proc.write(msg.data);
      case 'resize':
        if (!t) return;
        t.cols = msg.cols;
        t.rows = msg.rows;
        return t.proc.resize(msg.cols, msg.rows);
      case 'kill':
        return t?.proc.kill();
      case 'meta':
        if (t && msg.title) t.title = msg.title;
        if (t && msg.cwd) t.cwd = msg.cwd;
        return;
    }
  };

  try {
    fs.unlinkSync(sock);
  } catch {}
  net
    .createServer((sock) => {
      // One server at a time: a restarted server replaces the old connection.
      server?.destroy();
      server = sock;
      clearTimeout(idle);
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            handle(JSON.parse(line));
          } catch {}
        }
      });
      sock.on('close', () => {
        if (server === sock) {
          server = null;
          armIdle();
        }
      });
      sock.on('error', () => {});
    })
    .listen(sock, () => {
      fs.chmodSync(sock, 0o600);
      armIdle();
    });
  process.on('SIGTERM', () => process.exit(0));
}

if (process.argv[2] === '--serve') main(process.argv[3]);
