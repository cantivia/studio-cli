import { useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Globe, LayoutGrid, Plus, Sparkles, SquareTerminal, Wand2 } from 'lucide-react';
import { useStore } from '../lib/store';
import { findPane, panes } from '../lib/layout';
import { uid } from '../lib/api';
import type { LayoutNode, Pane, Workspace } from '../lib/types';
import { TerminalView } from './TerminalView';
import { BrowserView } from './BrowserView';
import { Mark } from './Sidebar';
import { hue } from '../lib/colors';
import { ClaudePanel } from './ClaudePanel';

export function WorkspaceView() {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.activeId));
  const visible = useStore((s) => s.mode === 'workspaces');
  if (!ws) return <EmptyState />;
  const zoomed = ws.zoomedPaneId ? findPane(ws.root, ws.zoomedPaneId) : null;
  return (
    <div className="absolute inset-0 flex flex-col px-4 pb-4">
      <Toolbar ws={ws} />
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-h-0 min-w-0 flex-1">
          {zoomed ? <PaneView ws={ws} pane={zoomed} visible={visible} /> : <Node ws={ws} node={ws.root} visible={visible} />}
        </div>
        <FocusedClaudePanel ws={ws} />
      </div>
    </div>
  );
}

/** The focused pane, if it's running Claude (or was started as Claude). */
function useFocusedClaude(ws: Workspace) {
  const key = useStore((s) => {
    const p = findPane(ws.root, ws.focusedPaneId);
    if (p?.kind !== 'terminal') return null;
    const m = p.termId ? s.meta[p.termId] : undefined;
    if (!m?.claude && !p.command?.startsWith('claude')) return null;
    return `${p.termId ?? ''}\n${m?.cwd || p.cwd}`;
  });
  if (!key) return null;
  const [termId, cwd] = key.split('\n');
  return { termId: termId || null, cwd };
}

function FocusedClaudePanel({ ws }: { ws: Workspace }) {
  const open = useStore((s) => s.claudePanel);
  const set = useStore((s) => s.set);
  const claude = useFocusedClaude(ws);
  if (!claude || !open) return null;
  return <ClaudePanel termId={claude.termId} cwd={claude.cwd} onClose={() => set({ claudePanel: false })} />;
}

function Toolbar({ ws }: { ws: Workspace }) {
  const addPane = useStore((s) => s.addPane);
  const tidy = useStore((s) => s.tidy);
  const toggleZoom = useStore((s) => s.toggleZoom);
  const all = panes(ws.root);
  const terminals = all.filter((p) => p.kind === 'terminal').length;
  const h = hue(ws.color);
  const btn =
    'flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium text-muted transition hover:bg-white hover:text-ink hover:shadow-sm';
  return (
    <div className="mb-2.5 flex h-9 shrink-0 items-center gap-1">
      <span className="mr-1 h-2.5 w-2.5 rounded-full" style={{ background: h.glow }} />
      <span className="mr-2 text-[13px] font-semibold text-ink">{ws.name}</span>
      <span className="mr-3 text-[12px] text-faint">
        {terminals} terminal{terminals === 1 ? '' : 's'}
        {all.length > terminals ? ` · ${all.length - terminals} browser` : ''}
      </span>
      <button
        onClick={() => addPane('terminal')}
        className="flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-medium text-white transition hover:brightness-110 active:scale-[0.98]"
        style={{ background: h.ui }}
        title="New terminal (⌥⌘T)"
      >
        <Plus size={13} strokeWidth={2.4} /> Terminal
      </button>
      <button onClick={() => addPane('claude')} className={btn} title="New Claude pane">
        <Sparkles size={13} /> Claude
      </button>
      <button onClick={() => addPane('browser')} className={btn} title="New browser pane">
        <Globe size={13} /> Browser
      </button>
      <div className="flex-1" />
      <ClaudePanelToggle ws={ws} btn={btn} />
      {ws.zoomedPaneId && (
        <button onClick={toggleZoom} className={btn}>
          Show all panes
        </button>
      )}
      {all.length > 1 && (
        <button onClick={tidy} className={btn} title="Arrange panes in an even grid">
          <LayoutGrid size={13} /> Tidy
        </button>
      )}
    </div>
  );
}

