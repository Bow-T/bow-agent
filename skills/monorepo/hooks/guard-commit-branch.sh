#!/usr/bin/env bash
# .claude/hooks/guard-commit-branch.sh — Claude Code PreToolUse(Bash) hook.
#
# docs/conventions/common.md (Branches & push) forbids committing directly to
# dev/main/master. Claude has to remember this every time; this hook makes it a
# hard rail. If Claude is about to run `git commit` while HEAD is on a protected
# branch, BLOCK the tool call (exit 2) and tell it to branch first.
#
# Only acts on `git commit`; honours an explicit --no-verify override and lets
# every other Bash command pass through (exit 0). Never blocks on `git commit`
# that is clearly creating nothing (the real git hook is the deterministic
# backstop — this is the early, Claude-facing nudge).
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null || true)

# Gate real commits only.
case "$cmd" in
  *"git commit"*) : ;;
  *) exit 0 ;;
esac
# Respect an explicit override and ignore non-mutating commit subcommands.
case "$cmd" in
  *"--no-verify"*|*"--dry-run"*) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

case "$branch" in
  develop|main|master|dev)
    echo "❌ Commit blocked: you are on protected branch '$branch'." >&2
    echo "   DUOCT convention forbids committing to dev/main/develop directly." >&2
    echo "   Create a feature branch first, e.g.:" >&2
    echo "     git checkout -b feat/DUOCT-XXX-short-kebab" >&2
    echo "   then re-run the commit." >&2
    exit 2
    ;;
esac
exit 0
