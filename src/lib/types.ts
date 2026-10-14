export type TermInfo = {
  id: string;
  cwd: string;
  command: string | null;
  title: string;
  pid: number;
  createdAt: number;
  exited: boolean;
};

export type TermMeta = {
  cwd: string;
  ports: number[];
  git: { branch: string; dirty: number; ahead: number; behind: number } | null;
  pr: { number: number; state: string; title: string; url: string } | null;
  claude: { sessionId: string; status: string; name?: string; pid: number; cwd: string } | null;
};

export type Notification = {
  id: string;
  termId: string;
  title: string;
  body: string;
  source: string;
  at: number;
  read: boolean;
};

export type TerminalPane = {
  id: string;
  kind: 'terminal';
  termId: string | null;
  cwd: string;
  command: string | null;
  /** Set by the user; replaces "Terminal" / "Claude" in the pane header. */
  name?: string;
  /** Last Claude conversation seen in this pane, so a respawn can resume it. */
  sessionId?: string;
};
export type BrowserPane = { id: string; kind: 'browser'; url: string };
export type Pane = TerminalPane | BrowserPane;

export type LayoutNode =
  | { type: 'pane'; pane: Pane }
  | { type: 'split'; id: string; dir: 'row' | 'col'; ratio: number; a: LayoutNode; b: LayoutNode };

export type Workspace = {
  id: string;
  name: string;
  /** Set once the user renames it; until then the name follows the live cwd. */
  customName?: boolean;
  color?: string;
  root: LayoutNode;
  focusedPaneId: string;
  zoomedPaneId?: string | null;
};

export type FocusSession = { id: string; pane: TerminalPane; label: string; color?: string };

export type Workflow = { id: string; name: string; description: string; steps: string[]; needsInput?: string; color?: string };

export type SlashCommand = { name: string; description: string; kind: 'command' | 'skill'; scope: 'user' | 'project' };

export type SessionSummary = {
  sessionId: string;
  cwd: string;
  project: string;
  title: string;
  updatedAt: number;
  sizeKb: number;
};

export type ActivityEvent = { id: string; at: string; kind: 'user' | 'assistant' | 'tool' | 'result'; text: string; tool?: string };

export type Activity = {
  events: ActivityEvent[];
  model: string | null;
  contextTokens: number;
  outputTokens: number;
  lastAssistantText: string;
  sessionId: string;
  status: string;
};

export type Mode = 'workspaces' | 'office' | 'sessions' | 'shared';

/** A share link made by this Studio (see server/shares.ts). */
export type Share = {
  token: string;
  kind: 'session' | 'workspace';
  ref: string;
  title: string;
  createdAt: number;
  expiresAt: number;
  canType: boolean;
  url: string;
};
