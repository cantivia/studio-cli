import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Bell, Check, GitBranch, Pencil, Plus, Settings2, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { panes } from '../lib/layout';
import { basename } from '../lib/api';
import type { TerminalPane, Workspace } from '../lib/types';
import { SettingsMenu } from './SettingsMenu';
import { Swatches } from './Swatches';
import { hue } from '../lib/colors';

export function Sidebar() {
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeId);
  const mode = useStore((s) => s.mode);
  const unread = useStore((s) => s.notifications.filter((n) => !n.read).length);
  const set = useStore((s) => s.set);
  const move = useStore((s) => s.moveWorkspace);
  const [settings, setSettings] = useState(false);
  // Drag to reorder: `slot` is the gap the dragged workspace would land in (0 = above the first).
  const [drag, setDrag] = useState<{ id: string; slot: number | null } | null>(null);
  const drop = () => {
    if (drag && drag.slot !== null) {
      const from = workspaces.findIndex((w) => w.id === drag.id);
      move(drag.id, drag.slot > from ? drag.slot - 1 : drag.slot);
    }
    setDrag(null);
  };

  return (
    <aside className="liquid-glass flex h-full w-full flex-col border-r border-white/70">
      <div className="drag titlebar-pad-top flex items-center justify-between px-5 pb-3">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[20px] font-bold tracking-[-0.03em] text-ink">studio</span>
          <Mark />
        </div>
        <button
          onClick={() => set({ newWorkspaceOpen: true, navOpen: false })}
          className="grid h-8 w-8 place-items-center rounded-full bg-ink text-white transition hover:bg-violet active:scale-95"
          title="New workspace (⌘⌥N)"
        >
          <Plus size={16} strokeWidth={2.2} />
        </button>
      </div>

      <div className="px-5 pb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">Workspaces</div>
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
        {workspaces.map((ws, i) => (
          <WorkspaceItem
            key={ws.id}
            ws={ws}
            index={i}
            active={mode === 'workspaces' && ws.id === activeId}
            dragging={drag?.id === ws.id}
            dropLine={drag && drag.id !== ws.id ? (drag.slot === i ? 'top' : drag.slot === i + 1 ? 'bottom' : null) : null}
            onDragStart={() => setDrag({ id: ws.id, slot: null })}
            onDragOver={(below) => drag && setDrag({ ...drag, slot: below ? i + 1 : i })}
            onDrop={drop}
            onDragEnd={() => setDrag(null)}
          />
        ))}
        {!workspaces.length && (
          <button
            onClick={() => set({ newWorkspaceOpen: true })}
            className="w-full rounded-2xl border border-dashed border-[var(--line-strong)] px-4 py-6 text-left text-sm text-muted transition hover:border-violet hover:text-ink"
          >
            <div className="font-medium text-ink">Open your first workspace</div>
            <div className="mt-1 text-[13px]">Pick a folder. Start a shell, Claude, or both side by side.</div>
          </button>
        )}
      </nav>

      <div className="relative flex items-center gap-1 border-t border-black/[0.06] px-3 py-3">
        <button
          onClick={() => set({ notificationsOpen: true })}
          className="flex flex-1 items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium text-muted transition hover:bg-black/[0.04] hover:text-ink"
        >
          <Bell size={16} />
          Notifications
          {unread > 0 && (
            <span className="ml-auto rounded-full bg-violet px-1.5 text-[11px] font-semibold leading-[18px] text-white">{unread}</span>
          )}
        </button>
        <button
          onClick={() => setSettings((v) => !v)}
          className="grid h-9 w-9 place-items-center rounded-xl text-muted transition hover:bg-black/[0.04] hover:text-ink"
          title="Settings"
        >
          <Settings2 size={16} />
        </button>
        {settings && <SettingsMenu onClose={() => setSettings(false)} />}
      </div>
    </aside>
  );
}

export function Mark({ size = 30 }: { size?: number }) {
  // "cli" as plain bold mono text; after the "studio" wordmark it reads "studio cli".
  return (
    <span className="font-mono font-extrabold text-ink" style={{ fontSize: size * 0.6, letterSpacing: '0.02em' }} aria-hidden>
      cli
    </span>
  );
}

type DragProps = {
  dragging: boolean;
  dropLine: 'top' | 'bottom' | null;
  onDragStart: () => void;
  onDragOver: (below: boolean) => void;
  onDrop: () => void;
  onDragEnd: () => void;
};

