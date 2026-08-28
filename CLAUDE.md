# CLAUDE.md

Hướng dẫn cho agent làm việc trong repo **bow-agent** — công cụ (TS/Node + Claude Agent
SDK) chạy Claude Code để nhận đề tài / WBS / Jira ticket rồi lập kế hoạch & thực thi thay
đổi code theo mô hình *plan-then-approve*.

## Bộ nhớ dự án (memory)

Trước khi làm việc, đọc `.claude/memory/MEMORY.md` — đây là index các ghi nhớ về
cách làm việc, quy ước và bối cảnh dự án này. Mỗi dòng trỏ tới một file memory
chi tiết trong cùng thư mục; đọc file liên quan khi cần.

Khi có ghi nhớ mới đáng lưu, tạo file trong `.claude/memory/` và thêm một dòng
trỏ vào `MEMORY.md`. Thư mục này được commit theo git để đồng bộ giữa nhiều máy.

> **Lưu ý:** memory recall trong `<system-reminder>` phản ánh thời điểm ghi — nếu một
> ghi nhớ nói khác code hiện tại thì **tin code**. (Ví dụ đã biết: memory `bow-collab-mode`
> nói "Git tự do trong Collab" nhưng code hiện siết mọi ghi qua admin — xem §Mode web.)

## Bản đồ nhanh

- **Một lõi, hai mặt.** CLI (`src/cli/index.ts`) và Web (`src/web/server.ts`) dùng chung
  `src/core/runner.ts`. Khác nhau chỉ ở hiển thị (terminal vs SSE) và cách duyệt (gõ y/N
  vs bấm nút). **Đừng nhân đôi logic** — sửa hành vi agent thì sửa ở `runner.ts`.
- **Khung rỗng.** KHÔNG còn thư mục `skills/` (data) trong repo. Skill tải từ GitHub lúc
  runtime, cache ở `~/.bow/skills-cache/`, trải vào `.claude/skills/` (gitignore). `src/skills/*.ts`
  là **code module** (đừng nhầm với data đã gỡ). Registry allowlist ở `~/.bow-agent/registry.json`.
  Repo đích đã fork/đổi tên skill bundle thành bộ riêng thì khai `.claude/skills/.bow-skip`
  (mỗi dòng một tên) — bow bỏ qua VÀ tự dọn bản đã lỡ trải, tránh nhân đôi mô tả skill tốn token.
- **AI có thể KHÔNG phải Claude — và đổi được PER-TAB.** Provider ngoài chạy qua gateway nói
  giọng Anthropic (LiteLLM, xem `examples/litellm.grok.yaml`) vì xAI không có `/v1/messages`.
  `BOW_PROVIDER` = AI mặc định; web gửi `provider` trong body `/api/run` để đổi riêng từng tab
  (chỉ admin — `effectiveProvider` ở `server.ts`, như `claudeProfile`). Ánh xạ model + env-patch
  nằm ở `resolveModelFor`/`providerEnvPatchFor` (`src/config/env.ts`), áp trong `buildPerTabEnv`;
  thêm chỗ gọi model mới thì bọc qua đó, đừng hardcode `claude-*`. NHIỀU tài khoản gateway (như profile Claude)
  nhập TỪ WEB (`GET/POST /api/provider`, `DELETE /api/provider/:name`, chỉ admin) lưu
  `~/.bow-agent/provider.json` chmod 600 dạng `{profiles:{<tên>:{token,baseUrl}}}`; tab gửi
  `providerProfile` trong body `/api/run`. Env (`BOW_PROVIDER_TOKEN`) vẫn thắng file — khi đó
  UI chỉ thấy một tài khoản ảo tên `env` và không sửa được từ web.
- **MCP tách khỏi profile.** MCP chung lưu `~/.bow-agent/mcp.json` (không phải `~/.claude.json`).
- **Cổng an toàn duy nhất** = `canUseTool` trong `runner.ts`: tool đọc + Bash an toàn tự chạy;
  mọi thao tác GHI qua cổng duyệt. Đừng mở đường ghi vòng qua cổng này.
