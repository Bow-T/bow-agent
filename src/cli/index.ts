#!/usr/bin/env node
import { buildTaskBrief, type TaskInput } from '../input/task.js';
import { parseJiraRef } from '../input/jira-ref.js';
import { fetchJiraTicketImages, fetchJiraTicketVideos } from '../input/jira-attachments.js';
import { runAgent, type AgentEvent } from '../core/runner.js';
import { createTicketWorktree, listWorktrees, removeTicketWorktree } from '../core/gitWorktree.js';
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
  bow-agent sprint-scan               Tự quét sprint đang chạy: triage bug/task, đề xuất fix + QC
                                      (mặc định DRY-RUN — chỉ đề xuất, không ghi gì)
  bow-agent schedule set …            Cấu hình lịch tự chạy (giờ + project + chế độ)
  bow-agent schedule install          Cài LaunchAgent (macOS) để tự kích theo lịch
  bow-agent schedule status           Xem lịch + trạng thái launchd
  bow-agent worktree add <TICKET>     Tạo git worktree riêng cho ticket (chạy song song nhiều cửa sổ)
  bow-agent worktree list             Liệt kê worktree hiện có của repo (--cwd)
  bow-agent worktree remove <TICKET>  Gỡ worktree + xoá branch của ticket đã xong việc

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

Cờ riêng cho sprint-scan:
  --project <KEY>          Project Jira cần quét (mặc định: BOW_PROJECT_KEY / JIRA_PROJECT_KEY)
  --execute                Tự làm thật (fix/commit). Mặc định DRY-RUN: chỉ triage + đề xuất
  --assign                 (kèm --execute) Cho agent tự đổi assignee sang QC + transition ticket
  --jql "<fragment>"       Lọc thêm ticket (vd: 'labels = auto-fixable')
  --interval <30m|1h|...>  Lặp lại lượt quét theo chu kỳ (bỏ trống = chạy một lần rồi thoát)

Cờ riêng cho schedule set:
  --at <HH:MM[,HH:MM]>     Mốc giờ chạy trong ngày (vd: 09:00,14:00)
  --project / --execute / --assign / --jql / --effort   (như sprint-scan) lưu vào lịch

Ví dụ:
  bow-agent run PROJ-123 --cwd ~/GitProject/monorepo
  bow-agent run --wbs ./task.md --execute
  bow-agent run PROJ-123 --wbs ./ac.md --execute --effort xhigh
  bow-agent run --text "sửa nút X" --profile none    # agent tổng quát
  bow-agent sprint-scan --project PROJ --cwd ~/GitProject/monorepo   # dry-run, xem agent định làm gì
  bow-agent sprint-scan --project PROJ --execute --assign            # toàn tự động: fix + assign QC
  bow-agent sprint-scan --project PROJ --interval 1h                 # tự lặp mỗi giờ (dry-run)
  bow-agent worktree add PROJ-123 --cwd ~/GitProject/monorepo   # tạo ../monorepo-wt-PROJ-123, branch feat/PROJ-123
  bow-agent worktree list --cwd ~/GitProject/monorepo
  bow-agent worktree remove PROJ-123 --cwd ~/GitProject/monorepo
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
  // ── Cờ riêng cho sprint-scan ──
  /** Project Jira cần quét (sprint-scan). */
  project?: string;
  /** (sprint-scan) Cho agent tự đổi assignee sang QC + transition. Chỉ tác dụng khi --execute. */
  assign?: boolean;
  /** (sprint-scan) JQL fragment lọc thêm ticket. */
  jql?: string;
  /** (sprint-scan) Chu kỳ lặp dạng '30m'/'1h'/'90s'. Bỏ trống = chạy một lần. */
  interval?: string;
  /** (sprint-scan) --tick: đọc sprint-schedule.json, chỉ chạy nếu đã tới mốc giờ. Dùng cho launchd. */
  tick?: boolean;
  /** (schedule) subcommand con: set | install | uninstall | status. */
  scheduleAction?: string;
  /** (schedule set) mốc giờ chạy trong ngày, "HH:MM", nhiều mốc cách nhau dấu phẩy. */
  atTimes?: string[];
  /** Đối số không-cờ thứ hai — dùng cho `worktree add|remove <TICKET>` (đối số đầu là action, rơi vào ticketKey). */
  secondArg?: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    execute: false,
    cwd: config.defaultCwd,
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
      case '--project':
        out.project = requireValue('--project', rest.shift());
        break;
      case '--assign':
        out.assign = true;
        break;
      case '--jql':
        out.jql = requireValue('--jql', rest.shift());
        break;
      case '--interval':
        out.interval = requireValue('--interval', rest.shift());
        break;
      case '--tick':
        out.tick = true;
        break;
      case '--at':
        out.atTimes = requireValue('--at', rest.shift())
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      default:
        // Đối số không cờ đầu tiên = Jira ticket key (hoặc action con của schedule/worktree);
        // đối số thứ hai chỉ hợp lệ cho `worktree add|remove <TICKET>` → secondArg.
        if (arg.startsWith('-')) fail(`Cờ không nhận diện được: ${arg}`);
        else if (!out.ticketKey) out.ticketKey = arg;
        else if (!out.secondArg) out.secondArg = arg;
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

