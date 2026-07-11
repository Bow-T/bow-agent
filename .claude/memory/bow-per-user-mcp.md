---
name: bow-per-user-mcp
description: MCP riêng theo user (overlay lên MCP chung) — user LAN tự quản, kể cả Safe/Collab
metadata:
  type: project
---

**Vấn đề gốc:** trước đây MỌI MCP nằm chung block `mcpServers` trong `~/.claude.json`
(`addGlobalMcp`/`removeGlobalMcp` ở `src/tools/mcp.ts`). Ai sửa cũng **dính cả LAN**.
User LAN (safe/collab) muốn MCP riêng (token/DB riêng) thì đụng của mọi người. Thêm nữa
`POST/DELETE /api/mcp` bị `requireAdmin` + `checkSafeMode` chặn → họ còn chẳng sửa được.

**Giải pháp: MCP overlay theo user.** Mỗi user (khóa theo `AccessUser.id` từ
[[bow-access-code-gate]]) có danh sách MCP riêng, **merge chồng** lên MCP chung của admin;
**trùng tên → bản riêng thắng**. Tự áp mọi lần chạy của chính user (không cần tick).

**Kiến trúc:**
- **`src/web/userMcp.ts`** (mới): store `conversations/user-mcp.json` dạng
  `{ [userId]: StoredUserMcp[] }` (gitignore, cùng chỗ `access.json`). Hàm:
  `listUserMcp` (CHE token), `addUserMcp`, `removeUserMcp`, `loadUserMcpServers` (config
  THẬT kèm token cho runner). Tái dùng helper từ `mcp.ts` — không viết lại che token/env.
- **`src/tools/mcp.ts`**: export lại helper dùng chung: `isValidMcpName`, `maskArgs`,
  `isStdioServer`, `resolveMcpEnv`, `buildStdioMcpConfig` (build 1 McpServerConfig stdio +
  timeout 60s). `loadClaudeCodeMcp`/`addGlobalMcp` giờ gọi các helper này.
- **`src/core/runner.ts`**: `RunOptions.userMcpServers?: Record<string,McpServerConfig>`.
  Merge: `mcpServers = { ...cc.servers, ...userMcp }` (user SAU → ghi đè). `mcpNames` =
  keys của map đã merge, dùng cho `mcpReadToolPatterns` ở CẢ read-auto-approve LẪN
  `SAFE_MODE_ALLOWED_TOOLS` (nên MCP riêng cũng đọc được trong Safe Mode; tool GHI vẫn duyệt).
- **`src/web/server.ts`**: trong `/api/run` resolve `userMcpServers` từ token
  (`getUserByToken(getReqToken(req)).id → loadUserMcpServers`), truyền qua `RunParams`
  (auto-resume giữ nguyên nhờ `{...params}`). 3 route MỚI `/api/my-mcp` GET/POST/DELETE,
  gate bằng `requireMcpUser` (cần `isAccessAllowed` + có user theo token) — **KHÔNG**
  `requireAdmin`/`checkSafeMode` nên **chạy được cả trong Safe/Collab**. `/api/mcp` chung
  giữ nguyên (admin only, vẫn 403 trong Safe/Collab — ranh giới cũ không đổi).
- **`web/App.tsx`**: nút MCP hiện cho admin (mọi mode trừ Safe) HOẶC user LAN đã duyệt
  (`gateState==='open'`). `openMcpPanel` → admin gọi `/api/mcp`, user gọi `/api/my-mcp`.
  Panel render theo `cfg?.isAdmin`: "MCP chung" vs "MCP riêng của bạn" (kèm ghi chú overlay).
  Dùng lại state form/error/busy chung; danh sách riêng ở `myMcpList`.

**Đã test (script scratchpad, đã dọn):** store cô lập theo user + che token + resolve
thật; HTTP normal-mode (403 khi không token, GET/POST/DELETE OK, cô lập giữa 2 user, token
không lộ); Collab Mode (`/api/my-mcp` 200 cả 3 verb, `/api/mcp` chung vẫn 403). typecheck
+ ui:build sạch. Loopback = admin nên test qua token của user approved, không cần IP LAN.

**Quyết định:** admin (localhost, không token access) KHÔNG dùng `/api/my-mcp` (trả 403 gọn)
— admin quản MCP chung. Overlay theo TÊN (khai lại cả entry), chưa hỗ trợ "chỉ override env".
