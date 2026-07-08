#!/usr/bin/env node
/**
 * Quản lý workspace từ CLI (tạm thời — trước khi có UI). Gán/gỡ repo vào một workspace,
 * liệt kê, xem nhật ký. Workspace = một sản phẩm gồm nhiều repo (xem DESIGN §9).
 *
 *   tsx scripts/workspace.ts add <tên-workspace> <đường-dẫn-repo> <vai-trò>
 *   tsx scripts/workspace.ts rm  <tên-workspace> <đường-dẫn-repo>
 *   tsx scripts/workspace.ts ls
 *   tsx scripts/workspace.ts show <tên-workspace>
 *
 * Ví dụ:
 *   tsx scripts/workspace.ts add app-giao-hang ~/work/delivery-backend BE
 *   tsx scripts/workspace.ts add app-giao-hang ~/work/delivery-flutter  FE
 *   tsx scripts/workspace.ts ls
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  addRepoToWorkspace,
  removeRepoFromWorkspace,
  listWorkspaces,
  resolveWorkspace,
} from '../src/profiles/workspace.js';

function die(msg: string): never {
  process.stderr.write(`Lỗi: ${msg}\n`);
  process.exit(1);
}

/** Mở rộng ~ ở đầu path (tiện gõ tay). */
function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return join(process.env.HOME ?? '', p.slice(1));
  return p;
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'add': {
    const [name, repoRaw, role] = rest;
    if (!name || !repoRaw || !role) die('Cú pháp: add <tên-workspace> <đường-dẫn-repo> <vai-trò>');
    const repo = resolve(expandHome(repoRaw));
    if (!existsSync(repo)) die(`Không thấy thư mục repo: ${repo}`);
    const ws = addRepoToWorkspace(name, repo, role);
    process.stdout.write(`✅ Đã gán "${role}" → ${repo} vào workspace "${ws.slug}"\n`);
    process.stdout.write(`   Workspace giờ có ${ws.repos.length} repo:\n`);
    for (const r of ws.repos) process.stdout.write(`   - ${r.role}: ${r.path}\n`);
    break;
  }
  case 'rm': {
    const [name, repoRaw] = rest;
    if (!name || !repoRaw) die('Cú pháp: rm <tên-workspace> <đường-dẫn-repo>');
    removeRepoFromWorkspace(name, resolve(expandHome(repoRaw)));
    process.stdout.write(`✅ Đã gỡ ${repoRaw} khỏi workspace "${name}"\n`);
    break;
  }
  case 'ls': {
    const all = listWorkspaces();
    if (all.length === 0) {
      process.stdout.write('(chưa có workspace nào)\n');
      break;
    }
    for (const ws of all) {
      process.stdout.write(`\n📦 ${ws.slug} (${ws.repos.length} repo)\n`);
      for (const r of ws.repos) process.stdout.write(`   - ${r.role}: ${r.path}\n`);
    }
    process.stdout.write('\n');
    break;
  }
  case 'show': {
    const [name] = rest;
    if (!name) die('Cú pháp: show <tên-workspace>');
    const ws = listWorkspaces().find((w) => w.slug === name) ?? resolveWorkspace(expandHome(name));
    if (!ws) die(`Không thấy workspace: ${name}`);
    process.stdout.write(`📦 ${ws.slug}\n`);
    for (const r of ws.repos) process.stdout.write(`   - ${r.role}: ${r.path}\n`);
    for (const file of ['shared.md', 'journal.md'] as const) {
      const p = join(ws.dir, file);
      process.stdout.write(`\n── ${file} ${existsSync(p) ? '' : '(chưa có)'} ──\n`);
      if (existsSync(p)) process.stdout.write(readFileSync(p, 'utf8'));
    }
    process.stdout.write('\n');
    break;
  }
  default:
    process.stdout.write(
      'Cách dùng:\n' +
        '  tsx scripts/workspace.ts add <tên> <repo> <vai-trò>\n' +
        '  tsx scripts/workspace.ts rm  <tên> <repo>\n' +
        '  tsx scripts/workspace.ts ls\n' +
        '  tsx scripts/workspace.ts show <tên>\n',
    );
    process.exit(cmd ? 1 : 0);
}
