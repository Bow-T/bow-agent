---
name: bow-skill-qc-triage
description: Skill qc-triage (+ qc-triage-apply) — chấm loại ticket Jira, nay ở stack qc (đã dời khỏi core), nạp tự động ở QC Mode
metadata:
  type: project
---

# Skill /qc-triage — QC chấm loại ticket

**Nguồn (đã đổi):** repo GitHub `Bow-T/bow-skill-qc` — một **STACK** (không còn ở core).
qc-triage được DỜI khỏi `bow-skill-core` (core v1.1.0 chỉ còn `watch`) sang stack `qc` @ v1.0.0.
Bow tải stack qua tag đã ghim vào `~/.bow/skills-cache/qc@<ref>` rồi trải sang
`.claude/skills/` qua `deployExternalSkills` (STAMP `.bow-external`), thư mục runtime gitignore.
Stack `qc` **tự nạp** khi chạy [[bow-qc-mode]] (`effectiveStack = … isQcMode ? 'qc'`).

**Hai skill trong stack:**
- **`qc-triage`**: nhận 1 ticket (key/URL Jira), đọc issue type + description + comment
  (+ ảnh/video khi mơ hồ, dùng /watch cho video), suy luận loại ĐÚNG theo bảng chuẩn
  Bug/Task/Story/Improvement/Sub-task, in báo cáo đúng/sai + loại đề xuất + lý do bám bằng
  chứng + độ tin cậy. **CHỈ đọc + báo cáo**, allowed-tools chỉ có jira read.
- **`qc-triage-apply`** (mới, tận dụng Jira write của QC Mode): chấm loại RỒI, khi user duyệt,
  **post comment kết luận** / đổi issue type / chuyển trạng thái. Luôn hỏi duyệt trước khi ghi;
  độ tin cậy Thấp → chỉ comment câu hỏi, không đổi type. allowed-tools gồm jira_add_comment,
  jira_transition_issue, jira_update_issue, jira_get_transitions + AskUserQuestion.

**Vì sao dời sang stack riêng:** user chọn đổi "Safe Mode" thành QC Mode có bộ skill riêng
(giống [[bow-ba-mode]] nạp stack `ba`) — qc-triage thuộc về QC nên tách khỏi core cho gọn; các
mode khác (dev/Collab/BA) không còn qc-triage. QC Mode mở tool `Skill` (whitelist) + Jira write
để 2 skill này chạy được. Xem [[bow-qc-mode]], [[bow-empty-frame-skills]].

Quyết định thiết kế: suy luận tự động, phạm vi 1 ticket. Muốn mở rộng: chạy hàng loạt qua
jira_search_issues.
