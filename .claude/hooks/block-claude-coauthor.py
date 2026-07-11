#!/usr/bin/env python3
"""PreToolUse hook (Bash): chặn `git commit` có dòng ghi công Claude/Anthropic.

Người dùng repo bow-agent KHÔNG muốn commit dính dòng ghi công Claude — cả
`Co-Authored-By: Claude ...` LẪN footer `🤖 Generated with [Claude Code](...)`.
Hệ thống prompt mặc định của harness lại buộc thêm các dòng này, và chỉ mình
memory không đủ mạnh để chặn — nên có hook chống lưng.

Cách hoạt động: đọc JSON PreToolUse từ stdin; nếu là lệnh Bash chứa `git commit`
và trong command có bất kỳ dòng ghi công nào → exit 2 để CHẶN, kèm lời nhắc trên
stderr để Claude viết lại commit KHÔNG có dòng đó.

Chỉ nhắm đúng các dòng ghi công cụ thể (trailer Co-Authored-By, footer
"Generated with Claude Code", link claude.com/claude-code), nên nội dung kỹ
thuật có chữ "claude" (vd .claude/, claude-opus-4-8) không bị vạ lây.
Xem memory: no-claude-coauthor-trailer.
"""
import json
import re
import sys

# Các dòng ghi công Claude/Anthropic bị cấm trong commit message:
# 1. Trailer "Co-Authored-By: Claude ..." — bắt cả biến thể "(1M context)",
#    email noreply@anthropic.com, hay tên model claude-*.
# 2. Footer "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
#    và biến thể — bắt qua cụm "Generated with ... Claude Code" hoặc link
#    claude.com/claude-code / claude.ai/code.
CREDIT_LINES = re.compile(
    r"(?im)"
    r"^\s*co-authored-by:\s*.*(claude|anthropic|noreply@anthropic\.com)"  # trailer
    r"|generated with\s+\[?claude\s*code"  # footer "Generated with Claude Code"
    r"|claude\.(?:com|ai)/(?:claude-code|code)"  # link ghi công Claude Code
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

    if CREDIT_LINES.search(command):
        sys.stderr.write(
            "CHẶN: commit message chứa dòng ghi công Claude/Anthropic "
            "(trailer 'Co-Authored-By: Claude' hoặc footer 'Generated with Claude Code'). "
            "Người dùng repo bow-agent không muốn commit dính dòng này "
            "(xem memory no-claude-coauthor-trailer). "
            "Hãy viết lại commit message BỎ HẲN các dòng ghi công đó rồi chạy lại.\n"
        )
        return 2  # exit 2 = chặn tool + đưa stderr cho Claude đọc.

    return 0


if __name__ == "__main__":
    sys.exit(main())
