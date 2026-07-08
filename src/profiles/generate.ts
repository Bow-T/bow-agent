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
 * Prompt "xem cấu trúc dự án": thiên về CÂY THƯ MỤC + kiến trúc để NGƯỜI đọc hiểu
 * nhanh layout repo (khác SCAN_PROMPT vốn để sinh knowledge cho agent). Chỉ đọc.
 */
const STRUCTURE_PROMPT = `
Bạn đang mô tả CẤU TRÚC của một dự án cho người đọc muốn hiểu nhanh repo này.
Hãy QUÉT (chỉ đọc, không sửa) và trả về markdown gồm:

1. **Tổng quan**: một câu — đây là loại dự án gì (app/lib/service/monorepo…), stack chính.
2. **Cây thư mục** (code block): các thư mục/file quan trọng ở vài cấp đầu, KÈM chú
   thích ngắn mỗi mục làm gì. BỎ QUA node_modules, .git, dist, build, .dart_tool,
   vendor, và file sinh tự động. Giữ gọn — không liệt kê mọi file.
3. **Vai trò từng phần chính**: mỗi thư mục top-level quan trọng làm gì (1 dòng).
4. **Điểm vào & luồng chính**: file khởi chạy / entrypoint, cách các phần nối nhau.

Viết bằng tiếng Việt, dưới 250 dòng. KHÔNG bịa — chỉ ghi thứ bạn thực sự thấy.
Bắt đầu ngay bằng phần mô tả, không lời mở đầu.
`.trim();

/**
 * Quét repo (chỉ đọc) bằng agent → trả CHUỖI mô tả. KHÔNG lưu file. Dùng chung cho
 * "sinh profile" (lưu) và "xem cấu trúc" (chỉ hiển thị). `prompt` chọn góc nhìn.
 */
export async function scanRepoKnowledge(
  cwd: string,
  prompt: string = SCAN_PROMPT,
  onEvent?: (msg: string) => void,
): Promise<string> {
  if (!config.hasAuth) {
    throw new Error('Chưa đăng nhập Claude CLI — chạy `claude` rồi /login.');
  }

  const options: Options = {
    model: config.model,
    effort: 'medium',
    cwd,
    permissionMode: 'plan', // chỉ đọc — không sửa repo.
    allowedTools: ['Read', 'Grep', 'Glob'],
    settingSources: ['project'],
  };

  // Ở permissionMode 'plan', nội dung mô tả nằm trong các text block của agent,
  // KHÔNG phải message.result (result chỉ là câu kết thúc). Nên GOM các text block;
  // result chỉ dùng làm dự phòng nếu không có text nào.
  const textChunks: string[] = [];
  let resultText = '';
  for await (const message of query({ prompt, options })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          const t = block.text.trim();
          textChunks.push(t);
          onEvent?.(t);
        }
      }
    } else if (message.type === 'result' && message.subtype === 'success') {
      resultText = message.result.trim();
    }
  }

  const knowledge = textChunks.length ? textChunks.join('\n\n') : resultText;
  if (!knowledge) throw new Error('Agent không quét được thông tin từ repo.');
  return knowledge;
}

/**
 * Xem CẤU TRÚC dự án ở `cwd` (chỉ đọc, KHÔNG lưu file). Trả mô tả markdown để hiển thị.
 * onEvent nhận log tiến độ. Khác generateProfile: không ghi generated-profiles/.
 */
export function analyzeStructure(
  cwd: string,
  onEvent?: (msg: string) => void,
): Promise<string> {
  return scanRepoKnowledge(cwd, STRUCTURE_PROMPT, onEvent);
}

/**
 * Sinh profile cho repo ở `cwd`. Trả {name, file, knowledge}.
 * onEvent (tùy chọn) nhận log tiến độ.
 */
export async function generateProfile(
  cwd: string,
  onEvent?: (msg: string) => void,
): Promise<GenerateResult> {
  const knowledge = await scanRepoKnowledge(cwd, SCAN_PROMPT, onEvent);

  const name = profileNameFromCwd(cwd);
  await mkdir(GENERATED_DIR, { recursive: true });
  const file = join(GENERATED_DIR, `${name}.md`);
  const header = `# Profile tự sinh cho repo: ${cwd}\n<!-- Sinh tự động bởi bow-agent. Có thể chỉnh tay. -->\n\n`;
  await writeFile(file, header + knowledge, 'utf8');

  return { name, file, knowledge };
}
