import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from '../config/env.js';

/**
 * Jira REST v3 client + MCP tools. Đọc issue, đọc comment, ghi comment, tạo subtask.
 * Auth bằng Basic (email:apiToken) theo chuẩn Atlassian Cloud.
 *
 * Chỉ nối được khi JIRA_* đã cấu hình trong .env — nếu chưa, buildJiraServer()
 * trả null và agent chạy không có Jira (vẫn nhận WBS/đề tài qua file/prompt).
 */

function authHeader(): string {
  const { email, apiToken } = config.jira;
  const token = Buffer.from(`${email}:${apiToken}`).toString('base64');
  return `Basic ${token}`;
}

async function jiraFetch(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${config.jira.baseUrl}/rest/api/3${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Jira ${res.status} ${res.statusText} cho ${path}: ${body.slice(0, 500)}`);
  }
  return body ? JSON.parse(body) : {};
}

/** Chuyển plain text → Atlassian Document Format (ADF) tối thiểu cho comment/description. */
function toADF(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

/** Trích plain text từ ADF (description/comment trả về dạng ADF lồng nhau). */
function fromADF(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text' && typeof n.text === 'string') return n.text;
  if (Array.isArray(n.content)) {
    const parts = n.content.map(fromADF);
    // paragraph/heading → xuống dòng; inline → nối liền
    return n.type === 'paragraph' || n.type === 'heading'
      ? parts.join('') + '\n'
      : parts.join('');
  }
  return '';
}

// ─── Tools ────────────────────────────────────────────────────────────────

const getIssue = tool(
  'get_issue',
  'Đọc chi tiết một Jira issue (ticket): summary, description, status, type, assignee, và acceptance criteria nếu có trong description. Dùng để hiểu task cần làm.',
  { issueKey: z.string().describe('Mã ticket, vd: PROJ-123') },
  async ({ issueKey }) => {
    const data = (await jiraFetch(
      `/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,issuetype,assignee,priority,labels,parent`,
    )) as {
      fields: {
        summary?: string;
        description?: unknown;
        status?: { name?: string };
        issuetype?: { name?: string };
        assignee?: { displayName?: string };
        priority?: { name?: string };
        labels?: string[];
        parent?: { key?: string };
      };
    };
    const f = data.fields;
    const summary = [
      `Key: ${issueKey}`,
      `Summary: ${f.summary ?? '(none)'}`,
      `Type: ${f.issuetype?.name ?? '?'}  |  Status: ${f.status?.name ?? '?'}  |  Priority: ${f.priority?.name ?? '?'}`,
      f.parent?.key ? `Parent: ${f.parent.key}` : undefined,
      f.assignee?.displayName ? `Assignee: ${f.assignee.displayName}` : undefined,
      f.labels?.length ? `Labels: ${f.labels.join(', ')}` : undefined,
      '',
      'Description:',
      fromADF(f.description).trim() || '(no description)',
    ]
      .filter((l) => l !== undefined)
      .join('\n');
    return { content: [{ type: 'text', text: summary }] };
  },
  { annotations: { readOnlyHint: true, openWorldHint: true } },
);

const getComments = tool(
  'get_comments',
  'Đọc các comment của một Jira issue — hữu ích để lấy thêm ngữ cảnh, feedback từ QC/BA.',
  { issueKey: z.string().describe('Mã ticket, vd: PROJ-123') },
  async ({ issueKey }) => {
    const data = (await jiraFetch(
      `/issue/${encodeURIComponent(issueKey)}/comment?maxResults=50`,
    )) as { comments?: Array<{ author?: { displayName?: string }; body?: unknown; created?: string }> };
    const comments = data.comments ?? [];
    if (comments.length === 0) {
      return { content: [{ type: 'text', text: '(no comments)' }] };
    }
    const text = comments
      .map(
        (c) =>
          `— ${c.author?.displayName ?? '?'} (${c.created?.slice(0, 10) ?? ''}):\n${fromADF(c.body).trim()}`,
      )
      .join('\n\n');
    return { content: [{ type: 'text', text }] };
  },
  { annotations: { readOnlyHint: true, openWorldHint: true } },
);

const addComment = tool(
  'add_comment',
  'Ghi một comment vào Jira issue. Dùng để log tiến độ, ghi chú kỹ thuật, hoặc trả lời QC. Đây là thao tác GHI — sẽ được duyệt trước khi thực thi.',
  {
    issueKey: z.string().describe('Mã ticket, vd: PROJ-123'),
    body: z.string().describe('Nội dung comment (plain text, hỗ trợ xuống dòng)'),
  },
  async ({ issueKey, body }) => {
    await jiraFetch(`/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: toADF(body) }),
    });
    return { content: [{ type: 'text', text: `Đã thêm comment vào ${issueKey}.` }] };
  },
  { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
);

