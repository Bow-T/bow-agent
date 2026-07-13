# Bài đăng cho bow-agent

> Giọng: ngắn, thẳng, không hoa mỹ. Kể vấn đề trước, tool sau. Thừa nhận hạn chế
> trước khi người khác chỉ ra — trên HN/Reddit, thành thật ăn điểm hơn hoàn hảo.

---

## ⚠️ CẬP NHẬT: r/ClaudeAI đã chặn bài (13/07/2026)

Bot kiểm duyệt gỡ bài khỏi feed. **Không phải vì nội dung** — bot nói rõ *"Your Showcase
project DOES meet minimum requirements"*. Lý do: **tài khoản chưa đủ karma** để đăng bài
Showcase riêng.

Bài bị gỡ gần như ngay: 0 star, không referrer từ Reddit. Coi như chưa đăng, không mất gì.

**Thứ tự đăng mới:**

1. **Megathread r/ClaudeAI** (mục 0 bên dưới) — tốn 2 phút, nhưng đừng kỳ vọng: comment
   lẫn giữa hàng chục dự án, traffic thấp.
2. **Cộng đồng VN** (mục 2) — không rào cản, cùng múi giờ nên trả lời comment được ngay.
3. **Show HN** (mục 3) — **HN KHÔNG có ngưỡng karma.** Tài khoản mới đăng bình thường.
   Đây giờ là kênh chính, không phải kênh cuối.

Muốn đăng bài riêng lên r/ClaudeAI sau này thì phải nuôi karma trước: comment hữu ích ở
các sub khác vài tuần.

---

## 0. Megathread r/ClaudeAI (bản rút gọn — đăng dạng COMMENT)

Link: https://www.reddit.com/r/ClaudeAI/comments/1sly3jm/built_with_claude_project_showcase_megathread/

Comment nên ngắn hơn bài đăng nhiều — người ta lướt megathread rất nhanh.

---

**bow-agent — share one Claude agent with your team, behind an approval gate**

I use Claude Code daily. The problem wasn't the model — it was everyone else on my team.

My QA engineer keeps asking me "why does checkout crash when the cart is empty?" and I keep
being a human API to my own codebase. She could just ask the agent — but giving her Claude Code
means giving her an agent that edits files and runs shell commands in a repo I'm responsible
for.

So: one agent on my machine, everyone else reaches it through a permission gate.

Reads run free. Every **write** stops — file edits, side-effecting shell, Jira comments, SQL —
shows the diff, and waits for a human. One gate, no bypass.

Six role modes, each on its own port, all runnable at once:

- **QC** — read source, triage Jira. Can't touch code.
- **BA** — write docs, full Jira. Source/DB/deploy hard-denied.
- **Reviewer** — review + approve PRs. Can't edit or merge.
- **Collab** — a contractor writes code, but *every* write (including git) pops an approval card
  **on my screen**, with the diff, and waits.
- **DevOps** — infra files yes, app source no.
- **Dev** — me, everything, still with approval cards.

Built on the Claude Agent SDK, uses your existing Claude CLI login — no API key, no extra bill.

**Limits, up front:** Claude only (SDK-bound). LAN-only sharing, and "auth" is basically
"admin = localhost" — fine for an office, not for the internet. Default knowledge profile
assumes Flutter + Supabase because that's my stack.

MIT. I'd rather have ideas than stars.

GitHub: https://github.com/Bow-T/bow-agent
Landing (with a clickable approval gate): https://bow-t.github.io/bow-agent/

---

## 1. Reddit r/ClaudeAI — bài đăng riêng (BỊ CHẶN KARMA — để dành khi đủ karma)

**Tiêu đề:**
```
I put a permission gate around Claude Agent SDK so my QA and BA can use it too
```

**Nội dung:**

---

I've used Claude Code every day for months. The thing that finally broke wasn't the model — it
was everyone else on my team.

My QA engineer keeps asking me "why does checkout crash when the cart is empty?" So I stop what
I'm doing, go read the code, and answer her. I am a human API to my own codebase.

She could just ask the agent. But giving her Claude Code means giving her an agent that edits
files and runs shell commands in a repo I'm responsible for. She doesn't need that. She needs to
*read* code and triage tickets. Same story for my BA, my tech lead, my contractor — each one
needs a different slice, and the tool only has one setting: full access.

So I built the boring middle thing. One agent on my machine. Everyone else reaches it through a
permission gate.

