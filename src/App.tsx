import { useEffect, useRef } from 'react';
import { useStore, allTerminalPanes } from './lib/store';
import { api } from './lib/api';
import type { Notification } from './lib/types';
import { setTheme } from './lib/terms';
import { hue, nextHue } from './lib/colors';
import { panes } from './lib/layout';
import type { Pane } from './lib/types';
import { Sidebar } from './components/Sidebar';
import { TopNav } from './components/TopNav';
import { WorkspaceView } from './components/WorkspaceView';
import { officeName, PixelOffice } from './components/PixelOffice';
import { Sessions } from './components/Sessions';
import { NotificationPanel } from './components/NotificationPanel';
import { CommandPalette } from './components/CommandPalette';
import { NewWorkspaceDialog } from './components/NewWorkspaceDialog';
import { InkField } from './components/InkField';
import { useWorkflowAutoAdvance } from './lib/runs';
import { StudioIntro } from './components/intro/StudioIntro';
import { useIsPhone } from './lib/device';

function useEventStream() {
  const setServer = useStore((s) => s.setServer);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/events`);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'focus') return jumpToTerminal(msg.termId);
        if (msg.type !== 'state') return;
        const notifications: Notification[] = msg.notifications;
        if (seen.current) {
          const fresh = notifications.filter((n) => !n.read && !seen.current!.has(n.id));
          for (const n of fresh) desktopNotify(n);
        }
        seen.current = new Set(notifications.map((n) => n.id));
        setServer({ ready: true, home: msg.home, terminals: msg.terminals, meta: msg.meta, notifications });
      };
      ws.onclose = () => {
        setServer({ ready: false });
        retry = setTimeout(open, 1200);
      };
    };
    open();
    return () => {
      clearTimeout(retry);
      ws.onclose = null;
      ws.close();
    };
  }, [setServer]);
}

function desktopNotify(n: Notification) {
  const s = useStore.getState();
  if (!s.desktopNotifications || !document.hidden || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  const note = new Notification(n.title, { body: n.body, tag: n.id });
  note.onclick = () => {
    window.focus();
    jumpToTerminal(n.termId);
  };
}

/** Switches to whichever workspace or Claude tab owns the terminal and focuses it. */
export function jumpToTerminal(termId: string) {
  const s = useStore.getState();
  const hit = allTerminalPanes(s).find((x) => x.pane.kind === 'terminal' && x.pane.termId === termId);
  if (!hit) return;
  if (hit.wsId) {
    s.set({ activeId: hit.wsId, mode: 'workspaces' });
    s.focusPane(hit.wsId, hit.pane.id);
  }
  api.markRead({ termId });
}

/** Tells the server which terminals belong to which workspace's office (and room in "Everyone"). */
function useOfficeSync() {
  const ready = useStore((s) => s.ready);
  // meta changes every poll but only the names drawn from it matter: select a string so App re-renders only on a real change.
  const defs = useStore((s) =>
    JSON.stringify(
      s.workspaces.map((w) => ({
        key: w.id,
        name: officeName(w, s.meta),
        color: hue(w.color).glow,
        termIds: panes(w.root).flatMap((p: Pane) => (p.kind === 'terminal' && p.termId ? [p.termId] : [])),
      })),
    ),
  );
  useEffect(() => {
    if (ready) api.put('/api/offices', JSON.parse(defs)).catch(() => {});
  }, [defs, ready]);
}

function jumpToLatestUnread() {
  const s = useStore.getState();
  const n = s.notifications.find((x) => !x.read && x.termId);
  if (n) jumpToTerminal(n.termId);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const key = e.key.toLowerCase();
      let handled = true;
      if (e.metaKey && key === 'k') s.set({ paletteOpen: !s.paletteOpen });
      else if (e.metaKey && e.shiftKey && key === 'u') jumpToLatestUnread();
      else if (e.metaKey && e.shiftKey && key === 'i') s.set({ notificationsOpen: !s.notificationsOpen });
      else if (e.metaKey && !e.shiftKey && key === 'd') s.splitFocused('row');
      else if (e.metaKey && e.shiftKey && key === 'd') s.splitFocused('col');
      else if (e.metaKey && e.altKey && key === 'n') s.set({ newWorkspaceOpen: true });
      else if (e.metaKey && e.altKey && (key === 't' || e.code === 'KeyT')) s.addPane('terminal');
      else if (e.metaKey && key === 'enter') s.toggleZoom();
      else if (e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
        const ws = s.workspaces[+e.key - 1];
        if (ws) s.selectWorkspace(ws.id);
      } else if (e.key === 'Escape' && (s.paletteOpen || s.notificationsOpen || s.newWorkspaceOpen))
        s.set({ paletteOpen: false, notificationsOpen: false, newWorkspaceOpen: false });
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Capture phase so shortcuts win over the focused xterm textarea.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

export default function App() {
  useEventStream();
  useShortcuts();
  const mode = useStore((s) => s.mode);
  const ready = useStore((s) => s.ready);
  const ink = useStore((s) => s.inkTerminals);
  const phone = useIsPhone();
  const navOpen = useStore((s) => s.navOpen);
  const set = useStore((s) => s.set);

  useEffect(() => setTheme(ink), [ink]);
  useOfficeSync();
  useWorkflowAutoAdvance();

  // Workspaces and Claude tabs saved before colour coding get a colour each.
  useEffect(() => {
    const s = useStore.getState();
    const used: (string | undefined)[] = [];
    const paint = <T extends { color?: string }>(list: T[]) =>
      list.map((x) => {
        const color = x.color || nextHue(used);
        used.push(color);
        return x.color ? x : { ...x, color };
      });
    if (s.workspaces.some((w) => !w.color)) s.set({ workspaces: paint(s.workspaces) });
  }, []);

  return (
    <div className="safe-area relative flex h-full w-full">
      <InkField />
      {phone ? (
        <>
          <div
            onClick={() => set({ navOpen: false })}
            className={`fixed inset-0 z-40 bg-black/20 transition-opacity duration-300 ${navOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
          />
          <div
            className={`safe-area fixed inset-y-0 left-0 z-50 w-[86vw] max-w-[320px] bg-[var(--canvas)] shadow-2xl transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${navOpen ? 'translate-x-0' : '-translate-x-full'}`}
          >
            <Sidebar />
          </div>
        </>
      ) : (
        <div className="relative z-10 h-full w-[272px] shrink-0 overflow-hidden">
          <Sidebar />
        </div>
      )}
      <main className="relative z-10 flex min-w-0 flex-1 flex-col">
        <TopNav />
        {!ready && (
          <div className="absolute left-1/2 top-16 z-30 -translate-x-1/2 rounded-full bg-ink px-4 py-1.5 text-xs font-medium text-white shadow-lg">
            Connecting to the Studio server…
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {/* Views stay mounted so terminals and iframes keep their state across tabs. */}
          <View show={mode === 'workspaces'}>
            <WorkspaceView />
          </View>
          <View show={mode === 'office'}>
            <PixelOffice />
          </View>
          <View show={mode === 'sessions'}>
            <Sessions />
          </View>
        </div>
      </main>
      <NotificationPanel />
      <CommandPalette />
      <NewWorkspaceDialog />
      <StudioIntro />
    </div>
  );
}

function View({ show, children }: { show: boolean; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0" style={{ visibility: show ? 'visible' : 'hidden', zIndex: show ? 1 : 0 }} aria-hidden={!show}>
      {children}
    </div>
  );
}
