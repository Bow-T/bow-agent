import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config/env.js';
import { loadGenome, saveGenome, mutateGenome } from './genome.js';

/**
 * ĐỘT BIẾN có định hướng — "củng cố trí nhớ sau khi làm".
 *
 * Sau một task đã chạy, chạy MỘT lượt agent phản tư ngắn: nhìn lại đề bài + báo cáo
 * kết quả, rút ra 0–3 câu tri thức BỀN VỮNG về CHÍNH repo này (pattern, quy ước, bẫy
 * hay gặp) mà lần sau nên biết trước. Không đọc lại repo (rẻ + đúng tinh thần "củng
 * cố cái vừa trải qua"), tool tắt hết, giới hạn lượt.
 *
 * Các câu này đưa qua mutateGenome (chống trùng, cấp id, fitness trung tính) rồi ghi
 * lại genome. Lỗi ở bước này KHÔNG được làm hỏng task — caller bọc try/catch.
 */

/** Ngưỡng độ dài một câu gen hợp lệ (bỏ câu quá ngắn/rỗng nghĩa hoặc lan man). */
const MIN_GENE_LEN = 8;
const MAX_GENE_LEN = 200;

function reflectionPrompt(brief: string, finalText: string, success: boolean, existing: string): string {
  return `
Bạn vừa hoàn thành (hoặc thử) một task trên một repo. Hãy PHẢN TƯ để rút ra tri thức
BỀN VỮNG về CHÍNH repo này — thứ mà một agent khác nên biết TRƯỚC khi làm task sau,
để nhanh và ít sai hơn.

## Đề bài
${brief}

## Kết quả (${success ? 'thành công' : 'CHƯA thành công'})
${finalText.slice(0, 4000)}

## Tri thức đã biết về repo (ĐỪNG lặp lại những điều này)
${existing || '(chưa có gì)'}

## Yêu cầu
Trả về TỐI ĐA 3 câu tri thức MỚI, mỗi câu:
- Nói về pattern/quy ước/bẫy CỦA REPO NÀY (không phải mẹo lập trình chung chung).
- Cụ thể, dùng lại được ("Repo dùng X, không dùng Y"; "Đổi Z phải nhớ cập nhật W").
- Chỉ ghi điều bạn THỰC SỰ quan sát được lần này. KHÔNG bịa. Không có gì đáng ghi → trả mảng rỗng.

Chỉ in DUY NHẤT một khối JSON, không giải thích gì thêm, đúng dạng:
{"genes": ["câu 1", "câu 2"]}
`.trim();
}

/** Bóc mảng câu gen từ text kết quả (chịu được model bọc thêm chữ quanh JSON). */
export function parseGenes(text: string): string[] {
  // Lấy object JSON đầu tiên có khóa "genes".
  const match = text.match(/\{[\s\S]*"genes"[\s\S]*\}/);
  if (!match) return [];
  try {
    const obj = JSON.parse(match[0]) as { genes?: unknown };
    if (!Array.isArray(obj.genes)) return [];
    return obj.genes
      .filter((g): g is string => typeof g === 'string')
      .map((g) => g.trim())
      .filter((g) => g.length >= MIN_GENE_LEN && g.length <= MAX_GENE_LEN);
  } catch {
    return [];
  }
}

/**
 * Chạy phản tư cho một task rồi đột biến genome của repo. Trả số gen mới đã thêm.
 * Không ném lỗi — mọi trục trặc trả 0 (mutation chỉ là "phần thưởng", không chặn task).
 */
export async function reflectAndMutate(params: {
  cwd: string;
  brief: string;
  finalText: string;
  success: boolean;
}): Promise<number> {
  if (!config.hasAuth) return 0;

  try {
    const before = loadGenome(params.cwd);
    const existing = before.traits.map((g) => `- ${g.gene}`).join('\n');

    const options: Options = {
      model: config.model,
      effort: 'low', // phản tư ngắn, không cần suy luận nặng.
      cwd: params.cwd,
      permissionMode: 'plan', // không sửa gì.
      allowedTools: [], // không cần tool — chỉ nghĩ trên dữ liệu đã có.
      maxTurns: 2,
      settingSources: [],
    };

    let result = '';
    for await (const message of query({
      prompt: reflectionPrompt(params.brief, params.finalText, params.success, existing),
      options,
    })) {
      if (message.type === 'result' && message.subtype === 'success') {
        result = message.result;
      }
    }

    const genes = parseGenes(result);
    if (genes.length === 0) return 0;

    // Tải lại genome ngay trước khi ghi (task có thể đã cập nhật history xong).
    const genome = loadGenome(params.cwd);
    const traitsBefore = genome.traits.length;
    mutateGenome(genome, genes);
    const added = genome.traits.length - traitsBefore;
    if (added > 0) saveGenome(genome);
    return added;
  } catch {
    // Phản tư hỏng không được ảnh hưởng task — nuốt lỗi.
    return 0;
  }
}
