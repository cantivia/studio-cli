import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// STUDIO_CLAUDE_DIR points a test Studio at its own history, so tests never touch the real ~/.claude.
const CLAUDE_DIR = process.env.STUDIO_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const PROJECTS = path.join(CLAUDE_DIR, 'projects');
const SESSIONS = path.join(CLAUDE_DIR, 'sessions');

/** Claude Code's live per-process record: ~/.claude/sessions/<pid>.json */
export type ClaudeProc = {
  pid: number;
  sessionId: string;
  cwd: string;
  status: string; // busy | idle | shell | …
  name?: string;
  version?: string;
  startedAt?: number;
};

export async function readClaudeProcs(): Promise<Map<number, ClaudeProc>> {
  const map = new Map<number, ClaudeProc>();
  let files: string[] = [];
  try {
    files = await fs.readdir(SESSIONS);
  } catch {
    return map;
  }
  await Promise.all(
    files
      .filter((f) => /^\d+\.json$/.test(f))
      .map(async (f) => {
        try {
          const d = JSON.parse(await fs.readFile(path.join(SESSIONS, f), 'utf8'));
          if (d.pid && d.sessionId) map.set(d.pid, d);
        } catch {}
      }),
  );
  return map;
}

export const projectSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
export const transcriptPath = (cwd: string, sessionId: string) =>
  path.join(PROJECTS, projectSlug(cwd), `${sessionId}.jsonl`);

/** True if Claude saved a transcript for this session (an opened-but-unused session has none). */
export const transcriptExists = async (sessionId: string) => !!(await findTranscript(sessionId));

async function readTail(file: string, bytes: number): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await fh.close();
  }
}

async function readHead(file: string, bytes: number): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const s = createReadStream(file, { start: 0, end: bytes - 1, encoding: 'utf8' });
    s.on('data', (c) => (data += c));
    s.on('end', () => resolve(data));
    s.on('error', () => resolve(data));
  });
}

export type ActivityEvent = {
  id: string;
  at: string;
  kind: 'user' | 'assistant' | 'tool' | 'result';
  text: string;
  tool?: string;
};

export type Activity = {
  events: ActivityEvent[];
  model: string | null;
  contextTokens: number;
  outputTokens: number;
  lastAssistantText: string;
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .filter((c) => c?.type === 'text')
      .map((c) => c.text)
      .join('\n');
  return '';
}

