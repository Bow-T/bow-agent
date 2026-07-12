# Thiết kế: Bow-Agent

Tài liệu này mô tả kiến trúc của bow-agent sau khi **gỡ over-engineering**: một agent
*single-agent gọn* dựng trên Claude Agent SDK, mở rộng bằng ba cơ chế tri thức tĩnh
(profile, skill, ngữ cảnh monorepo) và một tầng multi-agent **opt-in**.

> **Lịch sử:** bản đầu có thêm "Genome" (bộ nhớ tiến hóa per-repo qua fitness/mutation) và
> vài skill kèm code + Jira REST client riêng. A/B cho thấy với model mạnh (Opus 4.8) các
> thứ đó chỉ lặp lại điều model đã tự suy ra → **chi phí token thừa, phức tạp thừa**. Chúng
> đã bị gỡ. Nếu bạn tìm `genome.ts` / `reflect.ts` / `tools/jira.ts` — chúng không còn nữa.

## 1. Nguyên tắc thiết kế

- **Não 20W: rẻ = tốt.** Viết ít code nhất mà vẫn đúng. Không abstraction đầu cơ. Mọi
  tính năng phải trả lại giá trị vượt chi phí token/độ phức tạp — nếu không, cắt.
- **Một lõi, hai mặt.** CLI và Web dùng chung `core/runner.ts`; chỉ khác cách hiển thị
  (terminal vs SSE) và cách duyệt (gõ y/N vs bấm nút). Không nhân đôi logic.
- **Plan-then-approve.** Mọi thao tác GHI (sửa file, lệnh side-effect, commit, migration,
  ghi Jira) đi qua cổng duyệt `canUseTool`. Tool đọc tự chạy.
- **Opt-in cho thứ tốn kém.** Multi-agent và MCP-giới-hạn là lựa chọn, không mặc định bật
  cái đắt khi task không cần.

## 2. Kiến trúc tổng thể

```
      đề tài / WBS / Jira ticket / ảnh / PDF
                       │
              ┌────────▼─────────┐
              │  input/task.ts   │  chuẩn hóa thành "task brief"
              │  + jira-ref, pdf │
              └────────┬─────────┘
                       │
      ┌────────────────▼────────────────────────────────┐
      │            core/runner.ts (SDK query)            │
      │  systemPrompt = preset Claude Code (append):     │
      │    • BOW_AGENT_APPEND (quy trình plan-approve)   │
      │    • skill prompt-only (repo core clone)         │
      │    • ngữ cảnh monorepo (nếu cwd ∈ monorepo)      │
      │    • project profile (nếu --profile)             │
      │  + CLAUDE.md repo đích (settingSources:'project')│
      │  + MCP servers (Supabase/Jira/…)                 │
      │  + hooks monorepo (nếu cwd ∈ monorepo)           │
      │  + subagents (nếu --subagents)                   │
      └───┬──────────────────────────────────────────────┘
          │  canUseTool: đọc tự chạy · ghi → onApproval
    ┌─────▼──────┐
    │ Edit/Write │  CLI: y/N trên terminal
    │ Bash / MCP │  Web: treo Promise chờ nút bấm
    └────────────┘
```

## 3. Ba nguồn tri thức (tĩnh, từ chung tới riêng)

Agent LLM "quên" giữa các phiên. Thay vì một cơ chế học động phức tạp, bow-agent nạp tri
thức **tĩnh, khai báo sẵn** vào system prompt — đơn giản, đọc được, kiểm soát được.

| Nguồn | Cơ chế | Phạm vi | Vị trí |
|---|---|---|---|
| **Base profile** (chuẩn team) | viết tay, committed → `--profile` nạp vào prompt | mọi dự án cùng khuôn | `src/profiles/base/*.md` |
| **Profile tự sinh** | agent quét repo lạ (chỉ đọc) → ghi ra file | riêng từng repo lạ | `generated-profiles/` (gitignore) |
| **Ngữ cảnh monorepo** | CLAUDE.md + danh mục skill, tự kích hoạt | chỉ khi cwd ∈ monorepo | repo `Bow-T/bow-skill-flutter` (thư mục `monorepo/`, clone về cache) |

Prompt luôn dặn: *nếu thực tế repo mâu thuẫn với profile → tin repo*. Tri thức là gợi ý
mạnh, không phải luật cứng.

## 4. Skill — năng lực tái sử dụng

