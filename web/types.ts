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

/** Sự kiện từ backend qua SSE — phải khớp WebEvent ở src/web/session.ts. */
export type WebEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; id?: string; name: string; describe: string; summary?: string }
  | { type: 'tool-result'; toolId: string; text: string; isError: boolean }
  | { type: 'result'; text: string; turns: number; outputTokens: number; costUsd: number }
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'error'; subtype: string }
  | {
      type: 'approval-request';
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      title?: string;
      description?: string;
      blockedPath?: string;
      decisionReason?: string;
    }
  | { type: 'question-request'; id: string; questions: Question[] }
  | { type: 'conversation'; conversationId: string }
  | { type: 'done'; result: string | null }
  | { type: 'fatal'; message: string };

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

/** Kết quả nhận diện source từ backend. */
export interface DetectedSource {
  profile: string;
  stack: string;
  empty: boolean;
  summary: string;
}
