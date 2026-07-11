import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Agent Skills bundle sẵn trong bow-agent (skills/agent-skills/<name>/SKILL.md + scripts)
 * được TRẢI vào `.claude/skills/<name>/` của repo đích trước khi agent chạy — nhờ đó agent
 * (SDK nạp qua settingSources:['project'] + skills:'all') LUÔN thấy, không cần cài thủ công.
 *
 * Vì sao trải chứ không nạp thẳng: SDK chỉ auto-discover skill trong `.claude/skills/` của
 * cwd. Bundle nằm trong repo bow-agent (cwd khác) nên phải copy sang. Xem DESIGN §7.2.
 *
 * Ví dụ: skill `watch` (xem video: yt-dlp tải, ffmpeg tách frame, Claude Read từng frame).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Thư mục chứa các Agent Skill bundle của bow-agent. */
function bundleRoot(): string {
  // File này ở <root>/src/skills/agentSkills.ts (tsx) hoặc <root>/dist/skills/… (build).
  return resolve(__dirname, '../../skills/agent-skills');
}

/** Marker version để biết bản đã trải có khớp bundle không (tránh copy lại mỗi lần chạy). */
const STAMP = '.bow-bundled';

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
 * Trả danh sách tên skill đã sẵn sàng (để log). Fail-open: lỗi copy một skill không kéo sập.
 */
export function deploySkillsFrom(srcRoot: string, cwd: string, stamp: string): string[] {
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
      if (existsSync(dst)) {
        // Đã tồn tại: chỉ được ghi đè NẾU chính ta (cùng nguồn STAMP) đã trải trước đó.
        // Không có STAMP của ta → của người dùng HOẶC của nguồn khác: tôn trọng, không đụng.
        if (!existsSync(stampFile)) {
          deployed.push(name);
          continue;
        }
        // Cùng chữ ký → khỏi copy lại.
        const want = skillSignature(src);
        const have = readFileSync(stampFile, 'utf8').trim();
        if (have === want) {
          deployed.push(name);
          continue;
        }
      }
      copyDir(src, dst);
      writeFileSync(stampFile, skillSignature(src), 'utf8');
      deployed.push(name);
    } catch {
      // Bỏ qua skill lỗi — không kéo sập agent.
    }
  }
  return deployed;
}

/**
 * Trải mọi Agent Skill bundle NỘI BỘ (skills/agent-skills/*) vào `<cwd>/.claude/skills/`.
 * Xem `deploySkillsFrom`. Dùng STAMP `.bow-bundled`.
 */
export function deployBundledSkills(cwd: string): string[] {
  return deploySkillsFrom(bundleRoot(), cwd, STAMP);
}
