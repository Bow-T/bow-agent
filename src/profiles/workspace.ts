import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Workspace = MỘT SẢN PHẨM gồm NHIỀU repo (BE một nơi, FE một nơi, infra…). Thêm một
 * lớp TRÊN project profile (không thay thế): gom nhiều cwd vào một sản phẩm + hai file
 * tri thức dùng chung.
 *
 * Lưu trong bow-agent/workspaces/ — GITIGNORE, runtime per-máy (mirror generated-profiles/):
 *   workspaces/
 *   ├── workspaces.json          đăng ký: workspace ⇄ các repo (đường dẫn tuyệt đối) + vai trò
 *   └── <slug>/
 *       ├── shared.md            tri thức CHUNG sản phẩm (contract BE↔FE, quyết định KT)
 *       └── journal.md           nhật ký TỰ ĐỘNG: mỗi phiên append 1 mục
 *
 * Xem ARCHITECTURE.md §9. Tri thức là markdown phẳng — người đọc & sửa tay được, không trạng
 * thái ẩn (KHÔNG phải "Genome" đã gỡ: không fitness/mutation/vòng tiến hóa).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Thư mục gốc chứa mọi workspace (gitignore, cạnh repo root — như GENERATED_DIR). */
export const WORKSPACES_DIR = join(__dirname, '..', '..', 'workspaces');
/** File đăng ký workspace ⇄ repo. */
export const REGISTRY_FILE = join(WORKSPACES_DIR, 'workspaces.json');

/** Một repo thành viên của workspace. */
export interface WorkspaceRepo {
  /** Đường dẫn tuyệt đối tới repo. */
  path: string;
  /** Vai trò trong sản phẩm (BE / FE / infra…) — nhãn tự do, để agent hiểu bản đồ. */
  role: string;
}

/** Một workspace đã resolve (kèm slug + đường dẫn file tri thức). */
export interface Workspace {
  /** Tên slug (an toàn cho tên thư mục). */
  slug: string;
  /** Các repo thành viên. */
  repos: WorkspaceRepo[];
  /** Đường dẫn thư mục tri thức của workspace này. */
  dir: string;
}

/** Shape lưu trên đĩa: { slug: { repos: { <path>: <role> } } }. */
type Registry = Record<string, { repos: Record<string, string> }>;

/**
 * Chuẩn hóa tên workspace → slug an toàn cho tên file (kebab). Bỏ DẤU tiếng Việt trước
 * (Unicode NFD tách dấu combining rồi loại) để "App Giao Hàng" → "app-giao-hang" thay vì
 * "app-giao-h-ng". đ/Đ không phải combining nên map tay.
 */
export function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // xóa dấu thanh/mũ đã tách
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workspace'
  );
}

/** Đọc registry từ đĩa (rỗng nếu chưa có / lỗi parse — fail-open, không kéo sập). */
function readRegistry(): Registry {
  if (!existsSync(REGISTRY_FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Registry) : {};
  } catch {
    return {};
  }
}

/** Ghi registry ra đĩa (tạo thư mục nếu chưa có). */
function writeRegistry(reg: Registry): void {
  mkdirSync(WORKSPACES_DIR, { recursive: true });
  writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2) + '\n', 'utf8');
}

/** Thư mục tri thức của một workspace theo slug. */
function workspaceDir(slug: string): string {
  return join(WORKSPACES_DIR, slug);
}

/**
 * True nếu `child` nằm TRONG (hoặc chính là) `parent` — khớp theo BIÊN segment, không
 * chỉ tiền tố chuỗi (tránh /a/foobar khớp nhầm /a/foo). Cả hai đã resolve tuyệt đối.
 */
function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

/**
 * Tìm workspace chứa `cwd`: cwd trùng, nằm TRONG, hoặc CHỨA một repo đã đăng ký đều tính.
 * (Chứa: người dùng đăng ký monorepo root nhưng trỏ agent vào một package con — vẫn thuộc.)
 * Trả null nếu cwd không thuộc workspace nào → runner chạy y như cũ (opt-in).
 */