bow-agent là **khung rỗng**: không còn thư mục `skills/` (data) trong repo. Skill tải từ
repo GitHub, cache ở `~/.bow/skills-cache/<id>@<ref>`. Agent tự chọn theo mô tả (không cần
người dùng bật qua UI):

| Nguồn | Cơ chế | Phạm vi |
|---|---|---|
| **Repo đích** `.claude/skills/*/SKILL.md` | SDK auto-discover nhờ `settingSources:['project']` + `skills:'all'` | riêng từng dự án |
| **CORE** `Bow-T/bow-skill-core` (luôn tải) | `deployCoreSkills(cwd)`: skill kèm code (watch, qc-triage) trải vào `.claude/skills/` (STAMP `.bow-core`); prompt-only (coding-convention) gộp vào system prompt qua `loadPromptSkills()` | mọi repo |
| **STACK** `Bow-T/bow-skill-flutter`/`-react-native`/`-nextjs` (tải khi chọn stack) | `deployExternalSkills(stackId, cwd)` trải vào `.claude/skills/` (STAMP `.bow-external`); repo Flutter còn kèm `monorepo/` cho ngữ cảnh monorepo | theo stack đã chọn |

**Registry** (allowlist stack + repo core) nằm **ngoài repo**, ở `~/.bow-agent/registry.json`
— seed lần đầu từ hằng `DEFAULT_REGISTRY` trong `src/config/env.ts`, override qua env
`BOW_REGISTRY`.

> **Không còn skill kèm code chạy qua MCP.** Bản đầu có server `bow-skills` (`src/skills/code.ts`)
> chạy logic thật qua `tool()`. Đã gỡ — với model mạnh, Bash + các tool sẵn của Claude Code đã
> đủ; một server MCP nội bộ chỉ để "chạy test" là phức tạp thừa. (Skill kèm code hiện là skill
> Claude Code chuẩn — SKILL.md + script — tải từ repo core, không phải MCP server.)

## 5. Multi-agent (opt-in) — `core/subagents.ts`

Mặc định single-agent. Bật `--subagents` để agent chính giao việc cho subagent chuyên biệt
qua tool `Agent` — mượn ý *role specialization*, hiện thực bằng `Options.agents` của SDK
(không bê framework ngoài như CrewAI).

| Subagent | Vai trò | `permissionMode` | maxTurns |
|---|---|---|---|
| **reviewer** | phản biện kế hoạch/diff: call-site sót, rủi ro cross-cutting, over-engineering | `plan` | 12 |
| **verifier** | chạy test/analyze + trace runtime end-to-end (không chỉ "compile pass") | `plan` | 15 |
| **impact-scout** | quét blast radius: liệt kê MỌI call-site + allow-list/switch liệt-kê-tay | `plan` | 10 |

**An toàn nằm ở tầng tool, không chỉ ở prompt.** `permissionMode: 'plan'` chặn Edit/Write
nhưng KHÔNG chặn Bash — nên mỗi subagent còn khai báo `disallowedTools` (`READONLY_DENY`)
deny cứng `git commit/push/reset/checkout`, `rm`, `mv`, Edit/Write/NotebookEdit. Subagent
chỉ đọc / chạy lệnh kiểm chứng; **mọi thay đổi thật vẫn do agent chính làm và vẫn qua
`onApproval`** — bật multi-agent không nới lỏng cổng duyệt.

Profile có thể bổ sung subagent riêng (`buildSubagents` gộp, profile ghi đè chuẩn nếu trùng
tên); chỉ có tác dụng khi `--subagents` bật.

## 6. Ngữ cảnh monorepo — gói sẵn, kích hoạt có điều kiện

Toàn bộ `.claude` của monorepo đến từ repo skill stack `Bow-T/bow-skill-flutter` (thư mục
`monorepo/`, khai qua `monorepoDir` trong manifest `bow-skill.json`) — clone về
`~/.bow/skills-cache/` để agent KHÔNG cần `.claude` trong monorepo nữa. Chỉ áp khi cwd là
monorepo, và chỉ khi stack Flutter đã được tải về.

- **Nhận diện** (`src/skills/monorepo.ts` → `isMonorepo`): cwd có segment `monorepo`. Tách
  riêng một hàm để sau này đổi sang marker file chỉ cần sửa một chỗ.
- **Mã dự án Jira** (`detectJiraProjectKey`): ưu tiên `.env` (`BOW_PROJECT_KEY`), rồi branch,
  commit gần nhất, cuối cùng đoán từ tên thư mục. Skill/CLAUDE.md dùng placeholder
  `<PROJECT_KEY>` được map sang mã thật khi nạp.
