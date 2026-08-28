/**
 * Nav trái (196px) — điều hướng cấp app theo mockup "BOW OBSERVATORY". Màu bám ĐÚNG token
 * theme của web (--nav-* đều trỏ vào --surface/--ink/--brass), không có bảng màu riêng.
 *
 * Gồm 3 khối:
 *   1. 8 mục điều hướng (WORKSPACE … SETTINGS). Mỗi mục = một màn trong vùng làm việc;
 *      COSMOS không phải màn mà là hành động mở overlay vũ trụ của tab đang mở.
 *   2. COSMOS MAP mini — 4 "sao" của đội agent (SOL/VEGA/ORION/LYRA) do TaskPane báo lên
 *      qua onStateChange; chấm sáng = agent đang hoạt động THẬT (không phải trang trí).
 *      Màu chấm đọc §Step colors trong styles.css qua data-k, cùng nguồn với canvas galaxy.
 *   3. SYSTEM STATUS — trạng thái chạy + mode đang mở.
 *
 * Mục nào hiện: lọc theo mode chia sẻ (QC/BA/Reviewer/DevOps không thấy mục quản trị) —
 * chỉ là lớp ẩn UI, server vẫn cưỡng chế quyền riêng (xem canUseTool + requireAdmin).
 */
import { Icon, type IconName } from './Icon.js';
import type { AgentSummary, NavSection } from './types.js';
import type { Cfg } from './App.js';

