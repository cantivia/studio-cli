import { api, uid } from './api';
import { findPane, panes } from './layout';
import { useStore } from './store';
import type { Workspace } from './types';

/**
 * Workspaces are shared by every device (Mac, iPad, phone) through the server, so you can switch
 * devices and carry on in the same terminals. Which pane is focused or zoomed stays per device.
 */
type Shared = Omit<Workspace, 'focusedPaneId' | 'zoomedPaneId'>;

const clientId = uid();
let applying = false;
let lastSent = '';
let subscribed = false;
let timer: ReturnType<typeof setTimeout> | undefined;

const shared = (list: Workspace[]): Shared[] => list.map(({ focusedPaneId: _f, zoomedPaneId: _z, ...w }) => w);

function apply(list: Shared[]) {
  const s = useStore.getState();
  const mine = new Map(s.workspaces.map((w) => [w.id, w]));
  const workspaces = list.map((w): Workspace => {
    const m = mine.get(w.id);
    const keep = (id?: string | null) => (id && findPane(w.root, id) ? id : null);
    return { ...w, focusedPaneId: keep(m?.focusedPaneId) || panes(w.root)[0]?.id || '', zoomedPaneId: keep(m?.zoomedPaneId) };
  });
  applying = true;
  s.set({ workspaces, activeId: workspaces.some((w) => w.id === s.activeId) ? s.activeId : (workspaces[0]?.id ?? null) });
  applying = false;
  lastSent = JSON.stringify(shared(workspaces));
}

function push() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const list = shared(useStore.getState().workspaces);
    const json = JSON.stringify(list);
    if (json === lastSent) return;
    lastSent = json;
    api.put('/api/workspaces', { workspaces: list, from: clientId }).catch(() => (lastSent = ''));
  }, 250);
}

/** Runs whenever the event stream (re)connects: merge with the server's copy, then keep it in sync. */
export async function syncWorkspaces() {
  const r = await api.get<{ workspaces: Shared[] | null; deleted: string[] }>('/api/workspaces').catch(() => null);
  // Without a shared list (older server) this device just works on its own.
  if (!r) return useStore.getState().setServer({ synced: true });
  if (!subscribed) {
    subscribed = true;
    useStore.subscribe((s, prev) => {
      if (!applying && s.workspaces !== prev.workspaces) push();
    });
  }
  const server = r.workspaces || [];
  const known = new Set([...server.map((w) => w.id), ...r.deleted]);
  // Workspaces made on this device while it was offline (or before sharing existed) join the shared list;
  // ones another device closed stay closed.
  const extra = shared(useStore.getState().workspaces).filter((w) => !known.has(w.id));
  apply([...server, ...extra]);
  useStore.getState().setServer({ synced: true });
  if (extra.length || !r.workspaces) {
    lastSent = '';
    push();
  }
}

export function onRemoteWorkspaces(msg: { workspaces: Shared[]; from: string }) {
  if (msg.from !== clientId) apply(msg.workspaces);
}
