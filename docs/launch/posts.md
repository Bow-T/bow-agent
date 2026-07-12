# Bài đăng cho bow-agent

> Nguyên tắc: kể **vấn đề**, không bán sản phẩm. Thừa nhận giới hạn trước khi người
> khác chỉ ra. Trả lời comment trong 2 giờ đầu — đó là lúc quyết định bài sống hay chết.

---

## 1. Show HN (tiếng Anh) — quan trọng nhất

**Tiêu đề** (HN giới hạn 80 ký tự, không dùng chữ hoa giật gân):

```
Show HN: Bow-agent – share one AI coding agent with your team, behind an approval gate
```

**Cách đăng:** https://news.ycombinator.com/submit
- **URL**: `https://github.com/Bow-T/bow-agent`
- **Text**: để trống (HN không cho vừa URL vừa text — comment đầu tiên của bạn đóng vai trò đó)

**Comment đầu tiên** — đăng NGAY sau khi submit, đây mới là bài viết thật:

---

I build apps with a small team: a couple of devs, a QA engineer, a BA, a tech lead, and
sometimes a contractor. When Claude Code got good enough that I stopped reading every diff,
I hit a problem I didn't expect.

I wanted the rest of the team to use it too. But "use it" meant handing them an agent that
can edit files and run shell commands in our repo. Our QA engineer doesn't need to write
code — she needs to read it and triage Jira tickets. Our BA writes specs, not source. The
contractor writes real code, but I'm not giving him unreviewed write access to a repo I'm
responsible for.

Every option was bad. Give everyone their own Claude Code, and I have no idea what's landing
in the repo. Give nobody access, and I'm the bottleneck for every question anyone has about
the codebase.

So I built the boring middle thing: one agent, running on my machine, and everyone else
reaches it through a permission gate.

The core idea is that reads are free and every *write* stops. Grep, read, list, safe shell
commands — those just run. But `Edit`, `Write`, a shell command with side effects, a Jira
comment, an `execute_sql` — every one of those hits a single function (`canUseTool`) and
waits for a human. There's exactly one gate and nothing routes around it; if you want to
audit the safety model of this project, you read one file.

On top of that there are role modes, each on its own port, all runnable at once:

- **QC** — read-only source, but can triage and transition Jira tickets
- **BA** — can write docs and `*.md`, hard-denied from source, DB, deploy
- **Reviewer** — can review PRs and approve on GitHub, can't edit code or merge
- **Collab** — a contractor can write code, but *every* write, including git, pops an
  approval card **on my screen**, with the diff, and waits
- **DevOps** — infra files yes, app source no
- **Dev** — me, everything, still with approval cards

The demo GIF in the README is the whole pitch: the agent finds a bug, writes the patch,
and then stops. It cannot touch the file until someone clicks.

**Honest limitations**, because these are the first things I'd ask:

- **It only works with Claude.** It's built on the Claude Agent SDK and uses your existing
  Claude CLI login (no API key, no separate bill). If you want OpenAI or a local model, that
  doesn't exist yet — and it's the contribution I'd most like help with.
- **Sharing is LAN-only.** "Auth" means the admin is whoever is on localhost, and LAN users
  request access by name and wait to be approved. That's fine for a team in one office. It is
  not real auth, and I wouldn't expose it to the internet.
- **It's opinionated about my stack** (Flutter + Supabase) in the default knowledge profile,
  because that's what I build. It works on any repo, but the built-in profile won't help you
  if you're on Rails.
- I'm a dev in Vietnam and this started as an internal tool, so parts of the docs and code
  comments are still in Vietnamese. Working on it.

MIT. I'd genuinely like ideas more than stars — especially from anyone who's solved the
"let my team use an AI agent without giving them root" problem a different way.

https://github.com/Bow-T/bow-agent

---

### Lưu ý khi đăng HN

- **Giờ đăng tốt**: 8-10h sáng giờ Mỹ (tức ~20-22h giờ VN), thứ Ba–Thứ Năm.
- **KHÔNG** nhờ bạn bè upvote — HN phát hiện và chôn bài (kèm cả tài khoản).
- Ngồi canh 2-3 tiếng đầu để trả lời comment. Trả lời thẳng, thừa nhận cái chưa làm được.
  Người HN quý sự thành thật hơn sản phẩm hoàn hảo.
- Comment kiểu "sao không dùng X?" → trả lời thật (X làm gì, mình khác gì), đừng phòng thủ.

---

## 2. Reddit r/ClaudeAI (tiếng Anh)

**Tiêu đề:**

```
I built a permission gate around Claude Agent SDK so my QA, BA and contractors can share one agent
```

**Nội dung:**

---

I've been using Claude Code daily for months. The problem I ran into wasn't the model — it
was everyone else on my team.

Our QA engineer keeps asking me "why does checkout crash when the cart is empty?" and I keep
being the human API to the codebase. She could just ask the agent. But giving her Claude Code
means giving her an agent that can edit files and run shell commands in a repo I'm responsible
for. Same for our BA, our tech lead, our contractor.

So I built bow-agent: one agent core on my machine, and everyone else works through a
permission gate over LAN.

**How the gate works:** reads run free (grep, read, list, safe bash). Every write — file
edits, side-effecting commands, Jira writes, SQL — routes through a single function and waits
for a human to approve, with the diff shown. One gate, no bypass.

