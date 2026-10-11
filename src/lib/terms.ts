import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { isPhone } from './device';
import '@xterm/xterm/css/xterm.css';

/**
 * xterm instances live outside React. A pane borrows a terminal's DOM node
 * while it is mounted and hands it back on unmount, so switching workspaces or
 * tabs never tears down a terminal or replays its scrollback.
 */
type Entry = {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  ws: WebSocket | null;
  opened: boolean;
  /** The process exited on its own. */
  closed: boolean;
  /** The server no longer knows this terminal (it restarted); the pane should respawn. */
  gone: boolean;
  disposed: boolean;
  accent: string;
  ink: boolean;
};

const registry = new Map<string, Entry>();
const CLAUDE_LIGHT_MSG_BG = '\x1b[48;2;240;240;240m';
const listeners = new Set<() => void>();
/** ~9% of the accent over the paper background, as a truecolor background escape. */
function msgTint(accent: string) {
  const n = parseInt(accent.slice(1), 16);
  const paper = [0xfb, 0xf9, 0xf4];
  const mix = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c, i) => Math.round(paper[i] + (c - paper[i]) * 0.09));
  return `\x1b[48;2;${mix.join(';')}m`;
}
const changed = () => listeners.forEach((fn) => fn());

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export const PAPER_BG = '#fbf9f4';
export const INK_BG = '#0e0e10';

const INK_BASE: ITheme = {
  background: INK_BG,
  foreground: '#e9e6df',
  black: '#1d1d1f',
  red: '#ff6b6b',
  green: '#5fd4a0',
  yellow: '#f2c36b',
  blue: '#73a7ff',
  magenta: '#b794f6',
  cyan: '#62d0e6',
  white: '#d2d2d7',
  brightBlack: '#6e6e73',
  brightRed: '#ff8787',
  brightGreen: '#7fe3b6',
  brightYellow: '#f7d48f',
  brightBlue: '#99beff',
  brightMagenta: '#cdb2fa',
  brightCyan: '#8be0f0',
  brightWhite: '#ffffff',
};

/** Warm paper that sits inside the app instead of a black box dropped on top of it. */
const PAPER_BASE: ITheme = {
  background: PAPER_BG,
  foreground: '#1d1d1f',
  black: '#1d1d1f',
  red: '#c8102e',
  green: '#1a7f45',
  yellow: '#9a5b00',
  blue: '#1d5fd1',
  magenta: '#7c3aed',
  cyan: '#0b7489',
  white: '#8e8e93',
  brightBlack: '#8a8780',
  brightRed: '#e5383b',
  brightGreen: '#23a35a',
  brightYellow: '#b87100',
  brightBlue: '#2f74f0',
  brightMagenta: '#9061f9',
  brightCyan: '#1192ad',
  brightWhite: '#3a3a3c',
};

export function themeFor(ink: boolean, accent: string): ITheme {
  const base = ink ? INK_BASE : PAPER_BASE;
  const n = parseInt(accent.slice(1), 16);
  const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  return {
    ...base,
    cursor: accent,
    cursorAccent: base.background,
    selectionBackground: `rgba(${rgb}, ${ink ? 0.34 : 0.2})`,
    selectionInactiveBackground: `rgba(${rgb}, ${ink ? 0.2 : 0.12})`,
    scrollbarSliderBackground: `rgba(${rgb}, 0.18)`,
    scrollbarSliderHoverBackground: `rgba(${rgb}, 0.32)`,
    scrollbarSliderActiveBackground: `rgba(${rgb}, 0.45)`,
  };
}

