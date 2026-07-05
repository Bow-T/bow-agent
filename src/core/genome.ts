import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { profileNameFromCwd } from '../profiles/generate.js';

/**
 * GENOME — "ADN sống" của bow-agent.
 *
 * Ý tưởng (ẩn dụ sinh học, xem bàn luận thiết kế): profile dự án hiện tại là TĨNH
 * (sinh 1 lần rồi đóng băng). Genome là phần tri thức ĐỘNG: mỗi task để lại "gen"
 * (trait) — một điều đã học về repo — kèm điểm sức khỏe (fitness). Trước mỗi task,
 * gen khỏe nhất được "biểu hiện" (express) vào system prompt để agent làm tốt hơn
 * lần trước. Sau task, chọn lọc + đột biến cập nhật lại genome (bước 3–4, chưa làm ở
 * file này).
 *
 * File này CHỈ lo tầng lưu trữ + biểu hiện (bước 1–2):
 *  - đọc/ghi genome theo repo (JSON trong memory/genome/<repo>.json),
 *  - biến traits thành một đoạn prompt để nhồi vào system prompt.
 * Nó thuần dữ liệu — không gọi model, không phụ thuộc runner — nên test/độc lập dễ.
 */

/** Một "gen": một điều agent đã học về repo, kèm điểm sức khỏe. */
export interface Gene {
  /** Định danh ổn định trong 1 genome (vd "g1"). */
  id: string;
  /** Nội dung tri thức (1 câu, thực tế, dùng lại được). */
  gene: string;
  /**
   * Sức khỏe 0..1: gen giúp task thành công/hiệu quả tới đâu. Gen tụt dưới ngưỡng
   * qua nhiều thế hệ sẽ bị đào thải (bước 4). Gen mới sinh khởi tạo trung tính.
   */
  fitness: number;
  /** Thế hệ gen ra đời (để lần vết + đào thải theo tuổi). */
  bornGen: number;
  /** Số lần gen được biểu hiện vào prompt (dùng để tính lại fitness sau này). */
  usedCount: number;
}

/** Một dòng lịch sử: kết quả một task, dùng làm áp lực chọn lọc. */
export interface HistoryEntry {
  gen: number;
  /** Nhãn task (Jira key / mô tả ngắn) — để đọc, không dùng để tính. */
  task: string;
  success: boolean;
  turns: number;
  outputTokens: number;
  /** Id các gen đã BIỂU HIỆN vào prompt task này — dùng để gán công/tội (fitness). */
  expressedIds?: string[];
  /** Sau này: người dùng có sửa tay không (signal chất lượng mạnh nhất). */
  userEdits?: number;
}

