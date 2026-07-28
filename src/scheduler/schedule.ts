import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TriageItem } from './sprintScan.js';

/**
 * LỊCH TỰ CHẠY của sprint-scan — "tri thức lịch" nằm TRONG con agent (không phải trong
 * launchd). launchd/cron chỉ là cái kích nền gọi `bow sprint-scan --tick` thường xuyên;
 * agent tự đọc config này để quyết "đã tới giờ chạy chưa". Nhờ tách vậy: đổi giờ chạy chỉ
 * cần sửa 1 file JSON (không phải nạp lại launchd), và agent giữ trạng thái lastRunAt để
 * không chạy trùng trong cùng một khung giờ.
 *
 * File: ~/.bow-agent/sprint-schedule.json (override BOW_SPRINT_SCHEDULE). Cạnh mcp.json /
 * qc-routing.json cho nhất quán, ngoài repo.
 */

export interface SprintSchedule {
  /** Bật/tắt lịch. false = --tick không làm gì (dừng mềm không cần gỡ launchd). */
  enabled: boolean;
  /** Project Jira quét. Rỗng = dùng BOW_PROJECT_KEY/JIRA_PROJECT_KEY. */
  projectKey?: string;
  /** Repo agent thao tác. Rỗng = BOW_CWD/cwd hiện tại. */
  cwd?: string;
  /**
   * Các mốc giờ trong ngày để chạy, dạng "HH:MM" 24h (giờ máy local). Ví dụ ["09:00","14:00"].
   * --tick chạy nếu thời điểm hiện tại đã qua một mốc mà mốc đó CHƯA chạy hôm nay.
   */
  atTimes: string[];
  /** Thứ trong tuần được phép chạy (0=CN..6=T7). Rỗng/thiếu = mọi ngày. */
  weekdays?: number[];
  /** dryRun=true (mặc định): chỉ đề xuất. false: tự fix/commit. */
  dryRun: boolean;
  /** Cho tự đổi assignee/transition sang QC (chỉ khi !dryRun). */
  allowAssign: boolean;
  /** JQL fragment lọc thêm. */
  extraJql?: string;
  /** Reasoning effort. Mặc định 'high'. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** ISO thời điểm chạy gần nhất (agent tự cập nhật) — chống chạy trùng trong cùng khung. */
  lastRunAt?: string;
}

/** Đường dẫn file lịch. Override BOW_SPRINT_SCHEDULE. */
export function schedulePath(): string {
  return process.env.BOW_SPRINT_SCHEDULE || join(homedir(), '.bow-agent', 'sprint-schedule.json');
}

/** Đường dẫn file lịch sử các lượt quét (cho dashboard). Cạnh file lịch. */
export function runHistoryPath(): string {
  return process.env.BOW_SPRINT_HISTORY || join(homedir(), '.bow-agent', 'sprint-runs.json');
}

/** Một lượt quét đã chạy — lưu để dashboard hiển thị "lần gần nhất + kết quả". */
export interface SprintRun {
  /** ISO thời điểm bắt đầu. */
  startedAt: string;
  /** Nguồn kích: 'schedule' (launchd tick) | 'manual' (nút web / CLI). */
  trigger: 'schedule' | 'manual';
  projectKey?: string;
  dryRun: boolean;
  /** Text tổng kết cuối của agent (bảng triage). Null nếu lỗi. */
  summary: string | null;
  /** Kết quả triage đã cấu trúc (tách từ block JSON cuối) — dashboard vẽ thẻ. Rỗng nếu không parse được. */
  triage?: TriageItem[];
  /** Chi phí USD (nếu runner báo). */
  costUsd?: number;
  /** Lỗi (nếu có). */
  error?: string;
  /** ISO thời điểm kết thúc. */
  endedAt?: string;
}

/** Đọc lịch sử (mới nhất trước). Trả [] nếu chưa có. */
export function loadRunHistory(): SprintRun[] {
  const file = runHistoryPath();
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as SprintRun[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Ghi thêm một lượt vào lịch sử (giữ tối đa 50 lượt gần nhất). */
export function appendRunHistory(run: SprintRun): void {
  const file = runHistoryPath();
  mkdirSync(dirname(file), { recursive: true });
  const history = [run, ...loadRunHistory()].slice(0, 50);
  writeFileSync(file, JSON.stringify(history, null, 2), 'utf8');
}

/** Đọc lịch. Trả null nếu chưa cấu hình (—tick sẽ báo "chưa có lịch"). */
export function loadSchedule(): SprintSchedule | null {
  const file = schedulePath();
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as SprintSchedule;
    if (!data || typeof data !== 'object' || !Array.isArray(data.atTimes)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Ghi lịch (tạo thư mục nếu cần). Dùng cho `schedule set` và cập nhật lastRunAt. */
export function saveSchedule(sched: SprintSchedule): void {
  const file = schedulePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(sched, null, 2), 'utf8');
}

/** Parse "HH:MM" → tổng phút trong ngày. Trả null nếu sai định dạng. */
function parseHHMM(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export interface DueDecision {
  /** Có nên chạy ngay bây giờ không. */
  due: boolean;
  /** Lý do (để log): mốc giờ khớp, hoặc vì sao bỏ qua. */
  reason: string;
}

/**
 * Quyết định "đã tới giờ chạy chưa" cho thời điểm `now`. Thuần (nhận now để test được).
 * Logic: đúng weekday cho phép + hiện tại đã QUA ít nhất một mốc atTimes + mốc gần nhất đã
 * qua đó KHÁC ngày/khung với lastRunAt (chống chạy trùng khi launchd tick mỗi vài phút).
 */
export function isDue(sched: SprintSchedule, now: Date): DueDecision {
  if (!sched.enabled) return { due: false, reason: 'lịch đang tắt (enabled=false)' };

  const dow = now.getDay();
  if (sched.weekdays && sched.weekdays.length > 0 && !sched.weekdays.includes(dow)) {
    // 0=CN..6=T7 → nhãn "CN/T2/…/T7" cho dễ đọc (getDay 2 = Thứ Ba, không phải "thứ 2").
    const VN = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    return { due: false, reason: `hôm nay (${VN[dow]}) không nằm trong weekdays` };
  }

  const nowMin = now.getHours() * 60 + now.getMinutes();
  // Các mốc đã qua trong hôm nay, lấy mốc MUỘN nhất đã qua.
  const passed = sched.atTimes
    .map(parseHHMM)
    .filter((v): v is number => v !== null)
    .filter((v) => v <= nowMin)
    .sort((a, b) => b - a);
  if (passed.length === 0) return { due: false, reason: 'chưa tới mốc giờ nào hôm nay' };

  const latestPassed = passed[0];
  // lastRunAt: nếu đã chạy hôm nay TẠI/ SAU mốc muộn nhất đã qua → đã xử lý khung này rồi.
  if (sched.lastRunAt) {
    const last = new Date(sched.lastRunAt);
    const sameDay =
      last.getFullYear() === now.getFullYear() &&
      last.getMonth() === now.getMonth() &&
      last.getDate() === now.getDate();
    if (sameDay) {
      const lastMin = last.getHours() * 60 + last.getMinutes();
      if (lastMin >= latestPassed) {
        return { due: false, reason: `đã chạy hôm nay lúc ${sched.lastRunAt} cho khung này` };
      }
    }
  }

  const hh = Math.floor(latestPassed / 60).toString().padStart(2, '0');
  const mm = (latestPassed % 60).toString().padStart(2, '0');
  return { due: true, reason: `tới khung ${hh}:${mm}` };
}
