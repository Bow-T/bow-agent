import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploySkillsFrom } from './agentSkills.js';

/**
 * Skill EXTERNAL: bộ skill theo stack (Flutter+Supabase, React Native+Supabase, …) do team
 * tự nuôi trong repo GitHub RIÊNG, bow-agent tải về khi người dùng chọn stack rồi TRẢI vào
 * `<cwd>/.claude/skills/` — y như skill nội bộ, nhưng nguồn ở ngoài. Xem DESIGN §7.3.
 *
 * AN TOÀN (skill = code chạy trong agent nên phải siết):
 * - ALLOWLIST: chỉ tải repo có trong `skills/registry.json` (admin duyệt). Không nhận URL tùy ý.
 * - GHIM TAG/COMMIT: luôn checkout theo `ref` đã ghi trong registry — repo đổi nội dung sau khi
 *   duyệt KHÔNG tự động chạy. Không bao giờ lấy nhánh mặc định trôi nổi.
 * - CACHE bất biến theo `<id>@<ref>`: cùng ref → dùng lại cache, khỏi clone lại; đổi ref = cache
 *   mới, không ghi đè cái cũ.
 * - STAMP `.bow-external`: phân biệt với skill nội bộ (`.bow-bundled`) và skill người dùng
 *   (không STAMP) khi trải — không nguồn nào đá nguồn nào.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** STAMP riêng cho skill external — tách hẳn khỏi `.bow-bundled` của skill nội bộ. */
const EXTERNAL_STAMP = '.bow-external';

/** Đường dẫn `skills/registry.json` ở root repo bow-agent (dù chạy từ src/ hay dist/). */
function registryPath(): string {
  return resolve(__dirname, '../../skills/registry.json');
}

/** Thư mục cache các bản clone skill external, dùng chung mọi repo đích. */
function cacheRoot(): string {
  return join(homedir(), '.bow', 'skills-cache');
}

/** Một stack trong registry (đã admin duyệt). */
export interface RegistryStack {
  /** Định danh stack, kebab-case, duy nhất (vd `react-native-supabase`). */
  id: string;
  /** Nhãn hiển thị trong UI chọn stack (vd `React Native + Supabase`). */
  label: string;
  /** Repo GitHub chứa skill (dạng `github.com/org/repo` hoặc URL đầy đủ). */
  repo: string;
  /** Tag/commit đã review để ghim (vd `v0.1.0`). BẮT BUỘC — không cho lấy nhánh trôi. */
  ref: string;
  /** Stack mặc định gợi ý (chỉ để UI đánh dấu). */
  default?: boolean;
}

interface Registry {
  version: number;
  stacks: RegistryStack[];
}

/**
 * Đọc registry (allowlist stack admin duyệt). Trả [] nếu thiếu/hỏng — không throw, vì thiếu
 * registry chỉ nghĩa là "không có stack external nào", không phải lỗi chí mạng.
 */
export function loadRegistry(): RegistryStack[] {
  const path = registryPath();
  if (!existsSync(path)) return [];
  try {
    const reg = JSON.parse(readFileSync(path, 'utf8')) as Registry;
    if (!Array.isArray(reg.stacks)) return [];
    // Chỉ giữ mục hợp lệ: đủ id/repo/ref (ref bắt buộc — không ghim thì không tải).
    return reg.stacks.filter(
      (s) => s && typeof s.id === 'string' && typeof s.repo === 'string' && typeof s.ref === 'string' && s.ref.length > 0,
    );
  } catch {
    return [];
  }
}

/** Tìm một stack theo id trong registry (nguồn tin cậy DUY NHẤT cho repo/ref). */
export function findStack(stackId: string): RegistryStack | undefined {
  return loadRegistry().find((s) => s.id === stackId);
}

/** Chuẩn hóa `github.com/org/repo` (hoặc URL) thành URL để clone. */
function toCloneUrl(repo: string): string {
  // Đã là URL có scheme (https/http/ssh git@/file:// dùng cho test) → giữ nguyên.
  if (/^(https?:\/\/|git@|file:\/\/|ssh:\/\/)/.test(repo)) return repo;
  // `github.com/org/repo` → `https://github.com/org/repo`
  return `https://${repo}`;
}

