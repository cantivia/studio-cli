import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { Check, ExternalLink, Smartphone, Trash2 } from 'lucide-react';
import { api, timeAgo } from '../lib/api';
import { useStore } from '../lib/store';

type Remote = {
  managed: boolean;
  running: boolean;
  hasBinary: boolean;
  hasToken: boolean;
  configured: boolean;
  mode: 'pairing' | 'access' | null;
  host: string | null;
  allow: string[];
  devices: number;
};
type Device = { id: string; name: string; createdAt: number; lastSeen: number };
type Pairing = { code: string; expiresAt: number; url: string; qr: string };

/** Settings → Phone & remote access: one press gives this computer its own address; then pair phones with a code or QR. */
export function RemoteDialog() {
  const open = useStore((s) => s.remoteOpen);
  const set = useStore((s) => s.set);
  const [info, setInfo] = useState<Remote | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [now, setNow] = useState(Date.now());
  const [invite, setInvite] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<Remote>('/api/remote').catch(() => null);
    if (!r) return;
    setInfo(r);
    if (r.mode === 'pairing') api.get<Device[]>('/api/remote/devices').then(setDevices).catch(() => {});
  }, []);

  useEffect(() => {
    if (open) {
      setError(null);
      setPairing(null);
      load();
    }
  }, [open, load]);
  // While a code is showing, notice when a phone claims it (the device list grows) and keep the countdown moving.
  useEffect(() => {
    if (!open || !pairing) return;
    const t = setInterval(() => {
      setNow(Date.now());
      load();
    }, 2000);
    return () => clearInterval(t);
  }, [open, pairing, load]);
  // The tunnel takes a few seconds to come up.
  useEffect(() => {
    if (!open || !info?.configured || info.running) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [open, info, load]);

  if (!open) return null;
  const close = () => set({ remoteOpen: false });
  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  const turnOn = () =>
    guard(async () => {
      setInfo(await api.post<Remote>('/api/remote/enable'));
      await load();
    });
  const join = () =>
    guard(async () => {
      setInfo(await api.post<Remote>('/api/remote/join', { code }));
      setCode('');
    });
  const disconnect = () =>
    guard(async () => {
      setInfo(await api.del<Remote>('/api/remote'));
      setDevices([]);
      setPairing(null);
    });
  const addPhone = () =>
    guard(async () => {
      const p = await api.post<{ code: string; expiresAt: number; url: string }>('/api/remote/pair');
      const qr = await QRCode.toString(p.url, { type: 'svg', margin: 1, width: 176, color: { dark: '#1d1d1f', light: '#0000' } });
      setPairing({ ...p, qr });
      setNow(Date.now());
    });
  const removeDevice = (id: string) => api.del(`/api/remote/devices/${id}`).then(load).catch(() => {});

  const left = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0;
  const err = error && <div className="mt-3 rounded-xl bg-[#e5383b]/10 px-4 py-2.5 text-[13px] font-medium text-[#b42318]">{error}</div>;

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/15 backdrop-blur-[3px]" onMouseDown={close}>
      <div onMouseDown={(e) => e.stopPropagation()} className="surface max-h-[calc(100vh-24px)] w-[min(560px,calc(100vw-24px))] overflow-y-auto rounded-[26px] p-6">
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

        {/* Not turned on yet */}
        {info?.managed && !info.configured && (
          <div className="mt-4">
            <p className="text-[13px] leading-relaxed text-muted">
              Use Studio from your phone or iPad. This gives your computer its own private address; you then pair each phone once with a short code. No account or email needed.
            </p>
            {!invite ? (
              <>
                {err}
                <div className="mt-5 flex items-center justify-between gap-2">
                  <button onClick={() => setInvite(true)} className="text-[12px] font-medium text-faint underline-offset-2 hover:text-ink hover:underline">
                    I have an invite code instead
                  </button>
                  <div className="flex gap-2">
                    <button onClick={close} className="rounded-full px-4 py-2 text-[13px] font-medium text-muted hover:bg-fill">
                      Not now
                    </button>
                    <button onClick={turnOn} disabled={busy} className="rounded-full bg-ink px-5 py-2 text-[13px] font-medium text-white transition hover:bg-violet disabled:opacity-50">
                      {busy ? 'Setting up…' : 'Turn on phone access'}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <textarea
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="studio-invite:…"
                  rows={4}
                  spellCheck={false}
                  className="mt-3 w-full resize-none rounded-2xl border border-[var(--line)] bg-white px-4 py-3 font-mono text-[12px] outline-none focus:border-violet/50"
                />
                {err}
                <div className="mt-5 flex justify-between gap-2">
                  <button onClick={() => setInvite(false)} className="rounded-full px-3 py-1.5 text-[12px] font-medium text-muted hover:bg-fill hover:text-ink">
                    Back
                  </button>
                  <button
                    onClick={join}
                    disabled={busy || !code.trim()}
                    className="rounded-full bg-ink px-5 py-2 text-[13px] font-medium text-white transition hover:bg-violet disabled:opacity-40"
                  >
                    {busy ? 'Connecting…' : 'Connect'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Turned on */}
        {info?.managed && info.configured && (
          <div className="mt-4">
            <a
              href={`https://${info.host}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between gap-2 rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[14px] font-semibold text-ink hover:border-violet/40"
            >
              <span className="truncate">{info.host}</span>
              <ExternalLink size={14} className="shrink-0 text-faint" />
            </a>
            <div className="mt-3 flex items-center gap-2 text-[12px] text-muted">
              {info.running ? (
                <>
                  <Check size={13} className="text-[#16a34a]" /> Online. Your computer has to stay on and awake.
                </>
              ) : !info.hasBinary ? (
                'The connection program (cloudflared) wasn’t found. Reinstall the app.'
              ) : (
                <>
                  <span className="h-2 w-2 animate-pulse rounded-full bg-[#f59e0b]" /> Connecting…
                </>
              )}
            </div>

            {info.mode === 'pairing' && (
              <div className="mt-5 border-t border-[var(--line)] pt-4">
                {!pairing ? (
                  <>
                    <p className="text-[13px] leading-relaxed text-muted">Only phones you pair can open that address. Pairing takes a few seconds.</p>
                    <button onClick={addPhone} disabled={busy} className="mt-3 rounded-full bg-ink px-5 py-2 text-[13px] font-medium text-white transition hover:bg-violet disabled:opacity-40">
                      Add a phone
                    </button>
                  </>
                ) : (
                  <div className="flex items-center gap-5">
                    <div className="h-[176px] w-[176px] shrink-0 rounded-2xl border border-[var(--line)] bg-white p-1" dangerouslySetInnerHTML={{ __html: pairing.qr }} />
                    <div className="min-w-0">
                      <div className="text-[12px] text-muted">Scan this with your phone’s camera, or open <b className="text-ink">{info.host}/pair</b> and type:</div>
                      <div className="mt-2 font-mono text-[26px] font-bold tracking-[0.12em] text-ink">{pairing.code}</div>
                      <div className="mt-1 text-[12px] text-faint">
                        {left > 0 ? `Works once, for the next ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Expired.'}
                      </div>
                      <button onClick={addPhone} className="mt-2 text-[12px] font-medium text-violet hover:underline">
                        {left > 0 ? 'New code' : 'Make a new code'}
                      </button>
                    </div>
                  </div>
                )}
                {devices.length > 0 && (
                  <div className="mt-5">
                    <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">Paired devices</div>
                    {devices.map((d) => (
                      <div key={d.id} className="flex items-center gap-2 rounded-xl px-1 py-1.5 text-[13px]">
                        <Smartphone size={14} className="shrink-0 text-faint" />
                        <span className="font-medium text-ink">{d.name}</span>
                        <span className="text-faint">· {timeAgo(d.lastSeen)}</span>
                        <button onClick={() => removeDevice(d.id)} title="Sign this device out" className="ml-auto grid h-6 w-6 place-items-center rounded-md text-faint hover:bg-black/5 hover:text-ink">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {info.mode === 'access' && <p className="mt-4 text-[12px] leading-relaxed text-muted">Sign in at that address with your work email.</p>}
            {err}
            <div className="mt-5 flex justify-between">
              <button onClick={disconnect} disabled={busy} className="rounded-full px-3 py-1.5 text-[12px] font-medium text-muted hover:bg-fill hover:text-ink disabled:opacity-50" title="Turns off remote access and signs every phone out">
                Turn off
              </button>
              <button onClick={close} className="rounded-full bg-ink px-5 py-2 text-[13px] font-medium text-white hover:bg-violet">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
