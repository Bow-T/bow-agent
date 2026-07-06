#!/usr/bin/env bash
# .claude/hooks/guard-push.sh — Claude Code PreToolUse(Bash) hook.
#
# Belt-and-suspenders for the .githooks/pre-push gate: if Claude is about
# to run `git push`, scan the branch diff with the quest scanner first and
# BLOCK the tool call on failure (exit 2). This protects the case where
# core.hooksPath hasn't been wired on a fresh machine yet — important here
# because pushing can auto-merge into develop.
#
# Only acts on `git push`; every other Bash command passes through (exit 0).
set -uo pipefail

input=$(cat)

# Pull the command field out of the PreToolUse payload (best-effort).
cmd=$(printf '%s' "$input" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null || true)

# Gate real pushes only; honour an explicit --no-verify override.
case "$cmd" in
  *"git push"*) : ;;
  *) exit 0 ;;
esac
case "$cmd" in
  *"--no-verify"*) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
if [[ -x "$root/scripts/check-quest.sh" ]]; then
  if ! bash "$root/scripts/check-quest.sh" --branch >&2; then
    echo "❌ Push blocked by quest gate (check-quest.sh --branch). Fix the findings above before pushing." >&2
    exit 2
  fi
fi
exit 0
