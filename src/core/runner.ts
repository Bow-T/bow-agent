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
import { loadClaudeCodeMcp, mcpReadToolPatterns, describeTool } from '../tools/mcp.js';
import { loadPromptSkills } from '../skills/index.js';
import { loadMonorepoContext } from '../skills/monorepo.js';
import { buildMonorepoHooks } from '../skills/hooks.js';
import { buildSubagents } from './subagents.js';

/** Sự kiện tiến độ agent phát ra — CLI/web tự quyết cách hiển thị. */
export type AgentEvent =
  | { type: 'text'; text: string }
  // `describe` = mô tả người-đọc-được (do backend sinh, xem describeTool). Web hiển thị
  // thẳng chuỗi này nên không cần lặp lại logic mô tả ở frontend.
  | { type: 'tool'; name: string; describe: string }
  | { type: 'result'; text: string; turns: number; outputTokens: number; costUsd: number }
  | { type: 'error'; subtype: string };

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

export interface RunOptions {
  /** Task brief đã chuẩn hóa (từ input layer). */
  brief: string;
  /** Thư mục làm việc — repo mà agent sẽ thao tác. Mặc định cwd hiện tại. */
  cwd: string;
  /**
   * Chế độ quyền:
   * - 'plan'   : chỉ lập kế hoạch, KHÔNG sửa file/chạy lệnh (mặc định — an toàn nhất).
   * - 'execute': thực thi, nhưng mọi thao tác thay đổi đều hỏi duyệt.
   */
  mode: 'plan' | 'execute';
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
   * Hỏi duyệt một thao tác GHI (chỉ dùng ở mode 'execute'). CLI hỏi y/N trên
   * terminal; web treo Promise chờ nút bấm. Rỗng ở execute = tự động cho phép
   * (KHÔNG khuyến nghị — chỉ dùng khi caller cố ý bỏ cổng).
   */
  onApproval?: ApprovalRequest;
  /** Tín hiệu hủy (dừng agent giữa chừng). */
  abortSignal?: AbortSignal;
  /** Model sử dụng cho agent. */
  model?: string;
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

  const permissionMode: PermissionMode = opts.mode === 'plan' ? 'plan' : 'default';

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

  const allowedTools = [
    'Read',
    'Grep',
    'Glob',
    // Cho agent chính spawn subagent không kẹt cổng duyệt — subagent đều read-only /
    // chỉ chạy lệnh kiểm chứng nên an toàn. Chỉ mở khi bật multi-agent.
    ...(subagents ? ['Agent'] : []),
    ...mcpReadToolPatterns(cc.names), // read tools của MCP Claude Code (write phải duyệt)
  ];

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
  if (opts.projectProfile) {
    appendText += `\n\n---\n\n# Kiến thức dự án hiện tại\n\n${opts.projectProfile}`;
  }

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

  // Hook monorepo (guard-push/commit, self-verify, githooks) — chỉ khi cwd là monorepo.
  const monorepoHooks = buildMonorepoHooks(opts.cwd);

  const options: Options = {
    model: opts.model ?? config.model,
    effort: opts.effort ?? 'high',
    cwd: opts.cwd,
    permissionMode,
    allowedTools,
    // Bật Agent Skills: SDK tự nạp .claude/skills/* của repo đích (nhờ settingSources
    // 'project' bên dưới) và mở tool 'Skill'. Agent tự chọn skill theo mô tả.
    skills: 'all',
    // Multi-agent (opt-in): định nghĩa subagent để agent chính giao việc qua tool Agent.
    ...(subagents ? { agents: subagents } : {}),
    ...(monorepoHooks ? { hooks: monorepoHooks } : {}),
    pathToClaudeCodeExecutable: findClaudeCodeExecutable(opts.cwd || process.cwd()),
    ...(opts.abortSignal ? { abortController: toController(opts.abortSignal) } : {}),
    ...(hasMcp ? { mcpServers } : {}),
    // Giữ system prompt gốc của Claude Code + nạp CLAUDE.md của repo, rồi append quy trình + profile.
    systemPrompt: { type: 'preset', preset: 'claude_code', append: appendText },
    settingSources: ['project'],
    // Ở chế độ execute: mọi tool ghi/side-effect phải qua cổng duyệt (nếu có onApproval).
    ...(opts.mode === 'execute' && opts.onApproval
      ? {
          canUseTool: async (toolName, input, sdkOpts) => {
            // Tự động duyệt các lệnh bash kiểm tra/test an toàn
            if (toolName === 'Bash' && typeof input.command === 'string') {
              const cmd = input.command.trim();
              const isSafe = SAFE_COMMANDS.some((regex) => regex.test(cmd));
              if (isSafe) {
                return { behavior: 'allow' as const, updatedInput: input };
              }
            }

            // Tool đọc đã nằm trong allowedTools nên không tới đây; tới đây là tool ghi.
            const approved = await opts.onApproval!(toolName, input, {
              title: sdkOpts?.title,
              description: sdkOpts?.description,
              blockedPath: sdkOpts?.blockedPath,
              decisionReason: sdkOpts?.decisionReason,
            });
            return approved
              ? { behavior: 'allow' as const, updatedInput: input }
              : {
                  behavior: 'deny' as const,
                  message: 'Người dùng từ chối thao tác này. Dừng lại và hỏi hướng khác.',
                };
          },
        }
      : {}),
  };

  const promptText =
    opts.mode === 'plan'
      ? `${opts.brief}\n\n---\nHãy HIỂU và LẬP KẾ HOẠCH chi tiết cho task trên (không sửa file). Trình bày kế hoạch để tôi duyệt.`
      : `${opts.brief}\n\n---\nHãy thực hiện task trên theo quy trình. Xin duyệt trước các thao tác thay đổi trạng thái.`;

  // Có ảnh → gửi prompt dạng message với content blocks (text + image) để agent nhìn.
  // Không có ảnh → prompt string đơn giản.
  const prompt =
    opts.images && opts.images.length > 0
      ? imagePrompt(promptText, opts.images)
      : promptText;

  let finalText: string | null = null;

  for await (const message of query({ prompt, options })) {
    switch (message.type) {
      case 'assistant': {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            opts.onEvent({ type: 'text', text: block.text.trim() });
          } else if (block.type === 'tool_use') {
            opts.onEvent({ type: 'tool', name: block.name, describe: describeTool(block.name) });
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
          });
        } else {
          opts.onEvent({ type: 'error', subtype: message.subtype });
        }
        break;
      }
      // Các message type khác (stream_event, system, ...) bỏ qua cho gọn.
    }
  }

  return finalText;
}

/** Bắc cầu AbortSignal → AbortController mà SDK nhận. */
function toController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}

/**
 * Tạo prompt dạng AsyncIterable<SDKUserMessage> với ảnh, để agent (model vision)
 * nhìn wireframe/screenshot cùng phần text.
 */
async function* imagePrompt(
  text: string,
  images: { base64: string; mediaType: string }[],
): AsyncIterable<SDKUserMessage> {
  const content: MessageParam['content'] = [
    { type: 'text', text },
    ...images.map(
      (img) =>
        ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
            data: img.base64,
          },
        }) as const,
    ),
  ];
  yield {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: '',
  } as SDKUserMessage;
}
