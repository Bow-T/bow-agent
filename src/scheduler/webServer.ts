import express from 'express';
import { config } from '../config/env.js';
import { runSprintScan, parseTriage } from './sprintScan.js';
import {
  loadSchedule,
  saveSchedule,
  loadRunHistory,
  isDue,
  schedulePath,
  type SprintSchedule,
} from './schedule.js';
import { plistPath } from './launchd.js';
import { loadClaudeCodeMcp } from '../tools/mcp.js';
import { listSprints, listSprintIssues } from './jiraApi.js';
import { existsSync, readFileSync } from 'node:fs';
import type { AgentEvent } from '../core/runner.js';

/**
 * Đọc "context kết nối" để HIỂN THỊ rõ trên dashboard (agent KHÔNG tự đoán gì — mọi thứ do
 * config chỉ định, người dùng cần thấy để tránh chạy nhầm). Trả 3 thứ:
 *  - jiraBaseUrl: Atlassian workspace agent sẽ đọc (từ env server 'jira' trong mcp.json).
 *  - jiraServers: tên các MCP jira nạp được (thường là 'jira').
 *  - Không kèm token — chỉ URL/tên để nhận diện.
 */
function readConnectionContext(): { jiraBaseUrl: string | null; mcpNames: string[] } {
  const mcp = loadClaudeCodeMcp();
  let jiraBaseUrl: string | null = null;
  try {
    const raw = JSON.parse(readFileSync(config.mcpConfigPath, 'utf8')) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
    };
    for (const [name, cfg] of Object.entries(raw.mcpServers ?? {})) {
      if (name.includes('jira') && cfg.env) {
        jiraBaseUrl = cfg.env.JIRA_BASE_URL || cfg.env.JIRA_URL || null;
        if (jiraBaseUrl) break;
      }
    }
  } catch {
    /* file thiếu/hỏng — để null, dashboard báo "không đọc được" */
  }
  return { jiraBaseUrl, mcpNames: mcp.names };
}

/**
 * WEB SERVER cho sprint-scan (cổng riêng, mặc định 4006). Hai chức năng như người dùng chốt:
 *  1. DASHBOARD theo dõi — lịch đang cấu hình, trạng thái launchd, lịch sử các lượt quét +
 *     kết quả triage mới nhất.
 *  2. KÍCH 1 lượt quét ("Quét ngay") và xem log realtime qua SSE.
 *
 * TÁCH KHỎI server.ts (2200+ dòng, 6 mode chat LAN) vì sprint-scan khác bản chất: nó là agent
 * TỰ CHẠY theo lịch, không phải phiên chat người-gõ. Nhồi vào đó thành mode thứ 7 sẽ phải mượn
 * cả bộ máy access-token/SSE-chat không cần thiết. Server nhỏ này chỉ phục vụ dashboard + 1 SSE.
 *
 * AN TOÀN: mặc định CHỈ nghe localhost (admin tự xem trên máy mình). Muốn chia sẻ LAN thì đặt
 * BOW_SPRINT_WEB_HOST=0.0.0.0 — nhưng nút "Quét ngay" ở chế độ execute sẽ tự sửa code/Jira, nên
 * để LAN mở cần cân nhắc. Không có nút đổi lịch từ web (tránh client LAN sửa lịch tự-chạy); đổi
 * lịch vẫn qua CLI `bow schedule set`. Web chỉ XEM + kích lượt.
 */

const PORT = Number(process.env.BOW_SPRINT_WEB_PORT || '4006');
const HOST = process.env.BOW_SPRINT_WEB_HOST || '127.0.0.1';

/** Có một lượt quét đang chạy không (chặn kích song song — Jira/agent không nên chạy chồng). */
let scanning = false;

