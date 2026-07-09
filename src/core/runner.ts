import {
  query,
  type AgentDefinition,
  type Options,
  type PermissionMode,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';
import { BOW_AGENT_APPEND } from './systemPrompt.js';
import {
  loadClaudeCodeMcp,
  mcpReadToolPatterns,
  describeTool,
  summarizeToolInput,
  summarizeToolResult,
} from '../tools/mcp.js';
import { loadPromptSkills } from '../skills/index.js';
import { deployBundledSkills } from '../skills/agentSkills.js';
import { loadMonorepoContext } from '../skills/monorepo.js';
import { buildMonorepoHooks, buildReadAutoApproveHook } from '../skills/hooks.js';
import { buildSubagents } from './subagents.js';
import {
  resolveWorkspace,
  buildWorkspacePrompt,
  siblingRepoPaths,
  appendJournal,
} from '../profiles/workspace.js';

/** Sự kiện tiến độ agent phát ra — CLI/web tự quyết cách hiển thị. */
export type AgentEvent =
  | { type: 'text'; text: string }
  // `describe` = mô tả người-đọc-được (do backend sinh, xem describeTool). Web hiển thị
  // thẳng chuỗi này nên không cần lặp lại logic mô tả ở frontend.
  // `id` = tool_use id để khớp với 'tool-result' sau đó. `summary` = tham số cốt lõi
  // đã rút gọn (command/file/pattern...) để hiển thị "đã làm gì cụ thể" ở Activity Log.
  | { type: 'tool'; id?: string; name: string; describe: string; summary?: string }
  // Kết quả của một tool (khớp qua toolId) — hiển thị "→ exit 0 / 4 matches / lỗi...".
  | { type: 'tool-result'; toolId: string; text: string; isError: boolean }
  // `durationMs` = tổng thời gian phiên do SDK đo (duration_ms) — bao gồm cả lúc chờ duyệt.
  | { type: 'result'; text: string; turns: number; outputTokens: number; costUsd: number; durationMs: number }
  // Snapshot hạn mức tài khoản + độ dùng context window của phiên hiện tại. Phát ra
  // sau mỗi lượt `result` (đọc qua control request của SDK — xem readUsageSnapshot).
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'error'; subtype: string };

/** Một cửa sổ hạn mức (5 giờ / 7 ngày / theo model) — % đã dùng + thời điểm reset. */
export interface UsageWindow {
  /** Nhãn hiển thị (vd 'Session (5hr)', 'Weekly (7 day)', 'Weekly Fable'). */
  label: string;
  /** % đã dùng của cửa sổ, 0-100 (null nếu không lấy được). */
  utilization: number | null;
  /** Thời điểm cửa sổ reset (ISO 8601), null nếu không có. */
  resetsAt: string | null;
}

/**
 * Snapshot dữ liệu /usage: hạn mức gói claude.ai + độ dùng context window hiện tại.
 * `rateLimits` rỗng khi phiên dùng API key/Bedrock/Vertex (hạn mức gói không áp dụng).
 */
export interface UsageSnapshot {
  /** Các cửa sổ hạn mức tài khoản (Session 5h, Weekly 7d, per-model). */
  rateLimits: UsageWindow[];
  /** Loại gói ('pro' | 'max' | 'team' | 'enterprise') hoặc null (API key/3P). */
  subscriptionType: string | null;
  /** Token đã dùng trong context window của HỘI THOẠI hiện tại (null nếu không đọc được). */
  contextTokens: number | null;
  /** Tổng token tối đa của context window (null nếu không đọc được). */
  contextMaxTokens: number | null;
  /** % context window đã dùng, 0-100 (null nếu không đọc được). */
  contextPercentage: number | null;
}

export interface ApprovalMeta {
  title?: string;
  description?: string;
  blockedPath?: string;
  decisionReason?: string;
}

/** Yêu cầu duyệt một thao tác GHI. Trả true = cho phép, false = từ chối. */
export type ApprovalRequest = (
  toolName: string,
  input: Record<string, unknown>,
  meta?: ApprovalMeta,
) => Promise<boolean>;

/** Một lựa chọn của câu hỏi AskUserQuestion. */
export interface QuestionOption {
  label: string;
  description: string;
}

