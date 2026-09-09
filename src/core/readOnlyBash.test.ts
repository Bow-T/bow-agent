/**
 * Kiểm isReadOnlyBash: (1) NHẬN đúng các lệnh xem file từng bị đánh risky oan khiến toggle
 * "Tự duyệt" vẫn bắt bấm tay; (2) TỪ CHỐI mọi thứ có thể ghi/chạy lệnh khác.
 *
 * Chạy: npx tsx --test src/core/readOnlyBash.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isReadOnlyBash } from './readOnlyBash.js';

test('nhận lệnh xem file có dấu > trong nháy (báo động giả cũ)', () => {
  assert.ok(
    isReadOnlyBash(
      `awk 'NR>=470 && NR<=520' /repo/create-edit-service.tsx; echo "=== amount ==="; grep -n "pricing.amount\\|price" /repo/f.tsx`,
    ),
  );
  assert.ok(isReadOnlyBash(`grep -rn "rm -rf" src`)); // chuỗi TÌM KIẾM, không phải lệnh xoá
  assert.ok(isReadOnlyBash(`grep -rn "mv \\| cp" . 2>/dev/null | head -50`));
});

test('nhận các lệnh đọc thường ngày', () => {
  for (const c of [
    'cat package.json',
    'sed -n "1,80p" src/core/runner.ts',
    'ls -la src/core',
    'find src -name "*.test.ts"',
    'git log --oneline -20',
    'git diff --stat',
    'git status',
    'wc -l src/core/runner.ts',
    'cat a.json | jq ".x" | head -5',
    'gh pr view 54',
  ]) {
    assert.ok(isReadOnlyBash(c), `phải là read-only: ${c}`);
  }
});

test('từ chối mọi đường ghi / chạy lệnh khác', () => {
  for (const c of [
    'rm -rf build',
    'echo hi > file.txt',
    'echo hi >> file.txt',
    'cat f | tee out.txt',
    'sed -i "" "s/a/b/" f.ts',
    "awk '{print > \"out.txt\"}' f",
    "awk 'BEGIN{system(\"rm -rf /\")}'",
    'find . -name "*.log" -delete',
    'find . -name "*.ts" -exec rm {} ;',
    'sort -o sorted.txt f.txt',
    'cat $(ls) ',
    'cat `ls`',
    'grep x f | bash',
    'git push origin main',
    'git branch -D old',
    'git stash drop',
    'gh pr merge 54',
    'npm run build',
    'cat .env',
    'cat ~/.ssh/id_rsa',
    'ls & sleep 1',
    '(cd /tmp && rm x)',
    '/bin/rm x',
    'xargs rm < list.txt',
  ]) {
    assert.equal(isReadOnlyBash(c), false, `KHÔNG được coi là read-only: ${c}`);
  }
});
