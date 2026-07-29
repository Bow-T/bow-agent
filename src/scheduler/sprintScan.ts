import { runAgent, type AgentEvent } from '../core/runner.js';
import { config } from '../config/env.js';
import { loadClaudeCodeMcp } from '../tools/mcp.js';
import { loadQcRouting, renderQcRoutingBrief } from './qcRouting.js';

/**
 * SPRINT-SCAN — vòng lặp agent tự vận hành trên sprint đang chạy.
 *
 * Ý tưởng gốc (người dùng): "agent AI tự lên lịch, tự vào Jira tìm trong sprint đang làm
 * các bug/task, tự động hoá quy trình — tự làm, tự fix, tự assign đúng QC hoặc tự hỏi QC
 * nếu không hiểu."
 *
 * MVP này là MỘT LƯỢT quét (có thể lặp theo interval). Nó KHÔNG nhân đôi logic agent — chỉ
 * dựng một BRIEF điều phối rồi giao cho `runAgent` (cùng lõi CLI/Web dùng). Mọi thao tác GHI
 * vẫn đi qua cổng an toàn của runner:
 *  - dryRun=true  (MẶC ĐỊNH): mode='plan' → agent CHỈ triage + đề xuất (assignee/fix/câu hỏi
 *    cho QC), TUYỆT ĐỐI không sửa file / không ghi Jira. Đây là bản để bạn xem agent định làm
 *    gì trước khi thả phanh — vì tự push thẳng lên sprint thật thì không rollback được.
 *  - dryRun=false (--execute): mode='auto'. Agent tự fix/commit. onApproval tự-duyệt theo
 *    POLICY (xem autoApprovalPolicy) — vẫn CHẶN các lệnh huỷ hoại. Đây là "toàn tự động"
 *    mà bạn chọn, nhưng có phanh ở lệnh rủi ro để một triage sai không xoá sạch được.
 */

export interface SprintScanOptions {
  /** Project key (vd 'PROJ'). Mặc định lấy config.defaultProjectKey (BOW_PROJECT_KEY). */
  projectKey?: string;
  /** Thư mục repo agent thao tác. */
  cwd: string;
  /** Mức reasoning. Mặc định 'high'. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * dryRun=true (mặc định): chỉ triage + đề xuất (mode='plan'), không ghi gì.
   * dryRun=false: agent tự fix/commit/assign (mode='auto', tự-duyệt theo policy).
   */
  dryRun: boolean;
  /** Cho phép agent tự ĐỔI ASSIGNEE / TRANSITION ticket sang QC. Chỉ có tác dụng khi !dryRun. */
  allowAssign: boolean;
  /**
   * Chỉ xử lý các ticket khớp bộ lọc thêm (JQL fragment, vd 'labels = auto-fixable').
   * Rỗng = mọi bug/task đang mở & assign cho tôi trong sprint active.
   */
  extraJql?: string;
  /** Sprint cụ thể người dùng chọn (id + tên). Rỗng = agent tự lấy sprint active. */
  sprint?: { id: number; name: string };
  /** Danh sách ticket key người dùng đã duyệt — agent chỉ làm đúng các key này. Rỗng = quét cả sprint. */
  onlyKeys?: string[];
  /** Model cho lượt chạy. Mặc định config.model. */
  model?: string;
  /** Nguồn kích lượt này — lưu vào lịch sử để dashboard phân biệt tự-động vs bấm tay. */
  trigger?: 'schedule' | 'manual';
  /** Callback tiến độ (CLI in terminal). */
  onEvent: (event: AgentEvent) => void;
}

/**
 * Dựng brief điều phối cho một lượt quét sprint. Đây là "bộ não quy trình" — agent nhận nó
 * rồi TỰ dùng tool Jira (MCP) để thực thi. Ta không tự query Jira ở đây (tránh nhân đôi
 * logic + để agent quyết theo ngữ cảnh), chỉ ra ĐỀ BÀI + RÀNG BUỘC + ĐỊNH TUYẾN QC.
 */
