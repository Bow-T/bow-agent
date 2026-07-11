import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../config/env.js';
import { deploySkillsFrom } from './agentSkills.js';
import { loadPromptSkills } from './index.js';

/**
 * Skill EXTERNAL: bộ skill theo stack (Flutter+Supabase, React Native+Supabase, …) do team
 * tự nuôi trong repo GitHub RIÊNG, bow-agent tải về khi người dùng chọn stack rồi TRẢI vào
 * `<cwd>/.claude/skills/` — y như skill nội bộ, nhưng nguồn ở ngoài. Xem DESIGN §7.3.
 *
 * Ngoài stack, module này còn tải skill CORE (repo bow-skill-core) mỗi lần chạy — thứ agent
 * LUÔN cần bất kể stack (watch, qc-triage, coding-convention). Vì bow-agent là "khung rỗng",
 * KHÔNG còn thư mục skills/ nội bộ; mọi skill đều tải từ GitHub. Xem deployCoreSkills.
 *
 * AN TOÀN (skill = code chạy trong agent nên phải siết):
 * - ALLOWLIST: chỉ tải repo có trong registry (~/.bow-agent/registry.json, admin duyệt). Không nhận URL tùy ý.
 * - GHIM TAG/COMMIT: luôn checkout theo `ref` đã ghi trong registry — repo đổi nội dung sau khi
 *   duyệt KHÔNG tự động chạy. Không bao giờ lấy nhánh mặc định trôi nổi.
 * - CACHE bất biến theo `<id>@<ref>`: cùng ref → dùng lại cache, khỏi clone lại; đổi ref = cache
 *   mới, không ghi đè cái cũ.
 * - STAMP `.bow-external` / `.bow-core`: phân biệt nguồn (stack / core / người dùng không STAMP)
 *   khi trải — không nguồn nào đá nguồn nào.
 */

/** STAMP riêng cho skill external theo stack — tách khỏi core và skill người dùng. */
const EXTERNAL_STAMP = '.bow-external';
/** STAMP riêng cho skill CORE (luôn tải) — tách khỏi stack và skill người dùng. */
const CORE_STAMP = '.bow-core';

/**
 * Hằng FALLBACK cho core — dùng khi registry local thiếu field `core` (vd registry cũ/hỏng).
 * Core PHẢI luôn tải được, không phụ thuộc registry có mặt field `core` hay không.
 */
const CORE_FALLBACK: RegistryStack = { id: 'core', label: 'Bow Core', repo: 'github.com/Bow-T/bow-skill-core', ref: 'v1.0.0' };

/** Đường dẫn registry skill (allowlist) — tách khỏi repo, ở ~/.bow-agent/registry.json. */
function registryPath(): string {
  return config.registryPath;
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
  /** Repo skill CORE (luôn tải). Thiếu → dùng CORE_FALLBACK. */
  core?: { id: string; repo: string; ref: string };
  stacks: RegistryStack[];
}

/** Kiểm tra một mục có đủ repo/ref để tải (ref bắt buộc — không ghim thì không tải). */
function isValidSource(s: unknown): s is RegistryStack {
  const o = s as RegistryStack;
  return Boolean(o && typeof o.id === 'string' && typeof o.repo === 'string' && typeof o.ref === 'string' && o.ref.length > 0);
}

/** Đọc & parse registry thô (null nếu thiếu/hỏng). */
function readRegistry(): Registry | null {
  const path = registryPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Registry;
  } catch {
    return null;
  }
}

/**
 * Đọc registry (allowlist stack admin duyệt). Trả [] nếu thiếu/hỏng — không throw, vì thiếu
 * registry chỉ nghĩa là "không có stack external nào", không phải lỗi chí mạng.
 */
export function loadRegistry(): RegistryStack[] {
  const reg = readRegistry();
  if (!reg || !Array.isArray(reg.stacks)) return [];
  return reg.stacks.filter(isValidSource);
}

/**
 * Đọc mục CORE từ registry. Thiếu/hỏng → CORE_FALLBACK (core PHẢI luôn tải được).
 * Trả về dạng RegistryStack để dùng chung ensureCloned.
 */
export function loadCore(): RegistryStack {
  const reg = readRegistry();
  const c = reg?.core;
  if (c && isValidSource({ ...c, label: 'Bow Core' })) {
    return { id: c.id, label: 'Bow Core', repo: c.repo, ref: c.ref };
  }
  return CORE_FALLBACK;
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

/**
 * Đọc một field thư mục (`skillsDir`/`promptDir`/`monorepoDir`) từ manifest bow-skill.json.
 * Trả `fallback` nếu manifest thiếu field (hoặc không đọc được). `fallback` rỗng = không có
 * thư mục đó (vd repo stack không khai monorepoDir → không có monorepo context).
 */
function dirFromManifest(repoDir: string, field: string, fallback: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(repoDir, 'bow-skill.json'), 'utf8'));
    const v = manifest?.[field];
    if (typeof v === 'string' && v.length > 0) return v;
  } catch {
    // Không có/không đọc được manifest → dùng fallback.
  }
  return fallback;
}

