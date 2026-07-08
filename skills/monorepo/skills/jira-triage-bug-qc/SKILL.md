---
name: jira-triage-bug-qc
description: Khi user đưa MỘT ticket Jira (key hoặc link, vd <PROJECT_KEY>-820), phân loại ticket là Task hay Bug. Nếu là Bug thì kiểm QC log ngay trong ticket (mô tả + comment): đủ thông tin tái hiện chưa, có thật là bug không (đúng loại), và mô tả có khớp với code/hành vi thực không. In ra một báo cáo triage gọn + kết luận QC log ĐẠT / CHƯA ĐẠT. Dùng khi user nói "check ticket này", "task hay bug", "kiểm QC log", "ticket này bug thật không", hoặc chỉ dán một Jira key/link vào. KHÔNG comment lên Jira (MCP read-only) — chỉ đọc và in báo cáo.
---

# Jira Triage — Task hay Bug + Kiểm QC log

Mục tiêu: nhận **một ticket Jira**, trả lời 2 câu hỏi theo thứ tự:

1. **Task hay Bug?** — phân loại đúng loại thực chất (không chỉ tin field "Issue Type").
2. **Nếu là Bug → QC log trong ticket có đúng/đủ không?** — đối chiếu mô tả + comment
   của QC với 3 tiêu chí: (a) đủ thông tin tái hiện, (b) đúng là bug thật, (c) khớp
   với code/hành vi thực.

Đầu ra là **một báo cáo triage in thẳng ra chat** + kết luận **QC log ĐẠT / CHƯA ĐẠT**
kèm những gì còn thiếu để QC bổ sung.

> [!IMPORTANT]
> **Jira MCP ở repo này read-only.** KHÔNG gọi `jira_add_comment` / `jira_update_issue` /
> `jira_transition_issue` — mọi write đều fail và bị auto-mode chặn. Skill này chỉ **đọc**
> (`jira_get_issue`, `jira_get_comments`, `jira_get_attachments`) rồi **in báo cáo**. Nếu
> muốn phản hồi lên ticket, user tự dán vào Jira UI.
> (xem memory `jira-mcp-read-only`)

---

## Khi nào chạy skill này

Kích hoạt khi user:
- Dán một **Jira key** (`<PROJECT_KEY>-123`) hoặc **link** ticket rồi hỏi kiểm.
- Nói "task hay bug", "check ticket này", "kiểm QC log", "bug này thật không / tái hiện được không".
- Đưa ticket mà không nói rõ làm gì → **chủ động** đề nghị triage: *"Để tôi phân loại
  Task/Bug; nếu là Bug tôi kiểm luôn QC log nhé?"*

Nếu user đưa **nhiều ticket** hoặc một **board/epic** → đây không phải skill đó; hỏi user
chọn 1 ticket để triage, hoặc dùng skill khác cho việc quét hàng loạt.

---

## Quy trình

### Bước 1 — Đọc ticket
Bóc key từ input (skill dùng cùng logic `parseJiraRef` — chấp cả key thuần lẫn URL).
Rồi đọc đầy đủ:
- `jira_get_issue` → **Issue Type**, **Summary**, **Description**, **Status**, **Reporter**,
  **Assignee**, **Priority**, **Labels**, **Components**.
- `jira_get_comments` → toàn bộ trao đổi, đặc biệt comment của **QC (Kim / Ngan Nguyen)**.
- `jira_get_attachments` → có ảnh/video/log đính kèm không (đầu vào quan trọng cho tiêu chí tái hiện).

Nếu ticket không đọc được (key sai / không có quyền) → báo user, dừng, đừng đoán.

### Bước 2 — Phân loại Task hay Bug (không tin mù field Issue Type)

Field `Issue Type` là gợi ý đầu tiên, **không phải kết luận**. Đối chiếu với nội dung:

| Dấu hiệu **BUG** | Dấu hiệu **TASK** (feature / change / chore) |
| :--- | :--- |
| Mô tả một **hành vi sai** so với kỳ vọng đã có | Yêu cầu **thêm/đổi** một hành vi (chưa từng có) |
| Có "expected vs actual", "đáng lẽ… nhưng lại…" | Có "cần làm", "thêm màn", "đổi flow", acceptance criteria mới |
| Có bước tái hiện, ảnh lỗi, mã lỗi/stacktrace | Không có lỗi để tái hiện — là việc cần build |
| Từ khoá: lỗi, crash, sai, không hiển thị, mất, đơ | Từ khoá: thêm, hỗ trợ, cho phép, cập nhật UI, refactor |

**Kết luận phân loại** ghi rõ 1 trong 3:
- ✅ **BUG** (khớp field) — tiếp Bước 3.
- ✅ **TASK** — dừng ở đây, **không** kiểm QC log (không áp dụng). Gợi ý: nếu là Story lớn
  cân nhắc skill `bow-log-subtask`.
- ⚠️ **LỆCH LOẠI** — field ghi Bug nhưng thực chất là change-request/feature (hoặc ngược lại).
  **Flag rõ** cho user, nêu lý do; nếu bản chất không phải Bug thì QC log coi như "không áp dụng".

### Bước 3 — (Chỉ khi là BUG) Kiểm QC log trong ticket theo 3 tiêu chí

QC log = phần **mô tả bug + comment của QC** trong chính ticket. Chấm từng tiêu chí
**ĐẠT / THIẾU / KHÔNG CHẮC**, kèm dẫn chứng (trích câu / tên ảnh đính kèm).