function WorkspaceItem({ ws, index, active, ...dnd }: { ws: Workspace; index: number; active: boolean } & DragProps) {
  const meta = useStore((s) => s.meta);
  const notifications = useStore((s) => s.notifications);
  const select = useStore((s) => s.selectWorkspace);
  const close = useStore((s) => s.closeWorkspace);
  const [editing, setEditing] = useState(false);
  const color = hue(ws.color, index);

  const info = useMemo(() => {
    const termIds = panes(ws.root).flatMap((p) => (p.kind === 'terminal' && p.termId ? [p.termId] : []));
    const metas = termIds.map((id) => meta[id]).filter(Boolean);
    const mine = notifications.filter((n) => termIds.includes(n.termId));
    return {
      cwd: metas[0]?.cwd || (panes(ws.root).find((p) => p.kind === 'terminal') as TerminalPane | undefined)?.cwd || '',
      branch: metas.find((m) => m.git)?.git?.branch || null,
      busy: metas.some((m) => m.claude?.status === 'busy'),
      unread: mine.filter((n) => !n.read).length,
      done: mine.some((n) => !n.read && (n.source === 'claude' || n.source === 'osc777')),
    };
  }, [ws.root, meta, notifications]);

  const folder = basename(info.cwd);
  const name = ws.customName || !info.cwd ? ws.name : folder;
  // Several workspaces can share a repo; when the name isn't the folder, say which folder it is.
  const sub = [name !== folder ? folder : null, info.branch].filter(Boolean).join(' · ');

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => select(ws.id)}
      onKeyDown={(e) => e.key === 'Enter' && !editing && select(ws.id)}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', ws.id);
        dnd.onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        dnd.onDragOver(e.clientY > r.top + r.height / 2);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dnd.onDrop();
      }}
      onDragEnd={dnd.onDragEnd}
      style={info.unread && !active ? { boxShadow: `0 0 0 1.5px ${color.glow}66` } : undefined}
      className={`group relative w-full rounded-2xl px-3.5 py-2.5 text-left transition-all duration-300 ${active ? 'surface' : 'hover:bg-white/60'} ${dnd.dragging ? 'opacity-40' : ''}`}
    >
      {dnd.dropLine && (
        <div
          className={`pointer-events-none absolute left-2 right-2 h-[2px] rounded-full bg-violet ${dnd.dropLine === 'top' ? '-top-[3px]' : '-bottom-[3px]'}`}
        />
      )}
      {active && (
        <motion.div
          layoutId="ws-active"
          className="absolute bottom-2.5 left-0 top-2.5 w-[3px] rounded-r-md"
          style={{ background: color.glow }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        />
      )}
      <div className="flex items-center gap-2">
        <button
          title="Edit name and colour"
          onClick={(e) => {
            e.stopPropagation();
            setEditing((v) => !v);
          }}
          className={`h-2.5 w-2.5 shrink-0 rounded-full transition-transform hover:scale-125 ${info.busy ? 'dot-busy' : ''}`}
          style={{ background: color.glow }}
        />
        <span onDoubleClick={() => setEditing(true)} className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.005em] text-ink">
          {name}
        </span>
        {info.busy ? (
          <span className="shimmer-text text-[11px] font-semibold">Working</span>
        ) : info.done ? (
          <span className="flex items-center gap-0.5 rounded-full bg-[#16a34a]/10 px-1.5 text-[11px] font-semibold leading-[18px] text-[#15803d]">
            <Check size={10} strokeWidth={3} /> Done
          </span>
        ) : null}
        {info.unread > 0 && !info.done && (
          <span className="rounded-full px-1.5 text-[11px] font-semibold leading-[18px] text-white" style={{ background: color.glow }}>
            {info.unread}
          </span>
        )}
        <span className="hidden items-center group-hover:flex">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setEditing((v) => !v);
            }}
            className="grid h-5 w-5 place-items-center rounded-md text-faint hover:bg-black/5 hover:text-ink"
            title="Edit name and colour"
          >
            <Pencil size={11} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              close(ws.id);
            }}
            className="grid h-5 w-5 place-items-center rounded-md text-faint hover:bg-black/5 hover:text-ink"
            title="Close workspace"
          >
            <X size={13} />
          </button>
        </span>
      </div>
      {sub && !editing && (
        <div className="mt-0.5 flex items-center gap-1 pl-[18px] text-[11.5px] text-faint">
          {info.branch && <GitBranch size={10} className="shrink-0" />}
          <span className="truncate">{sub}</span>
        </div>
      )}
      {editing && <WorkspaceEditor ws={ws} name={name} onDone={() => setEditing(false)} />}
    </div>
  );
}

function WorkspaceEditor({ ws, name, onDone }: { ws: Workspace; name: string; onDone: () => void }) {
  const rename = useStore((s) => s.renameWorkspace);
  const recolor = useStore((s) => s.recolorWorkspace);
  const [draft, setDraft] = useState(name);
  const save = () => {
    if (draft.trim() && draft.trim() !== name) rename(ws.id, draft.trim());
    onDone();
  };
  return (
    <div className="mt-2.5 space-y-2.5 rounded-xl bg-fill/70 p-2.5" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') onDone();
          e.stopPropagation();
        }}
        className="w-full rounded-lg border border-[var(--line)] bg-white px-2.5 py-1.5 text-[13px] font-medium text-ink outline-none focus:border-violet/50"
        placeholder="Workspace name"
      />
      <Swatches size={18} value={ws.color} onChange={(id) => recolor(ws.id, id)} />
      <div className="flex justify-end">
        <button onClick={save} className="rounded-full bg-ink px-3 py-1 text-[12px] font-medium text-white hover:bg-violet">
          Done
        </button>
      </div>
    </div>
  );
}
