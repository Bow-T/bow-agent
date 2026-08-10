/**
 * Autopilot — phân loại lệnh Bash "rủi ro NHƯNG git khôi phục được nếu ghi trong repo".
 *
 * VÌ SAO: mode autopilot muốn KHÔNG dừng hỏi cho các thao tác ghi-file thuần trong repo (mv, cp,
 * ghi-đè `>`, tee) — vì git checkpoint (xem checkpoint.ts) hoàn tác được. (Sửa NỘI DUNG file thì
 * agent dùng tool Edit/Write — đã auto in-repo; KHÔNG nới `sed -i` vì script trong nháy làm việc
 * suy path mong manh, dễ thành lỗ hổng.)
 * NHƯNG tuyệt đối GIỮ hỏi cho nhóm THOÁT lưới git: xoá (rm…), git (push/reset/…), đặc quyền
 * (chmod/chown/sudo), ghi thiết bị (dd/mkfs), symlink, tải-chạy-mạng, script inline, và MỌI thứ
 * ghi RA NGOÀI repo. Đây là hàm THUẦN (không I/O) để test kỹ; runner truyền `isInRepo` (đã realpath,
 * chống symlink-escape) vào để tự kiểm path.
 *
 * NGUYÊN TẮC FAIL-SAFE: chỉ trả 'auto' khi CHẮC CHẮN an toàn (đúng nhóm nới + mọi path đích nằm
 * trong repo + không có ký tự khiến ta không suy được path thật). Mọi nghi ngờ → 'ask'.
 */
export type BashDecision = 'auto' | 'ask';

/** Ký tự khiến ta KHÔNG suy chắc được path thật (shell tự bung) → luôn 'ask' cho an toàn:
 *  ~ (home), $ (biến/lệnh), * ? [ (glob), backtick / $( ) (command-sub), nháy (path có khoảng trắng). */
const UNSAFE_TOKEN = /[~$*?[\]`'"]|\$\(/;

/** Toán tử nối lệnh — có mặt là KHÔNG nới (phải xét từng phần / hỏi). */
const CHAINING = /[;&|`\n]|\$\(|>\s*&|<\(/;

/** Lãnh đạo lệnh THOÁT lưới git → luôn 'ask' dù có lọt regex nới. Neo đầu-token lệnh. */
const HARD_ASK_LEADER =
  /(?:^|[\s;&|(])(rm|rmdir|unlink|find|truncate|shred|srm|wipe|ln|chmod|chown|chgrp|chflags|sudo|doas|su|mkfs|dd|shutdown|reboot|halt|poweroff|kill|killall|git|gh|npm|yarn|pnpm|bun|node|deno|python3?|ruby|php|sh|bash|zsh|fish|curl|wget|fetch|nc|ncat|ssh|scp|sftp|rsync|docker|podman|kubectl|helm|terraform|systemctl|launchctl|brew|apt|apt-get|yum|dnf|pacman|pip3?|gem|cargo|go|make)(?=$|[\s])/;

/** Nhóm NỚI: mv / cp / tee. (git bị HARD_ASK ở trên chặn trước; sửa nội dung file → dùng Edit.) */
const MV_CP = /^(mv|cp)(?=$|\s)/;
const TEE = /^tee(?=$|\s)/;

/** Tách token theo khoảng trắng (đã loại trường hợp có nháy/khoảng-trắng-trong-path qua UNSAFE_TOKEN). */
function tokens(cmd: string): string[] {
  return cmd.split(/\s+/).filter(Boolean);
}

/**
 * Trích các path ĐÍCH mà lệnh GHI vào (để kiểm in-repo). Trả null nếu KHÔNG suy chắc được
 * (→ caller nên 'ask'). Chỉ xử lý nhóm nới.
 */
function writeTargets(cmd: string): string[] | null {
  // Redirect ghi/ghi-nối: mọi `> path` và `>> path` (bỏ qua 2>/&> dạng số/hợp nhất đã bị chaining loại).
  const redirects = [...cmd.matchAll(/>>?\s*([^\s;&|]+)/g)].map((m) => m[1]);

  const t = tokens(cmd.replace(/>>?\s*[^\s;&|]+/g, ' ')); // bỏ phần redirect để phân tích phần lệnh
  const lead = t[0] ?? '';
  const rest = t.slice(1).filter((a) => !a.startsWith('-')); // bỏ cờ

  if (MV_CP.test(lead)) {
    // mv/cp [flags] src... dest — yêu cầu MỌI path (cả nguồn lẫn đích) nằm trong repo cho chắc.
    if (rest.length < 2) return null;
    return [...rest, ...redirects];
  }
  if (TEE.test(lead)) {
    // tee [-a] file... — ghi vào các file arg.
    if (rest.length < 1 && redirects.length === 0) return null;
    return [...rest, ...redirects];
  }
  // Lệnh KHÔNG thuộc nhóm nới nhưng có redirect thuần (vd `echo x > file`): chấp nhận nếu chỉ có
  // redirect làm target ghi. Nếu không có redirect → không phải nhóm nới → null.
  if (redirects.length > 0) return redirects;
  return null;
}

/**
 * Quyết định autopilot cho 1 lệnh Bash ĐÃ bị runner coi là "risky".
 * 'auto' CHỈ khi: không nối lệnh, không lãnh đạo-lệnh thoát-lưới, không ký tự bung-shell, và
 * MỌI path đích ghi vào đều in-repo. Ngược lại 'ask'.
 */
export function autopilotBashDecision(cmd: string, isInRepo: (p: string) => boolean): BashDecision {
  const c = cmd.trim();
  if (!c) return 'ask';
  if (CHAINING.test(c)) return 'ask';
  if (UNSAFE_TOKEN.test(c)) return 'ask';
  if (HARD_ASK_LEADER.test(c)) return 'ask';
  const targets = writeTargets(c);
  if (!targets || targets.length === 0) return 'ask';
  return targets.every((p) => isInRepo(p)) ? 'auto' : 'ask';
}
