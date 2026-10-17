/**
 * The parts of share links and Claude connections that are pure rules and wording, kept apart so they can be
 * tested on their own (links-core.test.ts). Design: docs/superpowers/specs/2026-10-17-sharing-v2-design.md.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long a link lasts, as chosen on its card. `never` means no end date (expiresAt null). */
export const LASTS = { '1h': HOUR, '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY, never: null } as const;
export type Lasts = keyof typeof LASTS;
export const isLasts = (v: unknown): v is Lasts => typeof v === 'string' && v in LASTS;
export const expiryFor = (lasts: Lasts, now = Date.now()) => (LASTS[lasts] === null ? null : now + LASTS[lasts]!);
export const isLive = (s: { expiresAt: number | null }, now = Date.now()) => s.expiresAt === null || s.expiresAt > now;

/** Claude connections pause themselves after this many messages with nobody typing in either pane. */
export const BRAKE_AFTER = 20;

/** Counts messages between two Claudes since a person last typed; says when to pause. */
export class Brake {
  count = 0;
  constructor(private limit = BRAKE_AFTER) {}
  /** A message went one way or the other. True when the connection should now pause. */
  message() {
    this.count++;
    return this.count >= this.limit;
  }
  human() {
    this.count = 0;
  }
}

const one = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Typed into your Claude when a teammate's Claude connects, so it knows the two commands. */
export const introText = (partner: string, where: string) =>
  `You're now connected to ${one(partner)}'s Claude (working in ${one(where)}) through Studio, so you can work together. ` +
  `To send it a message, run: studio tell "your message" (it arrives in that Claude straight away). ` +
  `To see what it has been doing lately, run: studio peek. ` +
  `Its messages will arrive here starting with "Message from ${one(partner)}'s Claude". ` +
  `Only message it when it helps the task. No need to reply to this note.`;

/** How a teammate Claude's message arrives in your Claude. */
export const incomingText = (partner: string, text: string) => `Message from ${one(partner)}'s Claude (reply with: studio tell "…"):\n\n${text}`;

/** How a guest's message from a share link arrives in your Claude. */
export const guestText = (name: string, text: string) => `Message from ${one(name) || 'a guest'} (a guest on your share link):\n\n${text}`;

export const MAX_MESSAGE = 4000;

/** What `studio peek` prints: a teammate's Claude's recent conversation and commands, oldest first. */
export function peekText(partner: string, events: { kind: string; tool?: string | null; text: string }[]) {
  if (!events.length) return `${partner}'s Claude hasn't done anything yet in this conversation.`;
  const line = (e: (typeof events)[number]) =>
    e.kind === 'user' ? `${partner}: ${e.text}` : e.kind === 'assistant' ? `Claude: ${e.text}` : `  (${e.tool || 'tool'}) ${e.text}`;
  return `What ${partner}'s Claude has been doing (most recent last):\n\n` + events.map(line).join('\n');
}

/** Wrapped like a paste, so a multi-line message stays one message in Claude Code. */
export const asPaste = (text: string) => (text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
