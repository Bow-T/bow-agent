import {
  query,
  type AgentDefinition,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
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
import { deployCoreSkills, deployExternalSkills, type ExternalDeployResult } from '../skills/externalSkills.js';
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
  // Phiên kết thúc bất thường. `isSessionLimit` = do hết hạn mức phiên (5h) — kèm `resetsAt`
  // (ISO) là thời điểm hạn mức reset, để caller LÊN LỊCH tự chạy tiếp. Lỗi thường thì hai
  // field này vắng.
  | { type: 'error'; subtype: string; isSessionLimit?: boolean; resetsAt?: string | null };

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
  /**
   * MCP RIÊNG của user (đã resolve kèm token) — overlay LÊN MCP chung. Trùng tên thì bản
   * này thắng. Rỗng = không có MCP riêng. (Nguồn: src/web/userMcp.ts theo user.id.)
   */
  userMcpServers?: Record<string, McpServerConfig>;
  /**
   * Stack skill EXTERNAL người dùng chọn (id trong skills/registry.json, vd
   * `react-native-supabase`). Khi có, bow tải bộ skill của stack từ repo GitHub đã ghim tag
   * rồi trải vào <cwd>/.claude/skills/ để agent dùng. Rỗng = chỉ skill nội bộ. Xem externalSkills.ts.
   */
  stack?: string;
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
   * Collab Mode (cộng tác viên qua LAN). Khi bật, mode chạy là 'auto' nhưng an toàn
   * được siết bằng requireApprovalForWrites (xem dưới) chứ không tự do như dev thường.
   * Caller (web server) định tuyến mọi yêu cầu duyệt lên ADMIN qua onApproval.
   */
  collabMode?: boolean;
  /**
   * BA Mode (Business Analyst qua LAN). Chạy 'auto' nhưng phân quyền theo ĐÍCH ghi:
   *  - ĐỌC repo (Read/Grep/Glob), WebSearch/WebFetch, Jira (cả read lẫn write) → cho phép.
   *  - GHI FILE: chỉ tài liệu (docs/, *.md/*.mdx/*.txt) → cho phép; source code / file khác
   *    (.ts/.dart/.sql/.js…) → DENY CỨNG (không phải hỏi duyệt).
   *  - MCP write ngoài Jira (execute_sql, apply_migration…), deploy, lệnh huỷ hoại → DENY.
   * Khác Safe (read-only tuyệt đối) và Collab (ghi code, gác dangerous chờ admin duyệt).
   */
  baMode?: boolean;
  /**
   * DevOps Mode (Triển khai & Hạ tầng qua LAN). Chạy 'auto' nhưng phân quyền theo ĐÍCH ghi:
   *  - ĐỌC repo (Read/Grep/Glob), WebSearch/WebFetch → cho phép.
   *  - GHI FILE: chỉ file HẠ TẦNG (Dockerfile, docker-compose*, .github/workflows/*, *.tf/*.tfvars/
   *    *.hcl, k8s/Helm manifests, .gitlab-ci.yml/Jenkinsfile…) + tài liệu vận hành (*.md) → cho phép;
   *    source code ứng dụng (.ts/.tsx/.dart/.py…) → DENY CỨNG (không đổi logic app).
   *  - LỆNH DEPLOY/APPLY (terraform apply, docker push, kubectl apply, gh workflow run…) và các
   *    lệnh RỦI RO khác: KHÔNG deny cứng mà ĐỊNH TUYẾN duyệt lên admin (requireApprovalForWrites).
   *  - MCP write ngoài đọc (execute_sql, apply_migration…): theo cổng duyệt chung (không mở riêng).
   * Khác BA (deploy DENY cứng) và Collab (ghi code tự do): DevOps mở hạ tầng, khoá source.
   */
  devopsMode?: boolean;
  /**
   * SIẾT DUYỆT GHI (M1–M5). Khi TRUE, MỌI thao tác ghi/side-effect đều phải qua onApproval
   * kể cả ở mode 'auto': ghi/sửa file (cả trong repo), lệnh Bash không-safe, MCP write.
   * Chỉ lệnh SAFE_COMMANDS đơn thuần (đọc/kiểm chứng) mới auto-allow. Dùng cho client
   * KHÔNG phải admin (Collab CTV, hoặc khách LAN nếu server cho phép ghi) — caller định
   * tuyến duyệt lên admin. Admin (localhost) chạy trực tiếp thì để FALSE → auto như cũ.
   */
  requireApprovalForWrites?: boolean;
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

  // (2) MCP RIÊNG của user: overlay SAU cc → trùng tên thì bản của user ghi đè bản chung.
  const userMcp = opts.userMcpServers ?? {};
  const mcpServers = { ...cc.servers, ...userMcp };
  const hasMcp = Object.keys(mcpServers).length > 0;
  // Tên tất cả MCP thực sự nạp (chung + riêng) — dùng để cấp read-auto-approve.
  const mcpNames = Object.keys(mcpServers);

  // Tool đọc tự cho phép; tool ghi/side-effect mặc định hỏi. Để chạy test/kiểm chứng,
  // agent dùng Bash — đã có cổng SAFE_COMMANDS bên dưới (npm test, flutter test...).
  // Multi-agent (opt-in): bộ subagent chuẩn + subagent riêng profile. Chỉ dựng khi bật.
  const subagents = opts.useSubagents ? buildSubagents(opts.profileSubagents) : undefined;

  // QC Mode (trước đây tên "Safe Mode"): read-only cho QC hỏi đáp, NHƯNG mở tool Skill
  // (chạy qc-triage…) + Jira read/write (comment kết luận, transition ticket). Bật qua env
  // BOW_QC_MODE (server đặt khi chạy `npm run ui:qc`). Không còn nhận tên env cũ BOW_SAFE_MODE.
  const isQcMode = process.env.BOW_QC_MODE === 'true';
  // Reviewer Mode: cho Tech Lead/Reviewer review PR GitHub + diff local. Read-only source NHƯNG
  // mở tool Skill (pr-review), chạy git/gh đọc + `gh pr comment`/`gh pr review` (comment/approve
  // PR), test/analyze để kiểm, và Jira READ (đối chiếu ticket). DENY sửa code/merge/push/deploy.
  // Bật qua env BOW_REVIEWER_MODE (server đặt khi chạy `npm run ui:review`).
  const isReviewerMode = process.env.BOW_REVIEWER_MODE === 'true';
  // BA Mode: bật khi caller (web) truyền opts.baMode. Đọc từ opts (KHÔNG từ env) để phân
  // quyền theo target trong canUseTool. Xem opts.baMode ở RunOptions.
  const isBaMode = opts.baMode === true;
  // DevOps Mode: bật khi caller (web) truyền opts.devopsMode. Như BA — phân quyền theo ĐÍCH
  // ghi (hạ tầng ✅ / source ❌) — NHƯNG khác BA ở lệnh deploy/apply: BA DENY cứng, DevOps
  // ĐỊNH TUYẾN duyệt lên admin (requireApprovalForWrites) vì deploy là việc HỢP LỆ của vai này.
  // Xem opts.devopsMode ở RunOptions + khối `if (isDevOpsMode)` trong canUseTool.
  const isDevOpsMode = opts.devopsMode === true;

  // Các tool ĐỌC được auto-duyệt. KHÔNG đưa chúng (và AskUserQuestion) vào
  // allowedTools: entry "trần" trong allowedTools auto-approve TRƯỚC khi tới
  // canUseTool, khiến SDK cảnh báo CLAUDE_SDK_CAN_USE_TOOL_SHADOWED (callback bị
  // che). Thay vào đó auto-duyệt qua PreToolUse hook (buildReadAutoApproveHook)
  // để mọi tool khác vẫn rơi vào canUseTool. Xem hooks.ts.
  //
  // QC/Reviewer/DevOps Mode: KHÔNG auto-duyệt Read/Grep — để chúng rơi vào canUseTool kiểm
  // tra file nhạy cảm (DevOps chặn đọc .env/key/credentials như QC/Reviewer). Glob vẫn auto-duyệt.
  const readAutoTools = [
    ...(isQcMode || isReviewerMode || isDevOpsMode ? [] : ['Read', 'Grep']),
    'Glob',
    // Cho agent chính spawn subagent không kẹt cổng duyệt — subagent đều read-only /
    // chỉ chạy lệnh kiểm chứng nên an toàn. Chỉ mở khi bật multi-agent.
    ...(subagents ? ['Agent'] : []),
    ...mcpReadToolPatterns(mcpNames), // read tools của MCP (chung + riêng user); write phải duyệt
  ];
  // allowedTools để rỗng: toàn bộ auto-duyệt read đã chuyển sang PreToolUse hook.
  const allowedTools: string[] = [];

  // R1: WHITELIST tool cho QC Mode (read-only + Skill + Jira). Chỉ các tool ĐỌC (và Skill,
  // Jira write — xử lý riêng trong canUseTool) mới được chạy; canUseTool DENY mọi tool khác
  // (kể cả MCP write execute_sql, ghi file source, Bash, Web*). Gồm: đọc file/liệt kê
  // (Read/Glob/NotebookRead), spawn subagent read-only (nếu bật), MCP READ pattern đã lọc, và
  // 'Skill' để agent kích hoạt qc-triage (Skill chỉ NẠP hướng dẫn vào ngữ cảnh — mọi tool mà
  // skill gọi bên trong vẫn phải qua chính whitelist này, nên không mở thêm kênh ghi nào).
  // AskUserQuestion + Jira write xử lý riêng dưới. Grep bị tắt riêng (lộ nội dung file).
  const QC_MODE_ALLOWED_TOOLS = new Set<string>([
    'Read',
    'Glob',
    'NotebookRead',
    'TodoWrite',
    'Skill',
    ...(subagents ? ['Agent'] : []),
    ...mcpReadToolPatterns(mcpNames), // read tools của MCP (chung + riêng user)
  ]);

  // R1: WHITELIST tool cho Reviewer Mode (review PR/diff — read-only source). Giống QC NHƯNG
  // thêm 'Bash' để chạy git/gh (đọc PR + `gh pr comment`/`gh pr review`) + test/analyze — nội
  // dung LỆNH Bash lọc riêng trong canUseTool (isReviewGhCommand + SAFE_COMMANDS, chặn risky/
  // chaining). Jira chỉ READ (mcpReadToolPatterns), KHÔNG mở Jira write. DENY ghi file source.
  const REVIEWER_MODE_ALLOWED_TOOLS = new Set<string>([
    'Read',
    'Glob',
    'NotebookRead',
    'TodoWrite',
    'Skill',
    'Bash',
    ...(subagents ? ['Agent'] : []),
    ...mcpReadToolPatterns(mcpNames),
  ]);

  // ── TẢI SKILL từ GitHub (bow-agent là KHUNG RỖNG, không còn skills/ nội bộ) ─────────────
  // Phải chạy SỚM: promptText của core + monorepoDir/hooksDir của stack đều cần cho system
  // prompt (dưới) và hooks (xa hơn dưới). Cả hai fail-open — offline/lỗi chỉ log, agent vẫn chạy.
  // CORE: luôn tải (watch, qc-triage, coding-convention). Trải skill kèm code + trả prompt-only.
  const core = deployCoreSkills(opts.cwd);
  if (core.error) {
    opts.onEvent({ type: 'tool', name: 'skills', describe: `⚠️ core skill chưa tải được (${core.error}) — chạy thiếu quy ước chung` });
  } else if (core.skills.length > 0) {
    opts.onEvent({ type: 'tool', name: 'skills', describe: `📦 skill sẵn dùng: ${core.skills.join(', ')}` });
  }
  // STACK: user chọn ở dropdown. Các mode vai trò TỰ nạp stack tương ứng nếu user chưa chọn:
  // BA→'ba' (nghiệp vụ BA), QC→'qc' (qc-triage), Reviewer→'review' (pr-review), DevOps→'devops'
  // (quy ước hạ tầng) — để vào ui:ba/ui:qc/ui:review/ui:devops là có skill ngay, khỏi phải chọn
  // tay. Cả bốn đều không khai monorepoDir nên không ảnh hưởng ngữ cảnh monorepo/hooks bên dưới.
  const effectiveStack =
    opts.stack ||
    (isBaMode ? 'ba' : isQcMode ? 'qc' : isReviewerMode ? 'review' : isDevOpsMode ? 'devops' : '');
  const ext: ExternalDeployResult | null = effectiveStack ? deployExternalSkills(effectiveStack, opts.cwd) : null;
  if (ext?.error) {
    opts.onEvent({ type: 'tool', name: 'skills', describe: `⚠️ skill stack "${ext.stack.label || effectiveStack}": ${ext.error}` });
  } else if (ext && ext.skills.length > 0) {
    opts.onEvent({ type: 'tool', name: 'skills', describe: `📦 skill stack ${ext.stack.label} (${ext.stack.ref}): ${ext.skills.join(', ')}` });
  }

  // System prompt = quy trình chung + skill dùng chung + (nếu có) kiến thức dự án.
  let appendText = BOW_AGENT_APPEND;
  // Ngôn ngữ trả lời người dùng (mặc định Tiếng Việt). Đặt SỚM để ưu tiên cao.
  // Chỉ áp cho văn bản trò chuyện — KHÔNG dịch code, comment, hay tên định danh.
  const langInstruction =
    opts.language === 'en'
      ? '# Response language\n\nAlways respond to the user in English. This applies to your conversational replies only — do not translate code, code comments, or identifiers.'
      : '# Ngôn ngữ trả lời\n\nLuôn trả lời người dùng bằng tiếng Việt. Chỉ áp dụng cho phần trò chuyện — KHÔNG dịch code, comment trong code, hay tên định danh.';
  appendText = `${langInstruction}\n\n---\n\n${appendText}`;
  // Skill prompt-only (coding-convention…) từ repo CORE đã clone — áp cho mọi repo.
  if (core.promptText) {
    appendText += `\n\n---\n\n${core.promptText}`;
  }
  // Ngữ cảnh monorepo (CLAUDE.md + danh mục skill) — CHỈ khi cwd là monorepo VÀ stack (flutter)
  // cấp monorepoDir. Nguồn từ bản clone stack, không còn skills/monorepo/ nội bộ.
  const monorepoContext = loadMonorepoContext(opts.cwd, ext?.monorepoDir ?? '');
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
  //
  // QUAN TRỌNG (M1): các mẫu đều neo CẢ đầu `^` LẪN cuối `$` (cho phép cờ/đối số vô hại
  // sau đó, nhưng KHÔNG cho toán tử nối lệnh). Fast-path 'safe' chỉ áp cho lệnh ĐƠN —
  // hàm hasCommandChaining() bên dưới chặn mọi chuỗi `a; b`, `a && b`, `a | b`… trước khi
  // xét SAFE, để `npm test; rm -rf ~` KHÔNG lọt qua như trước.
  const SAFE_COMMANDS = [
    /^fvm flutter analyze(\s+[\w./@=-]+)*$/,
    /^fvm flutter test(\s+[\w./@=-]+)*$/,
    /^flutter analyze(\s+[\w./@=-]+)*$/,
    /^flutter test(\s+[\w./@=-]+)*$/,
    /^bun test(\s+[\w./@=-]+)*$/,
    /^npm test(\s+[\w./@=-]+)*$/,
    /^npm run test(\s+[\w./@=-]+)*$/,
    /^(pnpm|yarn) test(\s+[\w./@=-]+)*$/,
    /^(pnpm|yarn) run test(\s+[\w./@=-]+)*$/,
    /^tsc --noEmit$/,
    /^git status(\s+[\w./@=-]+)*$/,
    /^git diff(\s+[\w./@=-]+)*$/,
  ];

  /** Lệnh có TOÁN TỬ NỐI (chuỗi lệnh) → KHÔNG được đi fast-path 'safe'/'auto': phải xét
   *  rủi ro từng phần / hỏi duyệt. Bắt: ; | & (kể cả && ||), backtick, $( ), newline, và
   *  redirect ghi >/>>. Đây là chốt chặn M1 — trước đây `npm test; rm -rf ~` khớp tiền tố
   *  `npm test` rồi auto-allow trước khi kịp xét `rm -rf`. */
  const hasCommandChaining = (cmd: string): boolean =>
    /[;&|`\n]|\$\(|>|<\(/.test(cmd);

  // Lệnh/mẫu RỦI RO: dù ở mode 'auto' cũng LUÔN hỏi duyệt. Đây là ranh giới an toàn của
  // 'auto' — mọi thứ không khớp mẫu này (mà cũng không nằm ngoài repo) được coi là an toàn.
  // Danh sách bao phủ: xóa dữ liệu, đẩy/viết lại lịch sử git, đổi quyền/chủ sở hữu,
  // tải-rồi-chạy script từ mạng, ghi đè thiết bị, tắt máy, và sudo.
  //
  // M3: danh sách được MỞ RỘNG để bịt các đường xóa/ghi-đè/exfil từng lọt trước đây —
  // rm không cờ, find -delete/-exec, truncate/shred, redirect ghi đè `> file`, mv/cp file
  // nhạy cảm, tạo symlink (ln -s), và chạy script inline (node -e / python -c / sh file /
  // pipe vào bash). Regex không thể phủ MỌI biến thể shell; đây là mạng lưới rộng hợp lý,
  // và mọi thứ không khớp mà nằm NGOÀI repo vẫn bị chặn bởi isPathInRepo ở nhánh file-write.
  // R7: các lệnh xóa/di chuyển/ghi neo vào ĐẦU-TOKEN LỆNH (đầu chuỗi hoặc sau khoảng
  // trắng/;/&/|/( ) và kết bằng ranh giới, tránh khớp nhầm hậu tố như 'npm run rm-cache',
  // 'my-cp-tool', 'env-mv' (dấu '-' là \b nên \brm\b từng khớp oan).
  const RISKY_COMMANDS = [
    /(?:^|[\s;&|(])rm(?=$|[\s/])/,          // rm (kể cả không cờ) — xóa là luôn phải hỏi
    /(?:^|[\s;&|(])rmdir(?=$|[\s/])/,
    /(?:^|[\s;&|(])unlink(?=$|[\s/])/,
    /\bfind\b[^\n]*-(delete|exec|execdir)\b/, // find … -delete / -exec rm …
    /(?:^|[\s;&|(])(truncate|shred|srm|wipe)(?=$|[\s/])/,
    /(?:^|[\s;&|(])ln\s+-s/,         // symlink (chặn M4 tận gốc — không tạo được symlink lách sandbox)
    /(^|[^0-9<>])>>?\s*[^\s&|;]/,    // redirect ghi/ghi-nối `> file`, `>> file` (bỏ qua 2> dạng số)
    /(?:^|[\s;&|(])tee(?=$|[\s/])/,  // tee ghi đè file
    /(?:^|[\s;&|(])mv(?=$|[\s/])/,
    /(?:^|[\s;&|(])cp(?=$|[\s/])/,
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
    /\bdd\b/,
    /[>|]\s*\/dev\/sd/,
    /\b(shutdown|reboot|halt|poweroff)\b/,
    /\b(curl|wget|fetch)\b[^\n]*\|\s*(sh|bash|zsh|python3?|node)\b/, // tải rồi chạy
    /\|\s*(sh|bash|zsh)\b/,          // pipe bất kỳ vào shell (cat evil | bash)
    /\b(node|deno|bun)\s+-e\b/,      // chạy script JS inline
    /\bpython3?\s+-c\b/,             // chạy script Python inline
    /\b(bash|sh|zsh)\s+[^\s-]/,      // sh/bash chạy file script
    /\bnpm\s+publish\b/,
    /\byarn\s+publish\b/,
    /\bkill\s+-9\b/,
    /\bkillall\b/,
    /:\s*\(\s*\)\s*\{.*\}\s*;/,      // fork bomb
  ];

  // Collab siết chặt: MỌI lệnh rủi ro (kể cả Git) đều phải ADMIN duyệt — không còn miễn
  // trừ Git như trước. Danh sách áp dụng nguyên vẹn ở mọi mode (M3 + chốt "Collab: mọi
  // thay đổi phải duyệt"). Xem thêm requireApprovalForWrites bên dưới.
  const activeRisky = RISKY_COMMANDS;

  /** True nếu lệnh bash bị coi là rủi ro → luôn qua cổng duyệt ngay cả ở mode 'auto'. */
  const isRiskyCommand = (cmd: string): boolean =>
    activeRisky.some((re) => re.test(cmd));

  // Lệnh AN TOÀN cho Reviewer Mode: git/gh ĐỌC (diff/status/log/show, gh pr view/diff/list/
  // checks/status, gh repo view) + gh GHI REVIEW đúng vai (gh pr comment / gh pr review). Neo
  // `^` đầu; caller đã chặn command-chaining + risky TRƯỚC khi gọi hàm này (xem khối
  // isReviewerMode). CỐ Ý không cho `gh pr merge/close/edit/create`, `git push/commit` — đó là
  // sửa/đóng PR, ngoài vai reviewer. Các flag/đối số vô hại (--body, -R, số PR, URL) cho qua.
  const REVIEW_GH_COMMANDS = [
    /^git\s+(diff|status|log|show|blame)\b/,
    /^gh\s+pr\s+(view|diff|list|checks|status)\b/,
    /^gh\s+pr\s+comment\b/,
    /^gh\s+pr\s+review\b/,
    /^gh\s+repo\s+view\b/,
    /^gh\s+api\s+repos\/[^\s;|&]+\s*$/, // gh api repos/... (chỉ GET đọc — không có -X/-f/--method)
  ];
  /** True nếu lệnh hợp lệ cho Reviewer (git/gh đọc + gh pr comment/review). Chỉ gọi SAU khi đã
   *  loại risky + command-chaining. */
  const isReviewGhCommand = (cmd: string): boolean =>
    REVIEW_GH_COMMANDS.some((re) => re.test(cmd));

  /** Tool sửa/ghi file (trong repo). Ở 'edit-auto'/'auto' được auto-allow nếu đường dẫn nằm trong cwd. */
  const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

  // Lệnh Bash SỬA FILE TẠI CHỖ (in-place) hoặc áp patch — có thể ghi vào BẤT KỲ path nào (kể cả
  // source .ts/.dart) mà KHÔNG khớp RISKY_COMMANDS (không có rm/mv/cp/redirect-ghi). Dùng riêng cho
  // DevOps Mode: DevOps deny-cứng source qua tool Edit/Write, nhưng CỐ Ý mở Bash cho deploy — nên
  // các editor này là ĐƯỜNG LÁCH để ghi source qua Bash. Ta bắt chúng và LUÔN treo duyệt (kể cả
  // admin) vì không thể chắc target là infra hay source chỉ từ chuỗi lệnh. Bao: sed -i / perl -i /
  // ruby -i (sửa tại chỗ), patch, git apply/checkout-patch, ex/ed (editor script), install (ghi
  // file), awk/gawk (thường kèm redirect nhưng bắt cả bản không redirect cho chắc), dd of= (đã
  // trong RISKY nhưng để đây cho rõ). Neo đầu-token lệnh để tránh khớp hậu tố (vd 'used', 'exec').
  const INPLACE_FILE_EDIT_COMMANDS = [
    /(?:^|[\s;&|(])sed\s+[^\n]*-i/,            // sed -i / -i'' (GNU & BSD)
    /(?:^|[\s;&|(])perl\s+[^\n]*-i/,           // perl -i -pe
    /(?:^|[\s;&|(])ruby\s+[^\n]*-i/,           // ruby -i
    /(?:^|[\s;&|(])patch(?=$|[\s/])/,          // patch (kể cả `patch f < diff` — redirect đọc không bị RISKY)
    /(?:^|[\s;&|(])git\s+apply\b/,             // git apply <diff>
    /(?:^|[\s;&|(])git\s+checkout\s+-p\b/,     // git checkout -p (áp hunk vào file)
    /(?:^|[\s;&|(])(ex|ed)\s+-/,               // ex -sc / ed - (editor script sửa file)
    /(?:^|[\s;&|(])install\s+[^\n]*\s[^\s]/,   // install <src> <dst> (ghi file đích)
    /(?:^|[\s;&|(])(awk|gawk)\s+/,             // awk/gawk (đầu ra thường redirect vào file)
  ];
  /** True nếu lệnh Bash là editor sửa-file-tại-chỗ/áp-patch → DevOps LUÔN treo duyệt (kể cả admin),
   *  vì nó có thể ghi source lách deny-cứng của tool Edit/Write. */
  const isInPlaceFileEdit = (cmd: string): boolean =>
    INPLACE_FILE_EDIT_COMMANDS.some((re) => re.test(cmd));

  /** True nếu đường dẫn trỏ tới file BÍ MẬT/nhạy cảm — chặn đọc/ghi trong QC Mode (M9).
   *  Danh sách được mở rộng để bịt các file từng lọt: .git-credentials, .ssh/*, .netrc,
   *  credentials.json (GCP), .docker/config.json (registry token), secrets.yaml… */
  const isSensitivePath = (p: string): boolean => {
    const t = p.toLowerCase();
    return (
      t.includes('.env') ||
      t.includes('.git/') ||
      t.includes('.git\\') ||
      t.includes('.git-credentials') ||
      t.includes('.npmrc') ||
      t.includes('.pypirc') ||
      t.includes('.netrc') ||
      t.endsWith('.pem') ||
      t.endsWith('.key') ||
      t.endsWith('.p12') ||
      t.endsWith('.jks') ||
      t.endsWith('.keystore') ||
      t.includes('id_rsa') ||
      t.includes('id_ed25519') ||
      t.includes('/.ssh/') ||
      t.includes('\\.ssh\\') ||
      t.includes('.aws/') ||
      t.includes('.aws\\') ||
      t.includes('.kube/') ||
      t.includes('.kube\\') ||
      t.includes('.docker/config') ||
      t.includes('.dockercfg') ||
      t.includes('credentials.json') ||
      t.includes('credentials.yaml') ||
      t.includes('credentials.yml') ||
      // R4: service-account key (GCP/Firebase), file cấu hình chứa mật khẩu DB/app.
      t.includes('serviceaccount') ||
      t.includes('service-account') ||
      t.includes('service_account') ||
      t.includes('firebase-admin') ||
      t.endsWith('database.yml') ||
      t.endsWith('database.yaml') ||
      t.endsWith('application.properties') ||
      t.endsWith('application.yml') ||
      t.endsWith('application.yaml') ||
      // Bất kỳ file NÀO trong thư mục secrets/ (không chỉ file tên "secret.*").
      /(^|[\/\\])secrets?[\/\\]/.test(t) ||
      /(^|[\/\\])secrets?\.(ya?ml|json|txt|env)$/.test(t)
    );
  };

  /** True nếu đường dẫn là FILE TÀI LIỆU (đầu ra hợp lệ của BA Mode). Nhận diện theo đuôi
   *  (.md/.mdx/.markdown/.txt/.rst/.adoc) HOẶC nằm trong thư mục tài liệu (docs/, doc/,
   *  documentation/). Mọi path khác (source code .ts/.dart/.sql, config…) → không phải doc,
   *  BA Mode chặn ghi. So sánh chữ thường; chấp cả '/' lẫn '\\'. */
  const isDocPath = (p: unknown): boolean => {
    if (typeof p !== 'string' || !p) return false;
    const t = p.toLowerCase();
    if (/\.(md|mdx|markdown|txt|rst|adoc)$/.test(t)) return true;
    return /(^|[\/\\])(docs?|documentation)[\/\\]/.test(t);
  };

  /** True nếu đường dẫn là FILE HẠ TẦNG (đầu ra hợp lệ của DevOps Mode). Bao phủ 4 nhóm:
   *   1) Container & Compose: Dockerfile / Dockerfile.* / *.dockerfile, docker-compose*.yml/.yaml,
   *      .dockerignore.
   *   2) CI/CD: .github/workflows/*, .gitlab-ci.yml, Jenkinsfile, azure-pipelines*.yml,
   *      bitbucket-pipelines.yml, .circleci/*, codemagic.yaml.
   *   3) IaC: *.tf / *.tfvars / *.hcl (Terraform); thư mục k8s|kubernetes|deploy|manifests|charts
   *      + Helm (Chart.yaml, values*.yaml, thư mục templates/).
   *   4) Docs vận hành: tái dùng isDocPath (*.md/docs/ — user chọn cho DevOps ghi thêm).
   *  Mọi path khác — nhất là source ứng dụng (.ts/.tsx/.dart/.py/.go/.java…) — KHÔNG phải hạ
   *  tầng → DevOps Mode chặn ghi (không đổi logic app). So sánh chữ thường; chấp cả '/' lẫn '\\'.
   *  Lưu ý: *.yaml/*.yml chỉ tính là hạ tầng khi nằm trong thư mục hạ tầng hoặc trùng tên đặc
   *  trưng (docker-compose/values/Chart) — không nhận MỌI yaml (config app cũng dùng yaml). */
  const isInfraPath = (p: unknown): boolean => {
    if (typeof p !== 'string' || !p) return false;
    if (isDocPath(p)) return true; // docs vận hành (.md / docs/) — nhóm 4
    const t = p.toLowerCase();
    const base = t.split(/[\/\\]/).pop() ?? t;
    // (1) Container & Compose
    if (base === 'dockerfile' || base === '.dockerignore') return true;
    if (/^dockerfile\./.test(base) || /\.dockerfile$/.test(base)) return true;
    if (/^docker-compose[\w.-]*\.ya?ml$/.test(base) || /^compose[\w.-]*\.ya?ml$/.test(base)) return true;
    // (2) CI/CD
    if (/(^|[\/\\])\.github[\/\\]workflows[\/\\]/.test(t)) return true;
    if (/(^|[\/\\])\.circleci[\/\\]/.test(t)) return true;
    if (base === '.gitlab-ci.yml' || base === 'jenkinsfile' || base === 'bitbucket-pipelines.yml') return true;
    if (/^azure-pipelines[\w.-]*\.ya?ml$/.test(base) || base === 'codemagic.yaml') return true;
    // (3) IaC — Terraform / Helm / K8s manifests
    if (/\.(tf|tfvars|hcl)$/.test(t)) return true;
    if (base === 'chart.yaml' || /^values[\w.-]*\.ya?ml$/.test(base)) return true;
    if (/(^|[\/\\])(k8s|kubernetes|manifests|charts|helm)[\/\\]/.test(t)) return true;
    if (/(^|[\/\\])deploy(ment)?s?[\/\\].*\.ya?ml$/.test(t)) return true;
    if (/(^|[\/\\])templates[\/\\].*\.(ya?ml|tpl)$/.test(t)) return true;
    return false;
  };

  /** True nếu tool là MCP của Jira (jira read + write đều cho phép trong BA Mode). SDK đặt
   *  tên MCP tool dạng `mcp__<server>__<tool>` → khớp phần server chứa 'jira'. */
  const isJiraTool = (name: string): boolean => /^mcp__[^_]*jira[^_]*__/i.test(name);

  const workdir = resolve(opts.cwd || process.cwd());
  // realpath của repo (theo symlink) — mốc so sánh THẬT để chống lách bằng symlink (M4).
  const realWorkdir = (() => {
    try { return realpathSync(workdir); } catch { return workdir; }
  })();
  /** True nếu path (từ input tool ghi) nằm TRONG repo cwd — ngoài repo thì coi là rủi ro, phải hỏi.
   *  M4: resolve symlink bằng realpathSync trước khi so sánh. resolve('..') chỉ chuẩn hoá
   *  chuỗi, KHÔNG đi theo symlink — nên `linkdir` (symlink trỏ ra ngoài) từng lọt. Ta lấy
   *  realpath của path (hoặc thư mục cha nếu path chưa tồn tại) rồi so với realWorkdir. */
  const isPathInRepo = (p: unknown): boolean => {
    if (typeof p !== 'string' || !p) return false;
    const abs = resolve(workdir, p);
    // Lấy realpath của path. Nếu path (hoặc thư mục cha) CHƯA tồn tại (ghi file/thư mục
    // mới), lần LÊN tổ tiên gần nhất ĐANG tồn tại rồi realpath nó, ghép lại phần đuôi chưa
    // tồn tại. R3: trước đây chỉ thử ĐÚNG 1 cấp cha — ghi vào thư mục MỚI (a/b/x.ts) dưới
    // cwd có tổ tiên là symlink (vd /tmp→/private/tmp trên macOS) bị chặn oan.
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      let d = dirname(abs);
      while (!existsSync(d) && d !== dirname(d)) d = dirname(d);
      try {
        real = resolve(realpathSync(d), relative(d, abs));
      } catch {
        real = abs; // không lần được tổ tiên nào → dùng path chuẩn hoá chuỗi
      }
    }
    const inReal = real === realWorkdir || real.startsWith(realWorkdir + '/');
    const inRaw = abs === workdir || abs.startsWith(workdir + '/');
    // Phải nằm trong repo theo CẢ hai cách tính — chặn symlink escape.
    return inReal && inRaw;
  };

  // Hook monorepo (guard-push/commit, self-verify, githooks) — chỉ khi cwd là monorepo VÀ stack
  // cấp hooksDir (từ bản clone flutter). Nguồn hooks không còn nội bộ skills/monorepo/hooks.
  const monorepoHooks = buildMonorepoHooks(opts.cwd, ext?.hooksDir ?? '');

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
  // (Deploy core + stack đã chạy SỚM ở đầu hàm — cần cho system prompt & hooks trên.)

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
    ...(opts.onQuestion || (isExecuting && opts.onApproval) || isQcMode || isReviewerMode || isBaMode || isDevOpsMode
      ? {
          canUseTool: async (toolName, input, sdkOpts) => {
            // ── QC Mode: read-only + Skill + Jira (WHITELIST) ─────────────────────
            // R1: dùng WHITELIST thay vì blacklist. Trong QC Mode chỉ cho phép tool ĐỌC
            // (Read/Glob/NotebookRead + MCP read patterns đã whitelist), tool Skill (kích hoạt
            // qc-triage), và Jira write (comment kết luận / transition ticket — đầu ra của QC).
            // DENY mọi thứ khác — MCP write ngoài Jira (execute_sql…), Bash, Web*, ghi file source.
            if (isQcMode) {
              // Grep bị tắt riêng (có thể lộ dữ liệu nhạy cảm qua nội dung khớp).
              if (toolName === 'Grep') {
                return {
                  behavior: 'deny' as const,
                  message: 'Grep bị vô hiệu hóa trong QC Mode để bảo mật dữ liệu nhạy cảm. Vui lòng sử dụng Glob + Read.',
                };
              }
              // Read (và các tool file nếu lọt): chặn file nhạy cảm (M9/R4).
              if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
                const target =
                  (input as Record<string, unknown>).file_path ??
                  (input as Record<string, unknown>).path ??
                  (input as Record<string, unknown>).notebook_path;
                if (typeof target === 'string' && isSensitivePath(target)) {
                  return {
                    behavior: 'deny' as const,
                    message: 'Truy cập bị chặn: Không được phép đọc/ghi file cấu hình nhạy cảm trong QC Mode.',
                  };
                }
              }
              // Jira (read + write) cho phép — QC comment kết luận triệu chứng / transition
              // ticket. Đây là đầu ra hợp lệ của QC. (isJiraTool khớp mọi mcp__…jira…__).
              if (isJiraTool(toolName)) {
                return { behavior: 'allow' as const, updatedInput: input };
              }
              // AskUserQuestion xử lý riêng ở khối bên dưới (cần onQuestion) — cho đi tiếp.
              // Mọi tool KHÔNG thuộc allowlist đọc/Skill → DENY (chốt whitelist).
              if (toolName !== 'AskUserQuestion' && !QC_MODE_ALLOWED_TOOLS.has(toolName)) {
                return {
                  behavior: 'deny' as const,
                  message: `QC Mode chỉ cho phép ĐỌC + Skill + Jira — tool "${toolName}" bị chặn.`,
                };
              }
            }

            // ── Reviewer Mode: review PR/diff — read-only source + git/gh review (WHITELIST) ──
            // Đọc code + Skill (pr-review) + Jira READ; chạy git/gh ĐỌC, `gh pr comment`/`gh pr
            // review` (comment/approve PR), và test/analyze. DENY sửa code, merge/push, MCP write.
            if (isReviewerMode) {
              // Grep tắt riêng (lộ nội dung nhạy cảm). File nhạy cảm chặn (M9/R4).
              if (toolName === 'Grep') {
                return {
                  behavior: 'deny' as const,
                  message: 'Grep bị vô hiệu hóa trong Reviewer Mode. Dùng Glob + Read.',
                };
              }
              if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
                const target =
                  (input as Record<string, unknown>).file_path ??
                  (input as Record<string, unknown>).path ??
                  (input as Record<string, unknown>).notebook_path;
                if (typeof target === 'string' && isSensitivePath(target)) {
                  return {
                    behavior: 'deny' as const,
                    message: 'Truy cập bị chặn: file cấu hình nhạy cảm không đọc/ghi được trong Reviewer Mode.',
                  };
                }
              }
              // Ghi/sửa file source → DENY CỨNG (reviewer không sửa code).
              if (FILE_WRITE_TOOLS.has(toolName)) {
                return {
                  behavior: 'deny' as const,
                  message: 'Reviewer Mode chỉ ĐỌC + review PR — không sửa code. Hãy comment/approve qua `gh pr`.',
                };
              }
              // Bash: chỉ git/gh review (đọc + gh pr comment/review) + test/analyze. Risky &
              // command-chaining bị chặn TRƯỚC để không lách qua `gh pr comment; rm -rf`.
              if (toolName === 'Bash' && typeof input.command === 'string') {
                const cmd = input.command.trim();
                if (isRiskyCommand(cmd) || hasCommandChaining(cmd)) {
                  return {
                    behavior: 'deny' as const,
                    message: 'Reviewer Mode: lệnh rủi ro / lệnh ghép bị chặn (không xoá/đẩy/nối lệnh).',
                  };
                }
                if (isReviewGhCommand(cmd) || SAFE_COMMANDS.some((re) => re.test(cmd))) {
                  return { behavior: 'allow' as const, updatedInput: input };
                }
                return {
                  behavior: 'deny' as const,
                  message: 'Reviewer Mode chỉ chạy git/gh đọc, `gh pr comment`/`gh pr review`, và test/analyze.',
                };
              }
              // AskUserQuestion xử lý riêng dưới. Còn lại: tool ngoài whitelist → DENY.
              // (Jira read qua mcpReadToolPatterns đã ở whitelist; Jira write không có → DENY.)
              if (toolName !== 'AskUserQuestion' && !REVIEWER_MODE_ALLOWED_TOOLS.has(toolName)) {
                return {
                  behavior: 'deny' as const,
                  message: `Reviewer Mode chỉ cho phép ĐỌC + Skill + git/gh review + Jira đọc — tool "${toolName}" bị chặn.`,
                };
              }
            }

            // ── BA Mode: ghi TÀI LIỆU + Jira; DENY source/DB/deploy ────────────────
            // Phân quyền theo ĐÍCH ghi (không phải read-vs-write thuần). Đây là DENY CỨNG:
            // các thao tác ngoài vai trò BA bị chặn hẳn (không định tuyến hỏi admin) — muốn
            // sửa code thì chuyển sang Collab/Admin. Đọc + Jira + ghi tài liệu chạy tự do.
            if (isBaMode) {
              // Ghi/sửa file: chỉ cho file TÀI LIỆU; file nhạy cảm luôn chặn; còn lại DENY.
              if (FILE_WRITE_TOOLS.has(toolName)) {
                const target =
                  (input as Record<string, unknown>).file_path ??
                  (input as Record<string, unknown>).path ??
                  (input as Record<string, unknown>).notebook_path;
                if (typeof target === 'string' && isSensitivePath(target)) {
                  return {
                    behavior: 'deny' as const,
                    message: 'BA Mode: không được ghi file cấu hình nhạy cảm.',
                  };
                }
                if (isDocPath(target)) {
                  return { behavior: 'allow' as const, updatedInput: input };
                }
                return {
                  behavior: 'deny' as const,
                  message:
                    'BA Mode chỉ được ghi TÀI LIỆU (docs/, *.md/*.mdx/*.txt). Không sửa source code/config. Hãy ghi phân tích/đặc tả ra file tài liệu, hoặc cập nhật Jira.',
                };
              }
              // MCP: Jira (read + write) cho phép; MCP write khác (execute_sql, migration…) DENY.
              // MCP read chung (mcpReadToolPatterns) được auto-duyệt qua hook, nhưng đề phòng
              // tool nào lọt tới đây: chặn mọi mcp__* không phải Jira mang tính ghi/side-effect.
              if (toolName.startsWith('mcp__') && !isJiraTool(toolName)) {
                // Cho các tool ĐỌC (list/get/search/describe…) đi tiếp; chặn phần còn lại.
                if (!/(?:^|__)(?:list|get|search|describe|read|show|fetch)/i.test(toolName)) {
                  return {
                    behavior: 'deny' as const,
                    message: `BA Mode: chặn thao tác MCP có side-effect "${toolName}" (chỉ Jira được ghi; DB/hạ tầng không đổi được).`,
                  };
                }
              }
              // Bash: chặn hẳn lệnh RỦI RO/huỷ hoại (deploy, rm -rf, git push…). Lệnh SAFE đơn
              // thuần (đọc/kiểm chứng) đi tiếp; lệnh ghép/không rõ cũng chặn cho an toàn.
              if (toolName === 'Bash' && typeof input.command === 'string') {
                const cmd = input.command.trim();
                if (isRiskyCommand(cmd)) {
                  return {
                    behavior: 'deny' as const,
                    message: 'BA Mode: lệnh có thể gây hại/không thể hoàn tác bị chặn (không deploy/không xoá/không git push).',
                  };
                }
                if (hasCommandChaining(cmd) || !SAFE_COMMANDS.some((re) => re.test(cmd))) {
                  return {
                    behavior: 'deny' as const,
                    message: 'BA Mode chỉ cho chạy lệnh đọc/kiểm chứng an toàn. Lệnh này bị chặn.',
                  };
                }
                return { behavior: 'allow' as const, updatedInput: input };
              }
              // Các tool còn lại (Read/Grep/Glob/WebSearch/WebFetch/Jira/AskUserQuestion/
              // TodoWrite/Agent…) đi tiếp — AskUserQuestion vẫn được xử lý ở khối dưới.
            }

            // ── DevOps Mode: ghi HẠ TẦNG; DENY source; deploy TREO DUYỆT ADMIN ─────
            // Phân quyền theo ĐÍCH ghi như BA, NHƯNG khác BA ở lệnh deploy/apply: BA deny cứng,
            // DevOps CHỈ chặn ghi source code — mọi thứ còn lại (Bash deploy/apply, MCP write như
            // apply_migration) KHÔNG chặn ở đây mà để rơi xuống cổng duyệt chung cuối hàm, nơi
            // requireApprovalForWrites (bật cho non-admin) định tuyến lên admin. Vậy deploy = việc
            // hợp lệ của vai này, chỉ cần admin xác nhận, thay vì bị khoá hẳn.
            if (isDevOpsMode) {
              // ĐỌC file nhạy cảm: chặn (như QC/Reviewer). DevOps làm với hạ tầng nơi bí mật tập
              // trung — CTV LAN không được lôi .env/key/credentials ra. Read/Grep KHÔNG auto qua hook
              // (đã loại khỏi readAutoTools) nên rơi vào đây. Mọi file KHÁC vẫn đọc bình thường.
              // Read/Grep KHÔNG auto qua hook (đã loại khỏi readAutoTools) nên rơi vào đây. Chặn nếu
              // nhạy cảm; NGƯỢC LẠI allow THẲNG (không rơi xuống gate cuối hàm — tránh non-admin
              // requireApprovalForWrites bắt admin duyệt TỪNG lần đọc, vốn là thao tác chỉ-đọc vô hại).
              if (toolName === 'Read') {
                const target = (input as Record<string, unknown>).file_path;
                if (typeof target === 'string' && isSensitivePath(target)) {
                  return {
                    behavior: 'deny' as const,
                    message: 'DevOps Mode: không được đọc file cấu hình nhạy cảm (bí mật/khóa). Chỉ đọc file hạ tầng/source thường.',
                  };
                }
                return { behavior: 'allow' as const, updatedInput: input };
              }
              // Grep: chặn khi path nhắm rõ vào file/thư mục nhạy cảm (tránh lộ nội dung secret qua
              // dòng khớp); ngược lại allow thẳng. Grep không path (quét cả cây) vẫn cho — muốn xem
              // đầy đủ 1 file vẫn phải Read, mà Read secret đã bị chặn ở trên.
              if (toolName === 'Grep') {
                const gpath = (input as Record<string, unknown>).path;
                if (typeof gpath === 'string' && isSensitivePath(gpath)) {
                  return {
                    behavior: 'deny' as const,
                    message: 'DevOps Mode: không được grep vào file/thư mục cấu hình nhạy cảm.',
                  };
                }
                return { behavior: 'allow' as const, updatedInput: input };
              }
              // Ghi/sửa file: chỉ cho file HẠ TẦNG (+docs vận hành); file nhạy cảm luôn chặn;
              // source ứng dụng (.ts/.dart/.py…) DENY CỨNG (không đổi logic app).
              if (FILE_WRITE_TOOLS.has(toolName)) {
                const target =
                  (input as Record<string, unknown>).file_path ??
                  (input as Record<string, unknown>).path ??
                  (input as Record<string, unknown>).notebook_path;
                if (typeof target === 'string' && isSensitivePath(target)) {
                  return {
                    behavior: 'deny' as const,
                    message: 'DevOps Mode: không được ghi file cấu hình nhạy cảm (bí mật/khóa).',
                  };
                }
                if (isInfraPath(target)) {
                  // File hạ tầng: cho đi tiếp xuống cổng duyệt chung. Admin localhost → auto;
                  // non-admin (requireApprovalForWrites) → treo admin duyệt như mọi thao tác ghi.
                  // (KHÔNG allow thẳng ở đây để không bỏ qua cổng duyệt của CTV DevOps.)
                } else {
                  return {
                    behavior: 'deny' as const,
                    message:
                      'DevOps Mode chỉ ghi được file HẠ TẦNG (Dockerfile, docker-compose*, .github/workflows/*, *.tf/*.hcl, k8s/Helm manifests) và tài liệu vận hành (*.md). Không sửa source code ứng dụng.',
                  };
                }
              }
              // Bash: hầu hết để rơi xuống gate chung (SAFE auto-allow; deploy/apply risky → gate).
              // NGOẠI LỆ — editor sửa-file-tại-chỗ/áp-patch (sed -i, perl -i, patch, git apply, ex,
              // install, awk…): đây là ĐƯỜNG LÁCH ghi source qua Bash (deny-cứng chỉ chặn Edit/Write).
              // Vì admin localhost ('auto', requireApprovalForWrites=false) sẽ auto-allow chúng ở
              // gate chung, ta chặn SỚM tại đây bằng gate() để LUÔN treo duyệt (kể cả admin) — không
              // thể chắc target là infra hay source chỉ từ chuỗi lệnh, nên buộc admin xác nhận.
              if (toolName === 'Bash' && typeof input.command === 'string') {
                const cmd = input.command.trim();
                if (isInPlaceFileEdit(cmd) && isExecuting && opts.onApproval) {
                  const approved = await opts.onApproval(toolName, input, {
                    decisionReason:
                      'DevOps Mode: lệnh sửa file tại chỗ/áp patch (sed -i, patch, git apply…) có thể ghi vào source — cần xác nhận không đụng code ứng dụng.',
                  });
                  return approved
                    ? { behavior: 'allow' as const, updatedInput: input }
                    : {
                        behavior: 'deny' as const,
                        message:
                          'DevOps Mode từ chối lệnh sửa file tại chỗ. Chỉ chỉnh file HẠ TẦNG; muốn sửa source hãy dùng Collab/Dev Mode.',
                      };
                }
              }
              // MCP write (execute_sql/apply_migration…) — DEFENSE-IN-DEPTH như BA: KHÔNG để admin
              // auto-allow DROP TABLE ở 'auto'. MCP read (mcpReadToolPatterns) đã auto qua hook nên
              // không tới đây; tool mcp__* còn lại mà KHÔNG phải read tường minh → ép treo duyệt (kể
              // cả admin). Non-admin vốn đã treo qua requireApprovalForWrites; đây bịt nốt admin.
              if (
                toolName.startsWith('mcp__') &&
                !/(?:^|__)(?:list|get|search|describe|read|show|fetch)/i.test(toolName) &&
                isExecuting &&
                opts.onApproval
              ) {
                const approved = await opts.onApproval(toolName, input, {
                  decisionReason: `DevOps Mode: thao tác MCP "${toolName}" có thể đổi DB/hạ tầng — cần xác nhận.`,
                });
                return approved
                  ? { behavior: 'allow' as const, updatedInput: input }
                  : {
                      behavior: 'deny' as const,
                      message: 'DevOps Mode từ chối thao tác MCP ghi. Hãy hỏi lại hoặc thao tác hạ tầng khác.',
                    };
              }
              // Còn lại (Bash thường/deploy, tool đọc, AskUserQuestion) đi tiếp — deploy risky sẽ
              // gặp gate chung; AskUserQuestion xử lý ở khối dưới.
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

            // Bash. THỨ TỰ QUAN TRỌNG (M1): xét RỦI RO + lệnh-ghép TRƯỚC fast-path 'safe'.
            // Trước đây SAFE được xét trước nên `npm test; rm -rf ~` khớp tiền tố rồi
            // auto-allow, `rm -rf` không bao giờ tới isRiskyCommand. Giờ:
            //   1) lệnh rủi ro → luôn hỏi (kể cả có tiền tố safe);
            //   2) lệnh GHÉP (có ;/&&/||/pipe/redirect) → không đi fast-path, phải hỏi
            //      (trừ khi mode cho auto và không rủi ro — vẫn qua requireApprovalForWrites);
            //   3) lệnh SAFE ĐƠN thuần → auto-allow;
            //   4) còn lại: siết-duyệt → hỏi; 'auto' → allow; khác → hỏi.
            if (toolName === 'Bash' && typeof input.command === 'string') {
              const cmd = input.command.trim();
              if (isRiskyCommand(cmd)) {
                return gate({ decisionReason: 'Lệnh có thể gây hại/không thể hoàn tác — cần bạn xác nhận.' });
              }
              // Fast-path 'safe' CHỈ cho lệnh đơn (không toán tử nối) — chốt chặn M1.
              if (!hasCommandChaining(cmd) && SAFE_COMMANDS.some((re) => re.test(cmd))) return allow;
              if (opts.requireApprovalForWrites) {
                return gate({ decisionReason: 'Chạy lệnh cần được duyệt (chế độ cộng tác/không phải admin).' });
              }
              return mode === 'auto' ? allow : gate();
            }

            // Sửa/ghi file: siết-duyệt → luôn hỏi (M5, Collab CTV). Ngược lại: 'edit-auto'
            // & 'auto' tự duyệt NẾU file nằm TRONG repo; ghi ngoài repo luôn hỏi; 'manual' hỏi.
            if (FILE_WRITE_TOOLS.has(toolName)) {
              const target =
                (input as Record<string, unknown>).file_path ??
                (input as Record<string, unknown>).path ??
                (input as Record<string, unknown>).notebook_path;
              if (opts.requireApprovalForWrites) {
                return gate({ decisionReason: 'Sửa/ghi file cần được duyệt (chế độ cộng tác/không phải admin).' });
              }
              const inRepo = isPathInRepo(target);
              if ((mode === 'edit-auto' || mode === 'auto') && inRepo) return allow;
              if ((mode === 'edit-auto' || mode === 'auto') && !inRepo) {
                return gate({ decisionReason: 'Ghi file NGOÀI thư mục repo — cần bạn xác nhận.' });
              }
              return gate(); // manual
            }

            // Mọi tool ghi/side-effect còn lại (MCP write như execute_sql/apply_migration,
            // jira_create…). M5: ở chế độ siết-duyệt LUÔN hỏi — trước đây 'auto' tự duyệt
            // khiến CTV Collab gọi được DROP TABLE trên DB thật mà admin không thấy.
            if (opts.requireApprovalForWrites) {
              return gate({ decisionReason: `Thao tác "${toolName}" có side-effect — cần được duyệt.` });
            }
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
  // Thời điểm reset hạn mức 5h GẦN NHẤT mà SDK báo (qua message 'rate_limit'), dạng ISO.
  // Dùng khi phiên kết thúc bằng lỗi hết hạn mức → caller lên lịch tự chạy tiếp đúng giờ.
  let lastFiveHourResetsAt: string | null = null;

  const q = query({ prompt, options });
  // Đếm số lượt 'result' trong phiên — để cảnh báo cache đúng lúc: lượt đầu read=0 là
  // BÌNH THƯỜNG (đang tạo cache); từ lượt 2 trở đi read=0 mới là silent invalidator.
  let resultCount = 0;

  // Cập nhật context window THEO THỜI GIAN THỰC trong lúc agent chạy (sau mỗi assistant
  // turn / tool-result), thay vì chỉ một lần khi kết thúc lượt ở 'result'. Chỉ đọc
  // getContextUsage() (nhẹ, 1 control request) — KHÔNG đọc rate limits ở đây (đắt hơn,
  // đổi chậm; snapshot đầy đủ vẫn phát ở 'result'). Throttle ≥800ms để tránh spam control
  // request khi tool chạy dồn dập. Giữ lại rateLimits/subscription gần nhất để event giữa
  // chừng không xóa mất phần hạn mức đang hiển thị ở UI.
  let lastEmittedContextAt = 0;
  let lastRateLimits: UsageWindow[] = [];
  let lastSubscriptionType: string | null = null;
  const CONTEXT_THROTTLE_MS = 800;
  const emitContextUsage = async () => {
    const nowMs = Date.now();
    if (nowMs - lastEmittedContextAt < CONTEXT_THROTTLE_MS) return;
    lastEmittedContextAt = nowMs;
    const ctx = await q.getContextUsage().catch(() => null);
    if (!ctx) return;
    opts.onEvent({
      type: 'usage',
      usage: {
        rateLimits: lastRateLimits,
        subscriptionType: lastSubscriptionType,
        contextTokens: ctx.totalTokens ?? null,
        contextMaxTokens: ctx.maxTokens ?? null,
        contextPercentage: ctx.percentage ?? null,
      },
    });
  };
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
      case 'rate_limit_event': {
        // SDK báo hạn mức đổi. Giữ lại resetsAt của cửa sổ 5h GẦN NHẤT: nếu phiên chốt
        // bằng lỗi hết hạn mức, đây là nguồn giờ reset CHÍNH XÁC nhất (epoch từ server,
        // không phụ thuộc giờ máy). resetsAt có thể tính bằng giây → chuẩn hoá về ms.
        const rl = (message as { rate_limit_info?: { resetsAt?: number; rateLimitType?: string } }).rate_limit_info;
        if (rl && typeof rl.resetsAt === 'number' && rl.rateLimitType === 'five_hour') {
          const ms = rl.resetsAt < 1e12 ? rl.resetsAt * 1000 : rl.resetsAt;
          lastFiveHourResetsAt = new Date(ms).toISOString();
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
        // Cập nhật context ngay sau khi agent vừa nói/gọi tool (throttled).
        await emitContextUsage();
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
        // Cập nhật context ngay sau khi có kết quả tool (throttled).
        await emitContextUsage();
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
          // Cảnh báo prompt caching CHỈ KHI BẤT THƯỜNG (im khi ổn). Bình thường cache tự
          // chạy: lượt 2+ đọc lại system prompt + profile từ cache (~0.1× giá). Nếu từ
          // lượt 2 trở đi mà read=0 dù đầu vào lớn → có silent invalidator phá cache ở
          // đầu prefix (timestamp/ID/nội dung đổi) — lúc đó token bị tính giá đầy đủ.
          resultCount++;
          const u = message.usage as {
            cache_read_input_tokens?: number;
            input_tokens?: number;
          };
          const read = u.cache_read_input_tokens ?? 0;
          const fresh = u.input_tokens ?? 0;
          // Ngưỡng 3000: chỉ báo khi phần đầu vào đủ lớn để đáng lẽ phải cache được
          // (dưới ngưỡng cacheable tối thiểu thì read=0 là đương nhiên, không phải lỗi).
          if (resultCount >= 2 && read === 0 && fresh > 3000) {
            opts.onEvent({
              type: 'tool',
              name: 'cache',
              describe: `⚠️ Cache không hoạt động: ${fresh.toLocaleString()} token đầu vào bị tính giá đầy đủ (read=0) dù đây là lượt ${resultCount}. Có thể prompt đầu prefix đang đổi mỗi lượt (timestamp/ID) — kiểm tra system prompt.`,
            });
          }
        }
        // Đọc snapshot hạn mức + context ngay khi query CÒN SỐNG (control request cần
        // transport chưa đóng). Lỗi/không hỗ trợ → bỏ qua, không chặn kết thúc lượt.
        const usage = await readUsageSnapshot(q);
        if (usage) {
          // Ghi nhớ rate limits/subscription mới nhất để event context realtime (giữa
          // chừng) tái dùng, không xóa mất phần hạn mức đang hiển thị ở UI.
          lastRateLimits = usage.rateLimits;
          lastSubscriptionType = usage.subscriptionType;
          opts.onEvent({ type: 'usage', usage });
        }
        if (!success) {
          // Phân loại lỗi: có phải hết hạn mức phiên (5h) không? SDKResultError có mảng
          // `errors` — dò chuỗi trong đó. Giờ reset ưu tiên: rate_limit_event 5h > cửa sổ
          // 'Session (5hr)' trong snapshot vừa đọc. Nếu là session limit → phát kèm cờ +
          // resetsAt để caller tự lên lịch chạy tiếp.
          const errors = (message as { errors?: string[] }).errors;
          const isSessionLimit = looksLikeSessionLimit(errors, message.subtype);
          const resetsAt =
            lastFiveHourResetsAt ??
            usage?.rateLimits.find((w) => /5\s*hr|5hr|five/i.test(w.label))?.resetsAt ??
            null;
          opts.onEvent({ type: 'error', subtype: message.subtype, isSessionLimit, resetsAt });
        }
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

/**
 * Nhận diện lỗi "hết hạn mức phiên" từ các chuỗi lỗi mà SDK trả về khi phiên chốt bằng
 * error. Bắt cả biến thể tiếng Anh của Claude Code ("session limit", "usage limit",
 * "rate limit ... resets"). Dùng để quyết định có LÊN LỊCH tự chạy tiếp hay không.
 */
function looksLikeSessionLimit(errors: string[] | undefined, subtype: string): boolean {
  const hay = [(subtype ?? ''), ...(errors ?? [])].join(' ').toLowerCase();
  if (!hay) return false;
  return (
    hay.includes('session limit') ||
    hay.includes('usage limit') ||
    (hay.includes('rate limit') && hay.includes('reset')) ||
    hay.includes("you've hit your")
  );
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
