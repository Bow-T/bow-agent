import express from 'express';
import http from 'node:http';
import cors from 'cors';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { config, loadActiveProfileToken } from '../config/env.js';
import { runAgent, fetchUsageSnapshot, type RunOptions } from '../core/runner.js';
import { buildTaskBrief } from '../input/task.js';
import { pdfToText } from '../input/pdf.js';
import { getProfile } from '../profiles/index.js';
import { detectSource } from '../profiles/detect.js';
import { generateProfile, analyzeStructure } from '../profiles/generate.js';
import { createSession, getSession, removeSession, adminBus } from './session.js';
import {
  requestAccess,
  approveAccess,
  rejectAccess,
  revokeAccess,
  getUserByToken,
  isValidToken,
  listAccessUsers,
  accessBus,
  type AccessUser,
} from './access.js';
import {
  listConversations,
  getConversation,
  upsertConversation,
  renameConversation,
  deleteConversation,
} from './conversations.js';
import {
  listGroups,
  getGroup,
  getOrCreateGroup,
  addMessage,
  normalizeGroupId,
  chatBus,
} from './chat.js';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { loadClaudeCodeMcp, listGlobalMcp, addGlobalMcp, removeGlobalMcp } from '../tools/mcp.js';
import { listUserMcp, addUserMcp, removeUserMcp, loadUserMcpServers } from './userMcp.js';
import { loadRegistry, skillStatus, syncSkills } from '../skills/externalSkills.js';
import { parseJiraRef } from '../input/jira-ref.js';
import { fetchJiraTicketImages, fetchJiraTicketVideos } from '../input/jira-attachments.js';
import {
  listWorkspaces,
  resolveWorkspace,
  addRepoToWorkspace,
  removeRepoFromWorkspace,
  readSharedKnowledge,
  writeSharedKnowledge,
  readFullJournal,
  type Workspace,
} from '../profiles/workspace.js';


const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const activeClients = new Map<string, { lastSeen: Date; userAgent?: string }>();

/** Chuẩn hoá một chuỗi IP: ::1/::ffff:127.0.0.1 → 127.0.0.1, bóc tiền tố ::ffff:. */
function normalizeIp(raw: string): string {
  let ip = (raw || '').trim();
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

/** IP client cho HIỂN THỊ/LOG. Tin x-forwarded-for (lấy IP đầu) để log đúng IP sau proxy.
 *  KHÔNG dùng cho quyết định quyền — header này client tự đặt được. Dùng getSocketIp thay thế. */
function getCleanIp(req: express.Request): string {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (Array.isArray(ip)) ip = ip[0];
  let cleanIp = typeof ip === 'string' ? ip : '';
  if (cleanIp.includes(',')) {
    cleanIp = cleanIp.split(',')[0].trim();
  }
  return normalizeIp(cleanIp);
}

/** IP THẬT của kết nối socket — KHÔNG tin bất kỳ header nào (x-forwarded-for giả mạo được).
 *  Đây là mốc DUY NHẤT để xác định admin (localhost) và ràng buộc access theo IP. Vá lỗ
 *  hổng leo thang: trước đây getCleanIp tin x-forwarded-for nên client LAN gửi
 *  `X-Forwarded-For: 127.0.0.1` là chiếm quyền admin. */
function getSocketIp(req: express.Request): string {
  return normalizeIp(req.socket.remoteAddress || '');
}

app.use((req, res, next) => {
  const cleanIp = getCleanIp(req);
  if (cleanIp) {
    activeClients.set(cleanIp, {
      lastSeen: new Date(),
      userAgent: req.headers['user-agent']
    });
  }
  next();
});

// QC Mode (trước đây "Safe Mode"): QC hỏi đáp read-only NHƯNG mở tool Skill (qc-triage) +
// Jira read/write. Bật qua `npm run ui:qc` (đặt BOW_QC_MODE=true). Runner áp policy trong
// canUseTool (isQcMode). Không còn nhận tên env cũ BOW_SAFE_MODE.
const isQcMode = process.env.BOW_QC_MODE === 'true';
// DEBUG: giả lập hết hạn mức phiên để verify luồng tự-chạy-tiếp mà không cần chờ limit thật.
// BOW_SIMULATE_SESSION_LIMIT=true → LẦN CHẠY ĐẦU của mỗi phiên đang thực thi sẽ tự "hết hạn
// mức" sau ~6s với resetsAt = now + 30s. Auto-resume (lần sau) chạy bình thường tới khi xong.
const simulateSessionLimit = process.env.BOW_SIMULATE_SESSION_LIMIT === 'true';
// Thư mục source cố định cho QC Mode. Cho phép trỏ tới một repo khác (vd monorepo) mà
// không cần chạy server TỪ trong repo đó:
//   BOW_QC_MODE=true BOW_QC_CWD=/path/to/monorepo npm run ui:qc:share
// Mặc định = process.cwd() (thư mục đang chạy server). Admin đổi lúc chạy qua
// POST /api/qc-cwd (không cần restart) → lưu vào qcCwdOverride.
let qcCwdOverride: string | null = null;
const qcCwd = () => resolve(qcCwdOverride || process.env.BOW_QC_CWD || process.cwd());

// Collab Mode: cộng tác viên (CTV) qua LAN code gần như dev, nhưng lệnh HỦY HOẠI
// (rm -rf, deploy, ghi ngoài repo…) phải được ADMIN (localhost) duyệt từ xa. Git
// được tự do. Không đổi được MCP/workspace config (như QC Mode). Khác QC Mode ở
// chỗ: QC = read-only (chỉ mở Skill + Jira); Collab = ghi code được, chỉ gác thao tác nguy hiểm.
//   BOW_COLLAB_MODE=true BOW_COLLAB_CWD=/path/to/repo npm run ui:collab
const isCollabMode = process.env.BOW_COLLAB_MODE === 'true';
// Repo cố định cho Collab (tương tự BOW_QC_CWD). Mặc định = cwd chạy server.
const collabCwd = () => resolve(process.env.BOW_COLLAB_CWD || process.cwd());

// BA Mode: Business Analyst qua LAN. Được ĐỌC toàn bộ repo (hiểu ngữ cảnh) + GHI TÀI LIỆU
// (docs/, *.md/*.txt) + FULL Jira write (tạo/sửa/comment/transition ticket — đầu ra chính
// của BA). NHƯNG bị chặn sửa source code (.ts/.dart/.sql…), ghi DB (execute_sql/migration),
// deploy và lệnh huỷ hoại. Khác QC (read-only + Skill + Jira) và Collab (ghi code tự do): BA
// phân quyền theo ĐÍCH ghi (tài liệu ✅ / source ❌), không theo read-vs-write thuần.
//   BOW_BA_MODE=true BOW_BA_CWD=/path/to/repo npm run ui:ba
const isBaMode = process.env.BOW_BA_MODE === 'true';
// Repo cố định cho BA (tương tự BOW_QC_CWD/BOW_COLLAB_CWD). Admin đổi lúc chạy qua
// POST /api/qc-cwd (gọi tới cổng BA 4003) → lưu vào baCwdOverride, không cần restart.
let baCwdOverride: string | null = null;
const baCwd = () => resolve(baCwdOverride || process.env.BOW_BA_CWD || process.cwd());

// Reviewer Mode: Tech Lead/Reviewer qua LAN. ĐỌC code + review PR GitHub (`gh pr view/diff`) và
// diff branch local (`git diff`), COMMENT/APPROVE PR (`gh pr comment`/`gh pr review`), chạy
// test/analyze, Jira READ (đối chiếu ticket). DENY sửa code / merge / push / deploy. Ép 'plan'
// như QC; policy chi tiết trong runner.canUseTool (isReviewerMode).
//   BOW_REVIEWER_MODE=true BOW_REVIEWER_CWD=/path/to/repo npm run ui:review
const isReviewerMode = process.env.BOW_REVIEWER_MODE === 'true';
// Repo cố định cho Reviewer (tương tự BOW_QC_CWD). Admin đổi lúc chạy qua POST /api/qc-cwd
// (gọi tới cổng Reviewer 4004) → lưu vào reviewerCwdOverride, không cần restart.
let reviewerCwdOverride: string | null = null;
const reviewerCwd = () => resolve(reviewerCwdOverride || process.env.BOW_REVIEWER_CWD || process.cwd());

// DevOps Mode (mode thứ 6): Triển khai & Hạ tầng qua LAN. ĐỌC repo + GHI FILE HẠ TẦNG
// (Dockerfile, docker-compose*, .github/workflows/*, *.tf/*.hcl, k8s/Helm manifests) + tài liệu
// vận hành (*.md), NHƯNG chặn sửa source code ứng dụng (.ts/.dart/.py…). Lệnh DEPLOY/APPLY
// (terraform apply, docker push, kubectl apply…) KHÔNG bị deny cứng mà TREO ADMIN DUYỆT từ xa
// (như Collab) — deploy là việc hợp lệ của vai này, chỉ cần admin xác nhận. Ép 'auto'; policy
// theo target trong runner.canUseTool (isDevOpsMode).
//   BOW_DEVOPS_MODE=true BOW_DEVOPS_CWD=/path/to/repo npm run ui:devops
const isDevOpsMode = process.env.BOW_DEVOPS_MODE === 'true';
// Repo cố định cho DevOps (tương tự BOW_QC_CWD). Admin đổi lúc chạy qua POST /api/qc-cwd
// (gọi tới cổng DevOps 4005) → lưu vào devopsCwdOverride, không cần restart.
let devopsCwdOverride: string | null = null;
const devopsCwd = () => resolve(devopsCwdOverride || process.env.BOW_DEVOPS_CWD || process.cwd());

/**
 * Trả về TẤT CẢ địa chỉ IPv4 LAN của máy (bỏ loopback), đã sắp xếp: IP mạng nội bộ
 * thật (192.168.x / 10.x / 172.16–31.x) lên trước, các dải khác (VPN/Docker/link-local)
 * xuống sau. Máy nhiều card mạng (Wi-Fi + Ethernet + VPN…) sẽ có nhiều host → UI cho
 * người dùng tự chọn/copy đúng cái client LAN dùng để truy cập. Rỗng ⇒ chỉ localhost.
 */
function getLocalIps(): string[] {
  const interfaces = os.networkInterfaces();
  const addrs: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addrs.push(iface.address);
      }
    }
  }
  // Ưu tiên dải mạng LAN riêng tư (RFC1918) — đây gần như luôn là IP client LAN dùng.
  const isPrivate = (ip: string) =>
    /^192\.168\./.test(ip) ||
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return addrs.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}

const logAudit = (message: string, clientIp?: string, username?: string) => {
  try {
    const logDir = join(process.cwd(), 'memory');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const timestamp = new Date().toISOString();
    const userSuffix = username ? ` (User: ${username})` : '';
    const formattedMsg = `[${timestamp}]${userSuffix} ${message}\n`;
    
    // Ghi vào log chung
    const globalLogPath = join(logDir, 'audit_share.log');
    fs.appendFileSync(globalLogPath, formattedMsg);
    
    // Ghi vào log riêng theo IP (nếu có)
    if (clientIp) {
      const safeIp = clientIp.replace(/[^a-zA-Z0-9.-]/g, '_');
      const ipLogPath = join(logDir, `audit_${safeIp}.log`);
      fs.appendFileSync(ipLogPath, formattedMsg);
    }
  } catch (err) {
    console.error('Lỗi ghi log audit:', err);
  }
};

