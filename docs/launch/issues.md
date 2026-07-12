# Issue soạn sẵn — copy-paste lên GitHub

> **Vì sao cần:** README mời người ta xem *"issues labeled `good first issue`"*, nhưng repo
> đang có **0 issue**. Người muốn đóng góp bấm vào → trang trống → đóng tab. Mở sẵn vài issue
> thật là cách rẻ nhất để biến người ghé qua thành người đóng góp.
>
> **Cách dùng:** vào https://github.com/Bow-T/bow-agent/issues/new → chọn *"Open a blank issue"*
> → copy tiêu đề + nội dung bên dưới → gắn nhãn như ghi ở đầu mỗi issue.

---

## Issue 1 — Dịch comment & docs sang tiếng Anh

**Nhãn:** `good first issue` · `documentation` · `help wanted`

**Tiêu đề:**
```
Translate Vietnamese comments and docs to English
```

**Nội dung:**

This project started as an internal tool in Vietnam, so a lot of the code comments and docs
are still in Vietnamese. That's a real barrier for anyone outside Vietnam who wants to
understand or contribute to it.

**This is a great first contribution** — it needs no deep knowledge of the codebase, and you
learn your way around while doing it.

The Vietnamese content, roughly by size:

| File | ~Lines with Vietnamese |
|---|---|
| `web/App.tsx` | 827 |
| `src/core/runner.ts` | 460 |
| `src/web/server.ts` | 382 |
| `web/NeuralBrain.tsx` | 142 |
| `src/skills/externalSkills.ts` | 129 |
| `src/web/session.ts` | 84 |
| `src/tools/mcp.ts` | 78 |
| …and ~25 more files | |
| `ARCHITECTURE.md` | 426 (whole file) |

**Please don't try to do all of it in one PR.** Pick *one file*, translate it, open a PR, and
say which file you took in a comment here so nobody duplicates your work.

Good ones to start with (small, self-contained):
- `src/tools/mcp.ts`
- `src/web/session.ts`
- `src/input/task.ts`
- `src/core/subagents.ts`

Guidelines:
- Translate **comments and doc strings only** — don't rename variables or change logic.
- Keep the meaning, not the word order. These comments explain *why*, and that's what matters.
- `README.vi.md` stays Vietnamese on purpose — it's the Vietnamese README. Don't touch it.
- Run `npm run typecheck` before you open the PR.

---

## Issue 2 — Web UI is hardcoded in Vietnamese (needs i18n)

**Nhãn:** `help wanted` · `enhancement` *(KHÔNG phải good first issue — việc này to hơn)*

**Tiêu đề:**
```
Web UI strings are hardcoded in Vietnamese — add i18n
```

**Nội dung:**

Every user-facing string in the web UI is hardcoded in Vietnamese: `"Chọn thư mục này"`,
`"Cấu trúc dự án"`, `"Cuộc trò chuyện mới"`, and so on. There is **no i18n layer at all** —
no locale files, no translation function.

The result: someone who doesn't read Vietnamese can install bow-agent, but can't really use
the web UI.

(Note: the "Tiếng Việt" dropdown in the header is *not* a UI language switch — it sets the
language the **agent replies in** (`web/App.tsx:324`). Different thing.)

**What's needed:**

1. A minimal i18n layer — no heavy dependency needed, a simple `t('key')` over a locale map
   is enough for a project this size.
2. Extract the hardcoded strings out of `web/App.tsx` (the bulk of them) and the other
   components into `en.json` / `vi.json`.
3. A UI language switch in the header, defaulting to the browser locale.
4. `en` should be the default for anyone whose locale isn't Vietnamese.

