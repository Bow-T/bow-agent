import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

/**
 * Nạp các MCP server mà người dùng đã cấu hình cho Claude Code (~/.claude.json).
 * Nhờ đó bow-agent dùng LẠI đúng kết nối Supabase / Jira / Codemagic... của Claude
 * Code — xem DB, apply migration, đọc ticket — mà KHÔNG hardcode token vào repo.
 * Token nằm nguyên trong ~/.claude.json của máy, bow-agent chỉ tham chiếu.
 */

/** Đọc block mcpServers từ ~/.claude.json (nếu có). Trả {} nếu không có. */
function readGlobalMcp(): Record<string, unknown> {
  const file = join(homedir(), '.claude.json');
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> };
    return data.mcpServers ?? {};
  } catch {
    return {};
  }
}

/** Một MCP server hợp lệ (stdio) từ config: có `command`. */
function isStdioServer(v: unknown): v is { command: string; args?: string[]; env?: Record<string, string> } {
  return Boolean(v && typeof v === 'object' && typeof (v as { command?: unknown }).command === 'string');
}

export interface LoadedMcp {
  /** Map tên server → config, truyền thẳng vào option mcpServers của query(). */
  servers: Record<string, McpServerConfig>;
  /** Tên các server nạp được (để hiển thị / gate tool). */
  names: string[];
}

/**
 * Nạp MCP server từ Claude Code global config. Chỉ lấy stdio server (command/args/env).
 * Hỗ trợ các server quan trọng: supabase, jira, codemagic, figma.
 */
export function loadClaudeCodeMcp(filterNames?: string[]): LoadedMcp {
  const raw = readGlobalMcp();
  const servers: Record<string, McpServerConfig> = {};
  const names: string[] = [];

  for (const [name, cfg] of Object.entries(raw)) {
    if (!isStdioServer(cfg)) continue;
    if (filterNames && !filterNames.includes(name)) continue;

    servers[name] = {
      type: 'stdio',
      command: cfg.command,
      ...(cfg.args ? { args: cfg.args } : {}),
      ...(cfg.env ? { env: cfg.env } : {}),
      // Giới hạn mỗi MCP call 60s — tránh treo vô hạn khi query DB lớn / npx tải chậm.
      timeout: 60_000,
    };
  }
  return { servers, names: Object.keys(servers) };
}

/**
 * Mô tả một tool cho người dùng dễ hiểu — đặc biệt MCP tool (báo "đang query DB/Jira")
 * để không tưởng agent bị treo khi MCP call chậm.
 */
export function describeTool(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__'); // mcp__<server>__<tool>
    const server = parts[1] ?? '';
    const tool = parts[2] ?? name;
    if (server.includes('supabase')) return `truy vấn Supabase (DB): ${tool}… (có thể mất chút thời gian)`;
    if (server.includes('jira')) return `đọc Jira: ${tool}…`;
    if (server.includes('codemagic')) return `Codemagic: ${tool}…`;
    return `MCP ${server}: ${tool}…`;
  }
  // Nhãn thân thiện cho các tool hệ thống hay lặp — tránh hiển thị tên thô khó hiểu.
  const FRIENDLY: Record<string, string> = {
    ToolSearch: '🔍 tìm công cụ phù hợp…',
    Read: 'đọc file…',
    Grep: 'tìm trong code…',
    Glob: 'quét danh sách file…',
    Bash: 'chạy lệnh…',
    Edit: 'sửa file…',
    Write: 'ghi file…',
    Agent: '🤖 giao việc cho agent phụ…',
    Skill: '📚 dùng skill…',
    TodoWrite: 'cập nhật danh sách việc…',
    WebFetch: 'tải trang web…',
    WebSearch: 'tìm trên web…',
    ScheduleWakeup: 'hẹn kiểm tra lại…',
  };
  return FRIENDLY[name] ?? `dùng tool: ${name}`;
}

/**
 * Sinh danh sách tool ĐỌC an toàn để auto-allow, cho các MCP server đã nạp.
 * Dùng wildcard mcp__<server>__* cho các server chỉ-đọc quan trọng; server có thao
 * tác ghi (apply_migration, execute_sql, trigger_build) KHÔNG auto-allow — phải duyệt.
 */
export function mcpReadToolPatterns(names: string[]): string[] {
  const patterns: string[] = [];
  for (const n of names) {
    // Các tool đọc phổ biến của Supabase/Jira — auto cho phép.
    if (n.includes('supabase')) {
      patterns.push(
        `mcp__${n}__list_projects`,
        `mcp__${n}__list_tables`,
        `mcp__${n}__list_migrations`,
        `mcp__${n}__list_edge_functions`,
        `mcp__${n}__get_edge_function`,
        `mcp__${n}__get_advisors`,
        `mcp__${n}__get_logs`,
        `mcp__${n}__get_project`,
        `mcp__${n}__get_project_url`,
        `mcp__${n}__generate_typescript_types`,
        `mcp__${n}__search_docs`,
      );
    }
    if (n.includes('jira')) {
      patterns.push(`mcp__${n}__jira_get_issue`, `mcp__${n}__jira_search_issues`, `mcp__${n}__jira_get_comments`);
    }
    // Codemagic/figma đọc: các tool list/get an toàn (build/trigger phải duyệt).
    if (n.includes('codemagic')) {
      patterns.push(`mcp__${n}__list_builds`, `mcp__${n}__get_build`, `mcp__${n}__list_applications`);
    }
  }
  return patterns;
}
