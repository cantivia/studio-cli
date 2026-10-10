import { useEffect, useState } from 'react';
import { ChevronLeft, Folder, FolderOpen, Clock } from 'lucide-react';
import { api, basename, tildify } from '../lib/api';
import { useStore } from '../lib/store';

type Listing = { path: string; parent: string | null; dirs: string[] };

export function DirPicker({ value, onChange }: { value: string; onChange: (p: string) => void }) {
  const home = useStore((s) => s.home);
  const [recent, setRecent] = useState<string[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    api.get<string[]>('/api/fs/recent').then(setRecent).catch(() => {});
  }, []);

  const browse = (p: string) =>
    api
      .get<Listing>(`/api/fs/dirs?path=${encodeURIComponent(p)}`)
      .then((l) => {
        setListing(l);
        onChange(l.path);
      })
      .catch(() => {});

  useEffect(() => {
    if (home && !listing) browse(value || home);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home]);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-3">
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">
          <Clock size={11} /> Recent projects
        </div>
        <div className="max-h-[300px] space-y-1 overflow-y-auto pr-1">
          {recent.map((d) => (
            <button
              key={d}
              onClick={() => browse(d)}
              className={`w-full rounded-xl px-3 py-2 text-left transition ${value === d ? 'bg-violet/10' : 'hover:bg-fill'}`}
            >
              <div className={`text-[13px] font-medium ${value === d ? 'text-violet' : 'text-ink'}`}>{basename(d)}</div>
              <div className="truncate text-[11px] text-muted">{tildify(d, home)}</div>
            </button>
          ))}
          {!recent.length && <div className="px-3 py-2 text-[12px] text-faint">No Claude projects yet.</div>}
        </div>
      </div>
      <div className="flex min-w-0 flex-col rounded-2xl border border-[var(--line)] bg-white">
        <form
          className="flex items-center gap-1 border-b border-[var(--line)] px-2 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) browse(typed.trim());
          }}
        >
          <button
            type="button"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && browse(listing.parent)}
            className="grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-fill disabled:opacity-30"
          >
            <ChevronLeft size={15} />
          </button>
          <input
            value={typed || tildify(listing?.path || '', home)}
            onChange={(e) => setTyped(e.target.value)}
            onFocus={() => setTyped(tildify(listing?.path || '', home))}
            onBlur={() => setTyped('')}
            className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none"
          />
        </form>
        <div className="max-h-[262px] min-h-[200px] overflow-y-auto p-1">
          {listing?.dirs.map((d) => (
            <button
              key={d}
              onClick={() => browse(`${listing.path}/${d}`.replace('//', '/'))}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink hover:bg-fill"
            >
              <Folder size={14} className="shrink-0 text-faint" />
              <span className="truncate">{d}</span>
            </button>
          ))}
          {listing && !listing.dirs.length && (
            <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-faint">
              <FolderOpen size={14} /> No subfolders
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
