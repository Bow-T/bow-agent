/**
 * Cột phải (296px) của một tác vụ — 3 khối theo mockup:
 *   1. HOẠT ĐỘNG AGENT  — dòng sự kiện rút gọn của phiên (thay Activity Log ở sidebar cũ).
 *   2. HÀNG CHỜ DUYỆT   — TOÀN BỘ thẻ đang chờ. Thẻ ĐẦU hàng vẫn ghim ở dock trên composer
 *      (nơi có đủ ngữ cảnh lệnh/diff) — cột này là chỗ nhìn toàn cảnh + bấm nhanh.
 *   3. TÁC VỤ GẦN ĐÂY   — các tab đang mở + trạng thái, bấm để nhảy sang.
 *
 * Không tự gọi API: mọi dữ liệu do TaskPane/App truyền xuống (đúng một nguồn sự thật).
 */
import { useState } from 'react';
import { Icon } from './Icon.js';
import type { ChatItem, PendingApproval, PendingQuestion, ToolDetail } from './types.js';

export interface RailTask {
  id: string;
  title: string;
  running: boolean;
  pendingCount: number;
  hasContent: boolean;
  active: boolean;
}

interface RightRailProps {
  language: 'vi' | 'en';
  /** Dòng sự kiện THÔ của phiên — cột này tự dựng feed từng thao tác (không gom nhóm). */
  items: ChatItem[];
  running: boolean;
  pending: PendingApproval[];
  questions: PendingQuestion[];
  onApprove: (p: PendingApproval, approved: boolean) => void;
  tasks: RailTask[];
  onGoTask: (id: string) => void;
  /** Cuộn khung chat tới thẻ duyệt đầu hàng (nơi có nút đầy đủ + ngữ cảnh). */
  onFocusDock: () => void;
}

/**
 * Nhãn hành động cho MỘT lần gọi tool: "Đọc file", "Tìm kiếm", "Chạy lệnh"…
 * Cột hoạt động cần đọc lướt được nên nhãn phải là ĐỘNG TỪ + đối tượng, không phải tên tool thô.
 */
function actionLabel(name: string, vi: boolean): string {
  if (name.startsWith('mcp__')) {
    const server = name.split('__')[1] ?? '';
    if (server.includes('jira')) return 'Jira';
    if (server.includes('supabase')) return vi ? 'Truy vấn DB' : 'Query DB';
    if (server.includes('codemagic')) return 'Codemagic';
    return 'MCP';
  }
  const MAP: Record<string, [string, string]> = {
    Read: ['Đọc file', 'Read file'],
    Grep: ['Tìm kiếm', 'Search'],
    Glob: ['Quét file', 'Glob files'],
    Bash: ['Chạy lệnh', 'Run command'],
    Edit: ['Sửa file', 'Edit file'],
    Write: ['Ghi file', 'Write file'],
    NotebookEdit: ['Sửa notebook', 'Edit notebook'],
    Agent: ['Agent phụ', 'Subagent'],
    Skill: ['Dùng skill', 'Use skill'],
    TodoWrite: ['Cập nhật kế hoạch', 'Update plan'],
    WebFetch: ['Tải trang', 'Fetch page'],
    WebSearch: ['Tìm trên web', 'Web search'],
    ToolSearch: ['Tìm công cụ', 'Find tool'],
    skills: ['Nạp skill', 'Load skills'],
    cache: ['Cache', 'Cache'],
  };
  const hit = MAP[name];
  return hit ? (vi ? hit[0] : hit[1]) : name;
}

/**
 * Rút gọn tham số cho vừa cột hẹp:
 *  - đường dẫn → tên file ("…/checkout/payment_service.dart" → "payment_service.dart");
 *  - lệnh shell → bỏ khúc `cd <path> &&` mở đầu (mọi lệnh đều có, không phân biệt được gì)
 *    rồi lấy lệnh CHÍNH, bỏ tiếp các cờ dài phía sau.
 */
function shortArg(tool: ToolDetail): string {
  let s = (tool.summary ?? '').trim();
  if (!s) return '';
  if (tool.name === 'Bash') {
    s = s.replace(/^cd\s+\S+\s*&&\s*/i, '');           // "cd /repo && npm test" → "npm test"
    s = s.split('\n')[0].replace(/\s+/g, ' ').trim();
  } else {
    const isPath = /[/\\]/.test(s) && !s.includes(' ');
    if (isPath) s = s.split(/[/\\]/).pop() ?? s;
  }
  return s.length > 42 ? s.slice(0, 41) + '…' : s;
}

/** Tool là thông báo hệ thống (nạp skill / cảnh báo cache) — không phải việc agent làm. */
function isSystemNotice(name: string): boolean {
  return name === 'skills' || name === 'cache';
}

