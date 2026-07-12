---
name: bow-skill-badge-states
description: Badge trạng thái skill cạnh dropdown Stack có 3 mức synced/stale/missing, so ref đã trải vào project với registry
metadata:
  type: project
---

Badge cạnh dropdown **Stack** (chỉ admin thấy) báo skill đã đồng bộ với dự án chưa,
**3 trạng thái** thay vì chỉ ✅/⬇️ cũ (cũ chỉ soi cache `~/.bow`, nên skill cũ vẫn báo ✅ sai):

- **✅ synced** — mọi nguồn (core + stack đang chọn) đã TRẢI vào `<cwd>/.claude/skills/`
  VÀ ref khớp registry hiện tại.
- **⚠️ stale** — có nguồn đã trải nhưng ref CŨ hơn registry (admin đã bump tag) → cần bấm 🔄.
- **⬇️ missing** — có nguồn CHƯA trải vào dự án (dù cache có sẵn hay không).

Badge tổng = nguồn xấu nhất: missing > stale > synced ([`worstState`](../../src/skills/externalSkills.ts)).

**Cơ chế:** STAMP file (`.bow-core`/`.bow-external`) trong mỗi skill folder giờ có 2 phần,
dòng đầu = **ref đã trải**, phần sau = signature (idempotent như cũ) — xem
[`stampContent`/`parseStamp`](../../src/skills/agentSkills.ts). `skillStatus(stackId, cwd)`
đọc ref này (`deployedRef`) để so với registry. STAMP kiểu cũ (chỉ signature, không ref)
→ ref='' → coi là **stale**, tự nhắc sync lại.

- `deploySkillsFrom(srcRoot, cwd, stamp, ref)` — thêm tham số `ref` để ghi vào STAMP.
- `/api/skill-status?stack=&cwd=` — thêm query `cwd` để soi đã trải vào project chưa
  (thiếu cwd → chỉ báo cache, mọi nguồn 'missing').
- **KHÔNG so remote GitHub**: registry cố tình ghim tag đã duyệt; tag mới hơn trên remote là
  bình thường, không phải "cần cập nhật". Badge chỉ xét project vs registry local.

Liên quan: [[bow-deploys-skills-runtime]], [[bow-web-subagents-admin]].
