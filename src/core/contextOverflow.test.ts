/**
 * Kiểm contextOverflowHint nhận đúng lỗi tràn context của CẢ HAI giọng API (Anthropic và
 * OpenAI/xAI qua gateway) và KHÔNG nhận nhầm lỗi hết hạn mức — hai loại này xử lý khác nhau
 * (tràn context phải mở phiên mới, hết hạn mức thì auto-resume).
 *
 * Chạy: npx tsx --test src/core/contextOverflow.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextOverflowHint, shouldCompactNow } from './runner.js';

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

test('không nhận nhầm chữ trong tài liệu / lời agent', () => {
  // Agent hay nhúng đúng cụm khi viết docs/code — nhận nhầm sẽ xóa conversationId.
  assert.equal(
    contextOverflowHint(
      'nổ 400 "maximum prompt length" rồi phải bỏ cả tab. 0 (hoặc >=100) = tắt, tự lo bằng tay.',
    ),
    null,
  );
  assert.equal(
    contextOverflowHint(
      'xAI báo lỗi "This model\'s maximum prompt length is 500000" — tức trần thật gấp 2,5 lần. Tin con số CLI đoán thì bow tuyên bố tràn context.',
    ),
    null,
  );
  assert.equal(
    contextOverflowHint(
      'Long sessions don\'t die. When a conversation approaches the model\'s context window, the agent compacts. If prompt is too long we keep going on the same tab.',
    ),
    null,
  );
  assert.equal(contextOverflowHint('maximum prompt length'), null);
  assert.equal(
    contextOverflowHint(
      'Trước đây compact tại chỗ; giờ đừng nhận nhầm chữ prompt is too long trong tài liệu rồi xóa conversationId.',
    ),
    null,
  );
});

test('vẫn bắt thông báo ngắn của CLI', () => {
  assert.ok(contextOverflowHint('prompt is too long'));
  assert.ok(contextOverflowHint('Claude Code returned an error result: Prompt is too long'));
  assert.ok(contextOverflowHint('Claude Code returned an error result: Prompt is too long?'));
});

/**
 * shouldCompactNow — quyết định xếp /compact. Chạy ở HAI chỗ: phép đo giữa lượt và ranh
 * giới lượt. Giữa lượt là chỗ mới: lượt marathon phình quá trần mà không bao giờ chạm
 * 'result' thì nén ở ranh giới lượt là quá muộn (nén cũng nổ theo).
 */
test('shouldCompactNow: chạm ngưỡng thì nén, dưới ngưỡng thì thôi', () => {
  assert.equal(shouldCompactNow({ pct: 80, overLimit: false, requested: false, at: 80 }), true);
  assert.equal(shouldCompactNow({ pct: 79.9, overLimit: false, requested: false, at: 80 }), false);
  assert.equal(shouldCompactNow({ pct: 56, overLimit: false, requested: false, at: 55 }), true);
});

test('shouldCompactNow: quá trần cứng thì vẫn thử nén dù chưa đo được %', () => {
  assert.equal(shouldCompactNow({ pct: null, overLimit: true, requested: false, at: 80 }), true);
  assert.equal(shouldCompactNow({ pct: null, overLimit: false, requested: false, at: 80 }), false);
});

test('shouldCompactNow: đã gửi rồi thì không gửi chồng; at ngoài (0,100) = tắt', () => {
  assert.equal(shouldCompactNow({ pct: 95, overLimit: true, requested: true, at: 80 }), false);
  assert.equal(shouldCompactNow({ pct: 95, overLimit: true, requested: false, at: 0 }), false);
  assert.equal(shouldCompactNow({ pct: 95, overLimit: true, requested: false, at: 100 }), false);
});

test('shouldCompactNow: phanh chống nén lặp khi nén không giảm được', () => {
  const over = { pct: 95, overLimit: true, requested: false, at: 55 };
  assert.equal(shouldCompactNow({ ...over, sent: 2 }), true);
  assert.equal(shouldCompactNow({ ...over, sent: 3 }), false);
  assert.equal(shouldCompactNow({ ...over, sent: 1, max: 1 }), false);
});
