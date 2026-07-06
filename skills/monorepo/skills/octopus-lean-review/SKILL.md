---
name: octopus-lean-review
description: Rà diff/file để SĂN over-engineering (chỉ complexity, KHÔNG đụng bug/security) — stdlib tự viết lại, dep thừa, abstraction đầu cơ, config chết, logic dài dòng. Xuất mỗi finding một dòng có tag (delete/stdlib/native/yagni/shrink) + "net: -N dòng có thể cắt". Dùng khi người dùng nói "review over-engineering", "cắt được gì", "có bị over-engineer không", "lean review", hoặc trước khi commit muốn xem diff có phình không. Bổ trợ [[octopus-lean]] và code-simplification; bug/security để cho /code-review.
---

# Octopus Lean Review — chỉ săn phức tạp thừa, không săn bug

> Adapt từ `ponytail-review`. Một pass **hẹp và sắc**: tìm code viết ra mà lẽ ra
> không cần. Đây KHÔNG phải code review đầy đủ — **correctness bug, lỗ hổng
> security, và vấn đề hiệu năng đi qua [/code-review] hoặc review thường.** Ở đây
> chỉ đánh vào **độ phức tạp thừa**.

## Khi nào dùng
Người dùng nói: "review over-engineering", "cắt được gì", "có bị over-engineer
không", "lean review", "diff này có phình không", hoặc trước khi octopus-commit
muốn soi diff còn mỡ thừa.

## Phạm vi (đọc trước khi bắt đầu)
- **Chỉ complexity.** Không báo bug/security/perf ở đây — route sang review thường.
- **Không đụng safety tối thiểu.** Một `assert`/1 test nhỏ giữ logic không tầm
  thường là hợp lệ, đừng đòi cắt. Validation ở biên, error-handling chống mất data,
  RLS/CORS — bất khả xâm phạm (xem ngoại lệ trong [[octopus-lean]]).
- **Đọc-thẩm định trước.** Hiểu code làm gì rồi mới đề xuất cắt.

## Cách chạy
1. Lấy diff cần soi: `git diff`, `git diff --staged`, hoặc file người dùng chỉ.
2. Duyệt từng thay đổi, phân loại theo tag dưới đây. Bỏ qua thứ không thuộc phạm vi.
3. Xuất mỗi finding **đúng một dòng**, kèm phương án thay thế cụ thể.
4. Chốt bằng `net: -<N> dòng có thể cắt`. Nếu không có gì để cắt: `Đã gọn. Ship.`

## Format finding
```
<file>:L<dòng>: <tag> <cái gì thừa>. <thay bằng gì>.
```
Cụ thể, không mơ hồ. Ví dụ:
```
delivery_estimate_vm.dart:L42: native: moment-style tự cộng ngày. dùng DateTime.add, 0 dep.
store_profile.dart:L88: yagni: interface StoreRepo có đúng 1 impl. gọi thẳng class.
utils.dart:L15: stdlib: tự viết hàm dedupe list. dùng Set.of(list).toList().
delivery_review_summary.dart:L30: shrink: if/else 6 dòng gán biến. đổi thành ternary 1 dòng.
```

## Tag phân loại
- `delete:` — code không dùng, feature đầu cơ, nhánh dead, config không ai đọc.
- `stdlib:` — tự viết lại thứ thư viện chuẩn Dart/Intl/collection đã có
  (format ngày/tiền, parse số, dedupe, groupBy…).
- `native:` — tái hiện thứ nền tảng đã cho (widget Flutter có sẵn, Postgres
  `CHECK`/`coalesce`/generated column thay logic app), **hoặc** thêm 1 dep mới cho
  việc mà dep-đã-cài / native làm được.
- `yagni:` — abstraction cho đúng 1 chỗ dùng (interface/factory/generic 1 impl),
  config/param không ai set, tham số "phòng xa".
- `shrink:` — logic đúng nhưng dài hơn cần thiết; gom về ít dòng hơn mà vẫn rõ.

## Ghép với pipeline <PROJECT_KEY>
- Cắt code thừa kéo metric **Codebase Impact** (`deletions/(add+del)` → 0.2–0.6)
  về vùng mục tiêu — nêu con số này khi tổng kết nếu liên quan.
- Sau khi người dùng đồng ý cắt, nếu đụng contract/cross-cutting thì chạy
  [[impact-sweep]] để chắc không sót call-site, rồi mới commit.

## Thoát chế độ
"stop lean-review" / "review thường" → quay lại review đầy đủ (có cả bug/security/perf).
