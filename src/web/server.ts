import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import fs from 'node:fs';
import { runAgent, fetchUsageSnapshot } from '../core/runner.js';
import { buildTaskBrief } from '../input/task.js';
import { pdfToText } from '../input/pdf.js';
import { getProfile } from '../profiles/index.js';
import { detectSource } from '../profiles/detect.js';
import { generateProfile, analyzeStructure } from '../profiles/generate.js';
import { createSession, getSession, removeSession } from './session.js';
import {
  listConversations,
  getConversation,
  upsertConversation,
  renameConversation,
  deleteConversation,
} from './conversations.js';
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

    const workdir = cwd || process.cwd();

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
    // sessionId (lớp web/SSE) trả ngay để client mở stream. conversationId THẬT của SDK
    // đến sau qua event 'conversation' (bắt từ system/init) — client lưu để resume lượt sau.
    res.json({ sessionId: session.id });

    // Nếu client gửi kèm conversationId (đang tiếp nối phiên cũ) thì resume phiên đó.
    const resumeSessionId =
      typeof conversationId === 'string' && conversationId ? conversationId : undefined;

    // 4 mode kiểu Claude. Nhận cả tên cũ 'execute' (→ 'manual') để tương thích client cũ.
    // Mọi mode ngoài 'plan' đều là "đang thực thi" (có cổng duyệt theo policy của runner).
    const VALID_MODES = new Set(['plan', 'manual', 'edit-auto', 'auto']);
    const runMode: 'plan' | 'manual' | 'edit-auto' | 'auto' =
      mode === 'execute'
        ? 'manual'
        : VALID_MODES.has(mode)
          ? (mode as 'plan' | 'manual' | 'edit-auto' | 'auto')
          : 'plan';
    const isExecuting = runMode !== 'plan';

    // Chạy agent nền; đẩy sự kiện vào session queue.
    runAgent({
      brief,
      cwd: workdir,
      mode: runMode,
      effort: effort ?? 'high',
      language: language === 'en' ? 'en' : 'vi',
      projectProfile,
      images: uploadImages.length > 0 ? uploadImages : undefined,
      mcpServers: effectiveMcp.length > 0 ? effectiveMcp : undefined,
      abortSignal: session.abort.signal,
      onEvent: (ev) => session.push(ev),
      onApproval: isExecuting
        ? (toolName, input, meta) => session.requestApproval(toolName, input, meta)
        : undefined,
      // AskUserQuestion hoạt động ở mọi mode (kể cả plan) để agent làm rõ yêu cầu.
      onQuestion: (questions) => session.requestQuestion(questions),
      model,
      resumeSessionId,
      // Bắt session_id THẬT của SDK → đẩy lên client để lưu, lượt sau resume đúng phiên.
      onSessionId: (conversationId) => session.push({ type: 'conversation', conversationId }),
    })
      .then((result) => session.push({ type: 'done', result }))
      .catch((err: unknown) => session.push({ type: 'fatal', message: (err as Error).message }))
      .finally(() => session.close());
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

/** POST /api/approve — duyệt/từ chối một thao tác ghi. body: { sessionId, id, approved } */
app.post('/api/approve', (req, res) => {
  const { sessionId, id, approved } = req.body ?? {};
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
  const session = getSession(req.params.id);
  if (session) {
    session.abort.abort();
    session.close();
  }
  res.json({ ok: Boolean(session) });
});

/** GET /api/config — thông tin cấu hình cho UI (MCP, cwd). Model do web tự chọn. */
app.get('/api/config', (_req, res) => {
  const cc = loadClaudeCodeMcp();
  res.json({
    defaultCwd: process.cwd(),
    mcpServers: cc.names,
  });
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
app.post('/api/mcp', (req, res) => {
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
app.delete('/api/mcp/:name', (req, res) => {
  try {
    removeGlobalMcp(req.params.name);
    res.json({ ok: true, servers: listGlobalMcp() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /api/browse-dirs?path=... — duyệt thư mục local. */
app.get('/api/browse-dirs', (req, res) => {
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
app.post('/api/workspace/repo', (req, res) => {
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
app.delete('/api/workspace/repo', (req, res) => {
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
app.put('/api/workspace/:slug/shared', (req, res) => {
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

/** GET /api/conversations — danh sách cuộc (không kèm items), mới nhất lên đầu. */
app.get('/api/conversations', (_req, res) => {
  try {
    res.json({ conversations: listConversations() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /api/conversations/:id — lấy đầy đủ một cuộc (kèm items + conversationId). */
app.get('/api/conversations/:id', (req, res) => {
  const conv = getConversation(req.params.id);
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
    );
    res.json({ ok: true, conversation: conv });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** PATCH /api/conversations/:id — đổi tên. body: { title }. */
app.patch('/api/conversations/:id', (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title : '';
  if (!title.trim()) {
    res.status(400).json({ error: 'Thiếu tiêu đề.' });
    return;
  }
  const conv = renameConversation(req.params.id, title, Date.now());
  if (!conv) {
    res.status(404).json({ error: 'Cuộc trò chuyện không tồn tại.' });
    return;
  }
  res.json({ ok: true, conversation: conv });
});

/** DELETE /api/conversations/:id — xóa một cuộc. */
app.delete('/api/conversations/:id', (req, res) => {
  const ok = deleteConversation(req.params.id);
  res.json({ ok, conversations: listConversations() });
});

const PORT = Number(process.env.BOW_AGENT_PORT ?? 4000);
app.listen(PORT, () => {
  process.stdout.write(`\n🌐 bow-agent web API chạy tại http://localhost:${PORT}\n`);
  process.stdout.write(`   (dev frontend: chạy \`npm run ui:web\` rồi mở http://localhost:5173)\n\n`);
});