// Chặn đổi cấu hình (MCP/workspace) ở QC/Reviewer/Collab/BA/DevOps Mode — không mode chia sẻ nào
// cho client đổi hạ tầng agent. (QC = read-only + Skill/Jira; Reviewer = read-only + gh pr review;
// Collab = ghi code nhưng khoá config; BA = ghi tài liệu + Jira nhưng khoá config; DevOps = ghi
// file hạ tầng nhưng khoá config agent.)
const checkReadonlyConfig = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (isQcMode || isReviewerMode || isCollabMode || isBaMode || isDevOpsMode) {
    const cleanIp = getCleanIp(req);
    const modeName = isQcMode ? 'QC Mode' : isReviewerMode ? 'Reviewer Mode' : isCollabMode ? 'Collab Mode' : isBaMode ? 'BA Mode' : 'DevOps Mode';
    logAudit(`IP: ${cleanIp} - BỊ CHẶN: Thao tác ${req.method} ${req.originalUrl} bị chặn trong ${modeName}.`, cleanIp);
    res.status(403).json({ error: `Thao tác bị chặn trong chế độ ${modeName} (không đổi được cấu hình).` });
    return;
  }
  next();
};

/** Admin = truy cập từ localhost. Chỉ admin xem/đổi cấu hình LAN, log, chọn source.
 *  Dùng getSocketIp (IP socket THẬT) — KHÔNG tin x-forwarded-for để không bị giả mạo. */
function isAdminReq(req: express.Request): boolean {
  return getSocketIp(req) === '127.0.0.1';
}

/** Middleware chặn mọi request không phải admin (dùng cho API nội bộ LAN Dashboard). */
const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!isAdminReq(req)) {
    res.status(403).json({ error: 'Chỉ Admin (localhost) mới có quyền truy cập.' });
    return;
  }
  next();
};

/** Token client gửi: header 'x-bow-token' (fetch) hoặc query '?token=' (SSE — EventSource
 *  không set được header). Trả '' nếu không có. */
function getReqToken(req: express.Request): string {
  const h = req.headers['x-bow-token'];
  if (typeof h === 'string' && h) return h;
  const q = req.query.token;
  if (typeof q === 'string' && q) return q;
  return '';
}

/** Client này đã được phép chưa: admin (localhost) luôn OK; cổng tắt → OK; còn lại cần
 *  token hợp lệ. */
function isAccessAllowed(req: express.Request): boolean {
  if (isAdminReq(req)) return true;
  return isValidToken(getReqToken(req));
}

function getClientName(req: express.Request): string {
  if (isAdminReq(req)) return 'Admin';
  const token = getReqToken(req);
  const user = getUserByToken(token);
  return user ? user.name : 'Unknown';
}

// ── Cổng duyệt truy cập theo tên (xem access.ts) ──────────────────────────────
// Các route access KHÔNG qua cổng (nếu không client sẽ không bao giờ xin duyệt được).

/** POST /api/access/request — client gửi yêu cầu truy cập kèm tên. */
app.post('/api/access/request', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'Tên không được để trống.' });
    return;
  }
  // Ràng buộc theo IP SOCKET thật (không tin x-forwarded-for) — nếu không, kẻ gửi
  // X-Forwarded-For: <IP nạn nhân> có thể trùng bản ghi approved của người khác (M6).
  const socketIp = getSocketIp(req);
  // Token client tự gửi kèm (nếu đang reload) — để nhận lại đúng bản ghi của chính mình.
  const knownToken = getReqToken(req);
  const user = requestAccess(name, socketIp, knownToken);

  logAudit(`Yêu cầu truy cập mới: Tên="${name}", IP="${socketIp}"`, socketIp, name);
  res.json({ token: user.token, status: user.status });
});

/** GET /api/access/status — client/admin kiểm tra trạng thái quyền truy cập hiện tại. */
app.get('/api/access/status', (req, res) => {
  const isAdmin = isAdminReq(req);
  if (isAdmin) {
    res.json({ allowed: true, isAdmin: true, status: 'approved' });
    return;
  }
  const token = getReqToken(req);
  const user = getUserByToken(token);
  if (!user) {
    res.json({ allowed: false, isAdmin: false, status: 'none' });
    return;
  }
  res.json({
    allowed: user.status === 'approved',
    isAdmin: false,
    status: user.status,
  });
});

/** GET /api/access/users — admin xem danh sách tất cả các thiết bị kết nối. */
app.get('/api/access/users', requireAdmin, (_req, res) => {
  res.json({ users: listAccessUsers() });
});

/** POST /api/access/approve — admin duyệt yêu cầu truy cập. */
app.post('/api/access/approve', requireAdmin, (req, res) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  const ok = approveAccess(id);
  res.json({ ok });
});

/** POST /api/access/reject — admin từ chối yêu cầu truy cập. */
app.post('/api/access/reject', requireAdmin, (req, res) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  const ok = rejectAccess(id);
  res.json({ ok });
});

/** POST /api/access/revoke — admin thu hồi quyền truy cập. */
app.post('/api/access/revoke', requireAdmin, (req, res) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  const ok = revokeAccess(id);
  res.json({ ok });
});

/** GET /api/access/events — SSE kênh realtime cho admin nhận yêu cầu truy cập. */
app.get('/api/access/events', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Phát lại tất cả các yêu cầu đang pending cho admin vừa kết nối
  const pendings = listAccessUsers().filter((u) => u.status === 'pending');
  for (const user of pendings) {
    res.write(`data: ${JSON.stringify({ type: 'access-request', user })}\n\n`);
  }

  const unsubscribe = accessBus.subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on('close', () => {
    unsubscribe();
  });
});

