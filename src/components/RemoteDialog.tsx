import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ExternalLink, Smartphone } from 'lucide-react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';

type Remote = { managed: boolean; running: boolean; hasBinary: boolean; hasToken: boolean; configured: boolean; host: string | null; allow: string[] };

/** Settings → Phone & remote access: paste the invite someone sent you and your computer gets its own secure address. */
export function RemoteDialog() {
  const open = useStore((s) => s.remoteOpen);
  const set = useStore((s) => s.set);
  const [info, setInfo] = useState<Remote | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.get<Remote>('/api/remote').then(setInfo).catch(() => {}), []);
  useEffect(() => {
    if (open) {
      setError(null);
      load();
    }
  }, [open, load]);
  // The tunnel takes a few seconds to come up after connecting.
  useEffect(() => {
    if (!open || !info?.configured || info.running) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [open, info, load]);

  if (!open) return null;
  const close = () => set({ remoteOpen: false });

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await api.post<Remote>('/api/remote/join', { code }));
      setCode('');
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      setInfo(await api.del<Remote>('/api/remote'));
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/15 backdrop-blur-[3px]" onMouseDown={close}>
      <div onMouseDown={(e) => e.stopPropagation()} className="surface w-[min(560px,calc(100vw-24px))] rounded-[26px] p-6">
        <div className="flex items-center gap-2.5 text-[20px] font-semibold tracking-[-0.015em] text-ink">
          <Smartphone size={20} className="text-violet" /> Phone &amp; remote access
        </div>

        {info && !info.managed && (
          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            This Studio runs from the code folder, so its remote address is set up there: run <code className="rounded bg-fill px-1.5 py-0.5 font-mono text-[12px]">npm run setup</code>.
            {info.configured && (
              <>
                {' '}
                It’s currently set up at <b className="text-ink">{info.host}</b>.
              </>
            )}
          </p>
        )}

        {info?.managed && info.configured && (
          <div className="mt-4">
            <p className="text-[13px] leading-relaxed text-muted">Open this address on your phone or iPad and sign in with your email. It reaches this computer, and only you can open it.</p>
            <a
              href={`https://${info.host}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 flex items-center justify-between gap-2 rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[14px] font-semibold text-ink hover:border-violet/40"
            >
              <span className="truncate">{info.host}</span>
              <ExternalLink size={14} className="shrink-0 text-faint" />
            </a>
            <div className="mt-3 flex items-center gap-2 text-[12px] text-muted">
              {info.running ? (
                <>
                  <Check size={13} className="text-[#16a34a]" /> Connected. Your computer has to stay on and awake.
                </>
              ) : !info.hasBinary ? (
                'The connection program (cloudflared) wasn’t found. Reinstall the app.'
              ) : (
                <>
                  <span className="h-2 w-2 animate-pulse rounded-full bg-[#f59e0b]" /> Connecting…
                </>
              )}
            </div>
            <div className="mt-5 flex justify-between">
              <button onClick={disconnect} disabled={busy} className="rounded-full px-3 py-1.5 text-[12px] font-medium text-muted hover:bg-fill hover:text-ink disabled:opacity-50">
                Disconnect
              </button>
              <button onClick={close} className="rounded-full bg-ink px-5 py-2 text-[13px] font-medium text-white hover:bg-violet">
                Done
              </button>
            </div>
          </div>
        )}

        {info?.managed && !info.configured && (
          <div className="mt-4">
            <p className="text-[13px] leading-relaxed text-muted">
              Paste the invite code you were sent. It gives this computer its own address that you can open from your phone or iPad. The code is secret, like a password.
            </p>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="studio-invite:…"
              rows={4}
              spellCheck={false}
              className="mt-3 w-full resize-none rounded-2xl border border-[var(--line)] bg-white px-4 py-3 font-mono text-[12px] outline-none focus:border-violet/50"
            />
            {error && <div className="mt-3 rounded-xl bg-[#e5383b]/10 px-4 py-2.5 text-[13px] font-medium text-[#b42318]">{error}</div>}
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={close} className="rounded-full px-4 py-2 text-[13px] font-medium text-muted hover:bg-fill">
                Not now
              </button>
              <button
                onClick={join}
                disabled={busy || !code.trim()}
                className="rounded-full bg-ink px-5 py-2 text-[13px] font-medium text-white transition hover:bg-violet disabled:opacity-40"
              >
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </div>
        )}
        {error && info?.managed && info.configured && <div className="mt-3 rounded-xl bg-[#e5383b]/10 px-4 py-2.5 text-[13px] font-medium text-[#b42318]">{error}</div>}
      </div>
    </div>,
    document.body,
  );
}
