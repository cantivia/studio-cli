import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Check, Copy, ExternalLink, LayoutGrid, Link2, Sparkles, Trash2 } from 'lucide-react';
import { api, timeAgo } from '../lib/api';
import { useStore } from '../lib/store';
import type { Share } from '../lib/types';
import { DirPicker } from './DirPicker';

/** A conversation handed over by someone's share link, waiting for you to pick where to continue it. */
type Incoming = { sessionId: string; project: string; title: string; transcript: string };

const expires = (ms: number) => {
  const d = Math.max(0, Math.round((ms - Date.now()) / 86_400_000));
  return d <= 1 ? 'expires today' : `expires in ${d} days`;
};

export function Shared() {
  const visible = useStore((s) => s.mode === 'shared');
  const addWorkspace = useStore((s) => s.addWorkspace);
  const updatePane = useStore((s) => s.updatePane);
  const home = useStore((s) => s.home);
  const [links, setLinks] = useState<Share[]>([]);
  const [remote, setRemote] = useState(true);
  const [paste, setPaste] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  // Origins of links you opened; only they may hand you a conversation.
  const opened = useRef(new Set<string>());

  const load = useCallback(
    () =>
      api
        .get<{ remote: boolean; links: Share[] }>('/api/shares')
        .then((r) => (setLinks(r.links), setRemote(r.remote)))
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    if (visible) load();
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

  const openLink = () => {
    setError(null);
    let u: URL;
    try {
      u = new URL(paste.trim());
    } catch {
      return setError('That doesn’t look like a link.');
    }
    if (!/^\/share\/[\w-]+\/?$/.test(u.pathname)) return setError('That isn’t a Studio share link (it should end in /share/…).');
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

  const patch = (s: Share, body: Partial<Share>) => api.patch<Share>(`/api/shares/${s.token}`, body).then(load).catch(() => {});
  const revoke = (s: Share) => api.del(`/api/shares/${s.token}`).then(load).catch(() => {});

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

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10">
      <div className="mx-auto max-w-4xl pt-6">
        <div className="text-[12px] font-medium uppercase tracking-[0.1em] text-violet">Shared</div>
        <h1 className="mt-2 text-[34px] font-semibold tracking-[-0.025em] text-ink">Share with a link</h1>
        <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-muted">
          Your Studio, terminals and Claude stay yours. Share a conversation or a live workspace as a link; the other person opens it from their own Studio.
        </p>
        {error && <div className="mt-4 rounded-xl bg-[#e5383b]/10 px-4 py-2.5 text-[13px] font-medium text-[#b42318]">{error}</div>}
        {!remote && (
          <div className="mt-4 rounded-xl bg-[#f59e0b]/10 px-4 py-3 text-[13px] leading-relaxed text-[#92400e]">
            <b>Links only work on this computer for now.</b> To let other people open them, run <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[12px]">npm run setup</code> in the
            Studio folder (takes a couple of minutes), which gives you your own secure address.
          </div>
        )}

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
          <p className="mt-2 pl-5 text-[12px] text-muted">A conversation can be continued in your own Claude. A live workspace opens in a tab so you can watch it.</p>
        </section>

        <section className="mt-8">
          <div className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-faint">Your links</div>
          {links.length === 0 && (
            <div className="rounded-2xl border border-dashed border-[var(--line-strong)] px-5 py-6 text-[13px] leading-relaxed text-muted">
              No links yet. Press <b className="text-ink">Share link</b> on a conversation in the Sessions tab, or the link icon on a workspace in the sidebar.
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {links.map((s, i) => (
              <motion.div
                key={s.token}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: Math.min(i, 10) * 0.025, ease: [0.22, 1, 0.36, 1] }}
                className="liquid-glass rounded-[20px] p-4"
              >
                <div className="flex items-center gap-2 text-[11px] font-medium">
                  <span className="flex shrink-0 items-center gap-1 rounded-md bg-ink px-1.5 py-0.5 text-white">
                    {s.kind === 'session' ? <Sparkles size={10} /> : <LayoutGrid size={10} />}
                    {s.kind === 'session' ? 'Session' : 'Workspace'}
                  </span>
                  <span className="ml-auto shrink-0 text-faint">{expires(s.expiresAt)}</span>
                </div>
                <div className="mt-2.5 line-clamp-2 min-h-[40px] text-[14px] font-medium leading-snug text-ink">{s.title}</div>
                <div className="mt-1 truncate font-mono text-[11px] text-faint" title={s.url}>
                  {s.url.replace(/^https?:\/\//, '')}
                </div>
                {s.kind === 'workspace' && (
                  <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-muted">
                    <input type="checkbox" checked={s.canType} onChange={(e) => patch(s, { canType: e.target.checked })} className="accent-violet" />
                    Guests can type (otherwise they only watch)
                  </label>
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
                    title="Turn this link off now"
                  >
                    <Trash2 size={12} /> Turn off
                  </button>
                </div>
                <div className="mt-2 text-[11px] text-faint">Made {timeAgo(s.createdAt)}</div>
              </motion.div>
            ))}
          </div>
        </section>
      </div>

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
