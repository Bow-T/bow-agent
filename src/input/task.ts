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
  /**
   * Tên các ảnh TẢI ĐƯỢC từ ticket Jira (đã đính kèm vào images[] ở runner) — liệt kê
   * trong brief để agent biết "ảnh nào là của ticket". Caller tải qua fetchJiraTicketImages.
   */
  jiraImageNames?: string[];
  /** Tên các ảnh của ticket Jira tải HỤT — báo placeholder để agent biết có mà chưa xem được. */
  jiraImageFailed?: string[];
  /**
   * Video ticket Jira đã tải về đĩa (đường dẫn) — agent dùng skill /watch để xem. Khác ảnh,
   * video không đưa thẳng vào context; caller tải qua fetchJiraTicketVideos.
   */
  jiraVideos?: { filename: string; path: string }[];
  /** Video ticket bị bỏ qua vì quá lớn (tên + MB) — báo để agent biết có mà chưa xem. */
  jiraVideosSkipped?: { filename: string; sizeMb: number }[];
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
          `→ Dùng tool Jira (MCP) để đọc chi tiết ticket này (summary, mô tả, acceptance ` +
          `criteria) và các comment quan trọng, TRƯỚC khi lập kế hoạch/làm.`,
      );
    } else if (ref.kind === 'board' && ref.boardId) {
      sections.push(
        `## Jira board: ${ref.boardId}${ref.projectKey ? ` (project ${ref.projectKey})` : ''}\n` +
          `→ Dùng tool Jira (MCP) để liệt kê các issue trên board ${ref.boardId}, rồi hỏi ` +
          `tôi chọn task nào (hoặc làm theo yêu cầu text kèm theo).`,
      );
    } else if (ref.kind === 'project' && ref.projectKey) {
      sections.push(
        `## Jira project: ${ref.projectKey}\n→ Chưa rõ ticket cụ thể — hỏi tôi ticket/board cần làm.`,
      );
    } else {
      sections.push(`## Jira (không bóc được ref rõ ràng từ: ${activeJiraRef})`);
    }

    // Ảnh đính kèm ticket (mockup/screenshot/ảnh lỗi) — đã được caller tải và đưa vào
    // images[] ở runner. Ở đây chỉ LIỆT KÊ để agent biết ảnh nào thuộc ticket, và báo
    // ảnh nào tải hụt (agent biết có ảnh mà chưa xem được → có thể nhờ người dùng gửi lại).
    const jiraImgNames = input.jiraImageNames ?? [];
    const jiraImgFailed = input.jiraImageFailed ?? [];
    if (jiraImgNames.length > 0 || jiraImgFailed.length > 0) {
      const lines: string[] = ['## Ảnh trong ticket Jira'];
      if (jiraImgNames.length > 0) {
        lines.push(
          `Ticket có ${jiraImgNames.length} ảnh (ĐÃ đính kèm ở cuối tin nhắn này — hãy XEM KỸ ` +
            `để hiểu yêu cầu UI/luồng/bug): ${jiraImgNames.map((n) => `\`${n}\``).join(', ')}.`,
        );
      }
      if (jiraImgFailed.length > 0) {
        lines.push(
          `⚠️ ${jiraImgFailed.length} ảnh KHÔNG tải được: ${jiraImgFailed
            .map((n) => `\`${n}\``)
            .join(', ')}. Nếu cần nội dung các ảnh này, hãy nhờ người dùng gửi trực tiếp.`,
        );
      }
      sections.push(lines.join('\n'));
    }

    // Video đính kèm ticket (thường là screen recording quay lại bug). Claude KHÔNG xem
    // video trực tiếp — dùng skill /watch (tách frame + transcript). Caller đã tải video về
    // đĩa; ở đây hướng dẫn agent gọi /watch trên đường dẫn đó. Xem DESIGN §7.2.
    const jiraVideos = input.jiraVideos ?? [];
    const jiraVideosSkipped = input.jiraVideosSkipped ?? [];
    if (jiraVideos.length > 0 || jiraVideosSkipped.length > 0) {
      const lines: string[] = ['## Video trong ticket Jira'];
      for (const v of jiraVideos) {
        lines.push(
          `- Video \`${v.filename}\` đã tải về: \`${v.path}\`\n` +
            `  → Để XEM nội dung video này, dùng skill \`/watch ${v.path}\` (nó tách frame + ` +
            `transcript rồi bạn Read từng frame). Cần thiết khi video là screen recording mô tả bug.`,
        );
      }
      for (const v of jiraVideosSkipped) {
        lines.push(
          `- ⚠️ Video \`${v.filename}\` (${v.sizeMb}MB) QUÁ LỚN nên chưa tải tự động. Nếu cần ` +
            `xem, hỏi người dùng hoặc tải thủ công rồi dùng \`/watch <đường-dẫn>\`.`,
        );
      }
      sections.push(lines.join('\n'));
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
