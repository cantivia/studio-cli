import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { AppWindow, ExternalLink, Globe, RotateCw, ShieldOff } from 'lucide-react';
import { useStore } from '../lib/store';
import type { BrowserPane } from '../lib/types';
import { IconBtn } from './TerminalView';
import { Columns2, Maximize2, Rows2, X } from 'lucide-react';

type Props = {
  pane: BrowserPane;
  focused: boolean;
  onFocus: () => void;
  ports: number[];
  actions: { split?: (dir: 'row' | 'col') => void; zoom?: () => void; close: () => void };
};

const normalize = (u: string) => {
  const t = u.trim();
  if (!t) return '';
  if (/^\d+$/.test(t)) return `http://localhost:${t}`;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?/.test(t)) return `http://${t}`;
  return /^https?:\/\//.test(t) ? t : `https://${t}`;
};

export function BrowserView({ pane, focused, onFocus, ports, actions }: Props) {
  const updatePane = useStore((s) => s.updatePane);
  const [draft, setDraft] = useState(pane.url);
  const [nonce, setNonce] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const [embed, setEmbed] = useState<'checking' | 'ok' | 'blocked'>('ok');
  useEffect(() => {
    if (!pane.url) return;
    let live = true;
    setEmbed('checking');
    api
      .get<{ embeddable: boolean }>(`/api/frame-check?url=${encodeURIComponent(pane.url)}`)
      .then((r) => live && setEmbed(r.embeddable ? 'ok' : 'blocked'))
      .catch(() => live && setEmbed('ok'));
    return () => {
      live = false;
    };
  }, [pane.url, nonce]);
  const go = (u: string) => {
    const url = normalize(u);
    setDraft(url);
    updatePane(pane.id, (p) => ({ ...p, url }) as BrowserPane);
  };

  return (
    <div className={`pane paper ${focused ? 'focused' : ''} group/pane flex h-full w-full flex-col`} onMouseDown={onFocus}>
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--line)] px-2.5 text-muted">
        <IconBtn title="Reload" onClick={() => setNonce((n) => n + 1)}>
          <RotateCw size={13} />
        </IconBtn>
        <form
          className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-fill px-3 py-1"
          onSubmit={(e) => {
            e.preventDefault();
            go(draft);
          }}
        >
          <Globe size={12} className="shrink-0" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="localhost:3000 or any URL"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-faint"
          />
        </form>
        {ports.slice(0, 3).map((p) => (
          <button key={p} onClick={() => go(String(p))} className="rounded-md bg-fill px-1.5 py-0.5 text-[11px] font-medium hover:text-violet">
            :{p}
          </button>
        ))}
        {pane.url && (
          <IconBtn title="Open in your browser" onClick={() => window.open(pane.url, '_blank')}>
            <ExternalLink size={13} />
          </IconBtn>
        )}
        <div className="flex items-center opacity-0 transition-opacity group-hover/pane:opacity-100 [@media(hover:none)]:opacity-100">
          {actions.split && (
            <>
              <IconBtn title="Split right" onClick={() => actions.split!('row')}>
                <Columns2 size={13} />
              </IconBtn>
              <IconBtn title="Split down" onClick={() => actions.split!('col')}>
                <Rows2 size={13} />
              </IconBtn>
            </>
          )}
          {actions.zoom && (
            <IconBtn title="Zoom" onClick={actions.zoom}>
              <Maximize2 size={13} />
            </IconBtn>
          )}
          <IconBtn title="Close" onClick={actions.close}>
            <X size={13} />
          </IconBtn>
        </div>
      </div>
      {pane.url && embed === 'blocked' ? (
        <Blocked url={pane.url} paneId={pane.id} />
      ) : pane.url && embed === 'checking' ? (
        <div className="flex-1 bg-white" />
      ) : pane.url ? (
        <iframe
          key={nonce}
          ref={frame}
          src={pane.url}
          title="Browser"
          className="min-h-0 w-full flex-1 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        />
      ) : (
        <div className="grid flex-1 place-items-center text-center text-[13px] text-muted">
          <div>
            <div className="font-medium text-ink">Point it at your dev server</div>
            <div className="mt-1">Type a port or URL above. Sites that forbid embedding open better in your own browser.</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Shown instead of the browser's "refused to connect" page when a site forbids being embedded. */
function Blocked({ url, paneId }: { url: string; paneId: string }) {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  })();
  // A window sized to the right half of the screen, so it sits beside Studio like a split.
  const openSide = () => {
    const w = Math.round(screen.availWidth / 2);
    window.open(url, `studio-${paneId}`, `popup=yes,width=${w},height=${screen.availHeight},left=${screen.availWidth - w},top=0`);
  };
  return (
    <div className="grid flex-1 place-items-center bg-white px-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-fill text-muted">
          <ShieldOff size={20} />
        </div>
        <div className="text-[15px] font-semibold text-ink">{host} can't be shown inside Studio</div>
        <div className="mt-1.5 text-[13px] leading-relaxed text-muted">
          The site tells browsers not to display it inside other apps. Your localhost dev servers and most docs sites work here.
        </div>
        <div className="mt-5 flex justify-center gap-2">
          <button
            onClick={openSide}
            className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-white transition hover:bg-violet"
          >
            <AppWindow size={14} /> Open in side window
          </button>
          <button
            onClick={() => window.open(url, '_blank')}
            className="flex items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium text-muted transition hover:bg-fill hover:text-ink"
          >
            <ExternalLink size={13} /> New tab
          </button>
        </div>
      </div>
    </div>
  );
}
