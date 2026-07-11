import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Skill prompt-only: các file *.md gộp thẳng vào system prompt (không trải vào .claude/skills/).
 * Nguồn là thư mục `prompt/` của repo skill CORE đã clone (bow-skill-core) — bow-agent là khung
 * rỗng, không còn skills/ nội bộ. externalSkills.deployCoreSkills gọi hàm này với promptDir từ
 * bản clone. Skill kèm code (watch…) đi đường khác: trải vào .claude/skills/ — xem agentSkills.ts.
 */

/**
 * Đọc mọi file `*.md` trong `promptDir` và ghép thành một khối text để append vào system prompt.
 * Trả '' nếu thiếu thư mục / không có file / lỗi đọc (không throw — thiếu skill không phải lỗi).
 */
export function loadPromptSkills(promptDir: string): string {
  if (!promptDir || !existsSync(promptDir)) return '';

  let files: string[];
  try {
    files = readdirSync(promptDir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return '';
  }
  if (files.length === 0) return '';

  const blocks: string[] = [];
  for (const f of files) {
    try {
      const text = readFileSync(join(promptDir, f), 'utf8').trim();
      if (text) blocks.push(text);
    } catch {
      // Bỏ qua file lỗi đọc — một skill hỏng không được kéo sập cả agent.
    }
  }
  if (blocks.length === 0) return '';

  return ['# Skill dùng chung của bow-agent', '', blocks.join('\n\n---\n\n')].join('\n');
}
