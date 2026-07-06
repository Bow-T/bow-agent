#!/usr/bin/env tsx
/**
 * sync-monorepo — đồng bộ .claude của monorepo vào bow-agent (skills/monorepo/).
 *
 * Bản gói trong bow-agent là COPY (agent dùng để không cần .claude trong monorepo).
 * Khi monorepo cập nhật skill/hook/CLAUDE.md, chạy script này để đồng bộ lại:
 *
 *   npm run sync-monorepo
 *   npm run sync-monorepo -- /duong/dan/khac/.claude   # nguồn khác
 *
 * Nguồn (ưu tiên từ trên xuống):
 *   1. Arg dòng lệnh đầu tiên
 *   2. Biến môi trường BOW_AGENT_MONOREPO_CLAUDE
 *   3. Mặc định: /Users/tuannguyen/GitProject/monorepo/.claude
 *
 * Copy: skills/ (symlink → nội dung thật, tự túc), hooks/, CLAUDE.md, settings.json.
 * KHÔNG đụng .claude gốc của monorepo (chỉ đọc).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SRC = '/Users/tuannguyen/GitProject/monorepo/.claude';

/** Root repo bow-agent (script này ở <root>/scripts/). */
function bowAgentRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function resolveSource(): string {
  const fromArg = process.argv[2];
  const fromEnv = process.env.BOW_AGENT_MONOREPO_CLAUDE;
  return resolve(fromArg || fromEnv || DEFAULT_SRC);
}

/**
 * Thay mọi symlink còn sót trong cây `dir` bằng NỘI DUNG THẬT.
 *
 * cpSync(dereference:true) chỉ deref symlink ở cấp trên cùng của thứ được copy;
 * symlink lồng bên trong (vd skills/stripe-*) bị tái tạo thành link ra ngoài
 * (../../.agents/...) → gãy khi bê bow-agent đi nơi khác. Bước này resolve từng
 * link tới đích thật rồi copy nội dung đè lên, để bản gói TỰ TÚC.
 */
function flattenSymlinks(dir: string): number {
  if (!existsSync(dir)) return 0;
  let flattened = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      let realTarget: string;
      try {
        realTarget = realpathSync(full); // đích cuối cùng (đã theo hết chuỗi link)
      } catch {
        console.warn(`   ⚠️  Symlink gãy, bỏ qua: ${name}`);
        continue;
      }
      rmSync(full, { recursive: true, force: true });
      cpSync(realTarget, full, { recursive: true, dereference: true });
      flattened++;
    } else if (st.isDirectory()) {
      flattened += flattenSymlinks(full);
    }
  }
  return flattened;
}

/** Xóa mọi .DS_Store trong một cây thư mục (đệ quy). */
function stripDsStore(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === '.DS_Store') {
      rmSync(full, { force: true });
    } else if (statSync(full).isDirectory()) {
      stripDsStore(full);
    }
  }
}

/** Đếm số skill (thư mục con có SKILL.md) để báo cáo. */
function countSkills(skillsDir: string): number {
  if (!existsSync(skillsDir)) return 0;
  let n = 0;
  for (const name of readdirSync(skillsDir)) {
    if (existsSync(join(skillsDir, name, 'SKILL.md'))) n++;
  }
  return n;
}

function main(): void {
  const src = resolveSource();
  const dst = join(bowAgentRoot(), 'skills', 'monorepo');

  if (!existsSync(src)) {
    console.error(`❌ Không tìm thấy nguồn: ${src}`);
    console.error('   Truyền path khác: npm run sync-monorepo -- /duong/dan/.claude');
    process.exit(1);
  }

  console.log(`🔄 Đồng bộ .claude monorepo`);
  console.log(`   Nguồn:  ${src}`);
  console.log(`   Đích:   ${dst}`);

  // Làm mới đích để không giữ lại skill/hook đã bị xóa ở nguồn.
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });

  // Các mục cần copy. dereference:true → symlink (vd stripe-*) thành nội dung thật.
  const items: { name: string; required: boolean }[] = [
    { name: 'skills', required: true },
    { name: 'hooks', required: true },
    { name: 'CLAUDE.md', required: true },
    { name: 'settings.json', required: false },
  ];

  for (const { name, required } of items) {
    const from = join(src, name);
    if (!existsSync(from)) {
      if (required) console.warn(`   ⚠️  Thiếu (bỏ qua): ${name}`);
      continue;
    }
    cpSync(from, join(dst, name), { recursive: true, dereference: true });
  }

  // Biến symlink lồng (vd stripe-*) thành nội dung thật để bản gói tự túc.
  const flattened = flattenSymlinks(dst);
  if (flattened > 0) console.log(`   🔗 Đã nội-dung-hóa ${flattened} symlink.`);

  stripDsStore(dst);

  const skillCount = countSkills(join(dst, 'skills'));
  const hookCount = existsSync(join(dst, 'hooks'))
    ? readdirSync(join(dst, 'hooks')).filter((f) => f.endsWith('.sh')).length
    : 0;

  console.log(`✅ Xong: ${skillCount} skill, ${hookCount} hook, CLAUDE.md${existsSync(join(dst, 'settings.json')) ? ', settings.json' : ''}.`);
}

main();
