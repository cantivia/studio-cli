import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Check, Globe, LayoutGrid, Plus, Sparkles, SquareTerminal, Wand2 } from 'lucide-react';
import { useStore } from '../lib/store';
import { findPane, panes } from '../lib/layout';
import { api, uid } from '../lib/api';
import { installClaude, installCommandLineTools, installHomebrew, signInToClaude } from '../lib/setup';
import type { LayoutNode, Pane, Workspace } from '../lib/types';
import { TerminalView } from './TerminalView';
import { BrowserView } from './BrowserView';
import { Mark } from './Sidebar';
import { hue } from '../lib/colors';
import { ClaudePanel } from './ClaudePanel';
import { useIsPhone } from '../lib/device';
import { basename } from '../lib/api';

export function WorkspaceView() {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.activeId));
  const visible = useStore((s) => s.mode === 'workspaces');
  const phone = useIsPhone();
  if (!ws) return <EmptyState />;
  // A phone shows one pane at a time: the focused one (chips in the toolbar switch).
  const zoomed = phone
    ? findPane(ws.root, ws.focusedPaneId) || panes(ws.root)[0]
    : ws.zoomedPaneId
      ? findPane(ws.root, ws.zoomedPaneId)
      : null;
  return (
    <div className={`absolute inset-0 flex flex-col ${phone ? 'px-2 pb-2' : 'px-4 pb-4'}`}>
      {phone ? <PhoneToolbar ws={ws} /> : <Toolbar ws={ws} />}
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
  const phone = useIsPhone();
  if (!claude || !open || phone) return null;
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

const paneLabel = (p: Pane, claude: boolean) =>
  p.kind === 'browser'
    ? (() => {
        try {
          return new URL(p.url).host || 'Browser';
        } catch {
          return 'Browser';
        }
      })()
    : p.name || (claude ? 'Claude' : p.command ? basename(p.command.split(' ')[0]) : 'Terminal');

function PhoneToolbar({ ws }: { ws: Workspace }) {
  const addPane = useStore((s) => s.addPane);
  const focusPane = useStore((s) => s.focusPane);
  const claudeIds = useStore(useShallow((s) => Object.keys(s.meta).filter((id) => s.meta[id]?.claude)));
  const all = panes(ws.root);
  const current = findPane(ws.root, ws.focusedPaneId) ? ws.focusedPaneId : all[0]?.id;
  const h = hue(ws.color);
  const add = 'grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition active:scale-95';
  return (
    <div className="mb-2 shrink-0 space-y-2">
      <div className="flex h-8 items-center gap-1">
        <span className="mr-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: h.glow }} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{ws.name}</span>
        <button onClick={() => addPane('terminal')} className={add} title="New terminal">
          <SquareTerminal size={15} />
        </button>
        <button onClick={() => addPane('claude')} className={add} title="New Claude pane">
          <Sparkles size={15} />
        </button>
        <button onClick={() => addPane('browser')} className={add} title="New browser pane">
          <Globe size={15} />
        </button>
      </div>
      {all.length > 1 && (
        <div className="-mx-2 flex gap-1.5 overflow-x-auto px-2 [scrollbar-width:none]">
          {all.map((p) => {
            const claude = p.kind === 'terminal' && (claudeIds.includes(p.termId || '') || !!p.command?.startsWith('claude'));
            const Icon = p.kind === 'browser' ? Globe : claude ? Sparkles : SquareTerminal;
            const active = p.id === current;
            return (
              <button
                key={p.id}
                onClick={() => focusPane(ws.id, p.id)}
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition ${active ? 'text-white' : 'bg-white/70 text-muted'}`}
                style={active ? { background: h.ui } : undefined}
              >
                <Icon size={13} />
                <span className="max-w-[120px] truncate">{paneLabel(p, claude)}</span>
              </button>
            );
          })}
        </div>
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
  const phone = useIsPhone();
  const focused = ws.focusedPaneId === pane.id;
  const onFocus = () => !focused && focusPane(ws.id, pane.id);
  const split = (dir: 'row' | 'col', next?: Pane) => {
    focusPane(ws.id, pane.id);
    useStore.getState().splitFocused(dir, next);
  };
  const ports = useStore(
    useShallow((s) => [...new Set(panes(ws.root).flatMap((p) => (p.kind === 'terminal' && p.termId ? s.meta[p.termId]?.ports || [] : [])))]),
  );
  // One pane at a time on a phone: splitting and zooming don't apply.
  const actions = phone
    ? { close: () => closePane(ws.id, pane.id) }
    : {
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

type Doctor = { installed: boolean; loggedIn: boolean | null; clt?: boolean; brew?: boolean };

/** First run: a short checklist that gets Claude installed and signed in, a first workspace open, and (optionally) the phone connected. */
function EmptyState() {
  const set = useStore((s) => s.set);
  const [doc, setDoc] = useState<Doctor | null>(null);
  const [managed, setManaged] = useState(false);
  const check = useCallback(() => api.get<Doctor>('/api/doctor').then(setDoc).catch(() => {}), []);
  useEffect(() => {
    check();
    api.get<{ managed: boolean }>('/api/remote').then((r) => setManaged(r.managed)).catch(() => {});
    // Installing and signing in happen in a terminal or browser tab: keep checking so the ticks appear by themselves.
    const t = setInterval(check, 2500);
    window.addEventListener('focus', check);
    return () => (clearInterval(t), window.removeEventListener('focus', check));
  }, [check]);

  const signedIn = doc?.loggedIn === true;
  type Step = { done: boolean; title: string; hint: string; action?: { label: string; run: () => void; primary?: boolean }; optional?: boolean };
  const steps: Step[] = [
    doc && !doc.installed
      ? { done: false, title: 'Install Claude Code', hint: 'Studio runs your own Claude Code. One click installs it here, in a terminal you can watch.', action: { label: 'Install it for me', run: installClaude, primary: true } }
      : { done: !!doc?.installed, title: 'Claude Code', hint: doc ? 'Installed on this computer.' : 'Checking…' },
    doc?.installed && !signedIn
      ? { done: false, title: 'Sign in to Claude', hint: 'A browser tab opens to approve it. Then come back here.', action: { label: 'Sign in', run: signInToClaude, primary: true } }
      : { done: signedIn, title: 'Sign in to Claude', hint: signedIn ? 'Signed in. Your Claude history stays on this computer.' : doc ? 'Install Claude Code first.' : 'Checking…' },
    // Developer basics only show up when something's missing.
    ...(doc && doc.clt === false
      ? [{ done: false, title: 'Install the Command Line Tools', hint: 'Apple’s developer basics (git and friends). A macOS window opens to finish it.', action: { label: 'Install', run: installCommandLineTools } } as Step]
      : []),
    ...(doc && doc.clt && doc.brew === false
      ? [{ done: false, optional: true, title: 'Homebrew', hint: 'The usual way to install other tools. It asks for your Mac password once.', action: { label: 'Install', run: installHomebrew } } as Step]
      : []),
    { done: false, title: 'Open your first workspace', hint: 'Pick a folder, then a shell, Claude, or both side by side.', action: { label: 'New workspace', run: () => set({ newWorkspaceOpen: true }), primary: !!doc?.installed && signedIn } },
    ...(managed ? [{ done: false, optional: true, title: 'Use it from your phone', hint: 'Optional. Pair your phone or iPad with a QR code. No account needed.', action: { label: 'Set up', run: () => set({ remoteOpen: true }) } } as Step] : []),
  ];

  return (
    <div className="grid h-full place-items-center overflow-y-auto px-6 py-8">
      <div className="w-full max-w-xl">
        <div className="text-center">
          <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-[20px] surface">
            <Mark size={26} />
          </div>
          <h1 className="text-[34px] font-semibold leading-[1.1] tracking-[-0.025em] text-ink">
            Let’s get you <span className="text-violet">set up.</span>
          </h1>
          <p className="mx-auto mt-3 max-w-md text-[14.5px] leading-relaxed text-muted">A minute, and you’re ready. Studio keeps all your terminals and Claude sessions in one calm window.</p>
        </div>
        <ol className="mt-7 space-y-2.5">
          {steps.map((st, i) => (
            <li key={st.title} data-testid="setup-step" className={`liquid-glass flex items-center gap-4 rounded-[20px] px-5 py-4 transition ${st.done ? 'opacity-70' : ''}`}>
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold ${st.done ? 'bg-[#16a34a] text-white' : 'bg-ink text-white'}`}>
                {st.done ? <Check size={15} strokeWidth={3} /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-semibold text-ink">
                  {st.title}
                  {st.optional && <span className="ml-2 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">optional</span>}
                </div>
                <div className="mt-0.5 text-[12.5px] leading-snug text-muted">{st.hint}</div>
              </div>
              {st.action && !st.done && (
                <button
                  onClick={st.action.run}
                  className={`shrink-0 rounded-full px-4 py-2 text-[13px] font-medium transition active:scale-[0.98] ${st.action.primary ? 'bg-ink text-white hover:bg-violet' : 'text-muted hover:bg-white hover:text-ink'}`}
                >
                  {st.action.label}
                </button>
              )}
            </li>
          ))}
        </ol>
        <div className="mt-8 flex justify-center gap-6 text-[12px] text-faint">
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
