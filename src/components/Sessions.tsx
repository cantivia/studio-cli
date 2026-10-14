import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { LayoutGrid, Link2, Search, Sparkles } from 'lucide-react';
import { shareLink } from '../lib/share';
import { api, timeAgo, tildify } from '../lib/api';
import { useStore } from '../lib/store';
import type { SessionSummary } from '../lib/types';

function bucket(ms: number) {
  const d = (Date.now() - ms) / 86_400_000;
  if (d < 1) return 'Today';
  if (d < 2) return 'Yesterday';
  if (d < 7) return 'This week';
  return 'Earlier';
}

export function Sessions() {
  const visible = useStore((s) => s.mode === 'sessions');
  const home = useStore((s) => s.home);
  const addPane = useStore((s) => s.addPane);
  const hasWorkspace = useStore((s) => !!s.activeId);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const updatePane = useStore((s) => s.updatePane);
  const [list, setList] = useState<SessionSummary[]>([]);
  const [q, setQ] = useState('');
  const [shareError, setShareError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) api.get<SessionSummary[]>('/api/claude/sessions').then(setList).catch(() => {});
  }, [visible]);

  const groups = useMemo(() => {
    const t = q.toLowerCase();
    const out = new Map<string, SessionSummary[]>();
    for (const s of list) {
      if (t && !s.title.toLowerCase().includes(t) && !s.cwd.toLowerCase().includes(t)) continue;
      const b = bucket(s.updatedAt);
      out.set(b, [...(out.get(b) || []), s]);
    }
    return [...out];
  }, [list, q]);

  const resumeInWorkspace = (s: SessionSummary) => {
    addWorkspace(s.cwd, 'claude', s.project);
    // The new workspace's only pane is Claude; point it at this conversation.
    const ws = useStore.getState().workspaces.at(-1)!;
    if (ws.root.type === 'pane') updatePane(ws.root.pane.id, (p) => ({ ...p, command: `claude --resume ${s.sessionId}` }));
  };

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10">
      <div className="mx-auto max-w-4xl pt-6">
        <div className="flex items-end justify-between gap-6">
          <div>
            <div className="text-[12px] font-medium uppercase tracking-[0.1em] text-violet">History</div>
            <h1 className="mt-2 text-[34px] font-semibold tracking-[-0.025em] text-ink">Every Claude conversation</h1>
          </div>
          <div className="liquid-glass flex w-72 items-center gap-2 rounded-full px-4 py-2">
            <Search size={14} className="text-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search prompts or folders" className="flex-1 bg-transparent text-[13px] outline-none" />
          </div>
        </div>

        {shareError && <div className="mt-4 rounded-xl bg-[#e5383b]/10 px-4 py-2.5 text-[13px] font-medium text-[#b42318]">{shareError}</div>}

        {groups.map(([label, items]) => (
          <section key={label} className="mt-8">
            <div className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-faint">{label}</div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {items.map((s, i) => (
                <motion.div
                  key={s.sessionId}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: Math.min(i, 10) * 0.025, ease: [0.22, 1, 0.36, 1] }}
                  className="liquid-glass group rounded-[20px] p-4 transition-all duration-500 hover:-translate-y-1 hover:border-violet/30 hover:shadow-[0_26px_56px_-20px_rgba(109,40,217,0.28)]"
                >
                  <div className="flex items-center gap-2 text-[11px] font-medium">
                    <span className="max-w-[45%] shrink-0 truncate whitespace-nowrap rounded-md bg-ink px-1.5 py-0.5 text-white">{s.project}</span>
                    <span className="truncate text-faint">{tildify(s.cwd, home)}</span>
                    <span className="ml-auto shrink-0 text-faint">{timeAgo(s.updatedAt)}</span>
                  </div>
                  <div className="mt-2.5 line-clamp-2 min-h-[40px] text-[14px] font-medium leading-snug text-ink">{s.title}</div>
                  <div className="mt-3 flex gap-1.5">
                    <button
                      onClick={() => resumeInWorkspace(s)}
                      className="flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-violet"
                    >
                      <Sparkles size={12} /> Resume
                    </button>
                    <button
                      onClick={() => addPane('terminal', `claude --resume ${s.sessionId}`)}
                      disabled={!hasWorkspace}
                      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-muted hover:bg-white hover:text-ink disabled:opacity-40"
                      title="Open as a new pane in the workspace you have open"
                    >
                      <LayoutGrid size={12} /> Add to current workspace
                    </button>
                    <button
                      onClick={() => {
                        setShareError(null);
                        shareLink('session', s.sessionId).catch((e) => setShareError(String(e.message || e)));
                      }}
                      className="ml-auto flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-muted hover:bg-white hover:text-ink"
                      title="Copy a link to this conversation. Whoever opens it can continue it in their own Studio."
                    >
                      <Link2 size={12} /> Share link
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>
          </section>
        ))}
        {!groups.length && <div className="mt-16 text-center text-[13px] text-muted">{list.length ? 'Nothing matches.' : 'Loading conversations…'}</div>}
      </div>
    </div>
  );
}
