# Contributing to bow-agent

Thanks for being here. This project started as an internal tool and went open because the
problem it solves — *letting a team share an AI coding agent without handing everyone root* —
turned out not to be an internal problem at all.

**Ideas count as contributions.** You do not need to write code to be useful here.

## The easiest ways to help

| I want to… | Do this |
| --- | --- |
| Share an idea or use case | [Open a discussion](https://github.com/Bow-T/bow-agent/discussions) |
| Report something broken | [Open an issue](https://github.com/Bow-T/bow-agent/issues/new) |
| Tell me my docs are confusing | Also an issue — genuinely, this is valuable |
| Write code | Read on |

If you're not sure whether an idea is worth raising: raise it. A duplicate costs me ten
seconds; an idea you kept to yourself costs the project.

## Things I'd love help with

- **More role modes.** There are five (Dev, QC, Collab, BA, Reviewer). What about a designer
  mode? A PM mode? A security-reviewer mode? Each is a permission policy in `canUseTool` — the
  hard part is deciding what the role should and shouldn't touch, and that's a *product*
  question more than a coding one.
- **More stack profiles.** The base profile assumes Flutter + Supabase because that's what I
  build. If you work in Rails, Django, Next.js, Go — a profile encoding your stack's
  conventions would make the agent immediately useful to people like you.
- **Auth beyond LAN.** Right now sharing means "same network, admin approves you by name."
  Real auth would let teams use this remotely.
- **Translations.** Docs are English + Vietnamese today.

## Development setup

```bash
git clone https://github.com/Bow-T/bow-agent.git
cd bow-agent
npm install
npm run ui        # web UI on http://localhost:5173
```

You need Node ≥ 18 and the [Claude CLI](https://claude.com/claude-code) logged in
(`claude` → `/login`). No API key required — it uses your existing Claude subscription.

Useful commands:

```bash
npm run typecheck    # tsc --noEmit — please run before opening a PR
npm run dev -- run --text "…" --cwd ~/some-repo   # CLI, plan mode
npm run ui:build     # build the web frontend
npm run ui:stop      # kill every mode's ports
```

## Architecture in one paragraph

CLI (`src/cli/index.ts`) and Web (`src/web/server.ts`) are two faces of one core:
`src/core/runner.ts`. They differ only in presentation (terminal vs SSE) and how approval is
collected (`y/N` vs a button). **If you're changing agent behavior, change it in `runner.ts`** —
don't duplicate logic into one of the faces.

Full design: [ARCHITECTURE.md](ARCHITECTURE.md).

## The one rule that matters

**There is exactly one safety gate: `canUseTool` in `src/core/runner.ts`.**

Read tools and safe shell commands run automatically. Every write — file edits, side-effecting
shell commands, Jira writes, SQL — routes through that gate for approval.

Do not add a code path that writes without passing through it. Not "just for this one MCP
tool," not "just in execute mode," not "just for git." The entire value of this project is that
the gate has no holes. A PR that opens one will be declined no matter how good the rest of it is.

If you think the gate itself is wrong, that's a legitimate discussion — open an issue and argue
for it. Just don't route around it quietly.

## Pull requests

1. Branch off `main`.
2. Run `npm run typecheck` — it must pass.
3. If you changed agent behavior, say in the PR description **what you tried** to verify it, not
   just that it compiles.
4. Keep the diff focused. One idea per PR.

Commit messages: describe the change plainly. Please don't add AI co-author trailers —
there's a hook that blocks them.

## Code style

Match the file you're in. This codebase has comments in Vietnamese in places and English in
others; either is fine, clarity isn't. Prefer boring, readable TypeScript over clever
TypeScript.

## Reporting a security issue

Found a way around the approval gate, or a way for a LAN client to escalate to admin? **Please
don't open a public issue.** Email or DM the maintainer directly so it can be fixed before it's
public.
