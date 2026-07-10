import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import {
  buildStdioMcpConfig,
  isValidMcpName,
  maskArgs,
  resolveMcpEnv,
  type McpInfo,
} from '../tools/mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * MCP RIÊNG theo từng user (overlay lên MCP chung của admin trong ~/.claude.json).
 *
 * Lý do tồn tại: MCP chung nằm trong ~/.claude.json — ai sửa cũng dính cả LAN. User LAN
 * (safe/collab) cần MCP riêng (token/DB riêng, server riêng) mà KHÔNG đụng người khác.
 * File này lưu MCP theo user.id (từ access.ts), tách hẳn khỏi ~/.claude.json, và tự áp
 * (overlay) vào mọi lần chạy của chính user đó — trùng tên MCP chung thì bản riêng thắng.
 *
 * Token nằm trong file runtime này (đã gitignore cùng conversations/), KHÔNG trả nguyên
 * ra UI: listUserMcp che token giống listGlobalMcp.
 */

/** Thư mục runtime (gitignore) — dùng chung với conversations/ + access.json. */
const USER_MCP_DIR = join(__dirname, '..', '..', 'conversations');
/** File lưu MCP riêng của các user, khóa theo user.id. */
const USER_MCP_FILE = join(USER_MCP_DIR, 'user-mcp.json');

/** Một MCP stdio đã lưu (kèm token thật). Chỉ hỗ trợ stdio — như addGlobalMcp. */
export interface StoredUserMcp {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Map user.id → danh sách MCP riêng của user đó. */
type UserMcpData = Record<string, StoredUserMcp[]>;

function load(): UserMcpData {
  try {
    if (existsSync(USER_MCP_FILE)) {
      const raw = JSON.parse(readFileSync(USER_MCP_FILE, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as UserMcpData;
      }
    }
  } catch {
    // File hỏng → coi như chưa ai có MCP riêng, tránh khoá cứng cả app.
  }
  return {};
}

function save(data: UserMcpData): void {
  if (!existsSync(USER_MCP_DIR)) mkdirSync(USER_MCP_DIR, { recursive: true });
  writeFileSync(USER_MCP_FILE, JSON.stringify(data, null, 2));
}

/** Danh sách MCP riêng của một user — CHE token (giống listGlobalMcp). Trả [] nếu chưa có. */
export function listUserMcp(userId: string): McpInfo[] {
  const list = load()[userId] ?? [];
  return list.map((cfg) => ({
    name: cfg.name,
    command: cfg.command,
    args: Array.isArray(cfg.args) ? maskArgs(cfg.args) : [],
    envKeys: cfg.env ? Object.keys(cfg.env) : [],
    stdio: true,
  }));
}

/**
 * Thêm một MCP riêng cho user. Từ chối nếu tên không hợp lệ, command rỗng, hoặc tên đã
 * tồn tại TRONG PHẠM VI user đó (trùng tên MCP chung thì OK — overlay sẽ ghi đè). Env
 * value dạng "$VAR" → lấy từ process.env của server.
 */
export function addUserMcp(
  userId: string,
  input: { name: string; command: string; args?: string[]; env?: Record<string, string> },
): void {
  const name = input.name.trim();
  const command = input.command.trim();
  if (!isValidMcpName(name)) {
    throw new Error(`Tên MCP không hợp lệ: "${name}" (chỉ chữ/số/gạch dưới/gạch ngang).`);
  }
  if (!command) {
    throw new Error('Command không được để trống.');
  }

  const data = load();
  const list = data[userId] ?? [];
  if (list.some((m) => m.name === name)) {
    throw new Error(`Bạn đã có MCP "${name}". Xóa nó trước nếu muốn cấu hình lại.`);
  }

  const resolvedEnv = resolveMcpEnv(input.env);
  const entry: StoredUserMcp = {
    name,
    command,
    ...(input.args && input.args.length ? { args: input.args.map(String) } : {}),
    ...(Object.keys(resolvedEnv).length ? { env: resolvedEnv } : {}),
  };
  data[userId] = [...list, entry];
  save(data);
}

/** Xóa một MCP riêng của user theo tên. No-op nếu không có. */
export function removeUserMcp(userId: string, name: string): void {
  const data = load();
  const list = data[userId];
  if (!list) return;
  const next = list.filter((m) => m.name !== name);
  if (next.length === list.length) return;
  if (next.length) data[userId] = next;
  else delete data[userId];
  save(data);
}

/**
 * Resolve MCP riêng của user thành map tên → McpServerConfig THẬT (kèm token), sẵn sàng
 * overlay vào option mcpServers của query(). Trả {} nếu user chưa có MCP riêng nào.
 */
export function loadUserMcpServers(userId: string): Record<string, McpServerConfig> {
  const list = load()[userId] ?? [];
  const servers: Record<string, McpServerConfig> = {};
  for (const cfg of list) {
    servers[cfg.name] = buildStdioMcpConfig(cfg);
  }
  return servers;
}