- **CLAUDE.md + danh mục skill** (`loadMonorepoContext(cwd, monorepoDir)`): nhận thư mục
  nguồn từ bản clone stack; CLAUDE.md đưa nguyên vào prompt; skill chỉ đưa
  name+description+đường-dẫn (agent tự `Read` full khi task khớp) — tránh nhồi cả nghìn dòng
  vào mọi lượt. Danh mục quét động nên số lượng tự cập nhật theo repo stack.
- **Hooks** (`src/skills/hooks.ts` → `buildMonorepoHooks(cwd, hooksDir)`): nhận thư mục hook
  từ bản clone stack, bọc 4 script shell thành SDK hook callback, chỉ gắn khi cwd là monorepo:
  - `PreToolUse(Bash)`: guard-push (chặn push khi quest gate fail), guard-commit-branch
    (chặn commit trên branch protected) → `exit 2` map thành `{ decision: 'block' }`.
  - `SessionStart`: ensure-githooks (wire core.hooksPath, không chặn).
  - `Stop`: self-verify-rubric (nhắc rubric khi có commit chưa push, không chặn).
  - Script tìm `scripts/*.sh` của monorepo qua `CLAUDE_PROJECT_DIR` = monorepo root.
  - **Fail-open**: hook lỗi hạ tầng không kéo sập agent.

Nguồn nằm trong repo `Bow-T/bow-skill-flutter` (thư mục `monorepo/`), không đụng `.claude`
của monorepo. Khi monorepo đổi skill/hook, cập nhật trong repo stack đó rồi commit; bow-agent
tự clone bản mới nhất về cache mỗi lần chạy khi chọn stack Flutter. `.claude` monorepo giữ
nguyên để vẫn dùng được Claude Code trực tiếp. (Script `sync-monorepo` cũ đã gỡ — đích cũ
`skills/monorepo/` không còn.)

> **Lưu ý prefix skill:** monorepo context dùng prefix skill `bow-*`. Nếu `.claude/skills`
> của monorepo còn `octopus-*`, đồng bộ prefix ở nguồn (repo `bow-skill-flutter`, thư mục
> `monorepo/`) trước khi commit để bow-agent kéo về đúng tên.

## 7. MCP — dùng lại kết nối của Claude Code

`src/tools/mcp.ts` nạp MCP server (stdio) — Supabase, Jira, Codemagic, Figma. Không hardcode
token; chỉ tham chiếu lúc chạy.

- **File cấu hình TÁCH khỏi profile**: MCP chung lưu ở `~/.bow-agent/mcp.json` (getter
  `config.mcpConfigPath` trong `env.ts`, override qua `BOW_MCP_CONFIG`), **seed lần đầu** từ
  `~/.claude.json` để không mất cấu hình sẵn. Vì sao tách: MCP trước nằm trong `.claude.json`
  của profile đang login → đổi tài khoản là mất MCP, phải khai lại. Tách file cố định = đổi
  acc bao nhiêu lần vẫn thấy MCP. (Login/token vẫn theo profile như cũ.)
- **CLI**: mặc định BẬT tất cả (để đọc được Jira ticket ngay). `--mcp a,b` giới hạn,
  `--no-mcp` tắt.
- **Web**: admin tick chọn server ở panel MCP + add/remove (ghi file MCP chung an toàn có
  backup+validate, che token khi trả UI). **MCP riêng theo user** (`src/web/userMcp.ts`):
  user LAN đã duyệt tự quản danh sách MCP riêng ở `conversations/user-mcp.json`, **overlay
  chồng** lên MCP chung (trùng tên → bản riêng thắng), tự áp mọi lần chạy — kể cả QC/Collab.
- **Gate tool**: tool đọc (`list_*`, `get_*`, `jira_get_*`, `search_docs`…) auto-allow qua
  `mcpReadToolPatterns`; tool ghi (`execute_sql`, `apply_migration`, `jira_add_comment`…)
  phải duyệt.

> ⚠️ SDK truyền cấu hình MCP (kèm token) qua tham số command-line → khi MCP bật, `ps aux`
> đọc được token lúc agent chạy. Dùng `--no-mcp` cho task không cần kết nối thật.

### 7.1. Ảnh trong ticket Jira → cho agent nhìn — `src/input/jira-attachments.ts`

