import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, Check, Columns2, GitBranch, Globe, Link2, Maximize2, Pencil, Radio, RotateCcw, Rows2, Sparkles, SquareTerminal, X } from 'lucide-react';
import { shareLink } from '../lib/share';
import { useStore } from '../lib/store';
import { api, basename, tildify } from '../lib/api';
import { alpha, hue, type Hue } from '../lib/colors';
import { disposeTerm, fitTerm, focusTerm, hasTerm, isClosed, isGone, isScrolledUp, mountTerm, onTermScroll, scrollToBottom, sendKey, setAccent, subscribe, type KeyName } from '../lib/terms';
import type { TerminalPane } from '../lib/types';
import { useIsTouch } from '../lib/device';
import { termThemeDef } from '../lib/termThemes';

const creating = new Set<string>();

/** Spawn the pty at the pane's real size so the shell doesn't redraw (and leave a stray %) on the first fit. */
function estimateSize(el: HTMLElement | null) {
  if (!el?.clientWidth) return {};
  return { cols: Math.max(20, Math.floor((el.clientWidth - 22) / 7.8)), rows: Math.max(5, Math.floor((el.clientHeight - 12) / 16.25)) };
}

type Props = {
  pane: TerminalPane;
  focused: boolean;
  visible: boolean;
  onFocus?: () => void;
  actions?: { split?: (dir: 'row' | 'col') => void; browser?: () => void; zoom?: () => void; close?: () => void };
  headerExtra?: ReactNode;
  bare?: boolean;
  accent?: Hue;
};

