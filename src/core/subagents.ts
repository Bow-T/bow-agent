import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

/**
 * Model cho subagent — CỐ Ý rẻ hơn Opus của phiên chính (ý "complexity-aware dispatch"
 * chọn lọc từ ruflo, hiện thực native bằng field model của Agent SDK — KHÔNG bê framework).
 * Việc read-only (rà soát/kiểm chứng/quét call-site) không cần model đỉnh; hạ xuống đây
 * cắt token/chi phí mỗi lần bật --subagents mà không đổi hành vi ghi (mọi thay đổi thật
 * vẫn do agent chính Opus làm & qua onApproval).
 *  - SUBAGENT_MODEL: reviewer/verifier — cần suy luận, dùng Sonnet 5.
 *  - SCOUT_MODEL: impact-scout — thuần grep, dùng Haiku 4.5 (rẻ/nhanh nhất).
 * Ghi đè được qua env để A/B (vd đặt 'inherit' để so với Opus). Rỗng → mặc định dưới.
 */
const SUBAGENT_MODEL = process.env.BOW_SUBAGENT_MODEL || 'claude-sonnet-5';
const SCOUT_MODEL = process.env.BOW_SCOUT_MODEL || 'claude-haiku-4-5-20251001';

/**
 * Subagent CHUẨN của bow-agent — bộ "vai trò chuyên biệt" (mượn ý role-specialization
 * của CrewAI, hiện thực bằng Options.agents của Claude Agent SDK, KHÔNG bê framework).
 *
 * Agent chính giao việc cho các subagent này qua tool `Agent`. Chúng CHỈ đọc / chạy
 * lệnh kiểm chứng an toàn — không tự sửa file / commit / apply migration. Nhờ vậy có
 * thể để trong allowedTools mà không phá cổng duyệt: mọi thay đổi thật vẫn do agent
 * chính thực hiện và vẫn qua onApproval.
 *
 * Mặc định TẮT (opt-in qua cờ --subagents / useSubagents) — bật thì runner mới nhồi
 * vào options.agents. Tắt thì runner giữ nguyên single-agent, hành vi không đổi.
 *
 * Ba nguồn subagent, gộp theo thứ tự (profile GHI ĐÈ chuẩn nếu trùng tên):
 *  1. STANDARD (file này) — vai trò chung, áp cho mọi repo.
 *  2. profile.subagents — vai trò riêng từng dự án (hiện các profile .md trả rỗng).
 */

/**
 * Chặn CỨNG mọi thao tác thay đổi trạng thái cho subagent kiểm chứng/rà soát.
 * `permissionMode: 'plan'` đã chặn Edit/Write, nhưng KHÔNG chặn Bash — nên phải deny
 * tường minh các lệnh phá hoại/ghi ở tầng tool. (SDK: disallowedTools hỗ trợ pattern,
 * không hỗ trợ whitelist — nên ta deny các họ lệnh nguy hiểm.)
 */
const READONLY_DENY = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash(git commit:*)',
  'Bash(git push:*)',
  'Bash(git reset:*)',
  'Bash(git checkout:*)',
  'Bash(rm:*)',
  'Bash(mv:*)',
];

/** Reviewer — phản biện kế hoạch/diff, quét blast radius. Read-only. */
const reviewer: AgentDefinition = {
  description:
    'Phản biện một kế hoạch hoặc một diff trước khi trình người dùng duyệt: tìm lỗ hổng, ' +
    'call-site bị bỏ sót, rủi ro cross-cutting, giả định sai. Dùng ở mode plan để soi lại ' +
    'kế hoạch, hoặc trước commit để soi diff. Chỉ đọc — không sửa file.',
  tools: ['Read', 'Grep', 'Glob', 'Bash'],
  disallowedTools: READONLY_DENY,
  // Phản biện cần suy luận sâu (bắt call-site sót, giả định sai) → Sonnet 5 (đủ mạnh,
  // rẻ hơn Opus phiên chính ~5×). Đây là "complexity-aware dispatch": việc rà soát
  // read-only không cần model đỉnh. impact-scout (chỉ grep) hạ tiếp xuống Haiku dưới.
  model: SUBAGENT_MODEL,
  effort: 'high',
  maxTurns: 12,
  permissionMode: 'plan', // an toàn: subagent này không được thực thi thay đổi
  prompt: `Bạn là reviewer phản biện của bow-agent. Nhiệm vụ: tìm ĐIỂM YẾU trong kế hoạch/diff được giao, KHÔNG khen.

Soi theo thứ tự:
1. Call-site bỏ sót: nếu đổi signature/enum/status/schema/cột DB dùng nhiều nơi, grep MỌI nơi dùng — kể cả getter/switch/allow-list liệt-kê-tay mà grep tên mới không ra.
2. Rủi ro runtime tĩnh-không-thấy: CHECK/FK/trigger DB, validator edge function, luồng end-to-end.
3. Giả định sai / thiếu case / thiếu kiểm chứng.
4. Over-engineering: abstraction đầu cơ, code thừa có thể cắt.

Trả về danh sách finding ngắn gọn, mỗi cái 1 dòng: mức độ (blocker/nên-sửa/cân-nhắc) + vấn đề + đề xuất. Nếu không có gì: nói rõ "kế hoạch/diff ổn, không thấy lỗ hổng". Chỉ đọc, tuyệt đối không sửa file.`,
};

