# Skill /qc-triage — QC chấm loại ticket

Bundle: `skills/agent-skills/qc-triage/SKILL.md` (nguồn, track git). Bow tự trải sang
`.claude/skills/qc-triage/` lúc runtime qua deployBundledSkills (STAMP .bow-bundled),
thư mục runtime bị gitignore.

Chức năng: nhận 1 ticket (key/URL Jira), đọc issue type + description + comment
(+ ảnh/video khi mơ hồ, dùng /watch cho video), suy luận loại ĐÚNG theo bảng chuẩn
Bug/Task/Story/Improvement/Sub-task, in báo cáo đúng/sai + loại đề xuất + lý do bám
bằng chứng + độ tin cậy. CHỈ đọc + báo cáo, KHÔNG sửa Jira (bow chỉ bật jira tool đọc:
jira_get_issue / jira_get_comments / jira_search_issues).

Quyết định thiết kế của user: suy luận tự động (không cần bảng quy ước riêng), phạm vi
1 ticket, chỉ báo cáo (không auto-fix). Muốn mở rộng: chạy hàng loạt qua jira_search_issues,
hoặc chế độ soạn sẵn comment để copy.
