---
name: bow-mcp-split-from-profile
description: MCP CHUNG tách khỏi profile — lưu ~/.bow-agent/mcp.json cố định, đổi acc không mất MCP
metadata:
  type: project
---

**Vấn đề:** MCP CHUNG trước đây nằm trong `.claude.json` của **profile Claude đang login**
(qua `config.claudeJsonPath`, phụ thuộc `CLAUDE_CONFIG_DIR`, vd `.claude-tuanleo`). Nên đổi
acc/profile qua lại là **mất MCP** — profile mới thường có `mcpServers` rỗng → panel hiện 0,
phải khai lại. User than "đổi acc qua lại bất tiện".

Nhầm lẫn hay gặp: user config MCP bằng **Claude Code CLI thường** → vào `~/.claude.json`,
nhưng bow-agent đọc profile riêng `.claude-tuanleo/.claude.json` (rỗng) → tưởng mất/lỗi.

**Giải pháp: TÁCH MCP chung khỏi profile.** Lưu ở file cố định **`~/.bow-agent/mcp.json`**
(chỉ chứa `{ mcpServers }`), độc lập mọi profile. Đổi acc chỉ đổi login/token; MCP giữ nguyên.

**Cài đặt:**
- `src/config/env.ts`: getter `config.mcpConfigPath` → `~/.bow-agent/mcp.json` (override qua
  env `BOW_MCP_CONFIG` — dùng để test). Getter TỰ **seed lần đầu** (`seedMcpConfigIfMissing`):
  nếu file chưa có → copy `mcpServers` từ `~/.claude.json` (nơi CLI thường lưu) sang, để
  không mất supabase/jira đang có. `claudeJsonPath` GIỮ NGUYÊN cho login/token theo profile.
- `src/tools/mcp.ts`: hàm nội bộ đổi tên `claudeJsonPath()` → `mcpConfigPath()` = trỏ file
  mới. `readGlobalMcp`/`readClaudeJson`/`writeClaudeJsonSafely` đọc-ghi file mới (thêm
  `mkdirSync` đảm bảo `~/.bow-agent/` tồn tại). Panel admin + `/api/mcp` tự dùng file mới.
- `src/input/jira-attachments.ts`: `readJiraAuth` (lấy JIRA_* để kéo ảnh Jira) đọc từ
  `config.mcpConfigPath` thay vì `claudeJsonPath` — nếu quên thì mất auth jira sau khi tách.

**Không đụng:** login/token vẫn theo profile ([[bow-genome-removed]] / profile system).
MCP-riêng-theo-user [[bow-per-user-mcp]] vẫn ở `conversations/user-mcp.json`, overlay lên
MCP chung (giờ đọc từ file tách này). Runner truyền `mcpServers` THẲNG vào `query()` nên
SDK không cần đọc file — tách file không ảnh hưởng agent chạy.

**Đã test (script scratchpad, đã dọn):** seed đúng từ ~/.claude.json; che token; **đổi
profile (CLAUDE_CONFIG_DIR khác) vẫn thấy MCP y hệt**; add/remove ghi file mới KHÔNG đụng
~/.claude.json; jira auth đọc đủ 3 biến; typecheck + ui:build sạch. Với máy user: panel
admin giờ hiện supabase-mcp-server + jira, token che `--access-token ***`.
