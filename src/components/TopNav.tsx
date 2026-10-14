import { motion } from 'framer-motion';
import { Bell, Command, Gamepad2, History, LayoutGrid, Link2, Menu } from 'lucide-react';
import { useStore } from '../lib/store';
import { useIsPhone } from '../lib/device';
import type { Mode } from '../lib/types';

const TABS: { id: Mode; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'workspaces', label: 'Workspaces', icon: LayoutGrid },
  { id: 'office', label: 'Agent View', icon: Gamepad2 },
  { id: 'sessions', label: 'Sessions', icon: History },
  { id: 'shared', label: 'Shared', icon: Link2 },
];

export function TopNav() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const set = useStore((s) => s.set);
  const unread = useStore((s) => s.notifications.filter((n) => !n.read).length);
  const busy = useStore((s) => Object.values(s.meta).filter((m) => m.claude?.status === 'busy').length);
  const phone = useIsPhone();

  return (
    <header
      className={`drag relative z-20 grid shrink-0 grid-cols-[1fr_auto_1fr] items-center ${phone ? 'h-[52px] px-3' : 'h-[60px] px-5'}`}
    >
      <div className="flex min-w-0 items-center gap-2 text-[12px] font-medium text-muted">
        {phone ? (
          <button
            onClick={() => set({ navOpen: true })}
            className="liquid-glass relative grid h-9 w-9 place-items-center rounded-full text-ink"
            title="Menu"
          >
            <Menu size={17} />
            {busy > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full dot-busy" />}
          </button>
        ) : busy > 0 ? (
          <>
            <span className="h-2 w-2 rounded-full dot-busy" />
            <span className="shimmer-text">
              {busy} agent{busy > 1 ? 's' : ''} working
            </span>
          </>
        ) : (
          <span className="text-faint">All agents idle</span>
        )}
      </div>

      <nav className="liquid-glass flex items-center gap-0.5 rounded-full p-1">
        {TABS.map((t) => {
          const active = mode === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setMode(t.id)}
              title={t.label}
              className={`relative flex items-center gap-2 rounded-full ${phone ? 'px-3.5 py-2' : 'px-4 py-1.5'} text-[13px] font-medium transition-colors duration-300 ${
                active ? 'text-white' : 'text-muted hover:text-ink'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="nav-pill"
                  className="absolute inset-0 rounded-full bg-ink"
                  transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                />
              )}
              <Icon size={14} className="relative" />
              {!phone && <span className="relative">{t.label}</span>}
            </button>
          );
        })}
      </nav>

      <div className="flex min-w-0 items-center justify-end gap-2">
        {!phone && (
          <button
            onClick={() => set({ paletteOpen: true })}
            className="liquid-glass flex items-center gap-2 rounded-full py-1.5 pl-3 pr-2 text-[12px] font-medium text-muted transition hover:text-ink"
          >
            <Command size={13} />
            Commands
            <kbd>⌘K</kbd>
          </button>
        )}
        <button
          onClick={() => set({ notificationsOpen: true })}
          className="liquid-glass relative grid h-8 w-8 place-items-center rounded-full text-muted transition hover:text-ink"
          title="Notifications (⌘⇧I)"
        >
          <Bell size={15} />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 min-w-[17px] rounded-full bg-violet px-1 text-center text-[10px] font-semibold leading-[17px] text-white">
              {unread}
            </span>
          )}
        </button>
      </div>
    </header>
  );
}
