import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity as ActivityIcon,
  Users,
  ArrowUp,
  BookOpen,
  ChevronRight,
  FileEdit,
  FileText,
  Globe,
  History,
  Play,
  Plus,
  Search,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { useStore } from '../lib/store';
import { useRuns } from '../lib/runs';
import { api, timeAgo, uid } from '../lib/api';
import { focusTerm } from '../lib/terms';
import type { Activity, ClaudeLink, SessionSummary, SlashCommand, Share, Workflow } from '../lib/types';
import { panes } from '../lib/layout';
import { ConnectionCard } from './Shared';
import { Swatches } from './Swatches';
import { alpha, hue, nextHue } from '../lib/colors';

const ease = [0.22, 1, 0.36, 1] as const;

type Tab = 'workflows' | 'activity' | 'skills' | 'history' | 'teammate';
const TABS: { id: Tab; label: string; icon: typeof Wand2 }[] = [
  { id: 'workflows', label: 'Workflows', icon: Wand2 },
  { id: 'activity', label: 'Activity', icon: ActivityIcon },
  { id: 'skills', label: 'Skills', icon: BookOpen },
  { id: 'history', label: 'History', icon: History },
  { id: 'teammate', label: 'Teammate', icon: Users },
];

/**
 * Side panel for the focused Claude pane in a workspace: saved workflows, a live
 * feed of what Claude is doing, skills and slash commands, earlier conversations,
 * and a connection to a teammate's Claude (server/claude-links.ts).
 */
export function ClaudePanel({ termId, cwd, onClose }: { termId: string | null; cwd: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('workflows');
  const activity = useActivity(termId, tab === 'activity');
  return (
    <div className="liquid-glass flex h-full w-[330px] flex-col rounded-[20px]">
      <div className="flex items-center gap-0.5 p-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            title={t.label}
            className={`relative flex flex-1 items-center justify-center gap-1.5 rounded-xl py-1.5 text-[11.5px] font-medium transition ${
              tab === t.id ? 'text-ink' : 'text-muted hover:text-ink'
            }`}
          >
            {tab === t.id && <motion.span layoutId="claude-panel-tab" className="absolute inset-0 rounded-xl bg-white shadow-sm" transition={{ duration: 0.35, ease }} />}
            <t.icon size={12} className="relative" />
            {/* Five tabs don't fit with every label: the others show their icon (and a tooltip). */}
            {tab === t.id && <span className="relative">{t.label}</span>}
          </button>
        ))}
        <button onClick={onClose} title="Hide panel" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-faint hover:bg-white/70 hover:text-ink">
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'workflows' && <WorkflowRail termId={termId} cwd={cwd} />}
        {tab === 'activity' && <ActivityFeed activity={activity} />}
        {tab === 'skills' && <Skills termId={termId} cwd={cwd} />}
        {tab === 'history' && <SessionHistory cwd={cwd} />}
        {tab === 'teammate' && <Teammate termId={termId} />}
      </div>
    </div>
  );
}