export function buildSprintScanBrief(opts: {
  projectKey: string;
  dryRun: boolean;
  allowAssign: boolean;
  extraJql?: string;
  /** Sprint cụ thể người dùng CHỌN (tên + id). Rỗng = để agent tự lấy sprint active (cũ). */
  sprint?: { id: number; name: string };
  /** DANH SÁCH ticket key người dùng ĐÃ DUYỆT — agent CHỈ được làm đúng các key này. Rỗng = quét cả sprint. */
  onlyKeys?: string[];
}): string {
  const { projectKey, dryRun, allowAssign, extraJql, sprint, onlyKeys } = opts;
  const qcBrief = renderQcRoutingBrief(loadQcRouting());

  // Ràng buộc phạm vi: nếu người dùng đã DUYỆT danh sách ticket cụ thể → CHỈ làm đúng các ticket
  // đó (không tự mở rộng). Đây là "người dùng quyết cuối" — agent không được đụng ticket ngoài list.
  const filterHint = onlyKeys && onlyKeys.length
    ? `CHỈ xử lý ĐÚNG các ticket sau (người dùng đã duyệt — TUYỆT ĐỐI không đụng ticket khác): ${onlyKeys.map((k) => `\`${k}\``).join(', ')}.`
    : extraJql
      ? `Chỉ xử lý ticket khớp thêm điều kiện: \`${extraJql}\`.`
      : 'Ưu tiên ticket đang mở (chưa Done) được giao cho tôi hoặc chưa có người làm.';

  // Ràng buộc theo chế độ — khác nhau HOÀN TOÀN giữa dryRun và execute.
  const modeBlock = dryRun
    ? [
        '## Chế độ: DRY-RUN (chỉ đề xuất, KHÔNG ghi gì)',
        'TUYỆT ĐỐI không sửa file, không chạy git, không ghi Jira (không comment, không đổi',
        'assignee, không transition). Nhiệm vụ của bạn là TRINH SÁT + LẬP KẾ HOẠCH:',
        'với mỗi ticket, in ra: (a) phân loại bug/task, (b) đủ thông tin làm chưa, (c) nếu đủ',
        'thì kế hoạch fix ngắn gọn + file dự kiến đụng, (d) QC nên assign là ai (theo định tuyến',
        'dưới), (e) nếu KHÔNG hiểu thì câu hỏi cụ thể sẽ gửi QC. Kết thúc bằng bảng tổng kết.',
      ].join('\n')
    : [
        '## Chế độ: EXECUTE (tự làm thật)',
        'Với mỗi ticket ĐỦ rõ ràng để làm an toàn:',
        '1. Tạo branch riêng theo quy ước repo (KHÔNG làm trực tiếp trên nhánh chính).',
        '2. Sửa code cho đúng acceptance criteria. Chạy typecheck/test của repo để tự kiểm.',
        '3. Commit theo quy ước repo (KHÔNG kèm trailer ghi công AI — repo có hook chặn).',
        allowAssign
          ? '4. Đổi assignee sang QC phụ trách (theo định tuyến dưới) và transition ticket sang trạng thái chờ QC.'
          : '4. KHÔNG tự đổi assignee/transition (chưa bật --assign) — chỉ comment tóm tắt việc đã làm và đề xuất QC.',
        'Nếu một ticket KHÔNG đủ rõ (thiếu bước tái hiện, AC mơ hồ, ảnh/video không rõ): ĐỪNG',
        'đoán và sửa bừa — comment @mention QC phụ trách hỏi cho rõ (theo định tuyến dưới), rồi',
        'bỏ qua ticket đó, ghi vào tổng kết là "đang chờ QC trả lời".',
        '',
        'AN TOÀN: chỉ tự làm ticket phạm vi NHỎ, rõ ràng. Ticket lớn/mơ hồ/đụng schema-DB/',
        'migration/RLS/thanh toán → CHỈ đề xuất kế hoạch + hỏi, KHÔNG tự sửa.',
      ].join('\n');

  // Sprint: người dùng chọn cụ thể → chỉ vào đúng sprint đó. Không chọn → agent tự lấy active (cũ).
  const sprintLine = sprint
    ? `Làm việc TRÊN sprint đã chọn: **${sprint.name}** (sprint id ${sprint.id}). Dùng tool Jira để lấy issue của đúng sprint này.`
    : 'Dùng tool Jira (MCP) để tìm SPRINT đang active của project này (board của project), rồi liệt kê các issue trong sprint đó.';

  return [
    `# Nhiệm vụ: Xử lý sprint của project ${projectKey}`,
    '',
    sprintLine,
    filterHint,
    '',
    'Với mỗi ticket: đọc summary, mô tả, acceptance criteria, comment, ảnh/video đính kèm VÀ',
    '**reporter (người tạo ticket)** để hiểu đúng yêu cầu TRƯỚC khi hành động. Reporter là người',
    'sẽ được hỏi/assign QC (xem §Định tuyến QC).',
    '',
    modeBlock,
    '',
    qcBrief,
    '',
    '## Nguyên tắc chung',
    '- Đọc CLAUDE.md của repo và tuân thủ quy ước dự án.',
    '- Không đụng ticket đã Done/Closed.',
    '- Mỗi ticket là một đơn vị độc lập — lỗi ở một ticket không được làm hỏng các ticket khác.',
    '- Kết thúc bằng BẢNG TỔNG KẾT: mỗi dòng = ticket, hành động đã làm/đề xuất, QC, trạng thái.',
    '',
    // BLOCK JSON cho dashboard vẽ THẺ triage (mỗi ticket một thẻ màu theo verdict). Song song
    // với bảng text ở trên — text để người đọc, JSON để máy vẽ. Đặt CUỐI cùng để parser dễ tách.
    TRIAGE_JSON_INSTRUCTION,
  ].join('\n');
}

