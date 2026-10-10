/**
 * Colour coding. Every workspace, Claude tab and workflow gets its own hue.
 * `ui` is for chrome on white (text, bars, rings); `glow` is a lighter tone that
 * reads on both the paper and ink terminal themes, so the shell prompt uses it.
 */
export type Hue = { id: string; name: string; ui: string; glow: string };

export const PALETTE: Hue[] = [
  { id: 'violet', name: 'Violet', ui: '#6d28d9', glow: '#8b5cf6' },
  { id: 'blue', name: 'Blue', ui: '#2563eb', glow: '#3b82f6' },
  { id: 'teal', name: 'Teal', ui: '#0f766e', glow: '#14b8a6' },
  { id: 'green', name: 'Green', ui: '#15803d', glow: '#22c55e' },
  { id: 'amber', name: 'Amber', ui: '#b45309', glow: '#f59e0b' },
  { id: 'orange', name: 'Orange', ui: '#c2410c', glow: '#f97316' },
  { id: 'rose', name: 'Rose', ui: '#be123c', glow: '#f43f5e' },
  { id: 'pink', name: 'Pink', ui: '#be185d', glow: '#ec4899' },
  { id: 'indigo', name: 'Indigo', ui: '#4338ca', glow: '#6366f1' },
  { id: 'cyan', name: 'Cyan', ui: '#0e7490', glow: '#06b6d4' },
];

export const hue = (id?: string, fallbackIndex = 0): Hue =>
  PALETTE.find((h) => h.id === id) || PALETTE[((fallbackIndex % PALETTE.length) + PALETTE.length) % PALETTE.length];

/** The first colour nobody is using yet; once all are taken, keep cycling. */
export function nextHue(used: (string | undefined)[]): string {
  const free = PALETTE.find((h) => !used.includes(h.id));
  return free ? free.id : PALETTE[used.length % PALETTE.length].id;
}

export const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
