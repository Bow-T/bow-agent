# Design: Bow-Agent

> Vietnamese version: [ARCHITECTURE.vi.md](ARCHITECTURE.vi.md)

This document describes the architecture of bow-agent after **the over-engineering was stripped
out**: a *lean single agent* built on the Claude Agent SDK, extended by three static knowledge
mechanisms (profiles, skills, monorepo context) and one **opt-in** multi-agent layer.

> **History:** the first version also had a "Genome" (per-repo evolutionary memory via
> fitness/mutation) plus a few code-bearing skills and a hand-rolled Jira REST client. A/B testing
> showed that with a strong model (Opus 4.8) those things only restated what the model had already
> worked out on its own → **wasted tokens, wasted complexity**. They are gone. If you go looking for
> `genome.ts` / `reflect.ts` / `tools/jira.ts` — they no longer exist.

## 1. Design principles

- **A 20W brain: cheap is good.** Write the least code that is still correct. No speculative
  abstraction. Every feature must return more value than it costs in tokens and complexity — if it
  doesn't, cut it.
- **One core, two faces.** CLI and Web share `core/runner.ts`; the only differences are how output is
  displayed (terminal vs SSE) and how you approve (typing y/N vs clicking a button). No duplicated
  logic.
- **Plan-then-approve.** Every WRITE operation (editing a file, side-effecting command, commit,
  migration, Jira write) goes through the approval gate `canUseTool`. Read tools run on their own.
- **Opt-in for the expensive stuff.** Multi-agent and MCP-scoping are choices; we don't turn on the
  costly thing by default when the task doesn't need it.

## 2. Overall architecture

```
      topic / WBS / Jira ticket / image / PDF
                       │
              ┌────────▼─────────┐
              │  input/task.ts   │  normalize into a "task brief"
              │  + jira-ref, pdf │
              └────────┬─────────┘
                       │
      ┌────────────────▼────────────────────────────────┐
      │            core/runner.ts (SDK query)            │
      │  systemPrompt = Claude Code preset (append):     │
      │    • BOW_AGENT_APPEND (plan-approve workflow)    │
      │    • prompt-only skills (core repo clone)        │
      │    • monorepo context (if cwd ∈ monorepo)        │
      │    • project profile (if --profile)              │
      │  + target repo's CLAUDE.md (settingSources:'project')│
      │  + MCP servers (Supabase/Jira/…)                 │
      │  + monorepo hooks (if cwd ∈ monorepo)            │
      │  + subagents (if --subagents)                    │
      └───┬──────────────────────────────────────────────┘
          │  canUseTool: reads run free · writes → onApproval
    ┌─────▼──────┐
    │ Edit/Write │  CLI: y/N in the terminal
    │ Bash / MCP │  Web: a Promise parked until a button is clicked
    └────────────┘
```

## 3. Three sources of knowledge (static, general → specific)

An LLM agent "forgets" between sessions. Instead of a complex dynamic learning mechanism, bow-agent
loads **static, pre-declared** knowledge into the system prompt — simple, readable, controllable.

| Source | Mechanism | Scope | Location |
|---|---|---|---|
| **Base profile** (team standard) | hand-written, committed → `--profile` loads it into the prompt | every project built to the same mold | `src/profiles/base/*.md` |
| **Generated profile** | agent scans an unfamiliar repo (read-only) → writes out a file | one unfamiliar repo at a time | `generated-profiles/` (gitignored) |
| **Monorepo context** | CLAUDE.md + skill catalog, self-activating | only when cwd ∈ monorepo | repo `Bow-T/bow-skill-flutter` (directory `monorepo/`, cloned into the cache) |

The prompt always says: *if the repo's reality contradicts the profile → trust the repo*. The
knowledge is a strong hint, not a hard rule.

## 4. Skills — reusable capabilities

bow-agent is an **empty frame**: there is no `skills/` (data) directory in the repo anymore. Skills
are fetched from a GitHub repo and cached in `~/.bow/skills-cache/<id>@<ref>`. The agent picks them
by description on its own (the user does not have to enable them in the UI):

| Source | Mechanism | Scope |
|---|---|---|
| **Target repo** `.claude/skills/*/SKILL.md` | SDK auto-discovers them thanks to `settingSources:['project']` + `skills:'all'` | one project at a time |
| **CORE** `Bow-T/bow-skill-core` (always fetched) | `deployCoreSkills(cwd)`: code-bearing skills (watch, qc-triage) are unpacked into `.claude/skills/` (STAMP `.bow-core`); prompt-only ones (coding-convention) are folded into the system prompt via `loadPromptSkills()` | every repo |
| **STACK** `Bow-T/bow-skill-flutter`/`-react-native`/`-nextjs` (fetched when a stack is selected) | `deployExternalSkills(stackId, cwd)` unpacks them into `.claude/skills/` (STAMP `.bow-external`); the Flutter repo also ships a `monorepo/` directory for monorepo context | whichever stack was selected |

The **registry** (allowlist of stacks + the core repo) lives **outside the repo**, at
`~/.bow-agent/registry.json` — seeded on first run from the `DEFAULT_REGISTRY` constant in
`src/config/env.ts`, overridable via the `BOW_REGISTRY` env var.

