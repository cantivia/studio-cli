import { useMemo, useState } from 'react';
import { RotateCw, Sparkles, Users } from 'lucide-react';
import { useStore } from '../lib/store';
import { panes } from '../lib/layout';
import { hue } from '../lib/colors';
import { basename } from '../lib/api';
import type { TermMeta, Workspace } from '../lib/types';

/** A workspace's office name: what the user called it, else its folder (as in the sidebar). */
export function officeName(w: Workspace, meta: Record<string, TermMeta>) {
  const first = panes(w.root).find((p) => p.kind === 'terminal');
  const cwd = first?.kind === 'terminal' ? (first.termId && meta[first.termId]?.cwd) || first.cwd : '';
  return w.customName || !cwd ? w.name : basename(cwd);
}

type Office = { key: string; name: string; color: string; count: number; busy: number; icon?: 'all' | 'claude' };

/**
 * "Everyone" (a building with one room per workspace) plus one office per workspace. Every open
 * terminal is a character (art and engine: Pixel Agents, MIT). Studio's server
 * drives them: typing while Claude edits or a command runs, reading while Claude
 * searches, a green check when a turn or long command finishes. Click a character
 * to jump to its terminal.
 */
export function PixelOffice() {
  const visible = useStore((s) => s.mode === 'office');
  const workspaces = useStore((s) => s.workspaces);
  const meta = useStore((s) => s.meta);
  const terminals = useStore((s) => s.terminals);
  const [active, setActive] = useState('all');
  const [visited, setVisited] = useState<Set<string>>(new Set(['all']));
  const [nonce, setNonce] = useState<Record<string, number>>({});

  const offices = useMemo<Office[]>(() => {
    const live = new Set(terminals.map((t) => t.id));
    const stats = (ids: string[]) => {
      const mine = ids.filter((id) => live.has(id));
      return { count: mine.length, busy: mine.filter((id) => meta[id]?.claude?.status === 'busy').length };
    };
    const ids = (list: { kind: string; termId?: string | null }[]) => list.flatMap((p) => (p.kind === 'terminal' && p.termId ? [p.termId] : []));
    const list: Office[] = [{ key: 'all', name: 'Everyone', color: '#1d1d1f', icon: 'all', ...stats(terminals.map((t) => t.id)) }];
    for (const w of workspaces) {
      list.push({ key: w.id, name: officeName(w, meta), color: hue(w.color).glow, ...stats(ids(panes(w.root))) });
    }
    return list;
  }, [workspaces, meta, terminals]);

  const select = (key: string) => {
    setActive(key);
    setVisited((v) => new Set(v).add(key));
  };

  return (
    <div className="absolute inset-0 flex flex-col px-4 pb-4">
      <div className="mb-2.5 flex h-9 shrink-0 items-center gap-1.5 overflow-x-auto">
        {offices.map((o) => {
          const on = o.key === active;
          return (
            <button
              key={o.key}
              onClick={() => select(o.key)}
              className={`flex h-8 shrink-0 items-center gap-2 rounded-full pl-2.5 pr-3 text-[12px] font-medium transition ${
                on ? 'surface text-ink' : 'text-muted hover:bg-surface/70 hover:text-ink'
              }`}
            >
              {o.icon === 'all' ? (
                <Users size={13} />
              ) : o.icon === 'claude' ? (
                <Sparkles size={13} style={{ color: o.color }} />
              ) : (
                <span className={`h-2.5 w-2.5 rounded-full ${o.busy ? 'dot-busy' : ''}`} style={{ background: o.color }} />
              )}
              {o.name}
              <span className={`rounded-full px-1.5 text-[10.5px] font-semibold ${on ? 'bg-fill text-muted' : 'text-faint'}`}>{o.count}</span>
            </button>
          );
        })}
        <div className="flex-1" />
        <span className="shrink-0 text-[11px] text-faint">Click a character to jump to its terminal</span>
        <button
          onClick={() => setNonce((n) => ({ ...n, [active]: (n[active] || 0) + 1 }))}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted hover:bg-surface/70 hover:text-ink"
          title="Reload office"
        >
          <RotateCw size={13} />
        </button>
      </div>
      <div className="pane paper relative min-h-0 flex-1" style={{ background: '#1e1e2e', ['--acc' as string]: offices.find((o) => o.key === active)?.color }}>
        {/* Only the room on screen runs: a hidden one would keep its game loop drawing 60 frames a second and slow everything else down. It reconnects instantly when you come back. */}
        {offices
          .filter((o) => visible && o.key === active && visited.has(o.key))
          .map((o) => (
            <iframe
              key={`${o.key}-${nonce[o.key] || 0}`}
              src={`/office/index.html?office=${encodeURIComponent(o.key)}`}
              title={`${o.name} agent view`}
              className="absolute inset-0 h-full w-full border-0"
            />
          ))}
        {offices.find((o) => o.key === active)?.count === 0 && (
          <div className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-4 py-1.5 text-[12px] text-white/80">
            Nobody here yet. Open a terminal in this workspace and someone walks in.
          </div>
        )}
      </div>
    </div>
  );
}