/**
 * Dòng breakdown token cuối phiên — để CHẨN ĐOÁN token đi đâu. `cacheRead` là nền cố định
 * (MCP tool schema + skill descriptions + system prompt) đọc lại mỗi lượt; `fresh` là input
 * tính giá đầy đủ; `creation` là phần vừa ghi cache; `output` là token model sinh ra. Tỷ lệ
 * cacheRead cao mà fresh thấp = cache đang hoạt động tốt (nền đắt nhưng chỉ tính ~0.1× giá).
 */
function fmtTokenBreakdown(ev: {
  inputFresh: number;
  cacheRead: number;
  cacheCreation: number;
  outputTokens: number;
}): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  return `   ↳ token: cache-read ${k(ev.cacheRead)} · fresh ${k(ev.inputFresh)} · cache-write ${k(ev.cacheCreation)} · output ${k(ev.outputTokens)}\n`;
}

function fail(msg: string): never {
  process.stderr.write(`Lỗi: ${msg}\n\n${USAGE}\n`);
  process.exit(1);
}

/** Parse chu kỳ '30m'/'1h'/'90s'/'500' → ms. Số trần = giây. Ném lỗi nếu sai định dạng. */
function parseInterval(raw: string): number {
  const m = raw.trim().match(/^(\d+)\s*(s|m|h)?$/i);
  if (!m) fail(`--interval không hợp lệ: "${raw}". Dùng dạng 30s / 15m / 1h.`);
  const n = parseInt(m![1], 10);
  const unit = (m![2] || 's').toLowerCase();
  const mult = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000;
  return n * mult;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Xử lý --tick: đọc sprint-schedule.json, chỉ chạy nếu isDue. Dùng bởi launchd (kích đều,
 * agent tự quyết bỏ qua). In lý do rồi thoát 0 dù bỏ qua — launchd không coi là lỗi.
 */
async function runTick(): Promise<void> {
  const { loadSchedule, saveSchedule, isDue } = await import('../scheduler/schedule.js');
  const { runSprintScan } = await import('../scheduler/sprintScan.js');
  const sched = loadSchedule();
  if (!sched) {
    process.stdout.write(`⏭️  --tick: chưa có lịch (chạy \`bow schedule set …\` trước). Bỏ qua.\n`);
    return;
  }
  const now = new Date();
  const decision = isDue(sched, now);
  if (!decision.due) {
    process.stdout.write(`⏭️  --tick ${now.toISOString()}: bỏ qua — ${decision.reason}.\n`);
    return;
  }
  process.stdout.write(`▶ --tick ${now.toISOString()}: chạy — ${decision.reason}.\n`);
  // Cập nhật lastRunAt TRƯỚC khi chạy để một launchd tick khác chồng lên không chạy trùng.
  saveSchedule({ ...sched, lastRunAt: now.toISOString() });
  await runSprintScan({
    projectKey: sched.projectKey,
    cwd: sched.cwd || config.defaultCwd,
    effort: sched.effort ?? 'high',
    dryRun: sched.dryRun,
    allowAssign: sched.allowAssign,
    extraJql: sched.extraJql,
    onEvent: (ev) => {
      if (ev.type === 'text') process.stdout.write(`🤖 ${ev.text}\n`);
      else if (ev.type === 'tool') process.stdout.write(`🔧 ${ev.describe}\n`);
      else if (ev.type === 'result') process.stdout.write(`✅ Xong · $${ev.costUsd.toFixed(4)}\n`);
      else if (ev.type === 'error') process.stdout.write(`⚠️  ${ev.subtype}\n`);
    },
  });
}

/** Xử lý subcommand `sprint-scan`: tự quét sprint, dry-run mặc định, có thể lặp theo interval. */
async function runSprintScanCommand(args: ParsedArgs): Promise<void> {
  if (args.tick) {
    await runTick();
    return;
  }
  const { runSprintScan } = await import('../scheduler/sprintScan.js');
  const dryRun = !args.execute;
  const intervalMs = args.interval ? parseInterval(args.interval) : 0;
  const projectLabel = args.project || config.defaultProjectKey || '(chưa đặt — sẽ lỗi)';
  const modeLabel = dryRun ? 'DRY-RUN (chỉ đề xuất)' : args.assign ? 'EXECUTE + tự assign QC' : 'EXECUTE';

  process.stdout.write(
    `\n▶ bow sprint-scan · project=${projectLabel} · mode=${modeLabel} · effort=${args.effort} · ` +
      `interval=${args.interval || 'một lần'} · cwd=${args.cwd}\n\n`,
  );
  if (!dryRun) {
    process.stdout.write(
      '⚠️  Chế độ EXECUTE: agent sẽ TỰ sửa code' +
        (args.assign ? ', TỰ commit và TỰ đổi assignee/transition Jira' : ' và TỰ commit') +
        '. Lệnh huỷ hoại (rm -rf, force push, sudo…) bị chặn cứng. Ctrl-C để dừng.\n\n',
    );
  }

  const onEvent = (ev: AgentEvent): void => {
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
        process.stdout.write(fmtTokenBreakdown(ev));
        break;
      case 'error':
        process.stdout.write(`⚠️  Kết thúc bất thường: ${ev.subtype}\n`);
        break;
    }
  };

  // Một lượt. Bọc try/catch để lỗi một lượt không giết vòng lặp interval.
  const runOnce = async (): Promise<void> => {
    try {
      await runSprintScan({
        projectKey: args.project,
        cwd: args.cwd,
        effort: args.effort,
        dryRun,
        allowAssign: Boolean(args.assign),
        extraJql: args.jql,
        onEvent,
      });
    } catch (err) {
      process.stdout.write(`❌ Lượt quét lỗi: ${(err as Error).message}\n`);
      // Nếu chạy một lần (không interval), ném ra để exit code != 0.
      if (!intervalMs) throw err;
    }
  };

  if (!intervalMs) {
    await runOnce();
    if (dryRun) {
      process.stdout.write('\n💡 Đây là bản DRY-RUN (chưa ghi gì). Thêm --execute để agent tự làm.\n');
    }
    return;
  }

  // Vòng lặp interval: chạy ngay lượt đầu rồi lặp. Ctrl-C (SIGINT) để dừng.
  process.stdout.write(`⏱️  Lặp mỗi ${args.interval}. Nhấn Ctrl-C để dừng.\n\n`);
  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
    process.stdout.write('\n⏹️  Nhận Ctrl-C — dừng sau lượt hiện tại.\n');
  });
  // eslint-disable-next-line no-constant-condition
  while (!stopped) {
    const startedAt = new Date().toISOString();
    process.stdout.write(`\n──── Lượt quét lúc ${startedAt} ────\n`);
    await runOnce();
    if (stopped) break;
    process.stdout.write(`\n😴 Ngủ ${args.interval} tới lượt sau…\n`);
    await sleep(intervalMs);
  }
}

