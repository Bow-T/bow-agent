---
name: bow-ba-mode
description: BA Mode — Business Analyst qua LAN, ghi TÀI LIỆU (docs/, *.md) + full Jira write, chặn source/DB/deploy
metadata:
  type: project
---

Mode thứ 4 (còn có [[bow-reviewer-mode]] thứ 5), cạnh dev đầy đủ, [[bow-qc-mode]] (read-only + Skill + Jira) và [[bow-collab-mode]] (code có
duyệt). Cho **Business Analyst** qua LAN: đọc repo để hiểu ngữ cảnh, **ghi tài liệu + tạo/sửa
Jira ticket**, nhưng KHÔNG đụng source code / DB / hạ tầng.

**Điểm phân biệt cốt lõi:** QC = read-only source (mở Skill + Jira); Collab = write mọi thứ trừ dangerous;
**BA = write CÓ CHỌN LỌC theo ĐÍCH** — tài liệu + Jira ✅, source code + DB + deploy ❌. Phân
quyền theo target path, không theo read-vs-write thuần.

**Bật:** `npm run ui:ba` (`BOW_BA_MODE=true` + `BOW_BA_CWD=/…/monorepo` + cổng riêng
`BOW_AGENT_PORT=4003 BOW_WEB_PORT=5176`). Chạy song song dev (4000/5173), QC (4001/5174),
collab (4002/5175). Dừng riêng: `ui:ba:stop`. Có cả trong `.vscode/tasks.json` ("web: chạy BA
Mode") + `.vscode/launch.json` ("📋 Chạy Web BA Mode", group 1_run order 4, mở :5176).

**Quyền trong BA (server ép `mode='auto'`, KHÔNG bật requireApprovalForWrites):**
- ĐỌC repo (Read/Grep/Glob), WebSearch/WebFetch → tự do.
- **Ghi file:** chỉ TÀI LIỆU (`isDocPath`: đuôi `.md/.mdx/.markdown/.txt/.rst/.adoc` HOẶC trong
  thư mục `docs?/`|`documentation/`) → tự chạy. File nhạy cảm (`isSensitivePath`) → DENY. Source
  code / config (.ts/.dart/.sql/.yaml…) → **DENY CỨNG** (không hỏi admin — muốn sửa code thì
  chuyển Collab/Admin).
- **Jira:** cả read lẫn write (`isJiraTool` = `mcp__…jira…__`) → tự do (create/update/comment/
  transition/subtask — đầu ra chính của BA).
- **MCP khác** (supabase execute_sql/apply_migration…): read (`list/get/search/describe/read/
  show/fetch`) đi tiếp; write/side-effect → DENY.
- **Bash:** chỉ SAFE_COMMANDS đơn thuần; risky (rm/deploy/git push) + lệnh ghép → DENY.
- Không đổi được MCP/workspace config (`checkReadonlyConfig` giờ chặn `isQcMode || isCollabMode || isBaMode`).

**Cài đặt (khác Collab — BA KHÔNG dùng adminBus):** cờ `opts.baMode` truyền từ server.ts →
runner.ts. Toàn bộ policy nằm trong khối `if (isBaMode)` trong `canUseTool` (chạy trước gate
duyệt thường), là DENY cứng nên không cần kênh admin duyệt từ xa. Helper `isDocPath` + `isJiraTool`
khai báo cạnh `isSensitivePath` trong runner. Admin đổi source runtime qua `POST /api/qc-cwd`
tới cổng 4003 → set `baCwdOverride` (route tự chọn override theo `isBaMode`).

**Frontend (`web/App.tsx`):** `cfg.isBaMode`; biến `ba`. Class `.ba-mode`, banner `.ba-banner`
(tông xanh dương, phân biệt Collab cam / QC teal). Badge "BA Src" + picker target `ba-cwd`
(cổng 4003). `API_PORTS` thêm 4003; `otherModes.ba` + `pingConfigPort(4003)`.

**Đã test:** typecheck + ui:build sạch; server BA trả `isBaMode:true` + `modes.ba` đúng repo;
18/18 test ranh giới `isDocPath`/`isJiraTool`/MCP-readish PASS (docs.md ghi được, .dart/.sql/.ts
chặn, jira write cho, supabase execute_sql chặn).

**Bộ skill BA (đã soạn, CHỜ đẩy GitHub):** 4 skill — `ba-userstory`, `ba-acceptance`,
`ba-ticket-review` (chỉ báo cáo), `ba-breakdown` (tạo Jira khi duyệt). Bám đúng format thật của
team **DUOCT** (project Octopus): User Story "As a … so that …" → UI (Screen+component) → UI
Rules ("The system must …") → Acceptance Criteria GIVEN/WHEN/THEN đánh số AC1..ACn; actor
Admin/Partner/Courier/End user.

**Đặt ở REPO RIÊNG `Bow-T/bow-skill-ba`, đăng ký như STACK** (user chọn quyết định này — không
nhét vào core cho khỏi phình). Cấu trúc: `bow-skill.json` (id=ba, skillsDir=skills) + `skills/
ba-*/SKILL.md`. Đẩy: tạo repo → push tag v1.0.0 → thêm mục `{id:"ba", repo:"…/bow-skill-ba",
ref:"v1.0.0"}` vào `stacks[]` của `~/.bow-agent/registry.json` (và/hoặc `src/config/env.ts` để
mặc định mọi máy). Cùng cơ chế 2 nguồn skill: xem [[bow-empty-frame-skills]] (CORE luôn tải /
STACK chỉ khi chọn), [[bow-mcp-split-from-profile]], [[bow-skill-qc-triage]].

**Auto-nạp:** runner có `effectiveStack = opts.stack || (isBaMode ? 'ba' : '')` — ở BA Mode nếu
user chưa chọn stack thì TỰ nạp `ba`, khỏi chọn tay ở dropdown. Stack `ba` không khai
monorepoDir nên không đụng ngữ cảnh monorepo/hooks. Nội dung skill đang ở scratchpad chờ user
duyệt với BA thật rồi mới push.
