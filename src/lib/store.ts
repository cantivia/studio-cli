import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { FocusSession, LayoutNode, Mode, Notification, Pane, TermInfo, TermMeta, Workspace } from './types';
import { basename, uid } from './api';
import { nextHue } from './colors';
import { DEFAULT_TERM_THEME } from './termThemes';
import { findPane, gridLayout, mapPane, panes, removePane, setRatio, splitPane, terminalPane } from './layout';

type ServerState = {
  ready: boolean;
  /** This device has merged its workspaces with the shared list; terminals wait for it. */
  synced: boolean;
  home: string;
  terminals: TermInfo[];
  meta: Record<string, TermMeta>;
  notifications: Notification[];
};

type UiState = {
  mode: Mode;
  workspaces: Workspace[];
  activeId: string | null;
  /** Claude side panel in Workspaces (shown when a Claude pane is focused). */
  claudePanel: boolean;
  /** Terminal colour theme id (see termThemes.ts). */
  terminalTheme: string;
  desktopNotifications: boolean;
  paletteOpen: boolean;
  notificationsOpen: boolean;
  newWorkspaceOpen: boolean;
  /** Settings → Phone & remote access dialog. */
  remoteOpen: boolean;
  /** Phone: the sidebar drawer is open. */
  navOpen: boolean;
};

type Actions = {
  setServer: (s: Partial<ServerState>) => void;
  setMode: (m: Mode) => void;
  set: (s: Partial<UiState>) => void;
  addWorkspace: (cwd: string, layout?: 'shell' | 'claude' | 'claude+shell', name?: string, color?: string) => void;
  selectWorkspace: (id: string) => void;
  closeWorkspace: (id: string) => void;
  /** Moves a workspace to a new slot in the sidebar (⌃1–9 follow this order). */
  moveWorkspace: (id: string, to: number) => void;
  renameWorkspace: (id: string, name: string) => void;
  recolorWorkspace: (id: string, color: string) => void;
  focusPane: (wsId: string, paneId: string) => void;
  splitFocused: (dir: 'row' | 'col', pane?: Pane) => void;
  /** Adds a pane to the active workspace and re-tiles everything into an even grid. */
  addPane: (kind: 'terminal' | 'claude' | 'browser', command?: string) => void;
  tidy: () => void;
  closePane: (wsId: string, paneId: string) => void;
  updatePane: (paneId: string, fn: (p: Pane) => Pane) => void;
  resizeSplit: (wsId: string, splitId: string, ratio: number) => void;
  toggleZoom: () => void;
};

export type Store = ServerState & UiState & Actions;

const updateWs = (list: Workspace[], id: string, fn: (w: Workspace) => Workspace) =>
  list.map((w) => (w.id === id ? fn(w) : w));

