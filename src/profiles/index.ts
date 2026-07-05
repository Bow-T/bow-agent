import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

/**
 * Registry các "project profile". Mỗi profile = kiến thức dự án (nhồi system prompt)
 * + bộ sub-agent chuyên biệt.
 *
 * Ba nguồn (ưu tiên theo thứ tự này khi trùng tên):
 *  1. Profile tĩnh (code).
 *  2. Profile CHUẨN (base source): file .md trong profiles/base/ — quy ước dựng app
 *     chuẩn của team (Flutter+Supabase+Stripe+Jira+Mapbox). ĐƯỢC COMMIT, chia sẻ cho
 *     mọi dự án cùng khuôn để phát triển nhanh. Con người viết & kiểm soát.
 *  3. Profile SINH ĐỘNG: file .md trong generated-profiles/ (do agent tự quét repo
 *     lạ sinh ra). GITIGNORE — dữ liệu runtime per-máy. Không có sub-agent riêng.
 */
export interface ProjectProfile {
  knowledge: string;
  subagents: Record<string, AgentDefinition>;
}

const STATIC_PROFILES: Record<string, ProjectProfile> = {};

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Thư mục profile CHUẨN của team (committed). Base profile là file .md nằm cạnh source;
 * `tsc` KHÔNG copy .md sang dist, nên resolve tới cây src để bản build (chạy từ dist/)
 * vẫn thấy — base profile luôn có sẵn trong repo. Chạy từ src (tsx): __dirname là
 * src/profiles → 'base'. Chạy từ dist: __dirname là dist/profiles → '../../src/profiles/base'.
 */
export const BASE_DIRS = [
  join(__dirname, 'base'),
  join(__dirname, '..', '..', 'src', 'profiles', 'base'),
];
/** Thư mục chứa profile sinh động (markdown, gitignore — runtime, cạnh repo root). */
export const GENERATED_DIR = join(__dirname, '..', '..', 'generated-profiles');

/** Đọc một profile .md từ danh sách thư mục (thư mục đầu có file thì thắng). */
function readProfileFrom(dirs: string[], name: string): ProjectProfile | null {
  for (const dir of dirs) {
    const file = join(dir, `${name}.md`);
    if (existsSync(file)) return { knowledge: readFileSync(file, 'utf8'), subagents: {} };
  }
  return null;
}

/** Liệt kê tên profile .md trong các thư mục (khử trùng, rỗng nếu không có). */
function listProfiles(dirs: string[]): string[] {
  const names = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.md')) names.add(f.replace(/\.md$/, ''));
    }
  }
  return [...names];
}

/** Lấy profile theo tên (tĩnh → base chuẩn → sinh động). Null nếu không có. */
export function getProfile(name: string): ProjectProfile | null {
  return (
    STATIC_PROFILES[name] ??
    readProfileFrom(BASE_DIRS, name) ??
    readProfileFrom([GENERATED_DIR], name)
  );
}

/** Danh sách tên profile hợp lệ (tĩnh + base chuẩn + sinh động + 'none'). */
export function profileNames(): string[] {
  const all = [
    ...Object.keys(STATIC_PROFILES),
    ...listProfiles(BASE_DIRS),
    ...listProfiles([GENERATED_DIR]),
  ];
  return [...new Set([...all, 'none'])]; // khử trùng nếu base & generated trùng tên
}