// Middleware cổng: chặn mọi /api/* nghiệp vụ nếu chưa được phép. Đặt SAU các route
// /api/access/* ở trên (chúng đã khớp trước) nên chỉ các route còn lại phải qua cổng.
app.use('/api', (req, res, next) => {
  if (isAccessAllowed(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Cần được Admin phê duyệt để truy cập hệ thống.' });
});

// Phục vụ frontend đã build (dist-web). Trong dev, Vite chạy riêng ở cổng khác.
const webDist = join(__dirname, '..', '..', 'dist-web');
app.use(express.static(webDist));

// ── Auto-resume khi hết hạn mức phiên (5h) ────────────────────────────────────────────
// Khi phiên đang THỰC THI dừng vì "You've hit your session limit · resets HH:MM", ta lên
// lịch tự chạy tiếp: tới giờ reset (+ đệm) resume ĐÚNG phiên cũ (conversationId) và gửi
// lệnh "tiếp tục" để agent làm nốt case dở. Tối đa 3 lần để không lặp triền miên.
// Lịch giữ SERVER-SIDE nên sống qua việc client đóng tab (miễn tiến trình server còn chạy).

/** Thời điểm hiện tại (ms). Gói lại để dễ đọc ở phần tính lịch. */
const nowMs = () => Date.now();

const AUTO_RESUME_MAX_ATTEMPTS = 3;
// Đệm sau giờ reset để chắc chắn hạn mức đã mở lại (tránh gọi sớm vẫn bị chặn). Cho phép
// override qua env để verify nhanh (BOW_AUTO_RESUME_BUFFER_MS=2000). Mặc định 30s.
const AUTO_RESUME_BUFFER_MS = Number(process.env.BOW_AUTO_RESUME_BUFFER_MS ?? 30_000);
// Prompt "tiếp tục" gửi khi resume — ngắn, dựa vào trí nhớ phiên cũ (đã resume conversationId).
const AUTO_RESUME_PROMPT =
  'Phiên trước bị ngắt do hết hạn mức sử dụng. Hãy tiếp tục công việc đang làm dở từ chỗ ' +
  'bạn dừng lại, không cần hỏi lại từ đầu.';

interface ResumeSchedule {
  timer: NodeJS.Timeout;
  retryAt: string;
  sessionId: string;
}
// key = conversationId (session_id THẬT của SDK). Một lịch đang chờ cho mỗi hội thoại.
const resumeSchedules = new Map<string, ResumeSchedule>();

/** Huỷ lịch tự chạy tiếp của một hội thoại (nếu có). Trả true nếu vừa huỷ một lịch. */
function cancelResumeSchedule(conversationId: string): boolean {
  const sched = resumeSchedules.get(conversationId);
  if (!sched) return false;
  clearTimeout(sched.timer);
  resumeSchedules.delete(conversationId);
  return true;
}

/**
 * Tham số đủ để CHẠY LẠI một phiên agent (không gồm callback gắn với session — những cái
 * đó dựng lại mỗi lần chạy). runAgentSession dùng nó cho cả lần chạy đầu lẫn auto-resume.
 */
interface RunParams {
  brief: string;
  cwd: string;
  mode: 'plan' | 'manual' | 'edit-auto' | 'auto';
  collabMode: boolean;
  /** BA Mode: ghi tài liệu + Jira, DENY source/DB/deploy. Xem runner. */
  baMode: boolean;
  /** DevOps Mode: ghi file hạ tầng + docs, DENY source; deploy treo admin duyệt. Xem runner. */
  devopsMode: boolean;
  effort: RunOptions['effort'];
  language: 'vi' | 'en';
  projectProfile?: string;
  images?: { base64: string; mediaType: string }[];
  mcpServers?: string[];
  /** MCP RIÊNG của user (đã resolve kèm token) — overlay lên MCP chung. Rỗng = không có. */
  userMcpServers?: Record<string, McpServerConfig>;
  /** Stack skill external người dùng chọn (id trong registry). Rỗng = chỉ skill nội bộ. */
  stack?: string;
  /** Bật multi-agent (reviewer/verifier/impact-scout). Chỉ admin. Mặc định tắt. */
  useSubagents?: boolean;
  model?: string;
  isExecuting: boolean;
  routeToAdmin: boolean;
  /** Siết duyệt ghi: MỌI thao tác ghi/side-effect phải qua onApproval (→ admin). Bật cho
   *  client KHÔNG phải admin (Collab CTV). Admin localhost = false → auto như cũ. */
  requireApprovalForWrites: boolean;
  cleanIp: string;
  clientName?: string;
  /** Phiên SDK cần resume (undefined ở lần chạy đầu nếu là hội thoại mới). */
  resumeSessionId?: string;
}

/**
 * Chạy agent trên một session web + tự lên lịch chạy tiếp nếu dừng vì hết hạn mức phiên.
 * `attempt` = lần thử hiện tại (0 = lần đầu do người dùng khởi động; 1..N = auto-resume).
 * Chỉ auto-resume khi `isExecuting` (phiên có việc dở đáng làm tiếp — plan/QC thì thôi).
 */
function runAgentSession(session: ReturnType<typeof createSession>, params: RunParams, attempt: number): void {
  // Bắt session_id THẬT của SDK cho lần chạy này. Cần cho auto-resume (resume đúng phiên)
  // và để đăng ký/huỷ lịch theo conversationId. Cập nhật động khi 'init' bắn.
  let conversationId: string | undefined = params.resumeSessionId;
  // Đánh dấu phiên này đã kết thúc bằng lỗi hết hạn mức + giờ reset kèm theo (nếu có).
  let sessionLimitResetsAt: string | null | undefined;
  let hitSessionLimit = false;

  const approvalHandler = params.routeToAdmin
    ? (toolName: string, input: Record<string, unknown>, meta?: { title?: string; description?: string; blockedPath?: string; decisionReason?: string }) => {
        logAudit(`IP: ${params.cleanIp} - COLLAB xin ADMIN duyệt: session=${session.id}, tool=${toolName}`, params.cleanIp, params.clientName);
        return adminBus.requestApproval({
          sessionId: session.id,
          clientIp: params.cleanIp,
          toolName,
          input,
          title: meta?.title,
          description: meta?.description,
          decisionReason: meta?.decisionReason,
        });
      }
    : (toolName: string, input: Record<string, unknown>, meta?: { title?: string; description?: string; blockedPath?: string; decisionReason?: string }) =>
        session.requestApproval(toolName, input, meta);

  runAgent({
    brief: params.brief,
    cwd: params.cwd,
    mode: params.mode,
    collabMode: params.collabMode,
    baMode: params.baMode,
    devopsMode: params.devopsMode,
    requireApprovalForWrites: params.requireApprovalForWrites,
    effort: params.effort,
    language: params.language,
    projectProfile: params.projectProfile,
    images: params.images && params.images.length > 0 ? params.images : undefined,
    mcpServers: params.mcpServers && params.mcpServers.length > 0 ? params.mcpServers : undefined,
    userMcpServers:
      params.userMcpServers && Object.keys(params.userMcpServers).length > 0
        ? params.userMcpServers
        : undefined,
    stack: params.stack || undefined,
    useSubagents: params.useSubagents,
    abortSignal: session.abort.signal,
    onEvent: (ev) => {
      // Bắt lỗi hết hạn mức trước khi đẩy event ra client — để lên lịch tự chạy tiếp.
      if (ev.type === 'error' && ev.isSessionLimit) {
        hitSessionLimit = true;
        sessionLimitResetsAt = ev.resetsAt;
      }
      session.push(ev);
    },
    onApproval: params.isExecuting ? approvalHandler : undefined,
    onQuestion: (questions) => session.requestQuestion(questions),
    model: params.model,
    resumeSessionId: params.resumeSessionId,
    onSessionId: (id) => {
      conversationId = id;
      session.push({ type: 'conversation', conversationId: id });
      // DEBUG: giả lập hết hạn mức ở LẦN CHẠY ĐẦU. Đợi 6s (để phiên đã init xong + có
      // conversationId) rồi bắn error giả + abort → chạm nhánh finally lên lịch tự chạy tiếp.
      if (simulateSessionLimit && attempt === 0) {
        const simResetMs = Number(process.env.BOW_SIMULATE_RESET_MS ?? 30_000);
        const simDelayMs = Number(process.env.BOW_SIMULATE_DELAY_MS ?? 6_000);
        setTimeout(() => {
          hitSessionLimit = true;
          sessionLimitResetsAt = new Date(nowMs() + simResetMs).toISOString();
          session.push({
            type: 'error',
            subtype: 'error_during_execution',
            isSessionLimit: true,
            resetsAt: sessionLimitResetsAt,
          });
          session.abort.abort(); // dừng phiên → runAgent kết thúc → finally lên lịch
        }, simDelayMs);
      }
    },
  })
    .then((result) => {
      logAudit(`IP: ${params.cleanIp || 'unknown'} - Session ${session.id} HOÀN THÀNH. Result length: ${result?.length ?? 0}`, params.cleanIp, params.clientName);
      session.push({ type: 'done', result });
    })
    .catch((err: unknown) => {
      // Nếu phiên dừng vì hết hạn mức (ta chủ động abort để lên lịch), KHÔNG đẩy 'fatal'
      // (đỏ, gây hiểu lầm) — nhánh finally sẽ phát 'auto-resume-scheduled' thay thế.
      if (hitSessionLimit) return;
      logAudit(`IP: ${params.cleanIp || 'unknown'} - Session ${session.id} THẤT BẠI: ${(err as Error).message}`, params.cleanIp, params.clientName);
      session.push({ type: 'fatal', message: (err as Error).message });
    })
    .finally(() => {
      // Quyết định auto-resume TRƯỚC khi đóng session (client vẫn đang nghe SSE của session
      // này — event 'auto-resume-scheduled' phải đi qua trước khi 'end' đóng stream).
      const canResume =
        hitSessionLimit &&
        params.isExecuting &&
        attempt + 1 < AUTO_RESUME_MAX_ATTEMPTS &&
        Boolean(conversationId);

      if (canResume && conversationId) {
        // Giờ chạy lại: giờ reset + đệm. Nếu không lấy được resetsAt (hiếm) → thử lại sau 5 phút.
        const resetMs = sessionLimitResetsAt ? Date.parse(sessionLimitResetsAt) : NaN;
        const retryMs = Number.isFinite(resetMs)
          ? Math.max(resetMs + AUTO_RESUME_BUFFER_MS, nowMs() + AUTO_RESUME_BUFFER_MS)
          : nowMs() + 5 * 60_000;
        const retryAt = new Date(retryMs).toISOString();
        const delay = Math.max(0, retryMs - nowMs());
        const cid = conversationId;

        cancelResumeSchedule(cid); // gỡ lịch cũ của cùng hội thoại (nếu có) trước khi đặt mới
        const timer = setTimeout(() => {
          resumeSchedules.delete(cid);
          // Phiên MỚI cho lần chạy tiếp — client sẽ nối tiếp qua conversationId (resume).
          const nextSession = createSession();
          (nextSession as any).clientIp = params.cleanIp;
          (nextSession as any).clientName = params.clientName;
          logAudit(`IP: ${params.cleanIp} - AUTO-RESUME (lần ${attempt + 2}/${AUTO_RESUME_MAX_ATTEMPTS}): resume ${cid} → session ${nextSession.id}`, params.cleanIp, params.clientName);
          runAgentSession(
            nextSession,
            { ...params, brief: AUTO_RESUME_PROMPT, resumeSessionId: cid },
            attempt + 1,
          );
        }, delay);

        resumeSchedules.set(cid, { timer, retryAt, sessionId: session.id });
        logAudit(`IP: ${params.cleanIp} - Đã LÊN LỊCH tự chạy tiếp cho ${cid} lúc ${retryAt} (lần ${attempt + 2}/${AUTO_RESUME_MAX_ATTEMPTS})`, params.cleanIp, params.clientName);
        session.push({
          type: 'auto-resume-scheduled',
          resetsAt: sessionLimitResetsAt ?? null,
          retryAt,
          attempt: attempt + 1,
          maxAttempts: AUTO_RESUME_MAX_ATTEMPTS,
        });
      } else if (hitSessionLimit && params.isExecuting && attempt + 1 >= AUTO_RESUME_MAX_ATTEMPTS) {
        // Đã hết số lần tự chạy tiếp — báo client để người dùng tự quyết.
        session.push({ type: 'auto-resume-cancelled', reason: 'exhausted' });
      }

      session.close();
      if (params.routeToAdmin) adminBus.rejectForSession(session.id);
    });
}

/**
 * POST /api/run — bắt đầu một phiên agent.
 * body: { text?, ticketKey?, wbs?, mode: 'plan'|'execute', profile, effort, cwd }
 * Trả { sessionId }. Sự kiện stream qua GET /api/events/:id.
 */
app.post('/api/run', async (req, res) => {
  try {
    const {
      text,
      jiraRef,
      docs,
      pdfs,
      images,
      mcpServers,
      mode,
      profile,
      effort,
      language,
      cwd,
      model,
      stack,
      useSubagents,
      conversationId,
      resumeContext,
    } = req.body ?? {};

    // Admin = localhost (IP socket thật). Quyết định cả cwd (M8) lẫn mode ghi bên dưới.
    const isAdmin = isAdminReq(req);
    // Repo cố định theo mode: QC → qcCwd, Collab → collabCwd. Mode thường: chỉ ADMIN
    // được tự chọn cwd; non-admin buộc dùng cwd server (M8) — tránh biến cả HOME thành
    // "trong repo" để lách sandbox ghi.
    const workdir = isQcMode
      ? qcCwd()
      : isReviewerMode
        ? reviewerCwd()
        : isCollabMode
          ? collabCwd()
          : isBaMode
            ? baCwd()
            : isDevOpsMode
              ? devopsCwd()
              : isAdmin
                ? (cwd || process.cwd())
                : process.cwd();
    const cleanIp = getCleanIp(req);
    // M11: guard kiểu — body do client gửi, ép về string để .trim() không ném TypeError
    // (trước đây {jiraRef:123} gây 500 + rò message lỗi nội bộ thay vì 400 đúng nghĩa).
    const textStr = typeof text === 'string' ? text : '';
    const jiraRefStr = typeof jiraRef === 'string' ? jiraRef : '';
    const auditMode = isQcMode ? 'plan' : isReviewerMode ? 'plan (review)' : isCollabMode ? 'auto (collab)' : isBaMode ? 'auto (ba)' : isDevOpsMode ? 'auto (devops)' : mode;
    logAudit(`IP: ${cleanIp} - YÊU CẦU CHẠY: CWD=${workdir}, Mode=${auditMode}, Brief=${JSON.stringify(textStr || jiraRefStr || 'N/A')}`, cleanIp);
    let activeJiraRef = jiraRefStr;
    if (!activeJiraRef && textStr) {
      const parsed = parseJiraRef(textStr);
      if (parsed.kind !== 'none') {
        activeJiraRef = textStr;
      }
    }

    // Jira đọc qua MCP (server jira của Claude Code), KHÔNG cần JIRA_* nữa.
    // Danh sách server client tick chọn ở panel.
    const selectedMcp: string[] = Array.isArray(mcpServers) ? mcpServers.map((n) => String(n)) : [];
    // Server jira ĐÃ CẤU HÌNH global trong ~/.claude.json (dù người dùng chưa tick).
    const jiraInGlobal = listGlobalMcp()
      .map((m) => m.name)
      .filter((name) => name.toLowerCase().includes('jira'));
    // Đã dùng được jira nếu: client tick chọn, HOẶC có sẵn trong ~/.claude.json.
    const hasJiraSelected = selectedMcp.some((n) => n.toLowerCase().includes('jira'));
    const hasJiraMcp = hasJiraSelected || jiraInGlobal.length > 0;

    // Nếu có Jira ref mà jira đã cấu hình global nhưng client chưa tick → TỰ bật,
    // để runner nạp được server jira. Tránh chặn oan khi ~/.claude.json đã có jira.
    let effectiveMcp = selectedMcp;
    if (activeJiraRef && !hasJiraSelected && jiraInGlobal.length > 0) {
      effectiveMcp = [...new Set([...selectedMcp, ...jiraInGlobal])];
    }

    // Chỉ chặn khi có Jira ref THUẦN mà KHÔNG có jira ở BẤT KỲ đâu (cả tick lẫn global) —
    // vì lúc đó agent không có cách nào đọc ticket. Có text/tài liệu kèm thì vẫn chạy được.
    if (activeJiraRef && !hasJiraMcp) {
      const isPureJiraRef = textStr ? textStr.trim() === activeJiraRef.trim() : true;
      if (isPureJiraRef || jiraRefStr) {
        res.status(400).json({
          error: 'Có Jira ref nhưng chưa cấu hình MCP jira. Thêm server "jira" ở panel MCP (hoặc trong ~/.claude.json) để agent đọc được ticket, hoặc mô tả task bằng text.',
        });
        return;
      }
    }

    // Parse PDF (base64) → text, gộp vào docs.
    const allDocs: { name: string; content: string }[] = Array.isArray(docs) ? [...docs] : [];
    if (Array.isArray(pdfs)) {
      for (const p of pdfs as { name: string; base64: string }[]) {
        try {
          allDocs.push({ name: p.name, content: await pdfToText(p.base64) });
        } catch (err) {
          allDocs.push({ name: p.name, content: `(không đọc được PDF: ${(err as Error).message})` });
        }
      }
    }

    // Tải ẢNH đính kèm ticket Jira (mockup/screenshot) để agent NHÌN được — MCP chỉ trả
    // text, nên ta tự gọi REST có auth (xem jira-attachments.ts). Chỉ khi có ticket ref +
    // jira đã cấu hình. Fail-open: lỗi tải không chặn việc chạy. Xem DESIGN §7.1.
    const uploadImages: { base64: string; mediaType: string }[] = Array.isArray(images) ? images : [];
    let jiraImageNames: string[] = [];
    let jiraImageFailed: string[] = [];
    let jiraVideos: { filename: string; path: string }[] = [];
    let jiraVideosSkipped: { filename: string; sizeMb: number }[] = [];
    const jiraTicketKey = activeJiraRef && hasJiraMcp ? parseJiraRef(activeJiraRef).ticketKey : undefined;
    if (jiraTicketKey) {
      const fetched = await fetchJiraTicketImages(jiraTicketKey);
      jiraImageNames = fetched.images.map((i) => i.filename);
      jiraImageFailed = fetched.failed;
      // Gộp ảnh Jira vào cuối mảng ảnh (sau ảnh upload) — cùng đưa vào images[] của runner.
      uploadImages.push(...fetched.images.map((i) => ({ base64: i.base64, mediaType: i.mediaType })));
      // Video Jira: tải về đĩa (không vào images[]) để agent dùng skill /watch xem.
      const vids = await fetchJiraTicketVideos(jiraTicketKey);
      jiraVideos = vids.videos.map((v) => ({ filename: v.filename, path: v.path }));
      jiraVideosSkipped = vids.skippedTooLarge;
    }

    let brief = await buildTaskBrief({
      text: textStr,
      jiraRef: jiraRefStr,
      docs: allDocs,
      imageCount: Array.isArray(images) ? images.length : 0,
      jiraImageNames,
      jiraImageFailed,
      jiraVideos,
      jiraVideosSkipped,
    });
    if (!brief) {
      res.status(400).json({ error: 'Cần ít nhất một trong: text, Jira ref, tài liệu, ảnh.' });
      return;
    }

    // Fallback trí nhớ: khi client MỞ LẠI một cuộc cũ, nó gửi kèm resumeContext = tóm
    // tắt các dòng chat trước. Nối vào ĐẦU brief làm ngữ cảnh. Nếu SDK resume phiên
    // .jsonl thành công thì đoạn này chỉ nhắc lại (vô hại); nếu phiên đã bị SDK dọn
    // (resume rỗng) thì nó cứu ngữ cảnh để agent không "quên trắng" cuộc cũ.
    if (typeof resumeContext === 'string' && resumeContext.trim()) {
      brief =
        `## Ngữ cảnh cuộc trò chuyện trước (tiếp nối)\n` +
        `Đây là tóm tắt trao đổi trước đó trong cùng cuộc trò chuyện. Hãy đọc để nắm ` +
        `bối cảnh trước khi xử lý yêu cầu mới bên dưới:\n\n${resumeContext.trim()}\n\n---\n\n` +
        brief;
    }

    // Chọn profile. 'auto' = tự nhận diện từ cwd; 'none' = tổng quát; còn lại = profile đăng ký.
    let projectProfile: string | undefined;
    let resolvedProfile = profile ?? 'auto';
    if (resolvedProfile === 'auto') {
      resolvedProfile = detectSource(workdir).profile;
    }
    if (resolvedProfile && resolvedProfile !== 'none') {
      const prof = getProfile(resolvedProfile);
      if (prof) {
        projectProfile = prof.knowledge;
      }
    }

    const session = createSession();
    const clientName = getClientName(req);
    (session as any).clientIp = cleanIp;
    (session as any).clientName = clientName;
    logAudit(`IP: ${cleanIp} - Session khởi tạo: id=${session.id}`, cleanIp, clientName);
    // sessionId (lớp web/SSE) trả ngay để client mở stream. conversationId THẬT của SDK
    // đến sau qua event 'conversation' (bắt từ system/init) — client lưu để resume lượt sau.
    res.json({ sessionId: session.id });

    // Nếu client gửi kèm conversationId (đang tiếp nối phiên cũ) thì resume phiên đó.
    const resumeSessionId =
      typeof conversationId === 'string' && conversationId ? conversationId : undefined;

    // 4 mode kiểu Claude. Nhận cả tên cũ 'execute' (→ 'manual') để tương thích client cũ.
    // Mọi mode ngoài 'plan' đều là "đang thực thi" (có cổng duyệt theo policy của runner).
    // QC Mode → ép 'plan' (read-only source; Skill + Jira mở riêng trong runner.canUseTool).
    // Collab Mode → ép 'auto' (ghi tự do, chỉ gác lệnh hủy hoại — định tuyến duyệt lên admin).
    // PHÂN QUYỀN (quan trọng): chỉ ADMIN (localhost) mới được chạy mode GHI. Client KHÔNG
    // phải admin bị ép 'plan' (read-only) ở mode thường — muốn ghi phải qua Collab (mọi
    // thao tác duyệt bởi admin). QC Mode → luôn 'plan'. Collab → 'auto' NHƯNG siết duyệt
    // bằng requireApprovalForWrites (mọi ghi phải admin duyệt), không còn "ghi tự do".
    // (isAdmin đã tính ở đầu handler.)
    // BA Mode → ép 'auto' (ghi tài liệu + Jira không hỏi từng cái); source/DB/deploy bị
    // DENY CỨNG trong runner (baMode), không phải "hỏi duyệt". Nên KHÔNG bật
    // requireApprovalForWrites (nếu bật thì cả ghi .md cũng phải admin duyệt — sai vai trò BA).
    const VALID_MODES = new Set(['plan', 'manual', 'edit-auto', 'auto']);
    // Ở mode thường: admin dùng mode client gửi; non-admin bị ép 'plan'.
    const normalModeRequest = isAdmin ? mode : 'plan';
    // DevOps Mode → ép 'auto' (ghi file hạ tầng không hỏi từng cái khi admin chạy trực tiếp);
    // ghi source bị DENY CỨNG trong runner (devopsMode), còn deploy/apply được TREO ADMIN duyệt
    // qua requireApprovalForWrites (bật cho non-admin, như Collab).
    const requestedMode = isQcMode
      ? 'plan'
      : isReviewerMode
        ? 'plan'
        : isCollabMode
          ? 'auto'
          : isBaMode
            ? 'auto'
            : isDevOpsMode
              ? 'auto'
              : normalModeRequest;
    const runMode: 'plan' | 'manual' | 'edit-auto' | 'auto' =
      requestedMode === 'execute'
        ? 'manual'
        : VALID_MODES.has(requestedMode)
          ? (requestedMode as 'plan' | 'manual' | 'edit-auto' | 'auto')
          : 'plan';
    const isExecuting = runMode !== 'plan';

    // QC/Reviewer Mode read-only → luôn ép Sonnet (nhẹ/rẻ), KHÔNG tin model client gửi.
    // Tránh lỡ dùng Opus 4.8 khi client cũ/lỗi hoặc localStorage còn Opus.
    const effectiveModel = isQcMode || isReviewerMode ? 'claude-sonnet-5' : model;

    // Multi-agent (reviewer/verifier/impact-scout): tốn token hơn (spawn agent con) nên CHỈ
    // admin localhost bật được. Non-admin gửi cờ lên cũng bị bỏ qua → single-agent như cũ.
    const allowSubagents = isAdmin && useSubagents === true;

    // Cổng duyệt cho phiên này. CTV Collab hoặc DevOps (không phải admin localhost): MỌI thao
    // tác ghi được ĐỊNH TUYẾN lên ADMIN qua adminBus (routeToAdmin) và runner siết duyệt toàn bộ
    // (requireApprovalForWrites). Với DevOps, đây là cách "deploy/apply phải admin duyệt": lệnh
    // hạ tầng hợp lệ nhưng non-admin không tự chạy — treo admin xác nhận. Admin localhost chạy
    // trực tiếp thì auto như cũ. (BA KHÔNG route vì BA deny cứng, không có gì để admin duyệt.)
    const routeToAdmin = (isCollabMode || isDevOpsMode) && !isAdmin;
    const requireApprovalForWrites = routeToAdmin;

    // MCP RIÊNG của user LAN (theo token → user.id): overlay lên MCP chung, TỰ áp mọi lần
    // chạy của chính user đó (không cần tick). Admin localhost không có token → rỗng, dùng
    // MCP chung như cũ. Resolve tại đây (có req) rồi truyền xuống runner.
    const runUser = getUserByToken(getReqToken(req));
    const userMcpServers = runUser ? loadUserMcpServers(runUser.id) : {};

    // Nếu người dùng CHỦ ĐỘNG chạy lại một hội thoại đang có lịch tự-chạy-tiếp treo, huỷ lịch
    // đó — họ đã tự tiếp tục bằng tay, khỏi để timer server gọi trùng.
    if (resumeSessionId) cancelResumeSchedule(resumeSessionId);

    // Chạy agent nền + tự lên lịch chạy tiếp nếu dừng vì hết hạn mức phiên (chỉ khi đang thực thi).
    runAgentSession(
      session,
      {
        brief,
        cwd: workdir,
        mode: runMode,
        collabMode: isCollabMode,
        baMode: isBaMode,
        devopsMode: isDevOpsMode,
        effort: effort ?? 'high',
        language: language === 'en' ? 'en' : 'vi',
        projectProfile,
        images: uploadImages,
        mcpServers: effectiveMcp,
        userMcpServers,
        stack: typeof stack === 'string' ? stack : undefined,
        useSubagents: allowSubagents,
        model: effectiveModel,
        isExecuting,
        routeToAdmin,
        requireApprovalForWrites,
        cleanIp,
        clientName,
        resumeSessionId,
      },
      0,
    );
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /api/session/:id — kiểm tra phiên chạy có tồn tại không. */
app.get('/api/session/:id', (req, res) => {
  const session = getSession(req.params.id);
  res.json({ exists: Boolean(session) });
});

/**
 * POST /api/resume/cancel — huỷ lịch tự-chạy-tiếp của một hội thoại (người dùng bấm huỷ).
 * body: { conversationId }. Nếu phiên trước còn session sống, báo huỷ cho client đang nghe.
 */
app.post('/api/resume/cancel', (req, res) => {
  const { conversationId } = req.body ?? {};
  if (typeof conversationId !== 'string' || !conversationId) {
    res.status(400).json({ error: 'Thiếu conversationId.' });
    return;
  }
  const sched = resumeSchedules.get(conversationId);
  const cancelled = cancelResumeSchedule(conversationId);
  // Báo cho client đang nghe SSE của phiên trước (nếu còn) để nó xoá đồng hồ đếm ngược.
  if (sched) {
    const prev = getSession(sched.sessionId);
    prev?.push({ type: 'auto-resume-cancelled', reason: 'user' });
  }
  logAudit(`Huỷ lịch tự chạy tiếp cho ${conversationId}: ${cancelled ? 'đã huỷ' : 'không có lịch'}`);
  res.json({ cancelled });
});

/**
 * GET /api/resume/pending?conversationId=... — client mở lại tab hỏi có lịch tự-chạy-tiếp
 * đang chờ cho hội thoại này không, để dựng lại đồng hồ đếm ngược. Trả { retryAt } hoặc null.
 */
app.get('/api/resume/pending', (req, res) => {
  const conversationId = String(req.query.conversationId ?? '');
  const sched = conversationId ? resumeSchedules.get(conversationId) : undefined;
  res.json(sched ? { pending: true, retryAt: sched.retryAt } : { pending: false });
});

/** GET /api/events/:id — SSE stream sự kiện của một phiên. */
app.get('/api/events/:id', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Phiên không tồn tại.' });
    return;
  }

  session.onClientConnect();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  req.on('close', () => {
    session.onClientDisconnect(() => {
      session.abort.abort();
      removeSession(session.id);
    });
  });

  for await (const event of session.events()) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.write('event: end\ndata: {}\n\n');
  res.end();
});

/**
 * GET /api/admin/events — SSE kênh riêng cho ADMIN (localhost) trong Collab Mode.
 * Nhận realtime các yêu cầu duyệt lệnh hủy hoại do CTV phát lên (admin-approval-request)
 * và tín hiệu đã giải quyết (admin-approval-resolved). Chỉ admin mới mở được kênh này.
 */
app.get('/api/admin/events', requireAdmin, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  // Phát lại các yêu cầu đang treo cho admin vừa kết nối (vd mở tab muộn/reload).
  for (const request of adminBus.snapshot()) {
    res.write(`data: ${JSON.stringify({ type: 'admin-approval-request', request })}\n\n`);
  }

  const unsubscribe = adminBus.subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  // Keep-alive: comment ping mỗi 25s để proxy/LAN không tự đóng stream nhàn rỗi.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

/** POST /api/admin/approve — ADMIN duyệt/từ chối một yêu cầu Collab. body: { id, approved } */
app.post('/api/admin/approve', requireAdmin, (req, res) => {
  const { id, approved } = req.body ?? {};
  const cleanIp = getCleanIp(req);
  logAudit(`ADMIN duyệt Collab: id=${id}, approved=${approved}`, cleanIp);
  const ok = adminBus.resolve(String(id), Boolean(approved));
  res.json({ ok });
});

/** POST /api/approve — duyệt/từ chối một thao tác ghi. body: { sessionId, id, approved } */
app.post('/api/approve', (req, res) => {
  const { sessionId, id, approved } = req.body ?? {};
  const cleanIp = getCleanIp(req);
  logAudit(`IP: ${cleanIp} - Yêu cầu duyệt: sessionId=${sessionId}, toolUseId=${id}, approved=${approved}`, cleanIp);
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Phiên không tồn tại.' });
    return;
  }
  const ok = session.resolveApproval(id, Boolean(approved));
  res.json({ ok });
});

/**
 * POST /api/answer — trả lời một câu hỏi AskUserQuestion.
 * body: { sessionId, id, answers } — answers là map câu-hỏi → câu-trả-lời,
 * hoặc null/thiếu = người dùng huỷ (tool bị deny).
 */
app.post('/api/answer', (req, res) => {
  const { sessionId, id, answers } = req.body ?? {};
  const cleanIp = getCleanIp(req);
  logAudit(`IP: ${cleanIp} - Trả lời câu hỏi: sessionId=${sessionId}, toolUseId=${id}, answers=${JSON.stringify(answers)}`, cleanIp);
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Phiên không tồn tại.' });
    return;
  }
  const normalized =
    answers && typeof answers === 'object' ? (answers as Record<string, string>) : null;
  const ok = session.resolveQuestion(id, normalized);
  res.json({ ok });
});

/** POST /api/stop/:id — dừng agent giữa chừng. */
app.post('/api/stop/:id', (req, res) => {
  const cleanIp = getCleanIp(req);
  logAudit(`IP: ${cleanIp} - Yêu cầu dừng session: id=${req.params.id}`, cleanIp);
  const session = getSession(req.params.id);
  if (session) {
    session.abort.abort();
    session.close();
  }
  res.json({ ok: Boolean(session) });
});

// Helper to list all Claude profiles
function listClaudeProfiles(): { name: string; tokenSet: boolean }[] {
  const home = os.homedir();
  try {
    const files = fs.readdirSync(home);
    const profiles = files.filter(f => {
      if (f === '.claude') return true;
      if (!f.startsWith('.claude-')) return false;
      const fullPath = join(home, f);
      try {
        return fs.statSync(fullPath).isDirectory();
      } catch {
        return false;
      }
    });
    // Trả về danh sách profile kèm trạng thái tokenSet
    return profiles.map(f => {
      const pName = f === '.claude' ? 'default' : f.slice('.claude-'.length);
      const tokenFile = join(home, f, 'token.txt');
      return {
        name: pName,
        tokenSet: fs.existsSync(tokenFile),
      };
    });
  } catch {
    return [{ name: 'default', tokenSet: false }];
  }
}

// Helper to get current profile display name
function getCurrentProfile(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (!configDir) return 'default';
  const name = basename(configDir);
  if (name === '.claude') return 'default';
  if (name.startsWith('.claude-')) return name.slice('.claude-'.length);
  return name;
}

function pingConfigPort(port: number): Promise<{ repoName: string; defaultCwd: string } | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/config`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({
            repoName: parsed.repoName || '',
            defaultCwd: parsed.defaultCwd || ''
          });
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => {
      resolve(null);
    });
    req.setTimeout(250, () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** GET /api/config — thông tin cấu hình cho UI (MCP, cwd). Model do web tự chọn. */
app.get('/api/config', async (req, res) => {
  const cc = loadClaudeCodeMcp();
  const localIps = getLocalIps();
  const localIp = localIps[0] ?? 'localhost';

  const isAdmin = isAdminReq(req);

  // Source bị khoá theo mode: QC → qcCwd, Reviewer → reviewerCwd, Collab → collabCwd, BA → baCwd,
  // DevOps → devopsCwd.
  const effectiveCwd = isQcMode ? qcCwd() : isReviewerMode ? reviewerCwd() : isCollabMode ? collabCwd() : isBaMode ? baCwd() : isDevOpsMode ? devopsCwd() : process.cwd();
  // Cổng web LAN theo bản đang chạy (BOW_WEB_PORT: dev 5173 / qc 5174 / collab 5175 / ba 5176 /
  // review 5177 / devops 5178).
  const webPort = process.env.BOW_WEB_PORT || '5173';

  const currentPort = Number(process.env.BOW_AGENT_PORT || '4000');
  const modes = {
    dev: { repoName: '', defaultCwd: '' },
    qc: { repoName: '', defaultCwd: '' },
    collab: { repoName: '', defaultCwd: '' },
    ba: { repoName: '', defaultCwd: '' },
    review: { repoName: '', defaultCwd: '' },
    devops: { repoName: '', defaultCwd: '' }
  };

  if (currentPort === 4000) {
    modes.dev = { repoName: basename(effectiveCwd), defaultCwd: effectiveCwd };
  } else if (currentPort === 4001) {
    modes.qc = { repoName: basename(effectiveCwd), defaultCwd: effectiveCwd };
  } else if (currentPort === 4002) {
    modes.collab = { repoName: basename(effectiveCwd), defaultCwd: effectiveCwd };
  } else if (currentPort === 4003) {
    modes.ba = { repoName: basename(effectiveCwd), defaultCwd: effectiveCwd };
  } else if (currentPort === 4004) {
    modes.review = { repoName: basename(effectiveCwd), defaultCwd: effectiveCwd };
  } else if (currentPort === 4005) {
    modes.devops = { repoName: basename(effectiveCwd), defaultCwd: effectiveCwd };
  }

  const promises = [];
  if (currentPort !== 4000) {
    promises.push(pingConfigPort(4000).then(res => { if (res) modes.dev = res; }));
  }
  if (currentPort !== 4001) {
    promises.push(pingConfigPort(4001).then(res => { if (res) modes.qc = res; }));
  }
  if (currentPort !== 4002) {
    promises.push(pingConfigPort(4002).then(res => { if (res) modes.collab = res; }));
  }
  if (currentPort !== 4003) {
    promises.push(pingConfigPort(4003).then(res => { if (res) modes.ba = res; }));
  }
  if (currentPort !== 4004) {
    promises.push(pingConfigPort(4004).then(res => { if (res) modes.review = res; }));
  }
  if (currentPort !== 4005) {
    promises.push(pingConfigPort(4005).then(res => { if (res) modes.devops = res; }));
  }

  await Promise.all(promises);

  res.json({
    defaultCwd: effectiveCwd,
    repoName: basename(effectiveCwd),
    mcpServers: cc.names,
    // lanUrl: host đầu tiên (tương thích ngược). lanUrls: TẤT CẢ host — UI cho chọn/copy.
    lanUrl: `http://${localIp}:${webPort}`,
    lanUrls: (localIps.length ? localIps : ['localhost']).map((ip) => `http://${ip}:${webPort}`),
    isQcMode,
    isReviewerMode,
    isCollabMode,
    isBaMode,
    isDevOpsMode,
    isAdmin,
    claudeProfiles: listClaudeProfiles(),
    currentClaudeProfile: getCurrentProfile(),
    hasAuth: config.hasAuth,
    tokenSet: config.hasTokenSet,
    otherModes: modes
  });
});

