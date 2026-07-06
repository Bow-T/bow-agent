#!/usr/bin/env bash
# .claude/hooks/self-verify-rubric.sh — Claude Code Stop hook.
#
# Backstops the bow-commit SKILL step "4b. Self-verify the quest checklist".
# That step depends on Claude remembering to fill the rubric; this hook makes the
# harness re-surface the auto-evaluated checklist whenever a turn ENDS with new
# commits on a feature branch that haven't been pushed yet — the exact moment the
# rubric matters and is easy to skip.
#
# It does NOT block (Stop hooks shouldn't trap the user). It prints the freshly
# evaluated checklist + a reminder to stderr so it lands in the transcript, then
# exits 0. Silent (exit 0, no output) when there's nothing to verify.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$root" 2>/dev/null || exit 0

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
# Only on feature branches — never nag on protected branches (nothing to commit there).
case "$branch" in
  ""|develop|main|master|dev|HEAD) exit 0 ;;
esac

# Are there commits ahead of origin/develop that are not yet on the remote branch?
ahead=$(git rev-list --count "origin/develop..HEAD" 2>/dev/null || echo "0")
[[ "$ahead" =~ ^[0-9]+$ ]] || ahead=0
[[ "$ahead" -gt 0 ]] || exit 0

# If the local branch tip is already on its remote (pushed), don't nag.
remote_tip=$(git rev-parse "origin/$branch" 2>/dev/null || echo "")
local_tip=$(git rev-parse HEAD 2>/dev/null || echo "")
[[ -n "$remote_tip" && "$remote_tip" == "$local_tip" ]] && exit 0

# Surface the auto-evaluated rubric so Claude/the user can self-verify before push.
if [[ -x "$root/scripts/quest-checklist.sh" ]]; then
  echo "🐙 Stop hook — $ahead unpushed commit(s) on '$branch'. Self-verify the quest rubric before pushing (SKILL step 4b):" >&2
  bash "$root/scripts/quest-checklist.sh" 2>/dev/null >&2 || true
fi
exit 0
