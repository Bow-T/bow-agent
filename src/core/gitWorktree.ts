/**
 * Tạo git worktree cho một ticket — dùng chung cho CLI (`bow worktree`) và Web (nút "Ticket mới").
 *
 * VÌ SAO: chạy nhiều ticket song song (nhiều cửa sổ/phiên agent) trên CÙNG một repo đích cần mỗi
 * phiên trỏ vào một working directory vật lý riêng, nếu không hai agent ghi đè file/git-index của
 * nhau. `git worktree` cho việc đó gần như miễn phí (chung .git, không nhân bản lịch sử) — rẻ hơn
 * clone riêng. Module này KHÔNG đụng cổng duyệt (canUseTool) vì `git worktree add` chỉ tạo thư mục
 * + branch mới, không sửa gì trong repo đích hiện tại của người dùng.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export interface CreateWorktreeOptions {
  /** Repo đích (đã là git repo) mà worktree mới được tách ra từ đó. */
  repoCwd: string;
  /** Tên ticket/nhánh, vd "PROJ-123". Dùng làm tên thư mục + branch. */
  ticket: string;
  /** Branch nền để tách worktree (mặc định: branch hiện tại của repoCwd). */
  baseBranch?: string;
}

export interface CreateWorktreeResult {
  /** Đường dẫn tuyệt đối worktree mới, đặt cạnh repoCwd: "<repo>-wt-<ticket-slug>". */
  path: string;
  /** Tên branch mới đã tạo, vd "feat/PROJ-123". */
  branch: string;
}

/** Tiền tố tên thư mục worktree — CỐ Ý khác "feat/" của branch, để tên thư mục KHÔNG bị
 *  đọc nhầm là tên nhánh (branch có thể đổi tên/prefix khác nhau, thư mục thì không theo). */
const WORKTREE_DIR_PREFIX = 'wt-';

/** "<repo>" + slug ticket → tên thư mục worktree, vd "bow-agent-wt-PROJ-123". */
function worktreeDirName(repoName: string, slug: string): string {
  return `${repoName}-${WORKTREE_DIR_PREFIX}${slug}`;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

/** "PROJ-123" / " proj 123 " → "PROJ-123" an toàn cho tên thư mục + branch. */
function slugifyTicket(ticket: string): string {
  const slug = ticket
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`Tên ticket không hợp lệ: "${ticket}"`);
  return slug;
}

/**
 * Tạo worktree mới cho một ticket, đặt cạnh repo gốc: "<repo>-<ticket>", branch "feat/<ticket>".
 * Ném lỗi nếu repoCwd không phải git repo, worktree/branch đã tồn tại, hoặc `git worktree add` lỗi.
 */
export function createTicketWorktree(opts: CreateWorktreeOptions): CreateWorktreeResult {
  const repoCwd = resolve(opts.repoCwd);
  if (!existsSync(repoCwd)) {
    throw new Error(`Thư mục repo không tồn tại: ${repoCwd}`);
  }
  try {
    git(repoCwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new Error(`Không phải git repo: ${repoCwd}`);
  }

  const slug = slugifyTicket(opts.ticket);
  const branch = `feat/${slug}`;
  const repoName = basename(repoCwd);
  const worktreePath = resolve(dirname(repoCwd), worktreeDirName(repoName, slug));

  if (existsSync(worktreePath)) {
    throw new Error(`Thư mục worktree đã tồn tại: ${worktreePath}`);
  }
  const existingBranches = git(repoCwd, ['branch', '--list', branch]);
  if (existingBranches) {
    throw new Error(`Branch đã tồn tại: ${branch} (xoá branch cũ hoặc chọn tên ticket khác)`);
  }

  const base = opts.baseBranch || git(repoCwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  git(repoCwd, ['worktree', 'add', '-b', branch, worktreePath, base]);

  return { path: worktreePath, branch };
}

export interface WorktreeEntry {
  path: string;
  branch?: string;
  head: string;
}

/**
 * Liệt kê worktree CÒN DÙNG ĐƯỢC của repo (dùng cho UI hiển thị danh sách ticket đang chạy
 * song song). Lọc bỏ entry `prunable` — git vẫn giữ metadata cho worktree mà thư mục đã bị
 * xoá bằng cách khác (rm -f trực tiếp, không qua `git worktree remove`); hiện những "bóng ma"
 * này ra sẽ khiến UI tưởng có worktree để gỡ trong khi thư mục không còn tồn tại.
 */
export function listWorktrees(repoCwd: string): WorktreeEntry[] {
  const out = git(resolve(repoCwd), ['worktree', 'list', '--porcelain']);
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry & { prunable: boolean }> = {};
  const flush = () => {
    if (current.path && !current.prunable) entries.push(current as WorktreeEntry);
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    }
  }
  flush();
  return entries;
}

/** Gỡ worktree của một ticket (và branch `feat/<ticket>` nếu `deleteBranch`). Dùng khi ticket xong việc. */
export function removeTicketWorktree(repoCwd: string, ticket: string, deleteBranch: boolean): void {
  const repo = resolve(repoCwd);
  const slug = slugifyTicket(ticket);
  const target = resolve(dirname(repo), worktreeDirName(basename(repo), slug));
  const entry = listWorktrees(repo).find((w) => resolve(w.path) === target);
  if (!entry) throw new Error(`Không tìm thấy worktree: ${target}`);

  git(repo, ['worktree', 'remove', target]);
  if (deleteBranch && entry.branch) {
    git(repo, ['branch', '-D', entry.branch]);
  }
}
