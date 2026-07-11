import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Cấu hình đọc từ biến môi trường (.env). Đây là NGUỒN DUY NHẤT đọc process.env —
 * mọi nơi khác import từ đây, không đọc process.env rải rác.
 */

function optional(key: string): string | undefined {
  const value = process.env[key];
  return value && value.trim() !== '' ? value : undefined;
}

/**
 * Tự động tải token (API Key hoặc OAuth Token) từ file token.txt của profile Claude đang chạy
 * và thiết lập vào process.env tương ứng để SDK và CLI tự động sử dụng.
 */
export function loadActiveProfileToken(): void {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const tokenFile = join(configDir, 'token.txt');
  if (existsSync(tokenFile)) {
    try {
      const token = readFileSync(tokenFile, 'utf8').trim();
      if (token) {
        if (token.startsWith('sk-ant-')) {
          process.env.ANTHROPIC_API_KEY = token;
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        } else {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
          delete process.env.ANTHROPIC_API_KEY;
        }
        return;
      }
    } catch (e) {
      console.error('Lỗi khi đọc token.txt cho profile:', e);
    }
  }
  // Nếu không có token.txt, xóa biến môi trường để dùng auth gốc của CLI
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

// Chạy khởi tạo token ngay khi nạp env config
loadActiveProfileToken();

/**
 * Có credential Claude Code CLI đã login sẵn không (~/.claude tồn tại)?
 * Hỗ trợ các biến môi trường ANTHROPIC_API_KEY hoặc CLAUDE_CODE_OAUTH_TOKEN.
 */
function hasClaudeCliLogin(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return true;
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return existsSync(configDir);
}

/**
 * Đường dẫn file cấu hình .claude.json (hoặc claude.json tùy theo CLAUDE_CONFIG_DIR).
 */
function getClaudeJsonPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) {
    const pathsToTry = [
      configDir + '.json',
      join(configDir, 'claude.json'),
      join(configDir, '.claude.json'),
    ];
    for (const p of pathsToTry) {
      if (existsSync(p)) return p;
    }
    return configDir + '.json';
  }
  return join(homedir(), '.claude.json');
}

/**
 * Đường dẫn file MCP CHUNG của bow-agent — TÁCH KHỎI profile/acc. Vì sao tách: MCP trước
 * đây nằm trong .claude.json của profile đang login, nên đổi acc là mất MCP, phải khai lại.
 * File này cố định (~/.bow-agent/mcp.json), độc lập mọi profile → config MCP một lần, đổi
 * acc bao nhiêu lần vẫn thấy. Chỉ chứa { mcpServers: {...} }. Override qua BOW_MCP_CONFIG.
 */
function getMcpConfigPath(): string {
  return optional('BOW_MCP_CONFIG') ?? join(homedir(), '.bow-agent', 'mcp.json');
}

/**
 * Seed file MCP mới LẦN ĐẦU từ ~/.claude.json (nơi người dùng thường đã cấu hình MCP bằng
 * Claude Code CLI). Chỉ chạy khi file mới CHƯA tồn tại — để không mất supabase/jira đang có.
 * Không seed đè nếu file đã có. Lỗi seed không kéo sập app (chỉ là tiện lợi ban đầu).
 */
function seedMcpConfigIfMissing(mcpPath: string): void {
  if (existsSync(mcpPath)) return;
  try {
    // Nguồn seed: ~/.claude.json mặc định (KHÔNG theo CLAUDE_CONFIG_DIR — đó là nơi CLI
    // thường lưu MCP; profile bow-agent thường rỗng mcpServers).
    const source = join(homedir(), '.claude.json');
    let mcpServers: Record<string, unknown> = {};
    if (existsSync(source)) {
      const data = JSON.parse(readFileSync(source, 'utf8')) as { mcpServers?: Record<string, unknown> };
      mcpServers = data.mcpServers ?? {};
    }
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(mcpPath, JSON.stringify({ mcpServers }, null, 2), 'utf8');
  } catch {
    // Seed thất bại → cứ để file chưa có; mcp.ts sẽ tự tạo {} khi ghi lần đầu.
  }
}

