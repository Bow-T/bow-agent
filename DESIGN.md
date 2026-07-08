---
version: alpha
name: Nebula Obsidian
description: A high-fidelity, premium dark-first design system with rich obsidian/slate surfaces, vibrant indigo and cyan glows, Outfit typography, and smooth glassmorphic panels.
colors:
  # Light theme (Slate Prestige)
  primary: "#0f172a"         # slate-900 (ink)
  secondary: "#475569"       # slate-600 (ink-2)
  tertiary: "#6366f1"        # indigo-500 (brand accent)
  neutral: "#f8fafc"         # slate-50 (bg)
  surface: "#ffffff"         # card/surface
  surface-2: "#f1f5f9"       # inset
  surface-3: "#e2e8f0"       # deep inset
  muted: "#64748b"           # slate-500
  brass-bright: "#4f46e5"    # indigo-600 (hover)
  on-brass: "#ffffff"        # light text on brand background
  teal: "#06b6d4"            # cyan-500 (live status)
  danger: "#f43f5e"          # rose-500 (error/warning)
  
  # Dark theme (Obsidian Void)
  primary-dark: "#f8fafc"    # slate-50 (ink-dark)
  secondary-dark: "#cbd5e1"  # slate-300 (ink-2-dark)
  tertiary-dark: "#818cf8"   # indigo-400 (brand accent-dark)
  neutral-dark: "#0b0f19"    # deep space obsidian (bg-dark)
  surface-dark: "#111827"    # slate-900 (card-dark)
  surface-2-dark: "#1f2937"  # slate-800 (inset-dark)
  surface-3-dark: "#374151"  # slate-700 (deep inset-dark)
  muted-dark: "#64748b"      # slate-500 (muted-dark)
  brass-bright-dark: "#6366f1" # indigo-500 (hover-dark)
  on-brass-dark: "#ffffff"   # light text on dark brand
  teal-dark: "#22d3ee"       # cyan-400 (live status-dark)
  danger-dark: "#fb7185"     # rose-400 (error/warning-dark)

typography:
  sans:
    fontFamily: Outfit
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6
  mono-label:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0.12em

rounded:
  sm: 6px
  lg: 12px

spacing:
  sm: 8px
  md: 16px
  lg: 24px

components:
  app-container:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    padding: 16px
  app-container-dark:
    backgroundColor: "{colors.neutral-dark}"
    textColor: "{colors.primary-dark}"
    padding: 16px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.lg}"
    padding: 16px
  card-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.primary-dark}"
    rounded: "{rounded.lg}"
    padding: 16px
  card-inset:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.primary}"
  card-inset-dark:
    backgroundColor: "{colors.surface-2-dark}"
    textColor: "{colors.primary-dark}"
  card-deep:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.primary}"
  card-deep-dark:
    backgroundColor: "{colors.surface-3-dark}"
    textColor: "{colors.primary-dark}"
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-brass}"
    rounded: "{rounded.sm}"
    padding: 8px
  button-primary-dark:
    backgroundColor: "{colors.tertiary-dark}"
    textColor: "{colors.on-brass-dark}"
    rounded: "{rounded.sm}"
    padding: 8px
  button-primary-hover:
    backgroundColor: "{colors.brass-bright}"
    textColor: "{colors.on-brass}"
  button-primary-hover-dark:
    backgroundColor: "{colors.brass-bright-dark}"
    textColor: "{colors.on-brass-dark}"
  badge-live:
    backgroundColor: "{colors.teal}"
    textColor: "{colors.on-brass}"
  badge-live-dark:
    backgroundColor: "{colors.teal-dark}"
    textColor: "{colors.on-brass-dark}"
  badge-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-brass}"
  badge-danger-dark:
    backgroundColor: "{colors.danger-dark}"
    textColor: "{colors.on-brass-dark}"
  label-secondary:
    textColor: "{colors.secondary}"
  label-secondary-dark:
    textColor: "{colors.secondary-dark}"
  label-muted:
    textColor: "{colors.muted}"
  label-muted-dark:
    textColor: "{colors.muted-dark}"
---

# Design System: Nebula Obsidian

Giao diện của Bow-Agent được định hướng theo phong cách không gian lập trình hiện đại và chuyên nghiệp (Hyper-Space Developer Mode).

## Overview

