#!/usr/bin/env node
import { buildTaskBrief, type TaskInput } from '../input/task.js';
import { parseJiraRef } from '../input/jira-ref.js';
import { fetchJiraTicketImages, fetchJiraTicketVideos } from '../input/jira-attachments.js';
import { runAgent } from '../core/runner.js';
import { config } from '../config/env.js';
import { getProfile, profileNames } from '../profiles/index.js';
import { loadClaudeCodeMcp } from '../tools/mcp.js';

/**
 * CLI của bow-agent.
 *
 *   bow-agent run <TICKET>            # nhận task từ Jira ticket
 *   bow-agent run --wbs <file>        # nhận task từ file WBS/đề tài
 *   bow-agent run --text "..."        # nhận task từ text trực tiếp
 *   bow-agent run <TICKET> --wbs f.md # kết hợp
 *
 * Cờ:
 *   --execute        Thực thi (mặc định chỉ 'plan' — lập kế hoạch, không sửa file)
 *   --cwd <dir>      Thư mục repo agent thao tác (mặc định: thư mục hiện tại)
 *   --effort <lvl>   low|medium|high|xhigh|max (mặc định: high)
 */

const USAGE = `
bow-agent — AI agent nhận đề tài / WBS / Jira ticket rồi lập kế hoạch & thực thi.

Cách dùng:
  bow-agent run <TICKET>              Nhận task từ Jira ticket (vd: PROJ-123)
  bow-agent run --wbs <file>          Nhận task từ file WBS / đề tài (markdown/text)
  bow-agent run --text "<mô tả>"      Nhận task từ text trực tiếp

Cờ:
  --execute                Thực thi thật (mặc định chỉ LẬP KẾ HOẠCH, không sửa file)
  --mcp [a,b]              MCP (Jira / Supabase / Figma... từ Claude Code). MẶC ĐỊNH BẬT
                           tất cả (để agent đọc được Jira ticket). Kèm danh sách để chỉ
                           nạp vài server: --mcp jira,supabase
  --no-mcp                 Tắt hoàn toàn MCP (chạy offline, không đọc Jira/DB).
  --cwd <dir>              Thư mục repo agent làm việc (mặc định: thư mục hiện tại)
  --profile <name>         Kiến thức dự án: none | (các tên profile tự sinh) (mặc định: none)
  --subagents              Bật multi-agent: agent chính giao việc cho subagent chuyên
                           biệt (reviewer / verifier / impact-scout). MẶC ĐỊNH TẮT.
  --effort <low|medium|high|xhigh|max>   Mức reasoning (mặc định: high)
  -h, --help               In hướng dẫn này

Ví dụ:
  bow-agent run PROJ-123 --cwd ~/GitProject/monorepo
  bow-agent run --wbs ./task.md --execute
  bow-agent run PROJ-123 --wbs ./ac.md --execute --effort xhigh
  bow-agent run --text "sửa nút X" --profile none    # agent tổng quát
`.trim();

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

