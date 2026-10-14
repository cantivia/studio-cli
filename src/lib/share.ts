import { api } from './api';
import { useStore } from './store';
import type { Share } from './types';

/** Makes (or renews) the share link for a session or workspace, copies it, and shows the Shared tab. */
export async function shareLink(kind: Share['kind'], ref: string): Promise<Share> {
  const s = await api.post<Share>('/api/shares', { kind, ref });
  try {
    await navigator.clipboard.writeText(s.url);
  } catch {
    // Clipboard blocked (not a secure page): the link is still listed in the Shared tab to copy by hand.
  }
  useStore.getState().set({ mode: 'shared' });
  return s;
}
