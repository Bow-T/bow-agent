import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';

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
  /** Hướng bung menu: 'up' (mặc định — hợp composer ở đáy) hoặc 'down' (hợp header trên cùng). */
  direction?: 'up' | 'down';
  onDelete?: (value: string) => void;
}

export function PixelSelect({ value, options, onChange, disabled, width, direction = 'up', onDelete }: Props) {
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
        <span className="px-select-caret"><Icon name={open ? 'caretUp' : 'caretDown'} size={13} /></span>
      </button>
      {open && !disabled && (
        <div className={`px-select-menu ${direction}`}>
          {options.map((o) => (
            <div key={o.value} className="px-select-item-container">
              <button
                type="button"
                className={`px-select-item${o.value === value ? ' selected' : ''}`}
                style={{ flex: 1, textAlign: 'left', paddingRight: 0 }}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span className="px-led" aria-hidden />
                {o.label}
              </button>
              {onDelete && o.value !== 'default' && o.value !== '__new__' && (
                <button
                  type="button"
                  className="px-select-delete-btn"
                  title="Xóa tài khoản này"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(o.value);
                    setOpen(false);
                  }}
                >
                  <Icon name="close" size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
