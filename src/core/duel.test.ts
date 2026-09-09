/**
 * Test lõi duel. Phần THUẦN (tên worktree, cắt diff, dựng brief) không chạm đĩa; riêng
 * collectDiff chạy trên một repo git TẠM tự dựng trong thư mục tmp rồi xoá.
 * Chạy: `node --import tsx --test src/core/duel.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFixBrief,
  buildReviewBrief,
  collectDiff,
  duelWorktreeTicket,
  truncateDiff,
  MAX_DIFF_CHARS,
} from './duel.js';

test('tên worktree tách hai phía, chữ thường', () => {
  assert.equal(duelWorktreeTicket('DUOCT-123', 'A'), 'DUOCT-123-a');
  assert.equal(duelWorktreeTicket('DUOCT-123', 'B'), 'DUOCT-123-b');
});

test('truncateDiff giữ nguyên diff ngắn', () => {
  const short = 'diff --git a/x b/x\n+1';
  const out = truncateDiff(short);
  assert.equal(out.text, short);
  assert.equal(out.truncated, false);
});

test('truncateDiff cắt diff dài và báo số ký tự còn lại', () => {
  const long = 'x'.repeat(MAX_DIFF_CHARS + 500);
  const out = truncateDiff(long);
  assert.equal(out.truncated, true);
  assert.ok(out.text.startsWith('x'.repeat(100)));
  assert.ok(out.text.includes('còn 500 ký tự nữa'));
  // Không được phình to hơn bản gốc.
  assert.ok(out.text.length < long.length);
});

test('brief review nêu đủ đề bài, hai nhãn, danh sách file và khuôn kết quả', () => {
  const brief = buildReviewBrief({
    task: 'Thêm bộ lọc ngày cho lịch sử',
    reviewerLabel: 'Grok',
    authorLabel: 'Claude',
    diff: 'diff --git a/web/App.tsx b/web/App.tsx',
    files: ['web/App.tsx'],
    summary: 'Đã sửa 1 file.',
  });
  assert.ok(brief.includes('bạn (Grok) soi bài của Claude'));
  assert.ok(brief.includes('Thêm bộ lọc ngày cho lịch sử'));
  assert.ok(brief.includes('- web/App.tsx'));
  assert.ok(brief.includes('Đã sửa 1 file.'));
  assert.ok(brief.includes('KẾT LUẬN: ĐẠT | CẦN SỬA'));
  // Reviewer phải biết mình đang read-only.
  assert.ok(brief.includes('KHÔNG sửa file'));
});

test('brief review bỏ mục tổng kết khi bên kia không trả text', () => {
  const brief = buildReviewBrief({
    task: 'T',
    reviewerLabel: 'Grok',
    authorLabel: 'Claude',
    diff: '',
    files: [],
    summary: null,
  });
  assert.ok(!brief.includes('Bên kia tự tổng kết'));
  assert.ok(brief.includes('(không có file nào đổi)'));
});

test('brief sửa theo review cho phép phản biện, không sửa lấy lệ', () => {
  const brief = buildFixBrief({ reviewerLabel: 'Grok', review: 'KẾT LUẬN: CẦN SỬA' });
  assert.ok(brief.includes('Sửa theo review của Grok'));
  assert.ok(brief.includes('KẾT LUẬN: CẦN SỬA'));
  assert.ok(brief.includes('KHÔNG sửa nếu bạn cho rằng'));
});

test('collectDiff thấy cả file đã sửa lẫn file mới chưa track', () => {
  const repo = mkdtempSync(join(tmpdir(), 'bow-duel-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'a.txt'), 'một\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const baseSha = git('rev-parse', 'HEAD').trim();

    // Một file sửa (chưa commit), một file mới hoàn toàn (untracked), một file trong thư mục con.
    writeFileSync(join(repo, 'a.txt'), 'hai\n');
    writeFileSync(join(repo, 'b.txt'), 'mới\n');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/c.ts'), 'export const c = 1;\n');

    const out = collectDiff(repo, baseSha);
    assert.deepEqual(out.files.sort(), ['a.txt', 'b.txt', 'src/c.ts']);
    assert.ok(out.diff.includes('+hai'));
    assert.ok(out.diff.includes('+mới'));
    assert.ok(out.diff.includes('export const c = 1;'));
    assert.equal(out.truncated, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('collectDiff trả rỗng khi không có thay đổi', () => {
  const repo = mkdtempSync(join(tmpdir(), 'bow-duel-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'a.txt'), 'một\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const out = collectDiff(repo, git('rev-parse', 'HEAD').trim());
    assert.deepEqual(out.files, []);
    assert.equal(out.diff, '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