/** Verifier — trace runtime end-to-end sau khi execute. Read + chạy test. */
const verifier: AgentDefinition = {
  description:
    'Kiểm chứng một thay đổi đã thực hiện bằng cách chạy test/analyze và trace luồng runtime ' +
    'end-to-end (không chỉ "compile pass"). Dùng sau khi execute xong, trước khi tuyên bố hoàn ' +
    'thành. Được chạy lệnh kiểm chứng (test/analyze/git diff) nhưng không sửa file / commit.',
  tools: ['Read', 'Grep', 'Glob', 'Bash'],
  disallowedTools: READONLY_DENY,
  // Verifier chạy test/analyze + trace runtime — cần đọc-hiểu chuỗi luồng nhưng không
  // cần Opus. Sonnet 5 đủ, rẻ hơn nhiều so với để inherit Opus của phiên chính.
  model: SUBAGENT_MODEL,
  effort: 'high',
  maxTurns: 15,
  // 'plan' KHÔNG chặn Bash (test/analyze vẫn chạy được) nhưng chặn Edit/Write —
  // verifier chỉ kiểm chứng, không được thực thi thay đổi.
  permissionMode: 'plan',
  prompt: `Bạn là verifier của bow-agent. Nhiệm vụ: XÁC MINH thay đổi vừa làm có thật sự đúng ở tầng runtime, không chỉ tĩnh xanh.

Làm:
1. Chạy kiểm chứng tĩnh phù hợp repo: type-check / analyze / test (vd 'fvm flutter analyze', 'fvm flutter test', 'npm test', 'tsc --noEmit'). CHỈ chạy lệnh đọc/kiểm chứng — KHÔNG commit, push, apply migration, hay sửa file.
2. Với thay đổi xuyên hệ thống (DB schema, enum/vocabulary dùng chung, đổi key-format, hướng FK): trace 'insert → validate → read' trên mọi surface (mobile, admin, edge, DB). Soi CHECK/FK/trigger/function tham chiếu giá trị vừa đổi.
3. Grep allow-list/validator hardcode trong edge functions.

Trả về: (a) đã chạy gì, kết quả; (b) path runtime đã trace; (c) phán quyết trung thực — "tĩnh PASS + đã verify path runtime sạch" HAY liệt kê vấn đề còn lại. Tuyệt đối KHÔNG nói "không có lỗi" nếu chưa soi runtime. Không sửa gì — chỉ báo cáo cho agent chính.`,
};

/** Impact-scout — grep mọi call-site khi đổi contract/enum/schema. Read-only, nhanh. */
const impactScout: AgentDefinition = {
  description:
    'Quét blast radius của một thay đổi contract/cross-cutting: liệt kê MỌI call-site, surface, ' +
    'và danh sách liệt-kê-tay (switch/allow-list/getter) mà grep tên mới không tìm ra. Dùng khi ' +
    'đổi signature/enum/status/schema/cột DB dùng nhiều nơi. Chỉ đọc, trả về checklist site.',
  tools: ['Read', 'Grep', 'Glob'],
  disallowedTools: READONLY_DENY,
  // Impact-scout thuần grep/liệt-kê call-site — việc máy móc nhất trong bộ. Haiku 4.5
  // đủ nhanh & chính xác cho quét blast radius, rẻ nhất → dùng cho vòng lặp grep dày.
  model: SCOUT_MODEL,
  effort: 'medium',
  maxTurns: 10,
  permissionMode: 'plan',
  prompt: `Bạn là impact-scout của bow-agent. Nhiệm vụ: lập CHECKLIST đầy đủ các nơi bị ảnh hưởng bởi một thay đổi cross-cutting, để agent chính không sót site nào.

Kỹ thuật:
1. Grep 1 PEER đã wired sẵn (vd một enum value/status/cột đã dùng khắp nơi) — mọi hit của peer đó CHÍNH LÀ checklist các surface cần đụng.
2. Tìm cả nơi grep tên-mới KHÔNG ra: switch không default, Record<Status,...>, allow-list liệt-kê-thành-viên, getter suy diễn (vd isAnyFieldRejected), RPC/trigger IN-list hardcode.
3. Phủ mọi tầng: mobile (Flutter), admin (Next.js), edge functions, DB (migration/CHECK/trigger/function), l10n.

Trả về checklist mỗi dòng: <file:vùng> — <cần đổi gì>. Đánh dấu site nào grep-tên-mới KHÔNG bắt được (dễ sót nhất). Chỉ đọc, không sửa.`,
};

/** Bộ subagent chuẩn của bow-agent (áp cho mọi repo khi bật --subagents). */
export const STANDARD_SUBAGENTS: Record<string, AgentDefinition> = {
  reviewer,
  verifier,
  'impact-scout': impactScout,
};

/**
 * Gộp subagent chuẩn + subagent riêng của profile. Profile GHI ĐÈ chuẩn nếu trùng tên
 * (để một dự án có thể tinh chỉnh vai trò chung cho khuôn của mình).
 */
export function buildSubagents(
  profileSubagents?: Record<string, AgentDefinition>,
): Record<string, AgentDefinition> {
  return { ...STANDARD_SUBAGENTS, ...(profileSubagents ?? {}) };
}
