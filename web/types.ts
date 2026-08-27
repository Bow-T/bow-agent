/** Một lựa chọn của câu hỏi AskUserQuestion. */
export interface QuestionOption {
  label: string;
  description: string;
}

/** Một câu hỏi agent gửi qua tool AskUserQuestion. */
export interface Question {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

/** Một cửa sổ hạn mức (5h / 7 ngày / theo model) — khớp UsageWindow ở runner.ts. */
export interface UsageWindow {
  label: string;
  utilization: number | null;
  resetsAt: string | null;
}

/** Snapshot /usage: hạn mức gói + độ dùng context window — khớp UsageSnapshot ở runner.ts. */
export interface UsageSnapshot {
  rateLimits: UsageWindow[];
  subscriptionType: string | null;
  contextTokens: number | null;
  contextMaxTokens: number | null;
  contextPercentage: number | null;
}

/** Tổng token đã tiêu — khớp TokenTotals ở src/core/tokenUsage.ts. */
export interface TokenTotals {
  calls: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
}

/**
 * Báo cáo token của MỘT AI (đếm từ transcript) — khớp TokenUsageReport ở
 * src/core/tokenUsage.ts. UI dùng cho provider ngoài (Grok), nơi không có hạn mức gói.
 */
export interface TokenUsageReport {
  provider: string;
  totals: TokenTotals;
  byModel: Array<{ model: string } & TokenTotals>;
  byDay: Array<{ day: string } & TokenTotals>;
  today: TokenTotals;
  firstDay: string | null;
  lastDay: string | null;
  scannedFiles: number;
  freshFiles: number;
  scanMs: number;
}

/** Sự kiện từ backend qua SSE — phải khớp WebEvent ở src/web/session.ts. */
export type WebEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; id?: string; name: string; describe: string; summary?: string }
  | { type: 'tool-result'; toolId: string; text: string; isError: boolean }
  | {
      type: 'result';
      text: string;
      turns: number;
      outputTokens: number;
      inputFresh: number;
      cacheRead: number;
      cacheCreation: number;
      costUsd: number;
      durationMs: number;
    }
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'error'; subtype: string; isSessionLimit?: boolean; resetsAt?: string | null; hint?: string; isContextOverflow?: boolean }
  | {
      // Server đã lên lịch tự chạy tiếp sau khi hết hạn mức phiên (5h).
      type: 'auto-resume-scheduled';
      resetsAt: string | null;
      retryAt: string;
      attempt: number;
      maxAttempts: number;
    }
  | { type: 'auto-resume-cancelled'; reason: 'user' | 'exhausted' | 'done' }
  | {
      type: 'approval-request';
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      title?: string;
      description?: string;
      blockedPath?: string;
      decisionReason?: string;
      /** True nếu thao tác RỦI RO (rm -rf/push/MCP ghi DB…) — toggle Auto-approve KHÔNG
       *  tự duyệt nhóm này, vẫn hiện popup hỏi (phanh cứng). */
      risky?: boolean;
    }
  | { type: 'question-request'; id: string; questions: Question[] }
  | { type: 'conversation'; conversationId: string }
  | { type: 'user-input'; text: string }
  | { type: 'done'; result: string | null }
  // `contextOverflow` = phiên chết vì tràn context window → tab tự dọn conversationId và
  // bật cờ gửi kèm tóm tắt, người dùng gõ tiếp là chạy được ngay (không phải mở tab mới).
  | { type: 'fatal'; message: string; contextOverflow?: boolean };

/** Chi tiết một lần gọi tool — để hiển thị "đã làm gì cụ thể" khi mở rộng Activity Log. */
export interface ToolDetail {
  /** tool_use id — khớp với tool-result. */
  toolId?: string;
  /** Tên tool thô (Bash, Read, Grep, mcp__...). */
  name: string;
  /** Tham số cốt lõi đã rút gọn (command/file/pattern). */
  summary?: string;
  /** Kết quả tool đã rút gọn (điền khi tool-result về). */
  result?: string;
  /** Kết quả là lỗi. */
  resultError?: boolean;
}

/** Một dòng trong khung chat. */
export interface ChatItem {
  id: string;
  kind: 'user' | 'agent' | 'tool' | 'result' | 'error' | 'system';
  text: string;
  /** Chỉ với kind==='tool': chi tiết cấu trúc để mở rộng ở Activity Log. */
  tool?: ToolDetail;
  /** Mốc thời gian tạo (ms). Cột "Hoạt động agent" hiện giờ HH:MM:SS. Item cũ lưu
   *  trước khi có trường này thì không có giờ — hiển thị bỏ trống, KHÔNG bịa. */
  ts?: number;
}

/** Yêu cầu duyệt đang chờ người dùng bấm nút. */
export interface PendingApproval {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  blockedPath?: string;
  decisionReason?: string;
  /** True nếu thao tác RỦI RO — toggle Auto-approve bỏ qua (vẫn hỏi người). */
  risky?: boolean;
}

/** Câu hỏi (AskUserQuestion) đang chờ người dùng chọn. */
export interface PendingQuestion {
  id: string;
  questions: Question[];
}

export type Mode = 'plan' | 'manual' | 'edit-auto' | 'auto';

/** Tài liệu đã đọc để đính kèm (upload). */
export interface DocAttachment {
  name: string;
  content: string;
}

/** Ảnh đã đọc để đính kèm (base64 + mediaType). */
export interface ImageAttachment {
  name: string;
  base64: string;
  mediaType: string;
}

/** Tóm tắt một cuộc trò chuyện (cho danh sách lịch sử — không kèm items). */
export interface ConversationSummary {
  id: string;
  title: string;
  cwd: string;
  /** Cửa sổ chat (tab tác vụ) đã tạo cuộc — tab Lịch sử lọc theo field này. */
  tabId?: string;
  itemCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Một cuộc trò chuyện đầy đủ (khi mở lại — kèm items + conversationId). */
export interface ConversationFull extends ConversationSummary {
  conversationId: string | null;
  items: ChatItem[];
}

/**
 * Một "sao" trong đội agent (SOL/VEGA/ORION/LYRA — xem buildAgentNodes ở TaskPane).
 * TaskPane báo lên App để nav trái vẽ Cosmos map mini và màn AGENTS đọc trạng thái thật.
 */
export interface AgentSummary {
  id: string;
  /** Mã thiên văn hiển thị (SOL, VEGA, ORION, LYRA…). */
  label: string;
  /** Vai trò đã dịch (Điều phối / Rà soát / Kiểm thử / Khảo sát). */
  role?: string;
  /** Loại bước — quyết định màu chấm (§Step colors trong styles.css). */
  type: string;
  active: boolean;
}

/** Mục điều hướng ở nav trái (mỗi mục = một màn trong vùng làm việc). */
export type NavSection =
  | 'workspace'
  | 'agents'
  | 'approvals'
  | 'jira'
  | 'repos'
  | 'cosmos'
  | 'activity'
  | 'settings';

/** Kết quả nhận diện source từ backend. */
export interface DetectedSource {
  profile: string;
  stack: string;
  empty: boolean;
  summary: string;
  /** Số ký tự kiến thức profile sẽ nhồi vào agent (chỉ có khi khớp profile đã sinh). */
  profileChars?: number;
}
