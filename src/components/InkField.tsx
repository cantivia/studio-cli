/** Slow violet ink diffusing behind the glass, after Cantivia's AmbientBackground. */
export function InkField() {
  return (
    <div className="ink-field" aria-hidden>
      <div className="ink-blob" style={{ width: 520, height: 520, left: -160, top: -180, background: 'rgba(139, 92, 246, 0.22)' }} />
      <div
        className="ink-blob"
        style={{ width: 620, height: 560, right: -220, bottom: -260, background: 'rgba(109, 40, 217, 0.16)', animationDelay: '-9s' }}
      />
      <div
        className="ink-blob"
        style={{ width: 360, height: 360, left: '42%', top: '38%', background: 'rgba(196, 181, 253, 0.18)', animationDelay: '-17s' }}
      />
    </div>
  );
}
