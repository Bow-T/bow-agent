import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import fs from 'node:fs';
import { runAgent } from '../core/runner.js';
import { buildTaskBrief } from '../input/task.js';
import { pdfToText } from '../input/pdf.js';
import { getProfile } from '../profiles/index.js';
import { detectSource } from '../profiles/detect.js';
import { generateProfile } from '../profiles/generate.js';
import { config } from '../config/env.js';
import { createSession, getSession, removeSession } from './session.js';
import { loadClaudeCodeMcp } from '../tools/mcp.js';


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
      newProject,
      mcpServers,
      mode,
      profile,
      effort,
      cwd,
      model,
    } = req.body ?? {};

    const workdir = cwd || process.cwd();

    if (jiraRef && !config.jiraConfigured) {
      res.status(400).json({ error: 'Có Jira ref nhưng chưa cấu hình JIRA_* trong .env.' });
      return;
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

    const brief = await buildTaskBrief({
      text,
      jiraRef,
      docs: allDocs,
      imageCount: Array.isArray(images) ? images.length : 0,
    });
    if (!brief) {
      res.status(400).json({ error: 'Cần ít nhất một trong: text, Jira ref, tài liệu, ảnh.' });
      return;
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
    res.json({ sessionId: session.id });

    const runMode: 'plan' | 'execute' = mode === 'execute' ? 'execute' : 'plan';

    // Chạy agent nền; đẩy sự kiện vào session queue.
    runAgent({
      brief,
      cwd: workdir,
      mode: runMode,
      effort: effort ?? 'high',
      projectProfile,
      images: Array.isArray(images) ? images : undefined,
      newProject: Boolean(newProject),
      mcpServers: Array.isArray(mcpServers) ? mcpServers : undefined,
      abortSignal: session.abort.signal,
      onEvent: (ev) => session.push(ev),
      onApproval:
        runMode === 'execute'
          ? (toolName, input, meta) => session.requestApproval(toolName, input, meta)
          : undefined,
      model,
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

/** POST /api/stop/:id — dừng agent giữa chừng. */
app.post('/api/stop/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (session) {
    session.abort.abort();
    session.close();
  }
  res.json({ ok: Boolean(session) });
});

/** GET /api/config — thông tin cấu hình cho UI (model, jira, auth, profiles). */
app.get('/api/config', (_req, res) => {
  const cc = loadClaudeCodeMcp();
  res.json({
    model: config.model,
    jiraConfigured: config.jiraConfigured,
    authSource: config.authSource, // 'api-key' | 'claude-cli' | 'none'
    defaultCwd: process.cwd(),
    mcpServers: cc.names,
  });
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

const PORT = Number(process.env.BOW_AGENT_PORT ?? 4000);
app.listen(PORT, () => {
  process.stdout.write(`\n🌐 bow-agent web API chạy tại http://localhost:${PORT}\n`);
  process.stdout.write(`   (dev frontend: chạy \`npm run ui:web\` rồi mở http://localhost:5173)\n\n`);
});