/**
 * Xử lý subcommand `schedule`: quản lịch tự chạy của con agent + cài/gỡ launchd.
 *   bow schedule set --project KEY --at 09:00,14:00 [--execute --assign --jql "…"]
 *   bow schedule install     # sinh + nạp LaunchAgent gọi --tick mỗi 5 phút
 *   bow schedule uninstall   # gỡ LaunchAgent
 *   bow schedule status      # in lịch + trạng thái launchd
 * Action con là token không-cờ đầu tiên (parser gán vào args.ticketKey).
 */
async function runScheduleCommand(args: ParsedArgs): Promise<void> {
  const action = args.ticketKey || 'status';
  const sched = await import('../scheduler/schedule.js');
  const lch = await import('../scheduler/launchd.js');

  if (action === 'set') {
    if (!args.atTimes || args.atTimes.length === 0) {
      fail('schedule set cần --at HH:MM[,HH:MM] (mốc giờ chạy trong ngày).');
    }
    const existing = sched.loadSchedule();
    const next: import('../scheduler/schedule.js').SprintSchedule = {
      enabled: true,
      projectKey: args.project ?? existing?.projectKey,
      cwd: args.cwd || existing?.cwd,
      atTimes: args.atTimes!,
      weekdays: existing?.weekdays,
      dryRun: !args.execute,
      allowAssign: Boolean(args.assign),
      extraJql: args.jql ?? existing?.extraJql,
      effort: args.effort,
      lastRunAt: existing?.lastRunAt,
    };
    sched.saveSchedule(next);
    process.stdout.write(
      `✅ Đã lưu lịch: ${sched.schedulePath()}\n` +
        `   project=${next.projectKey ?? '(env)'} · at=${next.atTimes.join(',')} · ` +
        `mode=${next.dryRun ? 'DRY-RUN' : next.allowAssign ? 'EXECUTE+assign' : 'EXECUTE'}\n` +
        `→ Chạy \`bow schedule install\` để launchd tự kích theo lịch.\n`,
    );
    return;
  }

  if (action === 'install') {
    if (!sched.loadSchedule()) {
      fail('Chưa có lịch. Chạy `bow schedule set --project … --at HH:MM` trước.');
    }
    // Chạy CLI qua tsx (src) nếu đang dev, hoặc node dist nếu đã build. Ưu tiên dist nếu có.
    const { existsSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { createRequire } = await import('node:module');
    const here = dirname(fileURLToPath(import.meta.url));
    const distEntry = resolve(here, 'index.js'); // khi chạy từ dist/cli/index.js
    const srcEntry = resolve(here, 'index.ts'); // khi chạy từ src qua tsx
    const useDist = existsSync(distEntry) && here.includes('dist');
    const cliEntry = useDist ? distEntry : srcEntry;
    // WorkingDirectory launchd = THƯ MỤC bow-agent (here = <bow>/[dist/]cli → lùi 2 cấp), nơi Node
    // resolve tsx. KHÔNG dùng args.cwd (repo đích) — nó không có node_modules/tsx → tick crash. cwd
    // repo đích do --tick tự đọc từ sprint-schedule.json/BOW_CWD, độc lập WorkingDirectory này.
    const bowRoot = resolve(here, '..', '..');
    // Dev (src .ts): --import tsx bằng ĐƯỜNG DẪN TUYỆT ĐỐI (không bare 'tsx' — phụ thuộc cwd).
    let tsxLoader: string | undefined;
    if (!useDist) {
      try {
        tsxLoader = createRequire(resolve(bowRoot, 'noop.js')).resolve('tsx');
      } catch {
        tsxLoader = 'tsx';
      }
    }
    const res = lch.installLaunchd({
      cliEntry,
      tsxLoader,
      cwd: bowRoot,
    });
    process.stdout.write(
      `${res.loaded ? '✅ Đã nạp' : '⚠️  Đã ghi plist nhưng chưa nạp được'} LaunchAgent: ${res.plist}\n` +
        `   Nó gọi \`sprint-scan --tick\` mỗi 5 phút; agent tự chạy khi tới mốc giờ trong lịch.\n` +
        `   Log: ~/.bow-agent/sprint-scan.log · Gỡ: \`bow schedule uninstall\`\n`,
    );
    return;
  }

  if (action === 'uninstall') {
    const res = lch.uninstallLaunchd();
    process.stdout.write(res.removed ? '✅ Đã gỡ LaunchAgent.\n' : 'ℹ️  Không có LaunchAgent để gỡ.\n');
    return;
  }

  // status (mặc định)
  const s = sched.loadSchedule();
  const { existsSync } = await import('node:fs');
  process.stdout.write(`\n📅 Lịch sprint-scan (${sched.schedulePath()}):\n`);
  if (!s) {
    process.stdout.write('   (chưa cấu hình — chạy `bow schedule set …`)\n');
  } else {
    const decision = sched.isDue(s, new Date());
    process.stdout.write(
      `   enabled=${s.enabled} · project=${s.projectKey ?? '(env)'} · at=${s.atTimes.join(',')}\n` +
        `   mode=${s.dryRun ? 'DRY-RUN' : s.allowAssign ? 'EXECUTE+assign' : 'EXECUTE'} · effort=${s.effort ?? 'high'}\n` +
        `   lastRunAt=${s.lastRunAt ?? '(chưa chạy)'} · bây giờ ${decision.due ? 'TỚI GIỜ' : 'chưa tới'} (${decision.reason})\n`,
    );
  }
  process.stdout.write(
    `   LaunchAgent: ${existsSync(lch.plistPath()) ? 'ĐÃ CÀI' : 'chưa cài'} (${lch.plistPath()})\n`,
  );
}

/**
 * Xử lý subcommand `worktree`: tạo/liệt kê/gỡ git worktree cho ticket — để mỗi cửa sổ chạy
 * một ticket riêng trên cùng repo đích mà không dẫm chân nhau. Action con ("add"/"list"/"remove")
 * là đối số không-cờ đầu tiên → args.ticketKey; tên ticket (nếu action cần) là đối số thứ hai →
 * args.secondArg (xem parseArgs).
 */
async function runWorktreeCommand(action: string | undefined, ticket: string | undefined, cwd: string): Promise<void> {
  if (action === 'add') {
    if (!ticket) fail('worktree add cần tên ticket, vd: bow worktree add PROJ-123');
    const res = createTicketWorktree({ repoCwd: cwd, ticket: ticket! });
    process.stdout.write(
      `✅ Đã tạo worktree: ${res.path}\n   branch: ${res.branch}\n` +
        `→ Mở cửa sổ mới trỏ vào đó, hoặc chạy ngay:\n` +
        `   bow run ${ticket} --cwd ${res.path}\n`,
    );
    return;
  }
  if (action === 'remove') {
    if (!ticket) fail('worktree remove cần tên ticket, vd: bow worktree remove PROJ-123');
    removeTicketWorktree(cwd, ticket!, true);
    process.stdout.write(`✅ Đã gỡ worktree + branch của ticket: ${ticket}\n`);
    return;
  }
  // list (mặc định)
  const entries = listWorktrees(cwd);
  process.stdout.write(`\n🌳 Worktree của ${cwd}:\n`);
  for (const w of entries) {
    process.stdout.write(`   ${w.path}${w.branch ? ` [${w.branch}]` : ' (detached)'}  ${w.head.slice(0, 8)}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.command) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(args.help ? 0 : 1);
  }

  if (args.command === 'sprint-scan') {
    await runSprintScanCommand(args);
    return;
  }

  if (args.command === 'schedule') {
    await runScheduleCommand(args);
    return;
  }

  if (args.command === 'worktree') {
    await runWorktreeCommand(args.ticketKey, args.secondArg, args.cwd);
    return;
  }

  if (args.command !== 'run') {
    fail(`Lệnh không hợp lệ: "${args.command}". Hỗ trợ: "run", "sprint-scan", "schedule", "worktree".`);
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
  // Provider ngoài đổi cả nguồn auth: không còn login Claude mà là token gateway.
  const isExternal = config.provider !== 'anthropic';
  const authLabel = config.hasAuth
    ? isExternal
      ? `gateway ${config.provider}`
      : 'Claude CLI login'
    : isExternal
      ? 'THIẾU BOW_PROVIDER_TOKEN'
      : 'CHƯA ĐĂNG NHẬP';
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
          process.stdout.write(fmtTokenBreakdown(ev));
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
