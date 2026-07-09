#!/usr/bin/env python3
"""PreToolUse hook (Bash): chặn `git commit` có trailer ghi công Claude/Anthropic.

Người dùng repo bow-agent KHÔNG muốn commit dính dòng
`Co-Authored-By: Claude ...`. Hệ thống prompt mặc định của harness lại buộc thêm
dòng này, và chỉ mình memory không đủ mạnh để chặn — nên có hook chống lưng.

Cách hoạt động: đọc JSON PreToolUse từ stdin; nếu là lệnh Bash chứa `git commit`
và trong command có trailer ghi công Claude/Anthropic → exit 2 để CHẶN, kèm lời
nhắc trên stderr để Claude viết lại commit KHÔNG có dòng đó.

Chỉ nhắm đúng dòng trailer "Co-Authored-By: <ai đó là Claude/Anthropic>", nên
nội dung kỹ thuật có chữ "claude" (vd .claude/, claude-opus-4-8) không bị vạ lây.
Xem memory: no-claude-coauthor-trailer.
"""
import json
import re
import sys

# Dòng trailer ghi công Claude/Anthropic — bắt cả biến thể có "(1M context)",
# email noreply@anthropic.com, hay tên model claude-*.
TRAILER = re.compile(
    r"(?im)^\s*co-authored-by:\s*.*(claude|anthropic|noreply@anthropic\.com)"
)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0  # Không parse được input → không chặn, để harness xử lý bình thường.

    if payload.get("tool_name") != "Bash":
        return 0

    command = (payload.get("tool_input") or {}).get("command", "")
    if not command:
        return 0

    # Chỉ soi các lệnh liên quan tới việc tạo commit.
    if "git commit" not in command and "git merge" not in command:
        return 0

    if TRAILER.search(command):
        sys.stderr.write(
            "CHẶN: commit message chứa trailer 'Co-Authored-By: Claude/Anthropic'. "
            "Người dùng repo bow-agent không muốn commit dính dòng này "
            "(xem memory no-claude-coauthor-trailer). "
            "Hãy viết lại commit message BỎ HẲN dòng Co-Authored-By đó rồi chạy lại.\n"
        )
        return 2  # exit 2 = chặn tool + đưa stderr cho Claude đọc.

    return 0


if __name__ == "__main__":
    sys.exit(main())