/**
 * Đường dẫn REGISTRY skill của bow-agent — allowlist các stack skill được duyệt + repo core.
 * TÁCH KHỎI repo bow-agent (khung để rỗng, không chứa skills/). File cố định
 * ~/.bow-agent/registry.json, seed lần đầu từ DEFAULT_REGISTRY dưới đây. Override qua BOW_REGISTRY.
 */
function getRegistryPath(): string {
  return optional('BOW_REGISTRY') ?? join(homedir(), '.bow-agent', 'registry.json');
}

/**
 * Registry MẶC ĐỊNH — nhúng trong code (KHÔNG đọc từ skills/ vì thư mục đó đã gỡ khỏi khung).
 * `core` = repo skill LUÔN tải (watch/qc-triage/coding-convention). `stacks` = allowlist stack
 * người dùng chọn. Admin sửa ~/.bow-agent/registry.json để ghim ref hoặc thêm stack, không cần
 * sửa code. Đây chỉ là bản seed lần đầu.
 */
const DEFAULT_REGISTRY = {
  version: 2,
  core: { id: 'core', repo: 'github.com/Bow-T/bow-skill-core', ref: 'v1.0.0' },
  stacks: [
    { id: 'flutter-supabase', label: 'Flutter + Supabase', repo: 'github.com/Bow-T/bow-skill-flutter', ref: 'v1.1.0', default: true },
    { id: 'react-native-supabase', label: 'React Native + Supabase', repo: 'github.com/Bow-T/bow-skill-react-native', ref: 'v1.0.0' },
    { id: 'nextjs-supabase', label: 'Next.js + Supabase', repo: 'github.com/Bow-T/bow-skill-nextjs', ref: 'v1.0.0' },
  ],
};

/** Seed registry LẦN ĐẦU từ DEFAULT_REGISTRY nếu file chưa có. Fail-open. */
function seedRegistryIfMissing(regPath: string): void {
  if (existsSync(regPath)) return;
  try {
    mkdirSync(dirname(regPath), { recursive: true });
    writeFileSync(regPath, JSON.stringify(DEFAULT_REGISTRY, null, 2), 'utf8');
  } catch {
    // Seed thất bại → externalSkills sẽ dùng hằng fallback CORE_REPO/CORE_REF cho core.
  }
}

export const config = {
  /** Agent có auth để chạy không? = đã login Claude CLI hoặc có Token config sẵn. */
  get hasAuth(): boolean {
    return hasClaudeCliLogin();
  },

  /** Có cấu hình token riêng cho profile này không? */
  get hasTokenSet(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
  },

  /** Đường dẫn file cấu hình Claude Code (login/token theo profile đang chạy). */
  get claudeJsonPath(): string {
    return getClaudeJsonPath();
  },

  /**
   * Đường dẫn file MCP CHUNG của bow-agent — TÁCH KHỎI profile. Seed lần đầu từ
   * ~/.claude.json để không mất MCP đã cấu hình. Đọc getter này = đảm bảo file đã tồn tại.
   */
  get mcpConfigPath(): string {
    const p = getMcpConfigPath();
    seedMcpConfigIfMissing(p);
    return p;
  },

  /**
   * Đường dẫn REGISTRY skill (allowlist stack + repo core), tách khỏi repo bow-agent.
   * Seed lần đầu từ DEFAULT_REGISTRY. Đọc getter này = đảm bảo file đã tồn tại.
   */
  get registryPath(): string {
    const p = getRegistryPath();
    seedRegistryIfMissing(p);
    return p;
  },

  /**
   * Model mặc định (CLI luôn dùng giá trị này). Opus 4.8 là bản mạnh nhất tier Opus
   * cho agentic dài hơi. Web tự chọn model riêng (gửi qua opts.model, ghi đè giá trị này).
   */
  model: 'claude-opus-4-8' as const,

  /**
   * Mã dự án mặc định (ví dụ: DEAR, PROJ). Không cấu hình → tự phát hiện từ git branch/commit.
   * (Jira đọc qua MCP jira của Claude Code — không cần JIRA_BASE_URL/EMAIL/TOKEN nữa.)
   */
  defaultProjectKey: optional('BOW_PROJECT_KEY') ?? optional('JIRA_PROJECT_KEY'),
} as const;
