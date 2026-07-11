# Memory Index

- [Working style — cách giao việc](working-style-agent-delegation.md) — mặc định 1 agent, giao gom 1 lượt, plan mode; chỉ bung subagent cho việc lớn kiểm chứng được
- [Văn phong ra lệnh](user-command-style.md) — lệnh ngắn ẩn chủ ngữ kèm lý do; "hay dùng" = tín hiệu nên tự động hóa (hook/command)
- [Ngôn ngữ](user-communicates-in-vietnamese.md) — user trao đổi bằng tiếng Việt, trả lời bằng tiếng Việt
- [Không dính Co-Authored-By Claude trong commit](no-claude-coauthor-trailer.md) — commit message không kèm trailer ghi công Claude; có hook .claude/hooks/block-claude-coauthor.py chặn tự động
- [Safe Mode chia sẻ hỏi đáp (QC/BA/PM)](bow-safe-mode-qc.md) — npm run ui:share: read-only cho người non-dev, ẩn UI kỹ thuật, khoá source, chạy song song dev ở cổng riêng 4001/5174
- [Collab Mode (CTV code có duyệt)](bow-collab-mode.md) — npm run ui:collab (4002/5175): CTV qua LAN code như dev, Git tự do, lệnh hủy hoại phải admin duyệt từ xa qua adminBus + /api/admin/events
- [Skill /qc-triage — chấm loại ticket](bow-skill-qc-triage.md) — đọc 1 ticket Jira, suy luận Bug/Task/Story đúng chưa; chỉ báo cáo, không sửa Jira; bundle skills/agent-skills/
- [Web LAN đen thui do 401 /api/config](bow-lan-config-401-crash.md) — client LAN chưa duyệt 401→setCwd(undefined)→cwd.trim() crash; phải check r.ok, test headless trỏ IP LAN
- [Tự chạy tiếp khi hết hạn mức phiên](bow-auto-resume-session-limit.md) — session limit 5h → server lên lịch tới giờ reset tự resume phiên cũ + prompt "tiếp tục"; chỉ phiên đang thực thi, tối đa 3 lần; UI đếm ngược + nút huỷ; cờ BOW_SIMULATE_SESSION_LIMIT để test
- [MCP riêng theo user](bow-per-user-mcp.md) — /api/my-mcp: user LAN tự quản MCP riêng (overlay lên MCP chung, trùng tên bản riêng thắng), tự áp mọi lần chạy, chạy cả trong Safe/Collab; lưu conversations/user-mcp.json theo user.id
- [MCP chung tách khỏi profile](bow-mcp-split-from-profile.md) — MCP chung lưu ~/.bow-agent/mcp.json cố định (config.mcpConfigPath), seed lần đầu từ ~/.claude.json; đổi acc/profile không mất MCP; login/token vẫn theo profile
