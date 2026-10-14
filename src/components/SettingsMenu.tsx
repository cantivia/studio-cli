import { useEffect, useRef, useState } from 'react';
import { SPLASH_OFF_KEY } from './intro/StudioIntro';
import { motion } from 'framer-motion';
import { Smartphone } from 'lucide-react';
import { useStore } from '../lib/store';

export function SettingsMenu({ onClose }: { onClose: () => void }) {
  const ink = useStore((s) => s.inkTerminals);
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
      <Toggle label="Ink terminals" hint="Dark terminals instead of paper" on={ink} onClick={() => set({ inkTerminals: !ink })} />
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