// Helper to save active profile to .env
function saveActiveProfileToEnv(profileName: string): void {
  const envPath = join(process.cwd(), '.env');
  const dirName = profileName === 'default' ? '.claude' : `.claude-${profileName}`;
  const fullPath = join(os.homedir(), dirName);
  
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  }
  
  const lineToSet = `CLAUDE_CONFIG_DIR=${fullPath}`;
  
  if (content.includes('CLAUDE_CONFIG_DIR=')) {
    content = content.replace(/CLAUDE_CONFIG_DIR=.*/g, lineToSet);
  } else {
    content += (content.endsWith('\n') ? '' : '\n') + lineToSet + '\n';
  }
  
  fs.writeFileSync(envPath, content, 'utf8');
}

/** POST /api/profiles — Chuyển tài khoản Claude hoạt động và thiết lập token (chỉ Admin mới làm được) */
app.post('/api/profiles', requireAdmin, (req, res) => {
  const { profile, token } = req.body ?? {};
  if (typeof profile !== 'string' || !profile.trim()) {
    res.status(400).json({ error: 'Thiếu tên profile.' });
    return;
  }

  const pName = profile.trim();
  const dirName = pName === 'default' ? '.claude' : `.claude-${pName}`;
  const fullPath = join(os.homedir(), dirName);

  if (!fs.existsSync(fullPath)) {
    try {
      fs.mkdirSync(fullPath, { recursive: true });
      logAudit(`ADMIN tạo mới profile Claude → ${pName}`, '127.0.0.1');
    } catch (err) {
      res.status(500).json({ error: `Không thể tạo thư mục cấu hình: ${(err as Error).message}` });
      return;
    }
  }

  process.env.CLAUDE_CONFIG_DIR = fullPath;
  logAudit(`ADMIN chuyển profile Claude → ${pName}`, '127.0.0.1');

  // Ghi hoặc xoá token.txt
  const tokenFile = join(fullPath, 'token.txt');
  if (typeof token === 'string') {
    const trimmedToken = token.trim();
    if (trimmedToken) {
      try {
        fs.writeFileSync(tokenFile, trimmedToken, 'utf8');
        logAudit(`ADMIN ghi token cho profile Claude → ${pName}`, '127.0.0.1');
      } catch (err) {
        res.status(500).json({ error: `Không thể lưu token: ${(err as Error).message}` });
        return;
      }
    } else {
      try {
        if (fs.existsSync(tokenFile)) {
          fs.unlinkSync(tokenFile);
          logAudit(`ADMIN xoá token của profile Claude → ${pName}`, '127.0.0.1');
        }
      } catch (err) {
        res.status(500).json({ error: `Không thể xoá token: ${(err as Error).message}` });
        return;
      }
    }
  }

  // Tải lại các biến môi trường token
  loadActiveProfileToken();

  try {
    saveActiveProfileToEnv(pName);
  } catch (err) {
    console.error('Lỗi khi ghi file .env:', err);
  }

  // Trả về config mới để UI cập nhật
  const cc = loadClaudeCodeMcp();
  res.json({
    ok: true,
    currentProfile: pName,
    hasAuth: config.hasAuth,
    tokenSet: config.hasTokenSet,
    mcpServers: cc.names,
  });
});

