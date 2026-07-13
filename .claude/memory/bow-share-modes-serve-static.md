---
name: bow-share-modes-serve-static
description: Mode chia sẻ LAN tự serve dist-web trên cổng API, KHÔNG Vite proxy (bảo mật)
metadata:
  type: project
---

Các mode chia sẻ LAN (QC/Collab/BA/Reviewer/DevOps) chạy `BOW_SERVE_STATIC=true`: backend
tự phục vụ `dist-web` ngay trên cổng API (4001…), client vào THẲNG cổng đó. KHÔNG còn Vite
`--host` + proxy.

**Why:** Vite proxy `/api` về backend qua `localhost` (`xfwd` bị `getSocketIp` bỏ qua), nên
backend thấy MỌI client LAN là `127.0.0.1` → ai cũng thành admin (`isAdminReq`), mất sạch
phân quyền IP + cổng token. Đây từng là lỗ hổng thật: QC agent qua LAN "vào không cần cấp
quyền" và bấm nút bị coi như admin.

**How to apply:** Đừng chuyển các script `ui:qc:share`/`ui:collab`/`ui:ba`/`ui:review:share`/
`ui:devops:share` về `vite --host`. Chúng phải `npm run ui:build && BOW_SERVE_STATIC=true …
npm run ui:api`. Khi `BOW_SERVE_STATIC=true`, `webPort` trong `/api/config` = cổng API (không
phải `BOW_WEB_PORT`) → `lanUrls` trỏ đúng cổng an toàn. Mode **Dev** (`npm run ui`) vẫn dùng
Vite cho HMR — chỉ admin tự chạy local, KHÔNG chia sẻ LAN. Kiểm chứng: LAN gọi `/api/config`
phải trả 401 (cần duyệt), localhost trả 200. Liên quan [[bow-access-code-gate]].
