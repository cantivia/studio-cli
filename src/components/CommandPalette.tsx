import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, Columns2, Gamepad2, Globe, History, LayoutGrid, Maximize2, Moon, Plus, Rows2, Search, Sparkles, SquareTerminal } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, uid } from '../lib/api';
import { findPane, terminalPane } from '../lib/layout';

type Item = { id: string; label: string; hint?: string; group: string; icon: typeof Plus; keys?: string; run: () => void };

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const s = useStore();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [custom, setCustom] = useState<{ name: string; command: string }[]>([]);

  const ws = s.workspaces.find((w) => w.id === s.activeId);
  const focused = ws ? findPane(ws.root, ws.focusedPaneId) : undefined;
  const cwd = focused?.kind === 'terminal' ? (focused.termId && s.meta[focused.termId]?.cwd) || focused.cwd : s.home;

  useEffect(() => {
    if (!open) return;
    setQ('');
    setSel(0);
    if (cwd)
      api
        .get<{ name: string; command: string }[]>(`/api/custom-commands?cwd=${encodeURIComponent(cwd)}`)
        .then(setCustom)
        .catch(() => setCustom([]));
  }, [open, cwd]);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [
      { id: 'new-ws', group: 'Create', label: 'New workspace', icon: Plus, keys: '⌘⌥N', run: () => s.set({ newWorkspaceOpen: true }) },
      { id: 'add-term', group: 'Panes', label: 'New terminal', icon: SquareTerminal, keys: '⌥⌘T', run: () => s.addPane('terminal') },
      { id: 'add-claude', group: 'Panes', label: 'New Claude pane', icon: Sparkles, run: () => s.addPane('claude') },
      { id: 'tidy', group: 'Panes', label: 'Tidy panes into a grid', icon: LayoutGrid, run: () => s.tidy() },
      { id: 'split-r', group: 'Panes', label: 'Split right', icon: Columns2, keys: '⌘D', run: () => s.splitFocused('row') },
      { id: 'split-d', group: 'Panes', label: 'Split down', icon: Rows2, keys: '⌘⇧D', run: () => s.splitFocused('col') },
      {
        id: 'split-claude',
        group: 'Panes',
        label: 'Split right with Claude',
        icon: Sparkles,
        run: () => s.splitFocused('row', terminalPane(cwd || s.home, 'claude')),
      },
      { id: 'browser', group: 'Panes', label: 'Open browser pane', icon: Globe, run: () => s.splitFocused('row', { id: uid(), kind: 'browser', url: '' }) },
      { id: 'zoom', group: 'Panes', label: 'Zoom focused pane', icon: Maximize2, keys: '⌘⏎', run: () => s.toggleZoom() },
      { id: 'm-ws', group: 'Go to', label: 'Workspaces', icon: LayoutGrid, run: () => s.setMode('workspaces') },
      { id: 'm-office', group: 'Go to', label: 'Agent View', icon: Gamepad2, run: () => s.setMode('office') },
      { id: 'm-sessions', group: 'Go to', label: 'Sessions history', icon: History, run: () => s.setMode('sessions') },
      { id: 'notifs', group: 'Go to', label: 'Notifications', icon: Bell, keys: '⌘⇧I', run: () => s.set({ notificationsOpen: true }) },
      { id: 'read-all', group: 'Settings', label: 'Mark all notifications read', icon: Bell, run: () => api.markRead({ all: true }) },
      {
        id: 'theme',
        group: 'Settings',
        label: s.inkTerminals ? 'Use paper (light) terminals' : 'Use ink (dark) terminals',
        icon: Moon,
        run: () => s.set({ inkTerminals: !s.inkTerminals }),
      },
      ...s.workspaces.map((w, i) => ({
        id: `ws-${w.id}`,
        group: 'Workspaces',
        label: w.name,
        icon: LayoutGrid,
        keys: i < 9 ? `⌃${i + 1}` : undefined,
        run: () => s.selectWorkspace(w.id),
      })),
      ...custom.map((c) => ({
        id: `cmd-${c.name}`,
        group: 'Project commands',
        label: c.name,
        hint: c.command,
        icon: SquareTerminal,
        run: () => s.splitFocused('row', terminalPane(cwd || s.home, c.command)),
      })),
    ];
    const t = q.toLowerCase().trim();
    return t ? list.filter((i) => `${i.group} ${i.label} ${i.hint || ''}`.toLowerCase().includes(t)) : list;
  }, [s, q, cwd, custom]);

  const run = (i: Item | undefined) => {
    if (!i) return;
    s.set({ paletteOpen: false });
    i.run();
  };

  let lastGroup = '';
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 flex justify-center bg-black/15 pt-[14vh] backdrop-blur-[2px]"
          onMouseDown={() => s.set({ paletteOpen: false })}
        >
          <motion.div
            initial={{ y: -8, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            onMouseDown={(e) => e.stopPropagation()}
            className="surface h-fit max-h-[60vh] w-[min(600px,calc(100vw-24px))] overflow-hidden rounded-[22px]"
          >
            <div className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-3.5">
              <Search size={16} className="text-faint" />
              <input
                autoFocus
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setSel(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') setSel((v) => Math.min(items.length - 1, v + 1));
                  else if (e.key === 'ArrowUp') setSel((v) => Math.max(0, v - 1));
                  else if (e.key === 'Enter') run(items[sel]);
                  else return;
                  e.preventDefault();
                }}
                placeholder="Type a command or workspace…"
                className="flex-1 bg-transparent text-[15px] text-ink outline-none focus-visible:outline-none placeholder:text-faint"
              />
              <kbd>esc</kbd>
            </div>
            <div className="max-h-[calc(60vh-56px)] overflow-y-auto p-2">
              {items.map((i, idx) => {
                const header = i.group !== lastGroup ? (lastGroup = i.group) : null;
                return (
                  <div key={i.id}>
                    {header && <div className="px-3 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">{header}</div>}
                    <button
                      onMouseEnter={() => setSel(idx)}
                      onClick={() => run(i)}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left ${idx === sel ? 'bg-fill' : ''}`}
                    >
                      <i.icon size={15} className={idx === sel ? 'text-violet' : 'text-muted'} />
                      <span className="text-[13px] font-medium text-ink">{i.label}</span>
                      {i.hint && <span className="truncate font-mono text-[11px] text-faint">{i.hint}</span>}
                      {i.keys && <kbd className="ml-auto">{i.keys}</kbd>}
                    </button>
                  </div>
                );
              })}
              {!items.length && <div className="px-3 py-6 text-center text-[13px] text-muted">No matches</div>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
