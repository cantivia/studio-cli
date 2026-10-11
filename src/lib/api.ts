async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {}
  // Non-JSON (a proxy's or Cloudflare's error page): show the status instead of a JSON parse error.
  if (!res.ok || data === null) throw new Error(data?.error || `${res.status} ${res.statusText || text.slice(0, 80)}`.trim());
  return data as T;
}

export const api = {
  get: <T>(url: string) => req<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => req<T>('POST', url, body),
  put: <T>(url: string, body: unknown) => req<T>('PUT', url, body),
  del: <T>(url: string) => req<T>('DELETE', url),
  send: (termId: string, text: string, enter = true) => req('POST', `/api/terminals/${termId}/send`, { text, enter }),
  markRead: (body: { ids?: string[]; termId?: string; all?: boolean }) => req('POST', '/api/notifications/read', body),
};

export const uid = () => Math.random().toString(36).slice(2, 10);

export const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

export const tildify = (p: string, home: string) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p);

export function timeAgo(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d}d ago` : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
