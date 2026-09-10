/**
 * Test bảng đấu. Dùng BOW_DUEL_SCORES trỏ vào file tạm nên KHÔNG đụng bảng điểm thật.
 * Chạy: `node --import tsx --test src/core/duelScore.test.ts`.
 */
import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countConcessions,
  countDisputesWon,
  loadScores,
  pointsForSide,
  recordMatch,
  POINTS,
} from './duelScore.js';

const sandbox = mkdtempSync(join(tmpdir(), 'bow-scores-'));
let counter = 0;
beforeEach(() => {
  // Mỗi test một file riêng — không test nào thấy điểm của test khác.
  process.env.BOW_DUEL_SCORES = join(sandbox, `scores-${counter++}.json`);
});
after(() => {
  delete process.env.BOW_DUEL_SCORES;
  rmSync(sandbox, { recursive: true, force: true });
});

test('countConcessions chỉ đếm dấu đầu dòng NHẬN SAI, không quét văn xuôi', () => {
  const rebuttal = [
    'TỔNG: 2 nhận / 1 giữ',
    '',
    'TỪNG ĐIỂM:',
    '- [NHẬN SAI] off-by-one ở dòng 42',
    '  Bằng chứng: a.dart:42',
    '- [GIỮ NGUYÊN] reviewer nhầm chỗ này',
    '- [NHẬN SAI] thiếu test',
  ].join('\n');
  assert.equal(countConcessions(rebuttal), 2);
  // Câu phủ định trong văn xuôi KHÔNG được tính là nhận sai.
  assert.equal(countConcessions('Tôi KHÔNG nhận sai điểm này vì reviewer đọc nhầm file.'), 0);
  assert.equal(countConcessions(null), 0);
  assert.equal(countConcessions(''), 0);
});

test('countDisputesWon đọc bảng điểm bất đồng của trọng tài theo từng bên', () => {
  const verdict = [
    'CHỌN: A',
    '',
    'ĐIỂM BẤT ĐỒNG:',
    '- nguyên nhân crash → ĐÚNG: A — log dòng 88 chứng minh',
    '- chỗ đặt validate → ĐÚNG: B — B dẫn được test',
    '- cách đặt tên → ĐÚNG: chưa rõ',
  ].join('\n');
  assert.equal(countDisputesWon(verdict, 'A'), 1);
  assert.equal(countDisputesWon(verdict, 'B'), 1);
  // "chưa rõ" không cho ai điểm.
  assert.equal(countDisputesWon('ĐÚNG: chưa rõ', 'A'), 0);
  assert.equal(countDisputesWon(null, 'A'), 0);
});

test('pointsForSide cộng đúng ba khoản', () => {
  assert.equal(pointsForSide({ isWinner: true, disputesWon: 2, concessions: 1 }), POINTS.win + 2 + 1);
  assert.equal(pointsForSide({ isWinner: false, disputesWon: 0, concessions: 0 }), 0);
  // Thua vẫn có điểm nếu thắng điểm bất đồng và dám nhận sai — chủ ý, xem đầu duelScore.ts.
  assert.equal(pointsForSide({ isWinner: false, disputesWon: 1, concessions: 3 }), 4);
});

test('recordMatch cộng dồn qua nhiều trận và giữ chuỗi thắng/thua', () => {
  const play = (winner: 'A' | 'B' | null) =>
    recordMatch({
      ticket: 'T-1',
      cwd: '/repo',
      winner,
      verdictText: 'ĐIỂM BẤT ĐỒNG:\n- x → ĐÚNG: A',
      sides: [
        { side: 'A', id: 'anthropic', label: 'Claude', rebuttal: '- [NHẬN SAI] y', changedFiles: 3, committed: true },
        { side: 'B', id: 'grok', label: 'Grok', rebuttal: null, changedFiles: 2, committed: true },
      ],
    });

  const first = play('A');
  const a = first.find((d) => d.side === 'A')!;
  // thắng 3 + 1 điểm bất đồng + 1 nhận sai
  assert.equal(a.points, POINTS.win + 1 + 1);
  assert.equal(a.isWinner, true);
  assert.equal(a.streak, 1);
  assert.ok(a.newBadges.some((b) => b.code === 'first-win'), 'thắng trận đầu phải mở huy hiệu');
  const b = first.find((d) => d.side === 'B')!;
  assert.equal(b.points, 0);
  assert.equal(b.streak, -1);

  play('A');
  const third = play('A');
  const a3 = third.find((d) => d.side === 'A')!;
  assert.equal(a3.streak, 3);
  assert.ok(a3.newBadges.some((bd) => bd.code === 'streak-3'), 'chuỗi 3 phải mở huy hiệu, và chỉ mở MỘT lần');

  const fourth = play('A');
  assert.equal(fourth.find((d) => d.side === 'A')!.newBadges.some((bd) => bd.code === 'streak-3'), false);

  const store = loadScores();
  assert.equal(store.players.anthropic.wins, 4);
  assert.equal(store.players.grok.losses, 4);
  assert.equal(store.players.anthropic.points, (POINTS.win + 2) * 4);
  assert.equal(store.matches.length, 4);
});

test('trận hoà (trọng tài không chọn ai) reset chuỗi và không cộng điểm thắng', () => {
  recordMatch({
    ticket: 'T-2',
    cwd: '/repo',
    winner: null,
    verdictText: 'CHỌN: KHÔNG',
    sides: [
      { side: 'A', id: 'anthropic', label: 'Claude', rebuttal: '- [NHẬN SAI] z', changedFiles: 1, committed: true },
      { side: 'B', id: 'grok', label: 'Grok', rebuttal: null, changedFiles: 1, committed: false },
    ],
  });
  const store = loadScores();
  assert.equal(store.players.anthropic.draws, 1);
  assert.equal(store.players.anthropic.wins, 0);
  assert.equal(store.players.anthropic.points, POINTS.concession);
  assert.equal(store.players.anthropic.streak, 0);
  assert.equal(store.players.grok.points, 0);
});

test('file bảng điểm hỏng không làm chết việc ghi trận mới', () => {
  const path = process.env.BOW_DUEL_SCORES!;
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(path, '{ đây không phải json', 'utf8');
  assert.deepEqual(loadScores().players, {});
  const deltas = recordMatch({
    ticket: 'T-3',
    cwd: '/repo',
    winner: 'B',
    verdictText: null,
    sides: [
      { side: 'A', id: 'anthropic', label: 'Claude', rebuttal: null, changedFiles: 0, committed: false },
      { side: 'B', id: 'grok', label: 'Grok', rebuttal: null, changedFiles: 4, committed: true },
    ],
  });
  assert.equal(deltas.find((d) => d.side === 'B')!.points, POINTS.win);
  assert.equal(loadScores().players.grok.wins, 1);
});