/**
 * Chỉ dẫn agent in một block JSON cấu trúc ở CUỐI tổng kết. Dashboard parse block này để vẽ THẺ
 * triage (thay vì hiển thị text thô khó đọc). Chỉ mô tả — không ép agent đổi cách làm việc.
 */
const TRIAGE_JSON_INSTRUCTION = [
  '## Xuất kết quả có cấu trúc (BẮT BUỘC — để dashboard vẽ thẻ)',
  'Sau bảng tổng kết, in THÊM một block ```json``` duy nhất: một mảng, mỗi phần tử là một ticket:',
  '```json',
  '[',
  '  {',
  '    "key": "PROJ-123",',
  '    "issueType": "bug",           // bug | task | story | ... (viết thường)',
  '    "verdict": "fix",             // done=đã fix&assign | fix=có kế hoạch fix | ask=cần hỏi QC/PM | skip=bỏ qua',
  '    "summary": "một câu tiếng Việt: đã làm/đề xuất gì",',
  '    "files": ["path/file.dart"],  // file dự kiến/đã đụng (rỗng nếu chưa rõ)',
  '    "qc": "tên QC/PM phụ trách hoặc reporter (rỗng nếu không có)"',
  '  }',
  ']',
  '```',
  'verdict CHỈ nhận đúng 4 giá trị: done | fix | ask | skip. Block JSON là NGUỒN CHÍNH cho dashboard —',
  'phải hợp lệ (JSON đúng cú pháp) và phủ ĐỦ mọi ticket đã xử lý.',
].join('\n');

/** Một dòng triage đã cấu trúc — agent xuất qua block JSON, dashboard vẽ thành thẻ màu. */
export interface TriageItem {
  key: string;
  issueType?: string;
  /** done=đã fix&assign | fix=có kế hoạch | ask=cần hỏi | skip=bỏ qua. Giá trị lạ → coi như 'skip'. */
  verdict: 'done' | 'fix' | 'ask' | 'skip';
  summary?: string;
  files?: string[];
  qc?: string;
}

/**
 * Tách mảng TriageItem từ text tổng kết cuối của agent. Tìm block ```json … ``` CUỐI cùng (agent
 * được dặn in JSON sau bảng text), parse & làm sạch từng phần tử. Trả [] nếu không tìm/không hợp lệ —
 * dashboard vẫn còn text summary để hiển thị, nên hỏng JSON không làm mất kết quả.
 */