/** Một câu hỏi agent gửi qua tool AskUserQuestion. */
export interface Question {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

/**
 * Agent hỏi người dùng (tool AskUserQuestion). Trả về map câu-hỏi → câu-trả-lời
 * (đúng shape mà harness kỳ vọng: key là text câu hỏi, value là (các) label đã
 * chọn nối bằng ', '). Trả null = người dùng hủy → tool bị deny.
 */
export type QuestionRequest = (
  questions: Question[],
) => Promise<Record<string, string> | null>;

export interface RunOptions {
  /** Task brief đã chuẩn hóa (từ input layer). */
  brief: string;
  /** Thư mục làm việc — repo mà agent sẽ thao tác. Mặc định cwd hiện tại. */
  cwd: string;
  /**
   * Chế độ quyền (lấy cảm hứng từ Modes của Claude Code):
   * - 'plan'      : chỉ lập kế hoạch, KHÔNG sửa file/chạy lệnh (an toàn nhất). SDK tự chặn tool ghi.
   * - 'manual'    : thực thi, nhưng MỌI thao tác thay đổi/ghi/bash (trừ lệnh test-build an toàn)
   *                 đều hỏi duyệt. (Chính là 'execute' cũ — vẫn nhận 'execute' để tương thích.)
   * - 'edit-auto' : tự duyệt việc SỬA/GHI file TRONG repo; bash & thao tác ngoài repo vẫn hỏi.
   * - 'auto'      : tự duyệt mọi thao tác AN TOÀN (sửa file trong repo + bash không phá hoại),
   *                 CHỈ dừng hỏi ở lệnh/thao tác RỦI RO (rm -rf, git push, ghi ngoài repo…).
   */
  mode: 'plan' | 'manual' | 'edit-auto' | 'auto' | 'execute';
  /** Mức reasoning effort. 'high' hợp cho hầu hết coding/agentic. */
  effort?: Options['effort'];
  /**
   * Ngôn ngữ agent dùng để TRẢ LỜI người dùng (không ảnh hưởng code/comment).
   * 'vi' = Tiếng Việt (mặc định), 'en' = English. Chèn chỉ thị vào system prompt.
   */
  language?: 'vi' | 'en';
  /**
   * Kiến thức dự án (project profile) nhồi vào system prompt — giúp agent viết
   * code khớp pattern của repo. Rỗng = agent tổng quát (chỉ dựa CLAUDE.md của repo).
   */
  projectProfile?: string;
  /**
   * Ảnh đính kèm (wireframe/screenshot) cho agent nhìn. base64 (không kèm data: prefix)
   * + mediaType (vd 'image/png'). Rỗng = không có ảnh.
   */
  images?: { base64: string; mediaType: string }[];