export function resolveWorkspace(cwd: string): Workspace | null {
  const reg = readRegistry();
  const target = resolve(cwd);
  for (const [slug, entry] of Object.entries(reg)) {
    const repos = Object.entries(entry.repos ?? {});
    const matches = repos.some(([path]) => isInside(target, path) || isInside(path, target));
    if (matches) {
      return {
        slug,
        dir: workspaceDir(slug),
        repos: repos.map(([path, role]) => ({ path: resolve(path), role: String(role) })),
      };
    }
  }
  return null;
}

/** Đọc một file tri thức của workspace (rỗng nếu chưa có). */
function readKnowledge(ws: Workspace, file: 'shared.md' | 'journal.md'): string {
  const p = join(ws.dir, file);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/**
 * Số mục journal gần nhất nạp vào prompt. Journal là append-only sẽ lớn dần; chỉ lấy
 * đuôi để không phình prompt. Mục cũ giữ trên đĩa để tra tay. Xem DESIGN §9.4.
 */
const JOURNAL_RECENT_ENTRIES = 15;
/** Dấu phân tách giữa các mục journal (dòng ngăn cách + tiêu đề mốc thời gian). */
const JOURNAL_SEP = '\n\n---\n\n';

/** Lấy N mục journal gần nhất (cắt theo JOURNAL_SEP). Rỗng nếu chưa có journal. */
function recentJournal(ws: Workspace, n = JOURNAL_RECENT_ENTRIES): string {
  const all = readKnowledge(ws, 'journal.md').trim();
  if (!all) return '';
  const entries = all.split(JOURNAL_SEP).filter((e) => e.trim());
  return entries.slice(-n).join(JOURNAL_SEP);
}

/**
 * Dựng khối tri thức workspace để APPEND vào system prompt (đặt TRƯỚC project profile —
 * chung → riêng). Rỗng nếu cwd không thuộc workspace nào. `cwd` = repo đang thao tác,
 * dùng để đánh dấu đâu là "repo hiện tại" trong bản đồ repo anh em.
 */
export function buildWorkspacePrompt(ws: Workspace, cwd: string): string {
  const shared = readKnowledge(ws, 'shared.md').trim();
  const journal = recentJournal(ws);
  const target = resolve(cwd);

  const repoMap = ws.repos
    .map((r) => {
      const here = isInside(target, r.path) || isInside(r.path, target);
      return `- **${r.role}**${here ? ' (repo HIỆN TẠI đang làm)' : ''}: \`${r.path}\``;
    })
    .join('\n');

  const parts: string[] = [
    `# Workspace: ${ws.slug}`,
    'Bạn đang làm việc trong một **sản phẩm gồm nhiều repo**. Các repo anh em dưới đây là để' +
      ' THAM CHIẾU: bạn ĐƯỢC đọc code của chúng (Read/Grep/Glob) để hiểu contract/hành vi' +
      ' THẬT — đừng đoán. TUYỆT ĐỐI không sửa repo anh em trừ khi người dùng yêu cầu và duyệt' +
      ' (mọi thao tác ghi ra ngoài repo hiện tại đều sẽ phải xin duyệt).',
    `## Bản đồ repo\n${repoMap}`,
  ];
  if (shared) parts.push(`## Tri thức chung sản phẩm\n${shared}`);
  if (journal) {
    parts.push(
      `## Nhật ký các phiên trước (mới → cũ, ${JOURNAL_RECENT_ENTRIES} mục gần nhất)\n` +
        'Ngữ cảnh tích lũy từ những lần làm trước trong sản phẩm này. Dùng để nhớ quyết định' +
        ` & điều đã học; nếu mâu thuẫn với code thực tế thì tin code.\n\n${journal}`,
    );
  }
  return parts.join('\n\n');
}

/** Đường dẫn các repo anh em (KHÁC repo hiện tại) — để mở đọc chéo read-only qua SDK. */
export function siblingRepoPaths(ws: Workspace, cwd: string): string[] {
  const target = resolve(cwd);
  return ws.repos
    .map((r) => r.path)
    .filter((p) => !(isInside(target, p) || isInside(p, target)));
}

/**
 * Append một mục vào journal của workspace. `summary` là bản cô đọng phiên vừa xong.
 * `stamp` là mốc thời gian (ISO) do CALLER truyền — module này không tự đọc đồng hồ để
 * giữ thuần & dễ test. Tự tạo thư mục nếu chưa có. Bỏ qua lặng lẽ nếu summary rỗng.
 */
export function appendJournal(ws: Workspace, summary: string, stamp: string): void {
  const body = summary.trim();
  if (!body) return;
  mkdirSync(ws.dir, { recursive: true });
  const file = join(ws.dir, 'journal.md');
  const entry = `## ${stamp}\n\n${body}`;
  // Nếu journal đã có nội dung, chèn separator trước; nếu chưa, ghi thẳng.
  const prefix = existsSync(file) && readFileSync(file, 'utf8').trim() ? JOURNAL_SEP : '';
  appendFileSync(file, prefix + entry + '\n', 'utf8');
}

/** Đọc tri thức chung (shared.md) của workspace — rỗng nếu chưa có. Cho UI/CLI hiển thị. */
export function readSharedKnowledge(ws: Workspace): string {
  return readKnowledge(ws, 'shared.md');
}

/** Ghi đè tri thức chung (shared.md) của workspace. Tự tạo thư mục nếu chưa có. */
export function writeSharedKnowledge(ws: Workspace, content: string): void {
  mkdirSync(ws.dir, { recursive: true });
  writeFileSync(join(ws.dir, 'shared.md'), content, 'utf8');
}

/** Đọc TOÀN BỘ journal.md (không cắt) — cho UI hiển thị lịch sử đầy đủ. Rỗng nếu chưa có. */
export function readFullJournal(ws: Workspace): string {
  return readKnowledge(ws, 'journal.md');
}

// ── API quản lý (dùng cho CLI/web gán repo vào workspace) ─────────────────────

/** Danh sách slug workspace đã đăng ký. */
export function listWorkspaces(): Workspace[] {
  const reg = readRegistry();
  return Object.entries(reg).map(([slug, entry]) => ({
    slug,
    dir: workspaceDir(slug),
    repos: Object.entries(entry.repos ?? {}).map(([path, role]) => ({
      path: resolve(path),
      role: String(role),
    })),
  }));
}

/**
 * Gán một repo vào workspace (tạo workspace nếu chưa có). `name` được slugify. Ghi đè
 * vai trò nếu repo đã có trong workspace đó. Trả workspace sau khi cập nhật.
 */
export function addRepoToWorkspace(name: string, repoPath: string, role: string): Workspace {
  const slug = slugify(name);
  const abs = resolve(repoPath);
  const reg = readRegistry();
  const entry = reg[slug] ?? { repos: {} };
  entry.repos[abs] = role || 'repo';
  reg[slug] = entry;
  writeRegistry(reg);
  return {
    slug,
    dir: workspaceDir(slug),
    repos: Object.entries(entry.repos).map(([path, r]) => ({ path: resolve(path), role: String(r) })),
  };
}

/** Gỡ một repo khỏi workspace (xóa workspace nếu không còn repo nào). */
export function removeRepoFromWorkspace(name: string, repoPath: string): void {
  const slug = slugify(name);
  const abs = resolve(repoPath);
  const reg = readRegistry();
  if (!reg[slug]) return;
  delete reg[slug].repos[abs];
  if (Object.keys(reg[slug].repos).length === 0) delete reg[slug];
  writeRegistry(reg);
}
