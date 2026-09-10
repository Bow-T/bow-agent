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
  commitSideWork,
  dirtyFileCount,
  buildKeepBrief,
  buildRebuttalBrief,
  buildReviewBrief,
  buildVerdictBrief,
  collectDiff,
  duelWorktreeTicket,
  parseVerdictWinner,
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

test('parseVerdictWinner đọc được dòng CHỌN ở mọi kiểu định dạng model hay trả', () => {
  assert.equal(parseVerdictWinner('CHỌN: A\n\nVÌ SAO: ...'), 'A');
  assert.equal(parseVerdictWinner('**CHỌN: B**\n'), 'B');
  assert.equal(parseVerdictWinner('  chọn : b '), 'B');
  // Không dấu (model trả ASCII) vẫn đọc được.
  assert.equal(parseVerdictWinner('CHON: A'), 'A');
  // Dòng CHỌN nằm sau vài dòng mở đầu.
  assert.equal(parseVerdictWinner('Tôi đã đọc cả hai bài.\nCHỌN: B\nVÌ SAO: ...'), 'B');
});

test('parseVerdictWinner trả null khi trọng tài không chọn bên nào', () => {
  assert.equal(parseVerdictWinner('CHỌN: KHÔNG\n\nVÌ SAO: cả hai đều thiếu'), null);
  // Model trả tự do, không theo khuôn → null, KHÔNG được đoán bừa một bên.
  assert.equal(parseVerdictWinner('Bài của Claude có vẻ ổn hơn một chút.'), null);
  assert.equal(parseVerdictWinner(''), null);
});

test('brief trọng tài nêu cả hai bài, đề bài gốc và khuôn kết quả máy đọc được', () => {
  const brief = buildVerdictBrief({
    task: 'Thêm bộ lọc ngày',
    sides: [
      { label: 'Claude', sideId: 'A', files: ['web/App.tsx'], result: 'xong', review: 'KẾT LUẬN: ĐẠT' },
      { label: 'Grok', sideId: 'B', files: [], error: 'hết hạn mức', result: null, review: null },
    ],
  });
  assert.ok(brief.includes('Thêm bộ lọc ngày'));
  assert.ok(brief.includes('### Phía A — Claude'));
  assert.ok(brief.includes('### Phía B — Grok'));
  assert.ok(brief.includes('⚠️ Chạy LỖI: hết hạn mức'));
  assert.ok(brief.includes('CHỌN: A | B | KHÔNG'));
  // Trọng tài phải được phép nói "cả hai đều chưa đạt", không bị ép chọn.
  assert.ok(brief.includes('không bên nào đạt'));
});

test('brief giữ nhánh nói rõ merge vào đâu và CẤM push/xoá nhánh', () => {
  const brief = buildKeepBrief({
    winnerLabel: 'Grok',
    winnerBranch: 'feat/X-b',
    baseBranch: 'main',
    loserBranch: 'feat/X-a',
    review: 'KẾT LUẬN: ĐẠT',
  });
  assert.ok(brief.includes('feat/X-b'));
  assert.ok(brief.includes('main'));
  assert.ok(brief.includes('KHÔNG push'));
  assert.ok(brief.includes('KHÔNG xoá nhánh nào'));
  // Nhánh thua phải được nêu tên để agent biết cái nào KHÔNG đụng vào.
  assert.ok(brief.includes('feat/X-a'));
});

