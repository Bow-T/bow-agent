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
- **MCP tách khỏi profile.** MCP chung lưu `~/.bow-agent/mcp.json` (không phải `~/.claude.json`).
- **Cổng an toàn duy nhất** = `canUseTool` trong `runner.ts`: tool đọc + Bash an toàn tự chạy;
  mọi thao tác GHI qua cổng duyệt. Đừng mở đường ghi vòng qua cổng này.

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

## Tài liệu chi tiết

- **README.md** — hướng dẫn dùng (CLI/Web, cờ, MCP, profile, subagents).
- **ARCHITECTURE.md** — thiết kế đầy đủ (nguồn tri thức, khung rỗng skill, cổng an toàn,
  workspace, xử lý ảnh/video Jira).

## Việc thường làm

- Typecheck: `npm run typecheck`. Build web: `npm run ui:build`. Build CLI: `npm run build`.
- KHÔNG tự commit/push trừ khi được yêu cầu rõ. Commit message **không** kèm trailer ghi
  công Claude (có hook `.claude/hooks/` chặn tự động).
