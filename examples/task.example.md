# Đề tài / WBS mẫu cho bow-agent

Đây là file WBS/đề tài mẫu. Truyền cho agent bằng:

    bow-agent run --wbs ./examples/task.example.md

---

## Mục tiêu

Thêm nút "Copy mã đơn hàng" vào màn hình chi tiết đơn hàng, khi bấm sẽ copy mã
đơn vào clipboard và hiện toast "Đã copy".

## Acceptance Criteria

- AC1: Nút hiển thị cạnh mã đơn hàng ở đầu màn hình chi tiết.
- AC2: Bấm nút → copy mã đơn (dạng chuỗi) vào clipboard hệ thống.
- AC3: Sau khi copy → hiện toast/snackbar "Đã copy" trong ~2 giây.
- AC4: Nút có vùng chạm đủ lớn (≥ 44x44) và có trạng thái nhấn.

## Ghi chú kỹ thuật

- Ưu tiên tái sử dụng component nút / toast đã có trong dự án (grep trước khi tự viết).
- Không thêm dependency mới nếu clipboard đã có sẵn trong stack.
