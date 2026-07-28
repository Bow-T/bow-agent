import { existsSync, readFileSync } from 'node:fs';
import { config } from '../config/env.js';

/**
 * GỌI JIRA REST TRỰC TIẾP cho dashboard sprint-scan — để LIỆT KÊ sprint và ticket mà KHÔNG
 * phải khởi động cả agent (agent đắt + chậm). Dùng chung cơ chế auth với input/jira-attachments.ts
 * (Basic auth từ ~/.bow-agent/mcp.json → JIRA_BASE_URL/EMAIL/API_TOKEN). Chỉ ĐỌC (GET) — chọn
 * sprint/ticket là bước người dùng quyết, việc GHI (fix/comment/assign) vẫn do agent qua cổng an toàn.
 *
 * Vì sao cần: người dùng muốn TỰ chọn sprint (không để agent tự lấy "active") và DUYỆT từng ticket
 * trước khi cho làm. Muốn vậy dashboard phải tự lấy được danh sách sprint/ticket — đây là module đó.
 */

export interface JiraAuth {
  baseUrl: string;
  email: string;
  token: string;
}

/** Đọc auth Jira từ mcpServers.<*jira*>.env của file MCP chung. Null nếu thiếu. */
export function readJiraAuth(): JiraAuth | null {
  const file = config.mcpConfigPath;
  if (!existsSync(file)) return null;
  let data: { mcpServers?: Record<string, { env?: Record<string, string> }> };
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  for (const [name, cfg] of Object.entries(data.mcpServers ?? {})) {
    if (!name.toLowerCase().includes('jira')) continue;
    const env = cfg?.env ?? {};
    const baseUrl = env.JIRA_BASE_URL?.replace(/\/+$/, '');
    const email = env.JIRA_EMAIL;
    const token = env.JIRA_API_TOKEN;
    if (baseUrl && email && token) return { baseUrl, email, token };
  }
  return null;
}

function authHeader(a: JiraAuth): string {
  return 'Basic ' + Buffer.from(`${a.email}:${a.token}`).toString('base64');
}

const TIMEOUT_MS = 15_000;

/** GET JSON từ Jira với auth + timeout. Ném lỗi rõ ràng nếu HTTP lỗi. */
async function getJson<T>(auth: JiraAuth, path: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${auth.baseUrl}${path}`, {
      headers: { Authorization: authHeader(auth), Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`Jira ${res.status} ${res.statusText} khi GET ${path}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface JiraBoard {
  id: number;
  name: string;
  type: string;
}

export interface JiraSprint {
  id: number;
  name: string;
  state: 'active' | 'future' | 'closed' | string;
  startDate?: string;
  endDate?: string;
  boardId?: number;
}

export interface JiraIssueBrief {
  key: string;
  summary: string;
  issueType: string;
  status: string;
  assignee: string | null;
  reporter: string | null;
  priority: string | null;
}

/** Tìm các board (Scrum) của một project — cần board id để lấy sprint. */
export async function listBoards(projectKey: string): Promise<JiraBoard[]> {
  const auth = readJiraAuth();
  if (!auth) throw new Error('Chưa cấu hình Jira MCP (~/.bow-agent/mcp.json).');
  const data = await getJson<{ values: JiraBoard[] }>(
    auth,
    `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}`,
  );
  return data.values ?? [];
}

/**
 * Liệt kê sprint của project: active + future + gần đây (closed). Gom từ mọi board Scrum.
 * Sắp: active trước, rồi future, rồi closed (mới nhất trước). Bỏ trùng theo sprint id.
 */
export async function listSprints(projectKey: string): Promise<JiraSprint[]> {
  const auth = readJiraAuth();
  if (!auth) throw new Error('Chưa cấu hình Jira MCP (~/.bow-agent/mcp.json).');
  const boards = await listBoards(projectKey);
  const scrumBoards = boards.filter((b) => b.type === 'scrum');
  if (scrumBoards.length === 0) return [];

  const byId = new Map<number, JiraSprint>();
  for (const board of scrumBoards) {
    try {
      const data = await getJson<{ values: JiraSprint[] }>(
        auth,
        `/rest/agile/1.0/board/${board.id}/sprint?state=active,future,closed&maxResults=50`,
      );
      for (const s of data.values ?? []) {
        if (!byId.has(s.id)) byId.set(s.id, { ...s, boardId: board.id });
      }
    } catch {
      /* board lỗi (không có sprint / quyền) — bỏ qua, board khác vẫn chạy */
    }
  }
  const order = (st: string): number => (st === 'active' ? 0 : st === 'future' ? 1 : 2);
  return [...byId.values()].sort((a, b) => {
    const d = order(a.state) - order(b.state);
    if (d !== 0) return d;
    // Trong cùng nhóm: mới nhất trước (theo startDate nếu có, ngược lại theo id).
    return (b.startDate ?? '').localeCompare(a.startDate ?? '') || b.id - a.id;
  });
}

/** Liệt kê issue trong một sprint (id) — để người dùng duyệt từng ticket. */
export async function listSprintIssues(sprintId: number): Promise<JiraIssueBrief[]> {
  const auth = readJiraAuth();
  if (!auth) throw new Error('Chưa cấu hình Jira MCP (~/.bow-agent/mcp.json).');
  const fields = 'summary,issuetype,status,assignee,reporter,priority';
  const data = await getJson<{ issues: RawIssue[] }>(
    auth,
    `/rest/agile/1.0/sprint/${sprintId}/issue?fields=${fields}&maxResults=100`,
  );
  return (data.issues ?? []).map((i) => ({
    key: i.key,
    summary: i.fields.summary ?? '',
    issueType: i.fields.issuetype?.name ?? '',
    status: i.fields.status?.name ?? '',
    assignee: i.fields.assignee?.displayName ?? null,
    reporter: i.fields.reporter?.displayName ?? null,
    priority: i.fields.priority?.name ?? null,
  }));
}

interface RawIssue {
  key: string;
  fields: {
    summary?: string;
    issuetype?: { name?: string };
    status?: { name?: string };
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    priority?: { name?: string } | null;
  };
}
