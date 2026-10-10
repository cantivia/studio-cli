import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { DATA_DIR } from './store.ts';
import type { TermInfo } from './terminals.ts';

/**
 * Pixel offices. The vendored Pixel Agents UI (public/office) connects here with
 * ?office=<key>. Each Studio workspace is an office ("all" holds everything);
 * every open terminal in it is a character, driven by Studio's own status data.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LAYOUT = path.join(ROOT, 'vendor/pixel-agents/webview-ui/public/assets/default-layout-1.json');
const LAYOUT_DIR = path.join(DATA_DIR, 'offices');
const READING_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LS', 'NotebookRead'];

export type OfficeDef = { key: string; name: string; color?: string; termIds: string[] };

/** What a character is doing, recomputed every poll. */
export type AgentState = {
  termId: string;
  label: string;
  active: boolean;
  tool: string | null; // tool name driving the animation (typing vs reading)
  status: string; // overlay text, e.g. "Editing App.tsx"
  done: boolean; // finished a turn: green checkmark
};

type Client = { ws: WebSocket; office: string; sent: Map<number, string> };

const hexHue = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round(((h * 60) + 360) % 360);
};

export class Offices {
  private defs: OfficeDef[] = [];
  private clients = new Set<Client>();
  private ids = new Map<string, number>();
  private nextId = 1;
  private states = new Map<string, AgentState>();
  private terminals: TermInfo[] = [];
  onFocus: (termId: string) => void = () => {};

  setDefs(defs: OfficeDef[]) {
    this.defs = defs;
    this.sync();
  }

  private idFor(termId: string) {
    if (!this.ids.has(termId)) this.ids.set(termId, this.nextId++);
    return this.ids.get(termId)!;
  }

  private def(key: string): OfficeDef {
    if (key === 'all') return { key, name: 'Everyone', termIds: this.terminals.map((t) => t.id) };
    return this.defs.find((d) => d.key === key) || { key, name: key, termIds: [] };
  }

  private members(key: string) {
    const live = new Set(this.terminals.map((t) => t.id));
    return this.def(key).termIds.filter((id) => live.has(id) && this.states.has(id));
  }

  private layout(key: string) {
    try {
      return JSON.parse(fs.readFileSync(path.join(LAYOUT_DIR, `${key}.json`), 'utf8'));
    } catch {}
    const layout = JSON.parse(fs.readFileSync(DEFAULT_LAYOUT, 'utf8'));
    // Same floor plan, but each workspace's lounge is carpeted in its own colour.
    const color = this.def(key).color;
    if (color) {
      const h = hexHue(color);
      layout.tileColors = layout.tileColors.map((c: any) => (c && c.h === 209 && c.s > 0 ? { ...c, h, s: 45 } : c));
    }
    return layout;
  }

  attach(ws: WebSocket, office: string) {
    const client: Client = { ws, office, sent: new Map() };
    this.clients.add(client);
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'webviewReady') this.hello(client);
      else if (msg.type === 'saveLayout' && msg.layout) {
        fs.mkdirSync(LAYOUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(LAYOUT_DIR, `${office.replace(/[^\w-]/g, '')}.json`), JSON.stringify(msg.layout));
      } else if (msg.type === 'focusAgent') {
        const termId = [...this.ids].find(([, id]) => id === msg.id)?.[0];
        if (termId) this.onFocus(termId);
      }
    });
    ws.on('close', () => this.clients.delete(client));
  }

  private send(c: Client, msg: unknown) {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  private hello(c: Client) {
    c.sent.clear();
    this.send(c, { type: 'providerCapabilities', readingTools: READING_TOOLS, subagentToolNames: ['Task', 'Agent'] });
    this.send(c, {
      type: 'settingsLoaded',
      soundEnabled: false,
      lastSeenVersion: '1.4',
      extensionVersion: '1.4.1',
      watchAllSessions: false,
      alwaysShowLabels: false, // hover a character for its label; overlapping labels were unreadable
      ghostHeadlessAgents: false,
      hooksEnabled: false,
      hooksInfoShown: true,
      externalAssetDirectories: [],
      showAreas: false,
    });
    this.send(c, { type: 'layoutLoaded', layout: this.layout(c.office) });
    const ids = this.members(c.office);
    const agents = ids.map((t) => this.idFor(t));
    this.send(c, {
      type: 'existingAgents',
      agents,
      agentMeta: {},
      folderNames: Object.fromEntries(ids.map((t) => [this.idFor(t), this.states.get(t)!.label])),
      externalAgents: {},
    });
    for (const t of ids) this.push(c, t);
  }

  /** Called by the poller with fresh terminal states. */
  update(terminals: TermInfo[], states: AgentState[]) {
    this.terminals = terminals;
    this.states = new Map(states.map((s) => [s.termId, s]));
    this.sync();
  }

  private sync() {
    for (const c of this.clients) {
      const want = new Set(this.members(c.office).map((t) => this.idFor(t)));
      for (const id of [...c.sent.keys()]) {
        if (!want.has(id)) {
          this.send(c, { type: 'agentClosed', id });
          c.sent.delete(id);
        }
      }
      for (const termId of this.members(c.office)) {
        const id = this.idFor(termId);
        if (!c.sent.has(id)) {
          const palette = (id - 1) % 6;
          this.send(c, { type: 'agentCreated', id, folderName: this.states.get(termId)!.label, palette });
        }
        this.push(c, termId);
      }
    }
  }

  /** Sends a character's state only when it changed since the last send to this client. */
  private push(c: Client, termId: string) {
    const s = this.states.get(termId);
    if (!s) return;
    const id = this.idFor(termId);
    const sig = `${s.active}|${s.tool}|${s.status}|${s.done}`;
    if (c.sent.get(id) === sig) return;
    const first = !c.sent.has(id);
    c.sent.set(id, sig);
    this.send(c, { type: 'agentToolsClear', id });
    if (s.active) {
      this.send(c, { type: 'agentToolStart', id, toolId: `${id}-${Date.now()}`, status: s.status, toolName: s.tool || 'Bash' });
      this.send(c, { type: 'agentStatus', id, status: 'active' });
    } else if (s.done || !first) {
      // A finished Claude turn gets the green checkmark; an idle shell just wanders.
      this.send(c, { type: 'agentStatus', id, status: 'waiting', awaitingInput: false });
    }
  }
}

export const offices = new Offices();

const VERB: Record<string, string> = {
  Read: 'Reading',
  Edit: 'Editing',
  Write: 'Writing',
  MultiEdit: 'Editing',
  Bash: 'Running',
  Grep: 'Searching',
  Glob: 'Searching',
  WebFetch: 'Fetching',
  WebSearch: 'Searching the web',
  Task: 'Delegating',
  Agent: 'Delegating',
  Skill: 'Using skill',
};

export function toolStatus(tool: string, detail: string) {
  const short = detail.split('/').pop() || detail;
  return `${VERB[tool] || tool} ${short}`.slice(0, 48);
}
