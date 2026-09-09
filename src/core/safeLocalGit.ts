/**
 * Git LOCAL "cơ bản" — phân loại lệnh git chỉ đổi trạng thái TRONG repo và hoàn tác được
 * (stage / commit / tạo nhánh mới) để cổng duyệt tự cho chạy, khỏi bắt người dùng bấm duyệt
 * từng lần.
 *
 * PHẠM VI NỚI (cố ý HẸP):
 *   - `git add <paths>`         — chỉ stage, không mất dữ liệu.
 *   - `git commit -m/-F …`      — commit LOCAL; remote không đổi, `git reset` lùi lại được.
 *   - `git checkout -b <new>` / `git switch -c <new>` — TẠO nhánh mới.
 *
 * PHANH:
 *   - Nhánh CHÍNH (main/master/develop/staging/release…) bất khả xâm phạm: đang đứng trên
 *     nhánh chính thì add/commit vẫn phải hỏi, và không tự tạo nhánh mới trùng tên nhánh chính.
 *   - `checkout`/`switch` sang nhánh CÓ SẴN (không -b/-c) luôn hỏi — đổi nhánh giữa chừng
 *     đè lên việc đang làm dở.
 *   - `--amend` / `--no-verify` (`-n`) viết lại lịch sử / bỏ qua hook → hỏi.
 *   - Interactive (`-p`, `-i`, `commit` không có message) treo phiên → hỏi.
 *   - push / reset --hard / rebase / restore / clean đã nằm ở RISKY_COMMANDS của runner,
 *     không bao giờ tới đây.
 *
 * FAIL-SAFE: chỉ trả 'auto' khi CHẮC CHẮN; mọi nghi ngờ (không suy được nhánh hiện tại,
 * ký tự shell lạ, cờ không nhận diện được) → 'ask'.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type GitDecision = 'auto' | 'ask';

/** Nhánh "chính" — không tự động commit lên, cũng không tự tạo nhánh mới trùng tên. */
export const PROTECTED_BRANCH =
  /^(main|master|develop|dev|staging|stage|prod|production|release|hotfix)(?:[/-].*)?$/i;

/** Ký tự khiến ta không suy chắc được lệnh sẽ chạy (nối lệnh, biến, command-sub, redirect). */
const UNSAFE_SHELL = /[;&|`\n<>()$]|\$\(/;

/** Cờ khiến lệnh mất tính "cơ bản": viết lại lịch sử, bỏ hook, hoặc mở giao diện tương tác. */
const UNSAFE_FLAG = /^(--amend|--no-verify|--interactive|--patch|--edit|-p|-e|-i)$/;

/** Tách token theo khoảng trắng, giữ nguyên cụm trong nháy (message commit). */
function tokens(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (quote) return null; // nháy hở → không suy được
  if (cur) out.push(cur);
  return out;
}

/** Cờ ngắn gộp (`-am`) có chứa chữ cái `c` không? Dùng để bắt `-n` (no-verify) trong cụm. */
const shortFlagHas = (tok: string, letter: string): boolean =>
  /^-[a-zA-Z]+$/.test(tok) && !tok.startsWith('--') && tok.slice(1).includes(letter);

/**
 * Nhánh git hiện tại của `cwd` (đi ngược lên tìm `.git`, hỗ trợ worktree nơi `.git` là FILE).
 * Trả null nếu không phải repo, detached HEAD, hoặc đọc lỗi → caller phải 'ask'.
 */
export function currentGitBranch(cwd: string): string | null {
  try {
    let dir = resolve(cwd);
    for (let i = 0; i < 40; i++) {
      const dotGit = join(dir, '.git');
      let gitDir: string | null = null;
      try {
        const st = statSync(dotGit);
        if (st.isDirectory()) gitDir = dotGit;
        else if (st.isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
          if (m) gitDir = resolve(dir, m[1].trim());
        }
      } catch { /* không có .git ở tầng này — lên tiếp */ }
      if (gitDir) {
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1] : null; // detached HEAD → null
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 'auto' nếu lệnh là git local cơ bản được nới (xem đầu file); 'ask' cho mọi thứ khác.
 * Hàm THUẦN — `branch` là nhánh hiện tại (null = không suy được → luôn 'ask' với add/commit).
 */
export function safeLocalGitDecision(cmd: string, branch: string | null): GitDecision {
  const c = cmd.trim();
  if (!c || c.length > 2000) return 'ask';
  if (UNSAFE_SHELL.test(c)) return 'ask';
  const t = tokens(c);
  if (!t || t[0] !== 'git') return 'ask';

  const sub = t[1];
  const args = t.slice(2);
  const flags = args.filter((a) => a.startsWith('-'));
  const rest = args.filter((a) => !a.startsWith('-'));
  if (flags.some((f) => UNSAFE_FLAG.test(f))) return 'ask';

  // Tạo nhánh MỚI: `git checkout -b <name> [start-point]` / `git switch -c <name>`.
  if ((sub === 'checkout' && flags.includes('-b')) || (sub === 'switch' && flags.includes('-c'))) {
    if (rest.length < 1 || rest.length > 2) return 'ask';
    return PROTECTED_BRANCH.test(rest[0]) ? 'ask' : 'auto';
  }
  // checkout/switch sang nhánh CÓ SẴN: luôn hỏi (đè lên việc đang làm dở).
  if (sub === 'checkout' || sub === 'switch') return 'ask';

  // Từ đây trở xuống chỉ nới khi đang đứng trên nhánh làm việc (không phải nhánh chính).
  if (!branch || PROTECTED_BRANCH.test(branch)) return 'ask';

  if (sub === 'add') {
    return rest.length > 0 || flags.includes('-A') || flags.includes('--all') ? 'auto' : 'ask';
  }
  if (sub === 'commit') {
    if (flags.some((f) => shortFlagHas(f, 'n'))) return 'ask'; // -n / -an = --no-verify
    // Bắt buộc có message inline: `git commit` trần sẽ mở editor và treo phiên.
    const hasMessage = flags.some((f) => f === '-m' || f === '-F' || /^--(message|file)=/.test(f))
      || flags.some((f) => shortFlagHas(f, 'm'));
    return hasMessage ? 'auto' : 'ask';
  }
  return 'ask';
}
