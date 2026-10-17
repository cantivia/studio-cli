import { termThemeDef, type TermThemeDef } from './termThemes';

/**
 * The colour scheme picked in Settings colours the whole app, not just the terminals. Paper is Studio's original
 * look, value for value; every other scheme's app colours are made from its own terminal colours, so a Dracula
 * Studio looks like Dracula. The values land in the CSS variables of styles.css.
 */

const rgb = (hex: string) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const toHex = (c: number[]) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
/** `a` blended over `b`: weight 1 is all `a`. */
const mix = (a: string, b: string, weight: number) => {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex(x.map((v, i) => v * weight + y[i] * (1 - weight)));
};
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const alpha = (hex: string, a: number) => `rgba(${rgb(hex).join(', ')}, ${a})`;

/** Studio's original look (Paper). */
const PAPER = {
  '--canvas': '#ffffff',
  '--surface': '#ffffff',
  '--ink': '#1d1d1f',
  '--on-ink': '#ffffff',
  '--muted': '#636366',
  '--faint': '#8e8e93',
  '--line': '#e5e5ea',
  '--line-strong': '#d2d2d7',
  '--fill': '#f2f2f5',
  '--accent': '#6d28d9',
  '--accent-hover': '#5b21b6',
  '--on-accent': '#ffffff',
  '--accent-glow': 'rgba(109, 40, 217, 0.14)',
  '--glass-edge': 'rgba(255, 255, 255, 0.85)',
  '--danger-ink': '#b42318',
  '--warn-ink': '#92400e',
  '--success-ink': '#15803d',
};
export type AppVars = typeof PAPER;

export function appVars(def: TermThemeDef): AppVars {
  if (def.id === 'paper') return PAPER;
  const { background: bg, foreground: fg } = def.colors as { background: string; foreground: string };
  const dark = def.dark;
  const accent = def.accent;
  return {
    '--canvas': bg,
    // Panels sit a touch lighter than the background on dark schemes, and whiter on light ones.
    '--surface': dark ? mix(fg, bg, 0.06) : mix('#ffffff', bg, 0.6),
    '--ink': fg,
    '--on-ink': bg,
    '--muted': mix(fg, bg, 0.7),
    '--faint': mix(fg, bg, 0.5),
    '--line': mix(fg, bg, dark ? 0.13 : 0.1),
    '--line-strong': mix(fg, bg, dark ? 0.2 : 0.17),
    '--fill': mix(fg, bg, dark ? 0.08 : 0.05),
    '--accent': accent,
    '--accent-hover': mix(accent, dark ? '#ffffff' : '#000000', 0.82),
    '--on-accent': luminance(accent) > 0.4 ? mix(bg, '#000000', 0.7) : '#ffffff',
    '--accent-glow': alpha(accent, 0.14),
    '--glass-edge': dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(255, 255, 255, 0.85)',
    '--danger-ink': dark ? '#ff8a80' : '#b42318',
    '--warn-ink': dark ? '#f6c453' : '#92400e',
    '--success-ink': dark ? '#5fd4a0' : '#15803d',
  };
}

const CACHE = 'studio_app_theme';

/** Puts a scheme's colours on the page. Cached so index.html can paint them before the app loads (no white flash). */
export function applyAppTheme(themeId: string | undefined) {
  const def = termThemeDef(themeId);
  const vars = appVars(def);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.theme = def.dark ? 'dark' : 'light';
  root.style.colorScheme = def.dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', vars['--canvas']);
  try {
    localStorage.setItem(CACHE, JSON.stringify({ dark: def.dark, vars }));
  } catch {}
}

/** The accent as "r, g, b", for the soft background glow. */
export const accentRgb = (themeId: string | undefined) => rgb(termThemeDef(themeId).accent).join(', ');
