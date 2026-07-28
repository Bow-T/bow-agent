import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * ĐỊNH TUYẾN QC cho sprint-scan.
 *
 * Bài toán: agent tự quét sprint, khi làm xong một bug/task cần "assign đúng QC" và
 * "hỏi QC nếu không hiểu". Muốn vậy phải biết AI là QC cho phần việc nào. Đây là đề xuất
 * (bạn chọn "chưa có, cần tôi đề xuất") — dùng MỘT file map đơn giản, kiểm soát được,
 * KHÔNG suy đoán ngầm từ lịch sử ticket (dễ assign nhầm người rồi tự commit — không rollback).
 *
 * File: ~/.bow-agent/qc-routing.json  (override qua BOW_QC_ROUTING). Ngoài repo → không lộ
 * tên/nick nội bộ vào git. Cùng chỗ với mcp.json / registry.json cho nhất quán.
 *
 * Cấu trúc:
 * {
 *   "default": { "qcAccountId": "5f…", "askVia": "jira-comment" },
 *   "components": {
 *     "express-delivery": { "qcAccountId": "5f…", "displayName": "QC Lan",  "askVia": "jira-comment" },
 *     "payment":          { "qcAccountId": "6a…", "displayName": "QC Minh", "askVia": "slack:#qc-payment" }
 *   },
 *   "labels": {
 *     "regression": { "qcAccountId": "5f…" }
 *   }
 * }
 *
 * Ưu tiên khớp: components[<component>] > labels[<label>] > default. Agent nhận map này ở
 * dạng CHỈ DẪN trong brief — nó tự quyết assignee + kênh hỏi, ta không hardcode luồng.
 */

export interface QcTarget {
  /** accountId Jira của QC — để agent gán assignee/reporter chính xác (không đoán theo tên). */
  qcAccountId?: string;
  /** Tên hiển thị (chỉ để log/brief cho người đọc; assign vẫn dùng accountId). */
  displayName?: string;
  /**
   * Kênh "hỏi QC khi không hiểu":
   *  - 'jira-comment'  : comment @mention QC ngay trên ticket (mặc định — không cần tích hợp thêm).
   *  - 'slack:#kênh'   : nếu sau này nối Slack MCP; hiện chỉ ghi chú, agent vẫn fallback comment.
   */
  askVia?: string;
}

export interface QcRouting {
  default?: QcTarget;
  components?: Record<string, QcTarget>;
  labels?: Record<string, QcTarget>;
}

/** Đường dẫn file routing (ngoài repo, cạnh mcp.json). Override qua BOW_QC_ROUTING. */
export function qcRoutingPath(): string {
  return process.env.BOW_QC_ROUTING || join(homedir(), '.bow-agent', 'qc-routing.json');
}

/** Đọc map routing. Trả object rỗng (không ném) nếu file thiếu/hỏng — sprint-scan vẫn chạy. */
export function loadQcRouting(): QcRouting {
  const file = qcRoutingPath();
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as QcRouting;
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/**
 * Render map routing thành một khối chỉ dẫn tiếng Việt nhồi vào brief. Agent đọc để tự
 * quyết assignee + kênh hỏi. Trả '' nếu map rỗng → brief báo "chưa cấu hình QC routing".
 */
export function renderQcRoutingBrief(routing: QcRouting): string {
  const hasAny =
    routing.default ||
    (routing.components && Object.keys(routing.components).length) ||
    (routing.labels && Object.keys(routing.labels).length);

  // Chiến lược MẶC ĐỊNH (không cần file config): HỎI/ASSIGN CHÍNH REPORTER của ticket.
  // Người tạo bug biết rõ nhất cách tái hiện → hỏi họ chuẩn hơn map component→QC tĩnh.
  const reporterStrategy =
    '## Định tuyến QC — HỎI CHÍNH NGƯỜI TẠO TICKET (reporter)\n' +
    'Với MỖI ticket, người phụ trách QC = **reporter của chính ticket đó** (người report bug ' +
    'biết rõ cách tái hiện nhất). Cách làm:\n' +
    '- Đọc field `reporter` (accountId + tên) khi lấy chi tiết ticket.\n' +
    '- Khi "không hiểu" (thiếu bước tái hiện, AC mơ hồ, ảnh/video không rõ): comment @mention ' +
    'ĐÚNG reporter đó ngay trên ticket, hỏi cụ thể cái còn thiếu — ĐỪNG đoán rồi sửa bừa.\n' +
    '- Khi cần chuyển ticket lại cho QC xác nhận (sau khi fix): đổi assignee về reporter và ' +
    'transition sang trạng thái chờ QC (nếu được bật --assign).\n' +
    '- Nếu ticket KHÔNG có reporter (hiếm): giữ nguyên assignee và ghi chú trong tổng kết.';

  if (!hasAny) return reporterStrategy;

  // CÓ file config → dùng làm OVERRIDE cho vài component/label đặc biệt, phần còn lại vẫn
  // theo reporter. (Ví dụ: muốn ép mọi bug 'payment' về một QC chuyên trách bất kể reporter.)
  const lines: string[] = [
    reporterStrategy,
    '',
    '### Override (ép QC khác cho một số component/label — ưu tiên hơn reporter)',
  ];
  const fmt = (t: QcTarget): string => {
    const parts: string[] = [];
    if (t.qcAccountId) parts.push(`accountId=\`${t.qcAccountId}\``);
    if (t.displayName) parts.push(`tên="${t.displayName}"`);
    parts.push(`hỏi qua=${t.askVia || 'jira-comment'}`);
    return parts.join(', ');
  };

  if (routing.default) lines.push(`- Mặc định: ${fmt(routing.default)}`);
  for (const [comp, t] of Object.entries(routing.components ?? {})) {
    lines.push(`- Component \`${comp}\`: ${fmt(t)}`);
  }
  for (const [label, t] of Object.entries(routing.labels ?? {})) {
    lines.push(`- Label \`${label}\`: ${fmt(t)}`);
  }

  lines.push(
    '\nQuy tắc khớp: component > label > mặc định. Khi assign QC, dùng ĐÚNG accountId ở trên ' +
      '(qua tool Jira set assignee). Khi "không hiểu" một ticket (thiếu bước tái hiện, AC mơ hồ, ' +
      'ảnh/video không rõ), HỎI QC tương ứng qua kênh ghi trên — mặc định là comment @mention trên ' +
      'chính ticket đó — thay vì tự suy diễn rồi sửa bừa.',
  );
  return lines.join('\n');
}
