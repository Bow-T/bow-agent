# Skill: Quy ước code khi chạm vào codebase

Áp dụng khi task yêu cầu thêm/sửa code trong bất kỳ repo nào.

## Trước khi viết code
- Đọc code xung quanh vùng sẽ sửa: nắm naming, cách chia file, idiom, mật độ comment.
  Code mới phải "đọc như code cũ" — không áp phong cách riêng lên repo.
- Ưu tiên tái sử dụng hàm/hằng/tiện ích sẵn có thay vì tự viết lại.

## Khi viết code
- Viết ít code nhất mà vẫn đúng: dùng stdlib, không copy logic > 5 dòng, không tạo
  abstraction đầu cơ, không thêm error-handling cho case không thể xảy ra.
- Chỉ validate ở biên (input người dùng, API ngoài), không rải validate khắp nơi.

## Quét đủ phạm vi (impact sweep)
- Khi đổi signature / enum / status / schema / cột DB dùng nhiều nơi: grep MỌI
  call-site, kể cả getter/switch/allow-list liệt-kê-tay mà grep tên mới không ra.
- "Done" = mọi site xanh + test + runtime, KHÔNG phải chỉ "compile pass".

## Kiểm chứng
- Thay đổi hành vi phải kèm test import code thật, assert hành vi quan sát được.
- Với thay đổi xuyên hệ thống (DB, enum chung, đổi key-format): sau type-check/test
  phải trace luồng end-to-end. Không nói "không có lỗi" cho tới khi soi tầng runtime.