/** Thư mục chứa skill (có SKILL.md) trong repo — mặc định `skills`. */
function skillsDirOf(repoDir: string): string {
  return dirFromManifest(repoDir, 'skillsDir', 'skills');
}

/** Kết quả trải skill external cho một stack. */
export interface ExternalDeployResult {
  /** Stack đã trải (theo registry). */
  stack: RegistryStack;
  /** Tên các skill đã sẵn sàng trong `.claude/skills/`. */
  skills: string[];
  /**
   * Thư mục MONOREPO context trong bản clone (CLAUDE.md + skills catalog), '' nếu manifest
   * không khai `monorepoDir`. runner đọc để nạp ngữ cảnh monorepo khi cwd là monorepo.
   */
  monorepoDir: string;
  /** Thư mục git hooks (guard-commit/push) trong bản clone, '' nếu không có. */
  hooksDir: string;
  /** Lý do không trải được (null nếu OK) — để log cho người dùng biết. */
  error: string | null;
}

/**
 * Tải (nếu cần) rồi TRẢI skill external của `stackId` vào `<cwd>/.claude/skills/`.
 *
 * Luồng: registry (allowlist) → clone theo ref đã ghim vào cache → đọc skillsDir từ manifest →
 * deploySkillsFrom với STAMP `.bow-external`. Còn trả monorepoDir/hooksDir (từ manifest bản
 * clone) để runner nạp ngữ cảnh monorepo. Fail-open: mọi lỗi (stack lạ, clone hỏng) trả error
 * mô tả thay vì throw — agent vẫn chạy được, chỉ là thiếu skill stack.
 */
export function deployExternalSkills(stackId: string, cwd: string): ExternalDeployResult | null {
  if (!stackId) return null;

  const empty = { skills: [] as string[], monorepoDir: '', hooksDir: '' };

  const stack = findStack(stackId);
  if (!stack) {
    // Stack không có trong registry = KHÔNG được tải (allowlist admin duyệt). Không đoán repo.
    return { stack: { id: stackId, label: stackId, repo: '', ref: '' }, ...empty, error: 'stack không có trong registry (chưa được admin duyệt)' };
  }

  const repoDir = ensureCloned(stack);
  if (!repoDir) {
    return { stack, ...empty, error: `không tải được ${stack.repo}@${stack.ref} (mạng hoặc ref sai?)` };
  }

  // Đường dẫn monorepo context + hooks (nếu manifest khai). Fallback '' = repo stack không có.
  const monorepoRel = dirFromManifest(repoDir, 'monorepoDir', '');
  const monorepoDir = monorepoRel ? join(repoDir, monorepoRel) : '';
  const hooksDir = monorepoDir ? join(monorepoDir, 'hooks') : '';

  const srcRoot = join(repoDir, skillsDirOf(repoDir));
  if (!existsSync(srcRoot)) {
    return { stack, ...empty, monorepoDir, hooksDir, error: `repo không có thư mục skills (${skillsDirOf(repoDir)}/)` };
  }

  const skills = deploySkillsFrom(srcRoot, cwd, EXTERNAL_STAMP);
  return { stack, skills, monorepoDir, hooksDir, error: null };
}

/** Kết quả tải skill CORE (luôn tải, không phụ thuộc stack). */
export interface CoreDeployResult {
  /** Tên các skill core đã trải vào `.claude/skills/` (watch, qc-triage). */
  skills: string[];
  /** Text prompt-only (coding-convention…) đã ghép sẵn để runner append vào system prompt. */
  promptText: string;
  /** Lý do không tải được (null nếu OK) — fail-open, agent vẫn chạy thiếu core. */
  error: string | null;
}

/**
 * TẢI skill CORE (repo bow-skill-core) — LUÔN chạy mỗi lần, không phụ thuộc stack. Trải skill
 * kèm code (watch, qc-triage) vào `<cwd>/.claude/skills/` với STAMP `.bow-core`, và đọc
 * prompt-only (coding-convention) trả về `promptText` để runner ghép vào system prompt.
 *
 * Fail-open: offline/clone lỗi lần đầu → trả rỗng + error; agent vẫn chạy (thiếu core). Sau lần
 * đầu, cache cho phép chạy offline. Core repo/ref lấy từ registry (field `core`), thiếu → CORE_FALLBACK.
 */
