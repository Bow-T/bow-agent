/**
 * Khung chung cho các màn mở từ nav trái (Agents / Approvals / Jira / Repos / Activity /
 * Settings). Cùng một tiêu đề + vùng cuộn để mọi màn trông như một hệ, không mỗi màn một kiểu.
 *
 * Chỉ là VỎ — dữ liệu do từng panel tự lấy (đa số dùng API đã có sẵn của server).
 */
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../Icon.js';

interface PanelShellProps {
  icon: IconName;
  title: string;
  subtitle?: string;
  /** Nút hành động ở góc phải tiêu đề (Làm mới, Thêm…). */
  actions?: ReactNode;
  children: ReactNode;
}

export function PanelShell({ icon, title, subtitle, actions, children }: PanelShellProps) {
  return (
    <section className="section-panel">
      <div className="section-panel-head">
        <span className="section-panel-mark"><Icon name={icon} size={19} /></span>
        <div className="section-panel-titles">
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions && <div className="section-panel-actions">{actions}</div>}
      </div>
      <div className="section-panel-body">{children}</div>
    </section>
  );
}

/** Dòng trạng thái rỗng/lỗi dùng chung trong các panel. */
export function PanelEmpty({ text }: { text: string }) {
  return <div className="panel-empty">{text}</div>;
}
