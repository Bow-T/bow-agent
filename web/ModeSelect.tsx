import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon.js';
import type { Mode } from './types.js';

/**
 * Bộ chọn CHẾ ĐỘ CHẠY dạng popover — lấy cảm hứng từ "Modes" của Claude Code
 * (Manual / Auto / Plan…), nhưng vẽ theo phong cách observatory/pixel của bow-agent.
 *
 * Mỗi mode có icon + tên + mô tả ngắn; mode đang chọn có dấu tick. Thêm/bớt mode =
 * sửa mảng MODES bên dưới (khớp type Mode ở types.ts và runner ở backend).
 */
interface ModeDef {
  value: Mode;
  label: string;
  icon: IconName;
  /** Nhãn cực ngắn hiện trên nút (khi popover đóng) và ở header readout. */
  short: string;
  desc: string;
}

export const MODES: ModeDef[] = [
  {
    value: 'plan',
    label: 'Kế hoạch',
    icon: 'book',
    short: 'PLAN',
    desc: 'Chỉ đọc & lập kế hoạch. Không sửa file, không chạy lệnh — an toàn nhất.',
  },
  {
    value: 'auto',
    label: 'Tự động',
    icon: 'routing',
    short: 'AUTO',
    desc: 'Tự chủ thực thi các thao tác an toàn; chỉ dừng hỏi trước thao tác rủi ro (xóa dữ liệu, git push, ghi ngoài repo…).',
  },
  {
    value: 'edit-auto',
    label: 'Sửa tự động',
    icon: 'magic',
    short: 'EDIT',
    desc: 'Tự sửa/ghi file trong repo không cần hỏi; nhưng chạy lệnh bash hay thao tác ngoài repo thì vẫn hỏi duyệt.',
  },
  {
    value: 'manual',
    label: 'Thủ công',
    icon: 'lock',
    short: 'MANUAL',
    desc: 'Hỏi duyệt trước MỌI thao tác thay đổi (sửa file, chạy lệnh). Kiểm soát chặt từng bước.',
  },
];

export function modeDef(value: Mode): ModeDef {
  return MODES.find((m) => m.value === value) ?? MODES[0];
}

interface Props {
  value: Mode;
  onChange: (mode: Mode) => void;
  disabled?: boolean;
}

export function ModeSelect({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = modeDef(value);

  // Đóng khi click ra ngoài hoặc nhấn Esc.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="mode-select" ref={ref}>
      <button
        type="button"
        className={`mode-select-btn mode-${current.value}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={current.desc}
      >
        <span className="mode-select-icon"><Icon name={current.icon} size={15} /></span>
        <span className="mode-select-label">{current.label}</span>
        <span className="mode-select-caret"><Icon name={open ? 'caretDown' : 'caretUp'} size={13} /></span>
      </button>

      {open && !disabled && (
        <div className="mode-menu" role="listbox" aria-label="Chế độ chạy">
          <div className="mode-menu-title">Chế độ chạy</div>
          {MODES.map((m) => {
            const active = m.value === value;
            return (
              <button
                type="button"
                key={m.value}
                role="option"
                aria-selected={active}
                className={`mode-menu-item mode-${m.value}${active ? ' active' : ''}`}
                onClick={() => {
                  onChange(m.value);
                  setOpen(false);
                }}
              >
                <span className="mode-menu-icon"><Icon name={m.icon} size={17} /></span>
                <span className="mode-menu-text">
                  <span className="mode-menu-name">
                    {m.label}
                    {active && <span className="mode-menu-check"><Icon name="success" size={13} /></span>}
                  </span>
                  <span className="mode-menu-desc">{m.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