export function parseTriage(summary: string | null): TriageItem[] {
  if (!summary) return [];
  // Lấy block ```json ... ``` CUỐI cùng (agent in nó sau bảng). Regex 'g' + lấy match cuối.
  const blocks = [...summary.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = blocks.length ? blocks[blocks.length - 1][1] : null;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const VERDICTS = new Set(['done', 'fix', 'ask', 'skip']);
  return parsed
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => {
      const v = String(x.verdict ?? '').toLowerCase();
      return {
        key: String(x.key ?? '').trim(),
        issueType: x.issueType ? String(x.issueType).toLowerCase() : undefined,
        verdict: (VERDICTS.has(v) ? v : 'skip') as TriageItem['verdict'],
        summary: x.summary ? String(x.summary) : undefined,
        files: Array.isArray(x.files) ? x.files.map(String).filter(Boolean) : undefined,
        qc: x.qc ? String(x.qc) : undefined,
      };
    })
    .filter((t) => t.key); // bỏ phần tử không có key (rác)
}

/**
 * POLICY tự-duyệt khi execute. "Toàn tự động" KHÔNG có nghĩa là mù quáng cho qua mọi thứ —
 * ta chặn các lệnh HUỶ HOẠI/không rollback được để một triage sai không phá repo. Trả:
 *  - true  → tự cho phép (agent chạy tiếp không hỏi).
 *  - false → CHẶN (agent phải tự tìm cách khác / bỏ qua).
 *
 * Vì đây là chế độ headless (không người bấm y/N), false = deny cứng chứ không phải "chờ hỏi".
 */
export function autoApprovalPolicy(toolName: string, input: Record<string, unknown>): boolean {
  // Bash: chặn lệnh phá huỷ / vượt phạm vi.
  if (toolName === 'Bash') {
    const cmd = String(input.command ?? '');
    const BLOCK = [
      /\brm\s+-rf?\b/, // xoá đệ quy
      /\bgit\s+push\s+.*(--force|-f)\b/, // force push
      /\bgit\s+reset\s+--hard\b/, // vứt thay đổi
      /\bgit\s+clean\s+-[a-z]*f/, // xoá file chưa track
      /:\s*>\s*\//, // truncate file tuyệt đối
      /\bdd\b|\bmkfs\b|\bshutdown\b|\breboot\b/, // huỷ hoại hệ thống
      /\bcurl\b.*\|\s*(sh|bash)/, // pipe internet vào shell
      /\bsudo\b/, // leo quyền
    ];
    if (BLOCK.some((re) => re.test(cmd))) return false;
    return true;
  }
  // MCP Jira: cho phép ghi (comment/assign/transition/update) — đó chính là việc của quy trình.
  // Nhưng KHÔNG cho tạo/xoá issue (create/delete) tự động — dễ spam sprint.
  if (toolName.startsWith('mcp__') && toolName.includes('jira')) {
    if (/create_issue|create_subtask|delete/i.test(toolName)) return false;
    return true;
  }
  // MCP khác có tác dụng phụ nặng (Supabase apply_migration/execute_sql, Codemagic trigger…):
  // chặn — sprint-scan không nên tự đụng DB/deploy.
  if (toolName.startsWith('mcp__')) {
    if (/apply_migration|execute_sql|trigger_build|upload|submit|promote|release/i.test(toolName)) {
      return false;
    }
    return true;
  }
  // Edit/Write file + các tool còn lại: cho phép (đây là "tự fix").
  return true;
}

/**
 * Chạy MỘT lượt quét sprint. Trả text tổng kết của agent (hoặc null nếu lỗi).
 * Caller (CLI) lo việc lặp theo interval.
 */