**How the gate works.** Reads are free — grep, read, list, safe bash. Every *write* stops:
`Edit`, `Write`, a shell command with side effects, a Jira comment, an `execute_sql`. It hits one
function, shows the diff, and waits for a human. One gate, no bypass. If you want to audit this
project's safety model, you read one file.

**Six role modes**, each on its own port, all runnable at once:

| Mode | Can | Can't |
|---|---|---|
| QC | read source, triage + transition Jira | touch code |
| BA | write docs, full Jira | source / DB / deploy |
| Reviewer | review + approve PRs on GitHub | edit, merge, push |
| Collab | write code, run tests | **anything** without my live approval — including git |
| DevOps | Dockerfile, workflows, Terraform, k8s | app source |
| Dev | everything | — (still with approval cards) |

Collab is the one I use most. A contractor's agent wants to write a file — the approval card pops
up **on my screen**, with the diff, and waits. Nothing lands on disk until I click.

Built on the Claude Agent SDK, so it's the same engine as Claude Code underneath. Uses your
existing Claude CLI login (Pro/Max) — no API key, no separate bill. It's not a replacement for
Claude Code; it's a different shape around the same core.

**What it can't do**, up front:

- **Claude only.** It's bound to the Agent SDK. No OpenAI, no local models. If you want that,
  it's the contribution I'd most like help with.
- **LAN only.** "Auth" means admin = whoever is on localhost, and LAN users request access by
  name and wait for approval. Fine for an office. Do not expose this to the internet.
- **Opinionated default profile** (Flutter + Supabase) because that's my stack. Works on any
  repo, but the built-in knowledge won't help you on Rails.
- Parts of the code comments are still Vietnamese. It was an internal tool. Working on it.

MIT. I'd rather have ideas than stars — especially from anyone who solved "let my team use an AI
agent without giving them root" a different way.

https://github.com/Bow-T/bow-agent

---

## 2. Cộng đồng Việt Nam

Group FB "Vietnam Web Developers", "Cộng đồng Lập trình viên Việt Nam", Discord/Slack dev VN.

**Tiêu đề:**
```
Mình làm cái cổng duyệt cho AI agent, để QC/BA/CTV xài chung mà không sợ phá repo
```

**Nội dung:**

---

Team mình: 2 dev, 1 QC, 1 BA, thỉnh thoảng thuê CTV. Xài Claude Code mấy tháng nay, mình làm
nhanh hẳn. Nhưng mấy bạn còn lại thì không đụng vào được.

Lý do đơn giản: đưa Claude Code cho QC là đưa một con agent **sửa file + chạy lệnh** được vào
repo mình chịu trách nhiệm. QC đâu cần sửa code — bạn ấy cần đọc code và chấm ticket. BA thì viết
tài liệu. CTV thì code thật, nhưng mình không dám cho ghi thẳng.

Cuối cùng mình cứ làm cái human API: QC hỏi "sao checkout crash khi giỏ rỗng?", mình bỏ việc đang
làm, đi đọc code, trả lời. Ngày mấy lần.

Nên mình làm bow-agent: **một agent chạy trên máy mình, cả team xài chung qua LAN, mọi thao tác
GHI đều phải mình duyệt.**

Đọc thì cho chạy tự do (grep, read, chạy test). Còn **ghi** — sửa file, chạy lệnh có side-effect,
comment Jira, chạy SQL — dừng hết, hiện thẻ duyệt kèm diff, chờ người bấm. Đúng một cổng duyệt,
không có đường vòng.

6 mode, mỗi mode một cổng, chạy song song được:

- **QC** — đọc source, chấm + chuyển trạng thái Jira. Không sửa được code.
- **BA** — ghi tài liệu (`docs/`, `*.md`) + full Jira. Chặn cứng source/DB/deploy.
- **Reviewer** — review PR, comment/approve trên GitHub. Không sửa/merge/push.
- **Collab** — CTV code như dev, nhưng **mọi thao tác ghi (kể cả git) hiện thẻ duyệt trên máy
  mình**, kèm diff, chờ mình bấm.
- **DevOps** — ghi file hạ tầng (Dockerfile, workflow, Terraform). Không đụng source app.
- **Dev** — mình, full quyền, vẫn có thẻ duyệt.

Xài login Claude CLI sẵn có (Pro/Max) nên không cần API key, không phát sinh bill riêng. Dựng
trên Claude Agent SDK — cùng engine với Claude Code.