**Vấn đề**: MCP `jira_get_issue` chỉ trả về TEXT (summary/description/comment). Ảnh đính
kèm ticket → agent mù. Người dùng thường bỏ mockup/wireframe/ảnh chụp lỗi vào ticket, và
đó là phần quan trọng nhất để hiểu yêu cầu.

**Nút thắt**: MCP `jira_get_attachments` chỉ đưa **metadata + URL** (`content` field), KHÔNG
đưa bytes. Tải URL `/secure/attachment/...` bằng curl trần → trả về trang login, không phải
ảnh. Muốn có bytes phải tự gọi REST có auth. (Cùng kết luận với `netresearch/jira-skill` và
`rui-branco/jira-mcp` — hai skill/MCP cộng đồng đã giải đúng phần tải ảnh này.)

**Luồng** (chạy ở `buildTaskBrief` khi ref là ticket):

1. MCP `jira_get_attachments(key)` → danh sách ảnh (id, filename, mimeType, content-url).
   Lọc `mimeType` bắt đầu `image/`.
2. Tải bytes có auth: `GET {JIRA_BASE_URL}/rest/api/3/attachment/content/{id}` với
   `Authorization: Basic base64(EMAIL:TOKEN)`. Ba biến lấy từ block `mcpServers.jira.env`
   trong `~/.claude.json` (KHÔNG từ `process.env` — xem `env.ts:39`), theo redirect sang CDN.
3. Xác thực **magic bytes** (PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF, WEBP) — nếu là HTML thì
   đó là trang login → bỏ, không đưa vào context. Giới hạn `MAX_IMAGE_BYTES = 5MB`/ảnh.
4. Cache bytes vào `.jira-cache/{issueKey}/{attachmentId}.{ext}` (gitignore) — tải một lần,
   lượt sau đọc lại từ đĩa.

**Đưa vào context**: KHÔNG gọi vision riêng để sinh mô tả. Ảnh gốc được đẩy thẳng vào
`images[]` (tái dùng đường vision sẵn có ở `runner.ts:483`) — **agent chính tự nhìn và tự
mô tả** khi làm việc, tự ghi vào journal/`shared.md` nếu đáng nhớ (§9). Brief chỉ thêm một
dòng liệt kê "ticket có N ảnh: … (đã đính kèm ở trên)".

> Bảo mật: `JIRA_API_TOKEN` là secret cá nhân — không log token, chỉ tải từ đúng host
> `JIRA_BASE_URL` (chống SSRF), ràng cache trong repo (chống path-traversal từ filename Jira).
> Fail-open: lỗi tải một ảnh không kéo sập việc đọc ticket — chèn placeholder "[ảnh chưa
> đọc được]" để agent biết ticket *có* ảnh.

### 7.2. Video trong ticket Jira + skill `/watch` — xem video

**Vấn đề**: Video ticket (thường là screen recording quay lại bug) — Claude KHÔNG "xem"
video trực tiếp (không có content block video như ảnh). Phải quy về (frames JPEG +
transcript) rồi Claude `Read` từng frame.

**Giải pháp**: skill `/watch` (gốc `bradautomates/claude-video`, MIT) nay là skill **CORE**
trong repo `Bow-T/bow-skill-core` (luôn tải mỗi lần chạy) + tải video Jira về đĩa cho skill xử lý.

**Trải skill** — repo core clone → `src/skills/externalSkills.ts` → `deployCoreSkills(cwd)`:
- Trước mỗi lần chạy, core được clone về `~/.bow/skills-cache/<id>@<ref>` rồi skill kèm code
  (watch, qc-triage) copy vào `<cwd>/.claude/skills/watch/` để SDK auto-discover (đã bật
  `settingSources: ['project']` + `skills: 'all'`). Nhờ đó agent LUÔN thấy `/watch` ở mọi repo,
  không cần cài thủ công.
- Idempotent (dấu chữ ký `.bow-core`, chỉ copy lại khi bản clone đổi). AN TOÀN: nếu repo đích
  đã có `.claude/skills/watch/` KHÔNG do ta trải (không có stamp) → coi là của người dùng,
  không ghi đè. Không đụng skill khác của người dùng.
- Yêu cầu runtime: `ffmpeg` + `yt-dlp` (skill tự cài qua brew/apt lần đầu; Whisper key tùy chọn).

