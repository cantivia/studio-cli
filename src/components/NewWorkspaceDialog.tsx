import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Columns2, Copy, Sparkles, SquareTerminal } from 'lucide-react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { DirPicker } from './DirPicker';
import { Swatches } from './Swatches';
import { nextHue } from '../lib/colors';

const LAYOUTS = [
  { id: 'claude+shell' as const, label: 'Claude + shell', hint: 'Side by side', icon: Columns2 },
  { id: 'claude' as const, label: 'Claude', hint: 'One pane', icon: Sparkles },
  { id: 'shell' as const, label: 'Shell', hint: 'Plain terminal', icon: SquareTerminal },
];

export function NewWorkspaceDialog() {
  const open = useStore((s) => s.newWorkspaceOpen);
  const home = useStore((s) => s.home);
  const set = useStore((s) => s.set);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const [cwd, setCwd] = useState('');
  const [layout, setLayout] = useState<(typeof LAYOUTS)[number]['id']>('claude+shell');
  const [name, setName] = useState('');
  const workspaces = useStore((s) => s.workspaces);
  const [color, setColor] = useState<string | undefined>();
  const chosen = color || nextHue(workspaces.map((w) => w.color));
  // Claude panes need Claude Code on this computer: say so up front, with the one-line install, instead of a shell error later.
  const [hasClaude, setHasClaude] = useState<boolean | null>(null);
  useEffect(() => {
    if (open) api.get<{ claude: boolean }>('/api/doctor').then((r) => setHasClaude(r.claude)).catch(() => setHasClaude(null));
  }, [open]);
  const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 grid place-items-center bg-black/15 backdrop-blur-[3px]"
          onMouseDown={() => set({ newWorkspaceOpen: false })}
        >
          <motion.div
            initial={{ y: 14, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            onMouseDown={(e) => e.stopPropagation()}
            className="surface max-h-[calc(var(--app-h,100vh)-24px)] w-[min(720px,calc(100vw-24px))] overflow-y-auto rounded-[26px] p-6"
          >
            <div className="text-[20px] font-semibold tracking-[-0.015em] text-ink">New workspace</div>
            <div className="mt-1 text-[13px] text-muted">A folder plus its terminals. You can open several workspaces on the same repo.</div>
            <div className="mt-5">
              <DirPicker value={cwd} onChange={setCwd} />
            </div>
            <div className="mt-5 grid grid-cols-[1fr_auto] items-end gap-4">
              <label className="block">
                <div className="mb-1 text-[12px] font-medium text-muted">Name (optional)</div>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. VC-tracker · frontend"
                  className="input"
                />
              </label>
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-muted">Colour</div>
                <Swatches size={20} value={chosen} onChange={setColor} />
              </div>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2">
              {LAYOUTS.map((l) => (
                <button
                  key={l.id}
                  onClick={() => setLayout(l.id)}
                  className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition ${
                    layout === l.id ? 'border-violet/50 bg-violet/[0.06]' : 'border-[var(--line)] hover:border-[var(--line-strong)]'
                  }`}
                >
                  <l.icon size={18} className={layout === l.id ? 'text-violet' : 'text-muted'} />
                  <div>
                    <div className="text-[13px] font-medium text-ink">{l.label}</div>
                    <div className="text-[11px] text-muted">{l.hint}</div>
                  </div>
                </button>
              ))}
            </div>
            {hasClaude === false && layout !== 'shell' && (
              <div className="mt-4 rounded-2xl bg-[#f59e0b]/10 px-4 py-3 text-[13px] leading-relaxed text-[#92400e]">
                <b>Claude Code isn’t installed on this computer yet.</b> Paste this in a Shell workspace to install it, then run <code className="font-mono">claude</code> once to sign in:
                <div className="mt-2 flex items-center gap-2 rounded-xl bg-white/70 px-3 py-2 font-mono text-[12px] text-ink">
                  <span className="min-w-0 flex-1 truncate">{INSTALL}</span>
                  <button onClick={() => navigator.clipboard.writeText(INSTALL).catch(() => {})} title="Copy" className="grid h-6 w-6 shrink-0 place-items-center rounded-md hover:bg-black/5">
                    <Copy size={12} />
                  </button>
                </div>
              </div>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => set({ newWorkspaceOpen: false })} className="rounded-full px-4 py-2 text-[13px] font-medium text-muted hover:bg-fill">
                Cancel
              </button>
              <button
                onClick={() => {
                  addWorkspace(cwd || home, layout, name.trim() || undefined, chosen);
                  setName('');
                  setColor(undefined);
                }}
                className="rounded-full bg-ink px-5 py-2 text-[13px] font-medium text-white transition hover:bg-violet active:scale-[0.98]"
              >
                Create workspace
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
