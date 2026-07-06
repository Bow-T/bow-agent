---
name: bow-lean
description: Viết ít code nhất có thể mà KHÔNG hy sinh correctness/security — leo "decision ladder" (có cần không → reuse → stdlib → native → dep sẵn có → one-liner → mới viết tối thiểu) TRƯỚC khi gõ code. Dùng khi sắp thêm code/thư viện/abstraction mới, khi thấy mình định copy logic, wrap helper thừa, hoặc tự viết lại thứ stdlib/SDK đã có. Nâng metric du-quest Codebase Impact (ưu tiên xóa, tỉ lệ deletions/(add+del) mục tiêu 0.2–0.6). Pairs với [[impact-sweep]] và skill code-simplification.
---

# Bow Lean — "lazy senior dev": code tốt nhất là code không phải viết

> Adapt từ triết lý [ponytail](https://github.com/DietrichGebert/ponytail) (YAGNI /
> "lazy senior developer") cho ngữ cảnh <PROJECT_KEY> (Flutter + Supabase). Khác với
> [code-simplification] (dọn code ĐÃ viết cho dễ đọc), skill này chặn **TRƯỚC khi
> gõ**: cân nhắc có cần viết không, và viết bằng cách rẻ nhất.

"Lười" ở đây là đức tính khi nó nghĩa là **tránh việc thừa**, không phải cẩu thả.
Diff nhỏ nhất mà vẫn đúng sẽ thắng. Việc này khớp thẳng với 2 thứ dự án đang chấm
điểm: `common.md` ("grep first, reuse/extract"; "dùng stdlib thay vì tự viết lại";
"đừng wrap helper chỉ để đổi 1 default arg") và metric **Codebase Impact** trong
`.claude/CLAUDE.md` (ưu tiên xóa, `deletions/(additions+deletions)` ∈ [0.2, 0.6]).

## Khi nào dùng
- Sắp thêm code, thư viện, abstraction, config, hoặc file mới.
- Thấy mình định copy–paste một khối logic sang chỗ khác.
- Định tự viết format/parse/validate mà `Intl` / stdlib Dart / SDK đã có.
- Định thêm 1 `pub` package mới cho một nhu cầu nhỏ.
- Đang fix bug và định vá ở từng call-site.

**KHÔNG dùng để:** cắt validation, error-handling, RLS/security, accessibility,
hay yêu cầu người dùng nêu rõ (xem "Ngoại lệ bất khả xâm phạm" bên dưới). Không
dùng để rewrite throwaway code cho gọn.

## Decision Ladder — leo từng bậc TRƯỚC khi viết
Dừng ở bậc thấp nhất giải quyết được vấn đề:

1. **Có cần không? (YAGNI)** — Task/nhánh code này có thật sự cần tồn tại? Cắt được
   yêu cầu thừa (thêm 1 lựa chọn UI chưa ai dùng, 1 config chưa ai đọc) thì cắt.
2. **Reuse trong repo?** — `grep -rln "<khái-niệm-peer>" apps/ packages/ supabase/`
   trước. <PROJECT_KEY> có nhà sẵn cho nhiều concern: đọc `.env`/config → `AppBaseUrl`
   (đừng đẻ class `Env` mới); enum/status/formatter/localizer/model converter/icon
   resolver → tìm 1 peer rồi thêm cạnh nó. (xem [[app-base-url-single-env-reader]],
   [[impact-sweep]] mục 0).
3. **Stdlib / framework có sẵn?** — `Intl.NumberFormat`/`DateFormat`, `int.tryParse`,
   `collection` helpers, Dart `Iterable`/`Set` ops, các Utilities converters của
   project. Đừng tự viết lại parse ngày, format tiền, dedupe list.
4. **Feature native của nền tảng?** — Widget Flutter có sẵn (`ListView.separated`,
   `InputDecoration`, `TextInputFormatter`) thay cho custom; Postgres/RLS/`CHECK`/
   generated column thay cho logic app; SQL `on conflict`/`coalesce` thay cho vòng
   lặp thủ công.
5. **Dep đã cài rồi?** — Trước khi `pub add`, xem `pubspec.yaml` / `package.json`:
   thứ cần có thể đã nằm trong package hiện có (dio, freezed, riverpod, intl…).
6. **One-liner được không?** — Nếu một biểu thức gọn giải quyết được, đừng dựng
   hàm/lớp quanh nó.
7. **Mới viết bản tối thiểu** — Chỉ tới đây mới viết, và viết đúng phần nhỏ nhất chạy được.

## Luật
- **Không abstraction đầu cơ** — không interface/factory/generic/config cho đúng 1
  chỗ dùng. Trừu tượng hóa khi có **≥2** call-site thật, không phải "phòng khi sau này".
- **Ưu tiên xóa** — bỏ 1 khối code thừa quý hơn thêm 1 khối mới; nó cũng kéo
  Codebase Impact về vùng mục tiêu.
- **Hiểu trước đã** — đọc hết vùng bị ảnh hưởng rồi mới tối giản; đừng cắt cái bạn
  chưa hiểu.
- **Fix bug tại gốc, không vá triệu chứng** — vá ở **hàm/trigger dùng chung một
  lần** là diff nhỏ hơn vá từng caller. "Thay đổi nhỏ nhất đặt sai chỗ không phải là
  lười — đó là con bug thứ hai." (Ghép với [[impact-sweep]] để chắc đã quét hết
  sibling call-site.)
- **Không wrap chỉ để đổi 1 default** — gọi thẳng helper gốc.

## Ngoại lệ bất khả xâm phạm (TUYỆT ĐỐI không "tối giản" đi)
- **Validation ở biên tin cậy** — route param, API/Supabase payload, dữ liệu client
  gửi lên (đặc biệt tiền/giảm giá → phải server-side/`CHECK`, xem [[verify-runtime-not-just-static-green]]).
- **Error handling chống mất dữ liệu** — side-effect sau mutation chính bọc `try/catch`.
- **Security / RLS / CORS** — không nới lỏng để cho gọn.
- **Accessibility** và **yêu cầu người dùng nêu rõ**.
- **Một kiểm chứng chạy được cho logic không tầm thường** — 1 test/assert nhỏ nhất
  sẽ fail nếu logic hỏng (khớp Test Discipline; xem [[test-driven-development]]).

## Đánh dấu shortcut cố ý
Khi cố tình đơn giản hóa và có trần hiệu năng/đường nâng cấp, để lại comment `ponytail:`
(hoặc `bow:`) nêu rõ trade-off — để người sau biết đây là lựa chọn, không phải sót:
```dart
// ponytail: khóa toàn cục cho counter; tách khóa theo account nếu throughput thành vấn đề
```

## Output
Code trước. Sau đó tối đa 1–3 dòng nêu **đã bỏ qua gì và khi nào nên thêm lại**. Nếu
lời giải thích dài hơn code, xóa lời giải thích. Với thay đổi Contract/Cross-cutting,
vẫn chạy checklist [[impact-sweep]] và audit runtime trước khi tuyên bố "done".

## Mức độ (nếu người dùng nêu)
- **Lite** — làm đúng yêu cầu, chỉ *gợi ý* phương án gọn hơn.
- **Full** (mặc định) — áp decision ladder, diff ngắn nhất thắng.
- **Ultra** — YAGNI cực đoan: chất vấn cả yêu cầu thừa trước khi code.
