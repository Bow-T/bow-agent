# Memory Index

- [Working style — cách giao việc](working-style-agent-delegation.md) — mặc định 1 agent, giao gom 1 lượt, plan mode; chỉ bung subagent cho việc lớn kiểm chứng được
- [Văn phong ra lệnh](user-command-style.md) — lệnh ngắn ẩn chủ ngữ kèm lý do; "hay dùng" = tín hiệu nên tự động hóa (hook/command)
- [Ngôn ngữ](user-communicates-in-vietnamese.md) — user trao đổi bằng tiếng Việt, trả lời bằng tiếng Việt
- [Không dính Co-Authored-By Claude trong commit](no-claude-coauthor-trailer.md) — commit message không kèm trailer ghi công Claude; có hook .claude/hooks/block-claude-coauthor.py chặn tự động
- [QC Mode](bow-qc-mode.md) — npm run ui:qc:share (4001/5174): QC read-only source + tool Skill (qc-triage) + Jira read/write; tự nạp stack qc; ẩn UI kỹ thuật, khoá source. Đổi tên từ "Safe Mode" (BOW_QC_MODE/api/qc-cwd)
- [Collab Mode (CTV code có duyệt)](bow-collab-mode.md) — npm run ui:collab (4002/5175): CTV qua LAN code như dev, nhưng MỌI thao tác GHI của CTV (kể cả Git) phải admin duyệt từ xa qua requireApprovalForWrites + adminBus + /api/admin/events
- [BA Mode (Business Analyst)](bow-ba-mode.md) — npm run ui:ba (4003/5176): ghi TÀI LIỆU (docs/, *.md) + full Jira write, DENY cứng source/DB/deploy; phân quyền theo target path (isDocPath/isJiraTool), không dùng adminBus
- [Reviewer Mode (Tech Lead review PR)](bow-reviewer-mode.md) — npm run ui:review:share (4004/5177): read-only code + review PR GitHub/diff local + comment/approve PR qua gh pr + test + Jira đọc; DENY sửa code/merge/push; tự nạp stack review (bow-skill-review)
- [Skill qc-triage (+ qc-triage-apply)](bow-skill-qc-triage.md) — chấm loại 1 ticket Jira (Bug/Task/Story…); qc-triage chỉ báo cáo, qc-triage-apply ghi comment/transition khi duyệt. ĐÃ DỜI khỏi core sang stack qc (repo bow-skill-qc), tự nạp ở QC Mode
- [bow-agent là KHUNG RỖNG](bow-empty-frame-skills.md) — xóa skills/, skill tải từ GitHub: CORE luôn tải (bow-skill-core) + STACK khi chọn; registry ở ~/.bow-agent/registry.json
- [Web LAN đen thui do 401 /api/config](bow-lan-config-401-crash.md) — client LAN chưa duyệt 401→setCwd(undefined)→cwd.trim() crash; phải check r.ok, test headless trỏ IP LAN
- [Tự chạy tiếp khi hết hạn mức phiên](bow-auto-resume-session-limit.md) — session limit 5h → server lên lịch tới giờ reset tự resume phiên cũ + prompt "tiếp tục"; chỉ phiên đang thực thi, tối đa 3 lần; UI đếm ngược + nút huỷ; cờ BOW_SIMULATE_SESSION_LIMIT để test
- [MCP riêng theo user](bow-per-user-mcp.md) — /api/my-mcp: user LAN tự quản MCP riêng (overlay lên MCP chung, trùng tên bản riêng thắng), tự áp mọi lần chạy, chạy cả trong QC/Collab; lưu conversations/user-mcp.json theo user.id
- [MCP chung tách khỏi profile](bow-mcp-split-from-profile.md) — MCP chung lưu ~/.bow-agent/mcp.json cố định (config.mcpConfigPath), seed lần đầu từ ~/.claude.json; đổi acc/profile không mất MCP; login/token vẫn theo profile
- [3 theme nền web (light/dark/blueprint)](bow-web-theme-blueprint.md) — theme (data-theme) tách khỏi 7 accent (data-accent); thêm theme phải sửa styles.css + THEME_CYCLE trong App.tsx + isLight trong NeuralBrain
- [Đội agent (multi-agent) trên web — chỉ admin](bow-web-subagents-admin.md) — toggle useSubagents ở web nối cờ xuống runAgent (reviewer/verifier/impact-scout); chỉ admin (localhost), gate 2 lớp; runner có sẵn, chỉ nối web
- [Badge trạng thái skill 3 mức](bow-skill-badge-states.md) — cạnh dropdown Stack: ✅ synced / ⚠️ stale (ref cũ hơn registry) / ⬇️ missing; STAMP 2 dòng ghi ref đã trải, so registry local (KHÔNG so remote)
