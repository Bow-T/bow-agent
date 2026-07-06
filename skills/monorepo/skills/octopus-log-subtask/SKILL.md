---
name: octopus-log-subtask
description: Khi nhận một task/ticket lớn đáng tách nhỏ, chủ động gợi ý tách thành subtask và in ra một danh sách subtask paste-ready (title + mô tả tiếng Việt ngắn) để người dùng tự log lên Jira. Dùng khi user nói "log subtask", "tách subtask", "chia nhỏ task này", "log lên jira", hoặc khi user đưa một Jira Story/epic nhiều Acceptance Criteria. KHÔNG tự tạo qua Jira MCP (writes bị chặn) — chỉ in danh sách.
---

# Octopus — Log Subtask (gợi ý + in danh sách paste-ready)

Mục tiêu: biến một **task lớn** (Jira Story nhiều AC, hoặc một yêu cầu công việc rộng)
thành một **danh sách subtask gọn, in thẳng ra chat** để user tự tạo trên Jira.

> [!IMPORTANT]
> **KHÔNG gọi `jira_create_subtask` / `jira_update_issue`.** Jira MCP ở repo này
> read-only và auto-mode classifier chặn external-system writes. Mọi lần tạo tự động
> đều fail. Việc của skill này là **in danh sách** — user tự bấm tạo trên Jira UI.
> (xem memory `jira-mcp-read-only`, `log-subtask-means-print-list`)

---

## Khi nào chủ động gợi ý (không cần user nói trước)

Sau khi nhận một task, nếu thấy nó **đáng tách** thì chủ động đề nghị: *"Task này nên
tách thành N subtask — bạn muốn tôi log danh sách subtask để bạn đưa lên Jira không?"*
Dấu hiệu đáng tách:

- Là một **Jira Story** có **≥ 3 Acceptance Criteria** rời rạc, hoặc nhiều section UI.
- Đụng **nhiều layer/surface** (mobile + admin + edge + DB) → mỗi layer là 1 đầu việc.
- Có **phần QA tách riêng** (Kim test sau khi DEV xong).
- Effort ước tính **> ~1 ngày** hoặc cần nhiều người làm song song.

Nếu task **nhỏ/local** (sửa 1 chỗ, 1 thân hàm) → **đừng** tách, làm luôn.

---

## Quy trình

### 1. Đọc nguồn task
- Nếu là link/khóa Jira → `jira_get_issue` đọc đầy đủ AC + UI rules.
- Nếu là yêu cầu bằng lời → tự rút ra các đầu việc rời rạc.

### 2. (Với ticket UI/feature) kiểm tra phần đã build
Trước khi chia, dùng agent `Explore` quét xem màn/luồng đã tồn tại tới đâu trong
`apps/mobile/lib/src` (hoặc `apps/admin`). Phản ánh thực tế vào subtask:
- Phần **đã có code** → subtask ghi tinh thần *verify/polish*, estimate nhỏ.
- Phần **chưa có** (gap thật) → đánh dấu là subtask DEV nặng, nêu rõ.
Việc này tránh log subtask "build mới" cho thứ đã xong → estimate sai.

### 3. Gom AC thành subtask
- Gom **các AC liên quan vào 1 subtask** (vd "filter status + filter date" = 1 cái),
  đừng đẻ 1 subtask cho mỗi AC vụn.
- Mục tiêu **3–7 subtask DEV + 1 subtask QA**. Nếu ra > 8, gom tiếp.
- Luôn có **1 subtask QA** cuối (assignee = Kim) bao trùm toàn ticket theo các AC.

### 4. Định dạng đầu ra (in ra chat, paste-ready)
Mỗi subtask in theo mẫu — **Title** dán vào ô tên, dòng dưới dán vào Description:

```
**Subtask N** · Assignee: <Bow|Hieu|Kim>
Title:
`<Title tiếng Anh ngắn, kèm (ACx, ACy)>`
Mô tả:
> <1 câu tiếng Việt, mô tả NGẮN GỌN, KHÔNG chi tiết file/code>
```

Quy ước title & mô tả (theo memory `jira-log-subtask-no-description`):
- Title **tiếng Anh**, ngắn, **KHÔNG** tiền tố `[DEV]`. Có thể gắn `(AC1, AC2)` cuối.
- Title QA: `QA - <tên màn/luồng>`.
- Mô tả **tiếng Việt, 1 câu**, mô tả *cái gì* — **không** path, không tên hàm, không code.

In kèm bảng account ID để user gán nhanh:
- **Bow (user)** = `712020:b02601a8-3b8b-481b-b234-f8e40cc2ad10`
- **Kim (QA)** = `712020:b277e0ad-956d-408f-8fef-c23e6a60d359`
- (Hieu — Lead Dev: lấy account ID qua `jira_get_users` nếu cần.)

### 5. Nêu lưu ý nghiệp vụ (nếu có)
Nếu phát hiện spec lệch với hiện trạng app (vd spec đòi tab riêng nhưng app gom chung),
**flag ra để user chốt với BA/Kim trước khi estimate** — đừng tự quyết.

### 6. Đề nghị tùy chọn
Cuối danh sách hỏi user có muốn: **rút gọn** (gộp về 3 subtask: DEV core / DEV phụ / QA),
hay **thêm bản mô tả tiếng Anh**.

---

## Mẫu hoàn chỉnh (rút gọn)

```
**Subtask 1** · Assignee: Bow
Title:
`Courier information section (AC2)`
Mô tả:
> Hiển thị thông tin tài xế khi đã gán: tên, đánh giá, ảnh, phương tiện, ETA, nút Gọi/Nhắn tin.

**Subtask 2 (QA)** · Assignee: Kim
Title:
`QA - Delivery booking detail screen`
Mô tả:
> Kiểm thử toàn bộ màn chi tiết booking giao hàng theo 9 acceptance criteria.
```

## Đừng làm
- ❌ Gọi `jira_create_subtask` / bất kỳ Jira write nào → in danh sách, không tạo.
- ❌ Tiền tố `[DEV]` ở title; nhồi path/tên hàm/code vào mô tả.
- ❌ Một subtask cho mỗi AC vụn → gom lại.
- ❌ Bỏ subtask QA.
- ❌ Tự quyết khi spec lệch hiện trạng → flag cho user chốt.
