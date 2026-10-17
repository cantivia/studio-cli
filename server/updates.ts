import { readJson, writeJson } from './store.ts';

/**
 * Automatic updates are done by the Mac app (electron/updater.cjs). The server is the go-between: it knows when
 * someone last typed and when a Claude was last busy (the app restarts only when both have been quiet a while),
 * keeps the "update automatically" choice, and passes the app's status to Settings and Settings' requests to the app.
 */
export type UpdateStatus = { state: string; current: string; latest?: string; progress?: number; error?: string; checkedAt?: number };

let lastInput = Date.now();
let lastBusy = Date.now();
let status: (UpdateStatus & { at: number }) | null = null;
let asked = { check: false, install: false };
let prefs: { auto: boolean } | null = null;

export const noteInput = () => void (lastInput = Date.now());
export const noteBusy = () => void (lastBusy = Date.now());
const loadPrefs = async () => (prefs ??= await readJson('updates.json', { auto: true }));

/** The app's report (every few seconds). The reply says what it should do next. */
export async function appReport(s: UpdateStatus) {
  const reply = { auto: (await loadPrefs()).auto, ...asked, sinceBusy: Date.now() - lastBusy, sinceInput: Date.now() - lastInput };
  status = { ...s, at: Date.now() };
  // Settings shouldn't flick back to "Up to date" while the app picks up the request.
  if (asked.install) status.state = 'installing';
  else if (asked.check && status.state === 'idle') status.state = 'checking';
  asked = { check: false, install: false };
  return reply;
}

/** What Settings shows. inApp is false in `npm run dev`, where there's no app to update. */
export async function updateInfo() {
  const inApp = !!status && Date.now() - status.at < 30_000;
  return { inApp, auto: (await loadPrefs()).auto, ...(inApp ? status : {}) };
}

export async function updateRequest(body: { auto?: unknown; check?: unknown; install?: unknown }) {
  if (typeof body.auto === 'boolean') {
    (await loadPrefs()).auto = body.auto;
    await writeJson('updates.json', prefs);
  }
  if (body.check) {
    asked.check = true;
    if (status?.state === 'idle' || status?.state === 'error') status.state = 'checking';
  }
  if (body.install && status?.state === 'ready') {
    asked.install = true;
    status.state = 'installing';
  }
}
