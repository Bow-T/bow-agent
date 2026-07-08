# bow-agent

AI agent nhận **đề tài / tài liệu WBS / task-bug từ Jira** rồi tự **lập kế hoạch** và **thực thi** thay đổi code — chạy theo mô hình *plan-then-approve* (lập kế hoạch trước, xin duyệt trước khi thay đổi thật).

Repo độc lập, thiết kế để **tái sử dụng cho nhiều dự án**: trỏ agent vào bất kỳ repo nào qua `--cwd`, và mỗi dự án có thể tự động sinh một **profile** kiến thức riêng.

Xây trên [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (engine chạy Claude Code).

---

## Chuẩn hóa base source của team 🧩

bow-agent **là công cụ** (TS/Node + Claude Agent SDK) — *không* phải app Flutter. Nhưng
nó không phải công cụ trung lập: nó được **đóng khuôn theo base source chuẩn của team**.

### Base source chuẩn = Flutter + Supabase + Stripe + Jira + Mapbox

Mọi app của team dựng theo cùng một khuôn công nghệ và cùng một bộ quy ước. bow-agent
**mang sẵn chuẩn đó** trong một *base profile* (`src/profiles/base/app-base-flutter-supabase.md`)
— agent biết trước cách team dựng app trước cả task đầu tiên:

| Công nghệ | Chuẩn team mà agent áp sẵn |
| --------- | -------------------------- |
| **Flutter** | Cấu trúc `pages/components/services/models`, DI qua **get_it** (expose ở `base_vm`), state bằng **provider/ChangeNotifier**, routing **AutoRoute** (regen `.gr.dart`), model **@JsonSerializable** (regen `.g.dart`), mọi chuỗi qua **l10n**. |
| **Supabase** | Query gom trong `services/`, **RLS bắt buộc** cho bảng mới, đổi schema bằng **migration** (không sửa DB tay). Qua MCP: `list_tables`, `get_advisors`, `get_logs`… |
| **Stripe** | Logic tính tiền/charge **ở backend** (Edge Function), client chỉ khởi tạo PaymentSheet; key đọc từ env, không hardcode. |
| **Jira** | Nhận task từ ticket/board; đọc issue + AC trước khi làm; ghi comment/subtask (phải duyệt). |
| **Mapbox** | Token từ env (không hardcode); xử lý đúng quyền vị trí + case người dùng từ chối. |

### Vì sao điều này giúp dự án mới chạy nhanh 🚀

> **Dự án mới cùng khuôn → dùng `--profile app-base-flutter-supabase` → agent biết chuẩn team
> ngay từ task đầu**, không phải "dạy lại" từ đầu mỗi lần.

Hai tầng tri thức, từ chung tới riêng:

1. **Base profile (chuẩn team)** — viết tay, **được commit & chia sẻ**, áp cho *mọi* dự án
   cùng khuôn. Đây là "hiến pháp kỹ thuật". → mục [Base profile](#base-profile--chuẩn-team-dùng-lại-cho-mọi-dự-án) bên dưới.
2. **Profile tự sinh** (`generated-profiles/`) — agent quét một repo lạ rồi ghi kiến thức
   riêng repo đó (gitignore, per-máy).

Base profile là nền chung; profile tự sinh tinh chỉnh cho từng repo lạ. Riêng **monorepo
của team** có thêm một bó tri thức đóng gói sẵn (CLAUDE.md + skill + hook), tự kích hoạt
khi `--cwd` nằm trong monorepo — xem mục [Ngữ cảnh monorepo](#ngữ-cảnh-monorepo--gói-sẵn-tự-kích-hoạt) bên dưới.

---

## Cài đặt

```bash
cd bow-agent
npm install
```

### Xác thực Claude — qua Claude CLI login

bow-agent xác thực **bằng login Claude CLI** (không dùng API key). Nếu máy đã đăng nhập
(`claude` → `/login`, dùng gói Claude Pro/Max), bow-agent **dùng luôn login đó** — Agent SDK
spawn tiến trình `claude`, tiến trình đó tự đọc credentials ở `~/.claude`.

Chưa login? Chạy `claude` rồi `/login` một lần. Dòng banner khi chạy hiện `auth=Claude CLI login`
(hoặc `auth=CHƯA ĐĂNG NHẬP` nếu thiếu).

---

## Dùng qua Web UI (khuyến nghị) 🌐

Giao diện chat trên trình duyệt — gõ task, xem tiến độ, bấm nút duyệt.

```bash
npm run ui
```

→ Mở **http://localhost:5173**. Trong đó:
- Ô nhập **task / đề tài** (Ctrl+Enter để chạy) + ô **Jira** + ô **cwd** (thư mục repo).
- **Tự nhận diện source**: gõ `cwd` → agent tự đoán loại dự án và chọn profile phù hợp (`auto`). Dòng 🔎 hiện kết quả nhận diện.
- **Jira URL hoặc key**: dán `PROJ-123` hoặc cả URL `/projects/PROJ/boards/123` — agent tự bóc ticket / board / project rồi đọc đúng.
- **Kéo-thả tài liệu, PDF & ảnh**: thả file WBS/spec (text/markdown), **PDF** (tự trích text) và ảnh (wireframe/screenshot) vào ô nhập, hoặc bấm 📎. Agent đọc tài liệu và nhìn ảnh (vision).
- **Sinh profile cho repo lạ**: trỏ vào repo chưa biết → nút *Sinh profile* → agent quét repo (chỉ đọc) rồi lưu kiến thức vào `generated-profiles/`, lần sau dùng ngay.
- Toggle **Chế độ**: `Kế hoạch` (an toàn, chỉ đọc/phân tích) / `Thực thi` (sửa code, hỏi duyệt).
- Nút **🌙/☀** đổi giao diện **Dark/Light** (pixel-art).
- Khi agent muốn sửa file / chạy lệnh / ghi Jira → **thẻ duyệt** với nút **Cho phép / Từ chối**.
- Nút **Dừng** hủy giữa chừng.

`npm run ui` chạy cùng lúc backend (cổng 4000) + frontend Vite (cổng 5173).
Muốn 1 cổng duy nhất (production): `npm run ui:preview` → mở http://localhost:4000.

---

## Dùng qua Terminal (CLI)

Có thể chạy trực tiếp bằng `tsx` (không cần build) hoặc từ bản build:

```bash
# Chạy nhanh khi dev (không cần build)
npm run dev -- run --wbs ./examples/task.example.md --cwd ~/GitProject/my-project

# Hoặc sau khi build:
node dist/cli/index.js run PROJ-123 --cwd ~/GitProject/my-project
```

### Ba nguồn đầu vào (có thể kết hợp)

| Nguồn            | Cách dùng                                   |
| ---------------- | ------------------------------------------- |
| **Jira ticket**  | `run PROJ-123` (đọc qua MCP jira — mặc định bật) |
| **File WBS/đề tài** | `run --wbs ./task.md`                    |
| **Text trực tiếp** | `run --text "Thêm nút copy mã đơn hàng"` |

### Cờ

| Cờ                | Ý nghĩa                                                          |
| ----------------- | --------------------------------------------------------------- |
| *(mặc định)*      | **Chỉ lập kế hoạch** — agent không sửa file, chỉ trình kế hoạch  |
| `--execute`       | Thực thi thật; mọi thao tác GHI/side-effect đều hỏi duyệt (y/N)  |
| `--cwd <dir>`     | Repo agent làm việc (mặc định: thư mục hiện tại)                 |
| `--profile <name>`| Kiến thức dự án: `none` (mặc định), `app-base-flutter-supabase` (chuẩn team), hoặc profile tự sinh |
| `--subagents`     | Bật **multi-agent**: agent chính giao việc cho subagent chuyên biệt (reviewer / verifier / impact-scout). Mặc định TẮT. Xem mục [Multi-agent](#multi-agent--subagent-chuyên-biệt-opt-in) |
| `--mcp [names]`   | Bật MCP (Supabase/Jira/Codemagic…); **mặc định BẬT tất cả** (để đọc được Jira ticket). `--mcp jira,supabase` để giới hạn |
| `--no-mcp`        | Tắt hoàn toàn MCP (chạy offline, không đọc Jira/DB)              |
| `--effort <lvl>`  | `low\|medium\|high\|xhigh\|max` (mặc định `high`)               |
| `-h`, `--help`    | In hướng dẫn                                                     |

### Ví dụ

```bash
# 1) Lập kế hoạch cho một ticket (an toàn — không sửa gì)
bow-agent run PROJ-123 --cwd ~/GitProject/my-project

# 2) Nhận task từ WBS rồi thực thi (hỏi duyệt từng thao tác ghi)
bow-agent run --wbs ./examples/task.example.md --cwd ~/GitProject/my-project --execute

# 3) Kết hợp ticket + WBS bổ sung, effort cao nhất
bow-agent run PROJ-123 --wbs ./ac.md --execute --effort xhigh --cwd ~/GitProject/my-project
```

---

## Cách hoạt động

```
      đề tài / WBS / Jira ticket
                 │
        ┌────────▼─────────┐
        │  input/task.ts   │  chuẩn hóa thành "task brief"
        └────────┬─────────┘
                 │
        ┌────────▼──────────────────────────────────┐
        │   core/runner (Claude Agent SDK query)     │
        │   systemPrompt = preset Claude Code        │
        │     + quy trình plan-then-approve          │
        │     + PROJECT PROFILE (kiến thức repo)     │
        │     + skill chung + ngữ cảnh monorepo     │
        │   + đọc CLAUDE.md của repo                 │
        │   (+ subagents nếu --subagents)           │
        └───┬───────────────────────────────────────┘
            │
    ┌───────▼─────────┐
    │ tools & file    │
    │ MCP / bash /    │
    │ edit (GHI duyệt)│
    └─────────────────┘
```

### Chế độ & an toàn

- **`plan` mode** (mặc định): dùng `permissionMode: 'plan'` của SDK — agent khám phá + lập kế hoạch nhưng **không** sửa file/chạy lệnh.
- **`execute` mode**: agent thực thi, nhưng mọi tool GHI (Write/Edit/Bash có side-effect, `add_comment`, `create_subtask`) đi qua cổng `canUseTool` → hỏi duyệt trước khi chạy. Tool ĐỌC (Read/Grep/Glob, đọc Jira) tự cho phép.
- Agent đọc `CLAUDE.md` của repo đích (qua `settingSources: ['project']`), nên quy ước riêng từng dự án được tôn trọng tự động.

---

## MCP — dùng lại kết nối của Claude Code 🔌

Bow-agent nạp các MCP server đã cấu hình cho Claude Code (`~/.claude.json`) — Supabase, Jira, Codemagic, Figma — nên nó **mạnh ngang Claude Code** ở mảng "kết nối thật":

- **Supabase**: xem DB thật (`list_tables`, `list_migrations`), quét lỗi (`get_advisors`), debug (`get_logs`), sinh types. Tool **đọc** tự chạy; tool **ghi** (`execute_sql`, `apply_migration`, `deploy_edge_function`) phải **duyệt**.
- **Jira**: đọc issue/board/search. **Codemagic**: build (phải duyệt).

**MẶC ĐỊNH BẬT tất cả** — để agent đọc được Jira ticket ngay từ đầu. Tùy chọn giới hạn/tắt:

```bash
bow-agent run PROJ-123               # (mặc định) nạp mọi MCP đã cấu hình
bow-agent run PROJ-123 --mcp jira    # chỉ nạp server jira
bow-agent run --text "..." --no-mcp  # tắt hoàn toàn (chạy offline)
```

> ⚠️ **Lưu ý bảo mật.** Claude Agent SDK truyền cấu hình MCP (kèm token) **qua tham số command-line**, nên khi MCP bật, bất kỳ ai chạy `ps aux` trên máy đều đọc được token trong lúc agent chạy. Dùng `--no-mcp` cho task không cần kết nối thật để giảm thời gian token lộ.

Token nằm nguyên trong `~/.claude.json` của máy, **bow-agent không hardcode** — chỉ tham chiếu lúc chạy.

---

## Multi-agent — subagent chuyên biệt (opt-in)

Mặc định bow-agent chạy **single-agent** (một agent làm hết). Bật `--subagents` để agent
chính có thể **giao việc cho subagent chuyên biệt** qua tool `Agent` — mượn ý *role
specialization*, hiện thực bằng `Options.agents` của Claude Agent SDK (không bê framework ngoài):

```bash
bow-agent run PROJ-123 --execute --subagents --cwd ~/GitProject/monorepo/apps/mobile
```

| Subagent | Vai trò | Quyền |
| -------- | ------- | ----- |
| **reviewer** | Phản biện kế hoạch/diff trước khi trình duyệt: tìm call-site bỏ sót, rủi ro cross-cutting, over-engineering. | Chỉ đọc (`permissionMode: 'plan'`) |
| **verifier** | Kiểm chứng thay đổi đã làm: chạy test/analyze + trace luồng runtime end-to-end (không chỉ "compile pass"). | Đọc + chạy lệnh kiểm chứng |
| **impact-scout** | Quét blast radius khi đổi contract/enum/schema: liệt kê MỌI call-site + allow-list/switch liệt-kê-tay. | Chỉ đọc |

- **MẶC ĐỊNH TẮT.** Với repo nhỏ / task rõ, một agent tự làm đủ; subagent chỉ thêm chi phí token. Đáng bật cho **task lớn, cross-cutting** (repo thật như monorepo) nơi việc rà soát/kiểm chứng độc lập bù lại chi phí.
- Subagent đều **read-only / chỉ chạy lệnh kiểm chứng** (chặn cứng Edit/Write/commit/push). Mọi thay đổi thật vẫn do **agent chính** làm và **vẫn qua cổng duyệt** — bật multi-agent không nới lỏng an toàn.
- Profile có thể bổ sung subagent riêng (ghi đè bộ chuẩn nếu trùng tên); chỉ có tác dụng khi `--subagents` bật.

> Thiết kế đầy đủ: xem **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Ngữ cảnh monorepo — gói sẵn, tự kích hoạt

Toàn bộ `.claude` của monorepo (CLAUDE.md + skill + hook) được **đóng gói sẵn** vào bow-agent
(`skills/monorepo/`), nên khi `--cwd` nằm trong monorepo, agent tự áp:

- **CLAUDE.md** (quy ước dự án) đưa nguyên vào system prompt.
- **Danh mục skill** (name + description + đường dẫn) — agent tự `Read` full `SKILL.md` khi task khớp, tránh nhồi cả nghìn dòng vào mọi lượt.
- **Hook** (`guard-push`, `guard-commit-branch`, `self-verify-rubric`, `ensure-githooks`) — chặn push khi quest gate fail, chặn commit trên branch protected, nhắc rubric.
- **Tự nhận mã dự án Jira** (`<PROJECT_KEY>`) từ branch/commit/`.env` rồi map placeholder trong skill sang mã thật.

Đây là bản **COPY** — không đụng `.claude` của monorepo. Khi monorepo đổi skill/hook, đồng bộ
lại bằng `npm run sync-monorepo`.

---

## Base profile — chuẩn team dùng lại cho mọi dự án 🧩

Base profile là **kiến thức chuẩn viết tay**, được **commit vào repo** (khác profile tự
sinh — vốn gitignore). File nằm ở `src/profiles/base/*.md`. Hiện có:

| Profile | Dùng cho |
| ------- | -------- |
| `app-base-flutter-supabase` | App team dựng theo khuôn **Flutter + Supabase + Stripe + Jira + Mapbox** |

**Dùng cho một dự án mới cùng khuôn:**

```bash
bow-agent run PROJ-123 --profile app-base-flutter-supabase --cwd ~/GitProject/new-app --execute
```

Agent lập tức áp chuẩn team: cấu trúc thư mục, DI qua get_it, AutoRoute/regen, RLS bắt
buộc, l10n, Stripe ở backend… — không phải khám phá lại từ đầu.

**Tạo/cập nhật chuẩn:**

1. Sửa hoặc thêm file `.md` trong `src/profiles/base/` (một dự án = một profile, hoặc
   dùng chung nếu cùng khuôn). Viết **thực tế, ngắn gọn**, tập trung vào quy ước + cạm bẫy.
2. Commit — cả team và mọi dự án dùng ngay.

> **Base profile là gợi ý mạnh, không phải luật cứng.** Prompt dặn agent: nếu thực tế repo
> mâu thuẫn với một mục trong profile → **tin repo**. Khi phát hiện chuẩn đã lỗi thời, sửa
> lại file base và commit — đó là cách chuẩn của team tiến hóa có kiểm soát.

---

## Jira — đọc qua MCP

Bow-agent đọc/ghi Jira **hoàn toàn qua MCP** (server `jira` của Claude Code, cấu hình trong
`~/.claude.json`) — **không** còn REST client riêng, **không** cần điền `JIRA_*` trong `.env`.

- **Đọc** (tự cho phép): `jira_get_issue`, `jira_get_comments`, `jira_search_issues`…
- **Ghi** (phải duyệt): `jira_add_comment`, `jira_create_subtask`, `jira_transition_issue`…

Chỉ cần đảm bảo Claude Code đã cấu hình MCP jira (`claude mcp add` hoặc trong `~/.claude.json`).
Trên **CLI**, MCP bật mặc định nên chỉ cần dán ticket là chạy. Trên **Web**, chọn server `jira`
ở panel MCP. Tùy chọn `BOW_PROJECT_KEY` (hoặc `JIRA_PROJECT_KEY`) trong `.env` để cố định mã
dự án nếu không muốn agent tự đoán từ git branch.

---

## Cấu trúc

```
src/
  config/env.ts       # đọc .env (nguồn duy nhất đọc process.env)
  input/task.ts       # chuẩn hóa đầu vào (ticket / WBS file / text)
  input/jira-ref.ts   # bóc Jira URL/key → ticket / board / project
  input/pdf.ts        # trích text từ PDF upload
  tools/mcp.ts        # nạp MCP từ ~/.claude.json + quản lý MCP qua UI (add/remove)
  profiles/
    index.ts          # registry profile (chọn qua --profile): base → tự-sinh
    base/             # profile CHUẨN của team (committed) — vd app-base-flutter-supabase.md
    detect.ts         # tự nhận diện stack repo (Flutter/Supabase/Node…)
    generate.ts       # agent quét repo lạ → sinh profile (generated-profiles/, gitignore)
  core/
    systemPrompt.ts   # quy trình chung của agent (append vào preset Claude Code)
    runner.ts         # LÕI agent: query() + profile + skill + subagents + events + approval
    subagents.ts      # bộ subagent chuẩn (reviewer/verifier/impact-scout) — opt-in
  skills/
    index.ts          # nạp skill prompt-only chung (skills/prompt/*.md)
    monorepo.ts       # nhận diện monorepo + nạp CLAUDE.md + danh mục skill đóng gói
    hooks.ts          # bọc hook shell của monorepo thành SDK hook (guard/verify)
  cli/index.ts        # entrypoint CLI (dùng lõi runner + terminal y/N)
  web/
    server.ts         # backend Express: /api/run + SSE /api/events + /api/approve
    session.ts        # phiên chạy + hàng đợi sự kiện + cổng duyệt treo Promise
skills/               # skill đóng gói: prompt/* (chung) + monorepo/* (COPY từ .claude monorepo)
web/                  # frontend React (Vite)
  App.tsx             # chat + toggle plan/execute + thẻ duyệt + model selection + cost tracking
  main.tsx, styles.css, types.ts
examples/
  task.example.md     # WBS mẫu
```

> **CLI và Web dùng chung lõi** `core/runner.ts` — khác nhau chỉ ở cách hiển thị (terminal vs SSE) và cách duyệt (gõ y/N vs bấm nút). Không trùng logic.

---

## Ghi chú

- **Model**: `claude-opus-4-8`. CLI luôn chạy model này; Web UI cho chọn model khác qua giao diện.
- **Node ≥ 18** (dùng `fetch` gốc, ESM).
- Agent **không** tự commit/push/apply-migration trừ khi bạn yêu cầu rõ và duyệt.
