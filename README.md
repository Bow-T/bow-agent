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

Ba tầng tri thức, từ chung tới riêng:

1. **Base profile (chuẩn team)** — viết tay, **được commit & chia sẻ**, áp cho *mọi* dự án
   cùng khuôn. Đây là "hiến pháp kỹ thuật". → mục [Base profile](#base-profile--chuẩn-team-dùng-lại-cho-mọi-dự-án) bên dưới.
2. **Profile tự sinh** (`generated-profiles/`) — agent quét một repo lạ rồi ghi kiến thức
   riêng repo đó (gitignore, per-máy).
3. **Genome** (`--genome`) — tri thức *tiến hóa* riêng từng repo qua các lần chạy.

Base profile là nền chung; hai tầng sau tinh chỉnh cho từng dự án cụ thể.

---

## Cài đặt

```bash
cd bow-agent
npm install
```

### Xác thực Claude — chọn 1 trong 2 cách

**Cách 1 — Dùng login Claude CLI sẵn có (khuyến nghị, KHÔNG cần API key)**

Nếu máy đã đăng nhập Claude CLI (`claude` → `/login`, dùng gói Claude Pro/Max), bow-agent **dùng luôn login đó** — không cần API key, không tốn phí API riêng. Agent tự phát hiện thư mục credentials `~/.claude`.

**Cách 2 — API key riêng**

```bash
cp .env.example .env      # rồi điền ANTHROPIC_API_KEY (key tại console.anthropic.com)
```

Agent tự chọn: có `ANTHROPIC_API_KEY` → dùng key; không có nhưng đã login CLI → dùng login. Dòng banner khi chạy hiện rõ `auth=Claude CLI login` hay `auth=API key`.

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
| **Jira ticket**  | `run PROJ-123` (cần cấu hình `JIRA_*`)      |
| **File WBS/đề tài** | `run --wbs ./task.md`                    |
| **Text trực tiếp** | `run --text "Thêm nút copy mã đơn hàng"` |

### Cờ

| Cờ                | Ý nghĩa                                                          |
| ----------------- | --------------------------------------------------------------- |
| *(mặc định)*      | **Chỉ lập kế hoạch** — agent không sửa file, chỉ trình kế hoạch  |
| `--execute`       | Thực thi thật; mọi thao tác GHI/side-effect đều hỏi duyệt (y/N)  |
| `--cwd <dir>`     | Repo agent làm việc (mặc định: thư mục hiện tại)                 |
| `--profile <name>`| Kiến thức dự án: `none` (mặc định), `app-base-flutter-supabase` (chuẩn team), hoặc profile tự sinh |
| `--genome`        | Bật **bộ nhớ tiến hóa** per-repo (mặc định TẮT). Xem mục Genome  |
| `--mcp [names]`   | Bật MCP (Supabase/Jira/Codemagic…); mặc định TẮT (xem cảnh báo)  |
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
        │   + đọc CLAUDE.md của repo                 │
        └───┬───────────────────────────────────────┘
            │
    ┌───────▼─────────┐
    │ tools & file    │
    │ jira / bash /   │
    │ edit (GHI duyệt)│
    └─────────────────┘
```

### Chế độ & an toàn

- **`plan` mode** (mặc định): dùng `permissionMode: 'plan'` của SDK — agent khám phá + lập kế hoạch nhưng **không** sửa file/chạy lệnh.
- **`execute` mode**: agent thực thi, nhưng mọi tool GHI (Write/Edit/Bash có side-effect, `add_comment`, `create_subtask`) đi qua cổng `canUseTool` → hỏi duyệt trước khi chạy. Tool ĐỌC (Read/Grep/Glob, đọc Jira) tự cho phép.
- Agent đọc `CLAUDE.md` của repo đích (qua `settingSources: ['project']`), nên quy ước riêng từng dự án được tôn trọng tự động.

---

## MCP — dùng lại kết nối của Claude Code 🔌 (opt-in)

Khi **bật** (`--mcp` ở CLI, hoặc tick **"Kết nối DB/Jira"** trên UI), bow-agent nạp các MCP server đã cấu hình cho Claude Code (`~/.claude.json`) — Supabase, Jira, Codemagic, Figma — nên nó **mạnh ngang Claude Code** ở mảng "kết nối thật":

- **Supabase**: xem DB thật (`list_tables`, `list_migrations`), quét lỗi (`get_advisors`), debug (`get_logs`), sinh types. Tool **đọc** tự chạy; tool **ghi** (`execute_sql`, `apply_migration`, `deploy_edge_function`) phải **duyệt**.
- **Jira**: đọc issue/board/search. **Codemagic**: build (phải duyệt).

> ⚠️ **MẶC ĐỊNH TẮT — vì lý do bảo mật.** Claude Agent SDK truyền cấu hình MCP (kèm token) **qua tham số command-line**, nên khi bật, bất kỳ ai chạy `ps aux` trên máy đều đọc được token trong lúc agent chạy. Vì vậy chỉ bật khi task thật sự cần, để giảm thời gian token lộ.

Token nằm nguyên trong `~/.claude.json` của máy, **bow-agent không hardcode** — chỉ tham chiếu lúc chạy.

---

## Genome — bộ nhớ tiến hóa per-repo 🧬 (opt-in)

Khác với **profile** (ảnh chụp tĩnh, sinh một lần), **genome** là tri thức **động**: sau mỗi task `execute`, agent tự phản tư rút ra "gen" — một điều đã học về chính repo đó — kèm điểm sức khỏe (fitness) tự tăng/giảm theo kết quả. Lần sau, các gen khỏe nhất được nạp vào prompt để agent làm nhanh + ít sai hơn.

```bash
bow-agent run PROJ-123 --execute --genome --cwd ~/GitProject/monorepo/apps/mobile
```

- **MẶC ĐỊNH TẮT.** Với repo nhỏ / task rõ + model mạnh, model tự làm đúng nên genome chỉ là chi phí token thừa. Chỉ đáng bật cho **repo lớn thật** (như monorepo), nơi tri thức cross-cutting *không nằm gọn trong một file* — ví dụ *"thêm service phải cập nhật 3 nơi: `locator.dart` + `base_vm.dart` + VM"*, hay *"dùng AutoRoute nên thêm route phải regen `.gr.dart`"*.
- Genome lưu per-repo ở `memory/genome/<repo>.json` (đã gitignore — dữ liệu runtime, không thuộc repo công cụ).
- Chỉ **thêm tri thức vào prompt**, không cấp quyền mới; plan-then-approve giữ nguyên.

> Thiết kế đầy đủ + bằng chứng A/B: xem **[DESIGN.md](DESIGN.md)**.

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

## Jira REST riêng (tùy chọn, fallback)

Nếu Claude Code CHƯA có MCP jira, điền `.env` để bow-agent tự nối Jira REST:

```
JIRA_BASE_URL=https://your-company.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=...        # https://id.atlassian.com/manage-profile/security/api-tokens
```

Khi cấu hình, agent có 6 tool Jira:
- **Đọc** (tự cho phép): `get_issue`, `get_comments`, `list_board_issues`, `search_issues`.
- **Ghi** (phải duyệt): `add_comment`, `create_subtask`.

---

## Cấu trúc

```
src/
  config/env.ts       # đọc .env (nguồn duy nhất đọc process.env)
  input/task.ts       # chuẩn hóa đầu vào (ticket / WBS file / text)
  tools/jira.ts       # Jira REST client + MCP tools (đọc/ghi)
  profiles/
    index.ts          # registry profile (chọn qua --profile): base → tự-sinh
    base/             # profile CHUẨN của team (committed) — vd app-base-flutter-supabase.md
    detect.ts         # tự nhận diện stack repo (Flutter/Supabase/Node…)
    generate.ts       # agent quét repo lạ → sinh profile (generated-profiles/, gitignore)
  core/
    systemPrompt.ts   # quy trình chung của agent (append vào preset Claude Code)
    runner.ts         # LÕI agent: query() + profile + genome + events callback + approval
    genome.ts         # bộ nhớ tiến hóa: store gen + express/record/select (opt-in)
    reflect.ts        # phản tư sau task → sinh gen mới (mutation)
  cli/index.ts        # entrypoint CLI (dùng lõi runner + terminal y/N)
  web/
    server.ts         # backend Express: /api/run + SSE /api/events + /api/approve
    session.ts        # phiên chạy + hàng đợi sự kiện + cổng duyệt treo Promise
web/                  # frontend React (Vite)
  App.tsx             # chat + toggle plan/execute + thẻ duyệt + model selection + cost tracking
  main.tsx, styles.css, types.ts
examples/
  task.example.md     # WBS mẫu
```

> **CLI và Web dùng chung lõi** `core/runner.ts` — khác nhau chỉ ở cách hiển thị (terminal vs SSE) và cách duyệt (gõ y/N vs bấm nút). Không trùng logic.

---

## Ghi chú

- **Model**: `claude-opus-4-8` (đổi qua `BOW_AGENT_MODEL` trong `.env` hoặc chọn trên Web UI).
- **Node ≥ 18** (dùng `fetch` gốc, ESM).
- Agent **không** tự commit/push/apply-migration trừ khi bạn yêu cầu rõ và duyệt.