export function deployCoreSkills(cwd: string): CoreDeployResult {
  const core = loadCore();
  const repoDir = ensureCloned(core);
  if (!repoDir) {
    return { skills: [], promptText: '', error: `không tải được core ${core.repo}@${core.ref} (offline hoặc chưa cache?)` };
  }

  // Skill kèm code → trải vào .claude/skills/ (STAMP riêng .bow-core).
  const skillsRoot = join(repoDir, skillsDirOf(repoDir));
  const skills = existsSync(skillsRoot) ? deploySkillsFrom(skillsRoot, cwd, CORE_STAMP) : [];

  // Prompt-only → đọc *.md ghép thành text (KHÔNG trải vào .claude/skills/).
  const promptRel = dirFromManifest(repoDir, 'promptDir', 'prompt');
  const promptDir = join(repoDir, promptRel);
  const promptText = existsSync(promptDir) ? loadPromptSkills(promptDir) : '';

  return { skills, promptText, error: null };
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

/**
 * Một mục trong ĐÃ CLONE về cache chưa — KHÔNG tải (khác ensureCloned). Chỉ soi đĩa.
 * Cache hợp lệ = thư mục `<id>@<ref>/.git` tồn tại.
 */
function isCached(source: RegistryStack): boolean {
  return existsSync(join(cacheRoot(), `${source.id}@${source.ref}`, '.git'));
}

/** Trạng thái tải của MỘT nguồn skill (core hoặc một stack). */
export interface SkillSourceStatus {
  /** Định danh nguồn (`core`, `flutter-supabase`, …). */
  id: string;
  /** Nhãn hiển thị. */
  label: string;
  /** Tag/commit đang ghim trong registry. */
  ref: string;
  /** Đã clone về `~/.bow/skills-cache/<id>@<ref>` chưa → chạy offline được. */
  cached: boolean;
}

/** Trạng thái skill tổng thể để UI dựng badge (đọc-only, không tải gì). */
export interface SkillStatus {
  /** Nguồn CORE (luôn cần). */
  core: SkillSourceStatus;
  /** Stack người dùng đang chọn (null nếu không chọn stack nào). */
  stack: SkillSourceStatus | null;
  /**
   * Tổng kết: mọi nguồn cần thiết (core + stack đang chọn, nếu có) đều đã cache?
   * true = sẵn sàng chạy offline; false = lần chạy tới sẽ phải tải (cần mạng/token).
   */
  ready: boolean;
}

/**
 * Soi trạng thái tải skill cho stack đang chọn — KHÔNG tải gì (chỉ đọc đĩa + registry).
 * UI gọi để dựng badge "đã đủ / chưa tải". `stackId` rỗng = chỉ xét core.
 */
export function skillStatus(stackId: string): SkillStatus {
  const core = loadCore();
  const coreStatus: SkillSourceStatus = { id: core.id, label: core.label, ref: core.ref, cached: isCached(core) };

  let stackStatus: SkillSourceStatus | null = null;
  if (stackId) {
    const stack = findStack(stackId);
    // Stack ngoài registry (chưa admin duyệt) → coi như chưa cache (không thể tải).
    stackStatus = stack
      ? { id: stack.id, label: stack.label, ref: stack.ref, cached: isCached(stack) }
      : { id: stackId, label: stackId, ref: '', cached: false };
  }

  const ready = coreStatus.cached && (stackStatus ? stackStatus.cached : true);
  return { core: coreStatus, stack: stackStatus, ready };
}

/** Kết quả một nguồn sau khi đồng bộ thủ công. */
export interface SyncOne {
  id: string;
  label: string;
  ref: string;
  /** Đã trải xong (clone OK + trải vào .claude/skills/) hay lỗi. */
  ok: boolean;
  /** Tên skill đã trải (rỗng nếu lỗi hoặc nguồn prompt-only). */
  skills: string[];
  /** Lý do lỗi (null nếu OK). */
  error: string | null;
}

/** Kết quả ĐỒNG BỘ THỦ CÔNG (core + stack đang chọn). */
export interface SyncResult {
  core: SyncOne;
  stack: SyncOne | null;
  /** Mọi nguồn đều OK? */
  ok: boolean;
}

/**
 * ĐỒNG BỘ THỦ CÔNG: chủ động tải (nếu chưa cache) + trải core + stack đang chọn vào
 * `<cwd>/.claude/skills/`, KHÔNG cần chạy phiên agent. Dùng lại deployCoreSkills/
 * deployExternalSkills nên hành vi giống hệt lúc runner khởi động — chỉ khác là gọi
 * chủ động từ nút UI. `stackId` rỗng = chỉ đồng bộ core.
 *
 * Fail-open: nguồn nào lỗi trả `ok:false` + error, không throw — cái khác vẫn tải.
 */
export function syncSkills(stackId: string, cwd: string): SyncResult {
  const coreRes = deployCoreSkills(cwd);
  const coreMeta = loadCore();
  const core: SyncOne = {
    id: coreMeta.id,
    label: coreMeta.label,
    ref: coreMeta.ref,
    ok: coreRes.error === null,
    skills: coreRes.skills,
    error: coreRes.error,
  };

  let stack: SyncOne | null = null;
  if (stackId) {
    const ext = deployExternalSkills(stackId, cwd);
    stack = ext
      ? {
          id: ext.stack.id,
          label: ext.stack.label || stackId,
          ref: ext.stack.ref,
          ok: ext.error === null,
          skills: ext.skills,
          error: ext.error,
        }
      : { id: stackId, label: stackId, ref: '', ok: false, skills: [], error: 'stackId rỗng hoặc không hợp lệ' };
  }

  const ok = core.ok && (stack ? stack.ok : true);
  return { core, stack, ok };
}
