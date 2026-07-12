# Tự chạy tiếp khi hết hạn mức phiên (auto-resume session limit)

**Vấn đề:** phiên agent đang thực thi bị dừng vì hết hạn mức 5h ("You've hit your
session limit · resets HH:MM"). Trước đây client chỉ in "Kết thúc bất thường" rồi dừng
hẳn — người dùng phải ngồi canh tới giờ reset rồi tự chạy lại. Nay hệ thống **tự lên lịch
và tự chạy tiếp** case dở.

## Cơ chế (cả server + client)

- **runner.ts**: bắt message SDK `rate_limit_event` (mang `rate_limit_info.resetsAt` epoch
  của cửa sổ `five_hour`) để giữ giờ reset chính xác. Khi phiên chốt bằng `result` lỗi,
  hàm `looksLikeSessionLimit()` dò chuỗi trong `errors[]`/subtype ("session limit",
  "usage limit", "rate limit ... reset") → phát event `error` kèm `isSessionLimit: true`
  + `resetsAt` (ưu tiên rate_limit_event > cửa sổ Session 5hr trong snapshot).
- **server.ts** — cốt lõi server-side, bền qua đóng tab:
  - `runAgentSession(session, params, attempt)` gói việc chạy agent + tự lên lịch. Thay cho
    khối `runAgent().then/catch/finally` inline cũ trong `/api/run`.
  - Registry `resumeSchedules: Map<conversationId, {timer, retryAt, sessionId}>`.
  - Khi dừng vì session limit + đang thực thi + còn lượt: `setTimeout` tới
    `resetsAt + AUTO_RESUME_BUFFER_MS (30s)` → tạo **phiên mới** resume `conversationId` cũ
    + gửi `AUTO_RESUME_PROMPT` ("tiếp tục việc dở"). Phát `auto-resume-scheduled` cho client.
  - **Chỉ phiên đang thực thi** (`isExecuting`, tức mode ≠ plan) — plan/QC không auto-resume.
  - **Tối đa 3 lần** (`AUTO_RESUME_MAX_ATTEMPTS`); hết thì phát `auto-resume-cancelled` reason
    `exhausted`.
  - Nhánh `.catch()` KHÔNG đẩy `fatal` khi `hitSessionLimit` (tránh thẻ đỏ gây hiểu lầm) —
    để `.finally()` phát `auto-resume-scheduled` thay thế.
  - Route: `POST /api/resume/cancel {conversationId}` (huỷ), `GET /api/resume/pending?conversationId=`
    (client mở lại tab dựng lại đồng hồ). Người dùng chạy tay 1 hội thoại có lịch treo →
    `/api/run` tự `cancelResumeSchedule`.
- **App.tsx** — client-side fallback (server-first): nhận `auto-resume-scheduled` → hiện
  thẻ `.auto-resume-card` đếm ngược (`formatCountdown`) + nút "Huỷ tự chạy tiếp". Đặt
  `setTimeout` tới `retryAt + 20s`: nếu server IM (đã tắt) thì `triggerClientResume` tự gửi
  lượt "tiếp tục". Khi phiên resume khởi động (`conversation` trùng cid đang chờ) → xoá thẻ
  + huỷ timer fallback. Mở lại tab thì hỏi `/api/resume/pending` để dựng lại thẻ.

## Debug / verify

Cờ env giả lập (không cần chờ limit thật): `BOW_SIMULATE_SESSION_LIMIT=true` →
lần chạy đầu mỗi phiên đang thực thi tự "hết hạn mức" sau `BOW_SIMULATE_DELAY_MS` (mặc
định 6s) với resetsAt = now + `BOW_SIMULATE_RESET_MS` (mặc định 30s). Đệm lịch chỉnh qua
`BOW_AUTO_RESUME_BUFFER_MS`. Đã verify end-to-end qua audit log:
error(isSessionLimit) → auto-resume-scheduled → AUTO-RESUME lần 2/3 → HOÀN THÀNH.

Liên quan: [[bow-resume-real-session-id]] (resume bằng session_id thật của SDK — nền tảng
để auto-resume nối đúng phiên), [[bow-collab-mode]], [[bow-qc-mode]].
