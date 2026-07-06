/** Sự kiện từ backend qua SSE — phải khớp WebEvent ở src/web/session.ts. */
export type WebEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; describe: string }
  | { type: 'result'; text: string; turns: number; outputTokens: number; costUsd: number }
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
  | { type: 'done'; result: string | null }
  | { type: 'fatal'; message: string };

/** Một dòng trong khung chat. */
export interface ChatItem {
  id: string;
  kind: 'user' | 'agent' | 'tool' | 'result' | 'error' | 'system';
  text: string;
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

export type Mode = 'plan' | 'execute';

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
