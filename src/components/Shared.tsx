import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Bot, Check, Copy, ExternalLink, LayoutGrid, Link2, Pause, Play, Smartphone, Sparkles, SquareTerminal, Trash2, Unplug } from 'lucide-react';
import { api, timeAgo } from '../lib/api';
import { panes } from '../lib/layout';
import { useStore } from '../lib/store';
import type { ClaudeLink, Share, TerminalPane } from '../lib/types';
import { DirPicker } from './DirPicker';

/** A conversation handed over by someone's share link, waiting for you to pick where to continue it. */
type Incoming = { sessionId: string; project: string; title: string; transcript: string };
/** A teammate's Claude connection link, waiting for you to pick which of your Claudes joins. */
type Joining = { url: string; name: string; pane: string };
type Device = { id: string; name: string; createdAt: number; lastSeen: number };

const LASTS: { id: string; label: string }[] = [
  { id: '1h', label: '1 hour' },
  { id: '1d', label: '1 day' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'never', label: 'No end date' },
];
const expires = (ms: number | null) => {
  if (ms === null) return 'no end date';
  const left = ms - Date.now();
  if (left < 3_600_000) return `expires in ${Math.max(1, Math.round(left / 60_000))} min`;
  if (left < 86_400_000) return `expires in ${Math.round(left / 3_600_000)} h`;
  return `expires in ${Math.round(left / 86_400_000)} days`;
};
const KIND = {
  session: { label: 'Session', icon: Sparkles },
  workspace: { label: 'Workspace', icon: LayoutGrid },
  pane: { label: 'Pane', icon: SquareTerminal },
  claude: { label: 'Claude connection', icon: Bot },
} as const;

/** Your Claude panes, for picking which one joins a teammate's Claude. */
function useClaudePanes() {
  const workspaces = useStore((s) => s.workspaces);
  const meta = useStore((s) => s.meta);
  return useMemo(
    () =>
      workspaces.flatMap((w) =>
        panes(w.root)
          .filter((p): p is TerminalPane => p.kind === 'terminal' && !!p.termId && !!meta[p.termId]?.claude)
          .map((p) => ({ paneId: p.id, label: `${p.name || 'Claude'} · ${w.name}` })),
      ),
    [workspaces, meta],
  );
}

