# Đội agent (multi-agent) trên Web UI — chỉ admin

Trước đây `--subagents` (bộ subagent chuẩn reviewer/verifier/impact-scout ở
`src/core/subagents.ts`) CHỈ nối dây qua CLI; đường web không truyền cờ nên người dùng
web không dùng được multi-agent. Đã nối dây lên web.

**Luồng cờ** (backend runner KHÔNG đổi — đã sẵn sàng từ trước):
`web/App.tsx` (state `useSubagents` + body `/api/run`) → `src/web/server.ts` đọc body →
gate `allowSubagents = isAdmin && useSubagents === true` → `RunParams.useSubagents` →
`runAgentSession` → `runAgent({ useSubagents })` → runner build `options.agents` qua
`buildSubagents()`.

**Phân quyền: CHỈ admin (localhost).** Subagents spawn nhiều agent con → tốn token hơn,
nên siết giống `model`/`cwd`. Toggle UI bọc `cfg?.isAdmin` (ẩn với non-admin) + server
cưỡng chế lại lần hai (phòng thủ 2 lớp — non-admin gửi cờ lên vẫn bị bỏ qua).

**UI**: toggle switch mới class `.bow-switch` trong `web/styles.css` (checkbox thật ẩn giữ
a11y, track+thumb vẽ tay, ăn accent `--brass` + 3 theme), đặt cạnh Effort trong `.controls`.
Nhãn "🤖 Đội agent". State lưu localStorage `bow-subagents` = '1'/'0'. Cờ được đưa vào
`lastRunPayloadRef` nên GIỮ khi auto-resume phiên (spread `...cfg`).

**Đã verify** (log tạm tại runner, đã xóa): web gửi `useSubagents:true` →
`subagentKeys=reviewer,verifier,impact-scout`; gửi `false` → `subagentKeys=undefined`.

Liên quan: [[working-style-agent-delegation]] (triết lý mặc định 1 agent, chỉ bung
subagent cho việc lớn kiểm chứng được).
