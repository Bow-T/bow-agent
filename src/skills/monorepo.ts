import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Ngữ cảnh riêng của MONOREPO (DUOCT), gói sẵn từ .claude của monorepo vào
 * bow-agent (skills/monorepo/). Chỉ kích hoạt khi agent làm việc TRONG monorepo
 * — repo khác không bị nhiễu.
 *
 * Gồm: CLAUDE.md (kiến thức nền) + danh mục 18 skill (name + description, kèm
 * đường dẫn để agent tự Read full SKILL.md khi cần — không nhồi cả nghìn dòng
 * vào system prompt). Hooks xử lý riêng ở ./hooks.ts.
 */

/** Thư mục skills/monorepo/ ở root repo bow-agent (dù chạy từ src/ hay dist/). */
function monorepoBundleDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../skills/monorepo');
}

/**
 * cwd có phải nằm trong monorepo không? Nhận diện theo đường dẫn chứa segment
 * "monorepo" (theo yêu cầu người dùng). Tách riêng một hàm để sau này muốn đổi
 * sang marker file (vd scripts/check-quest.sh) chỉ cần sửa ở đây.
 */
export function isMonorepo(cwd: string): boolean {
  const norm = resolve(cwd);
  // Khớp segment "monorepo" trong path, không khớp "monorepo-foo" nhầm.
  return /(^|\/)monorepo(\/|$)/.test(norm);
}

/** Đọc name + description từ frontmatter một SKILL.md (best-effort). */
function readSkillMeta(skillMd: string): { name: string; description: string } | null {
  let text: string;
  try {
    text = readFileSync(skillMd, 'utf8');
  } catch {
    return null;
  }
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const body = fm[1];
  const nameM = body.match(/^name:\s*(.+)$/m);
  // description có thể là 1 dòng hoặc block scalar (>- / >). Lấy phần sau "description:".
  const descM = body.match(/^description:\s*([\s\S]*?)(?=\n[a-zA-Z_]+:|$)/m);
  const name = nameM?.[1]?.trim() ?? '';
  let description = (descM?.[1] ?? '').replace(/^[>|]-?\s*/, '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  // Cắt description cho gọn (danh mục, không phải full skill).
  if (description.length > 300) description = description.slice(0, 297) + '...';
  return { name, description };
}

/**
 * Nạp ngữ cảnh monorepo để append vào system prompt. Trả '' nếu cwd KHÔNG phải
 * monorepo, hoặc bundle không tồn tại (không throw — thiếu bundle không phải lỗi).
 */
export function loadMonorepoContext(cwd: string): string {
  if (!isMonorepo(cwd)) return '';
  const dir = monorepoBundleDir();
  if (!existsSync(dir)) return '';

  const parts: string[] = ['# Ngữ cảnh dự án MONOREPO (DUOCT)'];
  parts.push(
    'Bạn đang làm việc trong monorepo DUOCT. Áp dụng kiến thức và quy trình dưới đây.',
  );

  // 1) CLAUDE.md — kiến thức nền, đưa nguyên vào.
  const claudeMd = join(dir, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    try {
      const text = readFileSync(claudeMd, 'utf8').trim();
      if (text) parts.push('## Quy ước dự án (CLAUDE.md)\n\n' + text);
    } catch {
      // bỏ qua nếu đọc lỗi
    }
  }

  // 2) Danh mục skill — chỉ name + description + đường dẫn (agent tự Read full khi cần).
  const skillsDir = join(dir, 'skills');
  if (existsSync(skillsDir)) {
    const catalog: string[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(skillsDir).sort();
    } catch {
      entries = [];
    }
    for (const name of entries) {
      const skillMd = join(skillsDir, name, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const meta = readSkillMeta(skillMd);
      if (!meta) continue;
      catalog.push(`- **${meta.name}** — ${meta.description}\n  (Đọc đầy đủ: \`${skillMd}\`)`);
    }
    if (catalog.length > 0) {
      parts.push(
        '## Skill của monorepo\n\n' +
          'Các quy trình sẵn có dưới đây. Khi task khớp mô tả một skill, hãy Read file ' +
          'SKILL.md tương ứng rồi làm theo:\n\n' +
          catalog.join('\n'),
      );
    }
  }

  return parts.join('\n\n');
}
