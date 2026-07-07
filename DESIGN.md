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
      │    • skill prompt-only chung (skills/prompt/*)   │
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
| **Ngữ cảnh monorepo** | CLAUDE.md + danh mục skill đóng gói, tự kích hoạt | chỉ khi cwd ∈ monorepo | `skills/monorepo/` |

Prompt luôn dặn: *nếu thực tế repo mâu thuẫn với profile → tin repo*. Tri thức là gợi ý
mạnh, không phải luật cứng.

## 4. Skill — năng lực tái sử dụng

Ba nguồn skill, agent tự chọn theo mô tả (không cần người dùng bật qua UI):

| Nguồn | Cơ chế | Phạm vi |
|---|---|---|
| **Repo đích** `.claude/skills/*/SKILL.md` | SDK auto-discover nhờ `settingSources:['project']` + `skills:'all'` | riêng từng dự án |
| **bow-agent** `skills/prompt/*.md` (prompt-only) | `loadPromptSkills()` đọc → append vào system prompt | mọi repo |
| **monorepo bundle** `skills/monorepo/skills/*` | danh mục (name+desc+path) trong prompt; agent tự `Read` full khi task khớp | chỉ monorepo |

> **Không còn skill kèm code.** Bản đầu có server `bow-skills` (`src/skills/code.ts`) chạy
> logic thật qua `tool()`. Đã gỡ — với model mạnh, Bash + các tool sẵn của Claude Code đã
> đủ; một server MCP nội bộ chỉ để "chạy test" là phức tạp thừa.

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

Toàn bộ `.claude` của monorepo được COPY vào bow-agent (`skills/monorepo/`) để agent KHÔNG
cần `.claude` trong monorepo nữa. Chỉ áp khi cwd là monorepo.

- **Nhận diện** (`src/skills/monorepo.ts` → `isMonorepo`): cwd có segment `monorepo`. Tách
  riêng một hàm để sau này đổi sang marker file chỉ cần sửa một chỗ.
- **Mã dự án Jira** (`detectJiraProjectKey`): ưu tiên `.env` (`BOW_PROJECT_KEY`), rồi branch,
  commit gần nhất, cuối cùng đoán từ tên thư mục. Skill/CLAUDE.md dùng placeholder
  `<PROJECT_KEY>` được map sang mã thật khi nạp.
- **CLAUDE.md + danh mục skill** (`loadMonorepoContext`): CLAUDE.md đưa nguyên vào prompt;
  skill chỉ đưa name+description+đường-dẫn (agent tự `Read` full khi task khớp) — tránh nhồi
  cả nghìn dòng vào mọi lượt. Danh mục quét động nên số lượng tự cập nhật theo bundle.
- **Hooks** (`src/skills/hooks.ts` → `buildMonorepoHooks`): bọc 4 script shell đã copy thành
  SDK hook callback, chỉ gắn khi cwd là monorepo:
  - `PreToolUse(Bash)`: guard-push (chặn push khi quest gate fail), guard-commit-branch
    (chặn commit trên branch protected) → `exit 2` map thành `{ decision: 'block' }`.
  - `SessionStart`: ensure-githooks (wire core.hooksPath, không chặn).
  - `Stop`: self-verify-rubric (nhắc rubric khi có commit chưa push, không chặn).
  - Script tìm `scripts/*.sh` của monorepo qua `CLAUDE_PROJECT_DIR` = monorepo root.
  - **Fail-open**: hook lỗi hạ tầng không kéo sập agent.

Bản gói là COPY (không đụng `.claude` của monorepo). Khi monorepo đổi skill/hook, đồng bộ
lại bằng `npm run sync-monorepo` (`scripts/sync-monorepo.ts`) — làm mới `skills/monorepo/`,
deref symlink (vd stripe-*) thành nội dung thật để bundle tự túc, dọn `.DS_Store`. Nguồn
override qua arg hoặc `BOW_AGENT_MONOREPO_CLAUDE`. `.claude` monorepo giữ nguyên để vẫn
dùng được Claude Code trực tiếp.

> **Lưu ý sync:** bundle hiện dùng prefix skill `bow-*`. Nếu
> `.claude/skills` của monorepo còn `octopus-*`, chạy `sync-monorepo` sẽ kéo tên cũ về —
> đồng bộ prefix ở monorepo gốc trước khi sync, hoặc điều chỉnh script sync.

## 7. MCP — dùng lại kết nối của Claude Code

`src/tools/mcp.ts` nạp MCP server (stdio) từ `~/.claude.json` — Supabase, Jira, Codemagic,
Figma. Không hardcode token; chỉ tham chiếu lúc chạy.

- **CLI**: mặc định BẬT tất cả (để đọc được Jira ticket ngay). `--mcp a,b` giới hạn,
  `--no-mcp` tắt.
- **Web**: người dùng tick chọn server ở panel MCP; còn quản lý được add/remove (ghi
  `~/.claude.json` an toàn có backup+validate, che token trong args/env khi trả về UI).
- **Gate tool**: tool đọc (`list_*`, `get_*`, `jira_get_*`, `search_docs`…) auto-allow qua
  `mcpReadToolPatterns`; tool ghi (`execute_sql`, `apply_migration`, `jira_add_comment`…)
  phải duyệt.

> ⚠️ SDK truyền cấu hình MCP (kèm token) qua tham số command-line → khi MCP bật, `ps aux`
> đọc được token lúc agent chạy. Dùng `--no-mcp` cho task không cần kết nối thật.

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

## 9. Hướng mở rộng (chưa làm)

- **UI chọn skill / subagent**: hiện agent tự chọn skill; subagent bật cả-cụm qua cờ. Có
  thể thêm ô chọn trên web như panel MCP.
- **Profile có subagent riêng**: khung `profileSubagents` đã có (`buildSubagents` gộp) nhưng
  các profile `.md` hiện chưa khai báo subagent nào.
- **Marker file cho monorepo**: `isMonorepo` đang nhận theo segment path; đổi sang marker
  file (vd `scripts/check-quest.sh`) sẽ chính xác hơn cho repo trùng tên.
