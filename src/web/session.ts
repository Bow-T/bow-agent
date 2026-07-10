import { randomUUID } from 'node:crypto';
import type { AgentEvent, Question } from '../core/runner.js';

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
  | {
      // Agent hỏi người dùng (tool AskUserQuestion) — UI render các option để chọn.
      type: 'question-request';
      id: string;
      questions: Question[];
    }
  | {
      // session_id THẬT của SDK (từ message system/init). Frontend lưu để lượt sau
      // gửi lại làm conversationId → agent resume đúng phiên và nhớ hội thoại trước.
      type: 'conversation';
      conversationId: string;
    }
  | {
      // Phiên vừa dừng vì hết hạn mức phiên (5h) và server ĐÃ LÊN LỊCH tự chạy tiếp.
      // `resetsAt` = giờ hạn mức reset, `retryAt` = giờ sẽ tự gọi lại (reset + đệm),
      // `attempt`/`maxAttempts` để UI hiện "lần 1/3". Client hiện đếm ngược + nút huỷ.
      type: 'auto-resume-scheduled';
      resetsAt: string | null;
      retryAt: string;
      attempt: number;
      maxAttempts: number;
    }
  | {
      // Lịch tự chạy tiếp đã bị huỷ — do người dùng bấm huỷ, hết số lần, hoặc phiên xong.
      type: 'auto-resume-cancelled';
      reason: 'user' | 'exhausted' | 'done';
    }
  | { type: 'done'; result: string | null }
  | { type: 'fatal'; message: string };

interface PendingApproval {
  resolve: (approved: boolean) => void;
}

interface PendingQuestion {
  // Trả map câu-hỏi → câu-trả-lời, hoặc null nếu người dùng huỷ.
  resolve: (answers: Record<string, string> | null) => void;
}

export class Session {
  readonly id = randomUUID();

  /** Lịch sử các sự kiện đã xảy ra trong phiên. */
  private history: WebEvent[] = [];
  /** Các consumer SSE đang kết nối. */
  private subscribers = new Set<(event: WebEvent) => void>();
  /**
   * "Thế hệ" consumer hiện hành. Mỗi lần events() được gọi lại (client mở SSE mới),
   * biến này tăng lên và mọi vòng events() cũ tự thoát khi thấy thế hệ của mình đã
   * lỗi thời. Đảm bảo MỖI SESSION CHỈ CÓ 1 CONSUMER SỐNG — chặn tận gốc việc 2 SSE
   * cùng session nhận trùng event rồi nhân đôi tin trên UI.
   */
  private consumerGeneration = 0;
  /** Hàm đánh thức của các consumer đang chờ event (để ép chúng kiểm tra lại điều kiện). */
  private wakers = new Set<() => void>();
  /** Các yêu cầu duyệt đang treo, keyed theo id. */
  private pending = new Map<string, PendingApproval>();
  /** Các câu hỏi (AskUserQuestion) đang chờ người dùng chọn, keyed theo id. */
  private pendingQuestions = new Map<string, PendingQuestion>();
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

  /** Đánh thức mọi consumer đang chờ (không phát event) để chúng kiểm tra lại điều
   *  kiện vòng lặp — dùng khi generation đổi để consumer cũ thoát ngay. */
  private wakeAll(): void {
    this.wakers.forEach((wake) => wake());
  }

