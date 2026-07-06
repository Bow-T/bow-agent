import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseJiraRef } from './jira-ref.js';

/**
 * Chuẩn hóa "đầu vào công việc" cho agent về một khối văn bản (task brief).
 * Nguồn: Jira (URL/key), file WBS/tài liệu, text trực tiếp. Có thể kết hợp.
 * (Ảnh xử lý riêng ở runner vì cần đưa qua content block vision.)
 */

export interface TaskInput {
  /** Tham chiếu Jira: chấp nhận cả URL (ví dụ: /projects/PROJ/boards/123) lẫn key thuần. */
  jiraRef?: string;
  /** Đường dẫn các file WBS / tài liệu (markdown/text), nếu có. */
  docPaths?: string[];
  /** Nội dung tài liệu đã đọc sẵn (vd từ upload web), kèm tên. */
  docs?: { name: string; content: string }[];
  /** Mô tả task trực tiếp bằng text, nếu có. */
  text?: string;
  /** Có ảnh đính kèm không (để nhắc agent nhìn ảnh). Nội dung ảnh đưa ở runner. */
  imageCount?: number;
}

/** Đọc file tài liệu; ném lỗi rõ ràng nếu không đọc được. */
async function readDoc(path: string): Promise<string> {
  const abs = resolve(path);
  try {
    return await readFile(abs, 'utf8');
  } catch (err) {
    throw new Error(`Không đọc được file "${abs}": ${(err as Error).message}`);
  }
}

/**
 * Ghép các nguồn đầu vào thành một task brief hoàn chỉnh.
 * Trả null nếu không có nguồn nào (caller báo lỗi usage).
 */
export async function buildTaskBrief(input: TaskInput): Promise<string | null> {
  const sections: string[] = [];

  // Jira: bóc URL/key thành ticket/board/project rồi hướng dẫn agent đọc đúng.
  let activeJiraRef = input.jiraRef;
  if (!activeJiraRef && input.text) {
    const parsed = parseJiraRef(input.text);
    if (parsed.kind !== 'none') {
      activeJiraRef = input.text;
    }
  }

  if (activeJiraRef) {
    const ref = parseJiraRef(activeJiraRef);
    if (ref.kind === 'ticket' && ref.ticketKey) {
      sections.push(
        `## Jira ticket: ${ref.ticketKey}\n` +
          `→ Dùng \`get_issue\` (và \`get_comments\` nếu cần) đọc chi tiết trước khi làm.`,
      );
    } else if (ref.kind === 'board' && ref.boardId) {
      sections.push(
        `## Jira board: ${ref.boardId}${ref.projectKey ? ` (project ${ref.projectKey})` : ''}\n` +
          `→ Dùng \`list_board_issues\` với boardId=${ref.boardId} để xem các task, rồi hỏi tôi chọn task nào (hoặc làm theo yêu cầu text kèm theo).`,
      );
    } else if (ref.kind === 'project' && ref.projectKey) {
      sections.push(
        `## Jira project: ${ref.projectKey}\n→ Chưa rõ ticket cụ thể — hỏi tôi ticket/board cần làm.`,
      );
    } else {
      sections.push(`## Jira (không bóc được ref rõ ràng từ: ${activeJiraRef})`);
    }
  }

  // Tài liệu từ đường dẫn file.
  for (const p of input.docPaths ?? []) {
    const content = await readDoc(p);
    sections.push(`## Tài liệu (${p})\n\n${content.trim()}`);
  }

  // Tài liệu đã đọc sẵn (upload web).
  for (const d of input.docs ?? []) {
    sections.push(`## Tài liệu: ${d.name}\n\n${d.content.trim()}`);
  }

  if (input.text) {
    sections.push(`## Yêu cầu trực tiếp\n\n${input.text.trim()}`);
  }

  if (input.imageCount && input.imageCount > 0) {
    sections.push(
      `## Ảnh đính kèm\nCó ${input.imageCount} ảnh (wireframe/screenshot) — hãy xem kỹ ảnh để hiểu yêu cầu UI/bug.`,
    );
  }

  if (sections.length === 0) return null;
  return sections.join('\n\n---\n\n');
}
