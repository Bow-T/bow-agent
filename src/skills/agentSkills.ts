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
function skillSignature(dir: string): string {
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
function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else writeFileSync(d, readFileSync(s));
  }
}

/**
 * Trải mọi Agent Skill bundle vào `<cwd>/.claude/skills/`. Idempotent & AN TOÀN:
 * - Bỏ qua nếu bundle không tồn tại (không throw).
 * - KHÔNG đụng skill người dùng tự đặt: chỉ ghi vào thư mục do CHÍNH ta trải (nhận diện qua
 *   file STAMP). Nếu `<cwd>/.claude/skills/<name>` đã có mà KHÔNG có STAMP → coi là của người
 *   dùng, tôn trọng, không ghi đè.
 * - Chỉ copy lại khi chữ ký bundle đổi (nâng cấp skill) — tránh ghi đĩa thừa mỗi lần chạy.
 *
 * Trả danh sách tên skill đã sẵn sàng (để log). Fail-open: lỗi copy một skill không kéo sập.
 */
export function deployBundledSkills(cwd: string): string[] {
  const root = bundleRoot();
  if (!existsSync(root)) return [];

  let names: string[];
  try {
    names = readdirSync(root).filter((n) => existsSync(join(root, n, 'SKILL.md')));
  } catch {
    return [];
  }

  const deployed: string[] = [];
  for (const name of names) {
    const src = join(root, name);
    const dst = join(resolve(cwd), '.claude', 'skills', name);
    const stampFile = join(dst, STAMP);
    try {
      if (existsSync(dst)) {
        // Đã tồn tại: chỉ được ghi đè NẾU chính ta trải trước đó (có STAMP).
        if (!existsSync(stampFile)) {
          // Của người dùng — tôn trọng, vẫn tính là sẵn sàng.
          deployed.push(name);
          continue;
        }
        // Cùng chữ ký → khỏi copy lại.
        const want = skillSignature(src);
        const have = existsSync(stampFile) ? readFileSync(stampFile, 'utf8').trim() : '';
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
