---
name: bow-qc-mode
description: QC Mode (trước là "Safe Mode") — QC hỏi đáp read-only source + tool Skill (qc-triage) + Jira read/write; ẩn UI kỹ thuật, khoá source, tự nạp stack qc
metadata:
  type: project
---

Chế độ cho **QC** hỏi đáp / chấm ticket. Read-only với source code NHƯNG mở tool `Skill`
(kích hoạt qc-triage) và **Jira read/write** (comment kết luận, transition/đổi type ticket).
Đây là mode cũ tên "Safe Mode" — đổi tên + nâng quyền cho đồng bộ với [[bow-ba-mode]] /
[[bow-collab-mode]] và để `qc-triage` chạy được (xem [[bow-skill-qc-triage]]).

**Đổi tên SẠCH (không tương thích ngược):** `BOW_SAFE_MODE`→`BOW_QC_MODE`,
`BOW_SAFE_CWD`→`BOW_QC_CWD`, `/api/safe-cwd`→`/api/qc-cwd`, script `ui:share`→`ui:qc:share`,
`ui:safe`→`ui:qc`, `ui:share:stop`→`ui:qc:stop`. Bỏ hẳn tên cũ, không alias, không fallback env.
`checkSafeMode`→`checkReadonlyConfig`. Cổng GIỮ NGUYÊN 4001/5174.

**Bật:** `npm run ui:qc:share` (đặt `BOW_QC_MODE=true` + `BOW_QC_CWD=/…/monorepo` +
`BOW_AGENT_PORT=4001 BOW_WEB_PORT=5174`). Bản local test: `ui:qc` (cổng mặc định). Chạy song
song dev (4000/5173), collab (4002/5175), BA (4003/5176). Dừng riêng: `ui:qc:stop`.
VSCode: task "web: chạy QC Mode" / launch "🔒 Chạy Web QC Mode" (group 1_run order 2, mở :5174).

**Quyền QC (server ép `mode='plan'`; policy trong `canUseTool` khối `if (isQcMode)` ở runner.ts):**
- ĐỌC repo: Read/Glob/NotebookRead + MCP read → cho. Grep DENY riêng (lộ nội dung nhạy cảm),
  file nhạy cảm (`isSensitivePath`) chặn.
- **Tool `Skill`**: có trong whitelist `QC_MODE_ALLOWED_TOOLS` → agent kích hoạt được qc-triage.
  (Plan mode KHÔNG chặn Skill/MCP-write trước canUseTool — chỉ chặn tự-duyệt Edit/Write/Bash-write;
  nên allow ở canUseTool là đủ để chạy.)
- **Jira read + write**: `isJiraTool(toolName)` → allow (comment/transition/update — đầu ra QC).
- DENY mọi thứ khác: ghi file source, MCP write ngoài Jira (execute_sql…), Bash, Web*.
- Ép model `claude-sonnet-5` (`effectiveModel`), KHÔNG tin model client. Frontend khoá picker Sonnet.

**Tự nạp stack qc:** runner có `effectiveStack = opts.stack || (isBaMode ? 'ba' : isQcMode ? 'qc' : '')`
— QC Mode chưa chọn stack thì TỰ nạp stack `qc` (qc-triage + qc-triage-apply). Bộ skill ở repo
riêng `Bow-T/bow-skill-qc` (private) @ v1.0.0, đăng ký như stack trong `~/.bow-agent/registry.json`.
`qc-triage` đã DỜI khỏi core (bow-skill-core v1.1.0 chỉ còn watch) → chỉ QC Mode có qc-triage.

**Backend** (`src/web/server.ts`): `qcCwd()` = `qcCwdOverride || BOW_QC_CWD || cwd`. `POST /api/qc-cwd`
(admin) đổi source runtime → `qcCwdOverride` (RAM, mất khi restart). `/api/config` trả `isQcMode`
+ `otherModes.qc`; cổng 4001 → `modes.qc`; `checkReadonlyConfig` chặn đổi config ở QC/Collab/BA (403).

**UI** (`web/App.tsx`, biến `qc = cfg.isQcMode`): class `app qc-mode`; badge Source "QC Src"
(tông teal); `pickerTarget='qc-cwd'` gọi `/api/qc-cwd` (cổng 4001). Badge nhận diện mode theo
cổng: 4001='QC'. Khi qc thì ẩn readouts Cost/Mode/Session, ẩn nút MCP/Workspace/Cấu trúc, ẩn
Mode-select + ô cwd, quick-prompts chỉ giữ "Giải thích codebase".

**Đã test:** typecheck + ui:build sạch; `deployExternalSkills('qc')` clone tag v1.0.0 + trải
qc-triage/qc-triage-apply; core v1.1.0 chỉ trải watch (không còn qc-triage); QC Mode cuối cùng có
đủ qc-triage + qc-triage-apply + watch trong `.claude/skills/`.

**Bản dev đầy đủ giữ nguyên:** `npm run ui` (không BOW_QC_MODE → `qc=false`).
Xem thêm [[bow-empty-frame-skills]] (CORE luôn tải / STACK chỉ khi chọn), [[bow-per-user-mcp]].
