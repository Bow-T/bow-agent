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

/** Yêu cầu truy cập mới từ máy khách. */
export function requestAccess(name: string, ip: string): AccessUser {
  const data = load();
  
  // Kiểm tra nếu IP và Tên trùng khớp đã có request, trả lại bản ghi cũ hoặc cập nhật
  const existing = data.users.find((u) => u.name.toLowerCase() === name.toLowerCase() && u.ip === ip);
  if (existing) {
    if (existing.status === 'rejected') {
      // Đổi trạng thái về pending để admin duyệt lại
      existing.status = 'pending';
      existing.updatedAt = Date.now();
      save(data);
      accessBus.emit({ type: 'access-request', user: existing });
    }
    return existing;
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

/** Admin thu hồi quyền truy cập (chuyển trạng thái sang rejected). */
export function revokeAccess(id: string): boolean {
  return rejectAccess(id);
}

/** Lấy thông tin user bằng token. */
export function getUserByToken(token: string | undefined | null): AccessUser | undefined {
  if (!token) return undefined;
  return load().users.find((u) => u.token === token);
}

/** Token có hợp lệ với trạng thái approved không. */
export function isValidToken(token: string | undefined | null): boolean {
  const user = getUserByToken(token);
  return user ? user.status === 'approved' : false;
}

/** Danh sách tất cả các user xin truy cập. */
export function listAccessUsers(): AccessUser[] {
  return load().users;
}