  /**
   * Danh sách MCP servers muốn kích hoạt (tên từ config Claude Code).
   * Rỗng = không dùng MCP.
   */
  mcpServers?: string[];
  /** Nhận sự kiện tiến độ. CLI in ra terminal; web đẩy qua SSE. */
  onEvent: (event: AgentEvent) => void;
  /**
   * Hỏi duyệt một thao tác GHI/RỦI RO (dùng ở mọi mode trừ 'plan'). CLI hỏi y/N trên
   * terminal; web treo Promise chờ nút bấm. Rỗng ở các mode thực thi = tự động cho phép
   * (KHÔNG khuyến nghị — chỉ dùng khi caller cố ý bỏ cổng).
   */
  onApproval?: ApprovalRequest;
  /**
   * Agent hỏi người dùng (tool AskUserQuestion) — hoạt động ở MỌI mode (kể cả
   * plan). Web render UI câu hỏi rồi trả lựa chọn; rỗng = không xử lý, để SDK
   * áp hành vi mặc định (thường là hủy).
   */
  onQuestion?: QuestionRequest;
  /** Tín hiệu hủy (dừng agent giữa chừng). */
  abortSignal?: AbortSignal;
  /**
   * Collab Mode (cộng tác viên qua LAN). Khi bật, chạy như 'auto' nhưng:
   * - Git (commit/push/reset…) được TỰ DO — bỏ khỏi danh sách RỦI RO.
   * - Lệnh HỦY HOẠI còn lại (rm -rf, deploy, ghi ngoài repo…) vẫn qua onApproval,
   *   nhưng caller (web server) định tuyến duyệt đó lên ADMIN chứ không phải CTV.
   * Mode phải là 'auto' để cơ chế này có tác dụng; server đảm bảo điều đó.
   */
  collabMode?: boolean;
  /** Model sử dụng cho agent. */
  model?: string;
  /** ID phiên chạy cũ cần khôi phục lịch sử chat. */
  resumeSessionId?: string;
  /**
   * Nhận session_id THẬT mà SDK dùng để lưu lịch sử (.jsonl) — phát ra từ message
   * `system/init` ngay đầu mỗi lượt query. Caller LƯU id này để lượt sau truyền lại
   * qua resumeSessionId, nhờ đó agent nhớ được toàn bộ hội thoại trước. KHÔNG tự sinh
   * id rồi ép cho SDK — SDK có thể bỏ qua, khiến resume trỏ vào phiên không tồn tại.
   */
  onSessionId?: (sessionId: string) => void;
  /**
   * Bật multi-agent: nhồi bộ subagent chuẩn (reviewer/verifier/impact-scout) vào
   * options.agents để agent chính giao việc qua tool `Agent`. MẶC ĐỊNH TẮT (opt-in):
   * tắt thì runner giữ nguyên single-agent, hành vi không đổi. Subagent đều read-only
   * / chỉ chạy lệnh kiểm chứng — mọi thay đổi thật vẫn do agent chính làm & qua onApproval.
   */
  useSubagents?: boolean;
  /**
   * Subagent riêng của profile (gộp với bộ chuẩn, profile ghi đè nếu trùng tên).
   * Chỉ có tác dụng khi useSubagents = true. Rỗng = chỉ dùng bộ chuẩn.
   */
  profileSubagents?: Record<string, AgentDefinition>;
}
/** Tìm đường dẫn tuyệt đối của binary claude để bypass lỗi spawn của SDK trong môi trường ESM/tsx. */
function findClaudeCodeExecutable(workspaceRoot: string): string | undefined {
  const platform = process.platform;
  const arch = process.arch;
  const exeSuffix = platform === 'win32' ? '.exe' : '';
  const folderSuffix = `${platform}-${arch}`;

  if (platform === 'linux') {
    const paths = [
      `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,
      `@anthropic-ai/claude-agent-sdk-linux-${arch}`
    ];
    for (const p of paths) {
      const fullPath = resolve(workspaceRoot, 'node_modules', p, `claude${exeSuffix}`);
      if (existsSync(fullPath)) return fullPath;
    }
  } else {
    const fullPath = resolve(workspaceRoot, 'node_modules', `@anthropic-ai/claude-agent-sdk-${folderSuffix}`, `claude${exeSuffix}`);
    if (existsSync(fullPath)) return fullPath;
  }

  // Dự phòng: Tìm so với file runner này
  const currentFileDir = dirname(fileURLToPath(import.meta.url));
  const fallbackPath = resolve(currentFileDir, '../../node_modules', `@anthropic-ai/claude-agent-sdk-${folderSuffix}`, `claude${exeSuffix}`);
  if (existsSync(fallbackPath)) return fallbackPath;

  return undefined;
}

/**
 * Chạy agent trên một task brief. Phát sự kiện qua onEvent, hỏi duyệt qua
 * onApproval. Trả text kết quả cuối (hoặc null nếu lỗi/không có kết quả).
 *
 * Lõi này KHÔNG phụ thuộc terminal — CLI và web cùng gọi, chỉ khác cách
 * hiển thị (onEvent) và cách duyệt (onApproval).
 */
export async function runAgent(opts: RunOptions): Promise<string | null> {
  // Cần auth: đã login Claude Code CLI (~/.claude). Agent SDK spawn `claude` dùng login đó.
  if (!config.hasAuth) {
    throw new Error(
      'Chưa đăng nhập Claude CLI. Chạy `claude` rồi /login (dùng gói Claude sẵn có, không cần API key).',
    );
  }

  // Chuẩn hóa mode: 'execute' (tên cũ) → 'manual'. Từ đây chỉ còn 4 mode chuẩn.
  const mode: 'plan' | 'manual' | 'edit-auto' | 'auto' =
    opts.mode === 'execute' ? 'manual' : opts.mode;
  const isExecuting = mode !== 'plan';

  const permissionMode: PermissionMode = mode === 'plan' ? 'plan' : 'default';

  // MCP chỉ nạp các server nằm trong danh sách opts.mcpServers.
  // (1) MCP server từ Claude Code (~/.claude.json): supabase, jira, codemagic...
  const cc = opts.mcpServers && opts.mcpServers.length > 0
    ? loadClaudeCodeMcp(opts.mcpServers)
    : { servers: {}, names: [] as string[] };

  const mcpServers = { ...cc.servers };
  const hasMcp = Object.keys(mcpServers).length > 0;

  // Tool đọc tự cho phép; tool ghi/side-effect mặc định hỏi. Để chạy test/kiểm chứng,
  // agent dùng Bash — đã có cổng SAFE_COMMANDS bên dưới (npm test, flutter test...).
  // Multi-agent (opt-in): bộ subagent chuẩn + subagent riêng profile. Chỉ dựng khi bật.
  const subagents = opts.useSubagents ? buildSubagents(opts.profileSubagents) : undefined;

  const isSafeMode = process.env.BOW_SAFE_MODE === 'true';

  // Các tool ĐỌC được auto-duyệt. KHÔNG đưa chúng (và AskUserQuestion) vào
  // allowedTools: entry "trần" trong allowedTools auto-approve TRƯỚC khi tới
  // canUseTool, khiến SDK cảnh báo CLAUDE_SDK_CAN_USE_TOOL_SHADOWED (callback bị
  // che). Thay vào đó auto-duyệt qua PreToolUse hook (buildReadAutoApproveHook)
  // để mọi tool khác vẫn rơi vào canUseTool. Xem hooks.ts.
  //
  // Safe Mode: KHÔNG auto-duyệt Read/Grep — để chúng rơi vào canUseTool kiểm
  // tra file nhạy cảm / chặn Grep. Glob vẫn auto-duyệt như trước.
  const readAutoTools = [
    ...(isSafeMode ? [] : ['Read', 'Grep']),
    'Glob',
    // Cho agent chính spawn subagent không kẹt cổng duyệt — subagent đều read-only /
    // chỉ chạy lệnh kiểm chứng nên an toàn. Chỉ mở khi bật multi-agent.
    ...(subagents ? ['Agent'] : []),
    ...mcpReadToolPatterns(cc.names), // read tools của MCP Claude Code (write phải duyệt)
  ];
  // allowedTools để rỗng: toàn bộ auto-duyệt read đã chuyển sang PreToolUse hook.
  const allowedTools: string[] = [];

  // System prompt = quy trình chung + skill dùng chung + (nếu có) kiến thức dự án.
  let appendText = BOW_AGENT_APPEND;
  // Ngôn ngữ trả lời người dùng (mặc định Tiếng Việt). Đặt SỚM để ưu tiên cao.
  // Chỉ áp cho văn bản trò chuyện — KHÔNG dịch code, comment, hay tên định danh.
  const langInstruction =
    opts.language === 'en'
      ? '# Response language\n\nAlways respond to the user in English. This applies to your conversational replies only — do not translate code, code comments, or identifiers.'
      : '# Ngôn ngữ trả lời\n\nLuôn trả lời người dùng bằng tiếng Việt. Chỉ áp dụng cho phần trò chuyện — KHÔNG dịch code, comment trong code, hay tên định danh.';
  appendText = `${langInstruction}\n\n---\n\n${appendText}`;
  // Skill prompt-only của bow-agent (skills/prompt/*.md) — áp cho mọi repo.
  const promptSkills = loadPromptSkills();
  if (promptSkills) {
    appendText += `\n\n---\n\n${promptSkills}`;
  }
  // Ngữ cảnh monorepo (CLAUDE.md + danh mục skill) — CHỈ khi cwd là monorepo.
  const monorepoContext = loadMonorepoContext(opts.cwd);
  if (monorepoContext) {
    appendText += `\n\n---\n\n${monorepoContext}`;
  }
  // Workspace (nhóm nhiều repo + trí nhớ tích lũy) — CHỈ khi cwd thuộc một workspace đã
  // đăng ký. Đặt TRƯỚC project profile (chung sản phẩm → riêng repo). Rỗng = opt-out,
  // hành vi y như cũ. Xem DESIGN §9. Giữ tham chiếu để ghi journal cuối phiên.
  const workspace = resolveWorkspace(opts.cwd);
  if (workspace) {
    appendText += `\n\n---\n\n${buildWorkspacePrompt(workspace, opts.cwd)}`;
  }
  if (opts.projectProfile) {
    appendText += `\n\n---\n\n# Kiến thức dự án hiện tại\n\n${opts.projectProfile}`;
  }

  // Lệnh KIỂM CHỨNG an toàn: auto-allow ở MỌI mode thực thi (kể cả 'manual') để agent
  // tự chạy test/analyze/xem trạng thái mà không làm phiền người dùng. Chỉ đọc/không đổi trạng thái.
  const SAFE_COMMANDS = [
    /^fvm flutter analyze/,
    /^fvm flutter test/,
    /^flutter analyze/,
    /^flutter test/,
    /^bun test/,
    /^npm test/,
    /^npm run test/,
    /^(pnpm|yarn) test/,
    /^(pnpm|yarn) run test/,
    /^tsc --noEmit/,
    /^git status/,
    /^git diff/,
  ];

  // Lệnh/mẫu RỦI RO: dù ở mode 'auto' cũng LUÔN hỏi duyệt. Đây là ranh giới an toàn của
  // 'auto' — mọi thứ không khớp mẫu này (mà cũng không nằm ngoài repo) được coi là an toàn.
  // Danh sách bao phủ: xóa dữ liệu, đẩy/viết lại lịch sử git, đổi quyền/chủ sở hữu,
  // tải-rồi-chạy script từ mạng, ghi đè thiết bị, tắt máy, và sudo.
  const RISKY_COMMANDS = [
    /\brm\s+-[a-z]*[rf]/,           // rm -rf / rm -f / rm -r
    /\brmdir\b/,
    /\bgit\s+push\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\b/,
    /\bgit\s+checkout\s+--\s/,       // vứt bỏ thay đổi file
    /\bgit\s+restore\b/,
    /\bgit\s+(rebase|filter-branch)\b/,
    /\bgit\s+.*--force\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /\bsudo\b/,
    /\bmkfs\b/,
    /\bdd\s+if=/,
    /[>|]\s*\/dev\/sd/,
    /\b(shutdown|reboot|halt|poweroff)\b/,
    /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh)\b/, // tải rồi chạy
    /\bnpm\s+publish\b/,
    /\byarn\s+publish\b/,
    /\bkill\s+-9\b/,
    /\bkillall\b/,
    /:\s*\(\s*\)\s*\{.*\}\s*;/,      // fork bomb
  ];

  // Các mẫu RỦI RO thuộc Git — ở Collab Mode được MIỄN (CTV toàn quyền Git). Mọi mẫu
  // hủy hoại khác (rm, dd, deploy, sudo…) vẫn giữ. Nhận diện bằng /\bgit\b/ trong mẫu.
  const GIT_RISKY = new Set(
    RISKY_COMMANDS.filter((re) => /git/.test(re.source)),
  );
  const activeRisky =
    opts.collabMode ? RISKY_COMMANDS.filter((re) => !GIT_RISKY.has(re)) : RISKY_COMMANDS;

  /** True nếu lệnh bash bị coi là rủi ro → luôn qua cổng duyệt ngay cả ở mode 'auto'.
   *  Ở Collab Mode, các lệnh Git đã được loại khỏi danh sách nên tự do chạy. */
  const isRiskyCommand = (cmd: string): boolean =>
    activeRisky.some((re) => re.test(cmd));

  /** Tool sửa/ghi file (trong repo). Ở 'edit-auto'/'auto' được auto-allow nếu đường dẫn nằm trong cwd. */
  const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

  const workdir = resolve(opts.cwd || process.cwd());
  /** True nếu path (từ input tool ghi) nằm TRONG repo cwd — ngoài repo thì coi là rủi ro, phải hỏi. */
  const isPathInRepo = (p: unknown): boolean => {
    if (typeof p !== 'string' || !p) return false;
    const abs = resolve(workdir, p);
    return abs === workdir || abs.startsWith(workdir + '/');
  };

  // Hook monorepo (guard-push/commit, self-verify, githooks) — chỉ khi cwd là monorepo.
  const monorepoHooks = buildMonorepoHooks(opts.cwd);

  // Hợp nhất PreToolUse: hook auto-duyệt read tools (mọi repo) + hook monorepo
  // (guard Bash, chỉ khi là monorepo). Matcher khác nhau nên nối chung vào một
  // mảng PreToolUse không đụng nhau. Đặt read-approve TRƯỚC guard: read tools
  // vô hại, còn guard chỉ nhắm Bash nên thứ tự không ảnh hưởng lẫn nhau.
  const readApproveHooks = buildReadAutoApproveHook(readAutoTools);
  const hooks = {
    ...monorepoHooks,
    ...(readApproveHooks.length > 0
      ? { PreToolUse: [...readApproveHooks, ...(monorepoHooks?.PreToolUse ?? [])] }
      : {}),
  };
  const hasHooks = Object.keys(hooks).length > 0;

  // Trải Agent Skills bundle (vd /watch — xem video) vào <cwd>/.claude/skills/ để SDK
  // auto-discover. Idempotent, không đụng skill người dùng tự đặt. Xem DESIGN §7.2.
  const bundledSkills = deployBundledSkills(opts.cwd);
  if (bundledSkills.length > 0) {
    opts.onEvent({
      type: 'tool',
      name: 'skills',
      describe: `📦 skill sẵn dùng: ${bundledSkills.join(', ')}`,
    });
  }

  const options: Options = {
    model: opts.model ?? config.model,
    effort: opts.effort ?? 'high',
    cwd: opts.cwd,
    permissionMode,
    allowedTools,
    // Bật Agent Skills: SDK tự nạp .claude/skills/* của repo đích (nhờ settingSources
    // 'project' bên dưới) và mở tool 'Skill'. Agent tự chọn skill theo mô tả.
    skills: 'all',
    // Khôi phục phiên chạy cũ nếu có (agent nhớ hội thoại trước). Lượt đầu KHÔNG ép
    // sessionId — để SDK tự sinh id đáng tin, ta bắt lại qua message system/init bên dưới.
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
    // Multi-agent (opt-in): định nghĩa subagent để agent chính giao việc qua tool Agent.
    ...(subagents ? { agents: subagents } : {}),
    ...(hasHooks ? { hooks } : {}),
    pathToClaudeCodeExecutable: findClaudeCodeExecutable(opts.cwd || process.cwd()),
    ...(opts.abortSignal ? { abortController: toController(opts.abortSignal) } : {}),
    ...(hasMcp ? { mcpServers } : {}),
    // Đọc chéo read-only sang repo anh em trong cùng workspace: mở phạm vi Read/Grep/Glob
    // ra ngoài cwd để agent hiểu contract THẬT của BE khi làm FE, không đoán. GHI vào các
    // repo này vẫn bị cổng isPathInRepo chặn (ngoài workdir → luôn hỏi duyệt). Xem DESIGN §9.3.
    ...(workspace && siblingRepoPaths(workspace, opts.cwd).length > 0
      ? { additionalDirectories: siblingRepoPaths(workspace, opts.cwd) }
      : {}),
    // Giữ system prompt gốc của Claude Code + nạp CLAUDE.md của repo, rồi append quy trình + profile.
    systemPrompt: { type: 'preset', preset: 'claude_code', append: appendText },
    settingSources: ['project'],
    // Gắn canUseTool khi cần xử lý câu hỏi (mọi mode) hoặc có cổng duyệt (mọi mode thực thi).
    // AskUserQuestion xử lý riêng ở MỌI mode; tool ghi/bash qua cổng theo policy của từng mode.
    ...(opts.onQuestion || (isExecuting && opts.onApproval) || isSafeMode
      ? {
          canUseTool: async (toolName, input, sdkOpts) => {
            // Kiểm tra truy cập file nhạy cảm trong chế độ an toàn
            if (isSafeMode && (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit')) {
              const target =
                (input as Record<string, unknown>).file_path ??
                (input as Record<string, unknown>).path ??
                (input as Record<string, unknown>).notebook_path;
              
              if (typeof target === 'string') {
                const lowerTarget = target.toLowerCase();
                const isSensitive =
                  lowerTarget.includes('.env') ||
                  lowerTarget.includes('.git/') ||
                  lowerTarget.includes('.git\\') ||
                  lowerTarget.includes('.npmrc') ||
                  lowerTarget.includes('.pypirc') ||
                  lowerTarget.endsWith('.pem') ||
                  lowerTarget.endsWith('.key') ||
                  lowerTarget.endsWith('.p12') ||
                  lowerTarget.endsWith('.jks') ||
                  lowerTarget.includes('id_rsa') ||
                  lowerTarget.includes('id_ed25519') ||
                  lowerTarget.includes('.aws/') ||
                  lowerTarget.includes('.kube/');
                
                if (isSensitive) {
                  return {
                    behavior: 'deny' as const,
                    message: 'Truy cập bị chặn: Không được phép đọc/ghi file cấu hình nhạy cảm trong Safe Mode.',
                  };
                }
              }
            }

            if (isSafeMode && toolName === 'Grep') {
              return {
                behavior: 'deny' as const,
                message: 'Grep bị vô hiệu hóa trong Safe Mode để bảo mật dữ liệu nhạy cảm. Vui lòng sử dụng Glob + Read.',
              };
            }
            // AskUserQuestion: render UI câu hỏi, gắn câu trả lời vào input trả cho agent.
            if (toolName === 'AskUserQuestion' && opts.onQuestion) {
              const questions = Array.isArray((input as { questions?: unknown }).questions)
                ? ((input as { questions: Question[] }).questions)
                : [];
              const answers = await opts.onQuestion(questions);
              if (answers === null) {
                return {
                  behavior: 'deny' as const,
                  message: 'Người dùng đã huỷ câu hỏi. Hãy hỏi lại theo hướng khác hoặc tiếp tục.',
                };
              }
              // Chèn answers vào input — harness đọc field này để dựng tool_result.
              return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
            }

            const allow = { behavior: 'allow' as const, updatedInput: input };

            // Không ở chế độ duyệt (vd plan mode, hoặc caller cố ý bỏ cổng): cho phép.
            // (Plan mode đã tự chặn tool ghi trước khi tới canUseTool.)
            if (!(isExecuting && opts.onApproval)) return allow;

            // ── Phân loại thao tác theo mode ─────────────────────────────────
            // Quy tắc chung: hỏi duyệt qua gate() nếu policy yêu cầu; ngược lại auto-allow.
            const gate = async (meta?: {
              title?: string;
              description?: string;
              blockedPath?: string;
              decisionReason?: string;
            }) => {
              const approved = await opts.onApproval!(toolName, input, {
                title: meta?.title ?? sdkOpts?.title,
                description: meta?.description ?? sdkOpts?.description,
                blockedPath: meta?.blockedPath ?? sdkOpts?.blockedPath,
                decisionReason: meta?.decisionReason ?? sdkOpts?.decisionReason,
              });
              return approved
                ? allow
                : {
                    behavior: 'deny' as const,
                    message: 'Người dùng từ chối thao tác này. Dừng lại và hỏi hướng khác.',
                  };
            };

            // Bash: lệnh kiểm chứng an toàn → auto-allow ở mọi mode. Lệnh rủi ro → luôn hỏi.
            // Còn lại: 'auto' auto-allow, các mode khác hỏi.
            if (toolName === 'Bash' && typeof input.command === 'string') {
              const cmd = input.command.trim();
              if (SAFE_COMMANDS.some((re) => re.test(cmd))) return allow;
              if (isRiskyCommand(cmd)) {
                return gate({ decisionReason: 'Lệnh có thể gây hại/không thể hoàn tác — cần bạn xác nhận.' });
              }
              return mode === 'auto' ? allow : gate();
            }

            // Sửa/ghi file: 'edit-auto' & 'auto' tự duyệt NẾU file nằm TRONG repo.
            // Ghi ra ngoài repo luôn phải hỏi (kể cả 'auto'). 'manual' luôn hỏi.
            if (FILE_WRITE_TOOLS.has(toolName)) {
              const target =
                (input as Record<string, unknown>).file_path ??
                (input as Record<string, unknown>).path ??
                (input as Record<string, unknown>).notebook_path;
              const inRepo = isPathInRepo(target);
              if ((mode === 'edit-auto' || mode === 'auto') && inRepo) return allow;
              if ((mode === 'edit-auto' || mode === 'auto') && !inRepo) {
                return gate({ decisionReason: 'Ghi file NGOÀI thư mục repo — cần bạn xác nhận.' });
              }
              return gate(); // manual
            }

            // Mọi tool ghi/side-effect còn lại (MCP write, v.v.): 'auto' tự duyệt, khác thì hỏi.
            return mode === 'auto' ? allow : gate();
          },
        }
      : {}),
  };

  const modeInstruction: Record<typeof mode, string> = {
    plan: 'Hãy HIỂU và LẬP KẾ HOẠCH chi tiết cho task trên (không sửa file). Trình bày kế hoạch để tôi duyệt.',
    manual:
      'Hãy thực hiện task trên theo quy trình. Xin duyệt trước MỌI thao tác thay đổi trạng thái (sửa file, chạy lệnh).',
    'edit-auto':
      'Hãy thực hiện task trên theo quy trình. Bạn được tự sửa file trong repo mà không cần hỏi; nhưng xin duyệt trước khi chạy lệnh bash hoặc thao tác ngoài repo.',
    auto:
      'Hãy thực hiện task trên theo quy trình một cách tự chủ. Bạn được tự sửa file trong repo và chạy các lệnh an toàn; chỉ dừng hỏi trước thao tác rủi ro/không thể hoàn tác (xóa dữ liệu, git push, ghi ngoài repo…).',
  };
  const promptText = `${opts.brief}\n\n---\n${modeInstruction[mode]}`;

  // Nội dung message user đầu tiên: chỉ text, hoặc text + ảnh (wireframe/screenshot).
  const firstContent: MessageParam['content'] =
    opts.images && opts.images.length > 0
      ? [
          { type: 'text', text: promptText },
          ...opts.images.map(
            (img) =>
              ({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: img.mediaType as
                    | 'image/png'
                    | 'image/jpeg'
                    | 'image/gif'
                    | 'image/webp',
                  data: img.base64,
                },
              }) as const,
          ),
        ]
      : promptText;

  // Dùng streaming input (giữ mở đến khi query xong) THAY VÌ prompt string, vì các
  // control request đọc hạn mức/context (query.getContextUsage / usage_EXPERIMENTAL…)
  // CHỈ hoạt động ở chế độ streaming input. inputDone giải phóng generator khi ta đã
  // đọc xong snapshot, để SDK đóng transport gọn gàng.
  let releaseInput: () => void = () => {};
  const inputDone = new Promise<void>((r) => {
    releaseInput = r;
  });
  const prompt = streamingPrompt(firstContent, inputDone);

  let finalText: string | null = null;

  const q = query({ prompt, options });
  try {
  for await (const message of q) {
    switch (message.type) {
      case 'system': {
        // system/init phát ngay đầu mỗi lượt, mang session_id THẬT mà SDK dùng để lưu
        // lịch sử. Báo ra ngoài để caller lưu → lượt sau resume đúng phiên (agent nhớ).
        if (message.subtype === 'init') {
          opts.onSessionId?.(message.session_id);
        }
        break;
      }
      case 'assistant': {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            opts.onEvent({ type: 'text', text: block.text.trim() });
          } else if (block.type === 'tool_use') {
            let describe = describeTool(block.name);
            if (block.name === 'Agent' && block.input && typeof block.input === 'object' && 'agent' in block.input) {
              describe = `🤖 giao việc cho agent phụ: ${block.input.agent}…`;
            }
            opts.onEvent({
              type: 'tool',
              id: block.id,
              name: block.name,
              describe,
              summary: summarizeToolInput(block.name, block.input),
            });
          }
        }
        break;
      }
      case 'user': {
        // Message 'user' do SDK sinh mang tool_result — khớp về tool đã gọi để hiển thị
        // "→ kết quả". content có thể là chuỗi hoặc mảng block.
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const { text, isError } = summarizeToolResult(block.content);
              if (text) {
                opts.onEvent({
                  type: 'tool-result',
                  toolId: block.tool_use_id,
                  text,
                  isError: isError || block.is_error === true,
                });
              }
            }
          }
        }
        break;
      }
      case 'result': {
        const success = message.subtype === 'success';
        if (success) {
          finalText = message.result;
          opts.onEvent({
            type: 'result',
            text: message.result,
            turns: message.num_turns,
            outputTokens: message.usage.output_tokens,
            costUsd: message.total_cost_usd,
            durationMs: message.duration_ms,
          });
        } else {
          opts.onEvent({ type: 'error', subtype: message.subtype });
        }
        // Đọc snapshot hạn mức + context ngay khi query CÒN SỐNG (control request cần
        // transport chưa đóng). Lỗi/không hỗ trợ → bỏ qua, không chặn kết thúc lượt.
        const usage = await readUsageSnapshot(q);
        if (usage) opts.onEvent({ type: 'usage', usage });
        // Giải phóng streaming input → SDK kết thúc query, vòng for..of thoát.
        releaseInput();
        break;
      }
      // Các message type khác (stream_event, system, ...) bỏ qua cho gọn.
    }
  }
  } finally {
    // Luôn giải phóng streaming input (kể cả khi lỗi/abort giữa chừng, chưa tới
    // 'result') để generator không treo vô hạn giữ query sống.
    releaseInput();
  }

  // Trí nhớ tích lũy: cuối phiên (nếu cwd thuộc workspace & chạy thành công) cô đọng
  // finalText — vốn đã có cấu trúc "đã đổi gì / verify gì / còn gì" theo BOW_AGENT_APPEND —
  // rồi APPEND vào journal.md. Cách "rẻ" của DESIGN §9.4: KHÔNG tốn thêm lượt model. Chỉ
  // ghi ở mode thực thi (mode 'plan' chưa đổi gì, không đáng ghi nhật ký). Fail-open: lỗi
  // ghi journal không được kéo sập kết quả phiên.
  if (workspace && isExecuting && finalText && finalText.trim()) {
    try {
      appendJournal(workspace, condenseForJournal(finalText, opts.brief), new Date().toISOString());
    } catch {
      // Bỏ qua — ghi nhật ký chỉ là phụ trợ, không được ảnh hưởng luồng chính.
    }
  }

  return finalText;
}