test('commitSideWork đưa bài của một phía lên nhánh (kể cả file mới)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'bow-duel-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'a.txt'), 'một\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const before = git('rev-list', '--count', 'HEAD').trim();

    writeFileSync(join(repo, 'a.txt'), 'hai\n');
    writeFileSync(join(repo, 'b.txt'), 'mới\n');
    const out = commitSideWork(repo, 'duel(A): T-1 — bài của Claude');

    assert.equal(out.ok, true);
    assert.equal(out.error, undefined);
    assert.equal(Number(git('rev-list', '--count', 'HEAD').trim()), Number(before) + 1);
    assert.equal(git('status', '--porcelain').trim(), '', 'working tree phải sạch sau commit');
    assert.ok(git('log', '-1', '--pretty=%s').includes('duel(A): T-1'));
    // File mới cũng phải nằm trên nhánh, không chỉ file đã track.
    assert.ok(git('show', '--name-only', '--pretty=', 'HEAD').includes('b.txt'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('commitSideWork không coi "chẳng có gì để commit" là lỗi', () => {
  const repo = mkdtempSync(join(tmpdir(), 'bow-duel-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'a.txt'), 'một\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const before = git('rev-list', '--count', 'HEAD').trim();

    const out = commitSideWork(repo, 'duel(B): T-1 — bài của Grok');
    assert.equal(out.ok, true);
    // Không được đẻ commit rỗng.
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), before);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('dirtyFileCount đếm đúng file chưa commit, kể cả file mới', () => {
  const repo = mkdtempSync(join(tmpdir(), 'bow-duel-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'a.txt'), 'một\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    assert.equal(dirtyFileCount(repo), 0, 'repo sạch phải là 0');

    writeFileSync(join(repo, 'a.txt'), 'hai\n');
    writeFileSync(join(repo, 'b.txt'), 'mới\n');
    assert.equal(dirtyFileCount(repo), 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('dirtyFileCount trả 0 (không ném) khi thư mục không phải git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bow-duel-notgit-'));
  try {
    assert.equal(dirtyFileCount(dir), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('brief đối chất bắt trả lời từng điểm bằng bằng chứng, cho phép nhận sai', () => {
  const brief = buildRebuttalBrief({
    task: 'Sửa lỗi đếm ký tự',
    ownLabel: 'Claude',
    opponentLabel: 'Grok',
    reviewOfMe: 'KẾT LUẬN: CẦN SỬA\n- [nặng] app_text_field.dart:42 — off-by-one',
    myFiles: ['apps/mobile/lib/src/components/input/app_text_field.dart'],
  });
  assert.ok(brief.includes('bạn (Claude) trả lời báo cáo của Grok'));
  assert.ok(brief.includes('app_text_field.dart:42 — off-by-one'), 'phải nhồi nguyên báo cáo về mình');
  assert.ok(brief.includes('NHẬN SAI | GIỮ NGUYÊN | CHƯA ĐỦ DỮ LIỆU'));
  assert.ok(brief.includes('Bằng chứng:'));
  // Read-only và không được lái sang chấm ngược bài đối thủ.
  assert.ok(brief.includes('KHÔNG được sửa gì'));
  assert.ok(brief.includes('không chấm ngược lại bài của họ'));
});

test('brief trọng tài nhồi cả phản biện và bắt liệt kê điểm bất đồng', () => {
  const brief = buildVerdictBrief({
    task: 'Tìm nguyên nhân crash',
    sides: [
      { label: 'Claude', sideId: 'A', files: ['a.dart'], result: 'nguyên nhân là X', review: 'CẦN SỬA', rebuttal: 'GIỮ NGUYÊN — a.dart:10' },
      { label: 'Grok', sideId: 'B', files: ['b.dart'], result: 'nguyên nhân là Y', review: 'ĐẠT', rebuttal: null },
    ],
  });
  assert.ok(brief.includes('GIỮ NGUYÊN — a.dart:10'));
  assert.ok(brief.includes('(không phản biện)'), 'bên không phản biện phải ghi rõ, không bỏ trống lặng lẽ');
  assert.ok(brief.includes('ĐIỂM BẤT ĐỒNG'));
  // Luật xử: bằng chứng thắng hùng biện.
  assert.ok(brief.includes('BẰNG CHỨNG, không theo giọng văn'));
  assert.ok(brief.includes('HAI NGUYÊN NHÂN khác nhau'));
});