interface NavItemDef {
  id: NavSection;
  icon: IconName;
  vi: string;
  en: string;
  /** Chỉ admin thấy (mục quản trị / cấu hình hệ thống). */
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItemDef[] = [
  { id: 'workspace', icon: 'sidebar', vi: 'Không gian', en: 'Workspace' },
  { id: 'agents', icon: 'agent', vi: 'Đội agent', en: 'Agents' },
  { id: 'approvals', icon: 'block', vi: 'Chờ duyệt', en: 'Approvals' },
  { id: 'jira', icon: 'target', vi: 'Jira', en: 'Jira' },
  { id: 'repos', icon: 'folder', vi: 'Nguồn mã', en: 'Repos', adminOnly: true },
  { id: 'cosmos', icon: 'starChart', vi: 'Cosmos', en: 'Cosmos' },
  { id: 'map', icon: 'target', vi: 'Bản đồ', en: 'Map' },
  { id: 'activity', icon: 'activityLog', vi: 'Hoạt động', en: 'Activity' },
  { id: 'settings', icon: 'tool', vi: 'Cài đặt', en: 'Settings' },
];

/** Vị trí 4 sao trong ô radar (%) — bố cục lấy từ mockup, đủ thưa để nhãn không đè nhau. */
const STAR_SPOTS: Record<string, { top: string; left: string }> = {
  main: { top: '50%', left: '50%' },
  reviewer: { top: '76%', left: '73%' },
  verifier: { top: '40%', left: '22%' },
  'impact-scout': { top: '16%', left: '48%' },
};

interface AppNavProps {
  active: NavSection;
  onSelect: (s: NavSection) => void;
  language: 'vi' | 'en';
  cfg: Cfg | null;
  /** Tổng thẻ chờ duyệt của MỌI tab — badge đỏ ở mục Chờ duyệt. */
  pendingCount: number;
  /** Có tab nào đang chạy không (đèn System status). */
  running: boolean;
  /** Đội agent của tab đang mở (Cosmos map mini). */
  agents: AgentSummary[];
  /** Nhãn mode đang chạy (Dev/QC/Collab/BA/Reviewer/DevOps) cho System status. */
  modeLabel: string;
  /** Mở overlay Cosmos toàn màn hình của tab đang mở. */
  onOpenCosmos: () => void;
  /** Mobile: nav là drawer trượt từ trái — cờ này mở nó (desktop bỏ qua, CSS luôn hiện). */
  mobileOpen?: boolean;
  /** Mobile: đóng drawer (nút ✕ trong nav; backdrop do App xử lý). */
  onCloseMobile?: () => void;
}

export function AppNav({
  active, onSelect, language, cfg, pendingCount, running, agents, modeLabel, onOpenCosmos,
  mobileOpen = false, onCloseMobile,
}: AppNavProps) {
  const vi = language === 'vi';
  const isAdmin = !!cfg?.isAdmin;
  const items = NAV_ITEMS.filter((it) => !it.adminOnly || isAdmin);
  // 4 sao chuẩn luôn hiện đúng thứ tự; subagent lạ (nếu có) nối đuôi ở phần chú giải.
  const stars = agents.length > 0 ? agents : [];

  return (
    <nav
      className={`app-nav${mobileOpen ? ' open' : ''}`}
      aria-label={vi ? 'Điều hướng chính' : 'Main navigation'}
    >
      {/* Chỉ hiện ở mobile (CSS) — drawer che gần hết màn nên phải có lối đóng rõ ràng. */}
      <button
        type="button"
        className="nav-close"
        onClick={onCloseMobile}
        title={vi ? 'Đóng menu' : 'Close menu'}
        aria-label={vi ? 'Đóng menu' : 'Close menu'}
      >
        <Icon name="close" size={16} />
      </button>
      <div className="app-nav-items" role="tablist">
        {items.map((it) => {
          const label = vi ? it.vi : it.en;
          const isCosmos = it.id === 'cosmos';
          return (
            <button
              key={it.id}
              type="button"
              role="tab"
              aria-selected={!isCosmos && active === it.id}
              className={`nv${!isCosmos && active === it.id ? ' on' : ''}`}
              onClick={() => (isCosmos ? onOpenCosmos() : onSelect(it.id))}
              title={label}
            >
              <i className="nv-ico"><Icon name={it.icon} size={15} /></i>
              <span className="nv-lbl">{label}</span>
              {it.id === 'approvals' && pendingCount > 0 && <b className="nv-badge">{pendingCount}</b>}
            </button>
          );
        })}
      </div>

      {/* COSMOS MAP — bản đồ đội agent thu nhỏ; ⤢ mở vũ trụ đầy đủ của tab đang mở. */}
      <div className="nav-map">
        <div className="nav-map-head">
          <span>{vi ? 'BẢN ĐỒ COSMOS' : 'COSMOS MAP'}</span>
          <button
            type="button"
            className="nav-map-expand"
            onClick={onOpenCosmos}
            title={vi ? 'Mở vũ trụ Cosmos toàn màn hình' : 'Open full Cosmos universe'}
            aria-label={vi ? 'Mở Cosmos' : 'Open Cosmos'}
          >
            <Icon name="expand" size={11} />
          </button>
        </div>
        <div className={`nav-radar${running ? ' live' : ''}`}>
          {stars.map((a) => {
            const spot = STAR_SPOTS[a.id];
            if (!spot) return null; // subagent lạ chỉ hiện ở chú giải, không chen vào radar
            return (
              <i
                key={a.id}
                className={`nav-star${a.active ? ' on' : ''}`}
                data-k={a.type}
                style={{ top: spot.top, left: spot.left }}
                title={`${a.label}${a.role ? ` · ${a.role}` : ''}`}
              >
                {a.label}
              </i>
            );
          })}
        </div>
        <div className="nav-legend">
          {stars.map((a) => (
            <div key={a.id} className={`nav-legend-item${a.active ? ' on' : ''}`} data-k={a.type}>
              <s />
              <b>{a.label}</b>
              <em>{a.role || ''}</em>
            </div>
          ))}
        </div>
      </div>

      {/* SYSTEM STATUS — trạng thái thật, không phải nhãn tĩnh. */}
      <div className="nav-status">
        <h4>{vi ? 'TRẠNG THÁI' : 'SYSTEM STATUS'}</h4>
        <p><s /> {vi ? 'Chế độ' : 'Mode'}: {modeLabel}</p>
        <p><s className={running ? 'live' : ''} /> {running ? (vi ? 'Agent đang chạy' : 'Agent running') : (vi ? 'Agent rảnh' : 'Agent idle')}</p>
        {pendingCount > 0 && (
          <p><s className="warn" /> {vi ? `${pendingCount} việc chờ duyệt` : `${pendingCount} pending approval(s)`}</p>
        )}
      </div>
    </nav>
  );
}