- **Ngữ cảnh KHÔNG vô hạn — bow tự nén.** `emitContextUsage` (`runner.ts`) đo % context mỗi lượt:
  chạm `BOW_COMPACT_AT` (mặc định 80%) thì xếp `/compact` ngay SAU lượt vừa xong (không cắt ngang);
  vượt trần cứng thì phát `context_overflow` → tab dọn ngữ cảnh, lượt sau chạy tiếp bằng tóm tắt
  (`resumeContext`). Trần context của AI ngoài khai THẬT ở `providerContextTokens` (`env.ts`,
  grok = 500k, ghi đè bằng `BOW_PROVIDER_CONTEXT_TOKENS`) — **đừng tin số CLI tự đoán**. autoCompact
  của CLI là lưới DUY NHẤT nén được giữa lượt: **giữ bật**, và khai trần thật cho nó bằng
  `autoCompactWindow` (tắt hẳn thì một cụm tool đọc file +172k/nhịp vọt qua trần, không ai cứu).
- **Mỗi tab một phiên — CẤM đọc chéo hội thoại.** Hook `PreToolUse` (`src/skills/hooks.ts`) *và*
  `canUseTool` cùng chặn Read/Grep/Glob/Bash chạm `.claude*/projects`, `~/.bow-agent`,
  `conversations.json`. Phải chặn ở CẢ hai tầng vì hook chạy TRƯỚC cổng duyệt (tool đọc auto-duyệt
  không bao giờ tới `canUseTool`). Bỏ một tầng = agent đi đọc transcript tab khác rồi làm nhầm việc.
- **Token đã tiêu đếm từ transcript, không phải `/usage`.** `src/core/tokenUsage.ts` quét MỌI thư mục
  config Claude (mỗi `CLAUDE_CONFIG_DIR` một kho riêng), khử trùng theo `message.id`, cache theo
  (size, mtime) ở `~/.bow-agent/usage-cache.json`; đọc qua `GET /api/usage/tokens` (**admin**).
  Panel "Hạn mức sử dụng": Anthropic → hạn mức gói 5h/tuần (`/usage`); AI ngoài → token đã đốt.
- **Web không còn một file.** `web/App.tsx` là vỏ (nav trái `AppNav` + cột phải `RightRail` + thanh
  tab), các màn con ở `web/panels/*`, `TaskPane.tsx` giữ luồng chat/SSE. Cosmos là **overlay**
  (`CosmosOverlay.tsx`) của tab đang mở, không phải một màn. Luật mobile gom ở §MOBILE cuối
  `web/styles.css` (đặt cuối để thắng override theme, khỏi cần `!important`).
- **Nói chen giữa lượt + worktree.** `POST /api/say/:id` đẩy lời vào kênh streaming input đang chạy
  (`createInputChannel`) — không nới quyền, vẫn qua cổng đã chốt lúc `/api/run`. Chạy nhiều ticket
  song song bằng `core/gitWorktree.ts` (`bow worktree add|list|remove`, `POST /api/worktree/create`,
  `DELETE /api/worktree/remove`) — thư mục `wt-<ticket>` cạnh repo, nhánh `feat/<ticket>`.

## Mode web (6 mode, cổng riêng, chạy song song)

| Mode | Script | Cổng client | Quyền |
| ---- | ------ | ----------- | ----- |
| **Dev** | `npm run ui` | 5173 (Vite) | Admin (localhost) full; non-admin LAN bị ép `plan` |
| **QC** | `npm run ui:qc:share` | **4001** | Read-only source + tool **Skill** (qc-triage) + **Jira** read/write; whitelist tool đọc, ép Sonnet, cho QC |
| **Collab** | `npm run ui:collab` | **4002** | CTV code như dev; **mọi ghi (kể cả Git) phải admin duyệt từ xa** |
| **BA** | `npm run ui:ba` | **4003** | Ghi TÀI LIỆU (`docs/`, `*.md`) + full Jira; DENY cứng source/DB/deploy |
| **Reviewer** | `npm run ui:review:share` | **4004** | Read-only code + review PR (`git/gh diff`) + comment/approve PR (`gh pr comment`/`gh pr review`) + test + Jira đọc; DENY sửa code/merge/push |
| **DevOps** | `npm run ui:devops:share` | **4005** | Ghi FILE HẠ TẦNG (Dockerfile, compose, `.github/workflows/*`, `*.tf/*.hcl`, k8s/Helm) + docs; DENY cứng source ứng dụng; deploy/apply **treo admin duyệt** (như Collab) |

