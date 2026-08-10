/**
 * Autopilot — lưới an toàn "khôi phục được" (Pha 1 của chế độ tự chạy A–Z).
 *
 * VÌ SAO: chế độ autopilot (Pha 2) sẽ NỚI cổng duyệt — tự làm phần lớn thao tác mà không hỏi.
 * Điều đó chỉ CHẤP NHẬN được nếu có lưới hoàn tác: trước khi chạy, chụp lại mốc git để nếu agent
 * làm sai ta khôi phục về sạch; và ghi journal append-only mọi thao tác ghi/bash để truy vết.
 * Module này KHÔNG đụng cổng duyệt — thuần cung cấp checkpoint + journal cho Pha 2 dùng.
 *
 * Thiết kế git (KHÔNG phá trạng thái làm việc):
 *  - baseSHA     = HEAD hiện tại → `git reset --hard baseSHA` huỷ MỌI commit autopilot tạo ra và
 *    trả file tracked về đúng mốc.
 *  - snapshotSHA = commit chụp TOÀN BỘ worktree lúc bắt đầu (tracked đã sửa + UNTRACKED chưa add),
 *    tạo qua GIT_INDEX_FILE tạm nên không đụng index/worktree thật; pin qua ref
 *    `refs/bow/autopilot/<id>` để git không GC. Khôi phục thay đổi/ file chưa commit:
 *    `git checkout snapshotSHA -- .`. (Dùng cách này thay `git stash create` vì stash create BỎ QUA
 *    file untracked — đã phát hiện khi verify runtime.)
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Thư mục journal: mặc định `conversations/` của bow-agent (cạnh access.json / session log),
 *  KHÔNG nằm trong repo đích. Cho override qua env để test không đụng dữ liệu thật. */
function journalDir(): string {
  return process.env.BOW_JOURNAL_DIR || join(__dirname, '..', '..', 'conversations');
}

export interface Checkpoint {
  /** ID phiên autopilot (thường trùng session id). */
  id: string;
  /** Repo đích agent làm việc. */
  cwd: string;
  /** cwd có phải git repo không. false ⇒ KHÔNG có lưới hoàn tác (caller phải cảnh báo). */
  git: boolean;
  /** Branch lúc bắt đầu (nếu là git). */
  branch?: string;
  /** HEAD lúc bắt đầu — mốc reset để hoàn tác commit autopilot. */
  baseSHA?: string;
  /** Commit chụp toàn bộ worktree lúc bắt đầu (tracked + untracked), nếu chụp được. */
  snapshotSHA?: string;
  /** Thời điểm tạo (ISO). */
  createdAt: string;
}

export type JournalEntry =
  | { kind: 'checkpoint'; checkpoint: Checkpoint }
  | { kind: 'tool'; tool: string; target?: string; command?: string }
  | { kind: 'note'; message: string };

/** Chạy git đồng bộ trong repo đích. Ném nếu lỗi (caller quyết bắt hay không). */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

/** git nhưng nuốt lỗi → null. Dùng cho probe không sống-còn (repo rỗng, không phải git…). */
function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/**
 * Chụp TOÀN BỘ worktree (tracked đã sửa + UNTRACKED) thành 1 commit MÀ KHÔNG đụng index/worktree
 * thật: dùng GIT_INDEX_FILE tạm rồi `git add -A` → `write-tree` → `commit-tree`. Tôn trọng
 * .gitignore (không nuốt node_modules). Trả sha commit, hoặc undefined nếu lỗi (vd chưa cấu hình
 * git identity → commit-tree fail) — best-effort, reset --hard baseSHA vẫn là lưới chính.
 */
function snapshotWorktree(cwd: string, baseSHA: string | undefined, id: string): string | undefined {
  const idxDir = mkdtempSync(join(tmpdir(), 'bow-idx-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(idxDir, 'index') };
  try {
    execFileSync('git', ['add', '-A'], { cwd, env, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
    const tree = execFileSync('git', ['write-tree'], { cwd, env, encoding: 'utf8' }).trim();
    const args = baseSHA
      ? ['commit-tree', tree, '-p', baseSHA, '-m', `bow autopilot checkpoint ${id}`]
      : ['commit-tree', tree, '-m', `bow autopilot checkpoint ${id}`];
    return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(idxDir, { recursive: true, force: true });
  }
}

/** Chỉ giữ ký tự an toàn cho tên file/ref journal. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_') || 'unknown';
}

/** Đường dẫn file journal của một phiên. */
export function journalPath(id: string): string {
  return join(journalDir(), `autopilot-${sanitizeId(id)}.jsonl`);
}

/** Ghi 1 dòng JSONL vào journal. Append-only — không bao giờ ghi đè dòng cũ. */
export function appendJournal(id: string, entry: JournalEntry): void {
  const dir = journalDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  appendFileSync(journalPath(id), line, 'utf8');
}

/**
 * Tạo checkpoint hoàn tác cho phiên autopilot trên repo `cwd`. KHÔNG ném:
 * repo không-git / git lỗi → trả `git: false` (caller Pha 2 PHẢI cảnh báo và cân nhắc không nới cổng).
 */
export function createCheckpoint(cwd: string, id: string): Checkpoint {
  const createdAt = new Date().toISOString();
  if (tryGit(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    const cp: Checkpoint = { id, cwd, git: false, createdAt };
    appendJournal(id, { kind: 'checkpoint', checkpoint: cp });
    return cp;
  }
  const branch = tryGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? undefined;
  const baseSHA = tryGit(cwd, ['rev-parse', 'HEAD']) ?? undefined;
  const snapshotSHA = snapshotWorktree(cwd, baseSHA, id);
  if (snapshotSHA) tryGit(cwd, ['update-ref', `refs/bow/autopilot/${sanitizeId(id)}`, snapshotSHA]);
  const cp: Checkpoint = { id, cwd, git: true, branch, baseSHA, snapshotSHA, createdAt };
  appendJournal(id, { kind: 'checkpoint', checkpoint: cp });
  return cp;
}

/** Ghi 1 thao tác GHI/BASH vào journal (Pha 2 gọi từ runner). */
export function recordAction(
  id: string,
  tool: string,
  detail?: { target?: string; command?: string },
): void {
  appendJournal(id, { kind: 'tool', tool, target: detail?.target, command: detail?.command });
}

/** Hướng dẫn khôi phục — in cho người dùng nếu autopilot làm sai. */
export function restoreInstructions(cp: Checkpoint): string {
  if (!cp.git) {
    return `⚠️ ${cp.cwd} không phải git repo — KHÔNG có lưới hoàn tác tự động. Không nên chạy autopilot ở đây.`;
  }
  const lines = [`# Khôi phục trạng thái trước autopilot (phiên ${cp.id})`, `cd ${cp.cwd}`];
  if (cp.baseSHA) lines.push(`git reset --hard ${cp.baseSHA}   # bỏ mọi commit autopilot tạo`);
  if (cp.snapshotSHA) {
    lines.push(`git checkout ${cp.snapshotSHA} -- .   # phục hồi thay đổi/ file chưa commit lúc bắt đầu (kể cả untracked)`);
  }
  lines.push(`# Journal: ${journalPath(cp.id)}`);
  return lines.join('\n');
}