**Nói trước cái chưa được:** chỉ chạy với Claude; share chỉ trong LAN (admin = localhost, user
LAN xin duyệt theo tên) — đủ cho team ngồi cùng văn phòng, **đừng** mở ra internet. Profile mặc
định thiên về Flutter + Supabase vì đó là stack mình làm.

Open source MIT. Mình cần **ý tưởng** hơn là star — ai từng gặp bài toán "cho team xài AI agent
mà không dám giao quyền ghi" thì rất muốn nghe cách mọi người xử.

https://github.com/Bow-T/bow-agent

---

## 3. Show HN — ĐĂNG SAU CÙNG

**Tiêu đề** (≤80 ký tự, không giật gân, không viết hoa):
```
Show HN: Bow-agent – share one AI coding agent with your team, behind an approval gate
```

**Cách đăng:** https://news.ycombinator.com/submit
- **URL**: `https://github.com/Bow-T/bow-agent`
- **Text**: để trống. Comment đầu tiên của bạn mới là bài viết.

**Comment đầu tiên — đăng ngay sau khi submit:**

---

I build apps with a small team: a couple of devs, a QA engineer, a BA, a tech lead, sometimes a
contractor. When Claude Code got good enough that I stopped reading every diff, I hit a problem I
didn't expect.

I wanted the rest of the team to use it. But "use it" means handing them an agent that edits
files and runs shell commands in our repo. My QA engineer doesn't need to write code — she needs
to read it and triage tickets. My BA writes specs. The contractor writes real code, but I'm not
giving him unreviewed write access to a repo I'm responsible for.

Every option was bad. Give everyone their own agent and I have no idea what's landing in the
repo. Give nobody access and I'm the bottleneck for every question about the codebase.

So I built the boring middle thing: one agent on my machine, and everyone else reaches it through
a permission gate.

Reads are free — grep, read, list, safe shell. Every *write* stops: `Edit`, `Write`, a shell
command with side effects, a Jira comment, an `execute_sql`. Each one hits a single function,
shows the diff, and waits for a human. There is exactly one gate and nothing routes around it. If
you want to audit the safety model of this project, you read one file.

On top of that, six role modes, each on its own port, all runnable at once:

- **QC** — read-only source, can triage and transition Jira tickets
- **BA** — writes docs and `*.md`, hard-denied from source, DB, deploy
- **Reviewer** — reviews PRs and approves on GitHub, can't edit code or merge
- **Collab** — a contractor writes code, but *every* write, including git, pops an approval card
  **on my screen**, with the diff, and waits
- **DevOps** — infra files yes, app source no
- **Dev** — me, everything, still with approval cards

The demo GIF in the README is the whole pitch: the agent finds the bug, writes the patch, then
stops. It cannot touch the file until someone clicks.

**Limitations, because these are the first things I'd ask:**

- **Claude only.** It's built on the Claude Agent SDK and uses your existing Claude CLI login (no
  API key, no separate bill). OpenAI or a local model doesn't exist yet — and it's the
  contribution I'd most like help with.
- **LAN-only sharing.** "Auth" means the admin is whoever is on localhost; LAN users request
  access by name and wait to be approved. Fine for a team in one office. It is not real auth and
  I wouldn't expose it to the internet.
- **The default knowledge profile assumes Flutter + Supabase**, because that's what I build. It
  runs on any repo, but the built-in profile won't help you on Rails. (Adding one is a single
  markdown file — that's the easiest way to contribute.)
- I'm a dev in Vietnam and this started as an internal tool, so parts of the code comments are
  still in Vietnamese. Working on it.

MIT. I'd rather have ideas than stars — especially from anyone who solved "let my team use an AI
agent without giving them root" a different way.

https://github.com/Bow-T/bow-agent

---

### Lưu ý khi đăng HN

- **Giờ tốt:** 8–10h sáng giờ Mỹ (≈ 20–22h giờ VN), thứ Ba–Năm.
- **KHÔNG** nhờ bạn bè upvote. HN phát hiện được và sẽ chôn bài, kèm cả tài khoản.
- Ngồi canh 2–3 tiếng đầu trả lời comment. Trả lời thẳng, thừa nhận cái chưa làm được.
- Gặp comment "sao không dùng X?" → nói thật X làm gì, mình khác gì. Đừng phòng thủ.