> **CỔNG AN TOÀN CHIA SẺ LAN — không dùng Vite proxy.** Các mode chia sẻ (QC/Collab/BA/
> Reviewer/DevOps) chạy `BOW_SERVE_STATIC=true`: backend TỰ phục vụ `dist-web` ngay trên
> cổng API (4001…), client vào thẳng cổng đó. **KHÔNG** còn Vite ở giữa. Lý do: Vite proxy
> `/api` về backend qua `localhost` (`xfwd` bị bỏ qua) nên backend thấy MỌI client LAN là
> `127.0.0.1` → ai cũng thành admin, mất sạch phân quyền IP + cổng token. Đi thẳng cổng API,
> `req.socket.remoteAddress` là IP LAN THẬT → `getSocketIp`/`isAdminReq` phân quyền đúng.
> URL admin đưa cho đồng nghiệp = `lanUrls` (đã trỏ cổng API). **Đừng** chuyển các mode này
> về `vite --host`. Mode **Dev** vẫn dùng Vite (HMR) vì chỉ admin tự chạy local, không chia sẻ.

Policy nằm trong các khối `isQcMode`/`isReviewerMode`/`isCollabMode`/`isBaMode`/`isDevOpsMode` của
`canUseTool` (`runner.ts`) + `checkReadonlyConfig`/`requireAdmin` ở `server.ts`. Admin = **socket IP
thật là localhost** (đừng tin header `X-Forwarded-For` — xem `.agents/AGENTS.md`). DevOps là mode
LAI: ghi file theo target như BA (helper `isInfraPath`), nhưng deploy/apply định tuyến admin duyệt
qua `adminBus` như Collab (`routeToAdmin = (isCollabMode || isDevOpsMode) && !isAdmin`).

## Sprint-scan (agent TỰ chạy theo lịch — KHÁC 6 mode chat trên)

| Thứ | Script | Cổng | Chức năng |
| --- | ------ | ---- | --------- |
| **Sprint-scan** | `npm run ui:sprint` (LAN: `ui:sprint:share`) | **4006** | Dashboard theo dõi + nút "Quét ngay" (SSE). Agent tự quét sprint Jira, triage bug/task, hỏi/assign **reporter** ticket |

> **KHÔNG phải mode thứ 7 của `server.ts`.** Sprint-scan là agent TỰ vận hành theo lịch (không phải
> phiên chat người-gõ), nên có **server độc lập** `src/scheduler/webServer.ts` (không đụng 6 mode trên,
> không dùng access-token/SSE-chat của `server.ts`). Lõi vẫn là `runAgent` — không nhân đôi logic agent.
> Các file: `src/scheduler/{sprintScan,schedule,launchd,qcRouting,webServer}.ts` + CLI `bow sprint-scan`
> / `bow schedule`. **Dry-run mặc định**; `--execute` full-auto có phanh cứng (`autoApprovalPolicy` chặn
> `rm -rf`/force-push/`execute_sql`/tạo-xoá issue). "Tự lên lịch" = config `~/.bow-agent/sprint-schedule.json`
> (agent giữ lịch) + launchd gọi `sprint-scan --tick` mỗi 5 phút (OS giữ sống). Đổi lịch qua CLI, KHÔNG qua web.

## Tài liệu chi tiết

- **README.md** — hướng dẫn dùng (CLI/Web, cờ, MCP, profile, subagents).
- **ARCHITECTURE.md** — thiết kế đầy đủ (nguồn tri thức, khung rỗng skill, cổng an toàn,
  workspace, xử lý ảnh/video Jira).

## Việc thường làm

- Typecheck: `npm run typecheck`. Build web: `npm run ui:build`. Build CLI: `npm run build`.
- KHÔNG tự commit/push trừ khi được yêu cầu rõ. Commit message **không** kèm trailer ghi
  công Claude (có hook `.claude/hooks/` chặn tự động).