**Skip-list `.bow-skip`.** A target repo that has forked/renamed bundle skills into its own
committed set (e.g. the monorepo renamed `bow-ui` → `octopus-ui`) can opt out of individual
bundle skills via `.claude/skills/.bow-skip` — one skill name per line, `#` for comments,
committed with the repo so every machine honors it. `deploySkillsFrom` skips those names and
**removes** a previously deployed copy (recognized by its STAMP) — self-healing on machines
that already got the duplicate. Unstamped dirs (user-owned) are never deleted. Without this,
duplicated skills double their descriptions in the system prompt of every API call — pure
token waste — and the agent may pick the stale twin.

> **No more code-bearing skills running over MCP.** The first version had a `bow-skills` server
> (`src/skills/code.ts`) that ran real logic through `tool()`. It's gone — with a strong model, Bash
> plus Claude Code's built-in tools are already enough; an in-house MCP server whose only job is to
> "run tests" is needless complexity. (Code-bearing skills today are standard Claude Code skills —
> SKILL.md + a script — fetched from the core repo, not an MCP server.)

## 5. Multi-agent (opt-in) — `core/subagents.ts`

Single-agent by default. Pass `--subagents` and the main agent can delegate to specialized subagents
through the `Agent` tool — borrowing the idea of *role specialization*, implemented with the SDK's
`Options.agents` (no external framework like CrewAI).

| Subagent | Role | `permissionMode` | maxTurns |
|---|---|---|---|
| **reviewer** | argues against the plan/diff: missed call sites, cross-cutting risk, over-engineering | `plan` | 12 |
| **verifier** | runs tests/analysis + traces the runtime end-to-end (not just "it compiles") | `plan` | 15 |
| **impact-scout** | scans the blast radius: lists EVERY call site + hand-enumerated allow-lists/switches | `plan` | 10 |

**Safety lives at the tool layer, not just in the prompt.** `permissionMode: 'plan'` blocks
Edit/Write but does NOT block Bash — so each subagent also declares `disallowedTools`
(`READONLY_DENY`) that hard-denies `git commit/push/reset/checkout`, `rm`, `mv`, and
Edit/Write/NotebookEdit. Subagents only read and run verification commands; **every real change is
still made by the main agent and still goes through `onApproval`** — turning on multi-agent does not
loosen the approval gate.

A profile can add its own subagents (`buildSubagents` merges them; a profile overrides a standard one
on a name collision); they only take effect when `--subagents` is on.

## 6. Monorepo context — shipped in the box, activated conditionally

The monorepo's entire `.claude` comes from the stack skill repo `Bow-T/bow-skill-flutter` (the
`monorepo/` directory, declared via `monorepoDir` in the `bow-skill.json` manifest) — cloned into
`~/.bow/skills-cache/` so the agent no longer needs a `.claude` inside the monorepo itself. It only
applies when cwd is the monorepo, and only when the Flutter stack has already been fetched.

- **Detection** (`src/skills/monorepo.ts` → `isMonorepo`): cwd contains a `monorepo` path segment.
  Kept as a separate function so that switching to a marker file later touches exactly one place.
- **Jira project key** (`detectJiraProjectKey`): prefers `.env` (`BOW_PROJECT_KEY`), then the branch,
  then the most recent commit, and finally guesses from the directory name. Skills and CLAUDE.md use
  the `<PROJECT_KEY>` placeholder, which is mapped to the real key at load time.
- **CLAUDE.md + skill catalog** (`loadMonorepoContext(cwd, monorepoDir)`): takes the source directory
  from the stack clone; CLAUDE.md goes into the prompt verbatim; skills contribute only
  name + description + path (the agent `Read`s the full file itself when a task matches) — this avoids
  stuffing a thousand lines into every turn. The catalog is scanned dynamically, so the count tracks
  the stack repo automatically.
- **Hooks** (`src/skills/hooks.ts` → `buildMonorepoHooks(cwd, hooksDir)`): takes the hooks directory
  from the stack clone and wraps 4 shell scripts as SDK hook callbacks, attached only when cwd is the
  monorepo:
  - `PreToolUse(Bash)`: guard-push (blocks a push when the quest gate fails), guard-commit-branch
    (blocks commits on a protected branch) → `exit 2` maps to `{ decision: 'block' }`.
  - `SessionStart`: ensure-githooks (wires up core.hooksPath; non-blocking).
  - `Stop`: self-verify-rubric (reminds you of the rubric when there is an unpushed commit;
    non-blocking).
  - The scripts find the monorepo's `scripts/*.sh` via `CLAUDE_PROJECT_DIR` = monorepo root.
  - **Fail-open**: an infrastructure error in a hook must not take the agent down.

The source lives in the `Bow-T/bow-skill-flutter` repo (the `monorepo/` directory) and never touches
the monorepo's own `.claude`. When the monorepo changes a skill or a hook, update it in that stack
repo and commit; bow-agent clones the latest version into its cache on every run once the Flutter
stack is selected. The monorepo's `.claude` is left intact so Claude Code still works directly against
it. (The old `sync-monorepo` script is gone — its old target `skills/monorepo/` no longer exists.)

> **Note on the skill prefix:** the monorepo context uses the `bow-*` skill prefix. If the monorepo's
> `.claude/skills` still has `octopus-*` names, align the prefix at the source (the `bow-skill-flutter`
> repo, `monorepo/` directory) before committing, so bow-agent pulls down the right names.

## 7. MCP — reusing Claude Code's connections

`src/tools/mcp.ts` loads MCP servers (stdio) — Supabase, Jira, Codemagic, Figma. No hardcoded tokens;
they are only referenced at run time.

