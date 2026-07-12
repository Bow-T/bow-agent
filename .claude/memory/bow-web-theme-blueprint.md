---
name: bow-web-theme-blueprint
description: Web có 4 theme nền (light/dark/blueprint/brutal) tách khỏi 7 màu accent; nút header xoay vòng
metadata:
  type: project
---

Web (React thuần + CSS token) có **hai trục độc lập**:

- **Theme nền** = `<html data-theme>`, 4 giá trị: `light` (giấy da), `dark` (mực đêm
  đài quan sát), `blueprint` (chàm-xanh bản vẽ kỹ thuật, accent cyan), `brutal` (Neo
  Brutalism — nền kem chói, viền đen dày, bóng cứng, góc vuông, accent vàng). Định nghĩa ở
  [web/styles.css](web/styles.css) mỗi theme một block `[data-theme='…']` khai đủ token
  `--bg/--surface/--ink/--brass/--grain…`. Theme "nghịch chất" như `brutal` phải ghi đè
  THÊM cả token hình dạng: `--r`/`--r-lg` (góc vuông = 0), `--depth` (bóng cứng offset,
  không blur), `--bd-thin` (viền dày lên) + `--hairline` (màu viền), `--glow-a/b`+`--grain`
  về `transparent/none` (bỏ glow & hạt film) — không chỉ đổi màu.
- **Accent** = `<html data-accent>`, 7 màu nhấn (brass mặc định + 6 màu), CHỒNG lên theme,
  chỉ ghi đè token nhấn. Blueprint (nền tối) dùng chung sắc DARK của accent — selector gộp
  `[data-theme='dark'][data-accent='X'], [data-theme='blueprint'][data-accent='X']`.

**Thêm theme nền thứ N cần đụng 3 chỗ:**
1. [web/styles.css](web/styles.css): block `[data-theme='…']` + block nhuốm accent
   `[data-theme='…'][data-accent]`.
2. [web/App.tsx](web/App.tsx): thêm vào `type Theme` và mảng `THEME_CYCLE` (nút header xoay
   vòng theo mảng này); lưu ở `localStorage['bow-theme']`.
3. [web/Icon.tsx](web/Icon.tsx): import + map icon cho theme mới trong `ICONS` (vd `brutal: Box1`);
   App.tsx chọn tên icon nút header theo `next` theme.
4. [web/NeuralBrain.tsx](web/NeuralBrain.tsx): canvas galaxy tự đọc `--brass` nên accent tự
   đúng, NHƯNG nền vẽ tay theo `theme`: `isLight = theme === 'light' || theme === 'brutal'`
   (theme nền SÁNG mới PHẢI thêm vào `isLight`, nếu không sẽ vẽ nền vũ trụ tối), rồi thêm
   nhánh nền riêng (vd `isBrutal`) cho theme mới.

**Chi tiết theme `brutal` (poster Neo Brutalism, khớp mẫu landing của user):** 3 màu NÓNG
(vàng `#ffcf24` accent + đỏ-hồng `#ff5a5a` → `--danger` + tím lavender `#b8a4ff` → `--teal`),
viền đen 3px (`--bd-thin`), bóng cứng 8px (`--depth: 8px 8px 0 0 #0a0a0a`). Hai override NGOÀI
block token, đặt ở cuối [web/styles.css](web/styles.css):
- **Nền chấm bi**: `[data-theme='brutal'] .app { background-image: radial-gradient(...) }` —
  ghi đè background-image mặc định (hạt film + lưới kẻ) thành dot grid.
- **Nút "lún theo bóng"** + heading in hoa: block `[data-theme='brutal'] .btn.primary/run/allow/
  stop/deny + .theme-btn` ép `box-shadow: var(--depth) !important` (thắng bóng blur mặc định của
  `.btn.run/allow`), hover dịch `translate(2px,2px)` + bóng co, active dán sát. Nút thật tên
  `.btn` + biến thể `.btn.primary/.run/.allow/.stop/.deny` (KHÔNG phải `.btn-primary`).
User đã CHỐT: không làm marquee chạy + khối trang trí nghiêng (đụng layout) — chỉ token + polish.

Build web: `npm run ui:build` (Vite → dist-web/). Dev: `npm run ui`.
Liên quan: [[user-communicates-in-vietnamese]].