function makeLayout(cwd: string, layout: 'shell' | 'claude' | 'claude+shell'): { root: LayoutNode; focus: string } {
  if (layout === 'shell') {
    const p = terminalPane(cwd);
    return { root: { type: 'pane', pane: p }, focus: p.id };
  }
  const claude = terminalPane(cwd, 'claude');
  if (layout === 'claude') return { root: { type: 'pane', pane: claude }, focus: claude.id };
  const shell = terminalPane(cwd);
  return {
    root: { type: 'split', id: uid(), dir: 'row', ratio: 0.62, a: { type: 'pane', pane: claude }, b: { type: 'pane', pane: shell } },
    focus: claude.id,
  };
}

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      ready: false,
      synced: false,
      home: '',
      terminals: [],
      meta: {},
      notifications: [],

      mode: 'workspaces',
      workspaces: [],
      activeId: null,
      claudePanel: true,
      terminalTheme: DEFAULT_TERM_THEME,
      desktopNotifications: false,
      paletteOpen: false,
      notificationsOpen: false,
      newWorkspaceOpen: false,
      remoteOpen: false,
      navOpen: false,

      setServer: (s) => set(s),
      setMode: (mode) => set({ mode }),
      set: (s) => set(s),

      addWorkspace: (cwd, layout = 'shell', name, color) => {
        const { root, focus } = makeLayout(cwd, layout);
        // A second workspace on the same folder gets "name 2", "name 3"… so they're told apart.
        if (!name) {
          const base = basename(cwd);
          const taken = new Set(get().workspaces.map((w) => w.name));
          const sameFolder = get().workspaces.some((w) =>
            panes(w.root).some((p) => p.kind === 'terminal' && ((p.termId && get().meta[p.termId]?.cwd) || p.cwd) === cwd),
          );
          if (sameFolder) {
            let n = 2;
            while (taken.has(`${base} ${n}`)) n++;
            name = `${base} ${n}`;
          }
        }
        const ws: Workspace = {
          id: uid(),
          name: name || basename(cwd),
          customName: !!name,
          color: color || nextHue(get().workspaces.map((w) => w.color)),
          root,
          focusedPaneId: focus,
        };
        set((s) => ({ workspaces: [...s.workspaces, ws], activeId: ws.id, mode: 'workspaces', newWorkspaceOpen: false }));
      },
      selectWorkspace: (id) => set({ activeId: id, mode: 'workspaces', navOpen: false }),
      closeWorkspace: (id) => {
        const ws = get().workspaces.find((w) => w.id === id);
        if (!ws) return;
        killPanes(panes(ws.root));
        set((s) => {
          const workspaces = s.workspaces.filter((w) => w.id !== id);
          const idx = s.workspaces.findIndex((w) => w.id === id);
          const activeId = s.activeId === id ? (workspaces[Math.max(0, idx - 1)]?.id ?? null) : s.activeId;
          return { workspaces, activeId };
        });
      },
      moveWorkspace: (id, to) =>
        set((s) => {
          const list = s.workspaces.filter((w) => w.id !== id);
          const ws = s.workspaces.find((w) => w.id === id);
          if (!ws) return {};
          list.splice(Math.max(0, Math.min(to, list.length)), 0, ws);
          return { workspaces: list };
        }),
      renameWorkspace: (id, name) => set((s) => ({ workspaces: updateWs(s.workspaces, id, (w) => ({ ...w, name, customName: true })) })),
      recolorWorkspace: (id, color) => set((s) => ({ workspaces: updateWs(s.workspaces, id, (w) => ({ ...w, color })) })),
      focusPane: (wsId, paneId) => {
        set((s) => ({ workspaces: updateWs(s.workspaces, wsId, (w) => ({ ...w, focusedPaneId: paneId })) }));
      },
      splitFocused: (dir, pane) => {
        const { activeId, workspaces, meta } = get();
        const ws = workspaces.find((w) => w.id === activeId);
        if (!ws) return;
        const cur = findPane(ws.root, ws.focusedPaneId);
        const cwd =
          cur?.kind === 'terminal' ? (cur.termId && meta[cur.termId]?.cwd) || cur.cwd : (panes(ws.root).find((p) => p.kind === 'terminal') as any)?.cwd;
        const next = pane || terminalPane(cwd || get().home);
        set((s) => ({
          workspaces: updateWs(s.workspaces, ws.id, (w) => ({
            ...w,
            root: splitPane(w.root, w.focusedPaneId, dir, next),
            focusedPaneId: next.id,
            zoomedPaneId: null,
          })),
        }));
      },
      addPane: (kind, command) => {
        const { activeId, workspaces, meta, home } = get();
        const ws = workspaces.find((w) => w.id === activeId);
        if (!ws) return get().set({ newWorkspaceOpen: true });
        const cur = findPane(ws.root, ws.focusedPaneId);
        const anyTerm = panes(ws.root).find((p) => p.kind === 'terminal') as Extract<Pane, { kind: 'terminal' }> | undefined;
        const base = cur?.kind === 'terminal' ? cur : anyTerm;
        const cwd = (base?.termId && meta[base.termId]?.cwd) || base?.cwd || home;
        const pane: Pane =
          kind === 'browser' ? { id: uid(), kind: 'browser', url: '' } : terminalPane(cwd, command || (kind === 'claude' ? 'claude' : null));
        set((s) => ({
          mode: 'workspaces',
          workspaces: updateWs(s.workspaces, ws.id, (w) => ({
            ...w,
            root: gridLayout([...panes(w.root), pane]),
            focusedPaneId: pane.id,
            zoomedPaneId: null,
          })),
        }));
      },
      tidy: () =>
        set((s) => ({
          workspaces: updateWs(s.workspaces, s.activeId || '', (w) => ({ ...w, root: gridLayout(panes(w.root)), zoomedPaneId: null })),
        })),
      closePane: (wsId, paneId) => {
        const ws = get().workspaces.find((w) => w.id === wsId);
        if (!ws) return;
        const p = findPane(ws.root, paneId);
        if (p) killPanes([p]);
        const root = removePane(ws.root, paneId);
        if (!root) return get().closeWorkspace(wsId);
        set((s) => ({
          workspaces: updateWs(s.workspaces, wsId, (w) => ({
            ...w,
            root,
            focusedPaneId: w.focusedPaneId === paneId ? panes(root)[0].id : w.focusedPaneId,
            zoomedPaneId: w.zoomedPaneId === paneId ? null : w.zoomedPaneId,
          })),
        }));
      },
      updatePane: (paneId, fn) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) => (findPane(w.root, paneId) ? { ...w, root: mapPane(w.root, paneId, fn) } : w)),
        })),
      resizeSplit: (wsId, splitId, ratio) =>
        set((s) => ({ workspaces: updateWs(s.workspaces, wsId, (w) => ({ ...w, root: setRatio(w.root, splitId, ratio) })) })),
      toggleZoom: () =>
        set((s) => ({
          workspaces: updateWs(s.workspaces, s.activeId || '', (w) => ({
            ...w,
            zoomedPaneId: w.zoomedPaneId ? null : w.focusedPaneId,
          })),
        })),

    }),
    {
      // Storage key predates the rename to studio-cli; kept so saved workspaces survive.
      name: 'cmux-studio',
      // The Claude tab is gone: any Claude sessions saved from it become workspaces (terminals kept).
      merge: (persisted, current) => {
        const p = (persisted || {}) as Partial<Store> & { focusSessions?: FocusSession[]; inkTerminals?: boolean };
        const moved: Workspace[] = (p.focusSessions || []).map((f) => ({
          id: uid(),
          name: f.label.replace(/ ↺$/, ''),
          customName: true,
          color: f.color,
          root: { type: 'pane', pane: f.pane },
          focusedPaneId: f.pane.id,
        }));
        // The old on/off "Ink terminals" switch became a theme picker; carry the choice over.
        const { focusSessions: _drop, inkTerminals, ...rest } = p;
        void _drop;
        if (!rest.terminalTheme && inkTerminals) rest.terminalTheme = 'ink';
        return {
          ...current,
          ...rest,
          mode: (rest.mode as string) === 'claude' ? 'workspaces' : rest.mode || current.mode,
          workspaces: [...(rest.workspaces || []), ...moved],
          activeId: rest.activeId || rest.workspaces?.[0]?.id || moved[0]?.id || null,
        } as Store;
      },
      partialize: (s) => ({
        mode: s.mode,
        workspaces: s.workspaces,
        activeId: s.activeId,
        claudePanel: s.claudePanel,
        terminalTheme: s.terminalTheme,
        desktopNotifications: s.desktopNotifications,
      }),
    },
  ),
);

function killPanes(list: Pane[]) {
  for (const p of list) {
    if (p.kind === 'terminal' && p.termId) {
      fetch(`/api/terminals/${p.termId}`, { method: 'DELETE' }).catch(() => {});
      import('./terms').then((m) => m.disposeTerm(p.termId!));
    }
  }
}

/** Every terminal pane in the app, wherever it lives. */
export function allTerminalPanes(s: Store) {
  return [
    ...s.workspaces.flatMap((w) => panes(w.root).map((p) => ({ pane: p, wsId: w.id }))),
  ].filter((x) => x.pane.kind === 'terminal');
}