export function startSprintWebServer(): void {
  const app = express();
  app.use(express.json());

  // Dashboard HTML (tự chứa, không cần build frontend). Nhẹ, đủ để theo dõi + kích.
  app.get('/', (_req, res) => {
    res.type('html').send(DASHBOARD_HTML);
  });

  // Trạng thái tổng: lịch + launchd + lịch sử.
  app.get('/api/status', (_req, res) => {
    const sched = loadSchedule();
    const history = loadRunHistory();
    const due = sched ? isDue(sched, new Date()) : null;
    const ctx = readConnectionContext();
    res.json({
      schedule: sched,
      schedulePath: schedulePath(),
      launchdInstalled: existsSync(plistPath()),
      launchdPath: plistPath(),
      due: due?.due ?? false,
      dueReason: due?.reason ?? 'chưa cấu hình lịch',
      scanning,
      history,
      projectDefault: config.defaultProjectKey ?? null,
      // CONTEXT KẾT NỐI — hiển thị rõ agent đang trỏ đâu (không đoán, do config chỉ định).
      jiraBaseUrl: ctx.jiraBaseUrl,
      mcpNames: ctx.mcpNames,
      // Folder code hiệu lực: lịch chỉ định > BOW_CWD/process.cwd (defaultCwd).
      effectiveCwd: sched?.cwd || config.defaultCwd,
    });
  });

  // Chỉ admin (localhost) mới đổi/cài lịch — client LAN không được sửa lịch tự-chạy.
  const isLocal = (req: express.Request): boolean =>
    req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1';

  // Bật/tắt lịch nhanh (chỉ toggle enabled). Chỉ localhost.
  app.post('/api/schedule/toggle', (req, res) => {
    if (!isLocal(req)) {
      res.status(403).json({ error: 'Chỉ admin (localhost) đổi được lịch.' });
      return;
    }
    const sched = loadSchedule();
    if (!sched) {
      res.status(400).json({ error: 'Chưa có lịch. Đặt lịch ở form bên dưới trước.' });
      return;
    }
    const next: SprintSchedule = { ...sched, enabled: !sched.enabled };
    saveSchedule(next);
    res.json({ enabled: next.enabled });
  });

  // ĐẶT/SỬA lịch từ UI (thay cho phải gõ CLI `bow schedule set`). Chỉ localhost.
  app.post('/api/schedule/set', (req, res) => {
    if (!isLocal(req)) {
      res.status(403).json({ error: 'Chỉ admin (localhost) đặt được lịch.' });
      return;
    }
    const b = req.body as {
      projectKey?: string; atTimes?: string[]; dryRun?: boolean; allowAssign?: boolean;
      effort?: string; cwd?: string;
    };
    const atTimes = (b.atTimes ?? []).map((s) => String(s).trim()).filter(Boolean);
    // Validate HH:MM.
    const bad = atTimes.find((t) => !/^([01]?\d|2[0-3]):[0-5]\d$/.test(t));
    if (bad) { res.status(400).json({ error: `Mốc giờ không hợp lệ: "${bad}" (dùng HH:MM).` }); return; }
    if (!atTimes.length) { res.status(400).json({ error: 'Cần ít nhất một mốc giờ (HH:MM).' }); return; }
    const projectKey = (b.projectKey || '').trim() || config.defaultProjectKey;
    if (!projectKey) { res.status(400).json({ error: 'Cần project key.' }); return; }

    const existing = loadSchedule();
    const next: SprintSchedule = {
      enabled: true,
      projectKey,
      cwd: (b.cwd || '').trim() || existing?.cwd,
      atTimes,
      weekdays: existing?.weekdays,
      dryRun: b.dryRun !== false, // mặc định dry-run
      allowAssign: Boolean(b.allowAssign),
      effort: (b.effort as SprintSchedule['effort']) || existing?.effort || 'high',
      extraJql: existing?.extraJql,
      lastRunAt: existing?.lastRunAt,
    };
    saveSchedule(next);
    res.json({ ok: true, schedule: next });
  });

  // CÀI LaunchAgent (macOS) từ UI — để lịch tự chạy theo giờ mà không cần gõ CLI.
  app.post('/api/schedule/install-launchd', async (req, res) => {
    if (!isLocal(req)) {
      res.status(403).json({ error: 'Chỉ admin (localhost) cài được launchd.' });
      return;
    }
    if (process.platform !== 'darwin') {
      res.status(400).json({ error: 'Chỉ hỗ trợ macOS (launchd). Linux dùng cron.' });
      return;
    }
    if (!loadSchedule()) {
      res.status(400).json({ error: 'Chưa có lịch. Đặt lịch trước rồi mới cài.' });
      return;
    }
    try {
      const { installLaunchd } = await import('./launchd.js');
      const { fileURLToPath } = await import('node:url');
      const { resolve, dirname } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const useDist = existsSync(resolve(here, 'index.js')) && here.includes('dist');
      const cliEntry = useDist ? resolve(here, 'webMain.js') : resolve(here, 'webMain.ts');
      // launchd gọi CLI sprint-scan --tick, không phải webMain. Trỏ tới cli/index.
      const cliDir = useDist ? resolve(here, '../cli') : resolve(here, '../cli');
      const entry = resolve(cliDir, useDist ? 'index.js' : 'index.ts');
      const result = installLaunchd({
        cliEntry: entry,
        tsxLoader: useDist ? undefined : 'tsx',
        cwd: loadSchedule()?.cwd || config.defaultCwd,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Liệt kê SPRINT của project (active/future/closed) — để người dùng CHỌN, không để agent tự lấy active.
  app.get('/api/sprints', async (req, res) => {
    const projectKey = (req.query.project as string) || loadSchedule()?.projectKey || config.defaultProjectKey;
    if (!projectKey) {
      res.status(400).json({ error: 'Cần ?project=KEY.' });
      return;
    }
    try {
      res.json({ projectKey, sprints: await listSprints(projectKey) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Liệt kê ISSUE trong một sprint — để người dùng DUYỆT từng ticket trước khi cho làm.
  app.get('/api/sprint-issues', async (req, res) => {
    const sprintId = Number(req.query.sprint);
    if (!sprintId) {
      res.status(400).json({ error: 'Cần ?sprint=<id>.' });
      return;
    }
    try {
      res.json({ sprintId, issues: await listSprintIssues(sprintId) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // KÍCH 1 lượt quét, stream log qua SSE. Chế độ (dry-run/execute) LẤY TỪ LỊCH đã cấu hình —
  // web không cho tự nâng lên execute (tránh bấm nhầm tự-sửa-code). Chưa có lịch → dry-run mặc định.
  // Query: ?project= &sprint=<id> &sprintName= &keys=KEY1,KEY2 (ticket đã duyệt — chỉ làm đúng các key).
  app.get('/api/scan', async (req, res) => {
    // LUÔN mở SSE 200 — KHÔNG trả HTTP 400. Lý do: EventSource coi non-200 là lỗi kết nối rồi
    // TỰ RETRY liên tục (chính là cơn bão 400 trong console). Ta mở stream 200, báo lỗi qua event
    // 'error' để client hiển thị + close(), không có retry.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (scanning) {
      send('error', { message: 'Đang có một lượt quét chạy. Chờ nó xong.' });
      res.end();
      return;
    }
    const sched = loadSchedule();
    const projectKey = (req.query.project as string) || sched?.projectKey || config.defaultProjectKey;
    if (!projectKey) {
      send('error', {
        message: 'Chưa biết project. Cấu hình lịch (bow schedule set) hoặc chọn project ở ô trên.',
      });
      res.end();
      return;
    }

    // Sprint + ticket người dùng đã chọn/duyệt (từ UI 2 pha). Rỗng = hành vi cũ (agent tự lấy).
    const sprintId = Number(req.query.sprint) || 0;
    const sprintName = (req.query.sprintName as string) || '';
    const keys = ((req.query.keys as string) || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    scanning = true;
    send('start', {
      projectKey,
      dryRun: sched?.dryRun ?? true,
      at: new Date().toISOString(),
      sprint: sprintName || undefined,
      ticketCount: keys.length || undefined,
    });
    try {
      const summary = await runSprintScan({
        projectKey,
        cwd: sched?.cwd || config.defaultCwd,
        effort: sched?.effort ?? 'high',
        dryRun: sched?.dryRun ?? true,
        allowAssign: sched?.allowAssign ?? false,
        extraJql: sched?.extraJql,
        sprint: sprintId ? { id: sprintId, name: sprintName || `sprint ${sprintId}` } : undefined,
        onlyKeys: keys.length ? keys : undefined,
        trigger: 'manual',
        onEvent: (ev: AgentEvent) => {
          if (ev.type === 'text') send('text', { text: ev.text });
          else if (ev.type === 'tool') send('tool', { describe: ev.describe });
          else if (ev.type === 'result') send('result', { costUsd: ev.costUsd, turns: ev.turns });
          else if (ev.type === 'error') send('agent-error', { subtype: ev.subtype });
        },
      });
      // Tách thẻ triage từ summary để client vẽ ngay (khỏi chờ refresh history).
      send('done', { summary, triage: parseTriage(summary) });
    } catch (err) {
      send('error', { message: (err as Error).message });
    } finally {
      scanning = false;
      res.end();
    }
  });

  app.listen(PORT, HOST, () => {
    const shareHint =
      HOST === '127.0.0.1'
        ? '(chỉ localhost — đặt BOW_SPRINT_WEB_HOST=0.0.0.0 để chia sẻ LAN)'
        : '(đang mở LAN)';
    process.stdout.write(
      `\n📊 Sprint-scan dashboard: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} ${shareHint}\n\n`,
    );
  });
}

// ── Dashboard HTML (tự chứa: CSS + JS inline, không phụ thuộc build) ──
const DASHBOARD_HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#fbf6e9">
<title>Sprint-scan · Bow</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%230a0a0a'/%3E%3Crect x='3' y='3' width='26' height='26' fill='%23ffcf24'/%3E%3Crect x='9' y='9' width='14' height='14' fill='%230a0a0a'/%3E%3Crect x='14' y='14' width='4' height='4' fill='%23ffcf24'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
<script>
  // Đặt theme TRƯỚC khi vẽ (chống FOUC) — DÙNG CHUNG localStorage với UI chính:
  // 'bow-theme' (brutal|figma) + 'bow-accent'. Nhờ vậy dashboard đổi theme đồng bộ với web chính.
  (function () {
    try {
      var t = localStorage.getItem('bow-theme');
      if (t === 'newsprint') t = 'figma';
      if (t !== 'brutal' && t !== 'figma') t = 'brutal';
      document.documentElement.setAttribute('data-theme', t);
      var a = localStorage.getItem('bow-accent');
      if (a && a !== 'brass') document.documentElement.setAttribute('data-accent', a);
    } catch (e) { document.documentElement.setAttribute('data-theme', 'brutal'); }
  })();
</script>
<style>
  /* Token DÙNG CHUNG với UI chính (web/styles.css). KHÔNG hardcode màu — chỉ khai lại các
     token nền tảng cho 2 theme brutal/figma để dashboard này (HTML rời) khớp phong cách. */
  :root, [data-theme='brutal'] {
    --bg:#fbf6e9; --surface:#fffdf5; --surface-2:#fdf3d6; --ink:#0a0a0a; --ink-2:#1a1a1a;
    --muted:#4a4a4a; --brass:#ffcf24; --brass-bright:#ffda52; --on-brass:#0a0a0a;
    --danger:#ff5a5a; --hairline:#0a0a0a; --r:0px; --r-lg:0px; --bd:2px;
    --depth:6px 6px 0 0 #0a0a0a; --ok:#1f7a3d; --warn:#c07a00;
    --step-bg:#0a0a0a; --step-ink:#ffcf24;
  }
  [data-theme='figma'] {
    --bg:#0c0c0c; --surface:#141414; --surface-2:#1e1e1e; --ink:#ffffff; --ink-2:#d4d4d4;
    --muted:#888888; --brass:#e2ff00; --brass-bright:#ebff4d; --on-brass:#0a0a0a;
    --danger:#ff4d4d; --hairline:rgba(255,255,255,0.12); --r:2px; --r-lg:8px; --bd:1px;
    --depth:0 8px 30px rgba(0,0,0,0.5); --ok:#3fb950; --warn:#e3b341;
    --step-bg:#e2ff00; --step-ink:#0a0a0a;
  }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.55 'Space Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); color:var(--ink); }
  header { padding:16px 20px; border-bottom:var(--bd) solid var(--hairline); display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:700; letter-spacing:-0.01em; }
  .pill { font-size:11px; font-weight:600; padding:3px 9px; border-radius:var(--r); border:var(--bd) solid var(--hairline); color:var(--muted); background:var(--surface); }
  .pill.on { color:var(--on-brass); background:var(--brass); border-color:var(--hairline); }
  .pill.off { color:var(--muted); }
  .pill.due { color:var(--on-brass); background:var(--brass-bright); border-color:var(--hairline); }
  main { max-width:1000px; margin:0 auto; padding:20px; display:grid; gap:16px; }
  .card { background:var(--surface); border:var(--bd) solid var(--hairline); border-radius:var(--r-lg); padding:16px; box-shadow:var(--depth); }
  .card h2 { font-size:12px; margin:0 0 12px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; font-weight:700; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:6px 0; border-bottom:1px solid var(--hairline); opacity:1; }
  .row { border-bottom-color:color-mix(in srgb, var(--hairline) 25%, transparent); }
  .row:last-child { border-bottom:none; }
  .k { color:var(--muted); } .v { font-family:'Space Mono',ui-monospace,monospace; text-align:right; word-break:break-all; color:var(--ink-2); }
  button { font:inherit; font-weight:700; padding:9px 16px; border-radius:var(--r); border:var(--bd) solid var(--hairline); background:var(--brass); color:var(--on-brass); cursor:pointer; box-shadow:var(--depth); transition:transform .1s, box-shadow .1s; }
  button:hover:not(:disabled) { transform:translate(-1px,-1px); }
  button:active:not(:disabled) { transform:translate(2px,2px); box-shadow:none; }
  button.ghost { background:var(--surface); color:var(--ink); }
  button:disabled { opacity:.5; cursor:not-allowed; box-shadow:none; }
  input { font:inherit; padding:9px 11px; border-radius:var(--r); border:var(--bd) solid var(--hairline); background:var(--surface); color:var(--ink); }
  code { font-family:'Space Mono',monospace; font-size:12px; background:var(--surface-2); padding:1px 5px; border-radius:var(--r); }
  #log { background:var(--surface-2); border:var(--bd) solid var(--hairline); border-radius:var(--r); padding:12px; font-family:'Space Mono',ui-monospace,monospace; font-size:12px; white-space:pre-wrap; max-height:340px; overflow:auto; }
  #log .t { color:var(--ink); } #log .tool { color:var(--muted); } #log .ok { color:var(--ok); } #log .err { color:var(--danger); }
  .runs .run { padding:10px 0; border-bottom:1px solid color-mix(in srgb, var(--hairline) 25%, transparent); }
  .runs .run:last-child { border-bottom:none; }
  .runs .meta { font-size:12px; color:var(--muted); display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .runs .sum { margin-top:6px; font-size:12px; max-height:120px; overflow:auto; white-space:pre-wrap; font-family:'Space Mono',ui-monospace,monospace; color:var(--ink-2); }
  .empty { color:var(--muted); }
  .tag { font-size:10px; font-weight:700; padding:2px 7px; border-radius:var(--r); border:var(--bd) solid var(--hairline); text-transform:uppercase; letter-spacing:.03em; }
  .tag.sched { color:var(--on-brass); background:var(--brass); } .tag.man { color:var(--ink); background:var(--surface-2); }
  .tag.dry { color:var(--muted); background:var(--surface); } .tag.exec { color:#fff; background:var(--danger); }
  .ctx-card { border-left:6px solid var(--brass); }
  .ctx { display:grid; gap:8px; }
  .ctx-item { display:flex; align-items:baseline; gap:10px; }
  .ctx-item .ico { font-size:15px; width:20px; text-align:center; }
  .ctx-item .lbl { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.05em; width:64px; flex:none; }
  .ctx-item .val { font-family:'Space Mono',ui-monospace,monospace; font-size:13px; color:var(--ink); word-break:break-all; }
  .ctx-item .val.warn { color:var(--danger); }
  .picker { display:grid; gap:10px; }
  .picker-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .picker-row .lbl { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.05em; width:64px; flex:none; }
  select { font:inherit; padding:9px 11px; border-radius:var(--r); border:var(--bd) solid var(--hairline); background:var(--surface); color:var(--ink); }
  .issue { display:flex; align-items:flex-start; gap:10px; padding:9px 0; border-bottom:1px solid color-mix(in srgb, var(--hairline) 22%, transparent); }
  .issue:last-child { border-bottom:none; }
  .issue input[type=checkbox] { margin-top:3px; width:16px; height:16px; accent-color:var(--brass); flex:none; }
  .issue .body { flex:1; min-width:0; }
  .issue .top { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .issue .key { font-family:'Space Mono',monospace; font-weight:700; font-size:12px; }
  .issue .sum { font-size:13px; color:var(--ink); margin-top:2px; }
  .issue .who { font-size:11px; color:var(--muted); margin-top:2px; }
  .it-type { font-size:10px; font-weight:700; padding:1px 6px; border-radius:var(--r); border:var(--bd) solid var(--hairline); }
  .it-type.bug { color:#fff; background:var(--danger); } .it-type.task { color:var(--ink); background:var(--surface-2); }
  .issues-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
  .issues-head a { color:var(--muted); font-size:12px; cursor:pointer; text-decoration:underline; }
  #toast-wrap { position:fixed; top:16px; right:16px; display:flex; flex-direction:column; gap:8px; z-index:100; }
  .toast { padding:11px 15px; border:var(--bd) solid var(--hairline); border-radius:var(--r); background:var(--surface); color:var(--ink); font-weight:600; font-size:13px; box-shadow:var(--depth); max-width:320px; opacity:0; transform:translateX(20px); transition:opacity .2s, transform .2s; }
  .toast.show { opacity:1; transform:none; }
  .toast.warn { border-left:6px solid var(--brass); }
  .toast.err { border-left:6px solid var(--danger); color:var(--danger); }
  .toast.ok { border-left:6px solid var(--ok); }
  .sched-form { display:grid; gap:10px; margin-top:12px; padding:12px; border:var(--bd) dashed var(--hairline); border-radius:var(--r); background:var(--surface-2); }
  #sched-form-wrap summary { color:var(--brass); }
  [data-theme='brutal'] #sched-form-wrap summary { color:var(--ink); }

  /* ── Banner "công cụ này làm gì" + flow 4 bước ── */
  .hero { background:var(--surface); border:var(--bd) solid var(--hairline); border-radius:var(--r-lg); box-shadow:var(--depth); padding:18px 20px; display:grid; gap:14px; }
  .hero-top { display:flex; align-items:flex-start; gap:14px; flex-wrap:wrap; }
  .hero-mark { width:44px; height:44px; flex:none; display:grid; place-items:center; font-size:22px; background:var(--brass); border:var(--bd) solid var(--hairline); border-radius:var(--r); }
  .hero-copy { flex:1; min-width:240px; }
  .hero-copy .lead { font-size:15px; font-weight:600; margin:0 0 3px; }
  .hero-copy p { margin:0; color:var(--muted); font-size:13px; max-width:62ch; }
  .flow { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
  .flow-step { border:var(--bd) solid var(--hairline); border-radius:var(--r); padding:10px 12px; background:var(--surface-2); display:grid; gap:3px; align-content:start; }
  .flow-step .n { font-family:'Space Mono',monospace; font-weight:700; font-size:11px; width:20px; height:20px; display:grid; place-items:center; border-radius:var(--r); background:var(--step-bg); color:var(--step-ink); margin-bottom:2px; }
  .flow-step .t { font-weight:700; font-size:12.5px; }
  .flow-step .d { color:var(--muted); font-size:11.5px; line-height:1.4; }

  /* ── Card header có step-badge + hint (nối flow với thao tác) ── */
  .card-h { display:flex; align-items:center; gap:10px; margin:0 0 12px; }
  .card-h h2 { font-size:13px; margin:0; font-weight:700; letter-spacing:.01em; flex:1; text-transform:none; color:var(--ink); }
  .card-h .hint { font-size:11px; color:var(--muted); font-weight:500; }
  .card-h .step-badge { font-family:'Space Mono',monospace; font-weight:700; font-size:12px; width:24px; height:24px; flex:none; display:grid; place-items:center; border-radius:var(--r); background:var(--step-bg); color:var(--step-ink); }

  /* ── Strip "agent trỏ đâu" — 3 chip ngang ── */
  #ctx { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
  .ctx-chip { display:flex; align-items:center; gap:10px; border:var(--bd) solid var(--hairline); border-radius:var(--r); padding:9px 11px; background:var(--surface-2); min-width:0; }
  .ctx-chip .ico { font-size:16px; flex:none; }
  .ctx-chip .txt { min-width:0; }
  .ctx-chip .clbl { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  .ctx-chip .cval { font-family:'Space Mono',monospace; font-size:12.5px; color:var(--ink); word-break:break-all; }
  .ctx-chip .cval.warn { color:var(--danger); }

  /* ── Pill "đang quét" nhấp nháy ── */
  .pill.live { color:#fff; background:var(--ok); border-color:var(--hairline); display:inline-flex; align-items:center; gap:5px; }
  .pill.live .dot { width:7px; height:7px; border-radius:50%; background:#fff; animation:pulse 1.1s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.25} }

  /* ── Run bar + mode chip ── */
  .run-bar { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-top:14px; padding-top:14px; border-top:var(--bd) solid var(--hairline); }
  .run-bar .sel-count { font-size:12px; color:var(--muted); }
  .mode-chip { font-size:11px; font-weight:700; padding:3px 9px; border-radius:var(--r); border:var(--bd) solid var(--hairline); }
  .mode-chip.dry { color:var(--warn); background:var(--surface); } .mode-chip.exec { color:#fff; background:var(--danger); }

  /* ── Split log realtime | kết quả triage ── */
  .split { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .col-lbl { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin-bottom:6px; }
  #log { height:320px; max-height:320px; }
  #log .ln { padding:1px 0; }
  .triage-list { display:grid; gap:8px; height:320px; overflow:auto; padding-right:2px; align-content:start; }
  .tri { border:var(--bd) solid var(--hairline); border-radius:var(--r); padding:10px 12px; background:var(--surface-2); display:grid; gap:5px; border-left-width:5px; }
  .tri.done { border-left-color:var(--ok); } .tri.ask { border-left-color:var(--warn); }
  .tri.skip { border-left-color:var(--muted); } .tri.fix { border-left-color:var(--brass); }
  .tri .top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .tri .key { font-family:'Space Mono',monospace; font-weight:700; font-size:12px; }
  .tri .verdict { font-size:10px; font-weight:700; padding:1px 7px; border-radius:var(--r); text-transform:uppercase; letter-spacing:.03em; border:var(--bd) solid var(--hairline); }
  .verdict.done { background:var(--ok); color:#fff; } .verdict.ask { background:var(--warn); color:#fff; }
  .verdict.skip { background:var(--surface); color:var(--muted); } .verdict.fix { background:var(--brass); color:var(--on-brass); }
  .tri .sum { font-size:12.5px; }
  .tri .meta { font-size:11px; color:var(--muted); display:flex; gap:12px; flex-wrap:wrap; }
  .tri .meta b { color:var(--ink-2); font-weight:600; }

  .two-col { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:820px){ .split, .two-col { grid-template-columns:1fr; } }
  @media (max-width:720px){ .flow { grid-template-columns:1fr 1fr; } }
  @media (max-width:640px){ #ctx { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1>📊 Sprint-scan</h1>
  <span class="pill" id="p-enabled">…</span>
  <span class="pill" id="p-mode">…</span>
  <span class="pill" id="p-due">…</span>
  <span class="pill" id="p-launchd">…</span>
  <span class="pill live" id="p-live" style="display:none"><span class="dot"></span>đang quét</span>
  <button id="theme" class="ghost" style="margin-left:auto;padding:5px 11px;font-size:12px" title="Đổi phong cách (đồng bộ với UI chính)">◐ Theme</button>
</header>
<main>
  <!-- CÔNG CỤ NÀY LÀM GÌ — banner + 4 bước, để người mở lần đầu hiểu ngay -->
  <section class="hero">
    <div class="hero-top">
      <div class="hero-mark">🤖</div>
      <div class="hero-copy">
        <p class="lead">Agent tự quét sprint Jira và dọn dẹp giúp bạn.</p>
        <p>Mỗi lượt, agent vào sprint đang chạy, đọc từng bug/task (mô tả, comment, ảnh/video, reporter), phân loại, rồi <b>đề xuất cách fix</b> — hoặc tự fix &amp; assign đúng QC ở chế độ Execute. Không hiểu ticket nào thì nó hỏi thẳng reporter/QC thay vì đoán bừa.</p>
      </div>
    </div>
    <div class="flow">
      <div class="flow-step"><span class="n">1</span><span class="t">Chọn project</span><span class="d">Nhập key Jira, agent lấy danh sách sprint.</span></div>
      <div class="flow-step"><span class="n">2</span><span class="t">Chọn sprint &amp; ticket</span><span class="d">Tick đúng ticket bạn muốn agent đụng vào.</span></div>
      <div class="flow-step"><span class="n">3</span><span class="t">Chạy &amp; xem log</span><span class="d">Theo dõi realtime agent làm gì từng bước.</span></div>
      <div class="flow-step"><span class="n">4</span><span class="t">Xem kết quả triage</span><span class="d">Mỗi ticket: đã fix / cần hỏi / bỏ qua + lý do.</span></div>
    </div>
  </section>

  <section class="card">
    <div class="card-h"><h2>Agent đang trỏ tới đâu</h2><span class="hint">do config chỉ định — agent không tự đoán</span></div>
    <div id="ctx"><span class="empty">Đang tải…</span></div>
    <p class="empty" style="margin:10px 0 0; font-size:11px;">Đổi qua: MCP (Jira) trong <code>~/.bow-agent/mcp.json</code> · project qua <code>--project</code>/<code>BOW_PROJECT_KEY</code> · folder qua <code>--cwd</code>/<code>BOW_CWD</code>.</p>
  </section>

  <section class="card">
    <div class="card-h"><span class="step-badge">1</span><h2>Chọn việc để chạy</h2><span class="hint">bạn quyết — agent chỉ đụng ticket bạn tick</span></div>
    <div class="picker">
      <div class="picker-row">
        <label class="lbl">Project</label>
        <input id="proj" placeholder="vd: DUOCT" style="width:130px">
        <button id="load-sprints" class="ghost" style="padding:7px 12px">Lấy sprint</button>
      </div>
      <div class="picker-row" id="sprint-row" style="display:none">
        <label class="lbl">Sprint</label>
        <select id="sprint-sel" style="min-width:220px"></select>
        <button id="load-issues" class="ghost" style="padding:7px 12px">Liệt kê ticket</button>
      </div>
    </div>
    <div id="issues" style="margin-top:12px"></div>
    <div id="run-bar" class="run-bar" style="display:none">
      <button id="scan" class="act" disabled>▶ Chạy trên ticket đã chọn</button>
      <span id="sel-count" class="sel-count"></span>
      <span id="run-mode" class="mode-chip dry" style="display:none"></span>
    </div>
  </section>

  <section class="card">
    <div class="card-h"><span class="step-badge">2</span><h2>Agent đang làm gì</h2><span class="hint">log realtime · kết quả triage từng ticket</span></div>
    <div class="split">
      <div>
        <div class="col-lbl">Log realtime</div>
        <div id="log"><span class="empty">Chọn project → sprint → tick ticket → "Chạy trên ticket đã chọn".</span></div>
      </div>
      <div>
        <div class="col-lbl">Kết quả triage</div>
        <div id="triage" class="triage-list"><span class="empty">Kết quả sẽ hiện ở đây sau khi chạy xong.</span></div>
      </div>
    </div>
  </section>

  <section class="two-col">
    <section class="card">
      <div class="card-h"><h2>Lịch tự chạy</h2><span class="hint">chế độ tự động</span></div>
      <div id="sched"></div>
      <details id="sched-form-wrap" style="margin-top:12px">
        <summary style="cursor:pointer; font-weight:700; font-size:13px">⚙️ Đặt / sửa lịch</summary>
        <div class="sched-form">
          <div class="picker-row">
            <label class="lbl">Project</label>
            <input id="sf-proj" placeholder="vd: DUOCT" style="width:130px">
          </div>
          <div class="picker-row">
            <label class="lbl">Giờ chạy</label>
            <input id="sf-at" placeholder="09:00,14:00" style="width:160px">
            <span class="empty" style="font-size:11px">HH:MM, nhiều mốc cách nhau dấu phẩy</span>
          </div>
          <div class="picker-row">
            <label class="lbl">Chế độ</label>
            <select id="sf-mode" style="min-width:200px">
              <option value="dry">DRY-RUN (chỉ đề xuất, an toàn)</option>
              <option value="exec">EXECUTE (tự fix + commit)</option>
              <option value="exec-assign">EXECUTE + tự assign QC</option>
            </select>
          </div>
          <div class="picker-row" style="margin-top:4px">
            <button id="sf-save">💾 Lưu lịch</button>
            <button id="sf-install" class="ghost">⏰ Cài tự chạy (launchd)</button>
          </div>
        </div>
      </details>
      <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
        <button id="toggle" class="ghost">Bật/tắt lịch</button>
        <button id="refresh" class="ghost">↻ Làm mới</button>
      </div>
      <p class="empty" style="margin:10px 0 0; font-size:12px;">Lịch tự chạy quét CẢ sprint active theo giờ. Muốn kiểm soát từng ticket thì dùng khối "Chọn việc" ở trên.</p>
    </section>

    <section class="card runs">
      <div class="card-h"><h2>Lịch sử các lượt quét</h2></div>
      <div id="history"><span class="empty">Đang tải…</span></div>
    </section>
  </section>
</main>
<div id="toast-wrap"></div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => (s==null?'':String(s)).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// Toast theo THEME (thay alert() mặc định trình duyệt — cái hộp trắng lạc quẻ). kind: 'warn'|'ok'|'err'.
function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || 'warn');
  el.textContent = msg;
  $('toast-wrap').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, 3200);
}

async function refresh() {
  const r = await fetch('/api/status'); const s = await r.json();
  const sc = s.schedule;

  // Context kết nối — hiển thị RÕ agent trỏ đâu (Jira / project / folder). Do config, không đoán.
  const proj = (sc && sc.projectKey) || s.projectDefault;
  const chip = (ico, lbl, val, warn) =>
    '<div class="ctx-chip"><span class="ico">'+ico+'</span><div class="txt"><div class="clbl">'+lbl+'</div>'+
    '<div class="cval'+(warn?' warn':'')+'">'+esc(val)+'</div></div></div>';
  $('ctx').innerHTML =
    chip('🔗','Jira', s.jiraBaseUrl || '⚠ không đọc được (kiểm ~/.bow-agent/mcp.json)', !s.jiraBaseUrl) +
    chip('📁','Project', proj || '⚠ chưa đặt — bấm Chạy sẽ hỏi project', !proj) +
    chip('💻','Repo (cwd)', s.effectiveCwd || '(mặc định)', false);

  $('p-enabled').textContent = sc ? (sc.enabled ? 'lịch: BẬT' : 'lịch: TẮT') : 'chưa có lịch';
  $('p-enabled').className = 'pill ' + (sc && sc.enabled ? 'on' : 'off');
  const mode = sc ? (sc.dryRun ? 'DRY-RUN' : (sc.allowAssign ? 'EXECUTE+assign' : 'EXECUTE')) : '—';
  $('p-mode').textContent = 'chế độ: ' + mode;
  // Chế độ hiệu lực cho nút "Chạy" — lấy từ lịch (web không cho tự nâng execute). Mặc định dry-run.
  window.__dryRun = sc ? !!sc.dryRun : true;
  updateRunMode();
  $('p-due').textContent = s.due ? 'TỚI GIỜ' : 'chưa tới giờ';
  $('p-due').className = 'pill ' + (s.due ? 'due' : '');
  $('p-launchd').textContent = s.launchdInstalled ? 'launchd: đã cài' : 'launchd: chưa cài';
  $('p-launchd').className = 'pill ' + (s.launchdInstalled ? 'on' : 'off');
  // Pill "đang quét" nhấp nháy — chỉ hiện khi server báo scanning (giải "không thấy đang chạy gì").
  $('p-live').style.display = s.scanning ? 'inline-flex' : 'none';

  if (!sc) {
    $('sched').innerHTML =
      '<p class="empty" style="margin-top:0">Chưa có lịch tự chạy. Mở <b>⚙️ Đặt / sửa lịch</b> bên dưới để đặt ngay trên đây (không cần gõ CLI).</p>';
  } else {
    $('sched').innerHTML = [
      row('Project', sc.projectKey || s.projectDefault || '(env)'),
      row('Mốc giờ', (sc.atTimes||[]).join(', ')),
      row('Chế độ', mode),
      row('Repo (cwd)', sc.cwd || '(mặc định)'),
      row('Lần chạy gần nhất', sc.lastRunAt || '(chưa chạy)'),
      row('Bây giờ', s.dueReason),
    ].join('');
  }
  // Điền sẵn FORM lịch từ lịch hiện có (không đè khi user đang gõ dở — chỉ set khi ô rỗng).
  if (sc) {
    if (!$('sf-proj').value) $('sf-proj').value = sc.projectKey || '';
    if (!$('sf-at').value) $('sf-at').value = (sc.atTimes||[]).join(',');
    $('sf-mode').value = sc.dryRun ? 'dry' : (sc.allowAssign ? 'exec-assign' : 'exec');
  } else if (!$('sf-proj').value && proj) {
    $('sf-proj').value = proj;
  }
  // Ô project ở khối "Chọn việc": điền sẵn project mặc định lần đầu (không đè khi user đang gõ).
  if (!$('proj').value && (proj)) $('proj').value = proj;
  renderHistory(s.history || []);
  // Cột triage: hiện thẻ của lượt GẦN NHẤT khi cột đang trống (chưa chạy live lần nào phiên này).
  // Không đè khi live vừa vẽ xong (scan.onclick set data-live='1').
  if ($('triage').dataset.live !== '1') {
    const last = (s.history || []).find(h => (h.triage||[]).length);
    renderTriage(last ? last.triage : []);
  }
  // KHÔNG động vào nút scan ở đây — trạng thái disable của nó do checkbox ticket + lúc đang chạy
  // quyết (trong renderIssues/scan.onclick). refresh() 15s/lần không được reset nhầm.
  if (s.scanning) { $('scan').disabled = true; $('scan').textContent = '⏳ đang chạy…'; }
}

// Vẽ cột KẾT QUẢ TRIAGE dạng thẻ màu theo verdict (done|fix|ask|skip). Rỗng → placeholder.
const VERDICT_LABEL = { done:'đã fix & assign', fix:'có kế hoạch fix', ask:'cần hỏi QC/PM', skip:'bỏ qua' };
function renderTriage(items) {
  items = items || [];
  if (!items.length) { $('triage').innerHTML = '<span class="empty">Kết quả sẽ hiện ở đây sau khi chạy xong.</span>'; return; }
  $('triage').innerHTML = items.map(t => {
    const v = ['done','fix','ask','skip'].includes(t.verdict) ? t.verdict : 'skip';
    const type = (t.issueType||'').toLowerCase();
    const tc = type.includes('bug')?'bug':(type.includes('task')?'task':'');
    const typeTag = t.issueType ? '<span class="it-type '+tc+'">'+esc(t.issueType)+'</span>' : '';
    const files = (t.files||[]).length ? '<span>📄 <b>'+esc(t.files.length>1 ? t.files.length+' file' : t.files[0])+'</b></span>' : '';
    const qc = t.qc ? '<span>👤 <b>'+esc(t.qc)+'</b></span>' : '';
    const meta = (files||qc) ? '<div class="meta">'+files+qc+'</div>' : '';
    return '<div class="tri '+v+'"><div class="top"><span class="key">'+esc(t.key)+'</span>'+
      '<span class="verdict '+v+'">'+VERDICT_LABEL[v]+'</span>'+typeTag+'</div>'+
      (t.summary ? '<div class="sum">'+esc(t.summary)+'</div>' : '')+meta+'</div>';
  }).join('');
}
function row(k, v) { return '<div class="row"><span class="k">'+esc(k)+'</span><span class="v">'+esc(v)+'</span></div>'; }

function renderHistory(hist) {
  if (!hist.length) { $('history').innerHTML = '<span class="empty">Chưa có lượt quét nào.</span>'; return; }
  $('history').innerHTML = hist.map(h => {
    const trig = h.trigger==='schedule' ? '<span class="tag sched">tự động</span>' : '<span class="tag man">bấm tay</span>';
    const mode = h.dryRun ? '<span class="tag dry">dry-run</span>' : '<span class="tag exec">execute</span>';
    const cost = h.costUsd!=null ? ('$'+h.costUsd.toFixed(4)) : '';
    const err = h.error ? '<div class="sum err" style="color:var(--err)">❌ '+esc(h.error)+'</div>' : '';
    const sum = h.summary ? '<div class="sum">'+esc(h.summary.slice(0,1500))+(h.summary.length>1500?'…':'')+'</div>' : '';
    return '<div class="run"><div class="meta">'+trig+mode+'<span>'+esc(h.startedAt)+'</span><span>'+cost+'</span></div>'+err+sum+'</div>';
  }).join('');
}

// ── FLOW 2 PHA: (1) chọn sprint → (2) duyệt ticket → chạy đúng ticket đã tick ──
let curSprint = null; // {id, name} sprint đang chọn

// Enter trong ô project = bấm "Lấy sprint" (đỡ phải rê chuột).
$('proj').addEventListener('keydown', e => { if (e.key === 'Enter') $('load-sprints').click(); });

// Pha 1a: lấy danh sách sprint của project.
$('load-sprints').onclick = async () => {
  const proj = $('proj').value.trim();
  if (!proj) { toast('Nhập project trước (vd DUOCT).', 'warn'); $('proj').focus(); return; }
  $('load-sprints').disabled = true; $('load-sprints').textContent = '…';
  try {
    const r = await fetch('/api/sprints?project=' + encodeURIComponent(proj));
    const j = await r.json();
    if (!r.ok) { toast(j.error || 'Không lấy được sprint.', 'err'); return; }
    const sel = $('sprint-sel');
    sel.innerHTML = (j.sprints||[]).map(s =>
      '<option value="'+s.id+'" data-name="'+esc(s.name)+'">['+s.state+'] '+esc(s.name)+'</option>'
    ).join('') || '<option value="">(không có sprint scrum)</option>';
    $('sprint-row').style.display = (j.sprints||[]).length ? 'flex' : 'none';
    $('issues').innerHTML=''; $('run-bar').style.display='none';
  } finally { $('load-sprints').disabled=false; $('load-sprints').textContent='Lấy sprint'; }
};

// Pha 1b: liệt kê ticket trong sprint đã chọn.
$('load-issues').onclick = async () => {
  const sel = $('sprint-sel'); const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) { toast('Chọn sprint.', 'warn'); return; }
  curSprint = { id: Number(opt.value), name: opt.getAttribute('data-name') };
  $('load-issues').disabled=true; $('load-issues').textContent='…';
  try {
    const r = await fetch('/api/sprint-issues?sprint=' + curSprint.id);
    const j = await r.json();
    if (!r.ok) { toast(j.error || 'Không lấy được ticket.', 'err'); return; }
    renderIssues(j.issues||[]);
  } finally { $('load-issues').disabled=false; $('load-issues').textContent='Liệt kê ticket'; }
};

function renderIssues(issues) {
  if (!issues.length) { $('issues').innerHTML='<span class="empty">Sprint này không có ticket.</span>'; $('run-bar').style.display='none'; return; }
  const head = '<div class="issues-head"><span class="empty" style="font-size:12px">'+issues.length+' ticket — tick chọn cái muốn cho agent làm:</span>'+
    '<span><a id="sel-all">chọn tất cả</a> · <a id="sel-none">bỏ chọn</a></span></div>';
  $('issues').innerHTML = head + issues.map(i => {
    const t = (i.issueType||'').toLowerCase();
    const tc = t.includes('bug')?'bug':(t.includes('task')?'task':'');
    return '<label class="issue"><input type="checkbox" class="isk" value="'+esc(i.key)+'">'+
      '<div class="body"><div class="top"><span class="it-type '+tc+'">'+esc(i.issueType||'?')+'</span>'+
      '<span class="key">'+esc(i.key)+'</span><span class="empty" style="font-size:11px">'+esc(i.status||'')+'</span></div>'+
      '<div class="sum">'+esc(i.summary||'')+'</div>'+
      '<div class="who">assignee: '+esc(i.assignee||'—')+' · reporter: '+esc(i.reporter||'—')+'</div></div></label>';
  }).join('');
  const upd = () => { const n=document.querySelectorAll('.isk:checked').length; $('sel-count').textContent = n+' ticket đã chọn'; $('scan').disabled=!n; };
  document.querySelectorAll('.isk').forEach(c => c.onchange = upd);
  $('sel-all').onclick = () => { document.querySelectorAll('.isk').forEach(c=>c.checked=true); upd(); };
  $('sel-none').onclick = () => { document.querySelectorAll('.isk').forEach(c=>c.checked=false); upd(); };
  $('run-bar').style.display='flex'; upd(); updateRunMode();
}

// Chip chế độ cạnh nút "Chạy" — nhắc rõ DRY-RUN (chỉ đề xuất) hay EXECUTE (tự sửa) để không bấm nhầm.
function updateRunMode() {
  const el = $('run-mode'); if (!el) return;
  const dry = window.__dryRun !== false;
  el.textContent = dry ? 'DRY-RUN · chỉ đề xuất' : 'EXECUTE · tự sửa code';
  el.className = 'mode-chip ' + (dry ? 'dry' : 'exec');
  el.style.display = 'inline-block';
}

// Pha 2: chạy agent CHỈ trên ticket đã tick.
$('scan').onclick = () => {
  const keys = [...document.querySelectorAll('.isk:checked')].map(c=>c.value);
  if (!keys.length) { toast('Tick chọn ít nhất 1 ticket.', 'warn'); return; }
  if (!curSprint) { toast('Chọn sprint + liệt kê ticket trước.', 'warn'); return; }
  const proj = $('proj').value.trim();
  const log = $('log'); log.innerHTML = '';
  // Reset cột triage + đánh dấu 'live' để refresh() không đè bằng lượt cũ trong lúc đang chạy.
  $('triage').dataset.live = '1'; renderTriage([]);
  $('p-live').style.display = 'inline-flex';
  const line = (cls, txt) => { const d=document.createElement('div'); d.className='ln '+cls; d.textContent=txt; log.appendChild(d); log.scrollTop=log.scrollHeight; };
  const q = new URLSearchParams({ project:proj, sprint:String(curSprint.id), sprintName:curSprint.name, keys:keys.join(',') });
  const es = new EventSource('/api/scan?' + q.toString());
  $('scan').disabled = true; $('scan').textContent = '⏳ đang chạy…';
  const resetBtn = () => { $('scan').disabled=false; $('scan').textContent='▶ Chạy trên ticket đã chọn'; $('p-live').style.display='none'; };
  es.addEventListener('start', e => { const d=JSON.parse(e.data); line('t', '▶ Chạy '+d.projectKey+(d.sprint?' · '+d.sprint:'')+' · '+(d.ticketCount||0)+' ticket · '+(d.dryRun?'DRY-RUN':'EXECUTE')); });
  es.addEventListener('text', e => line('t', '🤖 '+JSON.parse(e.data).text));
  es.addEventListener('tool', e => line('tool', '🔧 '+JSON.parse(e.data).describe));
  es.addEventListener('result', e => { const d=JSON.parse(e.data); line('ok', '✅ Xong · '+d.turns+' lượt · $'+d.costUsd.toFixed(4)); });
  es.addEventListener('agent-error', e => line('err', '⚠️ '+JSON.parse(e.data).subtype));
  es.addEventListener('done', e => {
    line('ok', '✔ Hoàn tất.');
    try { const d=JSON.parse(e.data); renderTriage(d.triage||[]);
      if (!(d.triage||[]).length) line('tool', 'ℹ️ Không tách được kết quả có cấu trúc — xem tổng kết ở "Lịch sử".'); } catch {}
    es.close(); resetBtn(); refresh();
  });
  es.addEventListener('error', e => { try { line('err','❌ '+JSON.parse(e.data).message);} catch{} es.close(); resetBtn(); refresh(); });
  es.onerror = () => { es.close(); resetBtn(); refresh(); };
};
$('toggle').onclick = async () => {
  const r = await fetch('/api/schedule/toggle', {method:'POST'});
  if (!r.ok) { const j = await r.json().catch(()=>({})); toast(j.error || 'Không đổi được lịch.', 'err'); }
  refresh();
};
$('refresh').onclick = refresh;

// ── Đặt lịch từ UI (thay cho gõ CLI bow schedule set) ──
$('sf-save').onclick = async () => {
  const proj = $('sf-proj').value.trim() || $('proj').value.trim();
  const atTimes = $('sf-at').value.split(',').map(s=>s.trim()).filter(Boolean);
  const m = $('sf-mode').value;
  if (!proj) { toast('Nhập project cho lịch.', 'warn'); return; }
  if (!atTimes.length) { toast('Nhập ít nhất một mốc giờ (HH:MM).', 'warn'); return; }
  const body = { projectKey: proj, atTimes, dryRun: m === 'dry', allowAssign: m === 'exec-assign' };
  const r = await fetch('/api/schedule/set', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const j = await r.json().catch(()=>({}));
  if (!r.ok) { toast(j.error || 'Lưu lịch thất bại.', 'err'); return; }
  toast('Đã lưu lịch ✓ — bấm "Cài tự chạy" để launchd tự kích theo giờ.', 'ok');
  refresh();
};
$('sf-install').onclick = async () => {
  const r = await fetch('/api/schedule/install-launchd', { method:'POST' });
  const j = await r.json().catch(()=>({}));
  if (!r.ok) { toast(j.error || 'Cài launchd thất bại.', 'err'); return; }
  toast(j.loaded ? 'Đã cài launchd ✓ — agent sẽ tự chạy theo lịch.' : 'Đã ghi plist nhưng chưa nạp được (xem log).', j.loaded?'ok':'warn');
  refresh();
};
// Đổi theme brutal ↔ figma, LƯU vào cùng key 'bow-theme' của UI chính → mở web chính cũng đồng bộ.
$('theme').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'figma' ? 'figma' : 'brutal';
  const next = cur === 'brutal' ? 'figma' : 'brutal';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('bow-theme', next); } catch {}
};
refresh();
setInterval(refresh, 15000);
</script>
</body>
</html>`;
