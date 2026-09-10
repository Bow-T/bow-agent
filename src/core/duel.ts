/**
 * DUEL — chạy SONG SONG hai AI (vd Claude + Grok) trên CÙNG một task, mỗi bên trong một git
 * worktree riêng, rồi cho hai bên ĐỔI CHÉO diff để soi lỗi của nhau.
 *
 * VÌ SAO worktree: hai agent cùng ghi vào một thư mục sẽ đè file + git index của nhau. Worktree
 * (đã có sẵn `gitWorktree.ts`) cho mỗi bên một working directory vật lý riêng mà vẫn chung .git.
 *
 * VÌ SAO tách module: lõi này KHÔNG biết web hay CLI — nó nhận callback (onEvent/onApproval) y
 * như `runAgent`, nên cả hai mặt dùng chung. Mọi thao tác GHI của hai bên vẫn đi qua `canUseTool`
 * trong runner (cổng an toàn duy nhất) — duel KHÔNG nới thêm quyền gì, chỉ nhân đôi số luồng.
 *
 * Pha 2 (review chéo) chạy mode 'plan' — SDK chặn cứng mọi tool ghi, nên reviewer chỉ đọc và
 * báo cáo; việc SỬA theo báo cáo là một lượt riêng do người dùng bấm (xem `buildFixBrief`).
 */
import { execFileSync } from 'node:child_process';
import { runAgent, type AgentEvent, type Question, type RunOptions } from './runner.js';
import { createTicketWorktree, removeTicketWorktree } from './gitWorktree.js';
import type { ProviderId } from '../config/env.js';

/** Hai phía của trận đấu. 'A' = bên chạy trước trong danh sách, 'B' = bên còn lại. */
export type DuelSideId = 'A' | 'B';

/** Cấu hình AI cho MỘT phía. Bỏ trống provider = dùng AI mặc định của tiến trình. */
export interface DuelSideSpec {
  id: DuelSideId;
  /** Nhãn hiển thị trong chat/log, vd 'Claude Opus 5' hay 'Grok'. */
  label: string;
  provider?: ProviderId;
  /** Tài khoản gateway (khi provider ngoài). */
  providerProfile?: string;
  /** Tài khoản Claude per-tab (khi provider = anthropic). */
  claudeProfile?: string;
  model?: string;
}

/**
 * Phần cấu hình `runAgent` DÙNG CHUNG cho cả hai phía. Cố ý loại bỏ những trường mà duel tự
 * quyết cho từng phía (cwd/provider/model/callback) để caller không vô tình đặt lệch hai bên.
 */
export type DuelRunBase = Omit<
  RunOptions,
  | 'brief'
  | 'cwd'
  | 'mode'
  | 'provider'
  | 'providerProfile'
  | 'claudeProfile'
  | 'model'
  | 'onEvent'
  | 'onApproval'
  | 'onQuestion'
  | 'onSessionId'
  | 'onInputChannel'
  | 'abortSignal'
  | 'resumeSessionId'
>;

/** Kết quả của một phía sau cả hai pha. */
export interface DuelSideOutcome {
  id: DuelSideId;
  label: string;
  /** Worktree nơi phía này làm việc. */
  cwd: string;
  /** Branch của worktree, vd 'feat/PROJ-123-a'. */
  branch: string;
  /** Text kết quả cuối của pha 1 (null nếu agent không trả gì). */
  result: string | null;
  /** Lỗi pha 1 (nếu có) — phía kia vẫn chạy tiếp, duel không đổ theo. */
  error?: string;
  /** Số file đã đổi so với base. */
  changedFiles: string[];
  /** Diff so với base (đã cắt bớt nếu quá dài — xem `diffTruncated`). */
  diff: string;
  diffTruncated: boolean;
  /** session_id THẬT của SDK ở pha 1 — cần để lượt "Cho sửa" resume đúng hội thoại. */
  conversationId?: string;
  /**
   * Bài đã được commit lên nhánh của phía này chưa. Quan trọng: nút "Giữ bài" merge NHÁNH,
   * nên bài chỉ nằm ở working tree là merge ra số không.
   */
  committed: boolean;
  /** Vì sao không commit được (hook chặn, không có gì để commit…) — hiện thẳng cho người dùng. */
  commitError?: string;
  /** Báo cáo review do PHÍA KIA viết về diff của phía này (null nếu không chạy được). */
  review: string | null;
  /** Nhãn của bên đã review phía này. */
  reviewedBy?: string;
}

