/**
 * Test nới git local cơ bản. Hàm THUẦN — truyền thẳng tên nhánh hiện tại, không chạm đĩa.
 * Chạy: `node --import tsx --test src/core/safeLocalGit.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeLocalGitDecision } from './safeLocalGit.js';

const onFeature = (cmd: string) => safeLocalGitDecision(cmd, 'feat/DUOCT-123');

test('AUTO: stage + commit local trên nhánh làm việc', () => {
  assert.equal(onFeature('git add .'), 'auto');
  assert.equal(onFeature('git add src/core/runner.ts web/App.tsx'), 'auto');
  assert.equal(onFeature('git add -A'), 'auto');
  assert.equal(onFeature('git commit -m "feat: thêm bộ lọc lịch sử"'), 'auto');
  assert.equal(onFeature('git commit -am "fix: sửa lọc ngày"'), 'auto');
});

test('AUTO: tạo nhánh mới (không trùng nhánh chính)', () => {
  assert.equal(onFeature('git checkout -b feat/DUOCT-999'), 'auto');
  assert.equal(onFeature('git switch -c fix/lọc-ngày'), 'auto');
  assert.equal(onFeature('git checkout -b feat/x origin/main'), 'auto');
  // Tạo nhánh mới không phụ thuộc nhánh đang đứng.
  assert.equal(safeLocalGitDecision('git checkout -b feat/y', 'main'), 'auto');
});

test('ASK: nhánh chính bất khả xâm phạm', () => {
  for (const b of ['main', 'master', 'develop', 'staging', 'release/1.2', 'production']) {
    assert.equal(safeLocalGitDecision('git add .', b), 'ask', b);
    assert.equal(safeLocalGitDecision('git commit -m "x"', b), 'ask', b);
  }
  assert.equal(onFeature('git checkout -b main'), 'ask');
  assert.equal(onFeature('git switch -c release/2.0'), 'ask');
});

test('ASK: đổi sang nhánh CÓ SẴN, detached HEAD, ngoài repo', () => {
  assert.equal(onFeature('git checkout main'), 'ask');
  assert.equal(onFeature('git checkout feat/khac'), 'ask');
  assert.equal(onFeature('git switch develop'), 'ask');
  assert.equal(safeLocalGitDecision('git add .', null), 'ask');
});

test('ASK: viết lại lịch sử / bỏ hook / tương tác / thiếu message', () => {
  assert.equal(onFeature('git commit --amend -m "x"'), 'ask');
  assert.equal(onFeature('git commit -m "x" --no-verify'), 'ask');
  assert.equal(onFeature('git commit -nm "x"'), 'ask');
  assert.equal(onFeature('git commit'), 'ask');       // mở editor → treo phiên
  assert.equal(onFeature('git add -p'), 'ask');       // interactive
  assert.equal(onFeature('git add -i'), 'ask');
  assert.equal(onFeature('git add'), 'ask');          // không path
});

test('ASK: mọi git khác + mưu nối lệnh/biến', () => {
  assert.equal(onFeature('git push origin HEAD'), 'ask');
  assert.equal(onFeature('git reset --hard'), 'ask');
  assert.equal(onFeature('git rebase main'), 'ask');
  assert.equal(onFeature('git branch -D feat/x'), 'ask');
  assert.equal(onFeature('git add . && git push'), 'ask');
  assert.equal(onFeature('git commit -m "x"; rm -rf /'), 'ask');
  assert.equal(onFeature('git commit -m "$(cat /etc/passwd)"'), 'ask');
  assert.equal(onFeature('git add . > /tmp/x'), 'ask');
  assert.equal(onFeature('npm test'), 'ask');
  assert.equal(onFeature('git commit -m "nháy hở'), 'ask');
});
