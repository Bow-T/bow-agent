/**
 * Test cho lưới an toàn autopilot (checkpoint + journal). Import code THẬT, dựng repo git tạm,
 * assert hành vi quan sát được (baseSHA/snapshotSHA/ref/journal/khôi phục). Không mock git.
 * Chạy: `node --import tsx --test src/core/checkpoint.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

// Ép journal ra thư mục tạm TRƯỚC mọi lời gọi (journalDir đọc env lazy nên import tĩnh vẫn an toàn).
const JOURNAL_TMP = mkdtempSync(join(tmpdir(), 'bow-journal-'));
process.env.BOW_JOURNAL_DIR = JOURNAL_TMP;

const { createCheckpoint, appendJournal, journalPath, restoreInstructions } = await import('./checkpoint.js');

const tmpDirs: string[] = [JOURNAL_TMP];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Repo git tạm có 1 commit; identity gắn qua config để không phụ thuộc git toàn cục. */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bow-cp-'));
  tmpDirs.push(dir);
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@bow.local']);
  git(dir, ['config', 'user.name', 'Bow Test']);
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

test('repo không phải git → git:false và hướng dẫn cảnh báo, không lưới hoàn tác', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bow-nogit-'));
  tmpDirs.push(dir);
  const cp = createCheckpoint(dir, 'id-nogit');
  assert.equal(cp.git, false);
  assert.equal(cp.baseSHA, undefined);
  assert.match(restoreInstructions(cp), /không phải git repo/);
});

test('git repo sạch → baseSHA = HEAD, có branch, snapshotSHA là commit hợp lệ', () => {
  const dir = makeGitRepo();
  const head = git(dir, ['rev-parse', 'HEAD']);
  const cp = createCheckpoint(dir, 'id-clean');
  assert.equal(cp.git, true);
  assert.equal(cp.baseSHA, head);
  assert.ok(cp.branch && cp.branch.length > 0);
  assert.ok(cp.snapshotSHA, 'phải chụp được snapshot worktree');
  assert.equal(git(dir, ['cat-file', '-t', cp.snapshotSHA!]), 'commit');
});

test('snapshot chụp cả file UNTRACKED và được pin qua ref refs/bow/autopilot/<id>', () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, 'untracked.txt'), 'file mới chưa add\n'); // untracked — stash create sẽ bỏ sót
  const cp = createCheckpoint(dir, 'id-untracked');
  assert.ok(cp.snapshotSHA);
  // ref pin đúng snapshot (git không GC mất).
  assert.equal(git(dir, ['rev-parse', 'refs/bow/autopilot/id-untracked']), cp.snapshotSHA);
  // snapshot PHẢI chứa untracked.txt (bằng chứng bắt được file chưa add).
  const listed = git(dir, ['ls-tree', '--name-only', cp.snapshotSHA!]);
  assert.ok(listed.split('\n').includes('untracked.txt'), 'snapshot phải chứa file untracked');
  // checkpoint KHÔNG đụng worktree: file vẫn nguyên.
  assert.equal(readFileSync(join(dir, 'untracked.txt'), 'utf8'), 'file mới chưa add\n');
});

test('chu trình khôi phục đầy đủ: reset baseSHA + checkout snapshot phục hồi cả untracked lẫn sửa đổi', () => {
  const dir = makeGitRepo();
  // Trạng thái trước autopilot: sửa file tracked (chưa commit) + thêm file untracked.
  writeFileSync(join(dir, 'a.txt'), 'edited-uncommitted\n');
  writeFileSync(join(dir, 'wip.txt'), 'WIP untracked\n');
  const cp = createCheckpoint(dir, 'id-cycle');

  // Agent "làm sai": ghi đè tùm lum, xoá wip, và commit.
  writeFileSync(join(dir, 'a.txt'), 'BROKEN\n');
  rmSync(join(dir, 'wip.txt'));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'bad autopilot change']);

  // Khôi phục theo đúng restoreInstructions.
  git(dir, ['reset', '--hard', cp.baseSHA!]);
  git(dir, ['checkout', cp.snapshotSHA!, '--', '.']);

  // a.txt trở lại đúng bản CHECKPOINT (bản sửa chưa commit), commit bậy biến mất, wip.txt sống lại.
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'edited-uncommitted\n');
  assert.equal(readFileSync(join(dir, 'wip.txt'), 'utf8'), 'WIP untracked\n');
  assert.equal(git(dir, ['log', '--oneline']).split('\n').length, 1); // chỉ còn commit init
});

test('restoreInstructions nêu đúng lệnh reset baseSHA + checkout snapshot', () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, 'a.txt'), 'x\n');
  const cp = createCheckpoint(dir, 'id-restore');
  const hint = restoreInstructions(cp);
  assert.match(hint, new RegExp(`git reset --hard ${cp.baseSHA}`));
  assert.match(hint, new RegExp(`git checkout ${cp.snapshotSHA} -- \\.`));
  assert.match(hint, /cd /);
});

test('appendJournal ghi JSONL parse được, có ts + kind; checkpoint được ghi lần tạo', () => {
  const dir = makeGitRepo();
  createCheckpoint(dir, 'id-journal'); // tự ghi 1 dòng kind:checkpoint
  appendJournal('id-journal', { kind: 'tool', tool: 'Edit', target: 'lib/x.dart' });
  appendJournal('id-journal', { kind: 'note', message: 'done' });

  const p = journalPath('id-journal');
  assert.ok(existsSync(p));
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  const parsed = lines.map((l) => JSON.parse(l));
  for (const e of parsed) assert.ok(typeof e.ts === 'string' && e.ts.length > 0);
  assert.equal(parsed[0].kind, 'checkpoint');
  assert.equal(parsed[1].kind, 'tool');
  assert.equal(parsed[1].tool, 'Edit');
  assert.equal(parsed[1].target, 'lib/x.dart');
  assert.equal(parsed[2].kind, 'note');
});