This is a bigger piece of work and touches a lot of `App.tsx`, so **please comment here before
starting** so we can agree on the approach (and so two people don't do it twice).

Happy to discuss the approach in [Discussions](https://github.com/Bow-T/bow-agent/discussions)
first if you'd rather.

---

## Issue 3 — Viết base profile cho stack khác (Rails / Django / Next.js / Go)

**Nhãn:** `good first issue` · `enhancement` · `help wanted`

> 💡 **Đây là issue "good first issue" TỐT NHẤT của repo.** Đã rà code: chỉ cần **thả một file
> `.md`** — không sửa `index.ts`, không đụng registry, không cần tạo repo skill.

**Tiêu đề:**
```
Add a base profile for your stack (Rails, Django, Next.js, Go, …)
```

**Nội dung:**

bow-agent ships with exactly one "base profile" — a document that teaches the agent your
stack's conventions before it touches its first task. Right now that profile assumes
**Flutter + Supabase**, because that's what I build.

If you work in Rails, Django, Next.js, Go, Laravel, Spring — a profile for your stack would
make bow-agent immediately useful to people like you, and it's the easiest way to contribute
here.

**What a profile is:** a single markdown file that gets injected into the agent's system
prompt. No code. It tells the agent things like *"queries go in `services/`, never in the
view"*, *"never hand-edit `schema.rb` — use a migration"*, *"run `bundle exec rubocop` before
you call it done"*.

### How to do it

1. **Copy the existing one as a template:**
   [`src/profiles/base/app-base-flutter-supabase.md`](../../src/profiles/base/app-base-flutter-supabase.md)
   (100 lines — read it first, it's short)

2. **Create `src/profiles/base/app-base-<your-stack>.md`** — e.g. `app-base-rails.md`.
   The filename *is* the profile name. That's the whole registration step.

3. **Test it:**
   ```bash
   npm run dev -- run --text "add a health check endpoint" \
     --profile app-base-rails --cwd ~/your-rails-repo
   ```
   (If the name is wrong, the CLI prints the list of valid ones.)

4. Open the PR. Add a row to the profile table in `README.vi.md`.

### What to put in it

Follow the same shape as the Flutter one:

- **A disclaimer up top** — the most important part: *"if the repo contradicts this profile,
  trust the repo."* A profile is a strong hint, not law.
- **Directory structure** — where things live and why.
- **The framework's mandatory patterns** — DI, state, routing, whatever your stack enforces.
- **Code generation & migrations** — what must *never* be hand-edited, and the exact command
  to regenerate it.
- **Security** — where secrets live, what must stay server-side.
- **Definition of Done** — the exact lint/test/build commands to run before claiming success.
- **A "common traps" checklist** at the bottom.

Keep it under ~400 lines. Be concrete. Name real commands. The value is in the *"don't do X,
it breaks Y"* knowledge that isn't in the framework docs.

### Stretch goal (optional)

Auto-detection: [`src/profiles/detect.ts`](../../src/profiles/detect.ts) sniffs the repo to
guess the stack, but it currently only knows Flutter and Node. Adding a branch (e.g.
`Gemfile` + `config/routes.rb` → Rails) would let bow-agent suggest your profile automatically.
Only do this if you want to — the profile alone is a complete contribution.

---

## Issue 4 — Thêm role mode mới (Designer / PM / Security-reviewer)

**Nhãn:** `help wanted` · `enhancement`
**⚠️ KHÔNG gắn `good first issue`** — việc này đụng cổng an toàn, ~45 chỗ / 9 file.

**Tiêu đề:**
```
Proposal: new role modes (Designer? PM? Security reviewer?)
```

**Nội dung:**

bow-agent has six role modes today — Dev, QC, Collab, BA, Reviewer, DevOps. Each one is a
permission policy: what that person's agent may read, may write, and may never touch.

**The interesting part of this is not the code — it's deciding what a role should never be able
to do.** So this issue is as much a design discussion as an implementation task.

Roles I've thought about but haven't built:

- **Designer** — can edit CSS/styles/assets and see the UI, but can't touch business logic?
- **PM** — read code, full Jira, write specs, but zero write access to the repo?
- **Security reviewer** — read *everything* including configs, run scanners, comment on PRs,
  but never write?
- **Something I haven't thought of.** Tell me what your team actually needs.

**If you just want to propose a role — comment here or open a
[Discussion](https://github.com/Bow-T/bow-agent/discussions). No code needed. That's a real
contribution.**

### If you want to implement one

⚠️ **Read this before you start.** A role mode touches the safety gate, so it is *not* a
beginner task. The gate is the entire value of this project — a PR that opens a hole in it
will be declined no matter how good the rest is.

The last mode added (DevOps, commit `f44241a`) is your template. It touched **9 files**:

| Where | What |
|---|---|
| `src/core/runner.ts` | The policy itself — a `if (isXMode) { … }` block inside `canUseTool` |
| `src/web/server.ts` | Read `BOW_X_MODE` / `BOW_X_CWD`, wire it to the runner, force the run mode, `/api/config` |
| `package.json` | `ui:x:share` script + a port pair + add ports to `ui:stop` |
| `web/App.tsx` | ~10 spots: `API_PORTS`, config type, banner, admin badge, approval queue label |
| `web/styles.css` | `.x-banner` colour |
| `.vscode/*`, `CLAUDE.md`, `README*.md`, `docs/index.html` | Task configs + docs |

**Ports:** each mode gets `(4000+n, 5173+n)`. DevOps took 4005/5178, so a 7th mode takes
**4006/5179**.

**The policy** lives in one `if` block and returns one of three things:
- `{ behavior: 'deny', message }` — hard denial, the agent is told why
- `{ behavior: 'allow', updatedInput: input }` — runs immediately, skipping the approval gate
- *nothing* — falls through to the shared approval gate (so the admin approves it)

**Three defences you must not forget** (each one is a hole DevOps had to patch):
1. `Bash` can bypass a hard-denied `Edit` — in-place edits (`sed -i`, `patch`, `git apply`)
   must always route to approval.
2. MCP writes (`execute_sql`, `apply_migration`) must route to approval even for admin.
3. If the role shouldn't read secrets, `Read`/`Grep` must be removed from auto-approve so the
   sensitive-path check actually runs.

**Verification** (there's no test runner yet — this is what "verified" means here):
```bash
npm run typecheck && npm run ui:build
```
Plus manually: start the mode, confirm `/api/config` reports it, confirm a non-admin can't
change MCP config, and *actively try to bypass your own policy* (via Bash, via MCP, via
spoofing `X-Forwarded-For`).

**Known tech debt you may fix along the way:** role modes are loose booleans
(`isQcMode`, `isBaMode`, …) scattered across `runner.ts` and `App.tsx` rather than one
`RoleMode` union type. Consolidating that would make mode #7 much cheaper to add. A PR doing
*just* that refactor would be very welcome.