export interface DuelOptions {
  /** Repo gốc — hai worktree được tách ra từ đây, đặt cạnh nó. */
  repoCwd: string;
  /** Tên ticket/định danh trận đấu, dùng đặt tên worktree + branch. */
  ticket: string;
  /** Task brief (giống hệt nhau cho cả hai phía — đó mới là đấu công bằng). */
  brief: string;
  sides: [DuelSideSpec, DuelSideSpec];
  /** Mode cho PHA 1. Pha 2 luôn bị ép 'plan'. */
  mode: 'manual' | 'edit-auto' | 'auto';
  runBase: DuelRunBase;
  /** Sự kiện agent, kèm phía phát ra ('system' = thông báo của chính duel). */
  onEvent: (side: DuelSideId | 'system', event: AgentEvent) => void;
  onApproval?: (
    side: DuelSideId,
    toolName: string,
    input: Record<string, unknown>,
    meta?: Parameters<NonNullable<RunOptions['onApproval']>>[2],
  ) => Promise<boolean>;
  onQuestion?: (side: DuelSideId, questions: Question[]) => Promise<Record<string, string> | null>;
  onSessionId?: (side: DuelSideId, sessionId: string) => void;
  /** Trao kênh nói chen cho TỪNG phía (caller giữ để phục vụ /api/say theo phía). */
  onInputChannel?: (side: DuelSideId, send: (text: string) => void) => void;
  abortSignal?: AbortSignal;
  /** Bỏ qua pha review chéo (chỉ chạy song song rồi so kết quả). Mặc định false. */
  skipReview?: boolean;
  /**
   * AI làm TRỌNG TÀI ở pha 3: đọc hai báo cáo review rồi đề xuất giữ bên nào. Bỏ trống = không
   * chạy pha 3 (người dùng tự đọc hai báo cáo). Trọng tài chỉ nhận BÁO CÁO + thống kê, không
   * nhận lại toàn bộ diff — đủ để so, mà không đốt thêm một lần token cỡ pha 2.
   */
  arbiter?: DuelArbiterSpec;
}

/** Phán quyết của pha 3 — bên nào nên giữ, và vì sao. */
export interface DuelVerdict {
  /** Phía được đề xuất giữ; null = trọng tài không chọn được bên nào (cả hai chưa đạt). */
  winner: DuelSideId | null;
  /** Nguyên văn báo cáo trọng tài (đã bỏ dòng máy đọc CHỌN:). */
  text: string;
  /** Nhãn AI đã làm trọng tài — người đọc cần biết ai chấm để tự trừ hao thiên vị. */
  arbiterLabel: string;
}

/** Cấu hình AI làm trọng tài ở pha 3. */
export interface DuelArbiterSpec {
  label: string;
  provider?: ProviderId;
  providerProfile?: string;
  claudeProfile?: string;
  model?: string;
}

export interface DuelReport {
  ticket: string;
  /** Commit gốc mà cả hai phía tách ra từ đó — mốc để diff. */
  baseSha: string;
  /** Nhánh của repo gốc lúc trận bắt đầu — đích để merge nhánh thắng về. */
  baseBranch: string;
  sides: [DuelSideOutcome, DuelSideOutcome];
  /** Đề xuất nên giữ bên nào (vắng nếu bỏ qua pha 3 hoặc không chạy được). */
  verdict?: DuelVerdict;
}

/** Trần ký tự của diff nhồi vào brief review (~30k token). Dài hơn thì cắt + báo rõ. */
export const MAX_DIFF_CHARS = 120_000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/**
 * Số file đang thay đổi/chưa commit ở repo gốc. Worktree mới tách từ HEAD nên KHÔNG mang theo
 * những thay đổi này — hai đấu thủ sẽ làm trên nền cũ hơn cái người dùng đang nhìn thấy trong
 * editor. Đếm để cảnh báo trước khi trận chạy, thay vì để họ phát hiện lúc so kết quả.
 */
export function dirtyFileCount(cwd: string): number {
  try {
    const out = git(cwd, ['status', '--porcelain']);
    return out ? out.split('\n').filter((l) => l.trim()).length : 0;
  } catch {
    return 0;
  }
}