Ý tưởng thiết kế chủ đạo là sự giao thoa giữa **chi tiết kỹ thuật cao** và **tính thẩm mỹ tương lai (Nebula Core)**. UI gợi cảm giác như một bảng điều khiển trung tâm vận hành siêu máy tính AI:
*   Chế độ tối (Obsidian Void): Chiếm chủ đạo, sử dụng màu nền tối sâu thẳm (`neutral-dark`), các thẻ màu xám xanh mịn màng (`surface-dark`), và các hiệu ứng phát sáng mờ ảo của khí tinh vân (tím/indigo và xanh/cyan).
*   Chế độ sáng (Slate Prestige): Thanh lịch với tông xám lạnh thanh khiết (`neutral`), thẻ nền trắng sữa bóng bẩy (`surface`), chữ đậm và độ tương phản cao.

## Colors

Hệ màu tập trung vào các màu trung tính tương phản cao và một màu nhấn đồng thau duy nhất:
*   **Indigo (`#6366f1` / `#818cf8`):** Màu nhấn thương hiệu chủ đạo cho các tác vụ tương tác, nút bấm chính, viền phát sáng và đường liên kết.
*   **Cyan (`#06b6d4` / `#22d3ee`):** Dành riêng cho trạng thái hoạt động (Live), tiến trình chạy, các luồng thông tin thành công và sơ đồ liên kết của AI.
*   **Rose (`#f43f5e` / `#fb7185`):** Đỏ ánh hồng sang trọng dành cho trạng thái lỗi, yêu cầu cần chú ý, nút hủy bỏ hoặc từ chối thao tác.

## Typography

Sử dụng hai phông chữ chuyên dụng được nhúng trực tiếp:
*   **Outfit:** Phong cách hình học sans-serif hiện đại, bo góc mềm mại, sang trọng, mang lại cảm giác thân thiện của AI thông minh cho các tiêu đề và nhãn giao diện chính.
*   **JetBrains Mono:** Phông chữ monospace cao cấp dành cho nhà phát triển, hiển thị dữ liệu log, câu lệnh, phản hồi của AI và các khối mã nguồn một cách rõ nét, cân đối.

## Layout

Cấu trúc giao diện mở rộng, sử dụng các hộp chứa dạng bán trong suốt (glassmorphic cards) và khoảng cách thông thoáng để giao diện không bị bí bách.
*   `spacing.sm` (8px) cho padding/margin bên trong các nút, biểu tượng.
*   `spacing.md` (16px) cho padding/margin trong thẻ card.
*   `spacing.lg` (24px) cho khoảng cách phân chia các vùng màn hình chính.

## Elevation & Depth

*   Sử dụng hiệu ứng bóng mờ nhẹ nhàng kết hợp với viền hairline mờ (`border: 1px solid rgba(255, 255, 255, 0.08)`) để tách biệt các lớp giao diện.
*   Chế độ tối tận dụng quầng sáng màu chàm/tím (`--viewport-glow`) để tạo cảm giác sâu thẳm 3D lơ lửng trong không gian vũ trụ.

## Shapes

*   Bo góc hiện đại, mềm mại:
    *   `rounded.sm` (6px) cho các nút, nhãn thẻ và input.
    *   `rounded.lg` (12px) cho các khung chứa lớn, chat panels và Question cards.

## Components

### Buttons
Các nút tương tác chính có nền màu chàm sáng rực rỡ, bo góc 6px, có chuyển động mượt mà khi hover.

### Cards
Các thẻ chứa nội dung (như Question Card, Log Item) sử dụng màu nền `surface` hoặc `surface-dark`, góc bo 12px hiện đại, viền mỏng tinh tế, tạo độ nổi khối tốt.

## Do's and Don'ts

*   **NÊN:** Sử dụng các đường kẻ đơn mỏng (1px) có màu slate nhẹ để giữ giao diện thanh thoát.
*   **NÊN:** Tận dụng hiệu ứng chuyển dịch màu sắc (gradient) từ chàm (indigo) sang xanh lam (cyan) ở các điểm nhấn quan trọng.
*   **KHÔNG NÊN:** Dùng viền đen dày hoặc các bóng đổ đậm không có độ lan tỏa.
*   **KHÔNG NÊN:** Sử dụng quá nhiều phông chữ khác nhau trên cùng một màn hình.