---

## 4. Reddit r/selfhosted

**⚠️ ĐỌC RULE TRƯỚC KHI ĐĂNG.** r/selfhosted có luật riêng về self-promotion (thường yêu cầu
**flair `Release`/`Product Announcement`**, một số bài bị gỡ nếu tài khoản mới hoặc thiếu karma).
Mở sidebar sub, đọc rule + wiki, chọn đúng flair. Nhớ vụ r/ClaudeAI vừa gỡ bài vì karma —
đừng để lặp lại.

**Nguyên tắc sống còn với sub này:** họ ghét SaaS trá hình. Bài này **phải** nói thẳng ngay từ đầu
là model vẫn là Claude cloud. Giấu = bị bới ra ở comment đầu tiên = chôn bài.

**Tiêu đề:**
```
Self-hosted AI coding agent for a small team — every write stops at an approval gate on my machine
```

**Nội dung:**

---

**Up front, so nobody wastes time:** the agent, the permission gate, the web UI, and your code all
run on your own box. Nothing goes through a server of mine. **But the model is Claude — it calls
Anthropic's API.** This is not a local-LLM setup. If that's a dealbreaker, stop reading; I'd
rather say it in line 1 than have you find it in the comments.

Now the actual problem.

I run a small team: a couple of devs, a QA engineer, a BA, sometimes a contractor. I use Claude
Code every day and it's genuinely good. Nobody else on the team can touch it.

Not because of a license — because handing someone Claude Code means handing them an agent that
edits files and runs shell commands in a repo I'm responsible for. My QA engineer doesn't need
that. She needs to *read* code and triage tickets. So instead she asks me "why does checkout crash
when the cart is empty?", I drop what I'm doing, go read the code, and answer her. I am a human
API to my own codebase, several times a day.

Every off-the-shelf option was some flavor of SaaS: upload your repo to their cloud, get a seat
per user, trust them with your source. Not doing that.

So I built **bow-agent**: one agent process on my machine, the rest of the team reaches it over
LAN, and every write goes through one approval gate.

**What's actually self-hosted here:**

- The agent runs as a Node process on your machine. `git clone`, `npm install`, `npm run ui`.
- Your **code never leaves your machine** except as the context Claude Code would already send
  to Anthropic. There is no bow-agent server, no telemetry, no account, no signup.
- Your team hits it on your LAN IP. Approval cards pop on *your* screen.
- Your Jira / Supabase / GitHub creds stay in your own MCP config, on your own disk.
- MIT. Fork it and it keeps working — nothing phones home to me to stay alive.

**The gate.** Reads run free — grep, read, list, safe shell. Every *write* stops: a file edit, a
shell command with side effects, a Jira comment, an `execute_sql`. It hits one function, shows the
diff, and waits for a human click. One gate, no bypass. If you want to audit the safety model, you
read one file (`canUseTool` in `src/core/runner.ts`).

Yes, I closed the obvious hole first: denying `Edit`/`Write` is theater if `Bash` can still run
`sed -i`, `patch`, or `git apply`. Those route through the gate too.

**Six role modes**, each on its own port, all runnable at once:

- **QC** — read source, triage + transition Jira. Literally has no write tool.
- **BA** — writes `docs/` and `*.md`. Source, DB, deploy: hard-denied.
- **Reviewer** — reviews and approves PRs. Can't edit, merge, or push.
- **Collab** — a contractor writes real code, but *every* write, **including git**, pops an
  approval card on my machine with the diff and waits.
- **DevOps** — Dockerfile, compose, workflows, Terraform, k8s. App source: denied. Deploy/apply
  gets routed to me.
- **Dev** — me, everything, still with approval cards.

**Limitations, plainly:**

- **Claude only, and that means the Anthropic cloud.** It's built on the Claude Agent SDK, so it's
  bound to it. It uses your existing Claude CLI login (Pro/Max) — no API key, no separate bill,
  no middleman — but the inference is not on your hardware. **Local model support (ollama /
  llama.cpp) is the contribution I'd most like help with**, and I know exactly which crowd to ask.
- **LAN-only, and "auth" is not real auth.** Admin = whoever is on localhost (checked by real
  socket IP, not a spoofable `X-Forwarded-For`); LAN users request access by name and wait for
  approval. Fine behind your own firewall. **Do not expose this to the internet.** Proper auth is
  on the wanted list.
