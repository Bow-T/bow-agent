import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Lịch sử NHIỀU cuộc trò chuyện, lưu BỀN ra đĩa (không phải localStorage) để xem lại
 * được dù restart server hay đổi máy. Mỗi cuộc giữ:
 *   - items[]: toàn bộ dòng chat hiển thị (câu hỏi, trả lời, tool, kết quả) — lưu
 *     NGUYÊN VẸN như frontend gửi (unknown[]) để không phụ thuộc shape ChatItem.
 *   - conversationId: session_id THẬT của SDK → mở lại cuộc + gõ tiếp thì agent resume
 *     đúng phiên và nhớ hội thoại (xem runner resume). File .jsonl do SDK quản lý riêng;
 *     nếu SDK đã dọn phiên đó, nội dung hiển thị vẫn còn, chỉ mất trí nhớ ngữ cảnh.
 *   - cwd: repo của cuộc → mở lại tự trỏ đúng thư mục, tránh agent làm nhầm chỗ.
 *
 * Lưu trong bow-agent/conversations/ — GITIGNORE, runtime per-máy (mirror workspaces/):
 *   conversations/
 *   └── conversations.json      registry: mảng cuộc trò chuyện (mới nhất cuối, sort khi đọc)
 *
 * Chọn 1 file phẳng (không mỗi cuộc một file) vì dùng cá nhân, số cuộc nhỏ, đọc/ghi cả
 * mảng đơn giản và đủ nhanh. items có thể lớn nên GET list KHÔNG kèm items (xem toSummary).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Thư mục chứa lịch sử chat (gitignore, cạnh repo root — như WORKSPACES_DIR). */
export const CONVERSATIONS_DIR = join(__dirname, '..', '..', 'conversations');
/** File registry chứa mọi cuộc trò chuyện. */
export const CONVERSATIONS_FILE = join(CONVERSATIONS_DIR, 'conversations.json');

/** Một cuộc trò chuyện đầy đủ (bản ghi lưu trên đĩa). */
export interface Conversation {
  id: string;
  /** Tiêu đề — mặc định lấy câu hỏi đầu tiên (cắt gọn), người dùng đổi tay được. */
  title: string;
  /** session_id SDK để resume trí nhớ. null nếu cuộc chưa từng chạy agent. */
  conversationId: string | null;
  /** Toàn bộ dòng chat hiển thị — lưu nguyên vẹn như frontend gửi. */
  items: unknown[];
  /** Thư mục làm việc của cuộc (để mở lại tự set cwd). */
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

/** Bản tóm tắt (cho danh sách sidebar — bỏ items cho nhẹ). */
export interface ConversationSummary {
  id: string;
  title: string;
  cwd: string;
  /** Số dòng chat (để hiện "trống" vs "có nội dung"). */
  itemCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Đọc registry từ đĩa (rỗng nếu chưa có / lỗi parse — fail-open, không kéo sập). */
function readAll(): Conversation[] {
  if (!existsSync(CONVERSATIONS_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(CONVERSATIONS_FILE, 'utf8'));
    return Array.isArray(raw) ? (raw as Conversation[]) : [];
  } catch {
    return [];
  }
}

/** Ghi registry ra đĩa (tạo thư mục nếu chưa có). */
function writeAll(list: Conversation[]): void {
  mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  writeFileSync(CONVERSATIONS_FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');
}

/** Bỏ items khỏi bản ghi → summary cho danh sách. */
function toSummary(c: Conversation): ConversationSummary {
  return {
    id: c.id,
    title: c.title,
    cwd: c.cwd,
    itemCount: Array.isArray(c.items) ? c.items.length : 0,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** Danh sách cuộc (không kèm items), MỚI NHẤT lên đầu theo updatedAt. */
export function listConversations(): ConversationSummary[] {
  return readAll()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(toSummary);
}

/** Lấy đầy đủ một cuộc (kèm items). null nếu không có. */
export function getConversation(id: string): Conversation | null {
  return readAll().find((c) => c.id === id) ?? null;
}

/**
 * Upsert một cuộc: tạo mới nếu id chưa có, ngược lại cập nhật (items/title/conversationId/
 * cwd). Dùng cho auto-lưu. now = mốc thời gian (truyền từ caller để module không tự gọi
 * Date.now trực tiếp trong nhánh test/resume — nhưng ở runtime web thì luôn có).
 */
export function upsertConversation(
  id: string,
  patch: {
    title?: string;
    conversationId?: string | null;
    items?: unknown[];
    cwd?: string;
  },
  now: number,
): Conversation {
  const list = readAll();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) {
    const created: Conversation = {
      id,
      title: patch.title?.trim() || 'Cuộc trò chuyện mới',
      conversationId: patch.conversationId ?? null,
      items: patch.items ?? [],
      cwd: patch.cwd ?? '',
      createdAt: now,
      updatedAt: now,
    };
    list.push(created);
    writeAll(list);
    return created;
  }
  const cur = list[idx];
  const updated: Conversation = {
    ...cur,
    // title: chỉ ghi đè khi patch có giá trị không rỗng (giữ tên người dùng đã đặt).
    title: patch.title?.trim() ? patch.title.trim() : cur.title,
    conversationId: patch.conversationId !== undefined ? patch.conversationId : cur.conversationId,
    items: patch.items !== undefined ? patch.items : cur.items,
    cwd: patch.cwd !== undefined ? patch.cwd : cur.cwd,
    updatedAt: now,
  };
  list[idx] = updated;
  writeAll(list);
  return updated;
}

/** Đổi tên một cuộc. Trả bản ghi sau đổi, hoặc null nếu id lạ. */
export function renameConversation(id: string, title: string, now: number): Conversation | null {
  const list = readAll();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const t = title.trim();
  if (!t) return list[idx]; // tên rỗng → giữ nguyên
  list[idx] = { ...list[idx], title: t, updatedAt: now };
  writeAll(list);
  return list[idx];
}

/** Xóa một cuộc. Trả true nếu có xóa. */
export function deleteConversation(id: string): boolean {
  const list = readAll();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return false;
  writeAll(next);
  return true;
}

/** Sinh id mới cho một cuộc (dùng khi frontend tạo "Cuộc trò chuyện mới"). */
export function newConversationId(): string {
  return randomUUID();
}
