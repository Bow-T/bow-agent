import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { runAgent, fetchUsageSnapshot } from '../core/runner.js';
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
import { loadClaudeCodeMcp, listGlobalMcp, addGlobalMcp, removeGlobalMcp } from '../tools/mcp.js';
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

/** IP client đã chuẩn hoá (::1 / ::ffff:127.0.0.1 → 127.0.0.1, lấy IP đầu nếu qua proxy). */
function getCleanIp(req: express.Request): string {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (Array.isArray(ip)) ip = ip[0];
  let cleanIp = typeof ip === 'string' ? ip : '';
  if (cleanIp.includes(',')) {
    cleanIp = cleanIp.split(',')[0].trim();
  }
  if (cleanIp === '::1' || cleanIp === '::ffff:127.0.0.1') return '127.0.0.1';
  if (cleanIp.startsWith('::ffff:')) return cleanIp.slice(7);
  return cleanIp;
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

const isSafeMode = process.env.BOW_SAFE_MODE === 'true';
// Thư mục source cố định cho Safe Mode (QC hỏi đáp read-only). Cho phép trỏ tới
// một repo khác (vd monorepo) mà không cần chạy server TỪ trong repo đó:
//   BOW_SAFE_MODE=true BOW_SAFE_CWD=/path/to/monorepo npm run ui:safe
// Mặc định = process.cwd() (thư mục đang chạy server). Admin đổi lúc chạy qua
// POST /api/safe-cwd (không cần restart) → lưu vào safeCwdOverride.
let safeCwdOverride: string | null = null;
const safeCwd = () => resolve(safeCwdOverride || process.env.BOW_SAFE_CWD || process.cwd());

// Collab Mode: cộng tác viên (CTV) qua LAN code gần như dev, nhưng lệnh HỦY HOẠI
// (rm -rf, deploy, ghi ngoài repo…) phải được ADMIN (localhost) duyệt từ xa. Git
// được tự do. Không đổi được MCP/workspace config (như Safe Mode). Khác Safe Mode ở
// chỗ: Safe Mode = read-only tuyệt đối; Collab = ghi được, chỉ gác thao tác nguy hiểm.
//   BOW_COLLAB_MODE=true BOW_COLLAB_CWD=/path/to/repo npm run ui:collab
const isCollabMode = process.env.BOW_COLLAB_MODE === 'true';
// Repo cố định cho Collab (tương tự BOW_SAFE_CWD). Mặc định = cwd chạy server.
const collabCwd = () => resolve(process.env.BOW_COLLAB_CWD || process.cwd());

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
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

// Chặn đổi cấu hình (MCP/workspace) ở CẢ Safe Mode LẪN Collab Mode — cả hai đều không
// cho client đổi hạ tầng agent. (Safe = read-only; Collab = ghi code nhưng khoá config.)
const checkSafeMode = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (isSafeMode || isCollabMode) {
    const cleanIp = getCleanIp(req);
    const modeName = isSafeMode ? 'Safe Mode' : 'Collab Mode';
    logAudit(`IP: ${cleanIp} - BỊ CHẶN: Thao tác ${req.method} ${req.originalUrl} bị chặn trong ${modeName}.`, cleanIp);
    res.status(403).json({ error: `Thao tác bị chặn trong chế độ ${modeName} (không đổi được cấu hình).` });
    return;
  }
  next();
};

