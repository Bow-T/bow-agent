# Banner "Phiên đã đầy context" là của BOW, không phải Claude Code

**Bẫy chẩn đoán:** thấy banner tiếng Việt "Phiên đã đầy context — lịch sử hội thoại vượt trần
prompt của model…" trong web bow thì ĐỪNG đi điều tra Claude Code (autoCompactWindow, hook,
MCP, skills). Chuỗi đó do chính repo sinh: `formatOverflowHint` ở `src/core/runner.ts`.
Grep chuỗi trong `src/` TRƯỚC khi kết luận nguồn.

## Vì sao tab Grok hay dính mà tab Claude thì không

1. Với gateway (provider ngoài) bow **TẮT auto-compact của CLI** (`applyFlagSettings({
   autoCompactEnabled: !usesGateway })`) — vì CLI đoán trần grok 200k trong khi xAI cho 500k.
   Việc nén từ đó là **trách nhiệm của bow**, không còn ai đỡ.
2. Trần grok 500k < trần Claude → cùng khối việc, chạm trần sớm hơn.
3. Bản đầu chỉ nén ở ranh giới lượt (`case 'result'`) → một lượt marathon phình quá trần mà
   không bao giờ chạm `result`; tới đó `/compact` cũng nổ (nén phải gửi cả hội thoại lên).
   Đo thật trong `conversations.json`: **503.312 / 500.000** và **504.432 / 500.000 token**.

## Đã sửa (28/08/2026)

- `shouldCompactNow` (hàm thuần, có test) gọi từ **hai** chỗ: `emitContextUsage` (giữa lượt)
  và `result` (cuối lượt). Nén giữa lượt là chỗ thực sự cứu phiên.
- Kế toán `compactsSent`/`compactsSettled`: lời `/compact` chiếm slot `input.count()` nhưng
  không chốt bằng `result` → còn lời nén chưa xong thì GIỮ kênh mở, xong thì trừ slot ra.
  Dùng `- 1` cứng như trước sẽ đóng transport trước khi nén kịp chạy.
- Phanh `MAX_COMPACTS_PER_RUN = 3`: `compact_boundary` mở khoá cho nén lại, nếu một lần nén
  không giảm được (post ≈ pre) thì phép đo kế tiếp lại chạm ngưỡng → gửi `/compact` vô tận.
- `.env`: đặt `BOW_COMPACT_AT=55` (mặc định 80) để lượt dài còn chỗ phình.

Pairs với [[bow-token-real-levers]], [[bow-auto-resume-session-limit]].
