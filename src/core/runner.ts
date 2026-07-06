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
  loadGenome,
  expressGenome,
  expressedIds,
  recordTaskOutcome,
  applySelection,
  saveGenome,
} from './genome.js';
import { reflectAndMutate } from './reflect.js';
import { buildJiraServer, JIRA_READ_TOOLS } from '../tools/jira.js';
import { loadClaudeCodeMcp, mcpReadToolPatterns, describeTool } from '../tools/mcp.js';
import { loadPromptSkills } from '../skills/index.js';
import { buildSkillsServer, BOW_SKILLS_READ_TOOLS } from '../skills/code.js';
import { loadMonorepoContext } from '../skills/monorepo.js';
import { buildMonorepoHooks } from '../skills/hooks.js';

/** Sự kiện tiến độ agent phát ra — CLI/web tự quyết cách hiển thị. */
export type AgentEvent =
  | { type: 'text'; text: string }
  // `describe` = mô tả người-đọc-được (do backend sinh, xem describeTool). Web hiển thị
  // thẳng chuỗi này nên không cần lặp lại logic mô tả ở frontend.
  | { type: 'tool'; name: string; describe: string }
  | { type: 'result'; text: string; turns: number; outputTokens: number; costUsd: number }
  // Genome vừa học thêm `added` gen mới về repo sau task (bước phản tư).
  | { type: 'learned'; added: number }
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
   * Chế độ dự án mới: agent được phép scaffold từ đầu (thư mục trống). Ảnh hưởng
   * lời nhắc — hướng agent khởi tạo cấu trúc thay vì chỉ sửa code có sẵn.
   */
  newProject?: boolean;
  /**
   * Danh sách MCP servers muốn kích hoạt (tên từ config Claude Code).
   * Rỗng = không dùng MCP.
   */
  mcpServers?: string[];
  /**
   * Nạp + tiến hóa "genome" (tri thức đã học về repo này qua các lần chạy trước).
   * MẶC ĐỊNH TẮT (opt-in): với repo nhỏ/task rõ, genome là chi phí thừa vì model tự
   * làm đúng. Chỉ đáng bật cho repo LỚN thật, nơi tri thức cross-cutting/cạm-bẫy không
   * nằm gọn trong một file (vd monorepo: "thêm service phải sửa 3 nơi", "regen .gr.dart").
   * Xem DESIGN.md §Bật/tắt để biết bằng chứng A/B.
   */
  useGenome?: boolean;
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
  // Cần auth: hoặc ANTHROPIC_API_KEY, hoặc đã login Claude Code CLI (~/.claude).
  if (!config.hasAuth) {
    throw new Error(
      'Chưa có cách xác thực Claude. Chọn 1 trong 2:\n' +
        '  • Điền ANTHROPIC_API_KEY vào .env (console.anthropic.com), HOẶC\n' +
        '  • Đăng nhập Claude CLI: chạy `claude` rồi /login (dùng gói Claude sẵn có, không cần API key).',
    );
  }

  const permissionMode: PermissionMode = opts.mode === 'plan' ? 'plan' : 'default';

  // MCP chỉ nạp các server nằm trong danh sách opts.mcpServers.
  // (1) MCP server từ Claude Code (~/.claude.json): supabase, jira, codemagic...
  const cc = opts.mcpServers && opts.mcpServers.length > 0
    ? loadClaudeCodeMcp(opts.mcpServers)
    : { servers: {}, names: [] as string[] };
  // (2) Jira REST server riêng của bow-agent — chỉ dùng nếu người dùng chọn 'jira'
  //     nhưng Claude Code CHƯA có MCP jira và JIRA_* đã cấu hình trong .env.
  const hasCcJira = cc.names.some((n) => n.includes('jira'));
  const wantJira = opts.mcpServers && opts.mcpServers.includes('jira');
  const jiraServer = wantJira && !hasCcJira ? buildJiraServer() : null;

  const mcpServers = {
    ...cc.servers,
    ...(jiraServer ? { jira: jiraServer } : {}),
    // Skill kèm code của bow-agent — server nội bộ, luôn có mặt cho mọi repo.
    'bow-skills': buildSkillsServer(),
  };
  const hasMcp = Object.keys(mcpServers).length > 0;

  // Tool đọc tự cho phép; tool ghi/side-effect mặc định hỏi.
  const allowedTools = [
    'Read',
    'Grep',
    'Glob',
    ...(jiraServer ? JIRA_READ_TOOLS : []),
    ...mcpReadToolPatterns(cc.names), // read tools của MCP Claude Code (write phải duyệt)
    ...BOW_SKILLS_READ_TOOLS, // skill kèm code chỉ-đọc/kiểm-chứng (vd run_tests)
  ];

  // System prompt = quy trình chung + skill dùng chung + (nếu có) kiến thức dự án + genome.
  let appendText = BOW_AGENT_APPEND;
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
  // Genome: tri thức ĐỘNG đúc kết qua các lần chạy trước trên chính repo này.
  // Khác projectProfile (tĩnh, sinh 1 lần) — genome tiến hóa theo từng task.
  // Ghi lại gen ĐÃ biểu hiện để sau task gán công/tội (chọn lọc fitness).
  let usedGeneIds: string[] = [];
  if (opts.useGenome === true) {
    const genome = loadGenome(opts.cwd);
    const genomeText = expressGenome(genome);
    if (genomeText) {
      appendText += `\n\n---\n\n${genomeText}`;
      usedGeneIds = expressedIds(genome);
    }
  }

  const SAFE_COMMANDS = [
    /^fvm flutter analyze/,
    /^fvm flutter test/,
    /^bun test/,
    /^npm test/,
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

  const newProjectHint = opts.newProject
    ? '\n\nĐây là DỰ ÁN MỚI (thư mục có thể trống). Hãy đề xuất cấu trúc dự án phù hợp, ' +
      'scaffold khung ban đầu (config, thư mục, màn hình đầu), giải thích lựa chọn stack. ' +
      'Vẫn theo quy trình plan-then-approve.'
    : '';

  const promptText =
    opts.mode === 'plan'
      ? `${opts.brief}${newProjectHint}\n\n---\nHãy HIỂU và LẬP KẾ HOẠCH chi tiết cho task trên (không sửa file). Trình bày kế hoạch để tôi duyệt.`
      : `${opts.brief}${newProjectHint}\n\n---\nHãy thực hiện task trên theo quy trình. Xin duyệt trước các thao tác thay đổi trạng thái.`;

  // Có ảnh → gửi prompt dạng message với content blocks (text + image) để agent nhìn.
  // Không có ảnh → prompt string đơn giản.
  const prompt =
    opts.images && opts.images.length > 0
      ? imagePrompt(promptText, opts.images)
      : promptText;

  let finalText: string | null = null;
  // Gom dữ liệu để phản tư SAU khi vòng query đóng (tránh spawn query lồng nhau
  // giữa lúc đang lặp). Chỉ đặt khi execute + genome bật.
  let reflectInput: { success: boolean } | null = null;

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
        // Ghi kết quả vào genome — chỉ với execute đã bật genome. Một lần
        // chỉ-lập-kế-hoạch chưa tạo hệ quả đúng/sai nên không tính là một thế hệ.
        // Ghi cả thất bại: chọn lọc cần biết gen nào dẫn tới hỏng, không chỉ gen tốt.
        if (opts.mode === 'execute' && opts.useGenome === true) {
          const outcome = { success, turns: message.num_turns };
          recordTaskOutcome(opts.cwd, {
            task: taskLabel(opts.brief),
            success,
            turns: message.num_turns,
            outputTokens: message.usage.output_tokens,
            expressedIds: usedGeneIds,
          });
          // CHỌN LỌC: kéo fitness các gen đã biểu hiện về phía reward, đào thải gen
          // vừa yếu vừa già. recordTaskOutcome đã +1 thế hệ nên tuổi gen tính đúng.
          const selected = applySelection(loadGenome(opts.cwd), usedGeneIds, outcome);
          saveGenome(selected);
          reflectInput = { success };
        }
        break;
      }
      // Các message type khác (stream_event, system, ...) bỏ qua cho gọn.
    }
  }

  // ĐỘT BIẾN: sau khi task xong, phản tư để genome học thêm gen mới về repo.
  // Chạy ngoài vòng query trên; không ném lỗi (reflectAndMutate tự nuốt) nên
  // không ảnh hưởng kết quả task. Chỉ khi có finalText để phản tư.
  if (reflectInput && finalText) {
    const added = await reflectAndMutate({
      cwd: opts.cwd,
      brief: opts.brief,
      finalText,
      success: reflectInput.success,
    });
    if (added > 0) opts.onEvent({ type: 'learned', added });
  }

  return finalText;
}

/**
 * Rút nhãn task ngắn từ brief để ghi vào history (đọc-được, không dùng để tính).
 * Lấy dòng không rỗng đầu tiên, cắt còn 80 ký tự.
 */
function taskLabel(brief: string): string {
  const firstLine = brief.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
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
