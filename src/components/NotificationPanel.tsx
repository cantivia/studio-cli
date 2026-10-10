import { AnimatePresence, motion } from 'framer-motion';
import { Bell, CheckCheck, Sparkles, Trash2, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, timeAgo } from '../lib/api';
import { jumpToTerminal } from '../App';

export function NotificationPanel() {
  const open = useStore((s) => s.notificationsOpen);
  const list = useStore((s) => s.notifications);
  const set = useStore((s) => s.set);
  const close = () => set({ notificationsOpen: false });

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close} className="fixed inset-0 z-40 bg-black/10" />
          <motion.aside
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="liquid-glass fixed bottom-3 right-3 top-3 z-50 flex w-[380px] flex-col rounded-[24px]"
          >
            <div className="flex items-center gap-2 px-5 pb-3 pt-5">
              <Bell size={16} />
              <span className="text-[15px] font-semibold text-ink">Notifications</span>
              <div className="ml-auto flex items-center gap-1">
                <button onClick={() => api.markRead({ all: true })} title="Mark all read" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-black/5 hover:text-ink">
                  <CheckCheck size={15} />
                </button>
                <button onClick={() => api.post('/api/notifications/clear')} title="Clear all" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-black/5 hover:text-ink">
                  <Trash2 size={14} />
                </button>
                <button onClick={close} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-black/5 hover:text-ink">
                  <X size={15} />
                </button>
              </div>
            </div>
            <div className="px-5 pb-2 text-[12px] text-muted">
              <kbd>⌘⇧U</kbd> jumps to the latest unread
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
              {list.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    if (n.termId) jumpToTerminal(n.termId);
                    else api.markRead({ ids: [n.id] });
                    close();
                  }}
                  className={`w-full rounded-2xl px-4 py-3 text-left transition ${n.read ? 'hover:bg-white/70' : 'surface'}`}
                >
                  <div className="flex items-center gap-2">
                    {!n.read && <span className="h-1.5 w-1.5 rounded-full bg-violet" />}
                    {n.source === 'claude' && <Sparkles size={12} className="text-violet" />}
                    <span className="truncate text-[13px] font-semibold text-ink">{n.title}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-faint">{timeAgo(n.at)}</span>
                  </div>
                  <div className={`mt-1 line-clamp-3 text-[12px] leading-snug ${n.read ? 'text-faint' : 'text-muted'}`}>{n.body}</div>
                </button>
              ))}
              {!list.length && (
                <div className="px-6 pt-16 text-center text-[13px] text-muted">
                  Nothing yet. When Claude finishes a turn, or a terminal rings, it shows up here with what it actually said.
                </div>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