/**
 * Clone repo skill theo `ref` đã ghim vào cache `<id>@<ref>` (shallow, chỉ ref đó). Idempotent:
 * cache đã tồn tại → khỏi clone lại. Trả đường dẫn cache, hoặc null nếu clone lỗi (mạng/ref sai).
 *
 * Vì sao clone theo tag cụ thể thay vì clone rồi checkout: `--branch <ref> --depth 1` chỉ kéo
 * đúng snapshot đã duyệt, nhẹ và không có lịch sử để trôi.
 */
function ensureCloned(stack: RegistryStack): string | null {
  const dst = join(cacheRoot(), `${stack.id}@${stack.ref}`);
  if (existsSync(join(dst, '.git'))) return dst; // cache hợp lệ sẵn có

  // Cache dở dang (clone lỗi giữa chừng) → dọn trước khi thử lại.
  if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
  mkdirSync(dirname(dst), { recursive: true });

  const url = toCloneUrl(stack.repo);
  try {
    // --branch nhận cả tag lẫn nhánh; ghim tag để bản đã duyệt bất biến. execFileSync (KHÔNG
    // execSync) để tham số vào dạng mảng — url/ref không chèn được lệnh shell.
    execFileSync('git', ['clone', '--depth', '1', '--branch', stack.ref, url, dst], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 60_000,
    });
    return dst;
  } catch {
    // Clone hỏng: dọn thư mục dở để lần sau thử lại sạch.
    if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    return null;
  }
}

/** Đọc `skillsDir` từ manifest bow-skill.json của repo skill (mặc định `skills`). */
function skillsDirOf(repoDir: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(repoDir, 'bow-skill.json'), 'utf8'));
    if (manifest && typeof manifest.skillsDir === 'string' && manifest.skillsDir.length > 0) {
      return manifest.skillsDir;
    }
  } catch {
    // Không có/không đọc được manifest → dùng quy ước mặc định.
  }
  return 'skills';
}

/** Kết quả trải skill external cho một stack. */
export interface ExternalDeployResult {
  /** Stack đã trải (theo registry). */
  stack: RegistryStack;
  /** Tên các skill đã sẵn sàng trong `.claude/skills/`. */
  skills: string[];
  /** Lý do không trải được (null nếu OK) — để log cho người dùng biết. */
  error: string | null;
}

/**
 * Tải (nếu cần) rồi TRẢI skill external của `stackId` vào `<cwd>/.claude/skills/`.
 *
 * Luồng: registry (allowlist) → clone theo ref đã ghim vào cache → đọc skillsDir từ manifest →
 * deploySkillsFrom với STAMP `.bow-external`. Fail-open: mọi lỗi (stack lạ, clone hỏng) trả
 * error mô tả thay vì throw — agent vẫn chạy được, chỉ là thiếu skill stack.
 */
export function deployExternalSkills(stackId: string, cwd: string): ExternalDeployResult | null {
  if (!stackId) return null;

  const stack = findStack(stackId);
  if (!stack) {
    // Stack không có trong registry = KHÔNG được tải (allowlist admin duyệt). Không đoán repo.
    return { stack: { id: stackId, label: stackId, repo: '', ref: '' }, skills: [], error: 'stack không có trong registry (chưa được admin duyệt)' };
  }

  const repoDir = ensureCloned(stack);
  if (!repoDir) {
    return { stack, skills: [], error: `không tải được ${stack.repo}@${stack.ref} (mạng hoặc ref sai?)` };
  }

  const srcRoot = join(repoDir, skillsDirOf(repoDir));
  if (!existsSync(srcRoot)) {
    return { stack, skills: [], error: `repo không có thư mục skills (${skillsDirOf(repoDir)}/)` };
  }

  const skills = deploySkillsFrom(srcRoot, cwd, EXTERNAL_STAMP);
  return { stack, skills, error: null };
}

/** Dọn toàn bộ cache skill external (debug/gỡ). Trả số thư mục đã xóa. */
export function clearExternalCache(): number {
  const root = cacheRoot();
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const name of readdirSync(root)) {
    rmSync(join(root, name), { recursive: true, force: true });
    n++;
  }
  return n;
}