const createSubtask = tool(
  'create_subtask',
  'Tạo một subtask dưới một issue cha. Dùng khi cần tách task lớn thành các phần nhỏ. Đây là thao tác GHI — sẽ được duyệt trước khi thực thi.',
  {
    parentKey: z.string().describe('Mã issue cha, vd: PROJ-123'),
    projectKey: z.string().describe('Mã project, vd: PROJ'),
    summary: z.string().describe('Tiêu đề subtask (ngắn gọn)'),
    description: z.string().optional().describe('Mô tả subtask (tùy chọn)'),
  },
  async ({ parentKey, projectKey, summary, description }) => {
    const fields: Record<string, unknown> = {
      project: { key: projectKey },
      parent: { key: parentKey },
      summary,
      issuetype: { name: 'Sub-task' },
    };
    if (description) fields.description = toADF(description);
    const data = (await jiraFetch('/issue', {
      method: 'POST',
      body: JSON.stringify({ fields }),
    })) as { key?: string };
    return { content: [{ type: 'text', text: `Đã tạo subtask ${data.key} dưới ${parentKey}.` }] };
  },
  { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
);

const listBoardIssues = tool(
  'list_board_issues',
  'Liệt kê các issue trên một Jira board (theo board id). Dùng khi người dùng dán URL board (vd /projects/PROJ/boards/123) để xem có task gì.',
  {
    boardId: z.string().describe('Board id, vd: 1795'),
    max: z.number().optional().describe('Số lượng tối đa (mặc định 30)'),
  },
  async ({ boardId, max }) => {
    // Jira Agile API dùng base /rest/agile/1.0, không phải /rest/api/3.
    const url = `${config.jira.baseUrl}/rest/agile/1.0/board/${encodeURIComponent(boardId)}/issue?maxResults=${max ?? 30}&fields=summary,status,issuetype,assignee`;
    const res = await fetch(url, {
      headers: { Authorization: authHeader(), Accept: 'application/json' },
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Jira board ${boardId} lỗi ${res.status}: ${body.slice(0, 400)}`);
    }
    const data = JSON.parse(body) as {
      issues?: Array<{
        key: string;
        fields: {
          summary?: string;
          status?: { name?: string };
          issuetype?: { name?: string };
          assignee?: { displayName?: string };
        };
      }>;
    };
    const issues = data.issues ?? [];
    if (issues.length === 0) return { content: [{ type: 'text', text: 'Board không có issue nào.' }] };
    const text = issues
      .map(
        (i) =>
          `${i.key} · [${i.fields.status?.name ?? '?'}] ${i.fields.issuetype?.name ?? ''} — ${i.fields.summary ?? ''}${i.fields.assignee?.displayName ? ` (${i.fields.assignee.displayName})` : ''}`,
      )
      .join('\n');
    return { content: [{ type: 'text', text: `Board ${boardId} — ${issues.length} issue:\n${text}` }] };
  },
  { annotations: { readOnlyHint: true, openWorldHint: true } },
);

const searchIssues = tool(
  'search_issues',
  'Tìm issue bằng JQL — linh hoạt cho báo cáo sprint (lọc theo sprint/status/assignee/updated). Dùng khi PM cần đối chiếu tiến độ (To Do/In Progress/Done) hoặc tìm blocker.',
  {
    jql: z
      .string()
      .describe(
        'Câu JQL, vd: project = PROJ AND sprint in openSprints() ORDER BY status. Hoặc: assignee = "developer" AND status = "In Progress".',
      ),
    max: z.number().optional().describe('Số lượng tối đa (mặc định 50)'),
  },
  async ({ jql, max }) => {
    const data = (await jiraFetch(
      `/search?jql=${encodeURIComponent(jql)}&maxResults=${max ?? 50}&fields=summary,status,issuetype,assignee,updated`,
    )) as {
      total?: number;
      issues?: Array<{
        key: string;
        fields: {
          summary?: string;
          status?: { name?: string };
          issuetype?: { name?: string };
          assignee?: { displayName?: string };
          updated?: string;
        };
      }>;
    };
    const issues = data.issues ?? [];
    if (issues.length === 0) return { content: [{ type: 'text', text: `Không có issue khớp JQL: ${jql}` }] };
    const text = issues
      .map(
        (i) =>
          `${i.key} · [${i.fields.status?.name ?? '?'}] ${i.fields.issuetype?.name ?? ''} — ${i.fields.summary ?? ''}${i.fields.assignee?.displayName ? ` (${i.fields.assignee.displayName})` : ''} · cập nhật ${i.fields.updated?.slice(0, 10) ?? ''}`,
      )
      .join('\n');
    return {
      content: [
        { type: 'text', text: `Tìm thấy ${data.total ?? issues.length} issue (hiện ${issues.length}):\n${text}` },
      ],
    };
  },
  { annotations: { readOnlyHint: true, openWorldHint: true } },
);

/**
 * Build MCP server chứa các Jira tool. Trả null nếu Jira chưa cấu hình
 * (agent sẽ chạy mà không có Jira — vẫn nhận task qua WBS file / prompt).
 */
export function buildJiraServer() {
  if (!config.jiraConfigured) return null;
  return createSdkMcpServer({
    name: 'jira',
    version: '1.0.0',
    tools: [getIssue, getComments, listBoardIssues, searchIssues, addComment, createSubtask],
  });
}

/** Tên đầy đủ của các tool GHI Jira — để gate duyệt (không auto-approve). */
export const JIRA_WRITE_TOOLS = ['mcp__jira__add_comment', 'mcp__jira__create_subtask'];
/** Tên đầy đủ của các tool ĐỌC Jira — an toàn để auto-approve. */
export const JIRA_READ_TOOLS = [
  'mcp__jira__get_issue',
  'mcp__jira__get_comments',
  'mcp__jira__list_board_issues',
  'mcp__jira__search_issues',
];
