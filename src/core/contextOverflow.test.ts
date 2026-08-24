/**
 * Kiểm contextOverflowHint nhận đúng lỗi tràn context của CẢ HAI giọng API (Anthropic và
 * OpenAI/xAI qua gateway) và KHÔNG nhận nhầm lỗi hết hạn mức — hai loại này xử lý khác nhau
 * (tràn context phải mở phiên mới, hết hạn mức thì auto-resume).
 *
 * Chạy: npx tsx --test src/core/contextOverflow.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextOverflowHint } from './runner.js';

test('bắt lỗi tràn context giọng Anthropic + hiện số token', () => {
  const hint = contextOverflowHint(
    'API Error: 400 {"code":"invalid-argument","error":"This model\'s maximum prompt length is 500000 but the request contains 503196 tokens."}',
  );
  assert.ok(hint);
  assert.match(hint, /503\.196 \/ 500\.000 token/);
  assert.match(hint, /gõ tiếp yêu cầu ngay tại đây/);
});

test('bắt lỗi tràn context giọng OpenAI/xAI qua gateway', () => {
  assert.ok(
    contextOverflowHint(
      "This model's maximum context length is 256000 tokens. However, your messages resulted in 260311 tokens.",
    ),
  );
  assert.ok(contextOverflowHint('litellm.BadRequestError: context_length_exceeded'));
  assert.ok(contextOverflowHint('prompt is too long: 512000 tokens > 500000 maximum'));
});

test('bắt cả lỗi nén thất bại vì chính việc nén cũng tràn', () => {
  // Nén phải gửi cả hội thoại lên cho model tóm tắt → quá trần thì /compact nổ theo.
  assert.ok(
    contextOverflowHint(
      'Error during compaction: API Error: 400 {"error":"This model\'s maximum prompt length is 500000 but the request contains 504917 tokens."}',
    ),
  );
});

test('không nhận nhầm lỗi khác', () => {
  assert.equal(contextOverflowHint(undefined), null);
  assert.equal(contextOverflowHint("You've hit your usage limit. Resets at 3pm."), null);
  assert.equal(contextOverflowHint('error_during_execution'), null);
});
