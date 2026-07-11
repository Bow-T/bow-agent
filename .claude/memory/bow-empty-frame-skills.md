# bow-agent là KHUNG RỖNG — skill tải hết từ GitHub

Đã XÓA hẳn thư mục `skills/` (data) khỏi repo bow-agent. Mọi skill giờ tải từ repo
GitHub, cache ở `~/.bow/skills-cache/<id>@<ref>`. (`src/skills/*.ts` là code module,
VẪN CÒN — đừng nhầm với thư mục data đã xóa.)

**Hai nguồn skill:**
- **CORE** — repo `Bow-T/bow-skill-core`, LUÔN tự tải mỗi lần chạy (không cần chọn).
  Gồm skill kèm code (watch, qc-triage) trải vào `.claude/skills/` STAMP `.bow-core`,
  và prompt-only (coding-convention) gộp vào system prompt. Hàm `deployCoreSkills(cwd)`.
- **STACK** — repo `Bow-T/bow-skill-<flutter|react-native|nextjs>`, tải khi user chọn
  stack trong UI. Trải STAMP `.bow-external`. Repo flutter kèm `monorepo/` (CLAUDE.md +
  git hooks), khai `monorepoDir` trong `bow-skill.json`. Hàm `deployExternalSkills(id,cwd)`.

**Registry** (allowlist stack + repo core): NGOÀI repo, ở `~/.bow-agent/registry.json`,
seed lần đầu từ hằng `DEFAULT_REGISTRY` trong `src/config/env.ts` (theo pattern
[[bow-per-user-mcp]]/mcpConfigPath), override qua env `BOW_REGISTRY`. Admin sửa file này
để ghim ref / thêm stack, KHÔNG cần sửa code.

**Fail-open:** offline/lỗi clone lần đầu → agent VẪN chạy (thiếu skill + cảnh báo), sau
lần đầu cache cho chạy offline. **Rủi ro:** máy mới cần mạng + token clone repo private
`Bow-T/*` (qua gh credential) lần đầu.

**Runner re-order:** `deployCoreSkills` + `deployExternalSkills` chạy SỚM (đầu runAgent)
vì `core.promptText` cần cho system prompt và `ext.monorepoDir`/`hooksDir` cần cho
monorepo context + hooks. Xem `src/core/runner.ts`.

Đã gỡ: `skills/` (data), `deployBundledSkills`+STAMP `.bow-bundled`, `scripts/sync-monorepo.ts`
(đích cũ không còn). Tác giả commit repo skill: `Bow-T <nguyenvantuan4034@hotmail.com>`.