function toolSummary(name: string, input: Record<string, any> = {}): string {
  const p = input.file_path || input.path || input.notebook_path;
  if (p) return String(p).replace(os.homedir(), '~');
  if (input.command) return String(input.description || input.command);
  if (input.pattern) return `${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
  if (input.url) return String(input.url);
  if (input.query) return String(input.query);
  if (input.description) return String(input.description);
  if (input.prompt) return String(input.prompt);
  if (input.skill) return String(input.skill);
  return name;
}

const isNoise = (t: string) =>
  !t.trim() ||
  t.startsWith('<command-') ||
  t.startsWith('<local-command') ||
  t.startsWith('<system-reminder>') ||
  t.startsWith('Caveat:') ||
  t.startsWith('[Request interrupted');

export async function readActivity(file: string, limit = 120): Promise<Activity> {
  const activity: Activity = { events: [], model: null, contextTokens: 0, outputTokens: 0, lastAssistantText: '' };
  let text: string;
  try {
    text = await readTail(file, 768 * 1024);
  } catch {
    return activity;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.isSidechain || rec.isMeta) continue;
    const at = rec.timestamp || '';
    const msg = rec.message;
    if (rec.type === 'user' && msg) {
      if (typeof msg.content === 'string' || msg.content?.some?.((c: any) => c.type === 'text')) {
        const t = textOf(msg.content);
        if (!isNoise(t)) activity.events.push({ id: rec.uuid, at, kind: 'user', text: t.slice(0, 600) });
      }
    } else if (rec.type === 'assistant' && msg) {
      activity.model = msg.model || activity.model;
      const u = msg.usage;
      if (u) {
        activity.contextTokens =
          (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        activity.outputTokens += u.output_tokens || 0;
      }
      for (const c of msg.content || []) {
        if (c.type === 'text' && c.text?.trim()) {
          activity.lastAssistantText = c.text;
          activity.events.push({ id: `${rec.uuid}-t`, at, kind: 'assistant', text: c.text.slice(0, 600) });
        } else if (c.type === 'tool_use') {
          activity.events.push({ id: c.id, at, kind: 'tool', tool: c.name, text: toolSummary(c.name, c.input) });
        }
      }
    }
  }
  activity.events = activity.events.slice(-limit);
  return activity;
}

export type SessionSummary = {
  sessionId: string;
  cwd: string;
  project: string;
  title: string;
  updatedAt: number;
  sizeKb: number;
};

/** Title and folder of a transcript, read from its first 96 KB. Null for sessions with no prompt yet. */
async function summarize(file: string, mtime: number, size: number): Promise<SessionSummary | null> {
  const head = await readHead(file, 96 * 1024);
  let cwd = '';
  let title = '';
  let custom = '';
  for (const line of head.split('\n')) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.cwd && !cwd) cwd = rec.cwd;
    if (rec.type === 'custom-title' && rec.customTitle) custom = rec.customTitle;
    if (rec.type === 'summary' && rec.summary && !custom) custom = rec.summary;
    if (!title && rec.type === 'user' && !rec.isMeta && !rec.isSidechain) {
      const t = textOf(rec.message?.content);
      const clean = t.replace(/<\/?[a-z_-]+[^>]*>/gi, ' ').replace(/\[Image #\d+\]/g, '').replace(/\s+/g, ' ').trim();
      if (!isNoise(t) && clean) title = clean.slice(0, 140);
    }
    if (cwd && title) break;
  }
  if (!cwd || (!title && !custom)) return null;
  return {
    sessionId: path.basename(file, '.jsonl'),
    cwd,
    project: path.basename(cwd),
    title: custom || title,
    updatedAt: mtime,
    sizeKb: Math.round(size / 1024),
  };
}

export async function listSessions(limit = 60): Promise<SessionSummary[]> {
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(PROJECTS);
  } catch {
    return [];
  }
  const files: { file: string; mtime: number; size: number }[] = [];
  await Promise.all(
    dirs.map(async (d) => {
      try {
        for (const f of await fs.readdir(path.join(PROJECTS, d))) {
          if (!f.endsWith('.jsonl')) continue;
          const file = path.join(PROJECTS, d, f);
          const st = await fs.stat(file);
          files.push({ file, mtime: st.mtimeMs, size: st.size });
        }
      } catch {}
    }),
  );
  files.sort((a, b) => b.mtime - a.mtime);
  const out: SessionSummary[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const s = await summarize(f.file, f.mtime, f.size);
    if (s) out.push(s);
  }
  return out;
}

/** The saved transcript for a session, if any. */
export async function findTranscript(sessionId: string): Promise<string | null> {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  try {
    for (const d of await fs.readdir(PROJECTS)) {
      const file = path.join(PROJECTS, d, `${sessionId}.jsonl`);
      try {
        await fs.access(file);
        return file;
      } catch {}
    }
  } catch {}
  return null;
}

export async function sessionInfo(sessionId: string): Promise<(SessionSummary & { file: string }) | null> {
  const file = await findTranscript(sessionId);
  if (!file) return null;
  const st = await fs.stat(file);
  const sum = await summarize(file, st.mtimeMs, st.size);
  return sum && { ...sum, file };
}

/** Saves a transcript someone shared into this Mac's Claude history so `claude --resume <id>` finds it in `cwd`. */
export async function importTranscript(sessionId: string, cwd: string, transcript: string): Promise<boolean> {
  if (!/^[\w-]+$/.test(sessionId)) throw new Error('Bad session id');
  // Never overwrite a conversation you already have.
  if (await findTranscript(sessionId)) return false;
  const file = transcriptPath(cwd, sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, transcript, { flag: 'wx' });
  return true;
}

export type SlashCommand = { name: string; description: string; kind: 'command' | 'skill'; scope: 'user' | 'project' };

function frontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

async function scanCommands(dir: string, scope: SlashCommand['scope']): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  try {
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith('.md')) continue;
      const md = await fs.readFile(path.join(dir, f), 'utf8');
      const fm = frontmatter(md);
      out.push({
        name: f.replace(/\.md$/, ''),
        description: fm.description || md.replace(/^---[\s\S]*?---/, '').trim().split('\n')[0].slice(0, 120),
        kind: 'command',
        scope,
      });
    }
  } catch {}
  return out;
}

async function scanSkills(dir: string, scope: SlashCommand['scope'], depth = 0): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const sub = path.join(dir, e);
    try {
      const md = await fs.readFile(path.join(sub, 'SKILL.md'), 'utf8');
      const fm = frontmatter(md);
      out.push({ name: fm.name || e, description: (fm.description || '').slice(0, 160), kind: 'skill', scope });
    } catch {
      if (depth < 2) out.push(...(await scanSkills(sub, scope, depth + 1)));
    }
  }
  return out;
}

export async function listSlashCommands(cwd?: string): Promise<SlashCommand[]> {
  const lists = await Promise.all([
    scanCommands(path.join(CLAUDE_DIR, 'commands'), 'user'),
    scanSkills(path.join(CLAUDE_DIR, 'skills'), 'user'),
    cwd ? scanCommands(path.join(cwd, '.claude', 'commands'), 'project') : [],
    cwd ? scanSkills(path.join(cwd, '.claude', 'skills'), 'project') : [],
  ]);
  const seen = new Set<string>();
  return lists.flat().filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}