export function Shared() {
  const visible = useStore((s) => s.mode === 'shared');
  const addWorkspace = useStore((s) => s.addWorkspace);
  const updatePane = useStore((s) => s.updatePane);
  const home = useStore((s) => s.home);
  const [links, setLinks] = useState<Share[]>([]);
  const [claudeLinks, setClaudeLinks] = useState<ClaudeLink[]>([]);
  const [remote, setRemote] = useState(true);
  const [managed, setManaged] = useState(false);
  const set = useStore((s) => s.set);
  const [paste, setPaste] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [joining, setJoining] = useState<Joining | null>(null);
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  // Origins of links you opened; only they may hand you a conversation.
  const opened = useRef(new Set<string>());

  const load = useCallback(() => {
    api
      .get<{ remote: boolean; managed: boolean; links: Share[] }>('/api/shares')
      .then((r) => (setLinks(r.links), setRemote(r.remote), setManaged(r.managed)))
      .catch(() => {});
    api.get<ClaudeLink[]>('/api/claude-links').then(setClaudeLinks).catch(() => {});
  }, []);
  // Watchers and connections change on their own, so keep the page fresh while it's open.
  useEffect(() => {
    if (!visible) return;
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [visible, load]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!opened.current.has(e.origin) || e.data?.type !== 'studio-session') return;
      const { sessionId, project, title, transcript } = e.data;
      if (typeof sessionId !== 'string' || typeof transcript !== 'string') return;
      setCwd('');
      setIncoming({ sessionId, project: String(project || 'shared'), title: String(title || 'Shared conversation'), transcript });
      useStore.getState().set({ mode: 'shared' });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const openLink = async () => {
    setError(null);
    let u: URL;
    try {
      u = new URL(paste.trim());
    } catch {
      return setError('That doesn’t look like a link.');
    }
    if (!/^\/share\/[\w-]+\/?$/.test(u.pathname)) return setError('That isn’t a Studio share link (it should end in /share/…).');
    // A Claude connection link joins here instead of opening a page. Your server asks theirs what the link is.
    const info = await api.get<{ kind: string; name?: string; pane?: string }>(`/api/claude-links/inspect?url=${encodeURIComponent(u.toString())}`).catch(() => null);
    if (info?.kind === 'claude') {
      setJoining({ url: u.toString(), name: info.name || 'Your teammate', pane: info.pane || 'Claude' });
      setPaste('');
      return;
    }
    opened.current.add(u.origin);
    // The page keeps a line back to this window (no "noopener") so it can hand a conversation over.
    u.searchParams.set('from', location.origin);
    window.open(u.toString(), '_blank');
    setPaste('');
  };

  const copy = (s: Share) => {
    navigator.clipboard.writeText(s.url).catch(() => {});
    setCopied(s.token);
    setTimeout(() => setCopied(null), 1600);
  };

  const patch = (s: Share, body: Record<string, unknown>) => api.patch<Share>(`/api/shares/${s.token}`, body).then(load).catch(() => {});
  const revoke = (s: Share) => (s.kind === 'claude' ? api.del(`/api/claude-links/${s.token}`) : api.del(`/api/shares/${s.token}`)).then(load).catch(() => {});
  const kick = (s: Share, visitor: string) => api.post(`/api/shares/${s.token}/kick`, { visitor }).then(load).catch(() => {});

  const continueSession = async () => {
    if (!incoming) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ cwd: string; added: boolean }>('/api/session-import', {
        sessionId: incoming.sessionId,
        cwd: cwd || home,
        transcript: incoming.transcript,
      });
      addWorkspace(r.cwd, 'claude', incoming.project);
      const ws = useStore.getState().workspaces.at(-1)!;
      if (ws.root.type === 'pane') updatePane(ws.root.pane.id, (p) => ({ ...p, command: `claude --resume ${incoming.sessionId}` }));
      setIncoming(null);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  const joined = claudeLinks.filter((l) => l.partner || l.side === 'guest');

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10">
      <div className="mx-auto max-w-4xl pt-6">
        <div className="text-[12px] font-medium uppercase tracking-[0.1em] text-violet">Shared</div>
        <h1 className="mt-2 text-[34px] font-semibold tracking-[-0.025em] text-ink">Share with a link</h1>
        <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-muted">
          Your Studio, terminals and Claude stay yours. Share a conversation, a live workspace or one pane as a link, or connect your Claude with a teammate’s; the other person opens it from their own Studio.
        </p>
        {error && <div className="mt-4 rounded-xl bg-[#e5383b]/10 px-4 py-2.5 text-[13px] font-medium text-[#b42318]">{error}</div>}
        {!remote && (
          <div className="mt-4 rounded-xl bg-[#f59e0b]/10 px-4 py-3 text-[13px] leading-relaxed text-[#92400e]">
            <b>Links only work on this computer for now.</b>{' '}
            {managed ? (
              <>
                To let other people open them,{' '}
                <button onClick={() => set({ remoteOpen: true })} className="font-semibold underline underline-offset-2">
                  turn on phone &amp; remote access
                </button>
                . It takes one click.
              </>
            ) : (
              <>
                To let other people open them, run <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[12px]">npm run setup</code> in the Studio folder (takes a couple of minutes), which gives you your own secure
                address.
              </>
            )}
          </div>
        )}

        <Devices />

        <section className="mt-8">
          <div className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-faint">Open a link someone sent you</div>
          <div className="liquid-glass flex items-center gap-2 rounded-full py-1.5 pl-5 pr-1.5">
            <Link2 size={14} className="shrink-0 text-faint" />
            <input
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && openLink()}
              placeholder="https://…/share/…"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
            />
            <button
              onClick={openLink}
              disabled={!paste.trim()}
              className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[12px] font-medium text-white transition hover:bg-violet disabled:opacity-40"
            >
              <ExternalLink size={12} /> Open
            </button>
          </div>
          <p className="mt-2 pl-5 text-[12px] text-muted">
            A conversation can be continued in your own Claude. A live workspace opens in a tab so you can watch it. A Claude connection links one of your Claudes with theirs.
          </p>
        </section>

        {joined.length > 0 && (
          <section className="mt-8">
            <div className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-faint">Connected Claudes</div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {joined.map((l) => (
                <ConnectionCard key={l.id} link={l} onChange={load} />
              ))}
            </div>
          </section>
        )}

        <section className="mt-8">
          <div className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-faint">Your links</div>
          {links.length === 0 && (
            <div className="rounded-2xl border border-dashed border-[var(--line-strong)] px-5 py-6 text-[13px] leading-relaxed text-muted">
              No links yet. Press <b className="text-ink">Share link</b> on a conversation in the Sessions tab, the link icon on a workspace in the sidebar or on a pane’s header, or <b className="text-ink">Connect</b> in a
              Claude panel’s Teammate tab.
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {links.map((s, i) => {
              const K = KIND[s.kind];
              const conn = s.kind === 'claude' ? claudeLinks.find((l) => l.id === s.token) : undefined;
              const live = s.kind === 'workspace' || s.kind === 'pane';
              return (
                <motion.div
                  key={s.token}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: Math.min(i, 10) * 0.025, ease: [0.22, 1, 0.36, 1] }}
                  className="liquid-glass rounded-[20px] p-4"
                >
                  <div className="flex items-center gap-2 text-[11px] font-medium">
                    <span className="flex shrink-0 items-center gap-1 rounded-md bg-ink px-1.5 py-0.5 text-white">
                      <K.icon size={10} />
                      {K.label}
                    </span>
                    {!!s.watching?.length && (
                      <span className="flex items-center gap-1 text-[#15803d]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[#22c55e]" /> {s.watching.length} watching now
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-faint">{expires(s.expiresAt)}</span>
                  </div>
                  <div className="mt-2.5 line-clamp-2 min-h-[40px] text-[14px] font-medium leading-snug text-ink">{s.title}</div>
                  <div className="mt-1 truncate font-mono text-[11px] text-faint" title={s.url}>
                    {s.url.replace(/^https?:\/\//, '')}
                  </div>
                  {s.kind === 'claude' && (
                    <div className="mt-2 text-[12px] text-muted">
                      {conn?.partner ? `Connected to ${conn.partner.name}’s Claude${conn.online ? '' : ' (offline)'}` : 'Waiting for your teammate to open it in their Studio.'}
                    </div>
                  )}
                  <label className="mt-3 flex items-center gap-2 text-[12px] text-muted">
                    Lasts
                    <select
                      value=""
                      onChange={(e) => e.target.value && patch(s, { lasts: e.target.value })}
                      className="rounded-full border border-[var(--line)] bg-white/70 px-2 py-0.5 text-[12px] text-ink outline-none"
                    >
                      <option value="">{s.expiresAt === null ? 'No end date' : 'Change…'}</option>
                      {LASTS.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.id === 'never' ? l.label : `${l.label} from now`}
                        </option>
                      ))}
                    </select>
                  </label>
                  {live && (
                    <>
                      <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-muted">
                        <input type="checkbox" checked={s.canType} onChange={(e) => patch(s, { canType: e.target.checked })} className="accent-violet" />
                        Guests can type (otherwise they only watch)
                      </label>
                      <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-[12px] text-muted">
                        <input type="checkbox" checked={!!s.canMessage} onChange={(e) => patch(s, { canMessage: e.target.checked })} className="accent-violet" />
                        Guests can message your Claude (it acts on what they say)
                      </label>
                    </>
                  )}
                  {!!s.watching?.length && (
                    <div className="mt-3 space-y-1">
                      {s.watching.map((w) => (
                        <div key={w.visitor} className="flex items-center gap-2 text-[12px] text-muted">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#22c55e]" />
                          <span className="min-w-0 flex-1 truncate">
                            {w.device}
                            {w.country ? ` · ${w.country}` : ''}
                          </span>
                          <button onClick={() => kick(s, w.visitor)} className="rounded-full px-2 py-0.5 text-[11px] font-medium text-[#b42318] hover:bg-[#e5383b]/10">
                            Kick
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {!!s.opens?.length && (
                    <details className="mt-2 text-[12px] text-muted">
                      <summary className="cursor-pointer select-none">
                        Opened {s.opens.length === 30 ? '30+' : s.opens.length} time{s.opens.length === 1 ? '' : 's'} · last {timeAgo(s.opens[0].at)}
                      </summary>
                      <div className="mt-1 space-y-0.5 pl-3">
                        {s.opens.slice(0, 10).map((o) => (
                          <div key={o.visitor + o.at}>
                            {timeAgo(o.at)} · {o.device}
                            {o.country ? ` · ${o.country}` : ''}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  <div className="mt-3 flex gap-1.5">
                    <button
                      onClick={() => copy(s)}
                      className="flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-violet"
                    >
                      {copied === s.token ? <Check size={12} /> : <Copy size={12} />} {copied === s.token ? 'Copied' : 'Copy link'}
                    </button>
                    <button
                      onClick={() => revoke(s)}
                      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-muted hover:bg-white hover:text-ink"
                      title="Turn this link off now (anyone watching is dropped)"
                    >
                      <Trash2 size={12} /> Turn off
                    </button>
                  </div>
                  <div className="mt-2 text-[11px] text-faint">Made {timeAgo(s.createdAt)}</div>
                </motion.div>
              );
            })}
          </div>
        </section>
      </div>

      {joining && <JoinDialog joining={joining} onClose={() => setJoining(null)} onJoined={load} />}

      {incoming &&
        createPortal(
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/15 backdrop-blur-[3px]" onMouseDown={() => !busy && setIncoming(null)}>
            <div onMouseDown={(e) => e.stopPropagation()} className="surface max-h-[calc(100vh-24px)] w-[min(720px,calc(100vw-24px))] overflow-y-auto rounded-[26px] p-6">
              <div className="text-[20px] font-semibold tracking-[-0.015em] text-ink">Continue this conversation</div>
              <div className="mt-1 line-clamp-2 text-[13px] text-muted">{incoming.title}</div>
              <div className="mt-1 text-[12px] text-faint">It’s copied into your own Claude history, so what you do next stays on your computer.</div>
              <div className="mt-5">
                <div className="mb-1.5 text-[12px] font-medium text-muted">Where should Claude work?</div>
                <DirPicker value={cwd} onChange={setCwd} />
              </div>
              {error && <div className="mt-4 rounded-xl bg-[#e5383b]/10 px-4 py-2.5 text-[13px] font-medium text-[#b42318]">{error}</div>}
              <div className="mt-6 flex justify-end gap-2">
                <button onClick={() => setIncoming(null)} className="rounded-full px-4 py-2 text-[13px] font-medium text-muted hover:bg-fill">
                  Cancel
                </button>
                <button
                  onClick={continueSession}
                  disabled={busy}
                  className="rounded-full bg-ink px-5 py-2 text-[13px] font-medium text-white transition hover:bg-violet disabled:opacity-50"
                >
                  {busy ? 'Opening…' : 'Open in Claude'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Your paired phones and iPads, and the way to add one (Phone & remote access, opened straight on the QR code). */
function Devices() {
  const remoteOpen = useStore((s) => s.remoteOpen);
  const set = useStore((s) => s.set);
  const [mode, setMode] = useState<string | null | undefined>(undefined);
  const [devices, setDevices] = useState<Device[]>([]);
  const load = useCallback(() => {
    api
      .get<{ mode: string | null }>('/api/remote')
      .then((r) => {
        setMode(r.mode);
        if (r.mode === 'pairing') api.get<Device[]>('/api/remote/devices').then(setDevices).catch(() => {});
      })
      .catch(() => setMode(null));
  }, []);
  // Refresh after the pairing dialog closes: a phone may have just been added.
  useEffect(() => {
    if (!remoteOpen) load();
  }, [remoteOpen, load]);
  if (mode === undefined || mode === 'access') return null;
  const remove = (id: string) => api.del(`/api/remote/devices/${id}`).then(load).catch(() => {});
  return (
    <section className="mt-8">
      <div className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-faint">Your phone &amp; iPad</div>
      <div className="liquid-glass rounded-[20px] p-4">
        {mode !== 'pairing' ? (
          <p className="text-[13px] text-muted">Phone access is off. Turn it on to use Studio from your phone or iPad.</p>
        ) : devices.length === 0 ? (
          <p className="text-[13px] text-muted">No phone or iPad paired yet.</p>
        ) : (
          <div className="space-y-1.5">
            {devices.map((d) => (
              <div key={d.id} className="flex items-center gap-2.5 text-[13px]">
                <Smartphone size={14} className="shrink-0 text-faint" />
                <span className="font-medium text-ink">{d.name}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-faint">used {timeAgo(d.lastSeen)}</span>
                <button onClick={() => remove(d.id)} className="rounded-full px-2.5 py-1 text-[12px] font-medium text-muted hover:bg-white hover:text-ink">
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={() => set({ remoteOpen: true, remotePair: true })}
          className="mt-3 flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[12px] font-medium text-white transition hover:bg-violet"
        >
          <Smartphone size={12} /> {mode === 'pairing' ? 'Add a phone or iPad' : 'Turn on and add a phone or iPad'}
        </button>
      </div>
    </section>
  );
}

/** A live connection between one of your Claudes and a teammate's: pause, disconnect, and what they said. */
export function ConnectionCard({ link, onChange, showLog = false }: { link: ClaudeLink; onChange: () => void; showLog?: boolean }) {
  const pause = () => api.post(`/api/claude-links/${link.id}`, { paused: !link.paused }).then(onChange).catch(() => {});
  const drop = () => api.del(`/api/claude-links/${link.id}`).then(onChange).catch(() => {});
  const status = !link.partner ? 'Connecting…' : !link.online ? 'Offline' : link.paused ? (link.pausedBy === 'auto' ? 'Paused after many messages' : `Paused by ${link.pausedBy}`) : 'Connected';
  return (
    <div className="liquid-glass rounded-[20px] p-4">
      <div className="flex items-center gap-2 text-[11px] font-medium">
        <span className="flex shrink-0 items-center gap-1 rounded-md bg-ink px-1.5 py-0.5 text-white">
          <Bot size={10} /> Claude connection
        </span>
        <span className={`flex items-center gap-1 ${link.online && !link.paused ? 'text-[#15803d]' : 'text-faint'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${link.online && !link.paused ? 'bg-[#22c55e]' : 'bg-[var(--line-strong)]'}`} /> {status}
        </span>
      </div>
      <div className="mt-2.5 text-[14px] font-medium leading-snug text-ink">{link.partner ? `${link.partner.name}’s Claude` : 'Your teammate’s Claude'}</div>
      {link.partner && <div className="mt-0.5 truncate text-[12px] text-muted">{link.partner.pane}</div>}
      <div className="mt-3 flex gap-1.5">
        <button onClick={pause} className="flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-violet">
          {link.paused ? <Play size={12} /> : <Pause size={12} />} {link.paused ? 'Resume' : 'Pause'}
        </button>
        <button onClick={drop} className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-muted hover:bg-white hover:text-ink">
          <Unplug size={12} /> Disconnect
        </button>
      </div>
      {showLog && link.log.length > 0 && (
        <div className="mt-3 max-h-[320px] space-y-1.5 overflow-y-auto border-t border-[var(--line)] pt-3">
          {link.log.map((e, i) => (
            <div
              key={i}
              className={`whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-[12px] leading-relaxed ${
                e.dir === 'note' ? 'text-center text-faint' : e.dir === 'out' ? 'ml-6 bg-[var(--fill)] text-ink' : 'mr-6 bg-[#f7f5ff] text-ink'
              }`}
            >
              {e.dir !== 'note' && <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-faint">{e.dir === 'out' ? 'Your Claude' : link.partner ? `${link.partner.name}’s Claude` : 'Their Claude'}</div>}
              {e.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JoinDialog({ joining, onClose, onJoined }: { joining: Joining; onClose: () => void; onJoined: () => void }) {
  const claudes = useClaudePanes();
  const [paneId, setPaneId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = paneId || claudes[0]?.paneId || '';
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/claude-links/join', { url: joining.url, paneId: chosen });
      onJoined();
      onClose();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/15 backdrop-blur-[3px]" onMouseDown={() => !busy && onClose()}>
      <div onMouseDown={(e) => e.stopPropagation()} className="surface w-[min(560px,calc(100vw-24px))] rounded-[26px] p-6">
        <div className="text-[20px] font-semibold tracking-[-0.015em] text-ink">Connect with {joining.name}’s Claude</div>
        <div className="mt-1 text-[13px] text-muted">{joining.pane}</div>
        <p className="mt-3 text-[13px] leading-relaxed text-muted">
          The two Claudes can send each other messages (they arrive straight away) and see what the other has been doing. Each stays on its own computer, and still asks you before anything risky. You can pause or disconnect any
          time.
        </p>
        <div className="mt-5">
          <div className="mb-1.5 text-[12px] font-medium text-muted">Which of your Claudes?</div>
          {claudes.length === 0 ? (
            <div className="rounded-xl bg-[#f59e0b]/10 px-4 py-3 text-[13px] text-[#92400e]">Start Claude in one of your panes first, then open the link again.</div>
          ) : (
            <select value={chosen} onChange={(e) => setPaneId(e.target.value)} className="w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-[13px] text-ink outline-none">
              {claudes.map((c) => (
                <option key={c.paneId} value={c.paneId}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
        </div>
        {error && <div className="mt-4 rounded-xl bg-[#e5383b]/10 px-4 py-2.5 text-[13px] font-medium text-[#b42318]">{error}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-full px-4 py-2 text-[13px] font-medium text-muted hover:bg-fill">
            Cancel
          </button>
          <button onClick={connect} disabled={busy || !chosen} className="rounded-full bg-ink px-5 py-2 text-[13px] font-medium text-white transition hover:bg-violet disabled:opacity-50">
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
