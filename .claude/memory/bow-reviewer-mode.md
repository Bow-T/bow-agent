---
name: bow-reviewer-mode
description: Reviewer Mode (mode thứ 5) — Tech Lead/Reviewer review PR GitHub + diff local, comment/approve PR qua gh, read-only code, không sửa/merge/push
metadata:
  type: project
---

Mode thứ 5, cho **Tech Lead / Reviewer** qua LAN — vai trò còn thiếu sau [[bow-qc-mode]] (QC),
[[bow-collab-mode]] (dev), [[bow-ba-mode]] (BA). Review PR GitHub + diff branch local, comment/
approve PR, NHƯNG không sửa code / merge / push. Cổng **API 4004 / Web 5177**.

**Vì sao có mode này:** phân tích "4 mode = 4 vai trò" thấy thiếu Reviewer — Collab thì được ghi
code (quá quyền), QC thì không thao tác GitHub PR. Reviewer lấp đúng khoảng đó.

**Bật:** `npm run ui:review:share` (đặt `BOW_REVIEWER_MODE=true` + `BOW_REVIEWER_CWD=/…/monorepo`
+ `BOW_AGENT_PORT=4004 BOW_WEB_PORT=5177`). Bản local: `ui:review`. Dừng: `ui:review:stop`.
VSCode: task "web: chạy Reviewer Mode" / launch "🔍 Chạy Web Reviewer Mode" (group 1_run order 5,
mở :5177). Chạy song song dev (4000/5173), QC (4001/5174), collab (4002/5175), BA (4003/5176).

**Ràng buộc quan trọng:** KHÔNG có MCP GitHub (chỉ supabase + jira) → PR chỉ thao tác qua `gh`
CLI (Bash). Nên Reviewer phải cho Bash nhưng LỌC lệnh chặt.

**Quyền (server ép `mode='plan'` như QC; policy trong `canUseTool` khối `if (isReviewerMode)`):**
- ĐỌC code: Read/Glob/NotebookRead + MCP read (gồm Jira read). Grep DENY riêng; file nhạy cảm chặn.
- **Tool `Skill`** (pr-review) — trong `REVIEWER_MODE_ALLOWED_TOOLS`.
- **Bash lọc riêng**: risky (`isRiskyCommand`) + command-chaining (`hasCommandChaining`) DENY
  TRƯỚC; rồi allow nếu `isReviewGhCommand(cmd)` (git diff/status/log/show, gh pr view/diff/list/
  checks/comment/review, gh repo view, gh api repos/… chỉ GET) HOẶC `SAFE_COMMANDS` (test/analyze);
  còn lại DENY. `REVIEW_GH_COMMANDS` neo `^` + CỐ Ý không cho `gh pr merge/close/edit`, `git
  push/commit`.
- **Ghi file source** (FILE_WRITE_TOOLS) → DENY CỨNG (reviewer không sửa code).
- **Jira READ** (mcpReadToolPatterns); Jira WRITE không mở (khác QC — reviewer dùng GitHub).
- Ép model `claude-sonnet-5`. Không đổi được MCP/workspace config (`checkReadonlyConfig` → 403).
- **Tự nạp stack `review`**: `effectiveStack = … isReviewerMode ? 'review'`. Bộ skill `pr-review`
  ở repo `Bow-T/bow-skill-review` (đăng ký như stack qc). Xem [[bow-skill-qc-triage]] mẫu.

**Backend** (`src/web/server.ts`): `isReviewerMode` từ env; `reviewerCwd()`/`reviewerCwdOverride`;
`/api/config` trả `isReviewerMode` + `otherModes.review` (cổng 4004 → `modes.review`,
`pingConfigPort(4004)`); `/api/qc-cwd` dùng chung → ghi `reviewerCwdOverride` khi isReviewerMode;
`workdir`/`auditMode`/`requestedMode`(ép 'plan')/`effectiveModel`(Sonnet) đều có nhánh reviewer.

**Frontend** (`web/App.tsx`): `cfg.isReviewerMode`; biến `reviewer`; gộp `readonlyShare = qc ||
reviewer` để ẩn UI kỹ thuật giống QC. Class `.reviewer-mode`; banner `.reviewer-banner` (tông
TÍM #8b5cf6, phân biệt QC teal / Collab cam / BA xanh dương). Badge "Review Src" + picker target
`reviewer-cwd` (cổng 4004). `API_PORTS` thêm 4004; badge nhận diện cổng 4004='Review' (cũng bổ
sung 4003='BA').

**Rủi ro cần nhớ:** `gh` dùng token GitHub của MÁY (Bow-T) → reviewer LAN comment/approve PR ghi
dưới danh nghĩa tài khoản đó, không phải reviewer thật. Whitelist gh neo chặt + chặn chaining để
không lách (`gh pr comment; rm -rf` → chan bởi hasCommandChaining).

**Đã test:** typecheck + ui:build sạch; policy case (allow git diff/gh pr view/comment/review +
test, DENY gh pr merge/git push/Write source/rm/chaining/execute_sql); `/api/config` trả
isReviewerMode + otherModes.review; checkReadonlyConfig chặn config (403).