export async function runSprintScan(opts: SprintScanOptions): Promise<string | null> {
  const projectKey = opts.projectKey || config.defaultProjectKey;
  if (!projectKey) {
    throw new Error(
      'Chưa biết project key. Truyền --project <KEY> hoặc đặt BOW_PROJECT_KEY / JIRA_PROJECT_KEY.',
    );
  }

  const brief = buildSprintScanBrief({
    projectKey,
    dryRun: opts.dryRun,
    allowAssign: opts.allowAssign,
    extraJql: opts.extraJql,
    sprint: opts.sprint,
    onlyKeys: opts.onlyKeys,
  });

  // Cần Jira MCP để đọc/ghi ticket. Nạp mọi MCP đã cấu hình (đường an toàn: read auto-allow,
  // write qua onApproval/policy). Nếu không có Jira MCP thì agent sẽ báo trong tổng kết.
  const mcpServers = loadClaudeCodeMcp().names;

  const startedAt = new Date().toISOString();

  // SNAPSHOT LOG realtime ra đĩa (~/.bow-agent/sprint-live.json) để dashboard reload KHÔNG mất
  // phần đang xem — và để lượt tự-động (launchd) cũng xem lại được, không chỉ lượt bấm-tay-trên-web.
  // Import động (như appendRunHistory) tránh vòng lặp import scheduler.
  const { saveLiveRun } = await import('./schedule.js');
  const live: import('./schedule.js').SprintLiveRun = {
    startedAt,
    status: 'running',
    projectKey,
    dryRun: opts.dryRun,
    sprintName: opts.sprint?.name,
    ticketCount: opts.onlyKeys?.length,
    log: [],
  };
  let flushTimer: NodeJS.Timeout | null = null;
  const flushLive = (): void => { flushTimer = null; saveLiveRun(live); };
  const appendLive = (cls: 't' | 'tool' | 'ok' | 'err', text: string): void => {
    live.log.push({ cls, text });
    // Debounce 400ms: gộp event dồn dập thành 1 lần ghi đĩa (tránh ghi mỗi token).
    if (!flushTimer) flushTimer = setTimeout(flushLive, 400);
  };
  saveLiveRun(live); // ghi ngay trạng thái 'running' để reload sớm vẫn thấy lượt đang chạy

  // Bắt cost từ event 'result' để lưu vào lịch sử (dashboard hiển thị $/lượt).
  let costUsd: number | undefined;
  const onEvent = (ev: AgentEvent): void => {
    if (ev.type === 'result') { costUsd = ev.costUsd; appendLive('ok', `Xong · ${ev.turns} lượt · $${ev.costUsd.toFixed(4)}`); }
    else if (ev.type === 'text') appendLive('t', ev.text);
    else if (ev.type === 'tool') appendLive('tool', ev.describe);
    else if (ev.type === 'error') appendLive('err', ev.subtype);
    opts.onEvent(ev);
  };

  let summary: string | null = null;
  let error: string | undefined;
  try {
    summary = await runAgent({
      brief,
      cwd: opts.cwd,
      // dryRun → 'plan' (SDK tự chặn mọi tool ghi). execute → 'auto' + policy tự-duyệt.
      mode: opts.dryRun ? 'plan' : 'auto',
      effort: opts.effort ?? 'high',
      model: opts.model ?? config.model,
      mcpServers,
      onEvent,
      // Ở execute, requireApprovalForWrites=true ép MỌI thao tác ghi đi qua onApproval; onApproval
      // của ta áp policy (chặn lệnh huỷ hoại) rồi tự trả true/false — không có người bấm.
      ...(opts.dryRun
        ? {}
        : {
            requireApprovalForWrites: true,
            onApproval: async (toolName: string, input: Record<string, unknown>) =>
              autoApprovalPolicy(toolName, input),
          }),
    });
  } catch (err) {
    error = (err as Error).message;
    throw err;
  } finally {
    const triage = parseTriage(summary);
    // Chốt snapshot live cuối cùng (huỷ debounce đang chờ để không đè status done bằng running).
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    live.status = error ? 'error' : 'done';
    live.triage = triage;
    if (error) { live.error = error; live.log.push({ cls: 'err', text: error }); }
    saveLiveRun(live);
    // Lưu lịch sử lượt quét (kể cả khi lỗi) để dashboard theo dõi. Import động tránh vòng lặp.
    const { appendRunHistory } = await import('./schedule.js');
    appendRunHistory({
      startedAt,
      endedAt: new Date().toISOString(),
      trigger: opts.trigger ?? 'manual',
      projectKey,
      dryRun: opts.dryRun,
      summary,
      // Kết quả triage đã cấu trúc (tách từ block JSON cuối) — dashboard vẽ thành thẻ màu.
      triage,
      costUsd,
      error,
    });
  }
  return summary;
}