- **The config file is SPLIT OFF from the profile**: the shared MCP config lives at
  `~/.bow-agent/mcp.json` (getter `config.mcpConfigPath` in `env.ts`, overridable via `BOW_MCP_CONFIG`),
  **seeded on first run** from `~/.claude.json` so existing config isn't lost. Why split it: MCP used
  to live in the `.claude.json` of whichever profile was logged in → switching accounts lost your MCP
  servers and you had to declare them again. A fixed, separate file means your MCP servers survive any
  number of account switches. (Login/tokens still follow the profile, as before.)
- **CLI**: all servers are ON by default (so a Jira ticket can be read right away). `--mcp a,b`
  restricts the set; `--no-mcp` turns them off.
- **Web**: the admin ticks servers in the MCP panel and can add/remove them (writes to the shared MCP
  file safely, with backup + validation, and masks tokens on the way back to the UI). **Per-user MCP**
  (`src/web/userMcp.ts`): an approved LAN user manages their own MCP list in
  `conversations/user-mcp.json`, which is **overlaid on top of** the shared config (on a name collision,
  the user's version wins) and applied on every run — including QC/Collab.
- **Tool gating**: read tools (`list_*`, `get_*`, `jira_get_*`, `search_docs`, …) are auto-allowed via
  `mcpReadToolPatterns`; write tools (`execute_sql`, `apply_migration`, `jira_add_comment`, …) must be
  approved.

> ⚠️ The SDK passes MCP config (tokens included) as command-line arguments → while MCP is on, `ps aux`
> can read those tokens for as long as the agent runs. Use `--no-mcp` for tasks that don't need a real
> connection.

### 7.1. Images in a Jira ticket → letting the agent see them — `src/input/jira-attachments.ts`

**The problem**: the MCP `jira_get_issue` call returns TEXT only (summary/description/comments). Images
attached to the ticket → the agent is blind to them. People routinely drop mockups, wireframes, and bug
screenshots into a ticket, and that is the most important part for understanding the request.

**The bottleneck**: the MCP `jira_get_attachments` call hands back **metadata + a URL** (the `content`
field), NOT the bytes. Fetching the `/secure/attachment/...` URL with a bare curl returns a login page,
not an image. Getting the bytes means calling the REST API yourself, with auth. (Same conclusion as
`netresearch/jira-skill` and `rui-branco/jira-mcp` — two community skill/MCP projects that solved this
image-fetching part correctly.)

**The flow** (runs inside `buildTaskBrief` when the ref is a ticket):

1. MCP `jira_get_attachments(key)` → the list of attachments (id, filename, mimeType, content-url).
   Filter for a `mimeType` starting with `image/`.
2. Fetch the bytes with auth: `GET {JIRA_BASE_URL}/rest/api/3/attachment/content/{id}` with
   `Authorization: Basic base64(EMAIL:TOKEN)`. All three variables come from the `mcpServers.jira.env`
   block in `~/.claude.json` (NOT from `process.env` — see `env.ts:39`), following the redirect to the
   CDN.
3. Verify the **magic bytes** (PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF, WEBP) — if it's HTML, it's a
   login page → drop it, keep it out of the context. Limit: `MAX_IMAGE_BYTES = 5MB` per image.
4. Cache the bytes in `.jira-cache/{issueKey}/{attachmentId}.{ext}` (gitignored) — fetched once, read
   back from disk on later turns.

**Getting them into the context**: we do NOT make a separate vision call to generate a description. The
original images are pushed straight into `images[]` (reusing the existing vision path at
`runner.ts:483`) — **the main agent looks at them and describes them itself** as it works, writing them
into the journal / `shared.md` if they're worth remembering (§9). The brief only adds one line:
"this ticket has N images: … (attached above)".

> Security: `JIRA_API_TOKEN` is a personal secret — never log the token, only fetch from the exact
> `JIRA_BASE_URL` host (SSRF protection), and confine the cache to the repo (path-traversal protection
> against a Jira-supplied filename). Fail-open: a failure to fetch one image must not take down reading
> the ticket — insert a "[image could not be read]" placeholder so the agent knows the ticket *has* an
> image.

### 7.2. Video in a Jira ticket + the `/watch` skill — watching video

**The problem**: ticket videos (usually a screen recording of the bug) — Claude cannot "watch" video
directly (there is no video content block the way there is for images). It has to be reduced to
(JPEG frames + a transcript), which Claude then `Read`s frame by frame.

**The solution**: the `/watch` skill (originally `bradautomates/claude-video`, MIT) is now a **CORE**
skill in the `Bow-T/bow-skill-core` repo (fetched on every run), plus code that downloads the Jira video
to disk for the skill to process.

**Unpacking the skill** — core repo clone → `src/skills/externalSkills.ts` → `deployCoreSkills(cwd)`:
- Before each run, core is cloned into `~/.bow/skills-cache/<id>@<ref>` and the code-bearing skills
  (watch, qc-triage) are copied into `<cwd>/.claude/skills/watch/` for the SDK to auto-discover
  (`settingSources: ['project']` + `skills: 'all'` are already on). That way the agent ALWAYS sees
  `/watch` in every repo, with no manual install.
- Idempotent (a `.bow-core` signature stamp; it only re-copies when the clone changes). SAFE: if the
  target repo already has a `.claude/skills/watch/` that we did NOT unpack (no stamp) → treat it as the
  user's own and don't overwrite it. Never touches the user's other skills.
- Runtime requirements: `ffmpeg` + `yt-dlp` (the skill installs them via brew/apt on first use; a
  Whisper key is optional).

**Jira video attachments** — `fetchJiraTicketVideos()` in `jira-attachments.ts`:
- Filters for a `mimeType` starting with `video/` and downloads to `.jira-cache/{key}/{id}.mp4` (same
  REST + auth path as images).
- **Limit `MAX_VIDEO_BYTES = 50MB`**: anything larger is NOT downloaded automatically (rejected early
  from the metadata size, so building the brief doesn't hang) — it just reports "video X is too large,
  view it manually".
- The brief tells the agent: "the video is downloaded at `<path>` → use `/watch <path>` to watch it".

**Video URLs the user pastes** (YouTube/Loom/…): no code needed — the agent sees the URL in the text and
uses `/watch <url>` on its own (the skill's yt-dlp does the download).

**Operating conditions**: `/watch` runs a number of Bash commands (download, ffmpeg, Whisper) → it suits
`auto` mode; in `manual`/`edit-auto` the agent will ask for approval on each command.

> Verified end-to-end: downloaded a real Jira video (REST + auth) → ffmpeg extracted frames → Claude
> could read the frame content; the bow-agent agent found and invoked `/watch` on its own (and stopped at
> the Bash approval gate in manual mode — exactly as designed). Unlike `bradautomates/claude-video` (which
> only takes a URL or a local file), bow-agent adds the Jira attachment source and unpacks the skill
> itself.

## 8. The approval gate (summary)

Every road to a WRITE operation passes through exactly one gate — `canUseTool` in `runner.ts`:

1. **Read tools** (`Read/Grep/Glob` + the MCP read patterns) are auto-approved by a **PreToolUse hook**
   (`buildReadAutoApproveHook`, `src/skills/hooks.ts`) — deliberately **not** via `allowedTools`, which is
   left empty (see `runner.ts:344`). The reason: an entry in `allowedTools` is auto-approved *before*
   `canUseTool` ever runs, so it **shadows the gate** and there is no way left to block a read of a
   sensitive file. QC/Reviewer/DevOps go further and deliberately **exclude `Read`/`Grep`** from this hook,
   so that `isSensitivePath` (blocking `.env`, `.ssh/`, `.git-credentials`, …) actually runs.
2. **Safe Bash** (`SAFE_COMMANDS`: `flutter test/analyze`, `npm test`, `tsc --noEmit`, `git status/diff`,
   …) is auto-allowed — so running tests and verification doesn't pester the user.
3. **Everything else** (Edit/Write, side-effecting Bash, MCP writes) → `onApproval`. A rejection returns
   `behavior: 'deny'` with a message telling the agent to stop and ask for a different approach.
4. **Monorepo hooks** block further at the `PreToolUse` layer (push/commit) — independent of the gate
   above.
5. **Subagents** (when enabled) are locked down by `permissionMode:'plan'` + `disallowedTools` and cannot
   reach the write gate at all.

On top of that, **risky** Bash commands (`RISKY_COMMANDS`: `rm/mv/cp`, output redirection,
`git push/reset --hard/rebase/--force`, `chmod/chown/sudo`, `curl … | sh`, running inline scripts, …)
always go through the approval gate **even in `auto` mode**. There is no Git exemption anymore — even
`git push` has to be approved.

### 8.1. Web — six permission modes (one and the same backend)

`src/web/server.ts` turns on one of six modes via a `BOW_*_MODE` env var; each mode gets **its own port**
(`BOW_AGENT_PORT`) so they can run side by side without colliding. The shared modes set
`BOW_SERVE_STATIC=true`, so the backend serves the built frontend from that same port (Dev keeps a
separate Vite dev server on 5173). The policy lives in `canUseTool` (`runner.ts`) plus the
`checkReadonlyConfig`/`requireAdmin` middleware (`server.ts`):

| Mode | Port | Forced mode | Policy |
|---|---|---|---|
| **Dev** (`ui`) | 4000 (+ Vite 5173) | client chooses | Admin (localhost) gets everything. **Non-admin LAN clients are forced to `plan`** (read-only) — to write, go through Collab |
| **QC** (`ui:qc:share`, `BOW_QC_MODE`) | 4001 | `plan` | **WHITELIST** of read tools (Read/Glob/MCP-read) **+ Skill** (to trigger qc-triage) **+ Jira read/write** (comment/transition); Grep is DENIED specifically; sensitive files blocked; source code DENIED; model forced to `claude-sonnet-5`; technical UI hidden |
| **Collab** (`ui:collab`, `BOW_COLLAB_MODE`) | 4002 | `auto` | Contributors edit code and run tests freely; **every WRITE operation (Edit/Write, risky Bash including Git, MCP writes) by a non-admin contributor is routed to an ADMIN for remote approval** (`requireApprovalForWrites` + `adminBus`) |
| **BA** (`ui:ba`, `BOW_BA_MODE`) | 4003 | `auto` | Free to write **documentation** (`isDocPath`: `docs/`, `*.md/.mdx/.txt`) and use **full Jira**; source code / config / DB / deploy are **HARD-DENIED** (the admin is not even asked — if you want to change code, switch modes) |
| **Reviewer** (`ui:review:share`, `BOW_REVIEWER_MODE`) | 4004 | `plan` | **WHITELIST** of read tools + Skill (pr-review) + a **Bash** filter of its own (`isReviewGhCommand`: `git diff/status/log/show`, `gh pr view/diff/list/checks/comment/review`) + `SAFE_COMMANDS` (test/analyze); Jira **read**; writing source files / merging / pushing / risky commands / command chaining are DENIED; model forced to `claude-sonnet-5`; technical UI hidden |
| **DevOps** (`ui:devops:share`, `BOW_DEVOPS_MODE`) | 4005 | `auto` | A **hybrid**: writes **infrastructure files** by target path (`isInfraPath`: Dockerfile, `docker-compose*`, `.github/workflows/*`, `*.tf/*.hcl`, k8s/Helm) and ops docs, like BA; but **application source is HARD-DENIED**, and **deploy/apply commands are routed to an admin for approval** like Collab (`routeToAdmin = (isCollabMode \|\| isDevOpsMode) && !isAdmin`). In-place file edits via Bash (`sed -i`, `patch`, `git apply`) always require approval — Bash must not be a way around a hard-denied `Edit` |

- **Admin = the real socket IP is `127.0.0.1`** (`getSocketIp`, which **ignores** `X-Forwarded-For` so a
  LAN client can't spoof a header into admin rights). Config changes (shared MCP / workspace /
  skill-sync) are blocked with a 403 by `checkReadonlyConfig` in all five shared modes
  (QC/Reviewer/Collab/BA/DevOps).
- **Claude account selection = admin (localhost) only**: `GET /api/config` returns `claudeProfiles`
  (the host's `~/.claude*` profile list) + `currentClaudeProfile` only when `isAdmin`; a LAN client gets
  an empty array, so the UI **hides** the account picker entirely (host profile names are never leaked).
  Even if a LAN client sends a `claudeProfile` flag to `/api/run`, the runner **ignores it**
  (`effectiveClaudeProfile = undefined` when `!isAdmin`) and runs under the server's env account — **all
  account setup is done from `localhost` only**.
- **Autopilot A–Z (admin localhost only)**: the 🛸 toggle sets the `autopilot` flag (server forces
  `effectiveAutopilot = isAdmin && autopilot === true`; a LAN client's flag is IGNORED, like
  `effectiveClaudeProfile`). Runs like `auto` but: (1) at session start it makes a **git checkpoint**
  (`createCheckpoint` in `checkpoint.ts` — `baseSHA` + a snapshot of the WHOLE worktree incl. untracked,
  pinned at `refs/bow/autopilot/<id>`) plus an append-only **journal** `conversations/autopilot-<id>.jsonl`,
  so `git reset --hard baseSHA` / `git checkout snapshot -- .` can roll back; (2) it **LOOSENS** the gate
  for pure in-repo file writes (`mv`/`cp`/`>`/`tee` via `autopilotBashDecision` in `autopilotBash.ts` —
  fail-safe: anything uncertain or out-of-repo still asks); (3) it **TIGHTENS**: DB/MCP writes,
  `git push`/`reset --hard`/`--force`/`rebase`/`clean`, `gh pr create`/`merge`, `rm`/deletes, out-of-repo
  writes, `chmod`/`sudo`… always ask. The system prompt forces runtime verification (analyze+test+trace+
  impact-sweep) before "done" and stops at a local commit on the ticket branch, awaiting push/MR approval.
- **Remote approval (Collab)**: `session.ts` has an `adminBus` (kept separate from Session because each
  contributor's session has exactly one SSE consumer). The contributor is parked waiting; the admin opens
  the SSE stream `GET /api/admin/events` and approves via `POST /api/admin/approve` → which resolves the
  parked Promise on the contributor's side.
- Each mode's source directory (`cwd`) is fixed by `BOW_{QC,COLLAB,BA,REVIEWER}_CWD`; the admin can change
  it at run time via `POST /api/qc-cwd` (an in-memory override, no restart).

### 8.2. LAN access + auto-resuming when the usage limit runs out

- **LAN access gate** (`src/web/access.ts`): a non-localhost client is blocked from every `/api/*` route
  until it **sends a request (entering a NAME)** and an admin **approves** it in the LAN Dashboard (there
  is no "access code"). The issued token is stored server-side in `conversations/access.json`; the client
  keeps it in `localStorage` (`bow-access-token`) and attaches it as the `x-bow-token` header. Realtime
  updates go over SSE at `/api/access/events`.
- **Auto-resume on usage limit** (`server.ts`): when a **running** session is stopped because the 5-hour
  usage limit was hit (`isSessionLimit`), the server computes the reset time (`resetsAt + buffer`) and
  uses `setTimeout` to start a new session that **resumes the same `conversationId`** with a "continue"
  prompt, **up to 3 times** (`AUTO_RESUME_MAX_ATTEMPTS`). This survives closing the tab (it's
  server-side); the client has a countdown fallback plus a cancel button. Simulate it in tests with
  `BOW_SIMULATE_SESSION_LIMIT=true`.

## 9. Workspaces — grouping repos + accumulated memory

> **Status:** IMPLEMENTED (`src/profiles/workspace.ts`, wired into `runner.ts`; managed from the web UI's
> workspace panel + the `/api/workspace/*` API). Activate it by registering a repo in
> `workspaces/workspaces.json` — with nothing registered, behavior is exactly as before.
> User decisions: (a) prioritize **linking multiple repos**, (b) memory is written **automatically**,
> (c) stored **inside bow-agent, gitignored** (like `generated-profiles/`), (d) the agent gets
> **read-only cross-repo access** to sibling repos.

### 9.1. The problem

All three knowledge sources in §3 are **static and bound to a single `cwd`**. Real usage doesn't fit that
mold:

- **One "product" spread across several repos in several directories**: the BE in one place, the FE in
  another, sometimes an infra/monorepo too. Profiles are named after `basename(cwd)` (`generate.ts:29`),
  so each directory is an island — point the agent at the FE and it **knows nothing about the BE's API
  contract**.
- **No memory between sessions**: `generateProfile` only snapshots the *static structure*, once. Test the
  agent on a repo, come back for the next session → every decision and everything learned in the previous
  session has evaporated. (`resumeSessionId` restores *one* conversation thread, not knowledge
  accumulated across sessions and across repos.)

The result: the user has to "re-teach" the context every time, and there is no way to tell the agent
"this FE talks to that BE".

### 9.2. The concept: a workspace = 1 product made of several repos

This adds **a layer on top of profiles** (it does not replace them). A workspace gathers several `cwd`s
(each of which still has its own profile, as before) into one product, along with two shared knowledge
files:

```
bow-agent/
└── workspaces/                      ← gitignored, per-machine (like generated-profiles/)
    ├── workspaces.json              ← the registry: workspace ⇄ repos (cwd) + roles
    └── delivery-app/
        ├── shared.md                ← SHARED product knowledge (BE↔FE contract, technical decisions)
        └── journal.md               ← AUTOMATIC log: each session appends one entry
```

`workspaces.json`:

```jsonc
{
  "delivery-app": {
    "repos": {
      "/path/to/delivery-backend": "BE",
      "/path/to/delivery-flutter":  "FE",
      "/path/to/delivery-monorepo": "infra"
    }
  }
}
```

Why store it here: it **mirrors `generated-profiles/` exactly** — same place, same gitignore policy, same
"per-machine runtime" nature. No new storage concept; it reuses the §3 principle that already exists.

### 9.3. Mechanism 1 — linking repos (the priority)

**When the agent is pointed at a `cwd`** (`runner.ts`, right where the profile is merged in,
`runner.ts:281–283`):

1. `resolveWorkspace(cwd)`: scan `workspaces.json` and match `cwd` by **path prefix** (a repo that is a
   child of a registered `cwd` counts too) → return the workspace containing it, or `null`.
2. If it belongs to a workspace → append **a new block** to the system prompt, placed *before* the project
   profile (general → specific), containing:
   - **`shared.md`** — shared product knowledge.
   - **A map of sibling repos** — each repo, its role, and its absolute path, so the agent knows "where
     the BE is, which contract the FE uses".
   - **`journal.md`** — accumulated memory (see §9.4).
3. A repo that belongs to **no** workspace → no such block → behavior is identical to today. This is an
   **opt-in** layer; it doesn't change the existing code path (per the principle in §1).

**Read-only cross-repo access** (the user's decision). Today `allowedTools` opens up `Read/Grep/Glob`, but
the SDK scopes them to `cwd`, so an agent working on the FE cannot read BE files. We need to **widen the
read scope to the sibling repos, read-only**:

- The SDK lets you pass extra read roots via `additionalDirectories` (the paths of the sibling repos). The
  agent can `Read/Grep/Glob` its way into the BE to learn the real contract instead of **guessing**.
- **Writes stay locked to the current repo.** The `isPathInRepo` gate (`runner.ts:340–344`) only counts
  `workdir` (cwd). A sibling repo lies outside `workdir` → any Edit/Write into it **falls into the "write
  outside the repo" branch → always asks for approval** (even in `auto` mode). In other words: *reading
  across repos is free; writing across repos still needs permission* — no new rule is required, it just
  reuses the §8 gate that already exists.
- The prompt has to spell it out: *sibling repos are for REFERENCE (reading); don't modify them unless the
  user asks and approves.*

### 9.4. Mechanism 2 — automatic accumulated memory (a freebie, riding on the above)

Since §9.3 already loads `journal.md`, all that's left is **writing** to it at the end of a session.

**Writing (automatic):** once `query()` finishes successfully (`runner.ts`, after the `case 'result'`
branch), run a short condensation step: summarize the session into 3–6 bullets — *what was done / what was
decided / what was learned about the product* — then **append** a timestamped entry to the workspace's
`journal.md`. (Only when cwd belongs to a workspace; otherwise skip it.)

There are two ways to implement the condensation step — the **cheap** one was chosen and implemented
(`condenseForJournal` in `runner.ts`):
- **Cheap (what we use):** reuse `finalText` itself (the done-report from §BOW_AGENT_APPEND already has the
  structure "what changed / what was verified / what's left") → trim it and append. **Costs no extra model
  turn.**
- **More thorough:** a short secondary `query()` call, fed the transcript → a condensed summary. Costs extra
  tokens; only worth it if the cheap version turns out noisy.

**Keeping it from bloating:** the journal is append-only, so it grows without bound → only load the **N most
recent entries** (or up to a character budget) into the prompt; older entries stay on disk for manual
lookup. There is no complicated "learning" machinery — which is exactly the §3 spirit of "static, readable,
controllable": the journal is just markdown that a human can read and edit by hand. This is **not** the
Genome that was removed (no fitness, no mutation, no evolutionary loop) — it's a flat logbook.

### 9.5. Code integration points (minimal, no disruption to the existing path — all wired up)

| Task | File | How it wires in |
|---|---|---|
| Workspace module (read/write md + json, resolve by cwd prefix) | `src/profiles/workspace.ts` (new) | Mirrors `index.ts`/`generate.ts`; reuses the `GENERATED_DIR` pattern. |
| Push the workspace block into the prompt | `src/core/runner.ts` (§281–283) | `resolveWorkspace(cwd)` → append shared + map + journal before the project profile. |
| Open up read-only cross-repo access | `src/core/runner.ts` (`options`) | Add `additionalDirectories` = the sibling repo paths. |
| Write the journal at end of session | `src/core/runner.ts` (after `case 'result'`) | Condense `finalText` → append to `journal.md`. |
| Register/assign a repo to a workspace | `src/web/server.ts` + `web/App.tsx` | A workspace picker/creator next to the `cwd` field (like the MCP panel). |
| gitignore | `.gitignore` | Add `workspaces/`. |

**Why this is safe:** the whole feature runs *parallel* to `generated-profiles/` and only activates when
`cwd` matches a registered workspace. Register nothing → nothing changes. Cross-repo writes still go
through the §8 approval gate. The memory is flat markdown you can edit or delete by hand — no hidden state.

### 9.6. Out of scope (deliberately not done)

- **Sharing memory between machines** (committing it / a shared server): the user chose per-machine and
  gitignored. If it needs to be shared later → only the storage location changes, the mechanism stays.
- **Approving journal writes**: "automatic" was chosen. If the journal turns out noisy → add an approve
  button later.
- **Inferring repo relationships automatically** (guessing FE↔BE): do it by hand in `workspaces.json`
  first; don't guess, to avoid getting it wrong.

## 10. The web shell — nav, tabs, panels, Cosmos

`web/App.tsx` is now only the **shell**; the individual screens live in `web/panels/*`.

- **Left nav** (`AppNav.tsx`, 196px): 8 entries — Workspace · Agents · Approvals · Jira · Repos · Cosmos ·
  Activity · Settings. Admin entries are hidden in the shared modes, but **hiding UI is a thin layer only** —
  the real permissions are enforced server-side by `canUseTool` + `requireAdmin`. Cosmos is not a screen: it
  opens the universe overlay of the tab you are in.
- **The tab bar = independent sessions.** Each tab keeps its own state in `localStorage` under a per-tab
  suffix (`bow-<key>_<tabId>`): model, effort, provider, account, conversation, session id. That is what lets
  tab A run Claude on one repo while tab B runs Grok on another, at the same time. Tabs are drag-reorderable;
  `Conversation.tabId` is stamped ONCE at creation, so the History tab filters by tab instead of mixing every
  task (older records have no `tabId` → they only show under "all").
- **Right rail** (`RightRail.tsx`): agent activity · the approval queue (across all tabs) · recent tasks.
- **Read-only panels**: `GET /api/agents` (subagent metadata) and `/api/jira/{config,sprints,issues}`, reusing
  `src/scheduler/jiraApi.ts`. **No write routes were opened** — writing to Jira still goes agent → MCP → gate.
- **Talking over a running turn** — `POST /api/say/:id`: the streaming input channel is a QUEUE
  (`createInputChannel`), so an interjection is appended to the session that is ALREADY running and therefore
  still runs under the `canUseTool` gate fixed at `/api/run` time (no permission is widened). A LAN client can
  only speak into the session belonging to its own IP; admin on localhost can speak into any; it is audit-logged.
  At `result` the channel is closed only once every message has a result (`doneTurns >= input.count()`), with a
  120s idle guard as the brake.
- **Worktrees** (`core/gitWorktree.ts`): `bow worktree add|list|remove` plus `POST /api/worktree/create` /
  `DELETE /api/worktree/remove` (both `requireAdmin`) create `wt-<ticket>` next to the repo on branch
  `feat/<ticket>`, so two agent sessions on two tickets never share one working directory. `prunable`
  worktrees are skipped when listing.
- **Cosmos** (`CosmosOverlay.tsx`, plain three.js): a navigable universe — a 6-DOF spaceship camera with
  inertia, 9 systems rendered as 9 different phenomena (nebula/wormhole/pulsar/belt…), **6 continuous LOD
  tiers** UNIVERSE → SYSTEM → MODULE → FILE → FUNCTION → CODE, with real files/symbols/source fetched lazily
  through the read-only `/api/file-source` + `/api/file-symbols` (`src/web/fileApi.ts`, path-traversal
  guarded). What the agent is touching right now lights up, driven by real `activeSources`.
- **Mobile**: every ≤860px rule is collected in the **§MOBILE block at the end of `web/styles.css`** (last so
  it beats the `[data-theme='figma']` overrides without `!important`) — nav becomes a drawer, the header wraps
  to a second row, the composer takes the full width (16px text, or iOS Safari zooms on focus).

## 11. The context window — self-compaction, overflow recovery, session isolation

Long conversations are normal here (marathon sessions), so `runner.ts` treats context as its own layer:

- **Measure**: `emitContextUsage` (throttled to 800ms) emits `contextTokens/contextMaxTokens` to the UI.
- **Self-compact**: on reaching `BOW_COMPACT_AT` (default **80%**), `/compact` is queued. The decision lives
  in the pure `shouldCompactNow`, called from **two** places: the mid-turn measurement (`emitContextUsage`)
  and the turn boundary (`result`). Compacting **mid-turn** is what actually saves the session: a marathon
  turn can grow from below the threshold to past the ceiling without ever reaching `result` — and by then
  `/compact` blows up too, since compaction must also ship the whole conversation (measured on grok:
  503,312/500,000 tokens). The input channel is queued, so the SDK picks the compaction up as soon as the
  agent releases its current tool.
- **Growth-rate safety brake** (matters more than the % threshold): one burst of file-reading tools on a
  monorepo dumps hundreds of thousands of tokens into a SINGLE measurement gap — measured on grok:
  `56k → 228k` after three file reads (+172k). A % threshold can never catch that: context jumps from below
  the threshold straight past the ceiling with no measurement in between. So `shouldCompactNow` also fires
  when `tokens + delta × 1.5 >= ceiling` — "if one more burst like the last one would overflow, compact now".
- **Accounting for compaction turns**: a `/compact` bow sends itself takes a slot in `input.count()` but never
  ends in a `result`. Counting `compactsSent`/`compactsSettled` keeps the channel open while a compaction is
  still pending (otherwise the SDK closes the transport before it runs) and subtracts settled slots when
  asking "is any user turn still unanswered?" — without that the session sits idle until the 120s guard fires.
- **The ceiling has to be the REAL number**: `providerContextTokens` (`config/env.ts`) declares the ceiling per
  provider (grok = 500k, override with `BOW_PROVIDER_CONTEXT_TOKENS`). The CLI *guesses* a ceiling for models
  it doesn't know (it guessed 200k for grok) — trusting that guess made bow declare an overflow while more than
  half the window was still free. That once led to **turning the CLI's autoCompact off** for external providers
  — a mistake: it is the only safety net that can compact *mid-turn* (bow's own `/compact` merely queues an
  input). With it off, one burst of file-reading tools (+172k per gap, measured) sails past the ceiling with
  nothing to catch it. The fix is to **keep the net and feed it the REAL ceiling** via
  `autoCompactWindow = trueContextMax`; only providers whose true ceiling is unknown still turn it off.
- **Overflow recovery**: past the hard ceiling even `/compact` fails (compacting has to send the whole
  conversation up too). The runner then emits `error/context_overflow`, the tab clears its context (drops
  `conversationId`), and the next turn continues from the `resumeContext` **summary** (20k chars for external
  AIs — that is the entire memory that survives).
- **Session isolation**: right after a context wipe an agent is very tempted to "find its memory" by reading
  another session's `.jsonl` transcript — and then continue *another tab's* work (caught red-handed once). So
  the conversation stores (`.claude*/projects`, `~/.bow-agent`, `conversations.json`) are blocked at **both**
  layers: the `PreToolUse` hook (`src/skills/hooks.ts`) *and* `canUseTool`. Both are required: hooks run BEFORE
  the gate, so auto-approved Read/Grep/Glob would never reach `canUseTool`; conversely a hook alone doesn't see
  every path Bash can take.

## 12. Token accounting — `core/tokenUsage.ts`

`/usage` (the 5h/weekly plan windows) is an **Anthropic-only control request**: through a gateway the endpoint
doesn't exist, and it would be the wrong question anyway — an external provider bills pay-as-you-go per token
and has no session window. What you want to see after switching to Grok is **how many tokens you burned**, so
bow counts them from the **Claude Code transcripts** — where the SDK records the real `message.usage` of every
turn, subagent turns included.

- **Scan EVERY Claude config directory** on the machine (`~/.claude`, `~/.claude-<profile>`…): each
  `CLAUDE_CONFIG_DIR` has its own transcript store, so reading only `~/.claude` misses nearly everything.
- **Globally de-duplicate by `message.id`**: resume/compact copy history into a new transcript, so one turn
  lives in several files — summing per file inflates the number.
- **Cache by (size, mtime)** in `~/.bow-agent/usage-cache.json`: the first scan of ~4000 transcripts takes ~2s,
  every later one ~30ms.
- `GET /api/usage/tokens` is behind **`requireAdmin`** — it aggregates tokens across every Claude account on
  the machine, which is not something to expose to LAN guests of the shared modes.

## 13. Prompt-injection screening & command de-obfuscation

Three speed bumps (not hard walls — the approval gate remains the real boundary):

- **Guard prompt** (`core/systemPrompt.ts`): teach the agent to treat external data (Jira/WBS/images/web/tool
  results) as **DATA**, never as **INSTRUCTIONS**.
- **Content screener** (`core/screener.ts`): score external data with one cheap LLM pass before it enters the
  turn. **Fail-open** — a suspected injection gets the brief wrapped in a warning label and still runs, it is
  not blocked. It only runs when there really is external data (a Jira ref / docs / images), so text the user
  typed themselves costs nothing.
- **Command de-obfuscation** (`core/scannableCommand.ts`): peel the wrappers (quotes, `bash -c`, `eval`,
  pipe-to-shell) *before* matching. Shared by `isRiskyCommand` (interactive runner) and `autoApprovalPolicy`
  (full-auto sprint-scan) — raw string matching lets `r""m -rf`, `bash -c 'rm -rf ~'` and `echo rm|bash` through.

## 14. Possible extensions (not done)

- **A UI for picking skills / subagents**: today the agent picks skills itself, and subagents are enabled as
  a whole group by a flag. We could add a picker on the web UI, like the MCP panel.
- **Profiles with their own subagents**: the `profileSubagents` scaffolding exists (`buildSubagents` merges
  them), but none of the current `.md` profiles declare any subagents.
- **A marker file for monorepos**: `isMonorepo` currently detects by path segment; switching to a marker file
  (e.g. `scripts/check-quest.sh`) would be more accurate for repos that happen to share a name.
- **A journal for failed sessions**: today the journal is only written when a session succeeds — the lessons
  from a failed session, or one whose approval was rejected, are not recorded.
