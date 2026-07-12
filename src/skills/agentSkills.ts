import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Lõi TRẢI skill vào `.claude/skills/<name>/` của repo đích — SDK auto-discover skill ở đó (nhờ
 * settingSources:['project'] + skills:'all'). Mỗi folder skill (có SKILL.md) được copy sang,
 * đánh STAMP để biết nguồn (core `.bow-core` / stack `.bow-external`) và chỉ ghi đè bản của mình.
 *
 * bow-agent là KHUNG RỖNG — không còn skills/ nội bộ; skill nguồn đến từ repo GitHub đã clone
 * (bow-skill-core / bow-skill-<stack>). Hàm ở đây chỉ lo phần COPY từ srcRoot sang, không biết
 * nguồn ở đâu — externalSkills.ts truyền srcRoot + stamp vào. Xem DESIGN §7.2.
 */

/**
 * Nội dung STAMP: dòng đầu = ref đã trải (để badge so với registry), phần còn lại = chữ ký
 * thư mục (để deploy idempotent). Tách 2 phần bằng ký tự newline đầu tiên. ref rỗng cho nguồn
 * không ghim ref (không nên xảy ra với core/stack — luôn có ref).
 */
export function stampContent(ref: string, signature: string): string {
  return `${ref}\n${signature}`;
}

/** Tách STAMP thành {ref, signature}. STAMP kiểu cũ (chỉ signature, không có ref) → ref='',
 *  signature=toàn bộ nội dung — vẫn so được chữ ký, chỉ là không biết ref (coi như cần sync lại). */
export function parseStamp(content: string): { ref: string; signature: string } {
  const nl = content.indexOf('\n');
  if (nl === -1) return { ref: '', signature: content };
  return { ref: content.slice(0, nl), signature: content.slice(nl + 1) };
}

/** Đọc "chữ ký" một thư mục skill: danh sách file + tổng size — đủ để phát hiện đổi bản. */
export function skillSignature(dir: string): string {
  const files: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(p);
      if (st.isDirectory()) walk(p, r);
      else files.push(`${r}:${st.size}`);
    }
  };
  walk(dir, '');
  return files.join('|');
}

/** Copy đệ quy một thư mục (ghi đè file đích). */
export function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else writeFileSync(d, readFileSync(s));
  }
}

/**
 * Trải mọi folder skill (mỗi folder có SKILL.md) từ `srcRoot` vào `<cwd>/.claude/skills/`.
 * Đây là lõi dùng chung cho cả skill bundle nội bộ (STAMP `.bow-bundled`) và skill external
 * tải từ GitHub (STAMP `.bow-external`). Idempotent & AN TOÀN:
 * - Bỏ qua nếu `srcRoot` không tồn tại (không throw).
 * - KHÔNG đụng skill người dùng tự đặt: chỉ ghi vào thư mục do CHÍNH ta trải (nhận diện qua
 *   file STAMP tương ứng). Nếu `<cwd>/.claude/skills/<name>` đã có mà KHÔNG có STAMP → coi là
 *   của người dùng, tôn trọng, không ghi đè.
 * - Chỉ copy lại khi chữ ký nguồn đổi (nâng cấp skill) — tránh ghi đĩa thừa mỗi lần chạy.
 *
 * `stamp` là tên file marker phân biệt nguồn (mỗi nguồn một STAMP để không đá nhau khi trùng
 * tên skill giữa các nguồn — bản trải sau chỉ ghi đè bản mang ĐÚNG STAMP của mình).
 *
 * `ref` (tag/commit đã ghim) được ghi vào dòng đầu STAMP để badge biết project đang trải bản NÀO
 * — từ đó phát hiện "đã trải nhưng ref cũ hơn registry". Truyền '' nếu nguồn không ghim ref.
 *
 * Trả danh sách tên skill đã sẵn sàng (để log). Fail-open: lỗi copy một skill không kéo sập.
 */
export function deploySkillsFrom(srcRoot: string, cwd: string, stamp: string, ref = ''): string[] {
  if (!existsSync(srcRoot)) return [];

  let names: string[];
  try {
    names = readdirSync(srcRoot).filter((n) => existsSync(join(srcRoot, n, 'SKILL.md')));
  } catch {
    return [];
  }

  const deployed: string[] = [];
  for (const name of names) {
    const src = join(srcRoot, name);
    const dst = join(resolve(cwd), '.claude', 'skills', name);
    const stampFile = join(dst, stamp);
    try {
      const want = skillSignature(src);
      if (existsSync(dst)) {
        // Đã tồn tại: chỉ được ghi đè NẾU chính ta (cùng nguồn STAMP) đã trải trước đó.
        // Không có STAMP của ta → của người dùng HOẶC của nguồn khác: tôn trọng, không đụng.
        if (!existsSync(stampFile)) {
          deployed.push(name);
          continue;
        }
        // Cùng chữ ký VÀ cùng ref → khỏi copy lại. Đổi ref (dù chữ ký giống) vẫn ghi lại STAMP
        // để dòng ref cập nhật — badge dựa vào ref này để biết bản đã trải.
        const prev = parseStamp(readFileSync(stampFile, 'utf8'));
        if (prev.signature === want && prev.ref === ref) {
          deployed.push(name);
          continue;
        }
      }
      copyDir(src, dst);
      writeFileSync(stampFile, stampContent(ref, want), 'utf8');
      deployed.push(name);
    } catch {
      // Bỏ qua skill lỗi — không kéo sập agent.
    }
  }
  return deployed;
}
