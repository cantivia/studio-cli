import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
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
    // Paper terminals: Claude's light theme puts your messages in a pale grey box; show them as plain text instead.
    e.term.write(e.ink ? data : data.replaceAll(CLAUDE_LIGHT_MSG_BG, '\x1b[49m'));
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
    fontSize: 13,
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowProposedApi: true,
    macOptionIsMeta: true,
    scrollback: 10000,
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
