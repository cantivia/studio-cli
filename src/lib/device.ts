import { useSyncExternalStore } from 'react';

const phoneQuery = matchMedia('(max-width: 767px)');
const touchQuery = matchMedia('(pointer: coarse)');

const watch = (q: MediaQueryList) => (fn: () => void) => {
  q.addEventListener('change', fn);
  return () => q.removeEventListener('change', fn);
};
const watchPhone = watch(phoneQuery);
const watchTouch = watch(touchQuery);

/** Phone-sized screen: one pane at a time, sidebar as a drawer. */
export const useIsPhone = () => useSyncExternalStore(watchPhone, () => phoneQuery.matches);
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
  const fit = () => {
    document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
    if (window.scrollY) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}
