---
name: bow-lan-config-401-crash
description: Client LAN chưa duyệt → /api/config trả 401, code không check r.ok → setCwd(undefined) → App crash trắng
metadata:
  type: feedback
---

Trang share/collab (5174/5175) "đen thui" trên máy LAN nhưng bình thường trên
localhost: client LAN chưa được duyệt gọi `/api/config` bị **401**. Code cũ
`apiFetch('/api/config').then(r => r.json())` nuốt luôn body 401, rồi
`setCwd(c.defaultCwd)` với `defaultCwd === undefined` → re-render chạy
`cwd.trim()` (App.tsx ~dòng 2200, TRƯỚC cả `if gateState !== 'open'`) →
`TypeError: reading 'trim'` → không có error boundary nên cả cây unmount,
`#root` rỗng, không hiện cổng truy cập lẫn dialog phê duyệt.

**Why:** localhost là admin nên /api/config luôn 200; chỉ LAN non-admin mới lộ.
Test phải trỏ headless vào **IP LAN**, không phải localhost, mới thấy.

**How to apply:** Mọi call `/api/*` lấy field từ body PHẢI check `r.ok` trước
(LAN chưa duyệt trả 401). Và code render top-level của App phải chịu được state
undefined (dùng `cwd?.trim()`), vì nó chạy trước cổng truy cập. Debug web đen:
dùng CDP headless bắt `Runtime.exceptionThrown` — số dòng lỗi là theo file
**đã transform** (curl `/App.tsx`), không phải file nguồn. Liên quan
[[bow-access-code-gate]].