/** Một dòng trong cột Hoạt động. */
interface FeedRow {
  id: string;
  /** Màu chấm — dùng lại §Step colors qua data-k. */
  kind: string;
  label: string;
  detail?: string;
  ts?: number;
  active?: boolean;
  /** Số lần thao tác y hệt lặp liền nhau (gom lại để cột không bị spam). */
  count?: number;
}

/** Giờ HH:MM:SS của một mốc; item cũ chưa có ts → chuỗi rỗng (không bịa giờ). */
function clock(ts?: number): string {
  return ts ? new Date(ts).toLocaleTimeString('vi-VN', { hour12: false }) : '';
}

/**
 * Dựng feed từng THAO TÁC (mỗi lần gọi tool = một dòng), thay vì các nhóm "Xử lý mã nguồn
 * (N thao tác)" của Activity Log cũ — cột này để liếc "agent vừa làm gì", nên phải cụ thể.
 * Bỏ qua các câu trả lời dài của agent (đã nằm trong khung chat).
 */
function buildFeed(items: ChatItem[], running: boolean, vi: boolean): FeedRow[] {
  const rows: FeedRow[] = [];
  const lastToolId = [...items].reverse().find((it) => it.kind === 'tool')?.id;
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trim() + '…' : s);

  for (const it of items) {
    if (it.kind === 'tool' && it.tool) {
      if (isSystemNotice(it.tool.name)) continue;   // nạp skill / cảnh báo cache: không phải việc agent
      const arg = shortArg(it.tool);
      rows.push({
        id: it.id,
        kind: it.tool.resultError ? 'error' : 'tool',
        label: arg ? `${actionLabel(it.tool.name, vi)}: ${arg}` : actionLabel(it.tool.name, vi),
        detail: [it.tool.summary, it.tool.result].filter(Boolean).join('\n→ '),
        ts: it.ts,
        // Tool cuối cùng chưa có kết quả trong lượt đang chạy = việc đang làm dở.
        active: running && it.id === lastToolId && !it.tool.result,
      });
    } else if (it.kind === 'user') {
      // Mốc mở đầu một lượt: kèm trích yêu cầu để phân biệt các lượt với nhau.
      const brief = clip(it.text.replace(/\s+/g, ' ').trim(), 34);
      rows.push({
        id: it.id,
        kind: 'start',
        label: brief ? `${vi ? 'Yêu cầu' : 'Request'}: ${brief}` : (vi ? 'Nhận yêu cầu' : 'Task received'),
        detail: it.text,
        ts: it.ts,
      });
    } else if (it.kind === 'result') {
      rows.push({ id: it.id, kind: 'result', label: vi ? 'Hoàn thành' : 'Done', detail: it.text, ts: it.ts });
    } else if (it.kind === 'error') {
      rows.push({
        id: it.id,
        kind: 'error',
        label: `${vi ? 'Lỗi' : 'Error'}: ${clip(it.text.replace(/\s+/g, ' ').trim(), 36)}`,
        detail: it.text,
        ts: it.ts,
      });
    }
  }

  // Gom các dòng GIỐNG HỆT nằm liền nhau (agent hay đọc/grep lặp) → "…  ×3".
  const merged: FeedRow[] = [];
  for (const r of rows) {
    const prev = merged[merged.length - 1];
    if (prev && prev.label === r.label && prev.kind === r.kind) {
      prev.count = (prev.count ?? 1) + 1;
      prev.ts = r.ts ?? prev.ts;                    // giữ mốc GẦN NHẤT của cụm
      prev.active = prev.active || r.active;
      continue;
    }
    merged.push({ ...r });
  }
  return merged;
}

/** Nhãn ngắn cho loại tool đang xin duyệt — quyết định màu viền trái của thẻ. */
function toolKind(p: PendingApproval): { k: string; vi: string; en: string } {
  const n = p.toolName.toLowerCase();
  if (n === 'bash') return { k: 'bash', vi: 'Chạy lệnh', en: 'Run command' };
  if (n === 'edit' || n === 'write' || n === 'notebookedit') return { k: 'edit', vi: 'Sửa file', en: 'Edit files' };
  if (n.includes('jira')) return { k: 'jira', vi: 'Jira', en: 'Jira' };
  if (n.includes('sql') || n.includes('supabase')) return { k: 'db', vi: 'Cơ sở dữ liệu', en: 'Database' };
  return { k: 'other', vi: p.toolName, en: p.toolName };
}

