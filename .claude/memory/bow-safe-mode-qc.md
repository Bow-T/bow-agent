---
name: bow-safe-mode-qc
description: Safe Mode chia sẻ hỏi đáp read-only cho người non-dev (QC/BA/PM) — ẩn UI kỹ thuật, khoá source, banner repo
metadata:
  type: project
---

Chế độ cho người **non-dev** (QC, BA, PM…) hỏi đáp source read-only (vd monorepo).
"QC" chỉ là một ví dụ vai trò — bản chất là read-only an toàn cho bất kỳ ai không sửa code.

**Bật:** `npm run ui:share` (đã đặt `BOW_SAFE_MODE=true` + `BOW_SAFE_CWD=/Users/tuannguyen/GitProject/monorepo`).
Hoặc tự đặt: `BOW_SAFE_MODE=true BOW_SAFE_CWD=<repo> npm run ui:safe`.
(Tên cũ `ui:qc` đã đổi thành `ui:share` để trung lập vai trò.)

**Chạy song song dev + share cùng máy (2 cặp cổng):**
- Cổng lấy từ env: backend `BOW_AGENT_PORT` (mặc định 4000, `server.ts` đã đọc sẵn),
  Vite `BOW_WEB_PORT` + proxy target `BOW_AGENT_PORT` (`vite.config.ts` đã đọc từ env).
  Frontend gọi `/api` tương đối → tự trỏ đúng backend theo proxy, không hard-code cổng.
- `npm run ui` = dev đầy đủ ở **4000/5173** (repo bow-agent). `npm run ui:share` = Safe Mode ở
  **4001/5174** (`--host` cho LAN, người dùng vào 5174). Hai bản chạy đồng thời không đụng cổng.
- Dừng: `ui:share:stop` (chỉ tắt 4001/5174, dev vẫn chạy) · `ui:stop` (tắt sạch cả 4 cổng).
- Đổi repo không cần restart: vào UI bản share bấm **Source**, hoặc
  `curl -X POST localhost:4001/api/safe-cwd -H 'Content-Type: application/json' -d '{"cwd":"<repo>"}'`
  (chỉ admin localhost). Giá trị `safeCwdOverride` nằm trong RAM → mất khi restart, về `BOW_SAFE_CWD`.

**Backend** (`src/web/server.ts`):
- `safeCwd()` = `safeCwdOverride || BOW_SAFE_CWD || process.cwd()` — source cố định khi
  safe mode. Trỏ repo khác không cần chạy server TỪ trong repo đó.
- `POST /api/safe-cwd` (chỉ admin): Admin đổi source lúc chạy, không restart → set `safeCwdOverride`.
- `/api/config` trả `repoName` (basename effectiveCwd) + `isAdmin` cho UI.
- Safe mode ép `mode='plan'`, `workdir=safeCwd()`; `checkSafeMode` chặn ghi (MCP/workspace) → 403.
- Safe mode **luôn ép `model='claude-sonnet-5'`** (`effectiveModel`), KHÔNG tin model client gửi —
  read-only hỏi đáp không cần Opus 4.8 (đắt). Frontend cũng luôn set Sonnet + khoá picker cho khớp.
- Helper `getCleanIp`/`isAdminReq`/`requireAdmin`. **Đã vá:** `/api/active-clients` +
  `/api/audit-logs` giờ đều gắn `requireAdmin` (trước active-clients hở, ai cũng gọi được).
  Admin = IP localhost 127.0.0.1.

**UI** (`web/App.tsx`, biến `safe = cfg.isSafeMode`): khi safe thì ẩn readouts
Cost/Mode/Session/Context, ẩn nút MCP/Workspace/Cấu trúc, ẩn Mode-select + ô cwd +
folder picker, quick-prompts chỉ giữ "Giải thích codebase". Model picker vẫn hiện nhưng
bị **khoá cứng ở Sonnet 5** (disabled). Nút LAN Dashboard chỉ hiện khi `cfg.isAdmin`.
Header có readout **Source** (gọn, chỉ tên repo): admin bấm → picker (`pickerTarget='safe-cwd'`)
đổi source qua `/api/safe-cwd`; QC thường chỉ xem.

**Tách phiên theo người (LAN share):**
- Mỗi lượt "Chạy" = `Session` random UUID riêng, SSE riêng — QC không chen phiên bạn.
- Lịch sử chat (`conversations/conversations.json`) TÁCH theo IP: field `ownerIp` gắn khi
  tạo. `canAccess`: admin (127.0.0.1) thấy tất để review; người khác chỉ thấy cuộc của IP mình.
  Bản ghi cũ (không ownerIp) chỉ admin thấy. list/get/put/patch/delete đều nhận `getCleanIp(req)`
  → QC đọc/ghi/xóa chéo cuộc người khác = 404/403/ok:false.
- QC read-only KHÔNG để lại dấu chung: safe mode ép mode='plan' → `isExecuting=false` →
  runner KHÔNG `appendJournal` vào workspace, `canUseTool` chặn Write/Edit/Read-ghi.

**Bản dev đầy đủ giữ nguyên:** `npm run ui` (không có BOW_SAFE_MODE → `safe=false`).
