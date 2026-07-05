import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../core/runner.js';

/**
 * Một phiên chạy agent trên web. Giữ hàng đợi sự kiện để đẩy qua SSE, và các
 * Promise duyệt đang treo (chờ người dùng bấm nút Cho phép/Từ chối trên UI).
 */

/** Sự kiện gửi tới UI qua SSE — bao gồm sự kiện agent + yêu cầu duyệt + kết thúc. */
export type WebEvent =
  | AgentEvent
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

interface PendingApproval {
  resolve: (approved: boolean) => void;
}

export class Session {
  readonly id = randomUUID();

  /** Lịch sử các sự kiện đã xảy ra trong phiên. */
  private history: WebEvent[] = [];
  /** Các consumer SSE đang kết nối. */
  private subscribers = new Set<(event: WebEvent) => void>();
  /** Các yêu cầu duyệt đang treo, keyed theo id. */
  private pending = new Map<string, PendingApproval>();
  /** Hủy agent giữa chừng. */
  readonly abort = new AbortController();
  private closed = false;
  /** Timer ngắt kết nối tạm thời (reload trang). */
  private disconnectTimer: NodeJS.Timeout | null = null;

  /** Đẩy một sự kiện vào lịch sử và phát tới tất cả subscriber. */
  push(event: WebEvent): void {
    this.history.push(event);
    this.subscribers.forEach((sub) => sub(event));
  }

  /** Async iterator các sự kiện — dùng cho SSE. Hỗ trợ phát lại lịch sử. */
  async *events(): AsyncGenerator<WebEvent> {
    // 1. Phát lại tất cả sự kiện cũ từ lịch sử trước
    for (const ev of this.history) {
      yield ev;
    }

    if (this.closed) return;

    // 2. Đăng ký nhận sự kiện mới trực tiếp
    const localQueue: WebEvent[] = [];
    let resolveWaker: (() => void) | null = null;

    const listener = (event: WebEvent) => {
      localQueue.push(event);
      resolveWaker?.();
    };

    this.subscribers.add(listener);

    try {
      while (!this.closed || localQueue.length > 0) {
        if (localQueue.length === 0) {
          await new Promise<void>((r) => {
            resolveWaker = r;
          });
          resolveWaker = null;
          continue;
        }
        yield localQueue.shift() as WebEvent;
      }
    } finally {
      this.subscribers.delete(listener);
    }
  }

  onClientConnect(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  onClientDisconnect(cleanup: () => void): void {
    if (this.closed) {
      // Phiên đã xong/lỗi, dọn dẹp ngay
      cleanup();
      return;
    }
    // Chờ 30 giây phòng khi người dùng reload trang để reconnect
    this.disconnectTimer = setTimeout(() => {
      if (this.subscribers.size === 0) {
        cleanup();
      }
    }, 30_000);
  }

  /**
   * Tạo một yêu cầu duyệt: đẩy 'approval-request' lên UI rồi treo Promise chờ
   * người dùng gọi resolveApproval(id, approved).
   */
  requestApproval(
    toolName: string,
    input: Record<string, unknown>,
    meta?: {
      title?: string;
      description?: string;
      blockedPath?: string;
      decisionReason?: string;
    },
  ): Promise<boolean> {
    const id = randomUUID();
    return new Promise<boolean>((resolve) => {
      this.pending.set(id, { resolve });
      this.push({
        type: 'approval-request',
        id,
        toolName,
        input,
        title: meta?.title,
        description: meta?.description,
        blockedPath: meta?.blockedPath,
        decisionReason: meta?.decisionReason,
      });
    });
  }

  /** Người dùng bấm nút → giải Promise treo tương ứng. Trả false nếu id lạ. */
  resolveApproval(id: string, approved: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(approved);
    return true;
  }

  /** Đóng phiên: từ chối mọi approval còn treo, dừng iterator. */
  close(): void {
    this.closed = true;
    for (const [, p] of this.pending) p.resolve(false);
    this.pending.clear();
    this.subscribers.forEach((sub) => {
      // Đẩy tín hiệu kết thúc tới các local loops
      sub({ type: 'done', result: null });
    });
  }
}

/** Kho phiên đang chạy (in-memory — đủ cho dùng cá nhân localhost). */
const sessions = new Map<string, Session>();

export function createSession(): Session {
  const s = new Session();
  sessions.set(s.id, s);
  return s;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function removeSession(id: string): void {
  sessions.delete(id);
}
