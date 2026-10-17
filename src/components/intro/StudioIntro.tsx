import { useEffect, useState } from 'react';
import { INK_TAG, INK_WORD, type InkLine } from './ink-data';

/**
 * Opening animation, copied from cantivia/studio (src/components/splash/studio-intro.tsx) with "cli" added after
 * "studio". The wordmark and tagline are written by an unseen pen: SVG centreline strokes drawn with
 * stroke-dashoffset, in order. It is a decorative overlay above the already mounted app; nothing waits for it.
 * Any click or key skips it. Plays once per window session; off via localStorage "studio_splash" = "off".
 */

export const SPLASH_SEEN_KEY = 'studio_cli_splash_seen';
export const SPLASH_OFF_KEY = 'studio_splash';
const INTRO_WORDMARK = 'studio cli';
const INTRO_TAGLINE = 'lets make money';

/** Timeline in milliseconds. Studio's, stretched a little for the three extra letters. */
const WORD_START = 150;
const WORD_END = 1850;
const TAG_START = 2050;
const TAG_END = 3850;
const HOLD_UNTIL = 4650;
const LEAVE_MS = 380;
const REDUCED_MS = 600;

const EASES = [
  'cubic-bezier(0.45, 0.05, 0.35, 1)',
  'cubic-bezier(0.3, 0.1, 0.25, 1)',
  'cubic-bezier(0.55, 0.1, 0.4, 1)',
  'cubic-bezier(0.4, 0, 0.2, 1)',
];

type Timed = { d: string; delay: number; dur: number; ease: string };

