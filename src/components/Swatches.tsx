import { Check } from 'lucide-react';
import { PALETTE } from '../lib/colors';

export function Swatches({ value, onChange, size = 20 }: { value?: string; onChange: (id: string) => void; size?: number }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {PALETTE.map((h) => (
        <button
          key={h.id}
          type="button"
          title={h.name}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onChange(h.id);
          }}
          className="grid place-items-center rounded-full transition-transform hover:scale-110"
          style={{ width: size, height: size, background: h.glow, boxShadow: value === h.id ? `0 0 0 2px #fff, 0 0 0 4px ${h.glow}` : undefined }}
        >
          {value === h.id && <Check size={size * 0.55} strokeWidth={3} color="#fff" />}
        </button>
      ))}
    </div>
  );
}
