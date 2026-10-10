import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function sh(cmd: string, args: string[], cwd?: string, timeout = 4000): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

/** pid → children, from one `ps` call. */
export async function processTree(): Promise<{ children: Map<number, number[]>; comm: Map<number, string> }> {
  const out = await sh('ps', ['-A', '-o', 'pid=,ppid=,comm=']);
  const children = new Map<number, number[]>();
  const comm = new Map<number, string>();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = +m[1];
    const ppid = +m[2];
    comm.set(pid, m[3]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  return { children, comm };
}

export function descendants(root: number, children: Map<number, number[]>): number[] {
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    out.push(pid);
    stack.push(...(children.get(pid) || []));
  }
  return out;
}

/** pid → listening TCP ports. */
export async function listeningPorts(): Promise<Map<number, number[]>> {
  const out = await sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  const map = new Map<number, number[]>();
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = +line.slice(1);
    else if (line.startsWith('n')) {
      const port = +line.slice(line.lastIndexOf(':') + 1);
      if (!port) continue;
      const list = map.get(pid) || [];
      if (!list.includes(port)) list.push(port);
      map.set(pid, list);
    }
  }
  return map;
}

/** Live cwd of a shell, so `cd` inside a pane is reflected in the sidebar. */
export async function processCwd(pid: number): Promise<string | null> {
  const out = await sh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

export type GitInfo = { branch: string; dirty: number; ahead: number; behind: number } | null;

export async function gitInfo(cwd: string): Promise<GitInfo> {
  const out = await sh('git', ['status', '--porcelain=v1', '--branch'], cwd);
  if (!out) return null;
  const [head, ...rest] = out.split('\n');
  const m = head.match(/^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.\S+)?(?: \[(.*)\])?/);
  const track = m?.[2] || '';
  return {
    branch: m?.[1] || 'HEAD',
    dirty: rest.filter(Boolean).length,
    ahead: +(track.match(/ahead (\d+)/)?.[1] || 0),
    behind: +(track.match(/behind (\d+)/)?.[1] || 0),
  };
}

export type PrInfo = { number: number; state: string; title: string; url: string } | null;

const prCache = new Map<string, { at: number; value: PrInfo }>();

/** Linked PR via gh, cached for a minute per cwd+branch since gh hits the network. */
export async function prInfo(cwd: string, branch: string): Promise<PrInfo> {
  const key = `${cwd}@${branch}`;
  const hit = prCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  prCache.set(key, { at: Date.now(), value: hit?.value ?? null });
  const out = await sh('gh', ['pr', 'view', '--json', 'number,state,title,url'], cwd, 8000);
  let value: PrInfo = null;
  try {
    if (out) value = JSON.parse(out);
  } catch {}
  prCache.set(key, { at: Date.now(), value });
  return value;
}
