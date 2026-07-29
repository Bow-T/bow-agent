---
name: sprint-scan-launchd-cwd
description: launchd sprint-scan — WorkingDirectory phải là bow-agent (tsx), không phải repo đích
metadata:
  type: project
---

launchd của sprint-scan (`com.bow-agent.sprint-scan`) có HAI cwd khác nhau, đừng gộp:

- **WorkingDirectory của launchd** = thư mục **bow-agent** (nơi có `node_modules/tsx`). Node
  resolve `tsx` theo cái này — nếu để repo đích (monorepo) sẽ crash `ERR_MODULE_NOT_FOUND: tsx`
  và MỌI tick chết trước khi vào agent (lịch mãi "chưa chạy", `launchctl list` cột giữa = 1).
- **cwd repo đích** (nơi agent sửa code) do `sprint-scan --tick` TỰ đọc từ
  `~/.bow-agent/sprint-schedule.json` (hoặc `BOW_CWD`), độc lập WorkingDirectory.

`--import tsx` phải là **đường dẫn tuyệt đối** tới `tsx/dist/loader.mjs`, KHÔNG bare `'tsx'`
(bare phụ thuộc cwd). Fix nằm ở `buildPlist` ([[bow-sprint-scan]]) + 2 caller: `webServer.ts`
(nút Cài tự chạy) và `cli/index.ts` (`bow schedule install`) — cả hai truyền `cwd: bowRoot`.

**Why:** Bug này từng khiến "tới giờ không chạy" dù dashboard báo "tới khung". **How to apply:**
Khi sửa/cài lại launchd, kiểm `~/Library/LaunchAgents/com.bow-agent.sprint-scan.plist`:
WorkingDirectory = bow-agent, `--import` = đường dẫn tuyệt đối. Dấu hiệu OK: `launchctl list |
grep bow-agent` có PID + exit 0; log `~/.bow-agent/sprint-scan.log` không có ERR_MODULE_NOT_FOUND.