interface ActiveLogin {
  child: any;
  url: string;
  output: string;
  urlSent: boolean;
}

const activeLogins = new Map<string, ActiveLogin>();

function getClaudeBinaryPath(): string {
  const paths = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    'claude',
  ];
  for (const p of paths) {
    if (p === 'claude') return p;
    if (fs.existsSync(p)) return p;
  }
  return 'claude';
}

/** POST /api/profiles/login/start — Bắt đầu đăng nhập qua Claude CLI (OAuth) */
app.post('/api/profiles/login/start', requireAdmin, (req, res) => {
  const { profile } = req.body ?? {};
  if (typeof profile !== 'string' || !profile.trim()) {
    res.status(400).json({ error: 'Thiếu tên profile.' });
    return;
  }

  const pName = profile.trim();
  const dirName = pName === 'default' ? '.claude' : `.claude-${pName}`;
  const fullPath = join(os.homedir(), dirName);

  if (!fs.existsSync(fullPath)) {
    try {
      fs.mkdirSync(fullPath, { recursive: true });
    } catch (err) {
      res.status(500).json({ error: `Không thể tạo thư mục cấu hình: ${(err as Error).message}` });
      return;
    }
  }

  const existing = activeLogins.get(pName);
  if (existing) {
    try {
      existing.child.kill();
    } catch {}
    activeLogins.delete(pName);
  }

  let child;
  try {
    const binary = getClaudeBinaryPath();
    const envPath = process.env.PATH || '';
    const pathsToPrepend = ['/opt/homebrew/bin', '/usr/local/bin'];
    const newPath = [...pathsToPrepend, envPath.split(':')].flat().filter(Boolean).join(':');

    child = spawn(binary, ['auth', 'login', '--claudeai'], {
      env: {
        ...process.env,
        PATH: newPath,
        CLAUDE_CONFIG_DIR: fullPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error('Lỗi khi spawn CLI login:', err);
    res.status(500).json({ error: `Không thể khởi chạy Claude CLI: ${(err as Error).message}` });
    return;
  }

  let url = '';
  let output = '';
  let urlSent = false;

  const handleChunk = (chunk: any) => {
    const text = chunk.toString();
    output += text;
    const match = output.match(/https:\/\/[^\s]+/);
    if (match && !urlSent) {
      url = match[0];
      urlSent = true;
      res.json({ ok: true, url, profile: pName });
    }
  };

  child.stdout.on('data', handleChunk);
  child.stderr.on('data', handleChunk);

  const timeoutId = setTimeout(() => {
    if (!urlSent) {
      child.kill();
      activeLogins.delete(pName);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Không nhận được URL đăng nhập từ Claude CLI.' });
      }
    }
  }, 20000);

  child.on('error', (err) => {
    clearTimeout(timeoutId);
    console.error('Tiến trình CLI login báo lỗi:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: `Tiến trình Claude CLI gặp lỗi: ${err.message}` });
    }
    activeLogins.delete(pName);
  });

  child.on('close', (code) => {
    clearTimeout(timeoutId);
    activeLogins.delete(pName);
    if (!urlSent && !res.headersSent) {
      res.status(500).json({
        error: `Tiến trình Claude CLI thoát sớm với mã ${code}. Chi tiết: ${output.trim() || 'Không có output.'}`
      });
    }
  });

  activeLogins.set(pName, { child, url, output, urlSent });
});

/** POST /api/profiles/login/verify — Nhập mã xác nhận hoàn tất OAuth */
app.post('/api/profiles/login/verify', requireAdmin, (req, res) => {
  const { profile, code } = req.body ?? {};
  if (typeof profile !== 'string' || !profile.trim()) {
    res.status(400).json({ error: 'Thiếu tên profile.' });
    return;
  }
  if (typeof code !== 'string' || !code.trim()) {
    res.status(400).json({ error: 'Thiếu mã xác thực.' });
    return;
  }

  const pName = profile.trim();
  const loginInfo = activeLogins.get(pName);
  if (!loginInfo) {
    res.status(400).json({ error: 'Tiến trình đăng nhập đã hết hạn hoặc không tồn tại.' });
    return;
  }

  const child = loginInfo.child;
  // M12: ghi vào stdin của tiến trình có thể đã chết → 'error' (EPIPE) bất đồng bộ. Không
  // có listener thì Node ném uncaught exception làm SẬP server. Gắn error handler + guard
  // writable, và trả 500 gọn thay vì để tiến trình chết.
  let responded = false;
  const failVerify = (msg: string) => {
    if (responded) return;
    responded = true;
    activeLogins.delete(pName);
    if (!res.headersSent) res.status(500).json({ error: msg });
  };
  child.stdin.on('error', (err: Error) => {
    failVerify(`Không gửi được mã xác thực tới tiến trình đăng nhập: ${err.message}`);
  });
  if (!child.stdin.writable || child.killed || child.exitCode !== null) {
    failVerify('Tiến trình đăng nhập đã đóng — hãy bắt đầu lại.');
    return;
  }
  try {
    child.stdin.write(code.trim() + '\n');
  } catch (err) {
    failVerify(`Không gửi được mã xác thực: ${(err as Error).message}`);
    return;
  }

  child.on('close', (exitCode: number | null) => {
    if (responded) return;
    responded = true;
    activeLogins.delete(pName);
    if (exitCode === 0) {
      loadActiveProfileToken();
      res.json({ ok: true });
    } else {
      res.status(500).json({ error: `Đăng nhập thất bại (mã lỗi ${exitCode}).` });
    }
  });

  setTimeout(() => {
    if (!responded) {
      responded = true;
      child.kill();
      activeLogins.delete(pName);
      res.status(500).json({ error: 'Quá thời gian xác thực tài khoản.' });
    }
  }, 15000);
});

/** DELETE /api/profiles — Xoá một tài khoản Claude (chỉ Admin mới làm được) */
app.delete('/api/profiles', requireAdmin, (req, res) => {
  const { profile } = req.body ?? {};
  if (typeof profile !== 'string' || !profile.trim()) {
    res.status(400).json({ error: 'Thiếu tên profile.' });
    return;
  }

  const pName = profile.trim();
  if (pName === 'default') {
    res.status(400).json({ error: 'Không thể xoá profile mặc định (default).' });
    return;
  }

  const dirName = `.claude-${pName}`;
  const fullPath = join(os.homedir(), dirName);

  if (fs.existsSync(fullPath)) {
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
      logAudit(`ADMIN xoá profile Claude → ${pName}`, '127.0.0.1');
    } catch (err) {
      res.status(500).json({ error: `Không thể xoá thư mục cấu hình: ${(err as Error).message}` });
      return;
    }
  }

  // Nếu profile bị xoá trùng với profile hiện tại, reset về default
  const activeProfile = getCurrentProfile();
  if (activeProfile === pName) {
    process.env.CLAUDE_CONFIG_DIR = join(os.homedir(), '.claude');
    try {
      saveActiveProfileToEnv('default');
    } catch (err) {
      console.error('Lỗi khi ghi file .env:', err);
    }
    loadActiveProfileToken();
  }

  const cc = loadClaudeCodeMcp();
  res.json({
    ok: true,
    currentProfile: getCurrentProfile(),
    claudeProfiles: listClaudeProfiles(),
    hasAuth: config.hasAuth,
    tokenSet: config.hasTokenSet,
    mcpServers: cc.names,
  });
});

/**
 * POST /api/qc-cwd — Admin đổi thư mục source cố định của mode (QC/BA). Tên route theo QC
 * Mode nhưng dùng chung: BA gọi cùng route (cổng 4003) để đổi baCwd.
 * body: { cwd }. Chỉ Admin (localhost) mới đổi được; không cần restart server.
 */
app.post('/api/qc-cwd', requireAdmin, (req, res) => {
  const raw = typeof req.body?.cwd === 'string' ? req.body.cwd.trim() : '';
  if (!raw) {
    res.status(400).json({ error: 'Thiếu đường dẫn thư mục.' });
    return;
  }
  const dir = resolve(raw);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    res.status(400).json({ error: 'Đường dẫn không tồn tại hoặc không phải thư mục.' });
    return;
  }
  // Ghi vào override đúng theo mode tiến trình đang chạy: BA → baCwdOverride, Reviewer →
  // reviewerCwdOverride, DevOps → devopsCwdOverride, còn lại → qcCwdOverride (dùng chung QC/dev —
  // GET /api/config đọc theo mode).
  if (isBaMode) baCwdOverride = dir;
  else if (isReviewerMode) reviewerCwdOverride = dir;
  else if (isDevOpsMode) devopsCwdOverride = dir;
  else qcCwdOverride = dir;
  logAudit(`ADMIN đổi source → ${dir}`, '127.0.0.1');
  res.json({ ok: true, cwd: dir, repoName: basename(dir) });
});

