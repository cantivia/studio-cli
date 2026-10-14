import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { DATA_DIR } from './store.ts';
import type { TermInfo } from './terminals.ts';

/**
 * Pixel offices. The vendored Pixel Agents UI (public/office) connects here with
 * ?office=<key>. Each Studio workspace is an office; "all" is a building with one
 * room per workspace. Every open terminal is a character, driven by Studio's own
 * status data.
 */

const ROOT = process.env.STUDIO_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LAYOUT = path.join(ROOT, 'vendor/pixel-agents/webview-ui/public/assets/default-layout-1.json');
const LAYOUT_DIR = path.join(DATA_DIR, 'offices');
const READING_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LS', 'NotebookRead'];
const VOID = 255;
const WALL = 0;

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

type Client = {
  ws: WebSocket;
  office: string;
  sent: Map<number, string>;
  names: Map<number, string>; // folderName each character was created with
  layoutSig: string;
  areaSig: string;
};

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
    return key === 'all' && this.defs.length ? this.building() : this.room(key);
  }

  private room(key: string) {
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

  /** Room label per workspace: its name, made unique. */
  private roomLabels() {
    const seen = new Map<string, number>();
    return new Map(
      this.defs.map((d) => {
        const n = (seen.get(d.name) || 0) + 1;
        seen.set(d.name, n);
        return [d.key, n > 1 ? `${d.name} ${n}` : d.name];
      }),
    );
  }

  /**
   * The "all" office: every workspace's room (its own saved layout or the tinted
   * default), cropped to its walls and laid out in a grid. Each room's floor is an
   * Area, so characters sit and wander in their own workspace's room.
   */
  private building() {
    const labels = this.roomLabels();
    const rooms = this.defs.map((d) => {
      const l = this.room(d.key);
      let c0 = Infinity, c1 = -1, r0 = Infinity, r1 = -1;
      l.tiles.forEach((t: number, i: number) => {
        if (t === VOID) return;
        const c = i % l.cols, r = Math.floor(i / l.cols);
        c0 = Math.min(c0, c); c1 = Math.max(c1, c);
        r0 = Math.min(r0, r); r1 = Math.max(r1, r);
      });
      // Wall-mounted furniture hangs above the wall row; keep one spare row over it.
      for (const f of l.furniture) r0 = Math.min(r0, f.row);
      r0 = Math.max(0, r0 - 1);
      return { def: d, l, c0, r0, w: c1 - c0 + 2, h: r1 - r0 + 1 }; // +1 col: gap between rooms
    });
    const cw = Math.max(...rooms.map((r) => r.w));
    const ch = Math.max(...rooms.map((r) => r.h));
    // Columns that make the whole building closest to a wide (16:9-ish) pane.
    let across = 1;
    for (let c = 1, best = Infinity; c <= rooms.length; c++) {
      const score = Math.abs(Math.log((c * cw) / (Math.ceil(rooms.length / c) * ch) / 1.8));
      if (score < best) (best = score), (across = c);
    }
    const cols = across * cw;
    const rows = Math.ceil(rooms.length / across) * ch;
    const tiles: number[] = new Array(cols * rows).fill(VOID);
    const tileColors: unknown[] = new Array(cols * rows).fill(null);
    const areaTiles: (string | null)[] = new Array(cols * rows).fill(null);
    const furniture: any[] = [];
    rooms.forEach(({ def, l, c0, r0, w, h }, i) => {
      const ox = (i % across) * cw, oy = Math.floor(i / across) * ch;
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w - 1; c++) {
          const src = (r0 + r) * l.cols + c0 + c;
          if (r0 + r >= l.rows || c0 + c >= l.cols) continue;
          const dst = (oy + r) * cols + ox + c;
          tiles[dst] = l.tiles[src];
          tileColors[dst] = l.tileColors?.[src] ?? null;
          if (l.tiles[src] !== VOID && l.tiles[src] !== WALL) areaTiles[dst] = labels.get(def.key)!;
        }
      }
      // Furniture uids stay stable per workspace so seats survive rooms moving around.
      for (const f of l.furniture) furniture.push({ ...f, uid: `${def.key}:${f.uid}`, col: f.col - c0 + ox, row: f.row - r0 + oy });
    });
    const areas = this.defs.map((d) => ({ label: labels.get(d.key)!, color: d.color || '#a78bfa' }));
    return { version: 1, cols, rows, tiles, tileColors, furniture, areas, areaTiles };
  }

  /** In the building, a terminal's name gets its workspace appended when another room has one called the same. */
  private folderName(c: Client, termId: string) {
    const label = this.states.get(termId)!.label;
    if (c.office !== 'all') return label;
    const ws = this.defs.find((d) => d.termIds.includes(termId));
    const clash = ws && this.defs.some((d) => d !== ws && d.termIds.some((t) => this.states.get(t)?.label === label));
    return clash ? `${label} · ${this.roomLabels().get(ws.key)}` : label;
  }

  /** Which room each character belongs to, keyed by the folderName it was created with. */
  private sendAreas(c: Client) {
    if (c.office !== 'all') return;
    const labels = this.roomLabels();
    const mappings: Record<string, string[]> = {};
    for (const termId of this.members('all')) {
      const name = c.names.get(this.idFor(termId));
      const ws = this.defs.find((d) => d.termIds.includes(termId));
      if (name && ws) mappings[name] = [labels.get(ws.key)!];
    }
    const sig = JSON.stringify(mappings);
    if (sig === c.areaSig) return;
    c.areaSig = sig;
    this.send(c, { type: 'areaMappingsLoaded', mappings });
  }

  /** Rooms change when workspaces are added, removed, renamed or recoloured. */
  private buildingSig() {
    return JSON.stringify(this.defs.map((d) => [d.key, d.name, d.color]));
  }

  attach(ws: WebSocket, office: string) {
    const client: Client = { ws, office, sent: new Map(), names: new Map(), layoutSig: '', areaSig: '' };
    this.clients.add(client);
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'webviewReady') this.hello(client);
      else if (msg.type === 'saveLayout' && msg.layout && office !== 'all') {
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
    c.areaSig = '';
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
      showAreas: c.office === 'all', // room names on the walls, floors tinted per workspace
    });
    c.layoutSig = this.buildingSig();
    this.send(c, { type: 'layoutLoaded', layout: this.layout(c.office) });
    const ids = this.members(c.office);
    const agents = ids.map((t) => this.idFor(t));
    c.names = new Map(ids.map((t) => [this.idFor(t), this.folderName(c, t)]));
    this.sendAreas(c); // before the agents, so they take seats in their own room
    this.send(c, {
      type: 'existingAgents',
      agents,
      agentMeta: {},
      folderNames: Object.fromEntries(c.names),
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
      if (c.office === 'all' && this.defs.length && c.layoutSig !== this.buildingSig()) {
        c.layoutSig = this.buildingSig();
        this.send(c, { type: 'layoutLoaded', layout: this.building() });
      }
      const want = new Set(this.members(c.office).map((t) => this.idFor(t)));
      for (const id of [...c.sent.keys()]) {
        if (!want.has(id)) {
          this.send(c, { type: 'agentClosed', id });
          c.sent.delete(id);
          c.names.delete(id);
        }
      }
      const fresh = this.members(c.office).filter((t) => !c.sent.has(this.idFor(t)));
      for (const termId of fresh) c.names.set(this.idFor(termId), this.folderName(c, termId));
      this.sendAreas(c);
      for (const termId of this.members(c.office)) {
        const id = this.idFor(termId);
        if (!c.sent.has(id)) {
          const palette = (id - 1) % 6;
          this.send(c, { type: 'agentCreated', id, folderName: c.names.get(id), palette });
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
    c.sent.set(id, sig);
    this.send(c, { type: 'agentToolsClear', id });
    if (s.active) {
      this.send(c, { type: 'agentToolStart', id, toolId: `${id}-${Date.now()}`, status: s.status, toolName: s.tool || 'Bash' });
      this.send(c, { type: 'agentStatus', id, status: 'active' });
    } else if (s.done) {
      // A finished Claude turn gets the green checkmark.
      this.send(c, { type: 'agentStatus', id, status: 'waiting', awaitingInput: false });
    } else {
      // Anything idle gets up and wanders (any status but active/waiting means idle, with no bubble).
      this.send(c, { type: 'agentStatus', id, status: 'idle' });
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
