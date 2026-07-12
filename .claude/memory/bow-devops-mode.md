---
name: bow-devops-mode
description: DevOps Mode (mode thứ 6) — Triển khai & Hạ tầng qua LAN; ghi FILE HẠ TẦNG (Dockerfile/compose/workflows/*.tf/k8s/Helm) + docs, DENY source ứng dụng, deploy/apply treo admin duyệt
metadata:
  type: project
---

Mode thứ 6, cạnh dev đầy đủ, [[bow-qc-mode]] (read-only + Skill + Jira), [[bow-collab-mode]] (code
có duyệt), [[bow-ba-mode]] (ghi docs + Jira), [[bow-reviewer-mode]] (review PR). Cho **kỹ sư
Triển khai & Hạ tầng** qua LAN: đọc repo, GHI FILE HẠ TẦNG + cấu hình CI/CD, chạy build/validate;
deploy/apply thì admin duyệt. Cổng **API 4005 / Web 5178**.

**Vì sao có mode này:** phân tích đề xuất mở rộng mode thấy DevOps/Infra là mode dễ & khớp kiến
trúc nhất — nó là ẢNH PHẢN CHIẾU của BA (BA ghi docs / DENY source; DevOps ghi infra / DENY source).

**Điểm thiết kế cốt lõi — mode LAI (khác mọi mode trước):**
- **Ghi file** phân quyền theo ĐÍCH như BA (helper `isInfraPath` cạnh `isDocPath` trong runner):
  infra → cho; source ứng dụng (.ts/.tsx/.dart/.py…) → DENY CỨNG; file nhạy cảm → DENY.
- **Deploy/apply** (terraform apply, docker push, kubectl apply, gh workflow run…): KHÔNG deny cứng
  như BA, mà ĐỊNH TUYẾN admin duyệt như Collab. Cơ chế: `routeToAdmin = (isCollabMode ||
  isDevOpsMode) && !isAdmin` → `requireApprovalForWrites=true` → runner cho Bash risky rơi xuống
  cổng `gate()` chung (treo `adminBus`) thay vì chặn. Admin localhost chạy trực tiếp → auto.
  Lý do chọn: deploy là việc HỢP LỆ của vai này, chỉ cần admin xác nhận; regex-whitelist-deploy
  dễ sai (một `terraform apply` lọt có thể phá hạ tầng thật) nên KHÔNG dùng.

**`isInfraPath` bao 4 nhóm** (test 41/41 PASS ở scratchpad/test-infra-path.mjs):
- Container & Compose: Dockerfile / Dockerfile.* / *.dockerfile, docker-compose*.yml, .dockerignore.
- CI/CD: `.github/workflows/*`, .gitlab-ci.yml, Jenkinsfile, azure-pipelines*.yml, `.circleci/*`,
  codemagic.yaml, bitbucket-pipelines.yml.
- IaC: *.tf/*.tfvars/*.hcl; thư mục k8s|kubernetes|manifests|charts|helm; Helm (Chart.yaml,
  values*.yaml, templates/*.yaml|tpl); deploy(ment)s/*.yaml.
- Docs vận hành: tái dùng `isDocPath` (*.md / docs/).
- CỐ Ý không nhận MỌI *.yaml (config app cũng dùng yaml): yaml chỉ tính là infra khi trong thư mục
  hạ tầng hoặc trùng tên đặc trưng. Case bẫy đã test: `src/deploy.ts`, `dockerfile-parser.ts`,
  `templates/email.html`, `config/database.yml` → đều KHÔNG phải infra.

**Bật:** `npm run ui:devops:share` (`BOW_DEVOPS_MODE=true` + `BOW_DEVOPS_CWD=/…/monorepo` + cổng
riêng `BOW_AGENT_PORT=4005 BOW_WEB_PORT=5178`). Bản local: `ui:devops`. Dừng: `ui:devops:stop`.
Server ép `mode='auto'`; policy trong `canUseTool` khối `if (isDevOpsMode)`. VSCode: task "web: chạy
DevOps Mode" / launch "🛠️ Chạy Web DevOps Mode" (group 1_run order 6, mở :5178). Chạy song song
dev (4000/5173), QC (4001/5174), collab (4002/5175), BA (4003/5176), review (4004/5177).

**Cài đặt:** cờ `opts.devopsMode` truyền server.ts → runner.ts (như baMode, ĐỌC từ opts không từ
env trong runner). `checkReadonlyConfig` giờ chặn config ở `isQcMode||isReviewerMode||isCollabMode
||isBaMode||isDevOpsMode` (403). `devopsCwdOverride` + `devopsCwd()`; `/api/qc-cwd` (cổng 4005) →
ghi `devopsCwdOverride`. `/api/config` trả `isDevOpsMode` + `otherModes.devops` (cổng 4005 →
`modes.devops`, `pingConfigPort(4005)`). Panel admin duyệt DÙNG CHUNG kênh `/api/admin/events` với
Collab (frontend mở SSE trên MỌI origin đang hoạt động qua `getActiveOrigins`, gồm 4005) — không
gắn cứng isCollabMode nên tự phủ DevOps.

**Frontend** (`web/App.tsx`): `cfg.isDevOpsMode`; biến `devops` (KHÔNG thuộc `readonlyShare` — mode
ghi như Collab/BA). Class `.devops-mode`; banner `.devops-banner` (tông XANH LÁ emerald #10b981,
phân biệt QC teal / Collab cam / BA xanh dương / Reviewer tím). Badge "DevOps Src" +
picker target `devops-cwd` (cổng 4005). `API_PORTS` thêm 4005; badge queue nhận diện 4005='DevOps'.

**Tự nạp stack `devops`:** `effectiveStack = … isDevOpsMode ? 'devops'`. **LƯU Ý: repo skill
`Bow-T/bow-skill-devops` CHƯA tồn tại/đăng ký** trong `~/.bow-agent/registry.json` → hiện fail-open
(chỉ log cảnh báo "skill stack không tải được", agent vẫn chạy). Giống BA lúc đầu (bộ skill chờ
soạn/đẩy). Muốn có skill DevOps: soạn repo `bow-skill-devops` (bow-skill.json id=devops) → push tag
→ thêm vào `stacks[]`. Xem [[bow-empty-frame-skills]] mẫu cơ chế 2 nguồn skill.

**AUDIT BẢO MẬT (3 agent adversarial + test regex) — đã vá 3 lỗ (#5/#6/#7), #4 để nguyên theo user:**
- 🔴 **VÁ #5 (đường lách ghi source qua Bash):** deny-cứng-source chỉ chặn `FILE_WRITE_TOOLS`
  (Edit/Write/MultiEdit/NotebookEdit). Bash cố ý mở cho deploy → editor sửa-file-tại-chỗ ghi được
  source lách cổng: `sed -i`, `perl -i`, `ruby -i`, `patch` (kể cả `patch f < diff` — redirect ĐỌC
  `<` không bị RISKY), `git apply`, `git checkout -p`, `ex/ed`, `install`, `awk`. Ở **admin
  localhost** (`mode='auto'`, requireApprovalForWrites=false) chúng AUTO-ALLOW (non-admin thì đã
  treo qua requireApprovalForWrites). Vá: helper `isInPlaceFileEdit` + `INPLACE_FILE_EDIT_COMMANDS`
  trong runner; khối `if (isDevOpsMode)` bắt Bash khớp → LUÔN gọi `opts.onApproval` (treo duyệt kể
  cả admin). Test 13 bắt / 20 không-bắt-nhầm (deploy terraform/docker/kubectl/helm + `git commit`/
  `make deploy`/`echo installing` đi tiếp) PASS.
- 🔴 **VÁ #6 (MCP write defense-in-depth):** BA có lớp `mcp__* && !isJira → deny`, DevOps ban đầu
  KHÔNG có → admin auto-allow `execute_sql DROP TABLE`/`apply_migration` ở 'auto'. Vá: khối DevOps
  ép mọi `mcp__*` KHÔNG-phải-read-tường-minh (`!list|get|search|describe|read|show|fetch`) qua
  `opts.onApproval` (treo duyệt kể cả admin). Jira write cũng bị treo (DevOps không có vai Jira).
- ⚠️ **Còn #4 (chưa vá — quyết định chính sách):** nhóm route `/api/profiles*` (đổi/xoá tài khoản
  Claude) chỉ có `requireAdmin`, THIẾU `checkReadonlyConfig` → admin DevOps localhost vẫn đổi được
  profile Claude dù mode tuyên bố "khoá config". CHỈ admin (không leo thang non-admin); áp cho CẢ 5
  mode cũ (không phải regression DevOps). Chưa sửa vì ảnh hưởng rộng + admin có thể cần đổi runtime.
- 🔴 **VÁ #7 (đọc secret) — user chốt CHẶN:** DevOps ban đầu auto-approve Read/Grep → đọc
  `.env`/`id_rsa`/`credentials` tự do (giống Collab/BA). Vì DevOps làm với hạ tầng (bí mật tập
  trung) + đối tượng là CTV LAN → rủi ro rò rỉ cao. Vá: (1) loại Read/Grep khỏi `readAutoTools` khi
  `isDevOpsMode` (như QC/Reviewer) để rơi vào canUseTool; (2) khối DevOps chặn Read file
  `isSensitivePath` + Grep có `path` nhạy cảm, NGƯỢC LẠI **allow THẲNG** (tránh non-admin
  requireApprovalForWrites bắt admin duyệt từng lần đọc). Mọi file khác đọc bình thường.
- ⚠️ **Còn #4 (user chốt ĐỂ NGUYÊN):** nhóm route `/api/profiles*` thiếu `checkReadonlyConfig` →
- ✅ **KÍN cho non-admin:** giả mạo admin (getSocketIp không tin x-forwarded-for), trỏ cwd ra $HOME
  (ép devopsCwd), lách mode/requireApprovalForWrites — mọi ghi/deploy/MCP đều treo admin duyệt.

**Đã test:** typecheck + ui:build sạch (cả trước & sau vá); `isInfraPath` 41/41; `isInPlaceFileEdit`
13 bắt + 20 không-bắt-nhầm; server DevOps trả `isDevOpsMode:true` + startup log; POST /api/mcp → 403
checkReadonlyConfig. Test ở scratchpad: test-infra-path.mjs, test-bash-escape.mjs, test-inplace-edit.mjs.
Xem thêm [[bow-per-user-mcp]].