/**
 * Cô đọng báo cáo-khi-xong của agent thành một mục journal ngắn. Bản "rẻ" (§9.4): dùng
 * chính finalText, thêm một dòng ngữ cảnh task ở đầu, cắt tới ngưỡng để journal không
 * phình. Không gọi model. Nếu sau này ra nhiễu có thể thay bằng một query() phụ tóm tắt.
 */
const JOURNAL_ENTRY_MAX_CHARS = 2000;
function condenseForJournal(finalText: string, brief: string): string {
  const taskLine = brief.split('\n').find((l) => l.trim())?.trim() ?? '';
  const header = taskLine ? `**Task:** ${taskLine.slice(0, 200)}\n\n` : '';
  let body = finalText.trim();
  if (header.length + body.length > JOURNAL_ENTRY_MAX_CHARS) {
    body = body.slice(0, JOURNAL_ENTRY_MAX_CHARS - header.length - 1).trimEnd() + '…';
  }
  return header + body;
}

/**
 * Streaming input tối giản: yield 1 message user rồi GIỮ MỞ đến khi `done` resolve.
 * Giữ mở là điều kiện để các control request (getContextUsage / usage) chạy được —
 * ở prompt string, transport đóng ngay nên control request báo lỗi "Query closed".
 */
async function* streamingPrompt(
  content: MessageParam['content'],
  done: Promise<void>,
): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: '',
  } as SDKUserMessage;
  await done;
}