interface ParsedArgs {
  command?: string;
  ticketKey?: string;
  wbsPath?: string;
  text?: string;
  execute: boolean;
  cwd: string;
  effort: Effort;
  profile: string;
  /** Bật multi-agent (subagent chuyên biệt). Mặc định tắt. */
  subagents: boolean;
  mcpServers?: string[];
  useMcpAll?: boolean;
  /** Tắt MCP (mặc định BẬT — tự nạp Jira/Supabase/... để agent đọc ticket được). */
  noMcp?: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    execute: false,
    cwd: process.cwd(),
    effort: 'high',
    profile: 'none',
    subagents: false,
    help: false,
  };
  const rest = [...argv];
  // Token đầu tiên là lệnh chỉ khi nó không phải cờ (vd "run"); nếu là -h/--help
  // hoặc rỗng thì để vòng lặp dưới bắt, tránh nuốt "--help" thành command sai.
  if (rest.length > 0 && !rest[0].startsWith('-')) {
    out.command = rest.shift();
  }

  while (rest.length > 0) {
    const arg = rest.shift() as string;
    switch (arg) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '--execute':
        out.execute = true;
        break;
      case '--mcp': {
        const next = rest[0];
        if (next && !next.startsWith('-')) {
          out.mcpServers = rest.shift()!.split(',');
        } else {
          out.useMcpAll = true;
        }
        break;
      }
      case '--no-mcp':
        out.noMcp = true;
        break;
      case '--wbs':
        out.wbsPath = requireValue('--wbs', rest.shift());
        break;
      case '--text':
        out.text = requireValue('--text', rest.shift());
        break;
      case '--cwd':
        out.cwd = requireValue('--cwd', rest.shift());
        break;
      case '--effort': {
        const val = requireValue('--effort', rest.shift());
        if (!EFFORTS.includes(val as Effort)) {
          fail(`--effort không hợp lệ: "${val}". Chọn một trong: ${EFFORTS.join(', ')}`);
        }
        out.effort = val as Effort;
        break;
      }
      case '--profile':
        out.profile = requireValue('--profile', rest.shift());
        break;
      case '--subagents':
        out.subagents = true;
        break;
      default:
        // Đối số không cờ đầu tiên = Jira ticket key.
        if (arg.startsWith('-')) fail(`Cờ không nhận diện được: ${arg}`);
        else if (!out.ticketKey) out.ticketKey = arg;
        else fail(`Đối số thừa: ${arg}`);
    }
  }
  return out;
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) fail(`Cờ ${flag} cần một giá trị.`);
  return value as string;
}

