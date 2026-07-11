---
name: no-claude-coauthor-trailer
description: User không muốn trailer ghi công Claude (Co-Authored-By VÀ "Generated with Claude Code") trong git commit
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ba67154e-17de-47f5-8fe4-69f9fd4d20e6
---

Không bao giờ thêm dòng `Co-Authored-By: Claude ...`, `🤖 Generated with Claude Code`, hay bất kỳ trailer/footer nào ghi công Claude vào commit message trong repo bow-agent.

**Why:** Người dùng không muốn commit "dính Claude" — bị nhắc rõ ràng sau khi một commit đã push kèm trailer này.

**How to apply:** Khi tạo commit, viết message KHÔNG có trailer `Co-Authored-By: Claude` VÀ không có footer `Generated with Claude Code`. Đây ngược với hướng dẫn mặc định của harness (vốn bảo thêm) — ưu tiên yêu cầu này của người dùng. Nội dung kỹ thuật có chữ "claude" (vd `.claude.json`, `.claude/skills/`) thì vẫn giữ, chỉ bỏ dòng trailer/footer ghi công. **Body PR trên GitHub** thì user chưa cấm footer Generated (yêu cầu chỉ nhắm commit của nhánh) — nhưng để nhất quán, khi user đã nêu thì bỏ luôn ở cả PR mới.

**Chống lưng bằng hook:** đã có hook `PreToolUse(Bash)` tại `.claude/hooks/block-claude-coauthor.py` (đăng ký trong `.claude/settings.json`) tự CHẶN mọi `git commit`/`git merge` có trailer `Co-Authored-By: ...Claude/Anthropic`. Nếu bị chặn (exit 2), viết lại message bỏ hẳn dòng đó rồi commit lại — đừng tìm cách lách hook.