**(a) Đủ thông tin tái hiện** — cần có:
- **Steps to reproduce** rõ ràng, đánh số hoặc tuần tự.
- **Expected** (kỳ vọng) vs **Actual** (thực tế) tách bạch.
- **Môi trường**: app nào (mobile/admin), OS/thiết bị, build/version, tài khoản/role test.
- **Bằng chứng**: ảnh chụp / video / log / mã lỗi (`23514`, stacktrace…) đính kèm hoặc dán.
- Nếu bug theo dữ liệu: **input/điều kiện** cụ thể để trúng (vd loại xe, trạng thái đơn).

Thiếu bất kỳ mục cốt lõi nào (không có step, hoặc không có expected/actual, hoặc không có
bằng chứng khi lỗi thuộc dạng phải nhìn mới tin) → tiêu chí (a) = **THIẾU**, liệt kê ra.

**(b) Đúng là bug thật (đúng loại)** — xét:
- Hành vi mô tả có thật sự **sai so với spec/kỳ vọng đã chốt** không, hay chỉ là "khác ý
  người test" / một **change-request** trá hình / **hiểu nhầm nghiệp vụ**?
- Có phải **trùng** một ticket đã biết / lỗi môi trường cục bộ (mạng, thiết bị) không?
- Kết luận: **BUG THẬT** / **NGHI KHÔNG PHẢI BUG** (nêu vì sao) / **CẦN BA/QC xác nhận spec**.

**(c) Khớp với code/hành vi thực** — đối chiếu mô tả với source (khi đang trong monorepo):
- Dùng agent `Explore` (hoặc grep) tìm màn/luồng/hàm liên quan trong `apps/mobile/lib/src`,
  `apps/admin`, `supabase/` để xem lỗi **có đường tái hiện trong code** không.
- Bug thuộc dạng **xuyên hệ thống** (enum/vocabulary, CHECK/FK/trigger DB, RPC `SECURITY DEFINER`,
  validator edge) thì đừng chỉ đọc mô tả — soi tầng runtime theo `debugging-and-error-recovery`
  và `impact-sweep`. Bài học <PROJECT_KEY>-1793/1797: giá trị compile sạch vẫn có thể vi phạm
  `CHECK` ở bảng cách 3 lớp → crash `23514`.
- Kết luận: **KHỚP — tái hiện được/thấy được trong code** / **KHÔNG KHỚP — code không có đường
  gây lỗi này** (nghi mô tả sai môi trường/nhánh) / **KHÔNG CHẮC — cần chạy runtime để chốt**.

> Chỉ soi code khi ticket đủ cụ thể để định vị. Nếu QC log quá mỏng (tiêu chí (a) THIẾU nặng)
> thì nói thẳng "chưa đủ dữ kiện để đối chiếu code" thay vì đoán bừa.

### Bước 4 — In báo cáo triage (paste-ready, tiếng Việt)

Dùng đúng mẫu dưới. Với ticket **TASK** thì chỉ in phần phân loại + lý do (bỏ khối QC log).

```
### Triage <PROJECT_KEY>-XXX — <Summary>
Issue Type (field): <Bug/Task/...>   Status: <...>   QC/Reporter: <...>

**Phân loại:** <BUG THẬT | TASK | LỆCH LOẠI: field=Bug nhưng thực chất là <...>>
Lý do: <1–2 câu dựa trên nội dung, không chỉ field>

── QC log (chỉ khi là Bug) ──────────────────────
(a) Đủ thông tin tái hiện : [ĐẠT | THIẾU | KHÔNG CHẮC]
    Steps<✓/✗> · Expected/Actual<✓/✗> · Môi trường<✓/✗> · Bằng chứng<✓/✗>
    Thiếu: <liệt kê cụ thể cái còn thiếu, hoặc "—">
(b) Đúng là bug thật      : [BUG THẬT | NGHI KHÔNG PHẢI BUG | CẦN XÁC NHẬN SPEC]
    <lý do ngắn>
(c) Khớp code/hành vi thực: [KHỚP | KHÔNG KHỚP | KHÔNG CHẮC]
    <đường code liên quan (file:line) hoặc lý do chưa đối chiếu được>

**Kết luận QC log: <ĐẠT | CHƯA ĐẠT>**
<Nếu CHƯA ĐẠT: liệt kê gạch đầu dòng những gì QC cần bổ sung để ticket dùng được>
```

### Bước 5 — Nêu bước tiếp theo (không tự làm thay)
- QC log **CHƯA ĐẠT** → in danh sách câu hỏi/mục cần QC (Kim) bổ sung; **không** tự comment
  lên Jira (read-only) — user tự gửi.
- QC log **ĐẠT** và là bug thật → gợi ý: có muốn tôi vào điều tra root cause theo
  `debugging-and-error-recovery` không?
- **LỆCH LOẠI** → đề nghị user chốt lại loại/quy trình với BA/QC trước khi xử.

---

## Đừng làm
- ❌ Gọi bất kỳ Jira **write** nào (`jira_add_comment`, `jira_update_issue`, `jira_transition_issue`) → chỉ đọc + in.
- ❌ Tin mù field "Issue Type" — luôn đối chiếu nội dung để phát hiện lệch loại.
- ❌ Kết luận "(c) KHỚP/KHÔNG KHỚP" chỉ bằng đọc mô tả với bug xuyên hệ thống → phải soi runtime.
- ❌ Chấm QC log ĐẠT khi thiếu bước tái hiện / thiếu expected-actual / thiếu bằng chứng.
- ❌ Đoán bừa root cause khi dữ kiện chưa đủ — nói thẳng "cần QC bổ sung X trước".
- ❌ Tự quyết khi nghi lệch spec → flag cho user chốt với BA/QC.
