import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Thư mục runtime (gitignore) — dùng chung với conversations/. */
const ACCESS_DIR = join(__dirname, '..', '..', 'conversations');
/** File lưu danh sách người dùng xin truy cập. */
const ACCESS_FILE = join(ACCESS_DIR, 'access.json');

export interface AccessUser {
  id: string;
  name: string;
  ip: string;
  token: string;
  status: 'pending' | 'approved' | 'rejected';
  /** M10: bị admin THU HỒI vĩnh viễn. Khác 'rejected' (có thể xin lại): banned=true thì
   *  requestAccess KHÔNG tái sinh về pending, không spam được hàng đợi admin. */
  banned?: boolean;
  createdAt: number;
  updatedAt: number;
}

interface AccessData {
  users: AccessUser[];
}

function load(): AccessData {
  try {
    if (existsSync(ACCESS_FILE)) {
      const raw = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<AccessData>;
      return {
        users: Array.isArray(raw.users) ? (raw.users as AccessUser[]) : [],
      };
    }
  } catch {
    // File hỏng → coi như chưa có ai, tránh khoá cứng cả app.
  }
  return { users: [] };
}

function save(data: AccessData): void {
  if (!existsSync(ACCESS_DIR)) mkdirSync(ACCESS_DIR, { recursive: true });
  writeFileSync(ACCESS_FILE, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Bus cho Realtime updates lên Admin
// ─────────────────────────────────────────────────────────────────────────────

export type AccessEvent =
  | { type: 'access-request'; user: AccessUser }
  | { type: 'access-resolved'; id: string; status: 'approved' | 'rejected' };

class AccessBus {
  private subscribers = new Set<(event: AccessEvent) => void>();

  subscribe(fn: (event: AccessEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  emit(event: AccessEvent): void {
    this.subscribers.forEach((sub) => sub(event));
  }
}

export const accessBus = new AccessBus();

// ─────────────────────────────────────────────────────────────────────────────
// Các API Nghiệp vụ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Yêu cầu truy cập mới từ máy khách. `ip` PHẢI là IP socket thật (getSocketIp) — không
 * phải x-forwarded-for — để ràng buộc theo IP có ý nghĩa.
 *
 * M6 (không rò token): nếu đã có bản ghi APPROVED trùng name+ip, KHÔNG trả token của bản
 * ghi đó cho người gọi mới. Chỉ khi client gửi kèm ĐÚNG token cũ (đã là chủ) mới nhận lại
 * token (luồng reload trang). Người gọi không có token → coi như request mới (pending).
 * M10 (ban bền): bản ghi banned KHÔNG tái sinh về pending.
 *
 * @param knownToken token client tự gửi kèm (nếu có) — để nhận lại đúng bản ghi của mình.
 */
export function requestAccess(name: string, ip: string, knownToken?: string): AccessUser {
  const data = load();

  const existing = data.users.find(
    (u) => u.name.toLowerCase() === name.toLowerCase() && u.ip === ip,
  );
  if (existing) {
    // Chủ hợp lệ của bản ghi (gửi đúng token cũ): trả nguyên trạng, kể cả token.
    const isOwner = Boolean(knownToken) && knownToken === existing.token;

    if (existing.banned) {
      // Đã bị thu hồi vĩnh viễn — không tái sinh, không cấp token, không spam admin.
      return { ...existing, token: isOwner ? existing.token : '' };
    }
    if (isOwner) {
      // Chủ reload: nếu đang rejected thì cho xin lại (về pending); trả token thật.
      if (existing.status === 'rejected') {
        existing.status = 'pending';
        existing.updatedAt = Date.now();
        save(data);
        accessBus.emit({ type: 'access-request', user: existing });
      }
      return existing;
    }
    // KHÔNG phải chủ:
    // - Bản ghi đang APPROVED của người khác → KHÔNG rò token, VÀ không kẹt: tạo bản ghi
    //   MỚI (pending) để người thứ hai thật sự cùng name+IP (sau NAT) xin duyệt riêng (R8).
    // - Bản ghi đang pending/rejected → trả token rỗng, không tạo trùng (tránh spam admin).
    if (existing.status !== 'approved') {
      return { ...existing, token: '' };
    }
    // (approved, không phải chủ) → rơi xuống dưới tạo bản ghi mới pending.
  }

  const user: AccessUser = {
    id: randomUUID(),
    name: name.trim(),
    ip,
    token: randomUUID(),
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  data.users.push(user);
  save(data);

  accessBus.emit({ type: 'access-request', user });
  return user;
}

/** Admin duyệt quyền truy cập. */
export function approveAccess(id: string): boolean {
  const data = load();
  const user = data.users.find((u) => u.id === id);
  if (!user) return false;
  
  user.status = 'approved';
  // R5: duyệt = gỡ ban. Nếu không clear, user từng bị revoke (banned=true) sẽ kẹt vĩnh
  // viễn dù admin bấm "Cho vào" (isValidToken vẫn false vì banned). Cho admin đường un-ban.
  user.banned = false;
  user.updatedAt = Date.now();
  save(data);

  accessBus.emit({ type: 'access-resolved', id, status: 'approved' });
  return true;
}

/** Admin từ chối quyền truy cập. */
export function rejectAccess(id: string): boolean {
  const data = load();
  const user = data.users.find((u) => u.id === id);
  if (!user) return false;
  
  user.status = 'rejected';
  user.updatedAt = Date.now();
  save(data);
  
  accessBus.emit({ type: 'access-resolved', id, status: 'rejected' });
  return true;
}

/** Admin thu hồi quyền truy cập VĨNH VIỄN. M10: đặt banned=true để bản ghi không tự tái
 *  sinh về pending khi client gửi lại request (chống spam hàng đợi admin + ban thật sự). */
export function revokeAccess(id: string): boolean {
  const data = load();
  const user = data.users.find((u) => u.id === id);
  if (!user) return false;

  user.status = 'rejected';
  user.banned = true;
  user.updatedAt = Date.now();
  save(data);

  accessBus.emit({ type: 'access-resolved', id, status: 'rejected' });
  return true;
}

/** Lấy thông tin user bằng token. */
export function getUserByToken(token: string | undefined | null): AccessUser | undefined {
  if (!token) return undefined;
  return load().users.find((u) => u.token === token);
}

/** Token có hợp lệ với trạng thái approved không (và chưa bị ban). */
export function isValidToken(token: string | undefined | null): boolean {
  const user = getUserByToken(token);
  return user ? user.status === 'approved' && !user.banned : false;
}

/** Danh sách tất cả các user xin truy cập. */
export function listAccessUsers(): AccessUser[] {
  return load().users;
}