/** Tên ticket của worktree cho một phía: 'PROJ-123' + 'A' → 'PROJ-123-a'. */
export function duelWorktreeTicket(ticket: string, side: DuelSideId): string {
  return `${ticket}-${side.toLowerCase()}`;
}

/** Cắt diff quá dài từ ĐẦU giữ phần đầu (hàm/file đầu tiên thường là phần chính của thay đổi). */
export function truncateDiff(diff: string, maxChars = MAX_DIFF_CHARS): { text: string; truncated: boolean } {
  if (diff.length <= maxChars) return { text: diff, truncated: false };
  return {
    text: `${diff.slice(0, maxChars)}\n\n[... diff bị cắt bớt, còn ${diff.length - maxChars} ký tự nữa — đọc file trực tiếp nếu cần ...]`,
    truncated: true,
  };
}

/**
 * Thu diff của một worktree so với `baseSha`, GỒM CẢ file mới chưa commit.
 * `git add -A --intent-to-add` chỉ đánh dấu ý-định-thêm vào index (không stage nội dung) để file
 * untracked hiện ra trong `git diff` — an toàn vì đây là worktree tạm của duel, không phải repo gốc.
 */
export function collectDiff(cwd: string, baseSha: string): { diff: string; files: string[]; truncated: boolean } {
  try {
    git(cwd, ['add', '-A', '--intent-to-add']);
  } catch {
    // Repo rỗng/không có gì để đánh dấu — bỏ qua, diff bên dưới vẫn chạy.
  }
  const files = git(cwd, ['--no-pager', 'diff', '--name-only', baseSha])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const raw = git(cwd, ['--no-pager', 'diff', baseSha]);
  const { text, truncated } = truncateDiff(raw);
  return { diff: text, files, truncated };
}

/**
 * Commit bài của một phía lên chính nhánh của nó. BẮT BUỘC phải có: "Giữ bài" merge NHÁNH, nên
 * thay đổi còn nằm ở working tree là merge ra số không — mà agent thì thường xuyên làm xong rồi
 * để đó, không tự commit.
 *
 * Đây là worktree TẠM do bow tạo, trên nhánh làm việc `feat/<ticket>-<side>`, nên commit local ở
 * đây nằm đúng trong ngoại lệ git-local-cơ-bản đã chốt (xem `safeLocalGit.ts`). KHÔNG dùng
 * `--no-verify`: hook của repo vẫn phải chạy — hook chặn thì báo lỗi ra, đừng lách.
 */
export function commitSideWork(cwd: string, message: string): { ok: boolean; error?: string } {
  try {
    git(cwd, ['add', '-A']);
    // Không có gì để commit (agent chỉ đọc, hoặc đã tự commit rồi) → không phải lỗi.
    const staged = git(cwd, ['diff', '--cached', '--name-only']);
    if (!staged) return { ok: true };
    git(cwd, ['commit', '-m', message]);
    return { ok: true };
  } catch (err) {
    const raw = (err as Error & { stderr?: Buffer | string; stdout?: Buffer | string });
    const detail = String(raw.stderr ?? raw.stdout ?? raw.message ?? '').trim().split('\n').slice(-3).join(' ');
    return { ok: false, error: detail || (err as Error).message };
  }
}

