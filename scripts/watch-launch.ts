#!/usr/bin/env tsx
/**
 * Theo dõi phản hồi sau khi đăng bài — GitHub + Hacker News.
 *
 * Chạy:  npx tsx scripts/watch-launch.ts
 *
 * In ra những gì MỚI kể từ lần chạy trước (state ở ~/.bow-agent/launch-watch.json):
 *   - GitHub: issue mới, comment mới, PR mới, số star
 *   - Hacker News: bài nhắc tới bow-agent + comment trên đó
 *
 * KHÔNG tự trả lời. Chỉ báo cáo — người đọc rồi quyết.
 * (Reddit không quét được: họ chặn bot. Bật email notification của Reddit thay thế.)
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO = 'Bow-T/bow-agent';
const STATE = join(homedir(), '.bow-agent', 'launch-watch.json');

interface State {
  seenIssues: number[];
  seenComments: number[];
  seenHnStories: string[];
  seenHnComments: string[];
  stars: number;
}

function loadState(): State {
  if (!existsSync(STATE)) {
    return { seenIssues: [], seenComments: [], seenHnStories: [], seenHnComments: [], stars: 0 };
  }
  try {
    return JSON.parse(readFileSync(STATE, 'utf8')) as State;
  } catch {
    return { seenIssues: [], seenComments: [], seenHnStories: [], seenHnComments: [], stars: 0 };
  }
}

function saveState(s: State): void {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

function gh<T>(args: string): T {
  return JSON.parse(execSync(`gh ${args}`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })) as T;
}

async function main(): Promise<void> {
  const state = loadState();
  const first = state.stars === 0 && state.seenIssues.length === 0;
  const news: string[] = [];

  // ── GitHub: star ────────────────────────────────────────────────────
  const repo = gh<{ stargazerCount: number; forkCount: number }>(
    `repo view ${REPO} --json stargazerCount,forkCount`,
  );
  if (!first && repo.stargazerCount > state.stars) {
    news.push(`⭐ +${repo.stargazerCount - state.stars} star (tổng ${repo.stargazerCount})`);
  }
  state.stars = repo.stargazerCount;

  // ── GitHub: issue mới ───────────────────────────────────────────────
  const issues = gh<Array<{ number: number; title: string; author: { login: string }; url: string }>>(
    `issue list --repo ${REPO} --state all --limit 50 --json number,title,author,url`,
  );
  for (const i of issues) {
    if (state.seenIssues.includes(i.number)) continue;
    state.seenIssues.push(i.number);
    if (!first) news.push(`🐛 Issue #${i.number} — ${i.title}\n   bởi @${i.author.login} · ${i.url}`);
  }

  // ── GitHub: comment mới trên issue ──────────────────────────────────
  for (const i of issues.slice(0, 20)) {
    const detail = gh<{ comments: Array<{ id: number; author: { login: string }; body: string }> }>(
      `issue view ${i.number} --repo ${REPO} --json comments`,
    );
    for (const c of detail.comments ?? []) {
      if (state.seenComments.includes(c.id)) continue;
      state.seenComments.push(c.id);
      if (!first) {
        const snip = c.body.replace(/\s+/g, ' ').slice(0, 140);
        news.push(`💬 Comment trên #${i.number} bởi @${c.author.login}:\n   "${snip}${c.body.length > 140 ? '…' : ''}"`);
      }
    }
  }

  // ── Hacker News ─────────────────────────────────────────────────────
  try {
    const res = await fetch('https://hn.algolia.com/api/v1/search?query=bow-agent&tags=story');
    const hn = (await res.json()) as { hits: Array<{ objectID: string; title: string; points: number; num_comments: number }> };
    for (const h of hn.hits ?? []) {
      const key = `${h.objectID}:${h.num_comments}`;
      if (state.seenHnStories.includes(key)) continue;
      state.seenHnStories = state.seenHnStories.filter((k) => !k.startsWith(h.objectID + ':'));
      state.seenHnStories.push(key);
      if (!first) {
        news.push(
          `🟠 HN: "${h.title}" — ${h.points} điểm, ${h.num_comments} comment\n   https://news.ycombinator.com/item?id=${h.objectID}`,
        );
      }
    }
  } catch {
    news.push('⚠️  Không gọi được HN API (mạng?)');
  }

  saveState(state);

  // ── Báo cáo ─────────────────────────────────────────────────────────
  if (first) {
    console.log('✅ Lần chạy đầu — đã ghi nhận trạng thái hiện tại làm mốc.');
    console.log(`   ${repo.stargazerCount} star · ${issues.length} issue.`);
    console.log('   Lần sau chạy sẽ chỉ báo cái MỚI.');
    return;
  }

  if (!news.length) {
    console.log('· Không có gì mới.');
    return;
  }

  console.log(`\n📣 ${news.length} thứ mới:\n`);
  news.forEach((n) => console.log('  ' + n.replace(/\n/g, '\n  ') + '\n'));
  console.log('💡 Đáp án soạn sẵn cho comment hay gặp: docs/launch/faq.md');
}

main().catch((e) => {
  console.error('Lỗi:', e instanceof Error ? e.message : e);
  process.exit(1);
});