/** Toàn bộ ADN của một repo. */
export interface Genome {
  /** Repo path đã chuẩn hóa (khóa nhận dạng). */
  repo: string;
  /** Số thế hệ đã trải qua (mỗi task hoàn tất = +1). */
  generation: number;
  traits: Gene[];
  history: HistoryEntry[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Thư mục chứa genome (một file JSON / repo). Nằm trong memory/ theo quy ước dự án. */
export const GENOME_DIR = join(__dirname, '..', '..', 'memory', 'genome');

/** Số gen tối đa được biểu hiện vào prompt mỗi task (chọn theo fitness giảm dần). */
const MAX_EXPRESSED = 12;

/** Số gen mới tối đa nhận vào mỗi lần đột biến (đột biến có kiểm soát, chống phình). */
const MAX_NEW_PER_MUTATION = 3;

/** Fitness khởi tạo cho gen mới: trung tính, để chọn lọc (bước 4) tự nâng/hạ sau. */
const INITIAL_FITNESS = 0.6;

/** Tổng số gen tối đa một genome giữ (chặn phình vô hạn; gen yếu nhất bị đẩy ra). */
const MAX_TRAITS = 40;

/** Đường dẫn file genome cho một repo (khóa = tên chuẩn hóa từ cwd). */
function genomePath(cwd: string): string {
  return join(GENOME_DIR, `${profileNameFromCwd(cwd)}.json`);
}

/** Genome rỗng cho repo chưa có ADN. */
function emptyGenome(cwd: string): Genome {
  return { repo: cwd, generation: 0, traits: [], history: [] };
}

/**
 * Đọc genome của repo. Chưa có / hỏng → trả genome rỗng (không ném lỗi: thiếu ADN
 * chỉ nghĩa là "chưa học gì", không phải lỗi chặn task).
 */
export function loadGenome(cwd: string): Genome {
  const file = genomePath(cwd);
  if (!existsSync(file)) return emptyGenome(cwd);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Genome>;
    return {
      repo: parsed.repo ?? cwd,
      generation: parsed.generation ?? 0,
      traits: Array.isArray(parsed.traits) ? parsed.traits : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    // JSON hỏng: coi như chưa có ADN thay vì làm hỏng cả task.
    return emptyGenome(cwd);
  }
}

/** Ghi genome xuống disk (tạo thư mục nếu cần). */
export function saveGenome(genome: Genome): void {
  mkdirSync(GENOME_DIR, { recursive: true });
  writeFileSync(genomePath(genome.repo), JSON.stringify(genome, null, 2), 'utf8');
}

/** Số dòng history giữ lại (cắt bớt cái cũ để file không phình vô hạn). */
const MAX_HISTORY = 200;

/**
 * CHỌN LỌC (bước ghi nhận): sau một task đã CHẠY THẬT (execute), ghi kết quả vào
 * history và +1 thế hệ. Đây là "áp lực chọn lọc" ở dạng dữ liệu thô — bước mutation
 * (bước 3) và đào thải (bước 4) sẽ đọc history này để quyết gen nào sống/chết.
 *
 * Chỉ nên gọi cho mode execute: một lần chỉ-lập-kế-hoạch chưa tạo ra hệ quả đúng/sai
 * nên không tính là một "thế hệ". Đọc → cập nhật → ghi (tải lại từ disk để không đè
 * mất thay đổi của tiến trình khác).
 */
export function recordTaskOutcome(
  cwd: string,
  outcome: Omit<HistoryEntry, 'gen'>,
): Genome {
  const genome = loadGenome(cwd);
  genome.generation += 1;
  genome.history.push({ gen: genome.generation, ...outcome });
  // Giữ history gọn: chỉ lưu MAX_HISTORY dòng gần nhất.
  if (genome.history.length > MAX_HISTORY) {
    genome.history = genome.history.slice(-MAX_HISTORY);
  }
  saveGenome(genome);
  return genome;
}

/** Chuẩn hóa một câu gen để so trùng: bỏ dấu câu/khoảng trắng thừa, về chữ thường. */
function normGene(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,;:!?()"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ĐỘT BIẾN (mutation): nhét các câu gen mới (do lượt phản tư sinh ra) vào genome.
 * Thuần dữ liệu — không gọi model. Kiểm soát chặt để genome không phình/loãng:
 *  - chỉ nhận tối đa MAX_NEW_PER_MUTATION câu mỗi lần,
 *  - bỏ câu rỗng và câu TRÙNG (so chuẩn hóa) với gen đã có hoặc gen vừa thêm,
 *  - gen mới nhận fitness trung tính INITIAL_FITNESS (không cho tự đặt điểm),
 *  - nếu vượt MAX_TRAITS, đẩy gen fitness thấp nhất ra (chọn lọc theo sức khỏe).
 * Trả genome đã cập nhật (chưa tự ghi disk — caller quyết định lúc save).
 */
export function mutateGenome(genome: Genome, newGenes: string[]): Genome {
  const seen = new Set(genome.traits.map((g) => normGene(g.gene)));
  // id kế tiếp: dựa trên số lớn nhất đã dùng, tránh trùng khi gen cũ bị xóa.
  let nextNum = genome.traits.reduce((max, g) => {
    const n = Number.parseInt(g.id.replace(/^g/, ''), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);

  const accepted: Gene[] = [];
  for (const raw of newGenes) {
    if (accepted.length >= MAX_NEW_PER_MUTATION) break;
    const gene = raw.trim();
    const key = normGene(gene);
    if (!key || seen.has(key)) continue; // rỗng hoặc trùng → bỏ
    seen.add(key);
    accepted.push({
      id: `g${++nextNum}`,
      gene,
      fitness: INITIAL_FITNESS,
      bornGen: genome.generation,
      usedCount: 0,
    });
  }

  genome.traits.push(...accepted);

  // Chặn phình: giữ MAX_TRAITS gen khỏe nhất, đẩy gen yếu nhất ra.
  if (genome.traits.length > MAX_TRAITS) {
    genome.traits.sort((a, b) => b.fitness - a.fitness);
    genome.traits = genome.traits.slice(0, MAX_TRAITS);
  }

  return genome;
}

/** Chọn tập gen sẽ biểu hiện: ≤MAX_EXPRESSED gen khỏe nhất, fitness giảm dần. */
function selectExpressed(genome: Genome): Gene[] {
  return [...genome.traits].sort((a, b) => b.fitness - a.fitness).slice(0, MAX_EXPRESSED);
}

/**
 * BIỂU HIỆN (expression): biến genome thành một đoạn prompt để nhồi vào system prompt.
 * Chọn tối đa MAX_EXPRESSED gen khỏe nhất (fitness giảm dần) — đây là "áp lực chọn lọc"
 * ở tầng dùng: gen khỏe được nói ra, gen yếu im lặng. Genome chưa có gen → trả '' (agent
 * chạy như thường, không nhồi gì thừa).
 */
export function expressGenome(genome: Genome): string {
  if (genome.traits.length === 0) return '';

  const lines = selectExpressed(genome).map((g) => `- ${g.gene}`).join('\n');
  return (
    `# Tri thức đã học về repo này (genome, thế hệ ${genome.generation})\n\n` +
    `Những điều dưới đây do các lần chạy trước đúc kết được về CHÍNH repo này. ` +
    `Ưu tiên tuân theo; nếu thực tế repo mâu thuẫn với một mục, tin repo và bỏ qua mục đó.\n\n` +
    lines
  );
}

/** Id các gen mà expressGenome() sẽ biểu hiện cho genome này (để gán công/tội sau task). */
export function expressedIds(genome: Genome): string[] {
  return selectExpressed(genome).map((g) => g.id);
}

// ── CHỌN LỌC (selection): fitness tiến hóa theo kết quả thật ────────────────────

/** Tốc độ học fitness (EMA): mỗi task kéo fitness gen về phía reward theo hệ số này. */
const FITNESS_ALPHA = 0.2;
/** Số turn coi là "hiệu quả tốt"; nhiều hơn thì reward giảm dần (não 20W: rẻ = tốt). */
const EFFICIENT_TURNS = 15;
/** Gen bị đào thải khi fitness < ngưỡng VÀ đã đủ già (đã có cơ hội chứng minh). */
const CULL_FITNESS = 0.25;
/** Tuổi tối thiểu (số thế hệ) trước khi một gen yếu bị xét đào thải. */
const CULL_MIN_AGE = 3;

/**
 * Reward 0..1 cho một task. Thành công là điều kiện cần; trong nhóm thành công,
 * task ít turn hơn được thưởng cao hơn (khuyến khích gen giúp làm GỌN, không chỉ XONG).
 * Thất bại → reward thấp (0.1) để kéo fitness các gen liên quan xuống.
 */
export function reward(outcome: { success: boolean; turns: number }): number {
  if (!outcome.success) return 0.1;
  // turns ≤ EFFICIENT_TURNS → ~1.0; càng nhiều turn càng về 0.6 (vẫn dương vì đã xong).
  const efficiency = Math.min(1, EFFICIENT_TURNS / Math.max(1, outcome.turns));
  return 0.6 + 0.4 * efficiency;
}

/**
 * ÁP LỰC CHỌN LỌC: sau một task, kéo fitness của các gen ĐÃ BIỂU HIỆN về phía reward
 * (EMA), tăng usedCount, rồi đào thải gen vừa yếu vừa đủ già. Gen không tham gia task
 * này giữ nguyên fitness. Thuần dữ liệu — không tự ghi disk (caller quyết định lúc save).
 */
export function applySelection(
  genome: Genome,
  expressed: string[],
  outcome: { success: boolean; turns: number },
): Genome {
  const r = reward(outcome);
  const used = new Set(expressed);

  for (const g of genome.traits) {
    if (!used.has(g.id)) continue;
    g.fitness = (1 - FITNESS_ALPHA) * g.fitness + FITNESS_ALPHA * r;
    g.usedCount += 1;
  }

  // Đào thải: fitness thấp VÀ đã sống đủ lâu (tránh giết gen mới chưa kịp chứng minh).
  genome.traits = genome.traits.filter((g) => {
    const age = genome.generation - g.bornGen;
    return !(g.fitness < CULL_FITNESS && age >= CULL_MIN_AGE);
  });

  return genome;
}