/** Brief cho PHA 2: bên `reviewerLabel` soi diff mà `authorLabel` vừa viết. */
export function buildReviewBrief(params: {
  task: string;
  reviewerLabel: string;
  authorLabel: string;
  diff: string;
  files: string[];
  summary: string | null;
}): string {
  const { task, reviewerLabel, authorLabel, diff, files, summary } = params;
  return [
    `# Review chéo — bạn (${reviewerLabel}) soi bài của ${authorLabel}`,
    '',
    `Một AI khác (${authorLabel}) vừa làm CÙNG nhiệm vụ dưới đây trong worktree này. Việc của bạn là`,
    'ĐỌC và CHẤM phần thay đổi đó. Bạn đang ở mode read-only: KHÔNG sửa file, KHÔNG chạy lệnh ghi.',
    '',
    '## Nhiệm vụ gốc (cả hai bên nhận đúng đề này)',
    '',
    task,
    '',
    ...(summary ? ['## Bên kia tự tổng kết', '', summary, ''] : []),
    `## Các file đã đổi (${files.length})`,
    '',
    files.length ? files.map((f) => `- ${f}`).join('\n') : '(không có file nào đổi)',
    '',
    '## Diff cần soi',
    '',
    '```diff',
    diff || '(rỗng)',
    '```',
    '',
    '## Cách chấm',
    '',
    '1. Mở các file liên quan quanh diff để hiểu ngữ cảnh — ĐỪNG chấm chỉ dựa vào diff.',
    '2. Chỉ báo vấn đề bạn CHỨNG MINH được, kèm kịch bản lỗi cụ thể (input/trạng thái → hậu quả).',
    '   Không liệt kê ý kiến phong cách, không "nên cân nhắc", không bịa file/line không có thật.',
    '3. Nếu code đúng thì nói thẳng là đúng — báo cáo rỗng tốt hơn báo cáo nhiễu.',
    '',
    '## Khuôn kết quả (bám đúng khuôn này)',
    '',
    '```',
    'KẾT LUẬN: ĐẠT | CẦN SỬA',
    '',
    'PHÁT HIỆN:',
    '- [nặng|vừa|nhẹ] <file>:<dòng> — <vấn đề trong một câu>',
    '  Kịch bản: <input/trạng thái cụ thể> → <hậu quả>',
    '  Sửa: <cách sửa gọn nhất>',
    '',
    'BỎ SÓT: <yêu cầu nào trong đề chưa được làm, hoặc "không">',
    '```',
  ].join('\n');
}

/** Brief cho pha 3: trọng tài đọc hai báo cáo review rồi đề xuất giữ bên nào. */
export function buildVerdictBrief(params: {
  task: string;
  sides: { label: string; sideId: DuelSideId; files: string[]; error?: string; result: string | null; review: string | null }[];
}): string {
  const { task, sides } = params;
  const block = (s: (typeof sides)[number]) =>
    [
      `### Phía ${s.sideId} — ${s.label}`,
      '',
      `- File đã đổi: ${s.files.length}${s.files.length ? ` (${s.files.slice(0, 20).join(', ')}${s.files.length > 20 ? '…' : ''})` : ''}`,
      s.error ? `- ⚠️ Chạy LỖI: ${s.error}` : '',
      '',
      '**Bên kia chấm phía này:**',
      '',
      s.review ?? '(không có báo cáo review)',
      '',
      '**Phía này tự tổng kết:**',
      '',
      s.result ?? '(không có)',
      '',
    ]
      .filter((l) => l !== '')
      .join('\n');

  return [
    '# Trọng tài — chọn bài nào nên giữ',
    '',
    'Hai AI vừa làm CÙNG một nhiệm vụ, mỗi bên trong một nhánh riêng, rồi soi chéo bài của nhau.',
    'Việc của bạn là đọc hai báo cáo dưới đây và nói người dùng nên GIỮ NHÁNH NÀO.',
    'Bạn đang ở mode read-only. Được phép mở file/chạy lệnh đọc để kiểm chứng, nhưng KHÔNG sửa gì.',
    '',
    '## Nhiệm vụ gốc',
    '',
    task,
    '',
    '## Hai bài',
    '',
    ...sides.map(block),
    '## Cách chấm',
    '',
    '1. Ưu tiên ĐÚNG trước: bên nào có lỗi thật (theo phát hiện của reviewer) thì trừ nặng.',
    '2. Rồi tới ĐỦ: bên nào bỏ sót yêu cầu trong đề.',
    '3. Cuối mới tới gọn: ít thay đổi hơn mà làm đủ việc thì hơn.',
    '4. Đừng chọn bừa để có kết quả: nếu CẢ HAI đều sai/thiếu, nói thẳng là không bên nào đạt.',
    '5. Báo cáo review là ý kiến của một AI khác — được phép BÁC nếu bạn kiểm tra thấy nó sai.',
    '',
    '## Khuôn kết quả (dòng đầu bắt buộc đúng khuôn — máy đọc dòng này)',
    '',
    '```',
    'CHỌN: A | B | KHÔNG',
    '',
    'VÌ SAO: <2-4 câu, nêu điểm quyết định chứ không tóm tắt lại cả hai bài>',
    '',
    'TRƯỚC KHI MERGE: <việc còn phải làm với nhánh thắng, hoặc "không có">',
    '```',
  ].join('\n');
}

