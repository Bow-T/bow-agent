---
name: bow-token-real-levers
description: Token cao KHÔNG do schema MCP — đòn bẩy thật là model (Opus mọi việc) + subagent tự spawn; ĐO trước khi cắt
metadata:
  type: project
---

Điều tra tốn-token khi làm ticket: **schema MCP tool KHÔNG phải thủ phạm chính** (chỉ ~11k
token/lượt = ~$0.66/phiên, rất nhỏ). Đừng nhảy vào cắt disallowedTools — đã thử, hiệu quả bé,
đổi lấy rủi ro mất tool. User bác đúng: "sai hướng".

**Đòn bẩy THẬT (từ số liệu sprint-runs.json: dry-run CHỈ ĐỌC 6 ticket vẫn tốn ~$2.24/lần):**
1. **Model Opus 4.8 cho MỌI việc** (config/env.ts:299 `model:'claude-opus-4-8'`) — kể cả đọc
   ticket, grep, triage. Output Opus $75/M = đắt gấp 50× cache-read. Việc đọc/triage nên hạ
   Sonnet 5 (rẻ 5×) → tiết kiệm ~$1.34/phiên, gấp 2× cắt schema, chất lượng gần như không đổi.
2. **Subagent tự spawn** — log sprint-live.json có nhiều "🤖 giao việc cho agent phụ". Mỗi
   subagent = 1 context riêng nạp lại toàn bộ. SUBAGENT_MODEL=Sonnet, SCOUT=Haiku
   (subagents.ts:13-14) nhưng số LƯỢNG subagent mới là chỗ tốn.
3. **Phiên dài + đọc code lặp** — nhiều vòng nạp lại context lớn (đã biết ở
   [[monorepo-token-burn-diagnosis]]).

**QUY TẮC:** ĐO trước khi cắt. Event `result` đã có breakdown `inputFresh/cacheRead/
cacheCreation` (in ở CLI `fmtTokenBreakdown` + web TaskPane). Chạy 1 phiên thật, đọc dòng
`↳ token: cache-read … · fresh … · output …`:
- output cao = model đắt sinh nhiều chữ → hạ model / bớt subagent
- cache-read cao = nền lặp (nhưng rẻ $1.5/M, ít đáng lo)
- fresh cao mỗi lượt = silent invalidator phá cache

Pairs với [[monorepo-token-burn-diagnosis]], [[bow-sprint-scan]].
