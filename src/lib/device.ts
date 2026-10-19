import { useSyncExternalStore } from 'react';

const phoneQuery = matchMedia('(max-width: 767px)');
// iPad portrait has enough room for a generous single workspace pane, but not for
// the desktop rail plus a useful split-terminal grid.
const compactQuery = matchMedia('(max-width: 1199px)');
const touchQuery = matchMedia('(pointer: coarse)');

const watch = (q: MediaQueryList) => (fn: () => void) => {
  q.addEventListener('change', fn);
  return () => q.removeEventListener('change', fn);
};
const watchPhone = watch(phoneQuery);
const watchCompact = watch(compactQuery);
const watchTouch = watch(touchQuery);

/** Phone-sized screen: one pane at a time, sidebar as a drawer. */
export const useIsPhone = () => useSyncExternalStore(watchPhone, () => phoneQuery.matches);
/** Phone and tablet widths use the focused-pane workspace layout and drawer navigation. */
export const useIsCompact = () => useSyncExternalStore(watchCompact, () => compactQuery.matches);
/** Finger instead of mouse (iPhone, iPad without a trackpad): show the extra key row. */
export const useIsTouch = () => useSyncExternalStore(watchTouch, () => touchQuery.matches);
export const isPhone = () => phoneQuery.matches;

/**
 * iOS keeps the page full height when the on-screen keyboard opens and scrolls it instead,
 * which pushes the terminal's prompt under the keyboard. Size the app to what's visible.
 */
export function fitToVisibleViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  let frame = 0;
  const fit = () => {
    // Safari can report a temporary offset while the keyboard is animating. Keeping
    // the visible top edge in the height prevents the terminal from jumping below it.
    document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height + vv.offsetTop)}px`);
    if (window.scrollY) window.scrollTo(0, 0);
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fit);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  fit();
}
