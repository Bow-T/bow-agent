import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

/** Đường dẫn file cấu hình Claude Code (chứa block mcpServers dùng chung). */
function claudeJsonPath(): string {
  return join(homedir(), '.claude.json');
}

/**
 * Nạp các MCP server mà người dùng đã cấu hình cho Claude Code (~/.claude.json).
 * Nhờ đó bow-agent dùng LẠI đúng kết nối Supabase / Jira / Codemagic... của Claude
 * Code — xem DB, apply migration, đọc ticket — mà KHÔNG hardcode token vào repo.
 * Token nằm nguyên trong ~/.claude.json của máy, bow-agent chỉ tham chiếu.
 */

/** Đọc block mcpServers từ ~/.claude.json (nếu có). Trả {} nếu không có. */
function readGlobalMcp(): Record<string, unknown> {
  const file = claudeJsonPath();
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

/** Cắt ngắn 1 chuỗi để hiển thị an toàn (không dump content file/secret dài). */
function clip(value: unknown, max = 160): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return '';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

/**
 * Rút gọn INPUT của một tool thành 1 chuỗi ngắn "đã làm gì cụ thể" để hiển thị chi
 * tiết ở Activity Log (vd `npm run build`, `src/core/runner.ts`, `"describeTool" in src/`).
 * Chỉ lấy tham số cốt lõi — KHÔNG lấy content file/patch dài để tránh dump & lộ secret.
 */
export function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const arg = input as Record<string, unknown>;
  switch (name) {
    case 'Bash':
      return clip(arg.command);
    case 'Read':
    case 'Write':
      return clip(arg.file_path ?? arg.path);
    case 'Edit':
      return clip(arg.file_path ?? arg.path);
    case 'Grep': {
      const where = arg.path ? ` in ${clip(arg.path, 60)}` : '';
      return `${clip(arg.pattern, 80)}${where}`;
    }
    case 'Glob':
      return clip(arg.pattern);
    case 'WebFetch':
    case 'WebSearch':
      return clip(arg.url ?? arg.query);
    case 'Agent':
      return clip(arg.description ?? arg.agent);
    case 'Skill':
      return clip(arg.command ?? arg.name);
    case 'TodoWrite':
      return Array.isArray(arg.todos) ? `${arg.todos.length} việc` : '';
    default: {
      // MCP tool hoặc tool lạ: lấy vài trường ngắn đầu tiên làm gợi ý.
      const parts: string[] = [];
      for (const [k, v] of Object.entries(arg)) {
        if (typeof v === 'string' || typeof v === 'number') {
          parts.push(`${k}=${clip(v, 40)}`);
          if (parts.length >= 3) break;
        }
      }
      return parts.join(', ');
    }
  }
}

/** Rút gọn KẾT QUẢ tool (chuỗi text trong tool_result) để hiển thị "→ ...". */
export function summarizeToolResult(content: unknown): { text: string; isError: boolean } {
  // content có thể là string, hoặc mảng block { type:'text', text }.
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('\n');
  }
  const trimmed = text.trim();
  const isError = /^(error|Error|Tool ran|InputValidationError)/.test(trimmed) || /\berror\b/i.test(trimmed.slice(0, 40));
  return { text: clip(trimmed, 240), isError };
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

// ── Quản lý MCP từ UI: list / add / remove (chỉ stdio, ghi vào ~/.claude.json) ──

/** Thông tin MCP trả về UI — CHE token: chỉ liệt kê TÊN các biến env, không kèm value. */
export interface McpInfo {
  name: string;
  command: string;
  args: string[];
  /** Tên các biến env (KHÔNG kèm value — tránh lộ token ra client). */
  envKeys: string[];
  /** false nếu entry không phải stdio (không sửa được qua UI này). */
  stdio: boolean;
}

/** Tên MCP hợp lệ: chữ/số/gạch, không rỗng. */
function isValidMcpName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Che token/secret lẫn trong args trước khi trả về UI. Nhiều MCP nhét secret vào args
 * (vd supabase: `--access-token sbp_xxx`), không chỉ env — nếu trả nguyên là lộ token.
 * Quy tắc: phần tử ĐỨNG SAU một cờ tên nhạy cảm (--token/--key/--secret/--password...),
 * hoặc bản thân trông giống secret (dài + có tiền tố sbp_/sk-/ghp_... hoặc chuỗi dài),
 * đều bị thay bằng '***'.
 */