export function introWanted(): boolean {
  try {
    if (localStorage.getItem(SPLASH_OFF_KEY) === 'off') return false;
    if (sessionStorage.getItem(SPLASH_SEEN_KEY)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Spread the strokes of one line across [start, end]. Time per stroke follows its length (slightly sub-linear, so
 * short strokes are not instant), with a small pause for each pen lift and a longer one at gaps in the writing.
 */
function schedule(line: InkLine, start: number, end: number, lift: number, jump: number): Timed[] {
  const parts = line.strokes.map(([d, len], i) => {
    const m = /^M([-\d.]+) ([-\d.]+)/.exec(d);
    const nums = d.match(/-?\d*\.?\d+/g) ?? [];
    const n = nums.length;
    return {
      d,
      w: Math.pow(Math.max(len, 4), 0.85),
      x: m ? parseFloat(m[1]) : 0,
      y: m ? parseFloat(m[2]) : 0,
      ex: n >= 2 ? parseFloat(nums[n - 2]) : 0,
      ey: n >= 2 ? parseFloat(nums[n - 1]) : 0,
      i,
    };
  });
  const gaps = parts.map((p, i) => {
    if (i === 0) return 0;
    const prev = parts[i - 1];
    return Math.hypot(p.x - prev.ex, p.y - prev.ey) > line.h * 0.18 ? jump : lift;
  });
  const gapTotal = gaps.reduce((a, b) => a + b, 0);
  const MIN = parts.length > 20 ? 20 : 45;
  const budget = Math.max(end - start - gapTotal, parts.length * MIN);
  const floored = new Set<number>();
  for (let pass = 0; pass < 8; pass++) {
    const restBudget = budget - floored.size * MIN;
    const restW = parts.reduce((a, p) => a + (floored.has(p.i) ? 0 : p.w), 0);
    let grew = false;
    parts.forEach((p) => {
      if (!floored.has(p.i) && (p.w / restW) * restBudget < MIN) {
        floored.add(p.i);
        grew = true;
      }
    });
    if (!grew) break;
  }
  const rest = budget - floored.size * MIN;
  const restWeight = parts.reduce((a, p) => a + (floored.has(p.i) ? 0 : p.w), 0);
  let t = start;
  return parts.map((p, i) => {
    t += gaps[i];
    const dur = floored.has(p.i) ? MIN : (p.w / restWeight) * rest;
    const out = { d: p.d, delay: Math.round(t), dur: Math.round(dur), ease: EASES[(i * 7 + 3) % EASES.length] };
    t += dur;
    return out;
  });
}

const WORD_STROKES = schedule(INK_WORD, WORD_START, WORD_END, 25, 55);
const TAG_STROKES = schedule(INK_TAG, TAG_START, TAG_END, 6, 22);

// Same letter size as studio's wordmark: its 202-unit "studio" is 400px wide, so scale the wider line to match.
const WORD_PX = Math.round((400 * INK_WORD.w) / 202.3);

const CSS = `
.studio-intro {
  --intro-ink: #111111;
  --intro-tag: #6D28D9;
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; align-items: center; justify-content: center;
  background: #FDFBF7; cursor: default; user-select: none; -webkit-user-select: none;
}
/* On a dark scheme the opening animation is drawn on the app's own colours (lib/appTheme.ts). */
[data-theme="dark"] .studio-intro { --intro-ink: var(--ink); --intro-tag: var(--accent); background: var(--canvas); }
.studio-intro-stack { display: flex; flex-direction: column; align-items: center; transform: translateY(-3vh); padding: 0 24px; }
.studio-intro[data-state="leave"] { pointer-events: none; animation: studio-intro-out ${LEAVE_MS}ms ease forwards; }
.studio-intro[data-state="leave"] .studio-intro-stack { animation: studio-intro-lift ${LEAVE_MS}ms ease forwards; }
@keyframes studio-intro-out { to { opacity: 0; } }
@keyframes studio-intro-lift { to { transform: translateY(calc(-3vh - 14px)); } }
.studio-ink { display: block; overflow: visible; height: auto; }
.studio-ink-word { width: min(86vw, ${WORD_PX}px); }
.studio-ink-tag { width: min(84vw, 440px); margin-top: clamp(18px, 3.8vw, 30px); }
.studio-ink path { fill: none; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 1 2; stroke-dashoffset: 1; opacity: 0; }
.studio-ink-word path { stroke: var(--intro-ink); stroke-width: 7px; }
.studio-ink-tag path { stroke: var(--intro-tag); stroke-width: 3px; }
.studio-ink path { animation: studio-ink-draw var(--t) var(--e) var(--d) both; }
.studio-intro:not([data-go]) .studio-ink path { animation-play-state: paused; }
@keyframes studio-ink-draw {
  0% { stroke-dashoffset: 1; opacity: 0; }
  0.5% { stroke-dashoffset: 1; opacity: 1; }
  100% { stroke-dashoffset: 0; opacity: 1; }
}
.studio-intro[data-reduced] .studio-ink path { animation: none; stroke-dashoffset: 0; opacity: 1; }
@media (prefers-reduced-motion: reduce) { .studio-intro[data-state="leave"] .studio-intro-stack { animation: none; } }
`;

/** Waits until the page has finished its heavy first work (load + two frames), but never longer than MAX_WAIT_MS. */
const MAX_WAIT_MS = 900;
function whenCalm(cb: () => void): () => void {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    window.clearTimeout(cap);
    requestAnimationFrame(() => requestAnimationFrame(cb));
  };
  const cap = window.setTimeout(fire, MAX_WAIT_MS);
  if (document.readyState === 'complete') {
    const idle = (window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(fire, { timeout: 300 });
    else window.setTimeout(fire, 60);
  } else {
    window.addEventListener('load', () => window.setTimeout(fire, 30), { once: true });
  }
  return () => {
    done = true;
    window.clearTimeout(cap);
  };
}

function InkLayer({ line, strokes, className }: { line: InkLine; strokes: Timed[]; className: string }) {
  return (
    <svg className={`studio-ink ${className}`} viewBox={`0 0 ${line.w} ${line.h}`} aria-hidden="true" focusable="false">
      {strokes.map((s, i) => (
        <path
          key={i}
          d={s.d}
          pathLength={1}
          style={{ ['--d' as string]: `${s.delay}ms`, ['--t' as string]: `${s.dur}ms`, ['--e' as string]: s.ease }}
        />
      ))}
    </svg>
  );
}

/** index.html marks <html data-intro> before first paint so the app stays hidden until the intro covers it. */
function removeFirstPaintMark() {
  document.documentElement.removeAttribute('data-intro');
}

export function StudioIntro() {
  const [state, setState] = useState<'play' | 'leave' | 'done'>(() => (introWanted() ? 'play' : 'done'));
  const [reduced, setReduced] = useState(false);
  const [go, setGo] = useState(false);

  useEffect(() => {
    if (state !== 'play') {
      removeFirstPaintMark();
      return;
    }
    try {
      sessionStorage.setItem(SPLASH_SEEN_KEY, '1');
    } catch {
      // storage can be blocked; the intro then plays on every load
    }
    const isReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setReduced(isReduced);
    removeFirstPaintMark();
    const leave = () => setState((s) => (s === 'play' ? 'leave' : s));
    let timer = 0;
    const stopWaiting = whenCalm(() => {
      setGo(true);
      timer = window.setTimeout(leave, isReduced ? REDUCED_MS : HOLD_UNTIL);
    });
    window.addEventListener('pointerdown', leave, { capture: true });
    window.addEventListener('keydown', leave, { capture: true });
    return () => {
      stopWaiting();
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', leave, { capture: true });
      window.removeEventListener('keydown', leave, { capture: true });
    };
  }, [state]);

  useEffect(() => {
    if (state !== 'leave') return;
    const t = window.setTimeout(() => setState('done'), LEAVE_MS + 40);
    return () => window.clearTimeout(t);
  }, [state]);

  if (state === 'done') return null;

  return (
    <>
      <span role="status" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
        {INTRO_WORDMARK}, {INTRO_TAGLINE}
      </span>
      <div
        className="studio-intro"
        data-state={state}
        data-go={go || reduced || undefined}
        data-reduced={reduced || undefined}
        aria-hidden="true"
        style={{ willChange: 'opacity, transform', contain: 'layout paint' }}
      >
        <style>{CSS}</style>
        <div className="studio-intro-stack">
          <InkLayer line={INK_WORD} strokes={WORD_STROKES} className="studio-ink-word" />
          <InkLayer line={INK_TAG} strokes={TAG_STROKES} className="studio-ink-tag" />
        </div>
      </div>
    </>
  );
}