/**
 * Đọc dòng `CHỌN: …` ở đầu báo cáo trọng tài. Không khớp khuôn (model trả tự do) → null, và
 * UI hiển thị nguyên văn báo cáo để người dùng tự đọc — thà không có đề xuất còn hơn đề xuất bịa.
 */
export function parseVerdictWinner(text: string): DuelSideId | null {
  const m = text.match(/^\s*(?:\*\*)?CH[ỌO]N(?:\*\*)?\s*:\s*(?:\*\*)?\s*([AB])\b/im);
  return m ? (m[1].toUpperCase() as DuelSideId) : null;
}

/**
 * Brief cho lượt "Giữ nhánh này": merge nhánh thắng về nhánh gốc trong REPO GỐC.
 * Cố ý KHÔNG push: đẩy lên remote là việc người dùng tự quyết, và cổng duyệt vẫn hỏi nếu agent
 * thử push. Nhánh thua được giữ nguyên — dọn hay không là một thao tác riêng, có xác nhận.
 */
export function buildKeepBrief(params: {
  winnerLabel: string;
  winnerBranch: string;
  baseBranch: string;
  loserBranch: string;
  review: string | null;
}): string {
  return [
    `# Giữ bài của ${params.winnerLabel}: merge \`${params.winnerBranch}\` vào \`${params.baseBranch}\``,
    '',
    'Hai AI vừa làm cùng một nhiệm vụ trong hai nhánh; người dùng đã chọn giữ bài này. Việc của bạn:',
    '',
    `1. Kiểm tra đang đứng ở nhánh \`${params.baseBranch}\` trong repo gốc (không phải worktree).`,
    `2. Merge \`${params.winnerBranch}\` vào. Có xung đột thì GIẢI QUYẾT, đừng bỏ dở giữa chừng.`,
    '3. Chạy kiểm chứng của repo (typecheck/lint/test theo đúng lệnh repo này dùng).',
    '4. Sai thì sửa cho xanh, rồi commit.',
    '',
    '**KHÔNG push lên remote** và **KHÔNG xoá nhánh nào** — hai việc đó người dùng tự làm.',
    `Nhánh thua (\`${params.loserBranch}\`) để nguyên.`,
    '',
    ...(params.review
      ? ['## Reviewer đã nói gì về bài này (xử lý nốt nếu còn tồn đọng)', '', params.review, '']
      : []),
  ].join('\n');
}

/** Brief cho lượt "Cho sửa": đẩy báo cáo của reviewer về lại chính tác giả để sửa. */
export function buildFixBrief(params: { reviewerLabel: string; review: string }): string {
  return [
    `# Sửa theo review của ${params.reviewerLabel}`,
    '',
    `Một AI khác (${params.reviewerLabel}) vừa soi phần bạn vừa làm và báo cáo như dưới đây.`,
    'Hãy XỬ LÝ từng phát hiện: sửa nếu đúng, hoặc nói rõ vì sao KHÔNG sửa nếu bạn cho rằng',
    'reviewer nhầm (kèm bằng chứng trong code). Đừng sửa lấy lệ cho xong.',
    '',
    '---',
    '',
    params.review,
  ].join('\n');
}

/** Phát một dòng thông báo của chính duel (không phải của agent nào). */
function note(opts: DuelOptions, text: string): void {
  opts.onEvent('system', { type: 'text', text });
}

/**
 * Chạy một phía ở pha 1. Không ném — lỗi được gói vào outcome để phía kia vẫn về đích
 * (thua một bên còn hơn mất cả trận).
 */
async function runSide(
  opts: DuelOptions,
  spec: DuelSideSpec,
  cwd: string,
  branch: string,
): Promise<DuelSideOutcome> {
  const outcome: DuelSideOutcome = {
    id: spec.id,
    label: spec.label,
    cwd,
    branch,
    result: null,
    changedFiles: [],
    diff: '',
    diffTruncated: false,
    committed: false,
    review: null,
  };
  try {
    outcome.result = await runAgent({
      ...opts.runBase,
      brief: opts.brief,
      cwd,
      mode: opts.mode,
      provider: spec.provider,
      providerProfile: spec.providerProfile,
      claudeProfile: spec.claudeProfile,
      model: spec.model,
      abortSignal: opts.abortSignal,
      onEvent: (ev) => opts.onEvent(spec.id, ev),
      onApproval: opts.onApproval
        ? (toolName, input, meta) => opts.onApproval!(spec.id, toolName, input, meta)
        : undefined,
      onQuestion: opts.onQuestion ? (questions) => opts.onQuestion!(spec.id, questions) : undefined,
      onSessionId: (id) => {
        outcome.conversationId = id;
        opts.onSessionId?.(spec.id, id);
      },
      onInputChannel: opts.onInputChannel
        ? (send) => opts.onInputChannel!(spec.id, send)
        : undefined,
    });
  } catch (err) {
    outcome.error = (err as Error).message;
  }
  return outcome;
}

