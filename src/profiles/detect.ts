import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from './index.js';
import { profileNameFromCwd } from './generate.js';

/**
 * Tự nhận diện "đang làm ở source nào" từ thư mục repo (cwd).
 * Không hardcode profile — nhìn dấu hiệu trong repo rồi đoán.
 */

export interface DetectedSource {
  /** Profile phù hợp: tên profile đã đăng ký, hoặc 'none'. */
  profile: string;
  /** Stack đoán được (để hiển thị + quyết định scaffold). */
  stack: string;
  /** Repo có trống không (thư mục mới, chưa có source) → gợi ý scaffold. */
  empty: boolean;
  /** Mô tả ngắn cho UI/CLI. */
  summary: string;
  /** Số ký tự kiến thức profile sẽ nhồi vào agent (chỉ có khi khớp profile đã sinh). */
  profileChars?: number;
}

/** File tồn tại trong dir? */
function has(dir: string, ...names: string[]): boolean {
  return names.every((n) => existsSync(join(dir, n)));
}

/** Đọc pubspec.yaml lấy tên project (nếu có). */
function pubspecName(dir: string): string | null {
  try {
    const txt = readFileSync(join(dir, 'pubspec.yaml'), 'utf8');
    const m = txt.match(/^name:\s*(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Repo trống (không có file nguồn đáng kể)? */
function isEmpty(dir: string): boolean {
  const markers = [
    'pubspec.yaml',
    'package.json',
    'Cargo.toml',
    'go.mod',
    'requirements.txt',
    'pyproject.toml',
    'pom.xml',
    'build.gradle',
  ];
  return !markers.some((m) => existsSync(join(dir, m)));
}

/**
 * Nhận diện source từ cwd. Trả profile + stack + gợi ý.
 *
 * Quy tắc (mở rộng dễ khi thêm dự án):
 * - Đã sinh profile riêng cho repo này (generated-profiles/<repo>.md) → ưu tiên dùng luôn.
 * - Flutter (pubspec) + Supabase (supabase/) → nhận diện flutter-supabase tổng quát (dùng 'none' + gợi ý sinh profile).
 * - Repo trống → gợi ý khởi tạo dự án mới.
 * - Còn lại → 'none' (agent tổng quát, dựa CLAUDE.md của repo).
 */
export function detectSource(cwd: string): DetectedSource {
  // Ưu tiên cao nhất: người dùng đã chủ động "Sinh profile cho repo này" →
  // file generated-profiles/<repo>.md. Nếu có, AUTO nạp luôn nó (getProfile đọc
  // được GENERATED_DIR). Đây là mắt xích nối "Sinh profile" ↔ selector AUTO.
  const genName = profileNameFromCwd(cwd);
  const genFile = join(GENERATED_DIR, `${genName}.md`);
  if (existsSync(genFile)) {
    let profileChars = 0;
    try {
      profileChars = readFileSync(genFile, 'utf8').length;
    } catch {
      /* đọc lỗi → bỏ qua kích thước, vẫn dùng profile */
    }
    return {
      profile: genName,
      stack: 'generated',
      empty: false,
      summary: `Dùng profile đã sinh cho repo này: ${genName}.`,
      profileChars,
    };
  }

  if (isEmpty(cwd)) {
    return {
      profile: 'none',
      stack: 'empty',
      empty: true,
      summary: 'Thư mục trống — có thể khởi tạo dự án mới.',
    };
  }

  const isFlutter = has(cwd, 'pubspec.yaml');
  const hasSupabase = existsSync(join(cwd, 'supabase'));
  const isMonorepoApps = existsSync(join(cwd, 'apps'));

  if (isFlutter || (isMonorepoApps && hasSupabase)) {
    if (hasSupabase) {
      return {
        profile: 'none',
        stack: 'flutter+supabase',
        empty: false,
        summary:
          'Nhận diện: Flutter + Supabase → profile none. Có thể sinh profile riêng cho repo này.',
      };
    }
    return {
      profile: 'none',
      stack: 'flutter',
      empty: false,
      summary: 'Nhận diện: Flutter → profile none. Có thể sinh profile riêng cho repo này.',
    };
  }

  // Node/Next/khác.
  if (has(cwd, 'package.json')) {
    return { profile: 'none', stack: 'node', empty: false, summary: 'Nhận diện: dự án Node/JS → profile none.' };
  }

  return { profile: 'none', stack: 'unknown', empty: false, summary: 'Không nhận diện được stack → profile none.' };
}
