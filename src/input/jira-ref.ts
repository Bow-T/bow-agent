/**
 * Bóc tách một tham chiếu Jira từ text người dùng nhập — chấp nhận cả URL lẫn key thuần.
 *
 * Nhận diện:
 *   PROJ-123                                         → ticket
 *   https://x.atlassian.net/browse/PROJ-123          → ticket
 *   .../jira/software/projects/PROJ/boards/123     → board (project PROJ, board 123)
 *   .../projects/PROJ                               → project
 *   .../projects/PROJ/boards/123?selectedIssue=PROJ-5 → board + ticket
 */

export interface JiraRef {
  /** Ticket key nếu bóc được (vd PROJ-123). */
  ticketKey?: string;
  /** Project key nếu bóc được (vd PROJ). */
  projectKey?: string;
  /** Board id nếu bóc được (vd 123). */
  boardId?: string;
  /** Loại tham chiếu chính. */
  kind: 'ticket' | 'board' | 'project' | 'none';
}

const TICKET_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const PROJECT_RE = /\/projects\/([A-Z][A-Z0-9]+)/i;
const BOARD_RE = /\/boards\/(\d+)/;
const SELECTED_ISSUE_RE = /[?&]selectedIssue=([A-Z][A-Z0-9]+-\d+)/i;

/** Bóc tách. Trả kind='none' nếu không nhận ra gì. */
export function parseJiraRef(raw: string): JiraRef {
  const input = raw.trim();
  if (!input) return { kind: 'none' };

  const ref: JiraRef = { kind: 'none' };

  // Ticket có thể nằm trong query (?selectedIssue=) hoặc /browse/KEY hoặc key thuần.
  const selected = input.match(SELECTED_ISSUE_RE);
  const ticket = selected ?? input.match(TICKET_RE);
  if (ticket) ref.ticketKey = ticket[1].toUpperCase();

  const project = input.match(PROJECT_RE);
  if (project) ref.projectKey = project[1].toUpperCase();

  const board = input.match(BOARD_RE);
  if (board) ref.boardId = board[1];

  // Nếu có project trong URL mà chưa có projectKey từ ticket, và ticket có prefix → suy ra.
  if (!ref.projectKey && ref.ticketKey) {
    ref.projectKey = ref.ticketKey.split('-')[0];
  }

  // Xác định kind chính (ưu tiên ticket > board > project).
  if (ref.ticketKey) ref.kind = 'ticket';
  else if (ref.boardId) ref.kind = 'board';
  else if (ref.projectKey) ref.kind = 'project';

  return ref;
}
