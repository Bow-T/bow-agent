import { useEffect, useRef, useState } from 'react';

/**
 * Bộ chọn MÀU NHẤN ở header — nút hình chấm màu, bấm mở popover 7 swatch.
 * Chỉ đổi màu nhấn (brass → hồng/lam/…); nền sáng/tối do nút mặt trăng/mặt trời lo.
 * Vẽ theo phong cách "bảng điều khiển" của header: ô vuông viền cứng, không bo tròn mềm.
 */
export interface AccentOption {
  id: string;
  label: string;
  swatch: string;
}

interface Props {
  value: string;
  options: AccentOption[];
  onChange: (id: string) => void;
}

export function AccentPicker({ value, options, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Đóng khi bấm ra ngoài.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const current = options.find((o) => o.id === value) ?? options[0];

  return (
    <div className="accent-picker" ref={ref}>
      <button
        type="button"
        className="theme-btn accent-btn"
        title={`Màu nhấn: ${current?.label ?? ''}`}
        aria-label="Chọn màu nhấn"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="accent-dot" style={{ background: current?.swatch }} aria-hidden />
      </button>
      {open && (
        <div className="accent-menu">
          <div className="accent-menu-title">Màu nhấn</div>
          <div className="accent-swatches">
            {options.map((o) => (
              <button
                type="button"
                key={o.id}
                className={`accent-swatch${o.id === value ? ' selected' : ''}`}
                title={o.label}
                aria-label={o.label}
                aria-pressed={o.id === value}
                style={{ background: o.swatch }}
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
