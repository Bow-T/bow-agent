---
name: bow-safe-mode-qc
description: Safe Mode cho QC hỏi đáp read-only — ẩn UI kỹ thuật, khoá source, banner repo
metadata:
  type: project
---

Chế độ cho QC hỏi đáp source read-only (vd monorepo).

**Bật:** `npm run ui:qc` (đã đặt `BOW_SAFE_MODE=true` + `BOW_SAFE_CWD=/Users/tuannguyen/GitProject/monorepo`).
Hoặc tự đặt: `BOW_SAFE_MODE=true BOW_SAFE_CWD=<repo> npm run ui:safe`.

**Backend** (`src/web/server.ts`):
- `safeCwd()` = `safeCwdOverride || BOW_SAFE_CWD || process.cwd()` — source cố định khi
  safe mode. Trỏ repo khác không cần chạy server TỪ trong repo đó.
- `POST /api/safe-cwd` (chỉ admin): Admin đổi source lúc chạy, không restart → set `safeCwdOverride`.
- `/api/config` trả `repoName` (basename effectiveCwd) + `isAdmin` cho UI.
- Safe mode ép `mode='plan'`, `workdir=safeCwd()`; `checkSafeMode` chặn ghi (MCP/workspace) → 403.
- Helper `getCleanIp`/`isAdminReq`/`requireAdmin`. **Đã vá:** `/api/active-clients` +
  `/api/audit-logs` giờ đều gắn `requireAdmin` (trước active-clients hở, ai cũng gọi được).
  Admin = IP localhost 127.0.0.1.

**UI** (`web/App.tsx`, biến `safe = cfg.isSafeMode`): khi safe thì ẩn readouts
Cost/Mode/Session/Context, ẩn nút MCP/Workspace/Cấu trúc, ẩn thanh controls
(Mode/Model/Profile/Effort) + ô cwd + folder picker, quick-prompts chỉ giữ
"Giải thích codebase". Nút LAN Dashboard chỉ hiện khi `cfg.isAdmin`.
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
