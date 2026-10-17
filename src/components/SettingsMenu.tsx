import { useEffect, useRef, useState } from 'react';
import { SPLASH_OFF_KEY } from './intro/StudioIntro';
import { motion } from 'framer-motion';
import { Smartphone } from 'lucide-react';
import { useStore } from '../lib/store';
import { TERM_THEMES } from '../lib/termThemes';

export function SettingsMenu({ onClose }: { onClose: () => void }) {
  const themeId = useStore((s) => s.terminalTheme);
  const desktop = useStore((s) => s.desktopNotifications);
  const set = useStore((s) => s.set);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const toggleDesktop = async () => {
    if (!desktop && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') return;
    }
    set({ desktopNotifications: !desktop });
  };

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="surface absolute bottom-14 left-3 right-3 z-50 rounded-2xl p-2"
    >
      <div className="px-3 pb-1 pt-2">
        <div className="text-[13px] font-medium text-ink">Terminal theme</div>
        <div className="text-[12px] text-muted">Colours for every terminal and Claude pane</div>
        <div className="mt-2 grid max-h-[232px] grid-cols-1 gap-1 overflow-y-auto pr-0.5">
          {TERM_THEMES.map((t) => {
            const on = t.id === themeId;
            return (
              <button
                key={t.id}
                title={t.hint}
                onClick={() => set({ terminalTheme: t.id })}
                className={`flex items-center gap-2.5 rounded-xl border px-2 py-1 text-left transition hover:bg-fill ${on ? 'border-violet bg-fill' : 'border-[var(--line)]'}`}
              >
                <span
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-black/10 font-mono text-[10px] font-bold"
                  style={{ background: t.colors.background, color: t.colors.foreground }}
                >
                  <span style={{ color: t.colors.blue }}>$</span>
                </span>
                <span className="min-w-0 truncate text-[12px] font-medium text-ink">{t.name}</span>
              </button>
            );
          })}
        </div>
      </div>
      <IntroToggle />
      <button
        onClick={() => {
          set({ remoteOpen: true });
          onClose();
        }}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-fill"
      >
        <div className="flex-1">
          <div className="text-[13px] font-medium text-ink">Phone &amp; remote access</div>
          <div className="text-[12px] text-muted">Use Studio from your phone or iPad</div>
        </div>
        <Smartphone size={15} className="text-faint" />
      </button>
      <Toggle label="Desktop notifications" hint="When Studio is in the background" on={desktop} onClick={toggleDesktop} />
      <Updates />
    </motion.div>
  );
}

function Toggle({ label, hint, on, onClick }: { label: string; hint: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-fill">
      <div className="flex-1">
        <div className="text-[13px] font-medium text-ink">{label}</div>
        <div className="text-[12px] text-muted">{hint}</div>
      </div>
      <span className={`relative h-5 w-9 rounded-full transition-colors ${on ? 'bg-violet' : 'bg-[var(--line-strong)]'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

function IntroToggle() {
  const read = () => {
    try {
      return localStorage.getItem(SPLASH_OFF_KEY) !== 'off';
    } catch {
      return true;
    }
  };
  const [on, setOn] = useState(read);
  return (
    <Toggle
      label="Opening animation"
      hint="Writes studio cli when the app opens"
      on={on}
      onClick={() => {
        try {
          localStorage.setItem(SPLASH_OFF_KEY, on ? 'off' : 'on');
        } catch {}
        setOn(!on);
      }}
    />
  );
}

type UpdateInfo = { inApp: boolean; auto: boolean; state?: string; current?: string; latest?: string; progress?: number; error?: string };

/** Version and automatic updates (done by the Mac app, see electron/updater.cjs). */
function Updates() {
  const [u, setU] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    const load = () => fetch('/api/update').then((r) => r.json()).then(setU).catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);
  const send = (body: object) =>
    fetch('/api/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .then(setU)
      .catch(() => {});
  if (!u) return null;
  if (!u.inApp) return <div className="px-3 py-2 text-[12px] text-muted">Updates come with the Mac app</div>;
  const line =
    u.state === 'checking' ? 'Checking for updates…'
    : u.state === 'downloading' ? `Downloading ${u.latest}${u.progress ? ` · ${u.progress}%` : ''}`
    : u.state === 'ready' ? `${u.latest} is ready${u.auto ? ' · installs when you’re idle' : ''}`
    : u.state === 'installing' ? `Installing ${u.latest}…`
    : u.state === 'move' ? 'Move Studio CLI to Applications to get updates'
    : u.state === 'error' ? `Couldn’t update: ${u.error}`
    : 'Up to date';
  const busy = u.state === 'checking' || u.state === 'downloading' || u.state === 'installing';
  return (
    <>
      <div className="flex items-center gap-3 rounded-xl px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink">Studio {u.current}</div>
          <div className="truncate text-[12px] text-muted" title={line}>{line}</div>
        </div>
        {u.state === 'ready' ? (
          <button onClick={() => send({ install: true })} className="shrink-0 rounded-full bg-violet px-3 py-1 text-[12px] font-medium text-white">
            Update now
          </button>
        ) : (
          u.state !== 'move' && (
            <button disabled={busy} onClick={() => send({ check: true })} className="shrink-0 rounded-full border border-[var(--line)] px-3 py-1 text-[12px] font-medium text-ink hover:bg-fill disabled:opacity-50">
              Check now
            </button>
          )
        )}
      </div>
      <Toggle label="Update automatically" hint="Restarts Studio when you’re idle; terminals keep running" on={u.auto} onClick={() => send({ auto: !u.auto })} />
    </>
  );
}
