import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Skill CHUNG của bow-agent (áp cho mọi repo). Gồm 2 loại:
 * - prompt-only: các file skills/prompt/*.md — gộp vào system prompt (module này).
 * - kèm code: server bow-skills — xem ./code.ts.
 *
 * Khác skill của repo đích (.claude/skills/*, do SDK tự nạp khi settingSources
 * có 'project'): những skill này không phụ thuộc repo nào, luôn có mặt.
 */

/** Đường dẫn thư mục skills/ ở root repo bow-agent (dù chạy từ src/ hay dist/). */
function skillsRoot(): string {
  // File này ở <root>/src/skills/index.ts (tsx) hoặc <root>/dist/skills/index.js.
  // Cả hai đều lùi 2 cấp về <root> rồi vào skills/.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../skills');
}

/**
 * Đọc mọi skill prompt-only (skills/prompt/*.md) và ghép thành một khối text để
 * append vào system prompt. Trả '' nếu không có skill nào (không throw — thiếu
 * skill không phải lỗi).
 */
export function loadPromptSkills(): string {
  const dir = join(skillsRoot(), 'prompt');
  if (!existsSync(dir)) return '';

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return '';
  }
  if (files.length === 0) return '';

  const blocks: string[] = [];
  for (const f of files) {
    try {
      const text = readFileSync(join(dir, f), 'utf8').trim();
      if (text) blocks.push(text);
    } catch {
      // Bỏ qua file lỗi đọc — một skill hỏng không được kéo sập cả agent.
    }
  }
  if (blocks.length === 0) return '';

  return ['# Skill dùng chung của bow-agent', '', blocks.join('\n\n---\n\n')].join('\n');
}
