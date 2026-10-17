import { accentRgb } from '../lib/appTheme';
import { useStore } from '../lib/store';
import { termThemeDef } from '../lib/termThemes';

/** A soft glow instead of a blurred, morphing shape: same look, but it is drawn once (blurring and animating big layers behind glass redraws them every frame and made Studio laggy). */
const glow = (rgb: string, a: number) => `radial-gradient(closest-side, rgba(${rgb}, ${a * 1.7}), rgba(${rgb}, ${a * 0.55}) 55%, rgba(${rgb}, 0))`;

/** Violet ink behind the glass, after Cantivia's AmbientBackground. Other colour schemes tint it with their accent. */
export function InkField() {
  const theme = useStore((s) => s.terminalTheme);
  const paper = termThemeDef(theme).id === 'paper';
  const acc = accentRgb(theme);
  return (
    <div className="ink-field" aria-hidden>
      <div className="ink-blob" style={{ width: 520, height: 520, left: -160, top: -180, background: glow(paper ? '139, 92, 246' : acc, 0.22) }} />
      <div
        className="ink-blob"
        style={{ width: 620, height: 560, right: -220, bottom: -260, background: glow(paper ? '109, 40, 217' : acc, 0.16) }}
      />
      <div
        className="ink-blob"
        style={{ width: 360, height: 360, left: '42%', top: '38%', background: glow(paper ? '196, 181, 253' : acc, paper ? 0.18 : 0.1) }}
      />
    </div>
  );
}