/** Admin = truy cập từ localhost. Chỉ admin xem/đổi cấu hình LAN, log, chọn source. */
function isAdminReq(req: express.Request): boolean {
  return getCleanIp(req) === '127.0.0.1';
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
  const cleanIp = getCleanIp(req);
  const user = requestAccess(name, cleanIp);
  
  logAudit(`Yêu cầu truy cập mới: Tên="${name}", IP="${cleanIp}"`, cleanIp, name);
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
      conversationId,
      resumeContext,
    } = req.body ?? {};

    // Repo cố định theo mode: Safe → safeCwd, Collab → collabCwd; thường → cwd client gửi.
    const workdir = isSafeMode ? safeCwd() : isCollabMode ? collabCwd() : (cwd || process.cwd());
    const cleanIp = getCleanIp(req);
    const auditMode = isSafeMode ? 'plan' : isCollabMode ? 'auto (collab)' : mode;
    logAudit(`IP: ${cleanIp} - YÊU CẦU CHẠY: CWD=${workdir}, Mode=${auditMode}, Brief=${JSON.stringify(text || jiraRef || 'N/A')}`, cleanIp);

    let activeJiraRef = jiraRef;
    if (!activeJiraRef && text) {
      const parsed = parseJiraRef(text);
      if (parsed.kind !== 'none') {
        activeJiraRef = text;
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
      const isPureJiraRef = text ? text.trim() === activeJiraRef.trim() : true;
      if (isPureJiraRef || jiraRef) {
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
      text,
      jiraRef,
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
    // Safe Mode → ép 'plan' (read-only). Collab Mode → ép 'auto' (ghi tự do, chỉ gác lệnh
    // hủy hoại — được định tuyến duyệt lên admin bên dưới).
    const VALID_MODES = new Set(['plan', 'manual', 'edit-auto', 'auto']);
    const requestedMode = isSafeMode ? 'plan' : isCollabMode ? 'auto' : mode;
    const runMode: 'plan' | 'manual' | 'edit-auto' | 'auto' =
      requestedMode === 'execute'
        ? 'manual'
        : VALID_MODES.has(requestedMode)
          ? (requestedMode as 'plan' | 'manual' | 'edit-auto' | 'auto')
          : 'plan';
    const isExecuting = runMode !== 'plan';

    // Safe/QC Mode chỉ hỏi đáp read-only → luôn ép Sonnet (nhẹ/rẻ), KHÔNG tin model
    // client gửi. Tránh lỡ dùng Opus 4.8 khi client cũ/lỗi hoặc localStorage còn Opus.
    const effectiveModel = isSafeMode ? 'claude-sonnet-5' : model;

    // Cổng duyệt cho phiên này. Collab Mode + CTV (không phải admin localhost): lệnh hủy
    // hoại được ĐỊNH TUYẾN lên ADMIN qua adminBus — CTV không tự duyệt được. Còn lại
    // (mọi mode thường, hoặc chính admin chạy Collab tại localhost) dùng cổng của phiên.
    const routeToAdmin = isCollabMode && cleanIp !== '127.0.0.1';
    const approvalHandler = routeToAdmin
      ? (toolName: string, input: Record<string, unknown>, meta?: { title?: string; description?: string; blockedPath?: string; decisionReason?: string }) => {
          logAudit(`IP: ${cleanIp} - COLLAB xin ADMIN duyệt: session=${session.id}, tool=${toolName}`, cleanIp, clientName);
          return adminBus.requestApproval({
            sessionId: session.id,
            clientIp: cleanIp,
            toolName,
            input,
            title: meta?.title,
            description: meta?.description,
            decisionReason: meta?.decisionReason,
          });
        }
      : (toolName: string, input: Record<string, unknown>, meta?: { title?: string; description?: string; blockedPath?: string; decisionReason?: string }) =>
          session.requestApproval(toolName, input, meta);

    // Chạy agent nền; đẩy sự kiện vào session queue.
    runAgent({
      brief,
      cwd: workdir,
      mode: runMode,
      collabMode: isCollabMode,
      effort: effort ?? 'high',
      language: language === 'en' ? 'en' : 'vi',
      projectProfile,
      images: uploadImages.length > 0 ? uploadImages : undefined,
      mcpServers: effectiveMcp.length > 0 ? effectiveMcp : undefined,
      abortSignal: session.abort.signal,
      onEvent: (ev) => session.push(ev),
      onApproval: isExecuting ? approvalHandler : undefined,
      // AskUserQuestion hoạt động ở mọi mode (kể cả plan) để agent làm rõ yêu cầu.
      onQuestion: (questions) => session.requestQuestion(questions),
      model: effectiveModel,
      resumeSessionId,
      // Bắt session_id THẬT của SDK → đẩy lên client để lưu, lượt sau resume đúng phiên.
      onSessionId: (conversationId) => session.push({ type: 'conversation', conversationId }),
    })
      .then((result) => {
        const sessionIp = (session as any).clientIp;
        const sessionName = (session as any).clientName;
        logAudit(`IP: ${sessionIp || 'unknown'} - Session ${session.id} HOÀN THÀNH. Result length: ${result?.length ?? 0}`, sessionIp, sessionName);
        session.push({ type: 'done', result });
      })
      .catch((err: unknown) => {
        const sessionIp = (session as any).clientIp;
        const sessionName = (session as any).clientName;
        logAudit(`IP: ${sessionIp || 'unknown'} - Session ${session.id} THẤT BẠI: ${(err as Error).message}`, sessionIp, sessionName);
        session.push({ type: 'fatal', message: (err as Error).message });
      })
      .finally(() => {
        session.close();
        // Phiên đóng: gỡ mọi yêu cầu duyệt Collab còn treo trên admin bus (khỏi nút "ma").
        if (routeToAdmin) adminBus.rejectForSession(session.id);
      });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /api/session/:id — kiểm tra phiên chạy có tồn tại không. */
app.get('/api/session/:id', (req, res) => {
  const session = getSession(req.params.id);
  res.json({ exists: Boolean(session) });
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

/** GET /api/config — thông tin cấu hình cho UI (MCP, cwd). Model do web tự chọn. */
app.get('/api/config', (req, res) => {
  const cc = loadClaudeCodeMcp();
  const localIp = getLocalIp();
  
  const isAdmin = isAdminReq(req);

  // Source bị khoá theo mode: Safe → safeCwd, Collab → collabCwd; thường → cwd server.
  const effectiveCwd = isSafeMode ? safeCwd() : isCollabMode ? collabCwd() : process.cwd();
  // Cổng web LAN theo bản đang chạy (BOW_WEB_PORT: dev 5173 / share 5174 / collab 5175).
  const webPort = process.env.BOW_WEB_PORT || '5173';
  res.json({
    defaultCwd: effectiveCwd,
    // Tên repo (basename của cwd) — dùng cho banner "Đang hỏi đáp source: <repo>"
    // ở chế độ Safe Mode, để QC luôn biết mình đang hỏi ở source nào.
    repoName: basename(effectiveCwd),
    mcpServers: cc.names,
    lanUrl: `http://${localIp}:${webPort}`,
    isSafeMode,
    isCollabMode,
    isAdmin,
  });
});

/**
 * POST /api/safe-cwd — Admin đổi thư mục source mà QC hỏi đáp (chỉ Safe Mode).
 * body: { cwd }. Chỉ Admin (localhost) mới đổi được; không cần restart server.
 */
app.post('/api/safe-cwd', requireAdmin, (req, res) => {
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
  safeCwdOverride = dir;
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

/** GET /api/mcp — liệt kê MCP server đã cấu hình (che token, chỉ trả tên env key). */
app.get('/api/mcp', (_req, res) => {
  try {
    res.json({ servers: listGlobalMcp() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** POST /api/mcp — thêm MCP server stdio mới. body: {name, command, args?, env?} */
app.post('/api/mcp', checkSafeMode, (req, res) => {
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
app.delete('/api/mcp/:name', checkSafeMode, (req, res) => {
  try {
    removeGlobalMcp(req.params.name);
    res.json({ ok: true, servers: listGlobalMcp() });
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
app.post('/api/workspace/repo', checkSafeMode, (req, res) => {
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
app.delete('/api/workspace/repo', checkSafeMode, (req, res) => {
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
app.put('/api/workspace/:slug/shared', checkSafeMode, (req, res) => {
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
app.post('/api/generate-profile', async (req, res) => {
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
app.post('/api/analyze-structure', (req, res) => {
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
    res.json({ conversations: listConversations(getCleanIp(req)) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /api/conversations/:id — lấy đầy đủ một cuộc (kèm items + conversationId).
 *  Chỉ chủ cuộc hoặc admin đọc được (tránh QC đọc chéo cuộc của người khác). */
app.get('/api/conversations/:id', (req, res) => {
  const conv = getConversation(req.params.id, getCleanIp(req));
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
      getCleanIp(req),
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
  const conv = renameConversation(req.params.id, title, Date.now(), getCleanIp(req));
  if (!conv) {
    res.status(404).json({ error: 'Cuộc trò chuyện không tồn tại.' });
    return;
  }
  res.json({ ok: true, conversation: conv });
});

/** DELETE /api/conversations/:id — xóa một cuộc (chỉ chủ hoặc admin). */
app.delete('/api/conversations/:id', (req, res) => {
  const ip = getCleanIp(req);
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
  if (isSafeMode) {
    process.stdout.write(`   ⚠️ CHẾ ĐỘ AN TOÀN ĐANG BẬT (Safe/LAN Share Mode) - CHỈ CHO PHÉP HỎI ĐÁP/LẬP KẾ HOẠCH\n`);
    process.stdout.write(`   Để chia sẻ với đồng nghiệp, chạy frontend bằng: npm run ui:web -- --host\n\n`);
  } else {
    process.stdout.write(`   (dev frontend: chạy \`npm run ui:web\` rồi mở http://localhost:5173)\n\n`);
  }
});
