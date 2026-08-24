/**
 * Test buildSubagents ánh xạ model theo provider của LƯỢT CHẠY (per-tab), không đóng băng
 * theo provider mặc định tiến trình. Đây là hồi quy cho bug "tab chọn Grok trên server mặc
 * định Claude": subagent giữ 'claude-*' rồi gửi sang gateway Grok → xAI trả 400.
 * Chạy: `node --import tsx --test src/core/subagents.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { buildSubagents } from './subagents.js';

test('provider grok: model claude-* của subagent chuẩn quy về bậc main/fast của Grok', () => {
  const agents = buildSubagents(undefined, 'grok');
  // reviewer/verifier (Sonnet) → bậc main; impact-scout (Haiku) → bậc fast.
  assert.equal(agents.reviewer.model, 'grok-4.6');
  assert.equal(agents.verifier.model, 'grok-4.6');
  assert.equal(agents['impact-scout'].model, 'grok-build-0.1');
  // Không còn sót tên model Claude nào (gateway Grok không hiểu 'claude-*').
  for (const def of Object.values(agents)) {
    assert.ok(!String(def.model).startsWith('claude'), `model còn claude-*: ${def.model}`);
  }
});

test('provider anthropic: model giữ nguyên (không đổi hành vi cũ)', () => {
  const agents = buildSubagents(undefined, 'anthropic');
  assert.equal(agents.reviewer.model, 'claude-sonnet-5');
  assert.equal(agents['impact-scout'].model, 'claude-haiku-4-5-20251001');
});

test('subagent riêng của profile cũng được ánh xạ theo provider', () => {
  const profile: Record<string, AgentDefinition> = {
    custom: {
      description: 'x',
      tools: ['Read'],
      model: 'claude-opus-4-8',
      prompt: 'p',
    },
  };
  const agents = buildSubagents(profile, 'grok');
  assert.equal(agents.custom.model, 'grok-4.6');
});

test("model 'inherit' được giữ nguyên cho mọi provider", () => {
  const profile: Record<string, AgentDefinition> = {
    inh: { description: 'x', tools: ['Read'], model: 'inherit', prompt: 'p' },
  };
  assert.equal(buildSubagents(profile, 'grok').inh.model, 'inherit');
  assert.equal(buildSubagents(profile, 'anthropic').inh.model, 'inherit');
});
