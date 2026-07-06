import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import { isMonorepo, detectJiraProjectKey } from './monorepo.js';

/**
 * Hook của monorepo (gói từ .claude/hooks). Bọc 4 script shell đã kiểm chứng
 * thành SDK hook callback — chỉ gắn khi cwd là monorepo.
 *
 * Hợp đồng script (giữ nguyên như Claude Code chạy):
 * - Nhận payload JSON qua STDIN (có tool_input.command...).
 * - exit 2 = CHẶN tool call (guard-push, guard-commit-branch).
 * - exit 0 = cho qua. stderr được đưa vào transcript.
 * Script tìm scripts/*.sh của repo qua $CLAUDE_PROJECT_DIR → ta set = monorepo root.
 */

/** Thư mục hook đã gói trong bow-agent. */
function hooksDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../skills/monorepo/hooks');
}

/** Root monorepo suy ra từ cwd (segment tới hết ".../monorepo"). */
function monorepoRoot(cwd: string): string {
  const norm = resolve(cwd);
  const idx = norm.split('/').lastIndexOf('monorepo');
  if (idx < 0) return norm;
  return norm.split('/').slice(0, idx + 1).join('/');
}

/**
 * Chạy một hook script với payload → trả kết quả SDK. exit 2 = block.
 * Không bao giờ throw: hook lỗi hạ tầng không được kéo sập agent (fail-open).
 */
function runHookScript(
  scriptPath: string,
  payload: unknown,
  projectDir: string,
  projectKey: string,
): { decision?: 'block'; reason?: string; continue?: boolean; systemMessage?: string } {
  if (!existsSync(scriptPath)) return { continue: true };
  let res;
  try {
    res = spawnSync('bash', [scriptPath], {
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, BOW_PROJECT_KEY: projectKey },
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 120_000,
    });
  } catch {
    return { continue: true }; // fail-open
  }
  const stderr = (res.stderr ?? '').trim();
  // exit 2 (hoặc >0 với guard) = chặn; kèm stderr làm lý do cho model.
  if (res.status === 2) {
    return { decision: 'block', reason: stderr || 'Hook monorepo chặn thao tác này.' };
  }
  // Hook không chặn nhưng có stderr (vd self-verify nhắc rubric) → đưa vào transcript.
  if (stderr) return { continue: true, systemMessage: stderr };
  return { continue: true };
}

/**
 * Dựng object hooks cho SDK query(). Trả undefined nếu cwd KHÔNG phải monorepo
 * (để runner không gắn hooks vô ích cho repo khác).
 */
export function buildMonorepoHooks(
  cwd: string,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  if (!isMonorepo(cwd)) return undefined;
  const dir = hooksDir();
  if (!existsSync(dir)) return undefined;
  const root = monorepoRoot(cwd);
  const projectKey = detectJiraProjectKey(cwd);

  const guardPush = join(dir, 'guard-push.sh');
  const guardCommit = join(dir, 'guard-commit-branch.sh');
  const selfVerify = join(dir, 'self-verify-rubric.sh');
  const ensureGithooks = join(dir, 'ensure-githooks.sh');

  return {
    // Trước mỗi Bash: chặn push khi quest gate fail, chặn commit trên branch protected.
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          async (input) => runHookScript(guardPush, input, root, projectKey),
          async (input) => runHookScript(guardCommit, input, root, projectKey),
        ],
      },
    ],
    // Khi phiên bắt đầu: wire core.hooksPath → .githooks (idempotent, không chặn).
    SessionStart: [
      { hooks: [async (input) => runHookScript(ensureGithooks, input, root, projectKey)] },
    ],
    // Khi kết thúc lượt: nhắc self-verify rubric nếu có commit chưa push (không chặn).
    Stop: [
      { hooks: [async (input) => runHookScript(selfVerify, input, root, projectKey)] },
    ],
  };
}