/** Chạy pha 2 cho một phía: `reviewer` soi diff của `author`. Trả null nếu không có gì để soi. */
async function reviewSide(
  opts: DuelOptions,
  reviewer: DuelSideSpec,
  author: DuelSideOutcome,
): Promise<string | null> {
  if (!author.changedFiles.length) return null;
  const brief = buildReviewBrief({
    task: opts.brief,
    reviewerLabel: reviewer.label,
    authorLabel: author.label,
    diff: author.diff,
    files: author.changedFiles,
    summary: author.result,
  });
  try {
    return await runAgent({
      ...opts.runBase,
      brief,
      // Đọc code THẬT của bên bị soi — nên cwd là worktree của tác giả, không phải của reviewer.
      cwd: author.cwd,
      mode: 'plan',
      provider: reviewer.provider,
      providerProfile: reviewer.providerProfile,
      claudeProfile: reviewer.claudeProfile,
      model: reviewer.model,
      abortSignal: opts.abortSignal,
      onEvent: (ev) => opts.onEvent(reviewer.id, ev),
      // Mode 'plan' đã chặn cứng tool ghi ⇒ không cần cổng duyệt; giữ onQuestion để
      // reviewer hỏi lại người dùng nếu đề mơ hồ.
      onQuestion: opts.onQuestion ? (questions) => opts.onQuestion!(reviewer.id, questions) : undefined,
    });
  } catch (err) {
    opts.onEvent('system', {
      type: 'text',
      text: `⚠️ ${reviewer.label} review ${author.label} thất bại: ${(err as Error).message}`,
    });
    return null;
  }
}

/** Chạy pha 3: trọng tài đọc hai báo cáo rồi đề xuất giữ bên nào. Trả undefined nếu không chạy được. */
async function runArbiter(
  opts: DuelOptions,
  arbiter: DuelArbiterSpec,
  outcomes: [DuelSideOutcome, DuelSideOutcome],
): Promise<DuelVerdict | undefined> {
  const brief = buildVerdictBrief({
    task: opts.brief,
    sides: outcomes.map((o) => ({
      label: o.label,
      sideId: o.id,
      files: o.changedFiles,
      error: o.error,
      result: o.result,
      review: o.review,
    })),
  });
  try {
    const text = await runAgent({
      ...opts.runBase,
      brief,
      // Chấm từ REPO GỐC, không đứng trong worktree của bên nào — đứng trong nhà một bên thì
      // mọi lệnh đọc mặc định soi bài bên đó.
      cwd: opts.repoCwd,
      mode: 'plan',
      provider: arbiter.provider,
      providerProfile: arbiter.providerProfile,
      claudeProfile: arbiter.claudeProfile,
      model: arbiter.model,
      abortSignal: opts.abortSignal,
      onEvent: (ev) => opts.onEvent('system', ev),
    });
    if (!text) return undefined;
    return { winner: parseVerdictWinner(text), text, arbiterLabel: arbiter.label };
  } catch (err) {
    opts.onEvent('system', { type: 'text', text: `⚠️ Trọng tài (${arbiter.label}) không chạy được: ${(err as Error).message}` });
    return undefined;
  }
}

/**
 * Chạy trọn một trận: tạo 2 worktree → 2 agent làm SONG SONG → thu diff → 2 lượt review chéo
 * (cũng song song) → trả báo cáo. Worktree được GIỮ LẠI để người dùng xem/merge nhánh thắng;
 * chỉ dọn khi tạo worktree thứ hai thất bại (không để lại rác nửa vời).
 */