function connect(termId: string, e: Entry) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/term/${termId}`);
  e.ws = ws;
  ws.onmessage = (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : '';
    // Paper terminals: Claude's light theme puts your messages in a grey box; swap it for a faint wash of the workspace colour.
    e.term.write(e.ink ? data : data.replaceAll(CLAUDE_LIGHT_MSG_BG, msgTint(e.accent)));
  };
  ws.onopen = () => sendSize(e);
  ws.onclose = (ev) => {
    if (e.disposed) return;
    if (ev.reason === 'exited') {
      e.closed = true;
      e.term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n');
      changed();
    } else if (ev.code === 4404) {
      e.gone = true;
      changed();
    } else setTimeout(() => !e.disposed && connect(termId, e), 1000);
  };
}

function sendSize(e: Entry) {
  if (e.ws?.readyState === WebSocket.OPEN) e.ws.send('\x00' + JSON.stringify({ t: 'resize', cols: e.term.cols, rows: e.term.rows }));
}

export function getTerm(termId: string, ink: boolean, accent: string): Entry {
  let e = registry.get(termId);
  if (e) return e;
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: isPhone() ? 11 : 13,
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowProposedApi: true,
    macOptionIsMeta: true,
    scrollback: 10000,
    // Default trackpad/wheel scrolling felt slow; this doubles it (hold ⌥ for faster still).
    scrollSensitivity: 2,
    theme: themeFor(ink, accent),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_ev, uri) => window.open(uri, '_blank')));
  const el = document.createElement('div');
  el.className = 'term-host';
  e = { term, fit, el, ws: null, opened: false, closed: false, gone: false, disposed: false, accent, ink };
  const entry = e;
  term.onData((d) => entry.ws?.readyState === WebSocket.OPEN && entry.ws.send(d));
  registry.set(termId, e);
  connect(termId, e);
  return e;
}

export function mountTerm(termId: string, container: HTMLElement, ink: boolean, accent: string) {
  const e = getTerm(termId, ink, accent);
  container.appendChild(e.el);
  if (!e.opened) {
    e.term.open(e.el);
    e.opened = true;
    // WebGL draws block/box glyphs itself (the Claude logo) and is much faster;
    // fall back to the DOM renderer when the context is unavailable or lost.
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      e.term.loadAddon(gl);
    } catch {}
    touchScroll(e);
    // The same terminal can be open on the Mac and a phone; whichever one you type in sets its size.
    const entry = e;
    e.term.textarea?.addEventListener('focus', () => sendSize(entry));
  }
  fitTerm(termId);
  return e;
}

export function fitTerm(termId: string) {
  const e = registry.get(termId);
  if (!e?.opened || !e.el.isConnected || !e.el.clientWidth) return;
  try {
    const { cols, rows } = e.term;
    e.fit.fit();
    if (cols !== e.term.cols || rows !== e.term.rows) sendSize(e);
  } catch {}
}

/**
 * iPad/iPhone: a one-finger drag scrolls. A shell scrolls its history; a full-screen app like
 * Claude gets mouse-wheel reports (what a real wheel sends it), or arrow keys if it takes no mouse.
 * xterm ignores synthetic wheel events, hence doing it by hand.
 */
function touchScroll(e: Entry) {
  let lastY: number | null = null;
  let acc = 0;
  e.el.addEventListener('touchstart', (ev) => ((lastY = ev.touches.length === 1 ? ev.touches[0].clientY : null), (acc = 0)), { passive: true, capture: true });
  e.el.addEventListener(
    'touchmove',
    (ev) => {
      if (lastY === null) return;
      const t = ev.touches[0];
      acc += lastY - t.clientY;
      lastY = t.clientY;
      ev.preventDefault();
      ev.stopPropagation();
      const cell = e.el.clientHeight / e.term.rows || 16;
      const lines = Math.trunc(acc / cell);
      if (!lines) return;
      acc -= lines * cell;
      if (e.term.buffer.active.type === 'normal') return e.term.scrollLines(lines);
      if (e.ws?.readyState !== WebSocket.OPEN) return;
      const r = e.el.getBoundingClientRect();
      const col = Math.max(1, Math.ceil(((t.clientX - r.left) / r.width) * e.term.cols));
      const row = Math.max(1, Math.ceil(((t.clientY - r.top) / r.height) * e.term.rows));
      const one =
        e.term.modes.mouseTrackingMode !== 'none' ? `\x1b[<${lines > 0 ? 65 : 64};${col};${row}M` : lines > 0 ? '\x1b[B' : '\x1b[A';
      e.ws.send(one.repeat(Math.abs(lines)));
    },
    { passive: false, capture: true },
  );
}

/** True when the shell is scrolled up into its history (never for full-screen apps like Claude). */
export function isScrolledUp(termId: string) {
  const b = registry.get(termId)?.term.buffer.active;
  return !!b && b.type === 'normal' && b.viewportY < b.baseY;
}

export function onTermScroll(termId: string, fn: () => void) {
  const e = registry.get(termId);
  if (!e) return () => {};
  const subs = [e.term.onScroll(fn), e.term.onWriteParsed(fn), e.term.buffer.onBufferChange(fn)];
  return () => subs.forEach((d) => d.dispose());
}

export type KeyName = 'esc' | 'tab' | 'shift-tab' | 'up' | 'down' | 'left' | 'right' | 'ctrl-c';

/** Sends a key the on-screen keyboard lacks, as the terminal itself would encode it. */
export function sendKey(termId: string, key: KeyName) {
  const e = registry.get(termId);
  if (e?.ws?.readyState !== WebSocket.OPEN) return;
  const arrow = (c: string) => (e.term.modes.applicationCursorKeysMode ? `\x1bO${c}` : `\x1b[${c}`);
  const seq = { esc: '\x1b', tab: '\t', 'shift-tab': '\x1b[Z', up: arrow('A'), down: arrow('B'), right: arrow('C'), left: arrow('D'), 'ctrl-c': '\x03' }[key];
  e.ws.send(seq);
}

export function scrollToBottom(termId: string) {
  registry.get(termId)?.term.scrollToBottom();
}

export function focusTerm(termId: string) {
  registry.get(termId)?.term.focus();
}

export function setTheme(ink: boolean) {
  for (const e of registry.values()) {
    e.ink = ink;
    e.term.options.theme = themeFor(ink, e.accent);
  }
}

export function setAccent(termId: string, ink: boolean, accent: string) {
  const e = registry.get(termId);
  if (!e || e.accent === accent) return;
  e.accent = accent;
  e.term.options.theme = themeFor(ink, accent);
}

export function disposeTerm(termId: string) {
  const e = registry.get(termId);
  if (!e) return;
  e.disposed = true;
  e.ws?.close();
  e.term.dispose();
  e.el.remove();
  registry.delete(termId);
}

export const hasTerm = (termId: string) => registry.has(termId);
export const isClosed = (termId: string) => !!registry.get(termId)?.closed;
export const isGone = (termId: string) => !!registry.get(termId)?.gone;
