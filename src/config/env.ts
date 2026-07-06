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
 * Nếu có, Agent SDK dùng được login đó — KHÔNG cần ANTHROPIC_API_KEY.
 */
function hasClaudeCliLogin(): boolean {
  return existsSync(join(homedir(), '.claude'));
}

export const config = {
  /** API key của Claude (tùy chọn). Rỗng = dựa vào login Claude CLI sẵn có. */
  get anthropicApiKey(): string | undefined {
    return optional('ANTHROPIC_API_KEY');
  },

  /**
   * Agent có auth để chạy không? Đúng nếu (a) có ANTHROPIC_API_KEY, HOẶC
   * (b) đã login Claude Code CLI (~/.claude). Sai = chưa có cách nào để gọi Claude.
   */
  get hasAuth(): boolean {
    return Boolean(this.anthropicApiKey) || hasClaudeCliLogin();
  },

  /** Đang dùng nguồn auth nào (để báo cho người dùng). */
  get authSource(): 'api-key' | 'claude-cli' | 'none' {
    if (this.anthropicApiKey) return 'api-key';
    if (hasClaudeCliLogin()) return 'claude-cli';
    return 'none';
  },

  /** Model mặc định. Opus 4.8 là bản mạnh nhất tier Opus cho agentic dài hơi. */
  model: optional('BOW_AGENT_MODEL') ?? 'claude-opus-4-8',

  /** Cấu hình Jira — chỉ cần nếu dùng lệnh chạy theo ticket. */
  jira: {
    baseUrl: optional('JIRA_BASE_URL'),
    email: optional('JIRA_EMAIL'),
    apiToken: optional('JIRA_API_TOKEN'),
  },

  /** Jira đã cấu hình đủ để đọc/ghi chưa? */
  get jiraConfigured(): boolean {
    return Boolean(this.jira.baseUrl && this.jira.email && this.jira.apiToken);
  },

  /** Mã dự án mặc định (ví dụ: DEAR, PROJ), nếu không cấu hình sẽ tự động phát hiện từ git. */
  defaultProjectKey: optional('BOW_PROJECT_KEY') ?? optional('JIRA_PROJECT_KEY'),
} as const;