- **No Docker image yet.** It's a Node ≥18 process; runs fine in a container if you build one, but
  I haven't shipped an official image. If that's what's blocking you, say so and I'll prioritize it.
- **Default knowledge profile assumes Flutter + Supabase** because that's my stack. It runs against
  any repo (it reads that repo's `CLAUDE.md` and detects the stack), but the built-in profile won't
  help you on Rails. Adding one is a single markdown file.

MIT. I'd rather have ideas than stars — especially from anyone who has solved "let my team use an
AI agent without giving them root."

Code: https://github.com/Bow-T/bow-agent
Landing page (has a clickable demo of the approval gate): https://bow-t.github.io/bow-agent/

---

### Lưu ý khi đăng r/selfhosted

- **Comment đầu tiên gần như chắc chắn là:** *"this isn't self-hosted, it calls Anthropic"*. Bài
  đã nói trước ở dòng 1 — nên trả lời bình tĩnh: *"đúng, agent + gate + dữ liệu là self-hosted,
  inference thì không. Tôi ghi rõ ngay đầu bài. Local model là thứ tôi muốn có người giúp nhất."*
  **Đừng phòng thủ, đừng cãi.**
- Câu hỏi thứ hai chắc chắn là **Docker image / compose file**. Trả lời thật: chưa có. Hỏi ngược
  họ cần compose kiểu gì — đó là research miễn phí.
- Đừng dùng chữ "free tier", "sign up", "cloud" trong bài. Sub này dị ứng.

---

## 5. Reddit r/devtools

**⚠️ ĐỌC RULE TRƯỚC KHI ĐĂNG.** r/devtools nhỏ và ít khắt khe hơn r/selfhosted, nhưng vẫn kiểm tra
sidebar: có sub yêu cầu flair, có sub cấm link ở phần thân bài nếu tài khoản mới. Nếu bài bị auto-
remove, nhắn modmail — thường được duyệt lại.

**Góc tiếp cận của bài này:** không bán tool. Kể **bài toán thiết kế** (phân quyền khi cả team dùng
chung một agent) và cách mình giải. Sub này quan tâm kiến trúc + DX hơn là feature list.

**Tiêu đề:**
```
The permission problem nobody solves: what happens when your whole team shares one AI agent
```

**Nội dung:**

---

Every AI coding tool I've used is designed for exactly one user at exactly one trust level: you,
with full access. That assumption quietly breaks the moment a second person on your team wants in.

Concretely: my QA engineer asks me "why does checkout crash when the cart is empty?" I stop what
I'm doing, read the code, answer her. Several times a day. I'm a human API to my own codebase, and
the agent sitting right there could answer her in ten seconds.

She can't use it, though. Giving her Claude Code means giving her an agent that edits files and
runs shell commands in a repo I'm responsible for. She doesn't want that; she wants to *read* code
and triage tickets. Same for my BA (writes specs), my tech lead (reviews PRs), my contractor
(writes real code, but I'm not giving him unreviewed write access).

Four people, four different slices of permission. The tool has one setting: root.

**The design constraint I set myself:** exactly one place in the code decides what is allowed, and
nothing routes around it. If a security model has two entry points, it has zero.

**What I built.** One agent process on my machine. Everyone else reaches it over LAN. The whole
thing turns on a single function — the Agent SDK's `canUseTool` hook:

- **Reads pass through.** grep, read, list, `git status`, running tests. No prompt, no friction.
  This matters for DX: a gate that interrupts you 40 times an hour is a gate you turn off.
- **Every write stops.** File edit, shell command with side effects, Jira comment, `execute_sql`.
  It shows the diff and waits for a human click.
- **On top of the same gate: role policies.** A QC agent isn't *told* not to edit code — the edit
  tools aren't in its toolset. A BA agent is hard-denied on source paths and can only write
  `docs/` and `*.md`. Capability, not instruction.

Auditing the whole safety model means reading one file. That was the point.

**Two design details that cost me the most time**, and are the reason I'm posting here rather than
just linking a repo:

1. **Deny-listing `Edit`/`Write` is theater.** An agent with `Bash` and a denied `Edit` tool will
   cheerfully reach for `sed -i`, `patch`, or `git apply`. Any in-place file mutation has to route
   through the *same* gate, or the gate is decorative. Same for MCP writes — an `execute_sql` that
   says `DROP TABLE` must not be auto-approvable, even for admin.
2. **"Admin = localhost" must mean the real socket IP.** My first version trusted
   `X-Forwarded-For`, which a LAN client sets to whatever it likes. That's a one-line privilege
   escalation. It now reads `req.socket.remoteAddress`; the header is display-only.

Both were bugs in my own code before they were features. Posting them because they're the parts
someone else building this would step on.

**Six role modes**, each on its own port, all runnable simultaneously: QC (read + Jira triage), BA
(docs + Jira, source hard-denied), Reviewer (review + approve PRs, can't merge or push), Collab
(contractor writes code, but *every* write including git pops an approval card on my screen and
waits), DevOps (infra files yes, app source no, deploy routed to admin), Dev (me, everything, still
gated).

Collab is the one I actually use. The contractor's agent writes a file, the card appears on *my*
machine with the diff, nothing lands on disk until I click.

**The obvious objection — "just use PRs":** for the contractor, fair, and I don't replace PRs. But
a PR gates the *end state on a branch*. It doesn't see the shell commands the agent ran, the
migration it applied, or the Jira comment it posted. And PRs do nothing for QC or BA — they don't
open PRs; they need the agent constrained from the start, not reviewed after.

**Limits, before anyone has to ask:**

- **Claude only.** Built on the Claude Agent SDK, so it's bound to it. The gate itself isn't
  model-specific — it could wrap another engine — but I built on what I use daily. This is the
  contribution I'd most like help with.
- **LAN-only, and it is not real auth.** Admin = localhost; LAN users request access by name.
  Fine for one office. Don't put it on the internet.
- **Default knowledge profile is Flutter + Supabase**, because that's my stack. Runs on any repo,
  but the built-in profile won't help you on Rails. Adding one is a single markdown file.

MIT, free, uses your existing Claude CLI login (no API key, no server of mine in the middle).

Mostly I want to hear how other people solved this — if you've dealt with "let the team use an
agent without handing them root," I'd take that over a star.

https://github.com/Bow-T/bow-agent
Landing page with a clickable approval gate: https://bow-t.github.io/bow-agent/

---

### Lưu ý khi đăng r/devtools

- Câu hỏi khó nhất sẽ là **"sao không dùng git branch + PR?"** — đáp án đã soạn trong
  `faq.md`, nhóm 1. Đọc lại trước khi đăng.
- Sub này thích **kiến trúc**, không thích **feature list**. Ai hỏi sâu về `canUseTool` thì trả lời
  kỹ, dẫn thẳng vào `src/core/runner.ts`. Đó là loại comment kéo bài lên.
- Có thể bị so sánh với Cursor/Aider/Continue → đáp án ở `faq.md`. Nói thẳng: chúng giải bài toán
  *"tôi code nhanh hơn"*, cái này giải *"QC của tôi dùng được agent"*.

---

## 📋 Nhắc chung trước khi đăng BẤT KỲ sub nào

1. **Đọc rule của sub.** Mỗi sub một luật. r/ClaudeAI vừa gỡ bài vì tài khoản thiếu karma —
   nội dung không hề sai. Kiểm tra: có cấm self-promotion không? Có yêu cầu ngưỡng karma /
   tuổi tài khoản không? Có bắt buộc flair không? Có ngày riêng cho bài show-off không?
2. **Mỗi sub một bài riêng.** Đừng copy-paste chung một bài. Cách nhanh nhất để ăn downvote và bị
   mod xoá.
3. **Đăng cách nhau vài ngày**, không đăng cùng lúc nhiều sub — Reddit coi đó là spam.
4. **Ngồi canh 2–3 giờ đầu** trả lời comment. Sau đó bài chìm.
5. **Không nhờ bạn bè upvote.** Reddit phát hiện được, chôn cả bài lẫn tài khoản.

---

## ⚠️ ĐỪNG đăng r/LocalLLaMA

Đó là cộng đồng chạy model **local / tự host**. bow-agent bắt buộc dùng **Claude cloud trả phí**.
Đăng vào đó gần như chắc chắn ăn downvote kiểu "this isn't local at all".

Để dành. Khi nào hỗ trợ được model local (ollama/llama.cpp) thì bài sẽ rất hợp.

Thay thế nếu muốn thêm kênh: **r/programming**, **r/ExperiencedDevs** — nhưng viết theo hướng
*bài toán phân quyền*, không phải giới thiệu tool.
