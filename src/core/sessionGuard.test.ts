/**
 * Kiểm hai chốt chống "AI ngoài mất trí nhớ rồi làm nhầm việc của tab khác":
 *   1. providerContextTokens — trần prompt THẬT của AI ngoài (CLI đoán 200k cho grok, thật 500k);
 *   2. isForeignSessionStore — chặn đọc transcript phiên khác / kho cấu hình bow.
 *
 * Chạy: npx tsx --test src/core/sessionGuard.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isForeignSessionStore } from './runner.js';
import { providerContextTokens } from '../config/env.js';
import { buildReadAutoApproveHook } from '../skills/hooks.js';

test('trần context: AI ngoài dùng số khai của bow, Anthropic để CLI tự lo', () => {
  assert.equal(providerContextTokens('grok'), 500_000);
  assert.equal(providerContextTokens('anthropic'), null);
});

test('chặn đường dẫn kho hội thoại của phiên khác', () => {
  assert.ok(isForeignSessionStore('/Users/x/.claude/projects/-Users-x-repo/abc.jsonl'));
  assert.ok(isForeignSessionStore('/Users/x/.claude-leo/projects/-Users-x-repo/abc.jsonl'));
  assert.ok(isForeignSessionStore('~/.bow-agent/provider.json'));
  assert.ok(isForeignSessionStore('conversations/conversations.json'));
  // Lệnh Bash cũng bị soi (agent hay dùng python đọc .jsonl).
  assert.ok(
    isForeignSessionStore("python3 -c \"open('/Users/x/.claude/projects/p/s.jsonl')\""),
  );
});

test('không chặn nhầm file thường của repo', () => {
  assert.equal(isForeignSessionStore('src/core/runner.ts'), false);
  assert.equal(isForeignSessionStore('/Users/x/repo/.claude/skills/bow-ui/SKILL.md'), false);
  assert.equal(isForeignSessionStore('src/web/conversations.ts'), false);
  assert.equal(isForeignSessionStore(undefined), false);
});

test('hook PreToolUse deny TRƯỚC khi auto-duyệt tool đọc', async () => {
  const [matcher] = buildReadAutoApproveHook(['Read', 'Glob'], isForeignSessionStore);
  const run = (toolName: string, toolInput: Record<string, unknown>) =>
    (matcher.hooks[0] as (i: unknown, t: unknown, o: unknown) => Promise<any>)(
      { tool_name: toolName, tool_input: toolInput },
      undefined,
      {},
    );

  const denied = await run('Read', {
    file_path: '/Users/x/.claude-leo/projects/-Users-x-repo/abc.jsonl',
  });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');

  const allowed = await run('Read', { file_path: 'src/core/runner.ts' });
  assert.equal(allowed.hookSpecificOutput.permissionDecision, 'allow');

  // Tool ngoài allowlist mà không chạm path cấm → pass-through cho canUseTool quyết.
  const passthrough = await run('Bash', { command: 'git status' });
  assert.deepEqual(passthrough, {});
});
