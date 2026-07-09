import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Chat NHÓM người-với-người qua LAN (không có AI trong nhóm — tách hẳn với runner).
 *
 * Ý tưởng: đồng nghiệp cùng mạng muốn nhắn hỏi nhau ngay trong giao diện bow-agent.
 * Mỗi người có một ID CÁ NHÂN (tự sinh, lưu ở máy mình) và một BIỆT DANH hiển thị.
 * Nhiều người vào cùng một PHÒNG bằng "mã phòng" (id phòng) rồi chat chung; ai cùng
 * mã thì thấy chung một luồng tin.
 *
 * Tin nhắn LƯU BỀN ra đĩa (như conversations/) để người vào sau đọc được lịch sử và
 * không mất khi restart server. Realtime do ChatBus (SSE broadcast) lo — giống hệt
 * cơ chế AdminBus của Collab Mode, nhưng broadcast theo từng phòng cho mọi người.
 *
 * Lưu trong bow-agent/conversations/chat-groups.json — GITIGNORE, runtime per-máy
 * (dùng chung thư mục với conversations.ts / access.ts).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Thư mục runtime (gitignore) — dùng chung với conversations/access. */
const CHAT_DIR = join(__dirname, '..', '..', 'conversations');
/** File registry chứa mọi phòng chat + tin nhắn. */
const CHAT_FILE = join(CHAT_DIR, 'chat-groups.json');

/** Giới hạn tin nhắn giữ lại mỗi phòng (cắt cũ nhất) — tránh file phình vô hạn. */
const MAX_MESSAGES_PER_GROUP = 1000;

/** Một tin nhắn trong phòng chat. */
export interface ChatMessage {
  id: string;
  /** ID cá nhân của người gửi (client tự sinh, lưu ở localStorage máy đó). */
  userId: string;
  /** Biệt danh hiển thị lúc gửi (chụp tại thời điểm gửi — đổi biệt danh không sửa tin cũ). */
  nickname: string;
  text: string;
  createdAt: number;
}

/** Một phòng chat (nhóm). */
export interface ChatGroup {
  /** Mã phòng — người dùng gõ để vào cùng nhóm. Chuẩn hoá về chữ thường/không dấu cách. */
  id: string;
  /** Tên phòng hiển thị (mặc định = id nếu không đặt). */
  name: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Phòng chat không kèm messages (cho danh sách/summary). */
export interface ChatGroupSummary {
  id: string;
  name: string;
  messageCount: number;
  updatedAt: number;
}

/** Chuẩn hoá mã phòng: trim, hạ chữ thường, gộp khoảng trắng → gạch nối. */
export function normalizeGroupId(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

/** Đọc registry từ đĩa (rỗng nếu chưa có / lỗi parse — fail-open). */
function readAll(): ChatGroup[] {
  if (!existsSync(CHAT_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(CHAT_FILE, 'utf8'));
    return Array.isArray(raw) ? (raw as ChatGroup[]) : [];
  } catch {
    return [];
  }
}

/** Ghi registry ra đĩa (tạo thư mục nếu chưa có). */
function writeAll(list: ChatGroup[]): void {
  mkdirSync(CHAT_DIR, { recursive: true });
  writeFileSync(CHAT_FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');
}

function toSummary(g: ChatGroup): ChatGroupSummary {
  return {
    id: g.id,
    name: g.name,
    messageCount: Array.isArray(g.messages) ? g.messages.length : 0,
    updatedAt: g.updatedAt,
  };
}

/** Danh sách mọi phòng (không kèm tin), mới hoạt động nhất lên đầu. */
export function listGroups(): ChatGroupSummary[] {
  return readAll()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(toSummary);
}

/**
 * Lấy (hoặc TẠO nếu chưa có) một phòng theo id. name chỉ dùng khi tạo mới; phòng đã
 * có thì giữ tên cũ. now = mốc thời gian truyền từ caller.
 */
export function getOrCreateGroup(rawId: string, name: string, now: number): ChatGroup {
  const id = normalizeGroupId(rawId);
  const list = readAll();
  const found = list.find((g) => g.id === id);
  if (found) return found;
  const created: ChatGroup = {
    id,
    name: name.trim() || id,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  list.push(created);
  writeAll(list);
  return created;
}

/** Lấy một phòng (kèm tin). null nếu chưa tồn tại. */
export function getGroup(rawId: string): ChatGroup | null {
  const id = normalizeGroupId(rawId);
  return readAll().find((g) => g.id === id) ?? null;
}

/**
 * Thêm một tin nhắn vào phòng (tạo phòng nếu chưa có). Trả về tin nhắn đã lưu
 * (kèm id/createdAt server gán) để caller broadcast. now = mốc thời gian.
 */
export function addMessage(
  rawId: string,
  msg: { userId: string; nickname: string; text: string },
  now: number,
): { group: ChatGroup; message: ChatMessage } {
  const id = normalizeGroupId(rawId);
  const list = readAll();
  let group = list.find((g) => g.id === id);
  if (!group) {
    group = { id, name: id, messages: [], createdAt: now, updatedAt: now };
    list.push(group);
  }
  const message: ChatMessage = {
    id: randomUUID(),
    userId: String(msg.userId || '').slice(0, 64),
    nickname: (msg.nickname || 'Ẩn danh').trim().slice(0, 40) || 'Ẩn danh',
    text: String(msg.text || '').slice(0, 4000),
    createdAt: now,
  };
  group.messages.push(message);
  // Cắt bớt tin cũ nhất nếu vượt trần.
  if (group.messages.length > MAX_MESSAGES_PER_GROUP) {
    group.messages = group.messages.slice(-MAX_MESSAGES_PER_GROUP);
  }
  group.updatedAt = now;
  writeAll(list);
  return { group, message };
}

// ─────────────────────────────────────────────────────────────────────────────
// ChatBus — broadcast realtime tin nhắn tới mọi người đang mở CÙNG một phòng.
//
// Giống AdminBus (Collab Mode) nhưng broadcast THEO PHÒNG: mỗi subscriber đăng ký
// một groupId, chỉ nhận tin của phòng đó. Tin đã LƯU ĐĨA (addMessage) rồi mới bơm
// qua bus — bus chỉ lo phần "hiện ngay", không phải nguồn sự thật.
// ─────────────────────────────────────────────────────────────────────────────

/** Event đẩy tới client đang mở một phòng qua SSE. */
export type ChatEvent = { type: 'message'; message: ChatMessage };

class ChatBus {
  /** groupId → tập các callback (mỗi SSE client một callback). */
  private rooms = new Map<string, Set<(event: ChatEvent) => void>>();

  /** Client mở SSE một phòng. Trả hàm huỷ đăng ký. */
  subscribe(rawId: string, fn: (event: ChatEvent) => void): () => void {
    const id = normalizeGroupId(rawId);
    let set = this.rooms.get(id);
    if (!set) {
      set = new Set();
      this.rooms.set(id, set);
    }
    set.add(fn);
    return () => {
      const s = this.rooms.get(id);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.rooms.delete(id);
    };
  }

  /** Phát một event tới mọi người trong phòng. */
  publish(rawId: string, event: ChatEvent): void {
    const id = normalizeGroupId(rawId);
    this.rooms.get(id)?.forEach((fn) => fn(event));
  }
}

/** Bus chat toàn cục (một instance cho cả tiến trình). */
export const chatBus = new ChatBus();
