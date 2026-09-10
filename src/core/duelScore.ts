/**
 * BẢNG ĐẤU — điểm và thành tích của hai AI qua các trận duel.
 *
 * VÌ SAO có: điểm KHÔNG khích lệ được model (không AI nào nhớ trận trước, không ai "muốn" thắng).
 * Giá trị thật nằm ở phía người dùng: sau vài chục trận sẽ thấy AI nào thắng loại task nào, để
 * chọn AI mặc định cho đúng việc và biết khi nào duel đáng tiền.
 *
 * VÌ SAO điểm KHÔNG bao giờ được nhồi vào prompt: hai bên phải vào trận với brief y hệt nhau,
 * nếu không phép so mất tính công bằng. Riêng với pha đối chất còn tệ hơn — biết mình sắp mất
 * điểm thì model sẽ cãi cố thay vì nhận sai, phá đúng thứ pha đó sinh ra để làm.
 *
 * VÌ SAO thưởng cả việc NHẬN SAI: chỉ thưởng thắng thì cả hai học được đúng một bài — không bao
 * giờ nhận sai — và đối chất biến thành cãi lộn.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Điểm cho mỗi loại thành tích trong một trận. */
export const POINTS = {
  /** Trọng tài chọn bài của mình. */
  win: 3,
  /** Mỗi điểm bất đồng được trọng tài xử cho mình. */
  dispute: 1,
  /** Mỗi lần tự nhận sai trong đối chất — thưởng sự thành thật, xem đầu file. */
  concession: 1,
} as const;

export interface PlayerStats {
  /** Khóa ổn định: id provider ('anthropic' | 'grok'). */
  id: string;
  /** Nhãn hiển thị lần gần nhất ('Claude', 'Grok'). */
  label: string;
  matches: number;
  wins: number;
  losses: number;
  /** Trận trọng tài không chọn bên nào. */
  draws: number;
  points: number;
  disputesWon: number;
  concessions: number;
  /** Chuỗi hiện tại: dương = thắng liên tiếp, âm = thua liên tiếp. */
  streak: number;
  bestStreak: number;
  /** Huy hiệu đã mở (mã, xem BADGES). */
  badges: string[];
  lastPlayedAt: string;
}

export interface MatchSideRecord {
  side: 'A' | 'B';
  id: string;
  label: string;
  points: number;
  disputesWon: number;
  concessions: number;
  changedFiles: number;
  committed: boolean;
}

export interface MatchRecord {
  at: string;
  ticket: string;
  /** Repo diễn ra trận — để lọc thống kê theo dự án. */
  cwd: string;
  winner: 'A' | 'B' | null;
  sides: MatchSideRecord[];
}

export interface ScoreStore {
  version: 1;
  players: Record<string, PlayerStats>;
  /** Lịch sử trận, mới nhất ở cuối. Giữ tối đa MAX_MATCHES. */
  matches: MatchRecord[];
}

/** Huy hiệu — "món quà nhỏ" sau mỗi trận. Điều kiện tính trên thống kê tích lũy. */
export const BADGES: { code: string; icon: string; label: string; hint: string; earned: (p: PlayerStats) => boolean }[] = [
  { code: 'first-win', icon: '🌱', label: 'Trận đầu', hint: 'Thắng trận duel đầu tiên', earned: (p) => p.wins >= 1 },
  { code: 'streak-3', icon: '🔥', label: 'Ba trận liền', hint: 'Thắng 3 trận liên tiếp', earned: (p) => p.bestStreak >= 3 },
  { code: 'streak-5', icon: '⚡', label: 'Năm trận liền', hint: 'Thắng 5 trận liên tiếp', earned: (p) => p.bestStreak >= 5 },
  { code: 'sniper', icon: '🎯', label: 'Thiện xạ', hint: 'Thắng 10 điểm bất đồng', earned: (p) => p.disputesWon >= 10 },
  { code: 'fair-play', icon: '🤝', label: 'Quân tử', hint: 'Tự nhận sai 10 lần trong đối chất', earned: (p) => p.concessions >= 10 },
  { code: 'century', icon: '💯', label: 'Trăm điểm', hint: 'Tích lũy 100 điểm', earned: (p) => p.points >= 100 },
  { code: 'veteran', icon: '🎖️', label: 'Lão làng', hint: 'Đánh 25 trận', earned: (p) => p.matches >= 25 },
];

const MAX_MATCHES = 200;

export function scoreStorePath(): string {
  return process.env.BOW_DUEL_SCORES ?? join(homedir(), '.bow-agent', 'duel-scores.json');
}

function emptyStore(): ScoreStore {
  return { version: 1, players: {}, matches: [] };
}

export function loadScores(): ScoreStore {
  const path = scoreStorePath();
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ScoreStore;
    if (!parsed || parsed.version !== 1 || typeof parsed.players !== 'object') return emptyStore();
    return { version: 1, players: parsed.players ?? {}, matches: Array.isArray(parsed.matches) ? parsed.matches : [] };
  } catch {
    // File hỏng (sửa tay, ghi dở) → coi như chưa có. Bảng điểm hỏng KHÔNG được làm chết trận đấu.
    return emptyStore();
  }
}

