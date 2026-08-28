#!/usr/bin/env python3
"""SessionStart hook — nạp lại .claude/session-notes.md vào context phiên mới / sau compact.

Bù cho phần tóm tắt bị mất khi context bị dọn: bản ghi nguyên văn của việc đang làm dở.
Không nạp khi source = "clear" (người dùng cố ý xoá sạch).
"""
import json, os, sys

MAX_CHARS = 6000

def main():
    try:
        ev = json.load(sys.stdin)
    except Exception:
        ev = {}
    if (ev.get("source") or "") == "clear":
        return 0

    cwd = ev.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    notes = os.path.join(cwd, ".claude", "session-notes.md")
    if not os.path.exists(notes):
        return 0
    body = open(notes, errors="replace").read().strip()
    if not body:
        return 0
    if len(body) > MAX_CHARS:
        body = body[:MAX_CHARS] + "\n…(cắt bớt — đọc đầy đủ ở .claude/session-notes.md)"

    ctx = (
        "Sổ tay phiên trước (ghi tự động trước khi context bị dọn). Dùng để nối lại việc đang "
        "làm dở; nếu mâu thuẫn với code hiện tại thì tin code.\n\n" + body
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": ctx,
        }
    }))
    return 0

if __name__ == "__main__":
    sys.exit(main())