/** Format thời lượng ms → chuỗi gọn kiểu "1g 23p 45s" / "3p 42s" / "58s". */
function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}g ${m}p ${s}s`;
  if (m > 0) return `${m}p ${s}s`;
  return `${s}s`;
}

function fail(msg: string): never {
  process.stderr.write(`Lỗi: ${msg}\n\n${USAGE}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.command) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(args.help ? 0 : 1);
  }

  if (args.command !== 'run') {
    fail(`Lệnh không hợp lệ: "${args.command}". Chỉ hỗ trợ "run".`);
  }

  const input: TaskInput = {
    jiraRef: args.ticketKey,
    docPaths: args.wbsPath ? [args.wbsPath] : undefined,
    text: args.text,
  };

  // Tải ảnh đính kèm ticket Jira (mockup/screenshot) để agent NHÌN — MCP chỉ trả text nên
  // ta tự gọi REST có auth (jira-attachments.ts). Fail-open: thiếu auth/lỗi tải đều bỏ qua.
  const jiraImages: { base64: string; mediaType: string }[] = [];
  const ticketKey = args.ticketKey ? parseJiraRef(args.ticketKey).ticketKey : undefined;
  if (ticketKey) {
    const fetched = await fetchJiraTicketImages(ticketKey);
    input.jiraImageNames = fetched.images.map((i) => i.filename);
    input.jiraImageFailed = fetched.failed;
    jiraImages.push(...fetched.images.map((i) => ({ base64: i.base64, mediaType: i.mediaType })));
    if (fetched.images.length > 0) {
      process.stdout.write(`🖼️  Đã tải ${fetched.images.length} ảnh từ ticket ${ticketKey}.\n`);
    }
    // Video ticket: tải về đĩa để agent dùng skill /watch xem (không vào images[]).
    const vids = await fetchJiraTicketVideos(ticketKey);
    input.jiraVideos = vids.videos.map((v) => ({ filename: v.filename, path: v.path }));
    input.jiraVideosSkipped = vids.skippedTooLarge;
    if (vids.videos.length > 0) {
      process.stdout.write(`🎬 Đã tải ${vids.videos.length} video từ ticket ${ticketKey} (dùng /watch để xem).\n`);
    }
  }

  // Ticket Jira được đọc qua MCP jira của Claude Code (không cần JIRA_* trong .env nữa).
  // Chỉ cảnh báo nhẹ nếu vừa không có MCP jira vừa không có JIRA_* — không chặn.

  // Chọn project profile (kiến thức + subagent riêng). 'none' = agent tổng quát.
  let projectProfile: string | undefined;
  let profileSubagents: NonNullable<ReturnType<typeof getProfile>>['subagents'] | undefined;
  if (args.profile !== 'none') {
    const prof = getProfile(args.profile);
    if (!prof) {
      fail(`--profile không hợp lệ: "${args.profile}". Chọn một trong: ${profileNames().join(', ')}`);
    }
    projectProfile = (prof as NonNullable<typeof prof>).knowledge;
    profileSubagents = (prof as NonNullable<typeof prof>).subagents;
  }

  const brief = await buildTaskBrief(input);
  if (!brief) {
    fail('Không có đầu vào. Cần ít nhất một trong: <TICKET>, --wbs <file>, --text "...".');
  }

  const mode = args.execute ? 'execute' : 'plan';
  const profileLabel = args.profile === 'none' ? 'none' : args.profile;
  const authLabel = config.hasAuth ? 'Claude CLI login' : 'CHƯA ĐĂNG NHẬP';
  // MCP MẶC ĐỊNH BẬT: tự nạp mọi server đã cấu hình trong Claude Code (Jira/Supabase/
  // Figma...) để agent đọc được ticket Jira. Tùy chọn:
  //   --mcp a,b   : chỉ nạp các server chỉ định
  //   --no-mcp    : tắt hoàn toàn
  //   (không cờ)  : nạp tất cả (mặc định)
  let mcpServers: string[] | undefined;
  if (args.noMcp) {
    mcpServers = undefined;
  } else if (args.mcpServers) {
    mcpServers = args.mcpServers;
  } else {
    mcpServers = loadClaudeCodeMcp().names;
  }

  const mcpLabel = mcpServers && mcpServers.length > 0 ? mcpServers.join(',') : 'off';
  const subagentsLabel = args.subagents ? 'on' : 'off';

  process.stdout.write(
    `\n▶ bow-agent · model=${config.model} · auth=${authLabel} · mode=${mode} · effort=${args.effort} · profile=${profileLabel} · mcp=${mcpLabel} · subagents=${subagentsLabel} · cwd=${args.cwd}\n\n`,
  );

  const result = await runAgent({
    brief: brief as string,
    cwd: args.cwd,
    mode,
    effort: args.effort,
    projectProfile,
    images: jiraImages.length > 0 ? jiraImages : undefined,
    mcpServers,
    useSubagents: args.subagents,
    profileSubagents,
    onEvent: (ev) => {
      switch (ev.type) {
        case 'text':
          process.stdout.write(`🤖 ${ev.text}\n`);
          break;
        case 'tool':
          process.stdout.write(`🔧 ${ev.describe}\n`);
          break;
        case 'result':
          process.stdout.write(
            `✅ Xong sau ${fmtDuration(ev.durationMs)} · ${ev.turns} lượt · ${ev.outputTokens} output tokens · $${ev.costUsd.toFixed(4)}\n`,
          );
          break;
        case 'error':
          process.stdout.write(`⚠️  Kết thúc bất thường: ${ev.subtype}\n`);
          break;
      }
    },
    onApproval: mode === 'execute' ? promptApproval : undefined,
  });

  if (result === null) {
    process.exit(1);
  }

  if (mode === 'plan') {
    process.stdout.write(
      '\n💡 Đây là kế hoạch (chưa sửa gì). Chạy lại với --execute để thực thi.\n',
    );
  }
}

/**
 * Hỏi người dùng duyệt một thao tác GHI trực tiếp trên terminal (y/N).
 * Cổng "plan-then-approve" ở tầng execute cho CLI (web dùng nút bấm thay hàm này).
 */
async function promptApproval(
  toolName: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const preview = JSON.stringify(input, null, 2).slice(0, 800);
    process.stdout.write(`\n⛔ Cần duyệt thao tác: ${toolName}\n${preview}\n`);
    const answer = (await rl.question('   Cho phép? (y/N) ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`\n❌ ${(err as Error).message}\n`);
  process.exit(1);
});
