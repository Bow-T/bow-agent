import 'dotenv/config';
import { existsSync } from 'node:fs';
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
 * Có credential Claude Code CLI đã login sẵn không (~/.claude tồn tại)?
 * Agent SDK spawn tiến trình `claude`, tiến trình đó tự đọc login này — đây là
 * cách xác thực DUY NHẤT của bow-agent (không dùng ANTHROPIC_API_KEY).
 */
function hasClaudeCliLogin(): boolean {
  return existsSync(join(homedir(), '.claude'));
}

export const config = {
  /** Agent có auth để chạy không? = đã login Claude CLI (`claude` → /login) chưa. */
  get hasAuth(): boolean {
    return hasClaudeCliLogin();
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
