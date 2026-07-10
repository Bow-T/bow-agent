import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

export const config = {
  /** Agent có auth để chạy không? = đã login Claude CLI hoặc có Token config sẵn. */
  get hasAuth(): boolean {
    return hasClaudeCliLogin();
  },

  /** Có cấu hình token riêng cho profile này không? */
  get hasTokenSet(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
  },

  /** Đường dẫn file cấu hình Claude Code (chứa block mcpServers dùng chung). */
  get claudeJsonPath(): string {
    return getClaudeJsonPath();
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
