---
name: qc-triage
version: "0.1.0"
description: Chấm xem một Jira ticket có được gán ĐÚNG loại (Bug / Task / Story / Improvement…) hay không. Đọc issue type hiện tại, mô tả, bước tái hiện, comment và ảnh/video đính kèm rồi suy luận loại đúng theo định nghĩa chuẩn, in kết luận (đúng/sai), loại đề xuất, lý do và độ tin cậy. CHỈ báo cáo — không tự sửa Jira.
argument-hint: "<ticket-key-hoặc-URL> (vd DUOCT-2346)"
allowed-tools: Read, Bash, mcp__jira__jira_get_issue, mcp__jira__jira_get_comments
user-invocable: true
---

# /qc-triage — QC chấm loại ticket

Mục tiêu: cho một ticket Jira, trả lời **loại hiện tại có ĐÚNG không** và nếu sai thì **nên là loại gì, vì sao**. Dành cho QC/BA soi từng ticket. Chỉ đọc + báo cáo, **tuyệt đối không** đổi issue type hay post comment lên Jira.

## Đầu vào

Người dùng đưa 1 tham chiếu ticket: key thuần (`DUOCT-2346`) hoặc URL Jira (`https://x.atlassian.net/browse/DUOCT-2346`). Bóc lấy **ticket key** (mẫu `[A-Z][A-Z0-9]+-\d+`). Nếu không có key hợp lệ → hỏi lại người dùng đúng 1 câu, đừng đoán.

## Bước 1 — Lấy dữ liệu ticket

Gọi `mcp__jira__jira_get_issue` với ticket key để lấy: **issue type hiện tại**, summary, description, priority, status, labels, và các custom field mô tả bước tái hiện / kết quả mong đợi nếu có.

Rồi gọi `mcp__jira__jira_get_comments` để lấy trao đổi — comment thường là nơi lộ rõ đây là lỗi (dev/QA tranh luận) hay là yêu cầu thêm việc.

Nếu ticket có ảnh/video đính kèm và bản thân việc phân loại còn mơ hồ sau khi đọc text, xem chúng để quyết:
- Ảnh: `Read` trực tiếp đường dẫn ảnh.
- Video: dùng skill `/watch <url-hoặc-path>` để bóc frame + transcript rồi đọc. Chỉ làm khi cần — đừng tải video nếu text đã đủ kết luận.

## Bước 2 — Suy luận loại ĐÚNG

Đối chiếu nội dung với **định nghĩa chuẩn** dưới đây. Ưu tiên bản chất nội dung hơn nhãn đang gán.

| Loại | Bản chất | Dấu hiệu nhận biết |
|------|----------|--------------------|
| **Bug** | Hệ thống chạy SAI so với kỳ vọng/spec đã có | Có kết quả-mong-đợi ≠ kết quả-thực-tế; từ khóa "lỗi/sai/crash/không hiển thị/trả về sai/bị treo"; có bước tái hiện; ảnh/video cho thấy hành vi sai |
| **Task** | Việc cần làm, không phải tính năng hướng người dùng | "Cấu hình/dựng/nâng cấp thư viện/dọn dẹp/viết script/thêm field vào DB/setup CI"; không có góc "người dùng muốn…" |
| **Story** | Tính năng mới mô tả theo góc người dùng | "Là <vai trò>, tôi muốn <mục tiêu> để <lợi ích>"; mô tả hành vi MỚI chưa từng có (khác Bug: Bug là cái đã có nhưng chạy sai) |
| **Improvement / Enhancement** | Cải tiến cái đang chạy ĐÚNG cho tốt hơn | "Tối ưu/nhanh hơn/gọn hơn/UX tốt hơn"; không phải lỗi, không phải tính năng hoàn toàn mới |
| **Sub-task** | Mảnh việc con của một ticket cha | Có liên kết parent; phạm vi hẹp là một phần của việc lớn |

Ranh giới hay nhầm — phân định dứt khoát:
- **Bug vs Story**: chức năng ĐÃ tồn tại và chạy sai → Bug. Chức năng CHƯA có, ticket yêu cầu tạo mới → Story. (Câu hỏi chốt: "trước ticket này, tính năng đã chạy chưa?")
- **Bug vs Improvement**: chạy sai spec → Bug. Chạy đúng spec nhưng muốn tốt/nhanh/đẹp hơn → Improvement.
- **Task vs Story**: có mô tả được từ góc người-dùng-cuối không? Có → Story. Thuần kỹ thuật/hạ tầng → Task.

Nếu dự án có file quy ước phân loại riêng (vd `docs/qc-*.md`, `.claude/...`), đọc và ưu tiên nó hơn bảng chuẩn trên.

## Bước 3 — Báo cáo (KHÔNG sửa Jira)

In kết luận gọn theo mẫu:

```
🎫 <KEY> — <summary>
Loại hiện tại : <type đang gán>
Kết luận      : ✅ ĐÚNG | ⚠️ SAI | ❓ Chưa chắc
Loại đề xuất  : <type nên gán> (nếu khác loại hiện tại)
Độ tin cậy    : Cao | Trung bình | Thấp
Lý do         : <2–4 gạch đầu dòng bám dữ liệu: trích mô tả/comment/ảnh cụ thể>
Cần làm rõ    : <chỉ ghi khi độ tin cậy Thấp — câu hỏi cần hỏi reporter>
```

Nguyên tắc:
- **Bám bằng chứng**: mỗi lý do phải trích từ mô tả/comment/ảnh thật, không phán chung chung.
- **Thành thật về độ chắc**: thiếu bước tái hiện, mô tả cụt, không rõ tính năng đã có chưa → để "❓ Chưa chắc / Thấp" và nêu câu cần hỏi, đừng gán bừa để trông quyết đoán.
- **Chỉ báo cáo**: không gọi tool ghi Jira, không đổi type, không post comment. Nếu người dùng muốn sửa, nhắc họ tự làm trên Jira (bow chỉ bật tool Jira đọc).