export function TerminalView({ pane, focused, visible, onFocus, actions, headerExtra, bare, accent = hue('violet') }: Props) {
  // Wait for the shared workspace list too, so a device with a stale copy doesn't start terminals for closed panes.
  const ready = useStore((s) => s.ready && s.synced);
  const alive = useStore((s) => !!pane.termId && s.terminals.some((t) => t.id === pane.termId));
  const meta = useStore((s) => (pane.termId ? s.meta[pane.termId] : undefined));
  const title = useStore((s) => s.terminals.find((t) => t.id === pane.termId)?.title);
  const unread = useStore((s) => (pane.termId ? s.notifications.filter((n) => n.termId === pane.termId && !n.read).length : 0));
  // A finished Claude turn or long command the user hasn't looked at yet.
  const doneUnread = useStore(
    (s) => !!pane.termId && s.notifications.some((n) => n.termId === pane.termId && !n.read && (n.source === 'claude' || n.source === 'osc777')),
  );
  const themeId = useStore((s) => s.terminalTheme);
  const termDef = termThemeDef(themeId);
  const ink = termDef.dark;
  const touch = useIsTouch();
  const home = useStore((s) => s.home);
  const updatePane = useStore((s) => s.updatePane);
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribe(rerender), []);
  const exited = !!pane.termId && !alive && isClosed(pane.termId);
  const gone = !!pane.termId && isGone(pane.termId);

  // Spawn a pty when the pane has none, or when its pty vanished with a server restart.
  useEffect(() => {
    if (!ready || creating.has(pane.id)) return;
    if (pane.termId && gone) disposeTerm(pane.termId);
    else if (pane.termId && (alive || hasTerm(pane.termId))) return;
    creating.add(pane.id);
    // Respawning after a server restart: pick the Claude conversation back up.
    const resume = pane.termId && pane.command?.startsWith('claude') ? pane.sessionId : undefined;
    // Keep the original command; the server swaps in --resume when the conversation exists.
    const command = pane.command?.startsWith('claude --resume') && resume ? 'claude' : pane.command;
    api
      .post<{ id: string }>('/api/terminals', {
        // paneId: if another device is starting this same pane right now, the server hands back that terminal.
        paneId: pane.id,
        cwd: meta?.cwd || pane.cwd,
        command,
        resume,
        accent: accent.glow,
        theme: ink ? 'dark' : 'light',
        ...estimateSize(ref.current),
      })
      .then((t) => updatePane(pane.id, (p) => ({ ...p, termId: t.id })))
      .catch((e) => setError(String(e.message || e)))
      .finally(() => creating.delete(pane.id));
  }, [ready, pane.id, pane.termId, alive, gone, pane.cwd, pane.command, updatePane]);

  const sessionId = meta?.claude?.sessionId;
  useEffect(() => {
    if (sessionId && sessionId !== pane.sessionId) updatePane(pane.id, (p) => ({ ...p, sessionId }));
  }, [sessionId, pane.sessionId, pane.id, updatePane]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !pane.termId || !(alive || hasTerm(pane.termId))) return;
    const id = pane.termId;
    mountTerm(id, el, themeId, accent.glow);
    const ro = new ResizeObserver(() => fitTerm(id));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.termId, alive]);

  useEffect(() => {
    if (pane.termId) setAccent(pane.termId, themeId, accent.glow);
  }, [pane.termId, themeId, accent.glow]);

  useEffect(() => {
    if (focused && visible && pane.termId) {
      focusTerm(pane.termId);
      fitTerm(pane.termId);
    }
  }, [focused, visible, pane.termId]);

  // Looking at the pane is reading it: clear its ring.
  useEffect(() => {
    if (unread && focused && visible && document.hasFocus() && pane.termId) api.markRead({ termId: pane.termId });
  }, [unread, focused, visible, pane.termId]);

  const restart = () => {
    if (pane.termId) disposeTerm(pane.termId);
    updatePane(pane.id, (p) => ({ ...p, termId: null }));
  };

  const claude = meta?.claude;
  const label = pane.name || (claude ? 'Claude' : pane.command ? basename(pane.command.split(' ')[0]) : 'Terminal');
  const rename = (name: string) => {
    updatePane(pane.id, (p) => ({ ...p, name: name.trim() || undefined }));
    setRenaming(false);
  };
  const Icon = claude || pane.command?.startsWith('claude') ? Sparkles : SquareTerminal;
  const cwd = meta?.cwd || pane.cwd;
  const muted = ink ? 'text-[#8e8e93]' : 'text-[#8a8780]';
  // Pane colour drives the border, glow, ring, cursor and prompt.
  const vars = {
    '--pane-bg': termDef.colors.background,
    '--pane-line': termDef.line,
    '--acc': accent.glow,
    '--acc-ui': ink ? accent.glow : accent.ui,
    '--acc-soft': alpha(accent.glow, ink ? 0.16 : 0.12),
    '--acc-line': alpha(accent.glow, 0.5),
    '--acc-faint': alpha(accent.glow, 0.12),
    '--acc-shadow': alpha(accent.glow, 0.45),
  } as React.CSSProperties;

  return (
    <div
      style={vars}
      className={`pane ${ink ? 'ink' : 'paper'} ${focused ? 'focused' : ''} ${unread && !(focused && visible) ? 'attention' : ''} group/pane flex h-full w-full flex-col`}
      onMouseDown={onFocus}
    >
      {!bare && (
        <div className={`pane-header flex h-10 shrink-0 items-center gap-2 pl-3 pr-2 text-[12px] ${muted}`}>
          <span
            onDoubleClick={() => setRenaming(true)}
            title="Double-click to rename"
            className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-[var(--acc-soft)] py-[3px] pl-2 pr-2.5 font-semibold text-[var(--acc-ui)]"
          >
            {claude?.status === 'busy' ? <span className="h-1.5 w-1.5 rounded-full dot-busy" style={{ background: 'var(--acc)' }} /> : <Icon size={12} strokeWidth={2.2} />}
            {renaming ? (
              <input
                autoFocus
                defaultValue={pane.name || ''}
                placeholder={label}
                onFocus={(e) => e.target.select()}
                onMouseDown={(e) => e.stopPropagation()}
                onBlur={(e) => rename(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') {
                    e.currentTarget.value = pane.name || '';
                    e.currentTarget.blur();
                  }
                }}
                className="w-[130px] bg-transparent font-semibold text-[var(--acc-ui)] outline-none placeholder:text-[var(--acc-ui)] placeholder:opacity-50"
              />
            ) : (
              <span className="max-w-[180px] truncate">{label}</span>
            )}
          </span>
          {claude && <ClaudeState busy={claude.status === 'busy'} done={doneUnread} ink={ink} />}
          {!claude && doneUnread && <ClaudeState busy={false} done ink={ink} />}
          <span className={`pane-context truncate font-mono text-[11.5px] ${ink ? 'text-[#c7c7cc]' : 'text-[#3a3a3c]'}`}>{tildify(cwd, home)}</span>
          {meta?.git && (
            <span className="pane-git flex shrink-0 items-center gap-1 font-medium">
              <GitBranch size={11} />
              <span className="max-w-[140px] truncate">{meta.git.branch}</span>
              {meta.git.dirty > 0 && <span className="text-[#f59e0b]">●{meta.git.dirty}</span>}
            </span>
          )}
          {meta?.ports.slice(0, 2).map((p) => (
            <a
              key={p}
              href={`http://localhost:${p}`}
              target="_blank"
              rel="noreferrer"
              onMouseDown={(e) => e.stopPropagation()}
              className="pane-port flex shrink-0 items-center gap-1 font-medium hover:text-[var(--acc-ui)]"
            >
              <Radio size={10} />:{p}
            </a>
          ))}
          {headerExtra}
          <div className="pane-actions ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/pane:opacity-100 [@media(hover:none)]:opacity-100">
            <IconBtn ink={ink} title="Rename terminal" onClick={() => setRenaming(true)}>
              <Pencil size={12} />
            </IconBtn>
            {actions && (
              <IconBtn ink={ink} title="Share this pane as a link" onClick={() => shareLink('pane', pane.id).catch(() => {})}>
                <Link2 size={12} />
              </IconBtn>
            )}
            {actions?.split && (
              <>
                <IconBtn ink={ink} title="Split right (⌘D)" onClick={() => actions.split!('row')}>
                  <Columns2 size={13} />
                </IconBtn>
                <IconBtn ink={ink} title="Split down (⌘⇧D)" onClick={() => actions.split!('col')}>
                  <Rows2 size={13} />
                </IconBtn>
              </>
            )}
            {actions?.browser && (
              <IconBtn ink={ink} title="Open browser beside" onClick={actions.browser}>
                <Globe size={13} />
              </IconBtn>
            )}
            {actions?.zoom && (
              <IconBtn ink={ink} title="Zoom pane (⌘⏎)" onClick={actions.zoom}>
                <Maximize2 size={13} />
              </IconBtn>
            )}
            {actions?.close && (
              <IconBtn ink={ink} title="Close pane" onClick={actions.close}>
                <X size={13} />
              </IconBtn>
            )}
          </div>
        </div>
      )}
      <div ref={ref} className="relative min-h-0 flex-1" />
      {pane.termId && <JumpToLatest termId={pane.termId} ink={ink} accent={accent} />}
      {touch && focused && pane.termId && <KeyRow termId={pane.termId} ink={ink} />}
      {(exited || error) && (
        <div className="absolute inset-0 grid place-items-center bg-black/40 backdrop-blur-[2px]">
          <div className="surface rounded-2xl p-5 text-center">
            <div className="text-sm font-semibold text-ink">{error ? "Couldn't start the terminal" : 'Process exited'}</div>
            {error && <div className="mt-1 max-w-xs text-[12px] text-muted">{error}</div>}
            <div className="mt-4 flex justify-center gap-2">
              <button onClick={restart} className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-on-ink hover:bg-violet">
                <RotateCcw size={13} /> Restart
              </button>
              {actions?.close && (
                <button onClick={actions.close} className="rounded-full border border-[var(--line-strong)] px-4 py-1.5 text-[13px] font-medium text-ink hover:bg-fill">
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const KEYS: [KeyName, string][] = [
  ['esc', 'esc'],
  ['tab', 'tab'],
  ['shift-tab', '⇧tab'],
  ['up', '↑'],
  ['down', '↓'],
  ['left', '←'],
  ['right', '→'],
  ['ctrl-c', '^C'],
];

/** Touch keyboards have no Esc, Tab or arrows, and Claude needs all of them (interrupt, modes, menus). */
function KeyRow({ termId, ink }: { termId: string; ink: boolean }) {
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto px-2 pb-2 pt-1 [scrollbar-width:none]">
      {KEYS.map(([key, label]) => (
        <button
          key={key}
          // Keep focus (and the on-screen keyboard) in the terminal.
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            sendKey(termId, key);
          }}
          className={`h-8 min-w-[42px] shrink-0 rounded-lg px-2 font-mono text-[12.5px] font-semibold transition active:scale-95 ${
            ink ? 'bg-white/10 text-[#e5e5ea] active:bg-white/20' : 'bg-black/[0.05] text-ink active:bg-black/10'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Floating "Latest" button while a shell is scrolled up into its history. */
function JumpToLatest({ termId, ink, accent }: { termId: string; ink: boolean; accent: Hue }) {
  const [up, setUp] = useState(false);
  useEffect(() => {
    // This effect runs before the parent's mountTerm creates the terminal, so wait for it.
    let off = () => {};
    const check = () => setUp(isScrolledUp(termId));
    const attach = () => {
      if (!hasTerm(termId)) return false;
      off = onTermScroll(termId, check);
      check();
      return true;
    };
    if (attach()) return () => off();
    const timer = setInterval(() => attach() && clearInterval(timer), 200);
    return () => (clearInterval(timer), off());
  }, [termId]);
  if (!up) return null;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        scrollToBottom(termId);
        focusTerm(termId);
      }}
      className={`absolute bottom-4 right-5 z-10 flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-semibold shadow-lg transition active:scale-95 ${ink ? 'bg-white text-ink' : 'text-white'}`}
      style={ink ? undefined : { background: accent.ui }}
    >
      <ArrowDown size={12} strokeWidth={2.5} /> Latest
    </button>
  );
}

export function IconBtn({ ink, title, onClick, children }: { ink?: boolean; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      title={title}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className={`grid h-6 w-6 place-items-center rounded-md transition ${ink ? 'hover:bg-white/10 hover:text-white' : 'hover:bg-black/5 hover:text-ink'}`}
    >
      {children}
    </button>
  );
}

export function ClaudeState({ busy, done, ink }: { busy: boolean; done: boolean; ink?: boolean }) {
  if (busy) return <span className="shimmer-text font-medium">Working…</span>;
  if (done)
    return (
      <span className={`flex items-center gap-1 rounded-full px-2 py-[2px] text-[11px] font-semibold ${ink ? 'bg-[#22c55e]/15 text-[#4ade80]' : 'bg-[#16a34a]/10 text-success-ink'}`}>
        <Check size={11} strokeWidth={3} /> Done
      </span>
    );
  return <span className="font-medium">Ready</span>;
}
