import { useEffect, useRef, useState } from 'react';

/**
 * Dropdown pixel-art tự vẽ — thay cho <select> native (element mặc định của
 * trình duyệt hiện đen bóng + bo góc, không hợp phong cách 8-bit).
 * Danh sách mở ra là các ô vuông viền cứng, có LED nhấp nháy ở lựa chọn hiện tại.
 */
export interface PixelSelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: PixelSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  width?: number;
}

export function PixelSelect({ value, options, onChange, disabled, width }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Đóng khi click ra ngoài.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className="px-select" ref={ref} style={width ? { width } : undefined}>
      <button
        type="button"
        className="px-select-btn"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{current?.label ?? value}</span>
        <span className="px-select-caret">{open ? '▲' : '▼'}</span>
      </button>
      {open && !disabled && (
        <div className="px-select-menu">
          {options.map((o) => (
            <button
              type="button"
              key={o.value}
              className={`px-select-item${o.value === value ? ' selected' : ''}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="px-led" aria-hidden />
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