**Video Jira attachment** — `fetchJiraTicketVideos()` trong `jira-attachments.ts`:
- Lọc `mimeType` bắt đầu `video/`, tải về `.jira-cache/{key}/{id}.mp4` (cùng REST + auth như ảnh).
- **Giới hạn `MAX_VIDEO_BYTES = 50MB`**: video lớn hơn KHÔNG tự tải (chặn sớm qua metadata size
  để không treo bước chuẩn bị brief) — chỉ báo "video X quá lớn, xem thủ công".
- Brief hướng dẫn agent: "video đã tải ở `<path>` → dùng `/watch <path>` để xem".

**Video URL người dùng dán** (YouTube/Loom/...): không cần code — agent thấy URL trong text
tự dùng `/watch <url>` (yt-dlp của skill tự tải).

**Điều kiện vận hành**: `/watch` chạy nhiều lệnh Bash (tải, ffmpeg, Whisper) → hợp mode `auto`;
ở `manual`/`edit-auto` agent sẽ xin duyệt từng lệnh.

> Đã kiểm chứng end-to-end: tải video Jira thật (REST+auth) → ffmpeg tách frame → Claude đọc
> được nội dung frame; agent bow-agent tự thấy & gọi được `/watch` (kẹt ở cổng duyệt Bash mode
> manual — đúng thiết kế). Khác `bradautomates/claude-video` (chỉ nhận URL/file local), bow-agent
> thêm nguồn Jira attachment và tự-trải skill.

## 8. Cổng an toàn (tổng hợp)

Mọi con đường tới một thao tác GHI đều qua đúng một cổng — `canUseTool` ở `runner.ts`:

1. **Tool đọc** (`Read/Grep/Glob` + MCP read patterns) nằm trong `allowedTools` → chạy thẳng.
2. **Bash an toàn** (`SAFE_COMMANDS`: `flutter test/analyze`, `npm test`, `tsc --noEmit`,
   `git status/diff`…) auto-allow — để chạy test/kiểm chứng không phiền người dùng.
3. **Mọi thứ còn lại** (Edit/Write, Bash side-effect, MCP write) → `onApproval`. Từ chối →
   `behavior: 'deny'` kèm message bảo agent dừng và hỏi hướng khác.
4. **Hook monorepo** chặn thêm ở tầng `PreToolUse` (push/commit) — độc lập với cổng trên.
5. **Subagent** (nếu bật) bị `permissionMode:'plan'` + `disallowedTools` khóa cứng, không
   chạm được cổng ghi.

Ngoài ra, lệnh Bash **rủi ro** (`RISKY_COMMANDS`: `rm/mv/cp`, redirect ghi, `git push/reset
--hard/rebase/--force`, `chmod/chown/sudo`, `curl … | sh`, chạy script inline…) luôn qua cổng
duyệt **kể cả ở mode `auto`**. Không còn miễn trừ Git — kể cả `git push` cũng phải duyệt.

### 8.1. Web — năm mode phân quyền (cùng một backend)

`src/web/server.ts` bật một trong năm mode qua env `BOW_*_MODE`; mỗi mode một **cặp cổng
riêng** (`BOW_AGENT_PORT`/`BOW_WEB_PORT`) nên chạy song song không đụng nhau. Chính sách nằm
trong `canUseTool` (`runner.ts`) + middleware `checkReadonlyConfig`/`requireAdmin` (`server.ts`):

| Mode | Cổng | Ép mode | Chính sách |
|---|---|---|---|
| **Dev** (`ui`) | 4000/5173 | client chọn | Admin (localhost) full. **Client LAN non-admin bị ép `plan`** (read-only) — muốn ghi phải qua Collab |
| **QC** (`ui:qc:share`, `BOW_QC_MODE`) | 4001/5174 | `plan` | **WHITELIST** tool đọc (Read/Glob/MCP-read) **+ Skill** (kích hoạt qc-triage) **+ Jira read/write** (comment/transition); Grep DENY riêng; file nhạy cảm chặn; source code DENY; ép model `claude-sonnet-5`; ẩn UI kỹ thuật |
| **Collab** (`ui:collab`, `BOW_COLLAB_MODE`) | 4002/5175 | `auto` | CTV sửa code + chạy test tự do; **mọi thao tác GHI (Edit/Write, Bash rủi ro kể cả Git, MCP write) của CTV non-admin bị định tuyến lên ADMIN duyệt từ xa** (`requireApprovalForWrites` + `adminBus`) |
| **BA** (`ui:ba`, `BOW_BA_MODE`) | 4003/5176 | `auto` | Ghi **tài liệu** (`isDocPath`: `docs/`, `*.md/.mdx/.txt`) + **full Jira** tự do; source code / config / DB / deploy **DENY CỨNG** (không hỏi admin — muốn sửa code thì đổi mode) |
| **Reviewer** (`ui:review:share`, `BOW_REVIEWER_MODE`) | 4004/5177 | `plan` | **WHITELIST** tool đọc + Skill (pr-review) + **Bash** lọc riêng (`isReviewGhCommand`: `git diff/status/log/show`, `gh pr view/diff/list/checks/comment/review`) + `SAFE_COMMANDS` (test/analyze); Jira **đọc**; ghi file source / merge / push / risky / command-chaining **DENY**; ép `claude-sonnet-5`; ẩn UI kỹ thuật |

