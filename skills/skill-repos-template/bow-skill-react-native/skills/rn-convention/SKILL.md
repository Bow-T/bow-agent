---
name: rn-convention
description: Quy ước code React Native của team Bow — cấu trúc thư mục, đặt tên component/hook/screen, quản lý state, và ranh giới giữa UI và lớp data. Dùng khi tạo màn hình/component/hook mới, hoặc khi review xem code có theo quy ước team không. Bản RN của convention Flutter. Đi cặp với [[rn-realtime]] và [[rn-supabase-data]].
---

# Bow RN Convention — cấu trúc, đặt tên, ranh giới

Mục tiêu: mọi màn hình RN đọc như nhau, tách bạch UI khỏi data, để người sau
sửa được mà không phải đoán. Đây là bản React Native của convention Flutter dùng
trong dự án Bow.

## 1. Cấu trúc thư mục
```
src/
  screens/        # 1 màn hình = 1 folder: index.tsx + styles + local hooks
  components/      # component tái dùng, không gắn business logic
  hooks/           # custom hook (data, realtime, form...)
  services/        # gọi Supabase / API — KHÔNG gọi trực tiếp trong component
  models/          # type/interface của domain
```

## 2. Đặt tên
- Component & Screen: `PascalCase` (`DeliveryTrackingScreen`).
- Hook: `use` + camelCase (`useDeliveryTracking`).
- Service: camelCase + hậu tố `Service` (`deliveryService`).
- File screen: `index.tsx` trong folder tên `PascalCase`.

## 3. Ranh giới UI ⟷ data (quan trọng nhất)
- Component **không** gọi thẳng `supabase.from(...)`. Mọi truy vấn qua `services/`
  hoặc `hooks/` — xem [[rn-supabase-data]].
- Realtime **không** nằm trong component — luôn trong custom hook (xem
  [[rn-realtime]]).
- State chỉ sống ở nơi cần: local → `useState`; chia sẻ → context/store, không
  prop-drill quá 2 tầng.

## 4. Checklist review
- [ ] Không có `supabase.from` trong file component.
- [ ] Hook đặt đúng tiền tố `use`, deps đầy đủ.
- [ ] Screen là folder có `index.tsx`, không phải file rời.
