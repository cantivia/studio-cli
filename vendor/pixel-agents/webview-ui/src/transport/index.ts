// Studio fork: the office UI talks to Studio's server, not the Pixel Agents server.
// One office per Studio workspace (?office=<key>). Art is loaded in the browser by
// browserMock; Studio sends layout, settings and one agent per open terminal.
import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_CONNECTING,
  TRANSPORT_STATE_RECONNECTING,
} from '../../../core/src/constants.js';
import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import { isBrowserRuntime } from '../runtime.js';
import { PostMessageTransport } from './postMessageTransport.js';
import type { MessageTransport, TransportState } from './types.js';

class StudioTransport implements MessageTransport {
  private ws: WebSocket | null = null;
  private handlers: Array<(msg: ServerMessage) => void> = [];
  private stateHandlers: Array<(state: TransportState) => void> = [];
  private outbox: ClientMessage[] = [];
  /** Server messages wait here until the sprites are in, so layout never lands before its art. */
  private inbox: ServerMessage[] = [];
  private assetsReady = false;
  private _state: TransportState = TRANSPORT_STATE_CONNECTING;
  private resolveReady!: () => void;
  readonly ready = new Promise<void>((r) => (this.resolveReady = r));

  constructor(private url: string) {}

  get state() {
    return this._state;
  }

  private setState(s: TransportState) {
    this._state = s;
    this.stateHandlers.forEach((h) => h(s));
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.setState(TRANSPORT_STATE_CONNECTED);
      this.resolveReady();
      for (const m of this.outbox) this.ws!.send(JSON.stringify(m));
      this.outbox = [];
    };
    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        if (this.assetsReady) this.deliver(msg);
        else this.inbox.push(msg);
      } catch {}
    };
    this.ws.onclose = () => {
      this.setState(TRANSPORT_STATE_RECONNECTING);
      setTimeout(() => {
        // Ask for a fresh snapshot after a reconnect.
        this.outbox.push({ type: 'webviewReady' } as ClientMessage);
        this.connect();
      }, 1500);
    };
  }

  markAssetsReady() {
    this.assetsReady = true;
    const queued = this.inbox;
    this.inbox = [];
    queued.forEach((m) => this.deliver(m));
  }

  send(message: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
    else this.outbox.push(message);
  }

  deliver(message: ServerMessage) {
    for (const h of this.handlers) h(message);
  }

  onMessage(handler: (m: ServerMessage) => void) {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  onStateChange(handler: (s: TransportState) => void) {
    this.stateHandlers.push(handler);
    return () => {
      this.stateHandlers = this.stateHandlers.filter((h) => h !== handler);
    };
  }

  dispose() {
    this.ws?.close();
  }
}

function createTransport(): MessageTransport {
  if (!isBrowserRuntime) return new PostMessageTransport();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const office = new URLSearchParams(window.location.search).get('office') || 'all';
  const t = new StudioTransport(`${protocol}//${window.location.host}/ws/office?office=${encodeURIComponent(office)}`);
  t.connect();
  // browserMock injects asset messages as window 'message' events; route them in directly.
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: unknown } | null;
    if (data && typeof data === 'object' && typeof data.type === 'string') t.deliver(data as ServerMessage);
  });
  return t;
}

export const transport: MessageTransport = createTransport();

export function markAssetsReady() {
  if (transport instanceof StudioTransport) transport.markAssetsReady();
}

export type { MessageTransport } from './types.js';