- **Admin = socket IP thật `127.0.0.1`** (`getSocketIp`, **bỏ qua** `X-Forwarded-For` để LAN
  không spoof header giành quyền admin). Đổi cấu hình (MCP chung/workspace/skill-sync) bị
  `checkReadonlyConfig` chặn 403 ở cả bốn mode chia sẻ QC/Reviewer/Collab/BA.
- **Duyệt từ xa (Collab)**: `session.ts` có `adminBus` (tách khỏi Session vì mỗi phiên CTV chỉ
  có một consumer SSE). CTV bị treo chờ; admin mở SSE `GET /api/admin/events`, bấm duyệt qua
  `POST /api/admin/approve` → giải Promise treo bên CTV.
- Source (`cwd`) mỗi mode cố định theo `BOW_{QC,COLLAB,BA,REVIEWER}_CWD`; admin đổi lúc chạy qua
  `POST /api/qc-cwd` (RAM override, không restart).

### 8.2. Truy cập LAN + tự chạy tiếp khi hết hạn mức

- **Cổng truy cập LAN** (`src/web/access.ts`): client non-localhost bị chặn mọi `/api/*` cho
  tới khi **gửi yêu cầu (nhập TÊN)** và được admin **duyệt** trong LAN Dashboard (không phải
  "mã số"). Token cấp lưu server ở `conversations/access.json`, client giữ ở `localStorage`
  (`bow-access-token`) và đính header `x-bow-token`. Realtime qua SSE `/api/access/events`.
- **Auto-resume hết hạn mức** (`server.ts`): phiên **đang thực thi** bị dừng vì hết hạn mức 5h
  (`isSessionLimit`) → server tính giờ reset (`resetsAt + buffer`), `setTimeout` tạo phiên mới
  **resume đúng `conversationId`** với prompt "tiếp tục", **tối đa 3 lần** (`AUTO_RESUME_MAX_ATTEMPTS`).
  Bền qua đóng tab (server-side); client có fallback đếm ngược + nút huỷ. Giả lập test bằng
  `BOW_SIMULATE_SESSION_LIMIT=true`.

## 9. Workspace — nhóm nhiều repo + trí nhớ tích lũy

> **Trạng thái:** ĐÃ IMPLEMENT (`src/profiles/workspace.ts`, ghép vào `runner.ts`; UI quản lý
> ở panel workspace của web + API `/api/workspace/*`). Kích hoạt bằng cách đăng ký repo vào
> `workspaces/workspaces.json` — chưa đăng ký thì hành vi y như cũ.
> Quyết định người dùng: (a) ưu tiên **liên kết nhiều repo**, (b) trí nhớ ghi **tự động**,
> (c) lưu **trong bow-agent, gitignore** (giống `generated-profiles/`), (d) agent được
> **đọc chéo read-only** repo anh em.

### 9.1. Vấn đề

Ba nguồn tri thức ở §3 đều **tĩnh và gắn với một `cwd` đơn lẻ**. Thực tế của người dùng
không vừa khuôn đó:

- **Một "sản phẩm" trải trên nhiều repo ở nhiều thư mục**: BE một nơi, FE một nơi, có khi
  thêm infra/monorepo. Profile đặt tên theo `basename(cwd)` (`generate.ts:29`) nên mỗi thư
  mục là một hòn đảo — trỏ agent vào FE thì nó **không biết gì về contract API của BE**.
