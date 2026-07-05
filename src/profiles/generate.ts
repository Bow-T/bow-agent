import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config/env.js';
import { GENERATED_DIR } from './index.js';

/**
 * Tự sinh profile cho một repo lạ: chạy agent (chỉ-đọc) quét cấu trúc/stack/pattern
 * của repo rồi ghi kiến thức ra generated-profiles/<name>.md. Lần sau chọn profile
 * này là dùng ngay, không quét lại.
 */

const SCAN_PROMPT = `
Bạn đang phân tích một repo để tạo "project profile" cho một AI coding agent.
Hãy QUÉT (chỉ đọc, không sửa) và trả về một bản mô tả NGẮN GỌN, THỰC TẾ gồm:

1. Stack & cấu trúc: ngôn ngữ, framework, thư mục chính (apps/packages/src…), build/test command.
2. Kiến trúc & pattern: cách tổ chức code (module/layer), pattern lặp lại agent phải khớp
   (vd cách tạo component/model/route), state management, convention đặt tên.
3. Quy ước & công cụ: lint/format, cách chạy test, cách build, có CLAUDE.md/CONTRIBUTING không.
4. Điểm cần cẩn thận: bug class hay gặp, ràng buộc, chỗ dễ sai.

Viết bằng tiếng Việt, dạng markdown, dưới 400 dòng, đủ để một agent khác viết code
KHỚP repo này mà không phá pattern. KHÔNG bịa — chỉ ghi thứ bạn thực sự thấy trong repo.
Bắt đầu ngay bằng phần mô tả, không lời mở đầu.
`.trim();

/** Chuẩn hóa tên profile từ đường dẫn repo (kebab, an toàn cho tên file). */
export function profileNameFromCwd(cwd: string): string {
  return (
    basename(cwd)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

export interface GenerateResult {
  name: string;
  file: string;
  knowledge: string;
}

/**
 * Sinh profile cho repo ở `cwd`. Trả {name, file, knowledge}.
 * onEvent (tùy chọn) nhận log tiến độ.
 */
export async function generateProfile(
  cwd: string,
  onEvent?: (msg: string) => void,
): Promise<GenerateResult> {
  if (!config.hasAuth) {
    throw new Error('Chưa có auth Claude — điền ANTHROPIC_API_KEY vào .env hoặc login Claude CLI (`claude` → /login).');
  }

  const options: Options = {
    model: config.model,
    effort: 'medium',
    cwd,
    permissionMode: 'plan', // chỉ đọc — không sửa repo lạ.
    allowedTools: ['Read', 'Grep', 'Glob'],
    settingSources: ['project'],
  };

  let knowledge = '';
  for await (const message of query({ prompt: SCAN_PROMPT, options })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          onEvent?.(block.text.trim());
        }
      }
    } else if (message.type === 'result' && message.subtype === 'success') {
      knowledge = message.result.trim();
    }
  }

  if (!knowledge) throw new Error('Agent không sinh được kiến thức từ repo.');

  const name = profileNameFromCwd(cwd);
  await mkdir(GENERATED_DIR, { recursive: true });
  const file = join(GENERATED_DIR, `${name}.md`);
  const header = `# Profile tự sinh cho repo: ${cwd}\n<!-- Sinh tự động bởi bow-agent. Có thể chỉnh tay. -->\n\n`;
  await writeFile(file, header + knowledge, 'utf8');

  return { name, file, knowledge };
}