export function saveScores(store: ScoreStore): void {
  const path = scoreStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

/**
 * Đếm số lần một bên TỰ NHẬN SAI trong bản đối chất của mình. Chỉ tính dấu đầu dòng theo khuôn
 * `- [NHẬN SAI] …` — nếu quét cả văn xuôi thì câu "tôi KHÔNG nhận sai điểm này" cũng bị tính.
 */
export function countConcessions(rebuttal: string | null | undefined): number {
  if (!rebuttal) return 0;
  const matches = rebuttal.match(/^\s*[-*]\s*\[?\s*NH[ẬA]N\s+SAI/gim);
  return matches ? matches.length : 0;
}

/**
 * Đếm số điểm bất đồng trọng tài xử cho một phía, đọc từ bảng `ĐIỂM BẤT ĐỒNG` trong phán quyết
 * (`… → ĐÚNG: A`). Trọng tài ghi "chưa rõ" thì không ai được điểm.
 */
export function countDisputesWon(verdictText: string | null | undefined, side: 'A' | 'B'): number {
  if (!verdictText) return 0;
  const matches = verdictText.match(/Đ[ÚU]NG\s*:\s*\*{0,2}\s*([AB])\b/gi);
  if (!matches) return 0;
  return matches.filter((m) => m.trim().toUpperCase().endsWith(side)).length;
}

/** Điểm một phía ăn được trong MỘT trận. */
export function pointsForSide(params: { isWinner: boolean; disputesWon: number; concessions: number }): number {
  return (
    (params.isWinner ? POINTS.win : 0) +
    params.disputesWon * POINTS.dispute +
    params.concessions * POINTS.concession
  );
}

function blankPlayer(id: string, label: string): PlayerStats {
  return {
    id,
    label,
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    points: 0,
    disputesWon: 0,
    concessions: 0,
    streak: 0,
    bestStreak: 0,
    badges: [],
    lastPlayedAt: new Date().toISOString(),
  };
}

/** Một phía sau trận, đủ dữ liệu để chấm điểm. */
export interface SideResultInput {
  side: 'A' | 'B';
  /** id provider ('anthropic' | 'grok') — khóa ổn định của người chơi. */
  id: string;
  label: string;
  rebuttal: string | null;
  changedFiles: number;
  committed: boolean;
}

export interface ScoreDelta {
  side: 'A' | 'B';
  id: string;
  label: string;
  points: number;
  disputesWon: number;
  concessions: number;
  isWinner: boolean;
  /** Huy hiệu MỚI mở ở trận này (chỉ cái mới — cái cũ đã nằm trong stats.badges). */
  newBadges: { code: string; icon: string; label: string; hint: string }[];
  /** Tổng điểm sau trận. */
  totalPoints: number;
  streak: number;
}

/**
 * Ghi nhận kết quả một trận vào bảng đấu và trả về phần điểm vừa ăn của từng phía.
 * KHÔNG ném: bảng điểm hỏng không được làm hỏng trận (mọi thứ thật đã nằm trong git rồi).
 */
export function recordMatch(params: {
  ticket: string;
  cwd: string;
  winner: 'A' | 'B' | null;
  verdictText: string | null;
  sides: SideResultInput[];
}): ScoreDelta[] {
  const store = loadScores();
  const at = new Date().toISOString();
  const deltas: ScoreDelta[] = [];
  const record: MatchRecord = { at, ticket: params.ticket, cwd: params.cwd, winner: params.winner, sides: [] };

  for (const side of params.sides) {
    const isWinner = params.winner === side.side;
    const disputesWon = countDisputesWon(params.verdictText, side.side);
    const concessions = countConcessions(side.rebuttal);
    const points = pointsForSide({ isWinner, disputesWon, concessions });

    const player = store.players[side.id] ?? blankPlayer(side.id, side.label);
    player.label = side.label;
    player.matches += 1;
    player.points += points;
    player.disputesWon += disputesWon;
    player.concessions += concessions;
    player.lastPlayedAt = at;
    if (params.winner === null) {
      player.draws += 1;
      player.streak = 0;
    } else if (isWinner) {
      player.wins += 1;
      player.streak = player.streak > 0 ? player.streak + 1 : 1;
      player.bestStreak = Math.max(player.bestStreak, player.streak);
    } else {
      player.losses += 1;
      player.streak = player.streak < 0 ? player.streak - 1 : -1;
    }

    const newBadges = BADGES.filter((b) => !player.badges.includes(b.code) && b.earned(player));
    player.badges.push(...newBadges.map((b) => b.code));
    store.players[side.id] = player;

    deltas.push({
      side: side.side,
      id: side.id,
      label: side.label,
      points,
      disputesWon,
      concessions,
      isWinner,
      newBadges: newBadges.map(({ code, icon, label, hint }) => ({ code, icon, label, hint })),
      totalPoints: player.points,
      streak: player.streak,
    });
    record.sides.push({
      side: side.side,
      id: side.id,
      label: side.label,
      points,
      disputesWon,
      concessions,
      changedFiles: side.changedFiles,
      committed: side.committed,
    });
  }

  store.matches.push(record);
  if (store.matches.length > MAX_MATCHES) store.matches = store.matches.slice(-MAX_MATCHES);
  try {
    saveScores(store);
  } catch {
    // Ghi hỏng (đĩa đầy, quyền) → vẫn trả delta để UI hiện được trận này.
  }
  return deltas;
}
