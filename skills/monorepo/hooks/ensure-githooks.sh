#!/usr/bin/env bash
# .claude/hooks/ensure-githooks.sh — Claude Code SessionStart hook.
#
# Wires this clone to the shared, committed git hooks in .githooks/ so
# the pre-commit / pre-push quest gates are active for anyone who opens
# the repo with Claude — no manual `git config` step required.
#
# Idempotent: only writes the config when it isn't already pointing at
# .githooks. Never fails the session (always exits 0).
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$root" 2>/dev/null || exit 0

current=$(git config --local --get core.hooksPath 2>/dev/null || echo "")
if [[ "$current" != ".githooks" && -d "$root/.githooks" ]]; then
  if git config --local core.hooksPath .githooks 2>/dev/null; then
    echo "🐙 Wired core.hooksPath → .githooks (pre-commit/pre-push quest gates now active)."
  fi
fi
exit 0
