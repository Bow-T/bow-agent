/**
 * Màn CÀI ĐẶT — gom các thứ trước đây rải rác ở header/modal về một chỗ.
 * Không nhân đôi logic: mỗi mục chỉ mở lại đúng modal/hàm đã có ở App.
 */
import { PanelShell } from './PanelShell.js';
import { Icon } from '../Icon.js';
import type { NavSectionViewProps } from './NavSectionView.js';

export function SettingsPanel({ language, cfg, skillStatus, onOpenModal, syncSkillsNow }: NavSectionViewProps) {
  const vi = language === 'vi';

  return (
    <PanelShell
      icon="tool"
      title={vi ? 'Cài đặt' : 'Settings'}
      subtitle={vi ? 'Kết nối, kỹ năng, hạn mức và dữ liệu phiên' : 'Connections, skills, quota and session data'}
    >
      <div className="settings-grid">
        <article className="settings-card">
          <h4><Icon name="mcp" size={15} /> MCP</h4>
          <p>{vi
            ? 'Các server MCP agent được phép gọi (Jira, Supabase…).'
            : 'MCP servers the agent may call (Jira, Supabase…).'}</p>
          <div className="settings-card-meta">
            {(cfg?.mcpServers ?? []).length > 0
              ? (cfg?.mcpServers ?? []).map((m) => <span key={m} className="repo-chip">{m}</span>)
              : <span className="repo-chip">{vi ? 'chưa chọn' : 'none selected'}</span>}
          </div>
          <button className="btn" onClick={() => onOpenModal('mcp')}>
            {cfg?.isAdmin ? (vi ? 'Quản lý MCP chung' : 'Manage shared MCP') : (vi ? 'MCP riêng của bạn' : 'Your own MCP')}
          </button>
        </article>

        <article className="settings-card">
          <h4><Icon name="magic" size={15} /> {vi ? 'Kỹ năng (skill)' : 'Skills'}</h4>
          <p>{vi
            ? 'Bộ skill tải từ GitHub và trải vào .claude/skills lúc chạy.'
            : 'Skill bundles fetched from GitHub and deployed into .claude/skills at runtime.'}</p>
          <div className="settings-card-meta">
            {skillStatus ? (
              <>
                <span className="repo-chip">core: {skillStatus.core.state}</span>
                {skillStatus.stack && <span className="repo-chip">{skillStatus.stack.label}: {skillStatus.stack.state}</span>}
              </>
            ) : (
              <span className="repo-chip">{vi ? 'chưa rõ' : 'unknown'}</span>
            )}
          </div>
          <button className="btn" onClick={syncSkillsNow}>{vi ? 'Đồng bộ ngay' : 'Sync now'}</button>
        </article>

        <article className="settings-card">
          <h4><Icon name="info" size={15} /> {vi ? 'Hạn mức' : 'Quota'}</h4>
          <p>{vi
            ? 'Hạn mức gói 5 giờ / 7 ngày và mức dùng context của tab đang mở.'
            : '5-hour / 7-day plan limits and context usage of the open tab.'}</p>
          <button className="btn" onClick={() => onOpenModal('usage')}>{vi ? 'Xem hạn mức' : 'View quota'}</button>
        </article>

        <article className="settings-card">
          <h4><Icon name="history" size={15} /> {vi ? 'Lịch sử hội thoại' : 'Conversation history'}</h4>
          <p>{vi ? 'Mở lại, đổi tên hoặc xoá các cuộc đã lưu.' : 'Reopen, rename or delete saved conversations.'}</p>
          <button className="btn" onClick={() => onOpenModal('history')}>{vi ? 'Mở lịch sử' : 'Open history'}</button>
        </article>

        <article className="settings-card">
          <h4><Icon name="lang" size={15} /> {vi ? 'Phiên hiện tại' : 'Current session'}</h4>
          <div className="settings-kv">
            <span>{vi ? 'Quyền' : 'Role'}</span><b>{cfg?.isAdmin ? 'Admin (localhost)' : (vi ? 'Khách LAN' : 'LAN guest')}</b>
            <span>{vi ? 'Thư mục' : 'Directory'}</span><b title={cfg?.defaultCwd}>{cfg?.repoName || cfg?.defaultCwd || '—'}</b>
            <span>{vi ? 'Tài khoản' : 'Account'}</span><b>{cfg?.currentClaudeProfile || 'default'}</b>
          </div>
        </article>

        {cfg?.isAdmin && (cfg.lanUrls ?? []).length > 0 && (
          <article className="settings-card">
            <h4><Icon name="users" size={15} /> {vi ? 'Địa chỉ chia sẻ LAN' : 'LAN share URLs'}</h4>
            <p>{vi ? 'Gửi cho đồng nghiệp để họ vào đúng cổng mode này.' : 'Send these to teammates to reach this mode.'}</p>
            <div className="settings-card-meta">
              {(cfg.lanUrls ?? []).map((u) => <code key={u} className="lan-url-code">{u}</code>)}
            </div>
          </article>
        )}
      </div>
    </PanelShell>
  );
}