/** GET /api/audit-logs — trả về danh sách lịch sử log kiểm toán (chỉ dành cho localhost admin). */
app.get('/api/audit-logs', requireAdmin, (_req, res) => {
  try {
    const logPath = join(process.cwd(), 'memory', 'audit_share.log');
    if (!fs.existsSync(logPath)) {
      res.json({ logs: [] });
      return;
    }
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim()).slice(-150).reverse();
    res.json({ logs: lines });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /api/active-clients — danh sách thiết bị đang kết nối LAN (chỉ Admin localhost). */
app.get('/api/active-clients', requireAdmin, (_req, res) => {
  const now = Date.now();
  for (const [ip, data] of activeClients.entries()) {
    if (now - data.lastSeen.getTime() > 45000) {
      activeClients.delete(ip);
    }
  }
  
  const clients = Array.from(activeClients.entries()).map(([ip, data]) => {
    let device = 'Thiết bị khác';
    const ua = data.userAgent || '';
    if (ua.includes('Mobi')) {
      device = 'Mobile';
    } else if (ua.includes('Chrome')) {
      device = 'Chrome';
    } else if (ua.includes('Safari') && !ua.includes('Chrome')) {
      device = 'Safari';
    } else if (ua.includes('Firefox')) {
      device = 'Firefox';
    }
    
    return {
      ip,
      device,
      lastSeen: data.lastSeen.toISOString(),
    };
  });
  
  res.json({ clients });
});

/**
 * GET /api/usage — snapshot hạn mức gói (Session 5h / Weekly 7d / theo model) để UI
 * hiển thị lúc mở trang & khi bấm làm mới. Độc lập với lượt chạy agent; context window
 * ở đây phản ánh phiên trống nên UI chỉ dùng phần rateLimits. Trả 503 nếu không đọc được.
 */
app.get('/api/usage', async (req, res) => {
  const model = typeof req.query.model === 'string' ? req.query.model : undefined;
  try {
    const usage = await fetchUsageSnapshot(model);
    if (!usage) {
      res.status(503).json({ error: 'Không đọc được dữ liệu usage (chưa login Claude CLI hoặc SDK không hỗ trợ).' });
      return;
    }
    res.json({ usage });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/skill-stacks — liệt kê stack skill external ĐÃ ADMIN DUYỆT (registry). UI đọc để
 * dựng dropdown chọn stack. Chỉ trả metadata hiển thị (id/label/ref/default), không lộ gì nhạy cảm.
 */
app.get('/api/skill-stacks', (_req, res) => {
  try {
    const stacks = loadRegistry().map((s) => ({
      id: s.id,
      label: s.label,
      ref: s.ref,
      default: s.default === true,
    }));
    res.json({ stacks });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/skill-status?stack=<id> — trạng thái TẢI của core + stack đang chọn (đã cache
 * chưa → chạy offline được chưa). CHỈ đọc đĩa/registry, KHÔNG tải gì. UI dựng badge cạnh
 * dropdown Stack. `stack` rỗng = chỉ xét core.
 */
app.get('/api/skill-status', (req, res) => {
  try {
    const stack = typeof req.query.stack === 'string' ? req.query.stack : '';
    // cwd để soi ĐÃ TRẢI vào project chưa (badge phân biệt synced/stale/missing). Thiếu cwd →
    // chỉ báo cache (mọi nguồn 'missing'). Client gửi cwd đang chọn ở dropdown thư mục.
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
    res.json(skillStatus(stack, cwd));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/skill-sync — ĐỒNG BỘ THỦ CÔNG: tải (nếu chưa) + trải core + stack đang chọn vào
 * `.claude/skills/` của cwd, không cần chạy phiên. body: {cwd, stack?}. Gate requireAdmin +
 * checkReadonlyConfig như /api/mcp: thao tác ghi vào máy (clone repo, trải file) chỉ admin localhost
 * làm, không mở cho user LAN. Fail-open: trả kết quả từng nguồn kèm error, không 500 vì 1 nguồn lỗi.
 */
app.post('/api/skill-sync', requireAdmin, checkReadonlyConfig, (req, res) => {
  const { cwd, stack } = req.body ?? {};
  if (typeof cwd !== 'string' || !cwd) {
    res.status(400).json({ error: 'Thiếu cwd.' });
    return;
  }
  try {
    res.json(syncSkills(typeof stack === 'string' ? stack : '', cwd));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /api/mcp — liệt kê MCP server đã cấu hình (che token, chỉ trả tên env key). */
app.get('/api/mcp', (_req, res) => {
  try {
    res.json({ servers: listGlobalMcp() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** POST /api/mcp — thêm MCP server stdio mới. body: {name, command, args?, env?} */
app.post('/api/mcp', requireAdmin, checkReadonlyConfig, (req, res) => {
  const { name, command, args, env } = req.body ?? {};
  if (typeof name !== 'string' || typeof command !== 'string') {
    res.status(400).json({ error: 'Thiếu name hoặc command.' });
    return;
  }
  try {
    addGlobalMcp({
      name,
      command,
      args: Array.isArray(args) ? args.map(String) : undefined,
      env: env && typeof env === 'object' ? (env as Record<string, string>) : undefined,
    });
    res.json({ ok: true, servers: listGlobalMcp() });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** DELETE /api/mcp/:name — xóa một MCP server. */
app.delete('/api/mcp/:name', requireAdmin, checkReadonlyConfig, (req, res) => {
  try {
    removeGlobalMcp(req.params.name);
    res.json({ ok: true, servers: listGlobalMcp() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── MCP RIÊNG theo user (overlay lên MCP chung) — /api/my-mcp ──────────────────
// KHÁC /api/mcp (chung, chỉ admin, bị chặn trong QC/Collab): các route này cho USER
// LAN đã duyệt tự quản MCP riêng của CHÍNH họ, KỂ CẢ trong QC/Collab Mode — vì chỉ
// ảnh hưởng họ, không đụng hạ tầng chung. Không dùng requireAdmin / checkReadonlyConfig.

/** Lấy user (đã duyệt) sở hữu request, hoặc trả 403 và null. Admin localhost không có
 *  token access → không dùng /api/my-mcp (admin quản MCP chung qua /api/mcp). */
function requireMcpUser(req: express.Request, res: express.Response): AccessUser | null {
  if (!isAccessAllowed(req)) {
    res.status(403).json({ error: 'Cần được duyệt truy cập mới quản lý MCP riêng.' });
    return null;
  }
  const user = getUserByToken(getReqToken(req));
  if (!user) {
    res.status(403).json({
      error: 'MCP riêng dành cho người dùng LAN đã duyệt. Admin dùng MCP chung ở mục cấu hình.',
    });
    return null;
  }
  return user;
}

/** GET /api/my-mcp — liệt kê MCP RIÊNG của user gọi (che token). */
app.get('/api/my-mcp', (req, res) => {
  const user = requireMcpUser(req, res);
  if (!user) return;
  try {
    res.json({ servers: listUserMcp(user.id) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** POST /api/my-mcp — user thêm MCP RIÊNG. body: {name, command, args?, env?} */
app.post('/api/my-mcp', (req, res) => {
  const user = requireMcpUser(req, res);
  if (!user) return;
  const { name, command, args, env } = req.body ?? {};
  if (typeof name !== 'string' || typeof command !== 'string') {
    res.status(400).json({ error: 'Thiếu name hoặc command.' });
    return;
  }
  try {
    addUserMcp(user.id, {
      name,
      command,
      args: Array.isArray(args) ? args.map(String) : undefined,
      env: env && typeof env === 'object' ? (env as Record<string, string>) : undefined,
    });
    logAudit(`IP: ${getCleanIp(req)} - Thêm MCP riêng "${name}"`, getCleanIp(req), user.name);
    res.json({ ok: true, servers: listUserMcp(user.id) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** DELETE /api/my-mcp/:name — user xóa một MCP RIÊNG của mình. */
app.delete('/api/my-mcp/:name', (req, res) => {
  const user = requireMcpUser(req, res);
  if (!user) return;
  try {
    removeUserMcp(user.id, req.params.name);
    logAudit(`IP: ${getCleanIp(req)} - Xóa MCP riêng "${req.params.name}"`, getCleanIp(req), user.name);
    res.json({ ok: true, servers: listUserMcp(user.id) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /api/browse-dirs?path=... — duyệt thư mục local. */
app.get('/api/browse-dirs', requireAdmin, (req, res) => {
  const queryPath = typeof req.query.path === 'string' ? req.query.path : '';
  const currentPath = resolve(queryPath || process.cwd());
  try {
    const items = fs.readdirSync(currentPath, { withFileTypes: true });
    const dirs = items
      .filter((item) => {
        try {
          return (
            item.isDirectory() &&
            !item.name.startsWith('.') &&
            item.name !== 'node_modules' &&
            item.name !== 'dist' &&
            item.name !== 'dist-web'
          );
        } catch {
          return false;
        }
      })
      .map((item) => item.name)
      .sort();

    const parent = currentPath === dirname(currentPath) ? null : dirname(currentPath);

    res.json({
      currentPath,
      parent,
      dirs,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/detect?cwd=... — nhận diện source từ thư mục (profile/stack/empty). */
app.get('/api/detect', (req, res) => {
  const cwd = (req.query.cwd as string) || process.cwd();
  try {
    res.json(detectSource(cwd));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ── Workspace (nhóm nhiều repo + trí nhớ tích lũy) — xem DESIGN §9 ────────────

/** Tìm workspace đã đăng ký theo slug (null nếu không có). */
function findWorkspace(slug: string): Workspace | null {
  return listWorkspaces().find((w) => w.slug === slug) ?? null;
}

/** GET /api/workspaces — liệt kê mọi workspace (slug + repos). */
app.get('/api/workspaces', (_req, res) => {
  try {
    res.json({ workspaces: listWorkspaces() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/workspace/current?cwd=... — workspace mà cwd hiện tại thuộc về (cho badge
 * chỉ báo ở composer). Trả { workspace: null } nếu cwd không thuộc workspace nào.
 */
app.get('/api/workspace/current', (req, res) => {
  const cwd = (req.query.cwd as string) || process.cwd();
  try {
    res.json({ workspace: resolveWorkspace(cwd) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/workspace/repo — gán một repo vào workspace (tạo nếu chưa có).
 * body: { name, path, role }. Trả workspace sau cập nhật.
 */
app.post('/api/workspace/repo', requireAdmin, checkReadonlyConfig, (req, res) => {
  const { name, path, role } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim() || typeof path !== 'string' || !path.trim()) {
    res.status(400).json({ error: 'Thiếu name hoặc path.' });
    return;
  }
  if (!fs.existsSync(path)) {
    res.status(400).json({ error: `Không thấy thư mục repo: ${path}` });
    return;
  }
  try {
    const ws = addRepoToWorkspace(name, path, typeof role === 'string' && role.trim() ? role : 'repo');
    res.json({ ok: true, workspace: ws });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * DELETE /api/workspace/repo — gỡ một repo khỏi workspace (xóa workspace nếu rỗng).
 * body: { name, path }.
 */
app.delete('/api/workspace/repo', requireAdmin, checkReadonlyConfig, (req, res) => {
  const { name, path } = req.body ?? {};
  if (typeof name !== 'string' || typeof path !== 'string') {
    res.status(400).json({ error: 'Thiếu name hoặc path.' });
    return;
  }
  try {
    removeRepoFromWorkspace(name, path);
    res.json({ ok: true, workspaces: listWorkspaces() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /api/workspace/:slug/knowledge — shared.md + journal.md của workspace (cho panel). */
app.get('/api/workspace/:slug/knowledge', (req, res) => {
  const ws = findWorkspace(req.params.slug);
  if (!ws) {
    res.status(404).json({ error: 'Workspace không tồn tại.' });
    return;
  }
  try {
    res.json({ shared: readSharedKnowledge(ws), journal: readFullJournal(ws) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** PUT /api/workspace/:slug/shared — ghi đè tri thức chung shared.md. body: { content }. */
app.put('/api/workspace/:slug/shared', requireAdmin, checkReadonlyConfig, (req, res) => {
  const ws = findWorkspace(req.params.slug);
  if (!ws) {
    res.status(404).json({ error: 'Workspace không tồn tại.' });
    return;
  }
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  try {
    writeSharedKnowledge(ws, content);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/generate-profile — quét repo lạ (chỉ đọc) rồi sinh profile lưu lại.
 * body: { cwd }. Stream tiến độ qua session giống /api/run.
 */
app.post('/api/generate-profile', requireAdmin, async (req, res) => {
  const cwd = (req.body?.cwd as string) || process.cwd();
  const session = createSession();
  res.json({ sessionId: session.id });

  generateProfile(cwd, (msg) => session.push({ type: 'text', text: msg }))
    .then((r) => {
      session.push({ type: 'text', text: `Đã sinh profile "${r.name}" → ${r.file}` });
      session.push({ type: 'done', result: r.name });
    })
    .catch((err: unknown) => session.push({ type: 'fatal', message: (err as Error).message }))
    .finally(() => session.close());
});

/**
 * POST /api/analyze-structure — quét repo ở cwd (chỉ đọc) rồi mô tả CẤU TRÚC (markdown)
 * cho panel "Cấu trúc dự án" ở header. Trả { sessionId } NGAY, stream tiến độ + kết quả
 * qua SSE (/api/events/:id) — KHÔNG treo HTTP request 60s (tránh proxy/browser timeout,
 * nguyên nhân lỗi "Unexpected end of JSON input"). KHÔNG lưu file (khác sinh profile).
 * Kết quả cuối đẩy qua event 'done' với result = mô tả markdown. body: { cwd }.
 */
app.post('/api/analyze-structure', requireAdmin, (req, res) => {
  const cwd = (req.body?.cwd as string) || process.cwd();
  if (!fs.existsSync(cwd)) {
    res.status(400).json({ error: `Không thấy thư mục: ${cwd}` });
    return;
  }
  const session = createSession();
  res.json({ sessionId: session.id });

  analyzeStructure(cwd, (msg) => session.push({ type: 'text', text: msg }))
    .then((structure) => session.push({ type: 'done', result: structure }))
    .catch((err: unknown) => session.push({ type: 'fatal', message: (err as Error).message }))
    .finally(() => session.close());
});

// ── Lịch sử nhiều cuộc trò chuyện (lưu bền ra đĩa) ───────────────────────────

/** GET /api/conversations — danh sách cuộc (không kèm items), mới nhất lên đầu.
 *  Lọc theo IP: mỗi máy chỉ thấy cuộc của mình; admin (localhost) thấy tất cả. */
app.get('/api/conversations', (req, res) => {
  try {
    // R2: dùng IP socket THẬT cho phân quyền chủ sở hữu/admin — getCleanIp tin
    // x-forwarded-for nên client giả `X-Forwarded-For: 127.0.0.1` sẽ được coi là admin và
    // đọc/xoá cuộc của mọi người. Đồng bộ với isAdminReq đã vá.
    res.json({ conversations: listConversations(getSocketIp(req)) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /api/conversations/:id — lấy đầy đủ một cuộc (kèm items + conversationId).
 *  Chỉ chủ cuộc hoặc admin đọc được (tránh QC đọc chéo cuộc của người khác). */
app.get('/api/conversations/:id', (req, res) => {
  const conv = getConversation(req.params.id, getSocketIp(req)); // R2: IP socket thật
  if (!conv) {
    res.status(404).json({ error: 'Cuộc trò chuyện không tồn tại.' });
    return;
  }
  res.json({ conversation: conv });
});

/**
 * PUT /api/conversations/:id — upsert (tạo nếu chưa có, ngược lại cập nhật). Dùng cho
 * auto-lưu. body: { title?, conversationId?, items?, cwd? }. Trả bản ghi sau lưu.
 */
app.put('/api/conversations/:id', (req, res) => {
  const { title, conversationId, items, cwd } = req.body ?? {};
  try {
    const conv = upsertConversation(
      req.params.id,
      {
        title: typeof title === 'string' ? title : undefined,
        conversationId:
          conversationId === null || typeof conversationId === 'string' ? conversationId : undefined,
        items: Array.isArray(items) ? items : undefined,
        cwd: typeof cwd === 'string' ? cwd : undefined,
      },
      Date.now(),
      getSocketIp(req), // R2: IP socket thật (không tin x-forwarded-for)
    );
    res.json({ ok: true, conversation: conv });
  } catch (err) {
    // Ghi đè cuộc của người khác → 403 (không phải lỗi server).
    const msg = (err as Error).message;
    res.status(/Không có quyền/.test(msg) ? 403 : 500).json({ error: msg });
  }
});

/** PATCH /api/conversations/:id — đổi tên. body: { title }. */
app.patch('/api/conversations/:id', (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title : '';
  if (!title.trim()) {
    res.status(400).json({ error: 'Thiếu tiêu đề.' });
    return;
  }
  const conv = renameConversation(req.params.id, title, Date.now(), getSocketIp(req)); // R2
  if (!conv) {
    res.status(404).json({ error: 'Cuộc trò chuyện không tồn tại.' });
    return;
  }
  res.json({ ok: true, conversation: conv });
});

/** DELETE /api/conversations/:id — xóa một cuộc (chỉ chủ hoặc admin). */
app.delete('/api/conversations/:id', (req, res) => {
  const ip = getSocketIp(req); // R2: IP socket thật cho phân quyền
  const ok = deleteConversation(req.params.id, ip);
  res.json({ ok, conversations: listConversations(ip) });
});

// ── Chat nhóm người-với-người (qua LAN) — xem chat.ts ────────────────────────
// Đồng nghiệp cùng mạng nhắn hỏi nhau ngay trong UI. Vào phòng bằng "mã phòng"
// (id), mỗi người có ID cá nhân + biệt danh. Tin lưu bền ra đĩa; realtime qua SSE.

/** GET /api/chat/groups — danh sách phòng chat (không kèm tin). */
app.get('/api/chat/groups', (_req, res) => {
  try {
    res.json({ groups: listGroups() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/chat/groups — vào (hoặc tạo) một phòng theo mã. body: { id, name? }.
 * Trả về phòng kèm lịch sử tin để client hiển thị ngay khi vào.
 */
app.post('/api/chat/groups', (req, res) => {
  const rawId = typeof req.body?.id === 'string' ? req.body.id : '';
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  if (!normalizeGroupId(rawId)) {
    res.status(400).json({ error: 'Thiếu mã phòng.' });
    return;
  }
  try {
    const group = getOrCreateGroup(rawId, name, Date.now());
    logAudit(`IP: ${getCleanIp(req)} - CHAT: vào phòng "${group.id}"`, getCleanIp(req));
    res.json({ group });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /api/chat/groups/:id — lấy một phòng kèm toàn bộ tin (cho người vào sau). */
app.get('/api/chat/groups/:id', (req, res) => {
  const group = getGroup(req.params.id);
  if (!group) {
    res.status(404).json({ error: 'Phòng chat không tồn tại.' });
    return;
  }
  res.json({ group });
});

/**
 * POST /api/chat/groups/:id/messages — gửi một tin. body: { userId, nickname, text }.
 * Lưu đĩa rồi broadcast realtime tới mọi người đang mở phòng.
 */
app.post('/api/chat/groups/:id/messages', (req, res) => {
  const { userId, nickname, text } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'Tin nhắn rỗng.' });
    return;
  }
  try {
    const { group, message } = addMessage(
      req.params.id,
      {
        userId: typeof userId === 'string' ? userId : '',
        nickname: typeof nickname === 'string' ? nickname : '',
        text,
      },
      Date.now(),
    );
    // Bơm tin đã lưu tới mọi người trong phòng (kể cả chính người gửi → xác nhận đã gửi).
    chatBus.publish(group.id, { type: 'message', message });
    res.json({ ok: true, message });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /api/chat/groups/:id/events — SSE realtime tin nhắn của một phòng. */
app.get('/api/chat/groups/:id/events', (req, res) => {
  const groupId = normalizeGroupId(req.params.id);
  if (!groupId) {
    res.status(400).json({ error: 'Thiếu mã phòng.' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  const unsubscribe = chatBus.subscribe(groupId, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  // Keep-alive: comment ping mỗi 25s để proxy/LAN không tự đóng stream nhàn rỗi.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

const PORT = Number(process.env.BOW_AGENT_PORT ?? 4000);
app.listen(PORT, () => {
  process.stdout.write(`\n🌐 bow-agent web API chạy tại http://localhost:${PORT}\n`);
  if (isQcMode) {
    process.stdout.write(`   ⚠️ QC MODE ĐANG BẬT (read-only + Skill + Jira) - CHỈ HỎI ĐÁP/CHẤM TICKET, KHÔNG SỬA SOURCE\n`);
    process.stdout.write(`   Để chia sẻ với đồng nghiệp, chạy frontend bằng: npm run ui:web -- --host\n\n`);
  } else if (isReviewerMode) {
    process.stdout.write(`   ⚠️ REVIEWER MODE ĐANG BẬT (read-only + gh pr review) - REVIEW/COMMENT/APPROVE PR, KHÔNG SỬA CODE\n`);
    process.stdout.write(`   Để chia sẻ với đồng nghiệp, chạy frontend bằng: npm run ui:web -- --host\n\n`);
  } else if (isDevOpsMode) {
    process.stdout.write(`   ⚠️ DEVOPS MODE ĐANG BẬT (ghi file hạ tầng + deploy treo admin duyệt) - KHÔNG SỬA SOURCE ỨNG DỤNG\n`);
    process.stdout.write(`   Để chia sẻ với đồng nghiệp, chạy frontend bằng: npm run ui:web -- --host\n\n`);
  } else {
    process.stdout.write(`   (dev frontend: chạy \`npm run ui:web\` rồi mở http://localhost:5173)\n\n`);
  }
});