**Role modes** (each on its own port, run them all at once):

| Mode | Can | Can't |
|---|---|---|
| QC | read source, triage + transition Jira | touch code |
| BA | write docs, full Jira | source / DB / deploy |
| Reviewer | review + approve PRs on GitHub | edit, merge, push |
| Collab | write code, run tests | **anything** without my live approval — including git |
| DevOps | Dockerfile, workflows, Terraform, k8s | app source |

The Collab one is my favorite: a contractor's agent wants to write a file, and the approval
card pops up **on my screen** with the diff. Nothing lands until I click.

It uses your existing Claude CLI login (Pro/Max), so no API key and no extra bill. Built on
the Claude Agent SDK, so it's the same engine as Claude Code underneath — it's not a
replacement, it's a different shape around the same core.

**Limitations, up front:** Claude-only (SDK-bound). LAN-only sharing, and the "auth" is
basically "admin is localhost" + name-based approval — fine for an office, not for the open
internet. Default knowledge profile assumes Flutter + Supabase because that's my stack.

MIT, and I'd love ideas as much as code — especially more role modes (a designer mode? a
security-reviewer mode?) and profiles for other stacks.

https://github.com/Bow-T/bow-agent

---

## 3. Reddit r/LocalLLaMA — CÂN NHẮC KỸ

⚠️ **Khuyến nghị: ĐỪNG đăng ở đây, ít nhất là chưa.**

r/LocalLLaMA là cộng đồng chạy model **local/tự host**. Bow-agent hiện **bắt buộc dùng Claude
(cloud, trả phí)**. Đăng vào đó rất dễ ăn downvote kiểu "this isn't local at all". Chỉ đăng
khi nào đã hỗ trợ được model local (ollama/llama.cpp) — lúc đó bài sẽ rất hợp.

Thay thế: **r/programming**, **r/devtools**, **r/ExperiencedDevs** (bài về *vấn đề quản trị
quyền*, không phải về tool).

---

## 4. Cộng đồng Việt Nam (tiếng Việt)

Group FB "Vietnam Web Developers", "Cộng đồng Lập trình viên Việt Nam", Discord/Slack dev VN.

**Nội dung:**

---

Team mình có 2 dev, 1 QC, 1 BA, thỉnh thoảng thuê CTV. Từ hồi xài Claude Code thì mình
làm nhanh hẳn — nhưng mấy bạn còn lại thì không đụng vào được.

Lý do: đưa Claude Code cho QC nghĩa là đưa một con agent **sửa file + chạy lệnh** được vào
repo mình chịu trách nhiệm. QC đâu cần sửa code, bạn ấy cần **đọc** code và chấm ticket Jira.
BA thì viết tài liệu. CTV thì có code thật, nhưng mình không dám cho ghi thẳng vào repo.

Nên mình làm bow-agent: **một agent chạy trên máy mình, cả team xài chung qua LAN, nhưng mọi
thao tác GHI đều phải mình duyệt.**

Cách hoạt động: đọc thì cho chạy tự do (grep, read, chạy test). Còn **ghi** — sửa file, chạy
lệnh có side-effect, comment Jira, chạy SQL — đều dừng lại, hiện thẻ duyệt kèm diff, chờ người
bấm. Chỉ có đúng một cổng duyệt, không có đường vòng.

Có 6 mode, mỗi mode một cổng, chạy song song được:

- **QC** — đọc source, chấm + chuyển trạng thái ticket Jira, không sửa được code
- **BA** — ghi tài liệu (`docs/`, `*.md`) + full Jira, chặn cứng source/DB/deploy
- **Reviewer** — review PR, comment/approve trên GitHub, không sửa/merge/push được
- **Collab** — CTV code như dev, nhưng **mọi thao tác ghi (kể cả git) hiện thẻ duyệt trên máy
  mình**, kèm diff, chờ mình bấm
- **DevOps** — ghi file hạ tầng (Dockerfile, workflow, Terraform), không đụng source app
- **Dev** — mình, full quyền, vẫn có thẻ duyệt

Xài login Claude CLI sẵn có (gói Pro/Max) nên không cần API key, không phát sinh bill riêng.
Dựng trên Claude Agent SDK — cùng engine với Claude Code.

**Hạn chế nói trước:** chỉ chạy với Claude; share chỉ trong LAN (admin = localhost, user LAN
xin duyệt theo tên) — đủ cho team ngồi cùng văn phòng, **không** nên mở ra internet.

Open source MIT. Mình cần **ý tưởng** hơn là star — nhất là ai từng gặp bài toán "cho team
xài AI agent mà không dám giao quyền ghi" thì rất muốn nghe cách mọi người xử lý.

https://github.com/Bow-T/bow-agent

---

## Thứ tự đăng đề xuất

1. **r/ClaudeAI trước** (cộng đồng thân thiện nhất, đúng đối tượng) — dùng để test phản ứng,
   xem người ta hỏi gì, vá README theo feedback.
2. **Cộng đồng VN** — dễ có người thử thật vì cùng múi giờ, nhắn được trực tiếp.
3. **Show HN sau cùng**, khi README đã được mài theo feedback 2 vòng trên. HN chỉ có một cơ hội.
