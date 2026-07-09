---
name: bow-collab-mode
description: Collab Mode — CTV qua LAN code như dev, lệnh hủy hoại phải admin duyệt từ xa, Git tự do
metadata:
  type: project
---

Mode thứ 3 (cạnh dev đầy đủ và [[bow-safe-mode-qc]] read-only). Cho **cộng tác viên (CTV)**
qua LAN code gần như dev, nhưng có ranh giới an toàn.

**Bật:** `npm run ui:collab` (đặt `BOW_COLLAB_MODE=true` + `BOW_COLLAB_CWD=/…/monorepo` +
cặp cổng riêng `BOW_AGENT_PORT=4002 BOW_WEB_PORT=5175`). Chạy song song dev (4000/5173) và
share (4001/5174) không đụng cổng. Dừng riêng: `ui:collab:stop`. Xem cả launch.json + tasks.json.

**Quyền trong Collab (server ép `mode='auto'`):**
- Sửa file trong repo + lệnh an toàn (test/build/analyze) → tự chạy.
- **Git (commit/push/reset/rebase…) → TỰ DO.** Runner opt `collabMode:true` loại các mẫu
  `/git/` khỏi `RISKY_COMMANDS` (biến `activeRisky` trong `src/core/runner.ts`).
- **Lệnh HỦY HOẠI còn lại** (rm -rf, dd, sudo, deploy, ghi ngoài repo…) → treo chờ **ADMIN
  duyệt từ xa**, KHÔNG cho CTV tự duyệt.
- Không đổi được MCP/workspace config (`checkSafeMode` giờ chặn cả `isSafeMode || isCollabMode`).

**Luồng "admin duyệt từ xa" (phần cốt lõi, dễ sai):**
- `src/web/session.ts` có **`adminBus`** (AdminBus toàn cục, tách khỏi Session). Vì mỗi phiên
  CTV chỉ có 1 consumer SSE (chính CTV) nên không nhét nút duyệt vào stream CTV được → phải
  có kênh admin riêng.
- server.ts: khi `isCollabMode && cleanIp !== '127.0.0.1'` (CTV thật, không phải admin chạy tại
  máy) → `approvalHandler` gọi `adminBus.requestApproval({sessionId, clientIp, toolName,…})`
  thay vì `session.requestApproval`. Admin chạy Collab tại localhost thì tự duyệt như thường.
- Admin (localhost) mở SSE **`GET /api/admin/events`** (requireAdmin) → nhận
  `admin-approval-request` / `admin-approval-resolved`. Bấm duyệt qua **`POST /api/admin/approve`**
  `{id, approved}` (requireAdmin) → `adminBus.resolve(id, approved)` giải Promise treo bên CTV.
- `/api/admin/events` phát lại `adminBus.snapshot()` cho admin mới kết nối (mở tab muộn/reload),
  và ping `: \n\n` mỗi 25s giữ stream. Phiên CTV đóng → `.finally` gọi `adminBus.rejectForSession`
  để gỡ nút "ma" bên admin.

**Frontend (`web/App.tsx`):** `cfg.isCollabMode`; biến `collab`. Class `.collab-mode`, banner
`.collab-banner`. useEffect mở `EventSource('/api/admin/events')` chỉ khi `isCollabMode && isAdmin`,
đổ vào state `collabApprovals`. Panel `.collab-approvals` render nút Cho phép/Từ chối → `decideCollab`.

**Đã test:** config trả isCollabMode; non-admin gọi /api/admin/* → 403; SSE admin mở 200;
/api/mcp → 403; Git tách khỏi RISKY (push/reset tự chạy, rm/sudo/dd vẫn treo duyệt); 3 bản
chạy song song không đụng cổng; typecheck + ui:build sạch.