export function RightRail({
  language, items, running, pending, questions, onApprove, tasks, onGoTask, onFocusDock,
}: RightRailProps) {
  const vi = language === 'vi';
  const queue = pending.length + questions.length;
  /** Dòng đang mở chi tiết (tham số đầy đủ + kết quả rút gọn). */
  const [expanded, setExpanded] = useState<string | null>(null);
  // Hoạt động: mới nhất lên đầu, đủ dùng để liếc nhanh (chi tiết đầy đủ ở khung chat).
  const activity = buildFeed(items, running, vi).reverse().slice(0, 60);

  return (
    <aside className="right-rail" aria-label={vi ? 'Bảng theo dõi tác vụ' : 'Task monitor'}>
      <section className="rr-sec">
        <h3>{vi ? 'Hoạt động agent' : 'Agent activity'}</h3>
        {activity.length === 0 ? (
          <p className="rr-empty">{vi ? 'Chưa có hoạt động nào.' : 'No activity yet.'}</p>
        ) : (
          <div className="rr-acts">
            {activity.map((row) => {
              const open = expanded === row.id;
              return (
                <div key={row.id} className="rr-act-wrap">
                  <button
                    type="button"
                    className={`rr-act${row.active ? ' on' : ''}${row.detail ? ' has-ops' : ''}`}
                    data-k={row.kind}
                    title={row.detail}
                    onClick={() => row.detail && setExpanded(open ? null : row.id)}
                  >
                    <s />
                    {/* Chỉ hiện giờ khi item có mốc thật — hội thoại cũ (trước khi lưu ts)
                        không chừa ô trống lệch hàng. */}
                    {row.ts != null && <time>{clock(row.ts)}</time>}
                    <span className="rr-act-label">{row.label}</span>
                    {row.count && row.count > 1 && <em>×{row.count}</em>}
                  </button>
                  {/* Chi tiết một thao tác: tham số đầy đủ + kết quả rút gọn. */}
                  {open && row.detail && <div className="rr-ops"><pre>{row.detail}</pre></div>}
                </div>
              );
            })}
          </div>
        )}
        {running && (
          <div className="rr-running">
            <span className="thinking-dots"><i /><i /><i /></span>
            {vi ? 'Agent đang làm việc' : 'Agent working'}
          </div>
        )}
      </section>

      <section className="rr-sec">
        <h3>
          {vi ? 'Hàng chờ duyệt' : 'Approval queue'}
          {queue > 0 && <span className="rr-badge">{queue}</span>}
        </h3>
        {queue === 0 ? (
          <p className="rr-empty">{vi ? 'Không có gì chờ duyệt.' : 'Nothing pending.'}</p>
        ) : (
          <div className="rr-apvs">
            {pending.map((p, i) => {
              const kind = toolKind(p);
              return (
                <div key={p.id} className="rr-apv" data-k={kind.k}>
                  <div className="rr-apv-head">
                    <i><Icon name={kind.k === 'bash' ? 'tool' : kind.k === 'edit' ? 'rename' : 'block'} size={11} /></i>
                    <b>{vi ? kind.vi : kind.en}</b>
                    {p.risky && <em className="rr-apv-risky">{vi ? 'rủi ro' : 'risky'}</em>}
                  </div>
                  <p title={p.description || p.title}>{p.title || p.description || p.toolName}</p>
                  {i === 0 ? (
                    <div className="rr-apv-actions">
                      <button className="btn deny" onClick={() => onApprove(p, false)}>{vi ? 'Từ chối' : 'Deny'}</button>
                      <button className="btn allow" onClick={() => onApprove(p, true)}>{vi ? 'Cho phép' : 'Approve'}</button>
                    </div>
                  ) : (
                    <button type="button" className="rr-apv-more" onClick={onFocusDock}>
                      {vi ? 'Đang xếp hàng' : 'Queued'} <Icon name="caretRight" size={11} />
                    </button>
                  )}
                </div>
              );
            })}
            {questions.map((q) => (
              <div key={q.id} className="rr-apv" data-k="ask">
                <div className="rr-apv-head">
                  <i><Icon name="info" size={11} /></i>
                  <b>{vi ? 'Agent hỏi' : 'Agent asks'}</b>
                </div>
                <p>{q.questions[0]?.question ?? ''}</p>
                <button type="button" className="rr-apv-more" onClick={onFocusDock}>
                  {vi ? 'Trả lời ở khung chat' : 'Answer in chat'} <Icon name="caretRight" size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rr-sec">
        <h3>{vi ? 'Tác vụ gần đây' : 'Recent tasks'}</h3>
        <div className="rr-tasks">
          {tasks.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`rr-task${t.active ? ' on' : ''}`}
              onClick={() => onGoTask(t.id)}
            >
              <s className={t.pendingCount > 0 ? 'warn' : t.running ? 'live' : ''} />
              <span className="rr-task-title">{t.title}</span>
              <span className={`rr-task-state${t.pendingCount > 0 ? ' warn' : t.running ? ' run' : t.hasContent ? ' done' : ''}`}>
                {t.pendingCount > 0
                  ? (vi ? 'CHỜ DUYỆT' : 'PENDING')
                  : t.running ? (vi ? 'ĐANG CHẠY' : 'RUNNING')
                  : t.hasContent ? (vi ? 'XONG' : 'DONE') : (vi ? 'TRỐNG' : 'EMPTY')}
              </span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