function Node({ ws, node, visible }: { ws: Workspace; node: LayoutNode; visible: boolean }) {
  if (node.type === 'pane') return <PaneView ws={ws} pane={node.pane} visible={visible} />;
  return <Split ws={ws} node={node} visible={visible} />;
}

function Split({ ws, node, visible }: { ws: Workspace; node: Extract<LayoutNode, { type: 'split' }>; visible: boolean }) {
  const resize = useStore((s) => s.resizeSplit);
  const ref = useRef<HTMLDivElement>(null);
  const row = node.dir === 'row';

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = ref.current!.getBoundingClientRect();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    const move = (ev: PointerEvent) => {
      const r = row ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
      resize(ws.id, node.id, Math.min(0.85, Math.max(0.15, r)));
    };
    const up = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };

  return (
    <div ref={ref} className={`flex h-full w-full ${row ? 'flex-row' : 'flex-col'}`}>
      <div style={{ flexBasis: `${node.ratio * 100}%` }} className="min-h-0 min-w-0 shrink grow-0">
        <Node ws={ws} node={node.a} visible={visible} />
      </div>
      <div className={`divider ${node.dir}`} onPointerDown={onPointerDown} />
      <div className="min-h-0 min-w-0 flex-1">
        <Node ws={ws} node={node.b} visible={visible} />
      </div>
    </div>
  );
}

function PaneView({ ws, pane, visible }: { ws: Workspace; pane: Pane; visible: boolean }) {
  const focusPane = useStore((s) => s.focusPane);
  const closePane = useStore((s) => s.closePane);
  const toggleZoom = useStore((s) => s.toggleZoom);
  const focused = ws.focusedPaneId === pane.id;
  const onFocus = () => !focused && focusPane(ws.id, pane.id);
  const split = (dir: 'row' | 'col', next?: Pane) => {
    focusPane(ws.id, pane.id);
    useStore.getState().splitFocused(dir, next);
  };
  const ports = useStore(
    useShallow((s) => [...new Set(panes(ws.root).flatMap((p) => (p.kind === 'terminal' && p.termId ? s.meta[p.termId]?.ports || [] : [])))]),
  );
  const actions = {
    split: (dir: 'row' | 'col') => split(dir),
    browser: () => split('row', { id: uid(), kind: 'browser', url: ports[0] ? `http://localhost:${ports[0]}` : '' }),
    zoom: () => {
      focusPane(ws.id, pane.id);
      toggleZoom();
    },
    close: () => closePane(ws.id, pane.id),
  };
  if (pane.kind === 'browser')
    return <BrowserView pane={pane} focused={focused} onFocus={onFocus} ports={ports} actions={actions} />;
  return <TerminalView pane={pane} focused={focused} visible={visible} onFocus={onFocus} actions={actions} accent={hue(ws.color)} />;
}

function ClaudePanelToggle({ ws, btn }: { ws: Workspace; btn: string }) {
  const open = useStore((s) => s.claudePanel);
  const set = useStore((s) => s.set);
  const claude = useFocusedClaude(ws);
  if (!claude || open) return null;
  return (
    <button onClick={() => set({ claudePanel: true })} className={btn} title="Workflows, activity, skills and history for this Claude">
      <Wand2 size={13} /> Workflows
    </button>
  );
}

function EmptyState() {
  const set = useStore((s) => s.set);
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="max-w-xl text-center">
        <div className="mx-auto mb-6 grid h-16 w-16 place-items-center rounded-[22px] surface">
          <Mark size={30} />
        </div>
        <h1 className="text-[40px] font-semibold leading-[1.08] tracking-[-0.025em] text-ink">
          Every agent, <span className="text-violet">one calm surface.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-muted">
          Workspaces full of terminals and Claude, each in its own colour. Rings and a Done tick when Claude needs you, and an agent
          view to watch them all work.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <button
            onClick={() => set({ newWorkspaceOpen: true })}
            className="flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-[14px] font-medium text-white transition hover:bg-violet active:scale-[0.98]"
          >
            <Plus size={15} /> New workspace
          </button>
        </div>
        <div className="mt-10 flex justify-center gap-6 text-[12px] text-faint">
          <span className="flex items-center gap-1.5">
            <SquareTerminal size={13} /> <kbd>⌘D</kbd> split
          </span>
          <span>
            <kbd>⌘K</kbd> commands
          </span>
          <span>
            <kbd>⌘⇧U</kbd> latest unread
          </span>
        </div>
      </div>
    </div>
  );
}
