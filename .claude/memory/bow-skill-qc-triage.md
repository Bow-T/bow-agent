# Skill /qc-triage — QC chấm loại ticket

Nguồn: repo GitHub `Bow-T/bow-skill-core` (skill CORE, luôn tự tải). Bow clone core về
`~/.bow/skills-cache/core@<ref>` rồi trải `qc-triage/` sang `.claude/skills/qc-triage/`
lúc runtime qua `deployCoreSkills` (STAMP `.bow-core`), thư mục runtime bị gitignore.
(Trước đây bundle nội bộ ở `skills/agent-skills/` + `deployBundledSkills`; đã gỡ khi
bow-agent thành khung rỗng — skill tải hết từ GitHub.)

Chức năng: nhận 1 ticket (key/URL Jira), đọc issue type + description + comment
(+ ảnh/video khi mơ hồ, dùng /watch cho video), suy luận loại ĐÚNG theo bảng chuẩn
Bug/Task/Story/Improvement/Sub-task, in báo cáo đúng/sai + loại đề xuất + lý do bám
bằng chứng + độ tin cậy. CHỈ đọc + báo cáo, KHÔNG sửa Jira (bow chỉ bật jira tool đọc:
jira_get_issue / jira_get_comments / jira_search_issues).

Quyết định thiết kế của user: suy luận tự động (không cần bảng quy ước riêng), phạm vi
1 ticket, chỉ báo cáo (không auto-fix). Muốn mở rộng: chạy hàng loạt qua jira_search_issues,
hoặc chế độ soạn sẵn comment để copy.
