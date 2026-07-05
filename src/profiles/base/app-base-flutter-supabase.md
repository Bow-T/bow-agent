# Base Source chuẩn — Ứng dụng Flutter + Supabase (app-base)

> **Đây là CHUẨN dựng app của team, không phải mô tả một repo cụ thể.** Mọi dự án mới
> theo khuôn này dùng chung profile để phát triển nhanh, đồng nhất. Khi thực tế repo
> mâu thuẫn với một mục ở đây → **tin repo**, và cân nhắc cập nhật lại chuẩn này.

Stack chuẩn: **Flutter** (mobile) · **Supabase** (backend/DB/auth) · **Stripe** (thanh
toán) · **Jira** (task) · **Mapbox** (bản đồ/định vị). Monorepo quản bằng **turbo + bun**.

---

## 1. Cấu trúc & tổ chức code (Flutter app)

```
apps/<app>/lib/
  <app>_app.dart          # widget gốc app
  router/app_router.dart  # AutoRoute (code-gen) — KHÔNG khai route thủ công
  src/
    base/                 # base_vm.dart (getter DI), base class dùng chung
    pages/                # màn hình theo feature: <feature>/pages/, <feature>/vm/
    components/           # widget tái sử dụng (button, dialog, input, snack_bar…)
    models/               # @JsonSerializable model — KHÔNG viết fromJson/toJson tay
    services/             # gọi API/Supabase, mỗi service 1 nhóm nghiệp vụ
    utils/locator.dart    # get_it — đăng ký DI trong setUpInjector()
    l10n/                 # đa ngôn ngữ (EN/… ) — mọi chuỗi hiển thị qua l10n
    themes/, constants/, resources/
```

**Nguyên tắc**: ưu tiên **tái sử dụng component sẵn có** trong `components/`; feature mới =
lắp ráp component + service có sẵn trước khi viết mới. Trước khi tạo màn/logic mới, tìm
xem đã có "peer" gần giống chưa (thường có) rồi mirror theo.

## 2. State management & DI

- **DI qua `get_it`** (`locator.dart`), expose cho ViewModel qua **getter trong `base_vm.dart`**.
- State qua **`provider` / `ChangeNotifier`** (ViewModel là `ChangeNotifier`).
- ⚠️ **Thêm một service mới phải cập nhật ĐỦ 3 nơi** (thiếu 1 là bug lặng):
  1. `registerLazySingleton(() => XxxService())` trong `utils/locator.dart`
  2. getter `xxxService` trong `base/base_vm.dart`
  3. ViewModel gọi qua getter đó (bọc trong runGuarded/state machine nếu có)

## 3. Routing — AutoRoute (code-gen)

- Repo dùng **AutoRoute**: route sinh tự động ra `app_router.gr.dart`.
- Thêm màn mới → thêm `AutoRoute(page: XxxRoute.page)` vào `app_router.dart` → **chạy
  `build_runner` để regen `.gr.dart`**. KHÔNG sửa tay file `.gr.dart`, KHÔNG khai route thủ công.

## 4. Model & code-gen

- Model dùng **`@JsonSerializable`** → chạy `build_runner` sinh `.g.dart`.
- **KHÔNG bao giờ tự viết `fromJson`/`toJson`** hay sửa file `.g.dart` — luôn regen.
- Lệnh regen (chạy trong thư mục app): `fvm dart run build_runner build --delete-conflicting-outputs`.

## 5. Supabase (backend)

- DB/Auth/Storage qua Supabase. Query đặt trong `services/` (hoặc `*_queries`), không rải trong UI.
- **RLS là bắt buộc**: thêm bảng/cột mới phải kèm **RLS policy** — quên là lỗ bảo mật.
- Đổi schema → **migration** (không sửa DB tay trên dashboard). Migration kèm cả policy.
- Trước khi đổi schema: `list_tables` để hiểu cấu trúc; sau khi đổi: sinh lại types.

## 6. Stripe (thanh toán)

- Xử lý thanh toán nhạy cảm → **logic tính tiền/tạo charge nằm ở backend** (Supabase Edge
  Function / server), client chỉ khởi tạo PaymentSheet với clientSecret. **Không** đặt
  secret key ở client.
- Test bằng Stripe test mode + thẻ test; không hardcode key — đọc từ env/config.

## 7. Mapbox (bản đồ/định vị)

- Access token đọc từ env/config, **không hardcode** trong source.
- Quyền vị trí (location permission) phải xin đúng vòng đời + xử lý case người dùng từ chối.

## 8. Jira & quy trình

- Task đến từ Jira (ticket/board). Đọc kỹ issue + comment + Acceptance Criteria trước khi làm.
- Theo **plan-then-approve**: lập kế hoạch, xin duyệt, mới thực thi. Không commit/push/apply
  migration khi chưa được yêu cầu rõ.

## 9. Đa ngôn ngữ (l10n)

- **Mọi chuỗi hiển thị cho người dùng phải qua l10n**, không hardcode text trong widget.
- Thêm chuỗi mới → thêm vào file l10n (đủ mọi ngôn ngữ đang hỗ trợ) rồi dùng key.

## 10. Kiểm chứng (Definition of Done)

- `fvm flutter analyze` sạch + `fvm flutter test` (test cho hành vi mới).
- Với thay đổi cross-cutting (service/schema/enum) → **quét đủ call-site**, trace runtime,
  không nói "xong" khi mới compile pass.
- Đổi schema → chạy migration + regen types; đổi route/model → regen `build_runner`.

---

## Bẫy hay gặp (checklist nhanh)

- [ ] Thêm service mà **quên 1 trong 3 nơi** (locator / base_vm / VM) → DI lỗi lặng.
- [ ] Thêm route/model mà **quên regen** `.gr.dart` / `.g.dart` → build fail.
- [ ] Thêm bảng/cột mà **quên RLS policy** → dữ liệu lộ.
- [ ] Hardcode chuỗi thay vì l10n; hardcode Stripe/Mapbox key thay vì env.
- [ ] Viết logic mới trong khi **đã có component/peer sẵn** để tái sử dụng.