  /** Async iterator các sự kiện — dùng cho SSE. Hỗ trợ phát lại lịch sử. */
  async *events(): AsyncGenerator<WebEvent> {
    // Nhận "vé" thế hệ mới rồi đánh thức các consumer cũ để chúng thấy generation
    // của mình đã lỗi thời và tự thoát → chỉ 1 consumer sống tại một thời điểm.
    const myGeneration = ++this.consumerGeneration;
    this.wakeAll();

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
      // Thoát ngay khi có consumer mới hơn thế chỗ (generation lỗi thời), khi session
      // đóng, hoặc còn event tồn đọng cần xả nốt.
      while ((!this.closed && myGeneration === this.consumerGeneration) || localQueue.length > 0) {
        if (localQueue.length === 0) {
          await new Promise<void>((r) => {
            resolveWaker = r;
            this.wakers.add(r);
          });
          if (resolveWaker) this.wakers.delete(resolveWaker);
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

  /**
   * Agent hỏi người dùng (AskUserQuestion): đẩy 'question-request' lên UI rồi treo
   * Promise chờ người dùng gọi resolveQuestion(id, answers).
   */
  requestQuestion(questions: Question[]): Promise<Record<string, string> | null> {
    const id = randomUUID();
    return new Promise<Record<string, string> | null>((resolve) => {
      this.pendingQuestions.set(id, { resolve });
      this.push({ type: 'question-request', id, questions });
    });
  }

  /**
   * Người dùng chọn xong → giải Promise câu hỏi treo. answers=null nghĩa là huỷ.
   * Trả false nếu id lạ.
   */
  resolveQuestion(id: string, answers: Record<string, string> | null): boolean {
    const q = this.pendingQuestions.get(id);
    if (!q) return false;
    this.pendingQuestions.delete(id);
    q.resolve(answers);
    return true;
  }

  /** Gọi khi phiên đóng để dọn khỏi kho (đặt bởi createSession). Tránh rò session (M7). */
  onDispose?: () => void;

  /** Đóng phiên: từ chối mọi approval/câu hỏi còn treo, dừng iterator, và tự dọn khỏi kho. */
  close(): void {
    if (this.closed) return; // idempotent — tránh lên lịch dọn nhiều lần
    this.closed = true;
    // R9: hủy timer ngắt-kết-nối 30s còn treo (nếu có). Nếu không, timer đó nổ sau khi
    // phiên đã đóng và removeSession SỚM (30s), phá vỡ cửa sổ grace 60s của onDispose
    // (SSE muộn mất cơ hội replay history) + gọi abort/removeSession thừa.
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    for (const [, p] of this.pending) p.resolve(false);
    this.pending.clear();
    for (const [, q] of this.pendingQuestions) q.resolve(null);
    this.pendingQuestions.clear();
    this.subscribers.forEach((sub) => {
      // Đẩy tín hiệu kết thúc tới các local loops
      sub({ type: 'done', result: null });
    });
    // Đánh thức mọi consumer đang chờ để chúng thấy closed=true và thoát vòng lặp.
    this.wakeAll();
    // M7: tự dọn khỏi kho sau một khoảng GRACE — đủ để client mở SSE muộn replay lịch sử
    // (history đã giữ trong Session) rồi mới xóa. Trước đây session CHỈ bị xóa khi SSE
    // mở-rồi-đóng; client spam /api/run mà không mở SSE làm rò session + history tới OOM.
    setTimeout(() => this.onDispose?.(), SESSION_DISPOSE_GRACE_MS);
  }
}

/** Kho phiên đang chạy (in-memory — đủ cho dùng cá nhân localhost). */
const sessions = new Map<string, Session>();

/** Khoảng chờ trước khi dọn một session đã đóng khỏi kho (cho SSE muộn kịp replay). */
const SESSION_DISPOSE_GRACE_MS = 60_000;

export function createSession(): Session {
  const s = new Session();
  sessions.set(s.id, s);
  s.onDispose = () => sessions.delete(s.id);
  return s;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function removeSession(id: string): void {
  sessions.delete(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin approval bus (Collab Mode — duyệt từ xa)
//
// Ở Collab Mode, cộng tác viên (CTV) qua LAN code gần như dev nhưng lệnh HỦY HOẠI
// (rm -rf, deploy, ghi ngoài repo…) không được tự chạy. Vì CTV không có quyền tự
// duyệt, yêu cầu duyệt được ĐỊNH TUYẾN LÊN ADMIN (localhost): admin thấy trên một
// kênh SSE riêng (/api/admin/events) và bấm cho phép/từ chối thay CTV.
//
// Bus này TÁCH khỏi Session: một phiên CTV chỉ có 1 consumer SSE (chính CTV), nên
// không thể nhét nút duyệt vào stream của CTV. Bus là kênh toàn cục riêng cho admin.
// ─────────────────────────────────────────────────────────────────────────────

/** Một yêu cầu duyệt Collab hiển thị cho admin. */
export interface AdminApprovalRequest {
  id: string;
  /** Phiên CTV phát yêu cầu — để audit/hiển thị. */
  sessionId: string;
  /** IP của CTV yêu cầu — admin biết ai đang xin. */
  clientIp: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  decisionReason?: string;
  /** Thời điểm tạo (ISO) — để admin biết yêu cầu cũ/mới. */
  createdAt: string;
}

/** Event đẩy tới admin qua SSE. */
export type AdminEvent =
  | { type: 'admin-approval-request'; request: AdminApprovalRequest }
  // Yêu cầu đã được giải quyết (bởi admin khác, hoặc phiên đóng) → admin gỡ khỏi UI.
  | { type: 'admin-approval-resolved'; id: string };

interface PendingAdminApproval {
  resolve: (approved: boolean) => void;
  request: AdminApprovalRequest;
  /** Timer auto-deny (R6) — clear khi resolve/reject để không rò timer. */
  timer?: NodeJS.Timeout;
}

/** R6: hết thời gian chờ admin duyệt (mặc định 10 phút) → auto-DENY để không treo agent
 *  vô hạn khi admin không online. Có thể override qua env cho test. */
const ADMIN_APPROVAL_TIMEOUT_MS = Number(process.env.BOW_ADMIN_APPROVAL_TIMEOUT_MS ?? 10 * 60_000);
/** R6: trần số yêu cầu duyệt ĐANG TREO cho MỖI phiên CTV — vượt thì auto-deny ngay, chống
 *  một CTV làm ngập hàng đợi admin + tích tụ tài nguyên. */
const MAX_PENDING_PER_SESSION = 20;

class AdminBus {
  private pending = new Map<string, PendingAdminApproval>();
  private subscribers = new Set<(event: AdminEvent) => void>();

  /** Admin mở SSE: nhận callback nhận event mới. Trả hàm huỷ đăng ký. */
  subscribe(fn: (event: AdminEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Snapshot các yêu cầu đang treo — admin mới kết nối phát lại ngay. */
  snapshot(): AdminApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  private emit(event: AdminEvent): void {
    this.subscribers.forEach((sub) => sub(event));
  }

  /** Số yêu cầu đang treo của một phiên (để áp trần per-session — R6). */
  private pendingCountForSession(sessionId: string): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.request.sessionId === sessionId) n++;
    return n;
  }

  /**
   * Phiên CTV xin duyệt một thao tác ghi → đẩy lên admin rồi treo Promise chờ admin bấm.
   * R6: (a) nếu phiên đã có quá nhiều yêu cầu treo → auto-DENY ngay (chống ngập); (b) đặt
   * timeout auto-DENY để agent không treo vô hạn khi admin không online.
   */
  requestApproval(
    meta: Omit<AdminApprovalRequest, 'id' | 'createdAt'>,
  ): Promise<boolean> {
    // (a) Trần số pending per-session.
    if (this.pendingCountForSession(meta.sessionId) >= MAX_PENDING_PER_SESSION) {
      return Promise.resolve(false);
    }
    const id = randomUUID();
    const request: AdminApprovalRequest = {
      ...meta,
      id,
      createdAt: new Date().toISOString(),
    };
    return new Promise<boolean>((resolve) => {
      // (b) timeout auto-deny — dọn pending + báo admin gỡ khỏi UI.
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        p.resolve(false);
        this.emit({ type: 'admin-approval-resolved', id });
      }, ADMIN_APPROVAL_TIMEOUT_MS);
      timer.unref?.(); // không giữ tiến trình sống chỉ vì timer này
      this.pending.set(id, { resolve, request, timer });
      this.emit({ type: 'admin-approval-request', request });
    });
  }

  /** Admin bấm cho phép/từ chối. Trả false nếu id lạ (đã giải quyết/hết hạn). */
  resolve(id: string, approved: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(approved);
    this.emit({ type: 'admin-approval-resolved', id });
    return true;
  }

  /** Phiên đóng giữa chừng: từ chối mọi yêu cầu treo của phiên đó. */
  rejectForSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.request.sessionId === sessionId) {
        if (p.timer) clearTimeout(p.timer);
        this.pending.delete(id);
        p.resolve(false);
        this.emit({ type: 'admin-approval-resolved', id });
      }
    }
  }
}

/** Bus duyệt admin toàn cục (một instance cho cả tiến trình). */
export const adminBus = new AdminBus();