export async function runDuel(opts: DuelOptions): Promise<DuelReport> {
  const [specA, specB] = opts.sides;
  const baseSha = git(opts.repoCwd, ['rev-parse', 'HEAD']);
  const baseBranch = git(opts.repoCwd, ['rev-parse', '--abbrev-ref', 'HEAD']);

  const wtA = createTicketWorktree({ repoCwd: opts.repoCwd, ticket: duelWorktreeTicket(opts.ticket, 'A') });
  let wtB: { path: string; branch: string };
  try {
    wtB = createTicketWorktree({ repoCwd: opts.repoCwd, ticket: duelWorktreeTicket(opts.ticket, 'B') });
  } catch (err) {
    // Dọn worktree A để lần bấm sau không vướng "worktree đã tồn tại".
    try {
      removeTicketWorktree(opts.repoCwd, duelWorktreeTicket(opts.ticket, 'A'), true);
    } catch {
      // Dọn không được thì thôi — lỗi gốc bên dưới mới là cái người dùng cần thấy.
    }
    throw err;
  }

  note(
    opts,
    `⚔️ Duel bắt đầu — ${specA.label} → \`${wtA.branch}\`, ${specB.label} → \`${wtB.branch}\` (base \`${baseSha.slice(0, 8)}\`).`,
  );
  const dirty = dirtyFileCount(opts.repoCwd);
  if (dirty > 0) {
    note(
      opts,
      `⚠️ Repo gốc đang có **${dirty} file chưa commit**. Hai worktree tách từ HEAD nên KHÔNG có ` +
        `những thay đổi đó — hai đấu thủ làm trên nền cũ hơn cái bạn đang thấy trong editor. ` +
        `Muốn họ làm trên đúng bản hiện tại thì dừng trận, commit (hoặc stash) rồi chạy lại.`,
    );
  }

  // PHA 1 — hai bên làm cùng lúc, mỗi bên một worktree.
  const outcomes = await Promise.all([
    runSide(opts, specA, wtA.path, wtA.branch),
    runSide(opts, specB, wtB.path, wtB.branch),
  ]);

  for (const outcome of outcomes) {
    try {
      const collected = collectDiff(outcome.cwd, baseSha);
      outcome.diff = collected.diff;
      outcome.changedFiles = collected.files;
      outcome.diffTruncated = collected.truncated;
    } catch (err) {
      note(opts, `⚠️ Không đọc được diff của ${outcome.label}: ${(err as Error).message}`);
    }
    if (outcome.changedFiles.length > 0) {
      const commit = commitSideWork(outcome.cwd, `duel(${outcome.id}): ${opts.ticket} — bài của ${outcome.label}`);
      outcome.committed = commit.ok;
      outcome.commitError = commit.error;
      if (!commit.ok) {
        note(
          opts,
          `⚠️ Không commit được bài của ${outcome.label} (${commit.error}). Bài vẫn nằm trong ` +
            `\`${outcome.cwd}\` nhưng nhánh rỗng — "Giữ bài" sẽ không merge được gì.`,
        );
      }
    }
  }

  const [outA, outB] = outcomes;
  note(
    opts,
    `📊 Pha 1 xong — ${outA.label}: ${outA.changedFiles.length} file${outA.error ? ' (LỖI)' : ''}, ` +
      `${outB.label}: ${outB.changedFiles.length} file${outB.error ? ' (LỖI)' : ''}.`,
  );

  // PHA 2 — đổi chéo: A soi B, B soi A. Chạy song song, read-only.
  if (!opts.skipReview) {
    note(opts, `🔍 Review chéo: ${specA.label} soi ${specB.label}, ${specB.label} soi ${specA.label}…`);
    const [reviewOfB, reviewOfA] = await Promise.all([
      reviewSide(opts, specA, outB),
      reviewSide(opts, specB, outA),
    ]);
    outB.review = reviewOfB;
    outB.reviewedBy = specA.label;
    outA.review = reviewOfA;
    outA.reviewedBy = specB.label;
  }

  // PHA 3 — trọng tài. Chỉ chạy khi có gì để so: ít nhất một bên có thay đổi.
  let verdict: DuelVerdict | undefined;
  if (opts.arbiter && (outA.changedFiles.length > 0 || outB.changedFiles.length > 0)) {
    note(opts, `⚖️ ${opts.arbiter.label} đang chấm hai bài để đề xuất nên giữ nhánh nào…`);
    verdict = await runArbiter(opts, opts.arbiter, [outA, outB]);
  }

  return { ticket: opts.ticket, baseSha, baseBranch, sides: [outA, outB], verdict };
}