/** Chuyển một cửa sổ rate-limit của SDK → UsageWindow (bỏ qua nếu thiếu). */
function toWindow(
  label: string,
  win: { utilization: number | null; resets_at: string | null } | null | undefined,
): UsageWindow | null {
  if (!win) return null;
  return { label, utilization: win.utilization, resetsAt: win.resets_at };
}

/**
 * Đọc snapshot /usage từ query đang sống: hạn mức gói (5h / 7 ngày / theo model) +
 * độ dùng context window của hội thoại hiện tại. Trả null nếu SDK không hỗ trợ hoặc
 * lỗi (vd đã đóng) — caller chỉ đơn giản không phát event 'usage'.
 */
async function readUsageSnapshot(q: {
  getContextUsage: () => Promise<{
    totalTokens: number;
    maxTokens: number;
    percentage: number;
  }>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise<{
    subscription_type: string | null;
    rate_limits: {
      five_hour?: { utilization: number | null; resets_at: string | null } | null;
      seven_day?: { utilization: number | null; resets_at: string | null } | null;
      model_scoped?: {
        display_name: string;
        utilization: number | null;
        resets_at: string | null;
      }[];
    } | null;
  }>;
}): Promise<UsageSnapshot | null> {
  try {
    const [ctx, usage] = await Promise.all([
      q.getContextUsage().catch(() => null),
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET().catch(() => null),
    ]);
    if (!ctx && !usage) return null;

    const rateLimits: UsageWindow[] = [];
    const rl = usage?.rate_limits;
    if (rl) {
      const five = toWindow('Session (5hr)', rl.five_hour);
      if (five) rateLimits.push(five);
      const seven = toWindow('Weekly (7 day)', rl.seven_day);
      if (seven) rateLimits.push(seven);
      for (const m of rl.model_scoped ?? []) {
        rateLimits.push({
          label: `Weekly ${m.display_name}`,
          utilization: m.utilization,
          resetsAt: m.resets_at,
        });
      }
    }

    return {
      rateLimits,
      subscriptionType: usage?.subscription_type ?? null,
      contextTokens: ctx?.totalTokens ?? null,
      contextMaxTokens: ctx?.maxTokens ?? null,
      contextPercentage: ctx?.percentage ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Đọc snapshot /usage ĐỘC LẬP (không gắn với lượt chạy agent nào) — dùng cho UI
 * hiển thị hạn mức lúc mới mở trang / bấm làm mới. Mở một query streaming tối giản
 * (không tốn token của model: chỉ cần transport sống để chạy control request), đọc
 * snapshot rồi đóng. `contextTokens` ở đây phản ánh phiên trống này, KHÔNG phải hội
 * thoại thực — UI chỉ nên lấy phần rateLimits từ đây; context lấy từ event trong lượt chạy.
 */
export async function fetchUsageSnapshot(model?: string): Promise<UsageSnapshot | null> {
  if (!config.hasAuth) return null;
  let release: () => void = () => {};
  const done = new Promise<void>((r) => {
    release = r;
  });
  // Prompt tối giản: chỉ để SDK khởi tạo session & mở transport. Ta KHÔNG chờ 'result'
  // (tránh gọi model) — đọc snapshot ngay sau 'system/init' rồi đóng.
  const q = query({
    prompt: streamingPrompt('.', done),
    options: {
      model: model ?? config.model,
      permissionMode: 'plan',
      pathToClaudeCodeExecutable: findClaudeCodeExecutable(process.cwd()),
    },
  });
  try {
    for await (const message of q) {
      if (message.type === 'system' && message.subtype === 'init') {
        const snap = await readUsageSnapshot(q);
        release();
        return snap;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    release();
  }
}

/** Bắc cầu AbortSignal → AbortController mà SDK nhận. */
function toController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}