- **Không có trí nhớ giữa các phiên**: `generateProfile` chỉ chụp *cấu trúc tĩnh* một lần.
  Test agent với một repo, quay lại phiên sau → mọi quyết định/điều-học-được của phiên trước
  bốc hơi. (`resumeSessionId` chỉ khôi phục *một* luồng hội thoại, không phải tri thức tích
  lũy xuyên phiên/xuyên repo.)

Kết quả: người dùng phải "dạy lại" ngữ cảnh mỗi lần, và không có cách nào nói với agent
"FE này ăn với BE kia".

### 9.2. Khái niệm: Workspace = 1 sản phẩm gồm nhiều repo

Thêm **một lớp trên profile** (không thay thế). Workspace gom nhiều `cwd` (mỗi cái vẫn có
profile riêng như cũ) vào một sản phẩm, kèm hai file tri thức dùng chung:

```
bow-agent/
└── workspaces/                      ← gitignore, per-máy (như generated-profiles/)
    ├── workspaces.json              ← đăng ký: workspace ⇄ các repo (cwd) + vai trò
    └── app-giao-hang/
        ├── shared.md                ← tri thức CHUNG sản phẩm (contract BE↔FE, quyết định KT)
        └── journal.md               ← nhật ký TỰ ĐỘNG: mỗi phiên append 1 mục
```

`workspaces.json`:

```jsonc
{
  "app-giao-hang": {
    "repos": {
      "/path/to/delivery-backend": "BE",
      "/path/to/delivery-flutter":  "FE",
      "/path/to/delivery-monorepo": "infra"
    }
  }
}
```

Vì sao lưu ở đây: **mirror y hệt `generated-profiles/`** — cùng chỗ, cùng chính sách
gitignore, cùng "runtime per-máy". Không thêm khái niệm lưu trữ mới, tái dùng nguyên tắc
§3 đã có.

### 9.3. Cơ chế 1 — Liên kết repo (ưu tiên làm trước)

**Khi trỏ agent vào một `cwd`** (`runner.ts`, ngay chỗ ghép profile `runner.ts:281–283`):

1. `resolveWorkspace(cwd)`: quét `workspaces.json`, khớp `cwd` theo **tiền tố đường dẫn**
   (repo là con của một `cwd` đã đăng ký cũng tính) → trả workspace chứa nó, hoặc `null`.
2. Nếu thuộc một workspace → append vào system prompt **một khối mới**, đặt *trước* project
   profile (chung → riêng), gồm:
   - **`shared.md`** — tri thức chung sản phẩm.
   - **Bản đồ repo anh em** — liệt kê từng repo + vai trò + đường dẫn tuyệt đối, để agent
     biết "BE nằm ở đâu, FE dùng contract nào".
   - **`journal.md`** — trí nhớ tích lũy (xem §9.4).
3. Repo **không** thuộc workspace nào → không có khối này → hành vi y hệt hiện tại. Đây là
   lớp **opt-in**, không đổi đường chạy cũ (đúng nguyên tắc §1).

**Đọc chéo read-only** (quyết định của người dùng). Hiện `allowedTools` mở `Read/Grep/Glob`
nhưng SDK giới hạn theo `cwd`, nên agent làm FE không đọc được file BE. Cần **mở phạm vi đọc
sang các repo anh em, chỉ đọc**:

- SDK cho phép truyền thêm gốc đọc qua `additionalDirectories` (đường dẫn các repo anh em).
  Agent `Read/Grep/Glob` được sang BE để hiểu contract thật, **không đoán**.
- **Ghi vẫn khóa trong repo hiện tại.** Cổng `isPathInRepo` (`runner.ts:340–344`) chỉ tính
  `workdir` (cwd). Repo anh em nằm ngoài `workdir` → mọi Edit/Write vào đó **rơi vào nhánh
  "ghi ngoài repo" → luôn hỏi duyệt** (kể cả mode `auto`). Tức là *đọc chéo tự do, ghi chéo
  vẫn phải xin phép* — không cần thêm luật mới, tận dụng đúng cổng §8 đã có.
- Prompt phải nói rõ: *repo anh em là để THAM CHIẾU (đọc); đừng sửa chúng trừ khi người dùng
  yêu cầu và duyệt.*

### 9.4. Cơ chế 2 — Trí nhớ tích lũy tự động (ăn theo, gần như miễn phí)

Vì §9.3 đã load `journal.md`, phần còn lại chỉ là **ghi** nó cuối phiên.

