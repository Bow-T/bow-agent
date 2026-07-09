---
name: user-command-style
description: "Văn phong ra lệnh của user — câu ngắn, ẩn chủ ngữ, thường kèm lý do ngắn; tín hiệu 'hay dùng' = nên tự động hóa"
metadata:
  node_type: memory
  type: feedback
---

User ra lệnh theo phong cách ngắn, ẩn chủ ngữ, thường kèm một lý do ngắn ở cuối.
Ví dụ thật: "commit/push đi, do tôi hay dùng"; "gợi ý cụm từ hay dùng nữa nhé.
học hỏi"; "làm gọn lại".

**Why:** Hiểu đúng ý ngay từ câu ngắn giúp giảm hỏi lại, khớp với kỳ vọng user
là mình chủ động đề xuất và tự cấu hình.

**How to apply:**
1. Diễn giải lệnh ngắn thành hành động cụ thể thay vì hỏi lại điều hiển nhiên;
   chỉ dùng AskUserQuestion cho quyết định thật sự mơ hồ (nhiều nghĩa khác nhau).
2. Coi "tôi hay dùng" / "hay làm" là tín hiệu nên dựng hook / slash command /
   memory chứ không chỉ làm một lần.
3. Chủ động đề xuất và tự cấu hình bằng skill phù hợp, rồi báo lại ngắn gọn.

Đã áp dụng: bật Stop hook nhắc commit/push trong `.claude/settings.json` (chỉ
nhắc, không tự chạy git).

Related: [[working-style-agent-delegation]], [[user-communicates-in-vietnamese]].
