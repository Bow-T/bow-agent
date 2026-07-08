---
name: no-claude-coauthor-trailer
description: User does not want the Co-Authored-By Claude trailer in git commits
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ba67154e-17de-47f5-8fe4-69f9fd4d20e6
---

Không bao giờ thêm dòng `Co-Authored-By: Claude ...` (hay bất kỳ trailer nào ghi công Claude) vào commit message trong repo bow-agent.

**Why:** Người dùng không muốn commit "dính Claude" — bị nhắc rõ ràng sau khi một commit đã push kèm trailer này.

**How to apply:** Khi tạo commit, viết message KHÔNG có trailer `Co-Authored-By: Claude`. Lưu ý: đây ngược với hướng dẫn mặc định của harness (vốn bảo thêm trailer) — ưu tiên yêu cầu này của người dùng. Nội dung kỹ thuật có chữ "claude" (vd `.claude.json`, `.claude/skills/`) thì vẫn giữ, chỉ bỏ dòng trailer ghi công.

**Chống lưng bằng hook:** đã có hook `PreToolUse(Bash)` tại `.claude/hooks/block-claude-coauthor.py` (đăng ký trong `.claude/settings.json`) tự CHẶN mọi `git commit`/`git merge` có trailer `Co-Authored-By: ...Claude/Anthropic`. Nếu bị chặn (exit 2), viết lại message bỏ hẳn dòng đó rồi commit lại — đừng tìm cách lách hook.
