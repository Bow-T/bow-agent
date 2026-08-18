/**
 * Điều phối các màn mở từ nav trái. Mỗi `section` → một panel; tất cả bọc trong PanelShell
 * để cùng một ngôn ngữ hình ảnh.
 *
 * Nguyên tắc: panel chỉ ĐỌC dữ liệu đã có (state per-tab do TaskPane báo lên, hoặc API sẵn
 * có của server). Không panel nào tự mở đường ghi vòng qua cổng duyệt trong runner.ts.
 */
import { PanelShell, PanelEmpty } from './PanelShell.js';
import { AgentsPanel } from './AgentsPanel.js';
import type { CollabApproval } from './ApprovalsPanel.js';
import { JiraPanel } from './JiraPanel.js';
import { ReposPanel } from './ReposPanel.js';
import { ActivityPanel } from './ActivityPanel.js';
import { ApprovalsPanel } from './ApprovalsPanel.js';
import { SettingsPanel } from './SettingsPanel.js';
import type { Cfg, SkillStatus } from '../App.js';
import type { AgentSummary, NavSection } from '../types.js';

export interface TaskRow {
  id: string;
  title: string;
  running: boolean;
  pendingCount: number;
  hasContent: boolean;
  active: boolean;
}

export interface NavSectionViewProps {
  section: Exclude<NavSection, 'workspace' | 'cosmos'>;
  language: 'vi' | 'en';
  cfg: Cfg | null;
  /** Đội agent của tab đang mở. */
  agents: AgentSummary[];
  useSubagents: boolean;
  setUseSubagents: (v: boolean) => void;
  /** Danh sách tab (tác vụ) + trạng thái — Approvals/Activity dựa vào để chỉ đường. */
  tasks: TaskRow[];
  /** Chuyển về khung chat (khi người dùng bấm vào một tác vụ cần xử lý). */
  onGoTask: (tabId: string) => void;
  /** Nạp một Jira key vào ô nhập của tab đang mở rồi về khung chat. */
  onUseJiraKey: (key: string) => void;
  /** Mở các modal cấu hình đã có sẵn ở App (MCP / workspace / usage / lịch sử). */
  onOpenModal: (id: 'mcp' | 'workspace' | 'usage' | 'history' | 'picker') => void;
  /** Đồng bộ skill (nút trong Settings) — dùng lại hàm của App. */
  syncSkillsNow: () => void;
  /** Yêu cầu chờ ADMIN duyệt từ xa (Collab/DevOps) — chỉ admin nhận được. */
  collabApprovals: CollabApproval[];
  onDecideCollab: (id: string, approved: boolean, apiOrigin?: string) => void;
  /** cwd của tab đang mở (màn Nguồn mã đọc worktree/workspace theo repo này). */
  cwd: string;
  /** Trạng thái bộ skill (badge synced/stale/missing ở màn Cài đặt). */
  skillStatus: SkillStatus | null;
}

export function NavSectionView(props: NavSectionViewProps) {
  const { section, language } = props;
  const vi = language === 'vi';

  switch (section) {
    case 'agents':
      return <AgentsPanel {...props} />;
    case 'approvals':
      return <ApprovalsPanel {...props} />;
    case 'jira':
      return <JiraPanel {...props} />;
    case 'repos':
      return <ReposPanel {...props} />;
    case 'activity':
      return <ActivityPanel {...props} />;
    case 'settings':
      return <SettingsPanel {...props} />;
    default:
      return (
        <PanelShell icon="info" title={vi ? 'Không có màn này' : 'Unknown section'}>
          <PanelEmpty text={vi ? 'Mục điều hướng không hợp lệ.' : 'Invalid navigation item.'} />
        </PanelShell>
      );
  }
}