function maskArgs(args: string[]): string[] {
  const SECRET_FLAG = /(token|key|secret|password|passwd|api[-_]?key|access[-_]?token|auth)/i;
  const SECRET_VALUE = /^(sbp_|sk-|ghp_|gho_|xox[baprs]-|eyJ)/; // tiền tố token phổ biến
  return args.map((a, i) => {
    const prev = i > 0 ? args[i - 1] : '';
    // Đứng sau cờ nhạy cảm (--access-token VALUE) → che.
    if (prev.startsWith('-') && SECRET_FLAG.test(prev)) return '***';
    // Bản thân là cờ dạng --token=VALUE → che phần value.
    if (a.startsWith('-') && SECRET_FLAG.test(a) && a.includes('=')) {
      return `${a.slice(0, a.indexOf('=') + 1)}***`;
    }
    // Trông giống token (tiền tố đặc trưng, hoặc chuỗi dài không có khoảng trắng).
    if (SECRET_VALUE.test(a) || (a.length >= 24 && !a.includes(' ') && !a.startsWith('-') && !a.includes('/'))) {
      return '***';
    }
    return a;
  });
}

/**
 * Đọc TOÀN BỘ ~/.claude.json (không chỉ mcpServers) để khi ghi lại giữ nguyên mọi
 * state khác (userID, cache, toolUsage...). Trả object rỗng nếu file chưa có/hỏng.
 */
function readClaudeJson(): Record<string, unknown> {
  const file = claudeJsonPath();
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/**
 * Ghi lại ~/.claude.json AN TOÀN: backup trước, ghi, rồi validate JSON đọc lại được;
 * nếu hỏng thì khôi phục từ backup và ném lỗi. Không bao giờ để file ở trạng thái hỏng.
 */
function writeClaudeJsonSafely(data: Record<string, unknown>): void {
  const file = claudeJsonPath();
  const serialized = JSON.stringify(data, null, 2);
  // Backup file cũ (nếu có) trước khi ghi đè.
  if (existsSync(file)) {
    copyFileSync(file, `${file}.bak`);
  }
  writeFileSync(file, serialized, 'utf8');
  // Validate: đọc lại phải parse được. Nếu không, rollback từ backup.
  try {
    JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (existsSync(`${file}.bak`)) copyFileSync(`${file}.bak`, file);
    throw new Error(`Ghi ~/.claude.json thất bại, đã khôi phục backup: ${(err as Error).message}`);
  }
}

/** Liệt kê MCP server hiện có (che token). Dùng cho GET /api/mcp. */
export function listGlobalMcp(): McpInfo[] {
  const raw = readGlobalMcp();
  return Object.entries(raw).map(([name, cfg]) => {
    const c = cfg as { command?: string; args?: string[]; env?: Record<string, string>; type?: string };
    const stdio = typeof c.command === 'string';
    return {
      name,
      command: stdio ? c.command! : '',
      args: Array.isArray(c.args) ? maskArgs(c.args) : [],
      envKeys: c.env ? Object.keys(c.env) : [],
      stdio,
    };
  });
}

/**
 * Thêm MCP server (stdio) mới vào ~/.claude.json. Từ chối nếu tên không hợp lệ,
 * command rỗng, hoặc tên đã tồn tại. Env value hỗ trợ `$ENV_VAR` → lấy từ env server.
 */
export function addGlobalMcp(input: {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): void {
  const name = input.name.trim();
  const command = input.command.trim();
  if (!isValidMcpName(name)) {
    throw new Error(`Tên MCP không hợp lệ: "${name}" (chỉ chữ/số/gạch dưới/gạch ngang).`);
  }
  if (!command) {
    throw new Error('Command không được để trống.');
  }

  const data = readClaudeJson();
  const servers = (data.mcpServers as Record<string, unknown>) ?? {};
  if (servers[name]) {
    throw new Error(`MCP "${name}" đã tồn tại. Xóa nó trước nếu muốn cấu hình lại.`);
  }

  // Env: value dạng "$VAR" → thay bằng process.env[VAR] (bỏ nếu không có). Còn lại giữ nguyên.
  const resolvedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (typeof v === 'string' && v.startsWith('$')) {
      const envVal = process.env[v.slice(1)];
      if (envVal !== undefined) resolvedEnv[k] = envVal;
    } else {
      resolvedEnv[k] = String(v);
    }
  }

  servers[name] = {
    type: 'stdio',
    command,
    ...(input.args && input.args.length ? { args: input.args } : {}),
    ...(Object.keys(resolvedEnv).length ? { env: resolvedEnv } : {}),
  };
  data.mcpServers = servers;
  writeClaudeJsonSafely(data);
}

/** Xóa một MCP server khỏi ~/.claude.json. No-op nếu không tồn tại. */
export function removeGlobalMcp(name: string): void {
  const data = readClaudeJson();
  const servers = (data.mcpServers as Record<string, unknown>) ?? {};
  if (!servers[name]) return;
  delete servers[name];
  data.mcpServers = servers;
  writeClaudeJsonSafely(data);
}