**Ghi (tự động):** sau khi `query()` kết thúc thành công (`runner.ts` sau nhánh
`case 'result'`), chạy một bước cô đọng ngắn: tóm tắt phiên vừa rồi thành 3–6 gạch đầu dòng
— *đã làm gì / quyết định gì / học được gì về sản phẩm* — rồi **append** một mục có mốc thời
gian vào `journal.md` của workspace. (Chỉ khi cwd thuộc một workspace; ngược lại bỏ qua.)

Hai cách hiện thực bước cô đọng — bản **rẻ** đã được chọn và implement
(`condenseForJournal` trong `runner.ts`):
- **Rẻ (đang dùng):** tận dụng chính `finalText` (báo cáo-khi-xong ở §BOW_AGENT_APPEND đã có
  cấu trúc "đã đổi gì / verify gì / còn gì") → cắt gọn & append. **Không tốn thêm lượt model.**
- **Kỹ hơn:** một lời gọi `query()` phụ, ngắn, nhồi transcript → bản tóm tắt cô đọng. Tốn
  thêm token; chỉ dùng nếu bản rẻ ra nhiễu.

**Chống phình:** journal là append-only sẽ lớn dần → chỉ nạp **N mục gần nhất** (hoặc tới
ngưỡng ký tự) vào prompt; mục cũ giữ trên đĩa để tra tay. Không có cơ chế "học" phức tạp —
đúng tinh thần §3 "tĩnh, đọc được, kiểm soát được": journal chỉ là markdown người đọc và sửa
tay được. Đây **không** phải "Genome" đã gỡ (không fitness/mutation, không vòng tiến hóa) —
chỉ là một cuốn nhật ký phẳng.

### 9.5. Điểm ghép code (tối thiểu, không phá đường chạy cũ — đã ghép đủ)

| Việc | File | Ghép thế nào |
|---|---|---|
| Module workspace (đọc/ghi md + json, resolve theo tiền tố cwd) | `src/profiles/workspace.ts` (mới) | Mirror `index.ts`/`generate.ts`; dùng lại pattern `GENERATED_DIR`. |
| Nhồi khối workspace vào prompt | `src/core/runner.ts` (§281–283) | `resolveWorkspace(cwd)` → append shared+map+journal trước project profile. |
| Mở đọc chéo read-only | `src/core/runner.ts` (`options`) | Thêm `additionalDirectories` = đường dẫn repo anh em. |
| Ghi journal cuối phiên | `src/core/runner.ts` (sau `case 'result'`) | Cô đọng `finalText` → append vào `journal.md`. |
| Đăng ký/gán repo vào workspace | `src/web/server.ts` + `web/App.tsx` | Ô chọn/tạo workspace cạnh ô `cwd` (giống panel MCP). |
| gitignore | `.gitignore` | Thêm `workspaces/`. |

**Vì sao an toàn:** toàn bộ tính năng *song song* với `generated-profiles/`, kích hoạt chỉ
khi `cwd` khớp một workspace đã đăng ký. Không đăng ký gì → không đổi hành vi. Ghi chéo vẫn
qua cổng duyệt §8. Trí nhớ là markdown phẳng, sửa/xóa tay được — không có trạng thái ẩn.

### 9.6. Ngoài phạm vi (cố ý chưa làm)

- **Chia sẻ trí nhớ giữa các máy** (commit / server chung): người dùng chọn gitignore per-máy.
  Nếu sau cần share → chỉ đổi nơi lưu, cơ chế giữ nguyên.
- **Duyệt trước khi ghi journal**: chọn "tự động". Nếu journal ra nhiễu → thêm nút duyệt sau.
- **Suy luận quan hệ repo tự động** (đoán FE↔BE): làm thủ công qua `workspaces.json` trước;
  không đoán để tránh sai.

## 10. Hướng mở rộng (chưa làm)

- **UI chọn skill / subagent**: hiện agent tự chọn skill; subagent bật cả-cụm qua cờ. Có
  thể thêm ô chọn trên web như panel MCP.
- **Profile có subagent riêng**: khung `profileSubagents` đã có (`buildSubagents` gộp) nhưng
  các profile `.md` hiện chưa khai báo subagent nào.
- **Marker file cho monorepo**: `isMonorepo` đang nhận theo segment path; đổi sang marker
  file (vd `scripts/check-quest.sh`) sẽ chính xác hơn cho repo trùng tên.
- **Journal cho phiên thất bại**: hiện journal chỉ ghi khi phiên chạy thành công — bài học
  từ phiên lỗi / bị từ chối duyệt chưa được lưu.
