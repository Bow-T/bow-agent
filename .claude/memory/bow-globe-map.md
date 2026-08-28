---
name: bow-globe-map
description: "Màn Bản đồ (BOW GLOBE) — quả cầu WebGL ở nav trái gom 4 lớp dữ liệu thật; múi kinh độ cố định theo lớp"
metadata:
  type: project
---

Màn **Bản đồ** (`navSection = 'map'`, nav trái, dưới Cosmos) — [web/panels/GlobeMapPanel.tsx](../../web/panels/GlobeMapPanel.tsx).
Một quả cầu lưới three.js, **KHÁC Cosmos**: Cosmos là overlay free-fly của MỘT tab; Bản đồ là
màn độc lập, nhìn toàn cục, lazy-load qua `React.lazy` trong `NavSectionView`.

**4 lớp, mỗi lớp một MÚI KINH ĐỘ cố định** (hằng `ZONE` — sửa bố cục thì sửa đúng chỗ đó):

| Lớp | Múi lon | Nguồn thật | Ý nghĩa hình học |
| --- | --- | --- | --- |
| `code` | −172…−14 | `/api/filetree` | 1 ô đĩa = 1 top-dir (to ∝ số file), chấm quanh = file (to ∝ log dòng) |
| `jira` | 12…104 | `/api/jira/sprints` + `/api/jira/issues` (sprint `active`) | **vĩ độ = trạng thái**: todo −46°, doing 2°, done 48° |
| `source` | 116…176 | `web/cosmosSystems.ts` | 9 hệ tri thức, lưới 3×3 |
| `live` | quỹ đạo alt 1.3 | tab đang mở + `agents` | cung Bezier nối tab → ticket (bắt Jira key trong tiêu đề tab) |

**Điểm dễ vỡ:**
- 9 hệ ĐÃ TÁCH ra `web/cosmosSystems.ts` (Cosmos + Bản đồ cùng đọc) — đừng khai lại bảng thứ hai.
- `tasks` từ App là mảng MỚI mỗi render → effect dựng cầu phụ thuộc `sig` (chuỗi id|tone|lat,lon),
  không phụ thuộc `nodes`; góc camera giữ ở `viewRef` để rebuild không giật.
- Màu trạng thái đọc token `--step-*` qua `getComputedStyle` + `MutationObserver` trên
  `data-theme`/`data-accent` (WebGL không tự biết CSS var đổi).
- Chỉ ĐỌC: hành động duy nhất là `onGoTask` / `onUseJiraKey`. Jira chưa cấu hình → lớp sprint rỗng,
  không phải lỗi của cả màn.

Liên quan: [[bow-web-theme-blueprint]].