function useActivity(termId: string | null, enabled: boolean) {
  const [activity, setActivity] = useState<Activity | null>(null);
  useEffect(() => {
    if (!termId || !enabled) return;
    let stop = false;
    const tick = () =>
      api
        .get<Activity | null>(`/api/claude/activity?termId=${termId}`)
        .then((a) => !stop && setActivity(a))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [termId, enabled]);
  return activity;
}

// ── Workflows rail ──────────────────────────────────────────────────────────

function WorkflowRail({ termId, cwd }: { termId: string | null; cwd: string }) {
  const run = useRuns((s) => (termId ? s.runs[termId] : undefined));
  const runs = useRuns();
  const onRun = (w: Workflow, input: string) => {
    if (!termId) return;
    runs.start(termId, w, input);
    focusTerm(termId);
  };
  const onNext = () => termId && runs.next(termId);
  const onStop = () => termId && runs.stop(termId);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [custom, setCustom] = useState<{ name: string; command: string }[]>([]);

  useEffect(() => {
    api
      .get<Workflow[]>('/api/workflows')
      .then((list) => {
        const used: (string | undefined)[] = list.map((w) => w.color);
        setWorkflows(list.map((w) => (w.color ? w : { ...w, color: (used.push(nextHue(used)), used.at(-1)) })));
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    api
      .get<{ name: string; command: string }[]>(`/api/custom-commands?cwd=${encodeURIComponent(cwd)}`)
      .then(setCustom)
      .catch(() => {});
  }, [cwd]);

  const save = (list: Workflow[]) => {
    setWorkflows(list);
    api.put('/api/workflows', list).catch(() => {});
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <div className="text-[12px] text-muted">One click sends a saved prompt to this Claude.</div>
        <button
          onClick={() => setEditing({ id: uid(), name: '', description: '', steps: [''], color: nextHue(workflows.map((w) => w.color)) })}
          className="grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-black/5 hover:text-ink"
          title="New workflow"
        >
          <Plus size={14} />
        </button>
      </div>

      {run && (
        <div className="mx-3 mb-2 rounded-2xl p-3 text-white" style={{ background: `linear-gradient(135deg, #111 0%, #111 55%, ${hue(run.workflow.color).ui} 160%)` }}>
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-semibold">{run.workflow.name}</span>
            <span className="text-white/60">
              Step {run.index + 1}/{run.steps.length}
            </span>
          </div>
          <div className="mt-2 flex gap-1">
            {run.steps.map((_, i) => (
              <div
                key={i}
                className="h-1 flex-1 rounded-full transition-colors"
                style={{ background: i <= run.index ? hue(run.workflow.color).glow : 'rgba(255,255,255,0.15)', opacity: i < run.index ? 0.6 : 1 }}
              />
            ))}
          </div>
          <div className="mt-2.5 flex gap-1.5">
            {run.index + 1 < run.steps.length && (
              <button onClick={onNext} className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium hover:bg-white/20">
                <ChevronRight size={12} /> Send next now
              </button>
            )}
            <button onClick={onStop} className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium hover:bg-white/20">
              <Square size={10} /> Stop
            </button>
          </div>
          {run.auto && run.index + 1 < run.steps.length && (
            <div className="mt-2 text-[11px] text-white/50">Next step sends when Claude finishes.</div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
        {workflows.map((w) => {
          const open = openId === w.id;
          const h = hue(w.color);
          return (
            <div
              key={w.id}
              className={`relative overflow-hidden rounded-2xl transition ${open ? 'surface' : 'hover:bg-white/70'}`}
              style={open ? { boxShadow: `0 0 0 1.5px ${alpha(h.glow, 0.45)}, 0 12px 30px -18px ${alpha(h.glow, 0.5)}` } : undefined}
            >
              <span className="absolute bottom-2.5 left-0 top-2.5 w-[3px] rounded-r-full" style={{ background: h.glow }} />
              <button onClick={() => setOpenId(open ? null : w.id)} className="w-full px-3.5 py-2.5 text-left">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[13px] font-medium text-ink">{w.name}</span>
                  {w.steps.length > 1 && (
                    <span className="rounded-full px-1.5 text-[10.5px] font-semibold" style={{ background: alpha(h.glow, 0.12), color: h.ui }}>
                      {w.steps.length} steps
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[12px] leading-snug text-muted">{w.description}</div>
              </button>
              {open && (
                <div className="px-3.5 pb-3">
                  {w.needsInput && (
                    <textarea
                      autoFocus
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder={w.needsInput}
                      rows={3}
                      className="mb-2 w-full resize-none rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-[12px] text-ink outline-none focus:border-violet/50"
                    />
                  )}
                  <div className="flex items-center gap-1.5">
                    <button
                      disabled={!termId || (!!w.needsInput && !input.trim())}
                      onClick={() => {
                        onRun(w, input.trim());
                        setInput('');
                        setOpenId(null);
                      }}
                      className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium text-white transition hover:brightness-110 disabled:opacity-40"
                      style={{ background: h.ui }}
                    >
                      <Play size={11} /> Run
                    </button>
                    <button onClick={() => setEditing(w)} className="rounded-full px-3 py-1.5 text-[12px] font-medium text-muted hover:bg-fill hover:text-ink">
                      Edit
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {custom.length > 0 && (
          <>
            <div className="px-1 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">Project commands · cmux.json</div>
            {custom.map((c) => (
              <button
                key={c.name}
                onClick={() => useStore.getState().addPane('terminal', c.command)}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[12px] hover:bg-white/70"
              >
                <SquareTerminal size={13} className="text-faint" />
                <span className="font-medium text-ink">{c.name}</span>
                <span className="truncate font-mono text-[11px] text-faint">{c.command}</span>
              </button>
            ))}
          </>
        )}
      </div>

      <Composer termId={termId} />

      <AnimatePresence>
        {editing && (
          <WorkflowEditor
            initial={editing}
            onCancel={() => setEditing(null)}
            onDelete={() => {
              save(workflows.filter((w) => w.id !== editing.id));
              setEditing(null);
            }}
            onSave={(w) => {
              const exists = workflows.some((x) => x.id === w.id);
              save(exists ? workflows.map((x) => (x.id === w.id ? w : x)) : [...workflows, w]);
              setEditing(null);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function Composer({ termId }: { termId: string | null }) {
  const [text, setText] = useState('');
  const send = () => {
    if (!termId || !text.trim()) return;
    api.send(termId, text.trim());
    setText('');
    focusTerm(termId);
  };
  return (
    <div className="border-t border-black/[0.06] p-3">
      <div className="rounded-2xl border border-[var(--line)] bg-white p-2 focus-within:border-violet/50">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.stopPropagation();
              send();
            }
          }}
          rows={3}
          placeholder="Draft a longer prompt…  ⌘↵ to send"
          className="w-full resize-none bg-transparent px-1 text-[12px] leading-relaxed text-ink outline-none placeholder:text-faint"
        />
        <div className="flex justify-end">
          <button
            onClick={send}
            disabled={!text.trim()}
            className="grid h-7 w-7 place-items-center rounded-full bg-ink text-white transition hover:bg-violet disabled:opacity-30"
          >
            <ArrowUp size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkflowEditor({
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: Workflow;
  onSave: (w: Workflow) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [w, setW] = useState<Workflow>(initial);
  const valid = w.name.trim() && w.steps.some((s) => s.trim());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  // Portalled: the glass rail's backdrop-filter would otherwise trap this fixed overlay inside it.
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 grid place-items-center bg-black/20 backdrop-blur-[3px]"
      onMouseDown={onCancel}
    >
      <motion.div
        initial={{ y: 12, scale: 0.98 }}
        animate={{ y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease }}
        onMouseDown={(e) => e.stopPropagation()}
        className="surface max-h-[85vh] w-[560px] overflow-y-auto rounded-[24px] p-6"
      >
        <div className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Workflow</div>
        <div className="mt-1 text-[13px] text-muted">
          Each step is a prompt. Steps send one after another as Claude finishes. Use <code className="text-violet">{'{input}'}</code> for
          something you type at launch.
        </div>
        <div className="mt-5 space-y-3">
          <Field label="Name">
            <input value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} className="input" />
          </Field>
          <Field label="Description">
            <input value={w.description} onChange={(e) => setW({ ...w, description: e.target.value })} className="input" />
          </Field>
          <Field label="Colour">
            <Swatches value={w.color} onChange={(color) => setW({ ...w, color })} />
          </Field>
          <Field label="Ask at launch (optional)">
            <input
              value={w.needsInput || ''}
              placeholder="e.g. What should Claude build?"
              onChange={(e) => setW({ ...w, needsInput: e.target.value || undefined })}
              className="input"
            />
          </Field>
          {w.steps.map((s, i) => (
            <Field key={i} label={`Step ${i + 1}`}>
              <div className="flex gap-2">
                <textarea
                  rows={3}
                  value={s}
                  onChange={(e) => setW({ ...w, steps: w.steps.map((x, j) => (j === i ? e.target.value : x)) })}
                  className="input flex-1 resize-y"
                />
                {w.steps.length > 1 && (
                  <button
                    onClick={() => setW({ ...w, steps: w.steps.filter((_, j) => j !== i) })}
                    className="grid h-8 w-8 place-items-center rounded-lg text-faint hover:bg-fill hover:text-danger"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </Field>
          ))}
          <button onClick={() => setW({ ...w, steps: [...w.steps, ''] })} className="text-[13px] font-medium text-violet">
            + Add step
          </button>
        </div>
        <div className="mt-6 flex items-center gap-2">
          <button onClick={onDelete} className="flex items-center gap-1.5 rounded-full px-3 py-2 text-[13px] font-medium text-muted hover:text-danger">
            <Trash2 size={13} /> Delete
          </button>
          <div className="flex-1" />
          <button onClick={onCancel} className="rounded-full px-4 py-2 text-[13px] font-medium text-muted hover:bg-fill">
            Cancel
          </button>
          <button
            disabled={!valid}
            onClick={() => onSave({ ...w, steps: w.steps.filter((s) => s.trim()) })}
            className="rounded-full bg-ink px-5 py-2 text-[13px] font-medium text-white hover:bg-violet disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[12px] font-medium text-muted">{label}</div>
      {children}
    </label>
  );
}

// ── Activity, skills, history ──────────────────────────────────────────────

const TOOL_ICON: Record<string, typeof FileText> = {
  Read: FileText,
  Edit: FileEdit,
  Write: FileEdit,
  MultiEdit: FileEdit,
  Bash: SquareTerminal,
  Grep: Search,
  Glob: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  Skill: BookOpen,
  Agent: Sparkles,
  Task: Sparkles,
};

function ActivityFeed({ activity }: { activity: Activity | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const count = activity?.events.length || 0;
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [count]);
  if (!activity || !count)
    return (
      <div className="px-6 pt-10 text-center text-[12px] text-muted">
        <ActivityIcon size={20} className="mx-auto mb-3 text-faint" />
        Claude's prompts, replies and tool calls appear here live as it works.
      </div>
    );
  return (
    <div ref={ref} className="h-full space-y-2 overflow-y-auto px-3 pb-4">
      {activity.events.map((e) => {
        if (e.kind === 'user')
          return (
            <div key={e.id} className="ml-6 rounded-2xl rounded-tr-md bg-ink px-3 py-2 text-[12px] leading-relaxed text-white">
              <div className="line-clamp-5 whitespace-pre-wrap">{e.text}</div>
            </div>
          );
        if (e.kind === 'assistant')
          return (
            <div key={e.id} className="rounded-2xl rounded-tl-md bg-white px-3 py-2 text-[12px] leading-relaxed text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
              <div className="line-clamp-6 whitespace-pre-wrap">{e.text}</div>
            </div>
          );
        const Icon = TOOL_ICON[e.tool || ''] || Sparkles;
        return (
          <div key={e.id} className="flex items-start gap-2 px-1 text-[11px]">
            <Icon size={12} className="mt-0.5 shrink-0 text-violet" />
            <span className="font-semibold text-ink">{e.tool}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-muted" title={e.text}>
              {e.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Skills({ termId, cwd }: { termId: string | null; cwd: string }) {
  const [list, setList] = useState<SlashCommand[]>([]);
  const [q, setQ] = useState('');
  useEffect(() => {
    api.get<SlashCommand[]>(`/api/claude/commands?cwd=${encodeURIComponent(cwd)}`).then(setList).catch(() => {});
  }, [cwd]);
  const shown = useMemo(() => {
    const t = q.toLowerCase();
    return list.filter((c) => !t || c.name.toLowerCase().includes(t) || c.description.toLowerCase().includes(t));
  }, [list, q]);
  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-1.5">
          <Search size={13} className="text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search skills & commands" className="flex-1 bg-transparent text-[12px] outline-none" />
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {shown.map((c) => (
          <button
            key={c.name}
            onClick={() => {
              if (!termId) return;
              api.send(termId, `/${c.name} `, false);
              focusTerm(termId);
            }}
            className="w-full rounded-xl px-3 py-2 text-left hover:bg-white/80"
            title="Insert into Claude's prompt"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] font-medium text-ink">/{c.name}</span>
              <span className="rounded bg-black/[0.05] px-1 text-[10px] text-faint">{c.scope === 'project' ? 'project' : c.kind}</span>
            </div>
            {c.description && <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted">{c.description}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

function SessionHistory({ cwd }: { cwd: string }) {
  const [list, setList] = useState<SessionSummary[]>([]);
  const addPane = useStore((s) => s.addPane);
  useEffect(() => {
    api.get<SessionSummary[]>('/api/claude/sessions').then((l) => setList(l.filter((s) => s.cwd === cwd))).catch(() => {});
  }, [cwd]);
  if (!list.length) return <div className="px-6 pt-10 text-center text-[12px] text-muted">No earlier conversations in this folder.</div>;
  return (
    <div className="h-full space-y-1 overflow-y-auto px-3 pb-3">
      {list.map((s) => (
        <button
          key={s.sessionId}
          onClick={() => addPane('terminal', `claude --resume ${s.sessionId}`)}
          title="Reopen this conversation in a new pane"
          className="w-full rounded-xl px-3 py-2 text-left hover:bg-white/80"
        >
          <div className="line-clamp-2 text-[12px] font-medium leading-snug text-ink">{s.title}</div>
          <div className="mt-0.5 text-[11px] text-faint">
            {timeAgo(s.updatedAt)} · {s.sizeKb} KB
          </div>
        </button>
      ))}
    </div>
  );
}

/** Connect this Claude with a teammate's (each on its own computer); they talk with studio tell / studio peek. */
function Teammate({ termId }: { termId: string | null }) {
  const paneId = useStore((s) => {
    for (const w of s.workspaces) for (const p of panes(w.root)) if (p.kind === 'terminal' && p.termId && p.termId === termId) return p.id;
    return null;
  });
  const set = useStore((s) => s.set);
  const [links, setLinks] = useState<ClaudeLink[] | null>(null);
  const [shares, setShares] = useState<{ remote: boolean; links: Share[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    api.get<ClaudeLink[]>('/api/claude-links').then(setLinks).catch(() => {});
    api.get<{ remote: boolean; links: Share[] }>('/api/shares').then(setShares).catch(() => {});
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);
  const mine = links?.find((l) => l.paneId === paneId);
  const url = mine && shares?.links.find((s) => s.token === mine.id)?.url;
  const copy = (u: string) => {
    navigator.clipboard.writeText(u).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  const invite = async () => {
    setError(null);
    try {
      const s = await api.post<Share>('/api/claude-links/invite', { paneId });
      copy(s.url);
      load();
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };
  if (!paneId) return <div className="p-4 text-[12px] text-muted">Open Claude in a pane to connect it with a teammate’s Claude.</div>;
  if (!links) return null;
  return (
    <div className="h-full overflow-y-auto p-3">
      {mine && (mine.partner || mine.side === 'guest') ? (
        <>
          <ConnectionCard link={mine} onChange={load} showLog />
          <p className="mt-3 px-1 text-[11.5px] leading-relaxed text-faint">
            Your Claude sends with <code className="font-mono">studio tell "…"</code> and looks with <code className="font-mono">studio peek</code>. After 20 messages with nobody typing, the connection pauses itself.
          </p>
        </>
      ) : (
        <div className="px-1 pt-1">
          <div className="text-[13px] font-medium text-ink">Work with a teammate’s Claude</div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
            Make a link and send it to a teammate. They open it in their own Studio (Shared → Open a link) and pick one of their Claudes. The two can then message each other and see each other’s work. Each stays on its own
            computer.
          </p>
          {shares && !shares.remote && (
            <div className="mt-3 rounded-xl bg-[#f59e0b]/10 px-3 py-2 text-[12px] leading-relaxed text-[#92400e]">
              Links only work on this computer until you{' '}
              <button onClick={() => set({ remoteOpen: true })} className="font-semibold underline underline-offset-2">
                turn on phone &amp; remote access
              </button>
              .
            </div>
          )}
          {mine && url ? (
            <div className="mt-3 rounded-xl border border-[var(--line)] bg-white/60 p-3">
              <div className="text-[12px] text-muted">Waiting for your teammate to open this link:</div>
              <div className="mt-1 truncate font-mono text-[11px] text-faint" title={url}>
                {url.replace(/^https?:\/\//, '')}
              </div>
              <div className="mt-2 flex gap-1.5">
                <button onClick={() => copy(url)} className="rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-violet">
                  {copied ? 'Copied' : 'Copy link'}
                </button>
                <button onClick={() => api.del(`/api/claude-links/${mine.id}`).then(load)} className="rounded-full px-3 py-1.5 text-[12px] font-medium text-muted hover:bg-white hover:text-ink">
                  Turn off
                </button>
              </div>
            </div>
          ) : (
            <button onClick={invite} className="mt-3 rounded-full bg-ink px-4 py-2 text-[12px] font-medium text-white transition hover:bg-violet">
              {copied ? 'Link copied' : 'Connect a teammate’s Claude'}
            </button>
          )}
          {error && <div className="mt-3 text-[12px] font-medium text-[#b42318]">{error}</div>}
        </div>
      )}
    </div>
  );
}
