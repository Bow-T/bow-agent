/**
 * Test cho shim Anthropic → xAI. Import code THẬT, không mở cổng/mạng: chỉ chạm hàm thuần
 * adaptRequestBody (gọt body cho vừa khẩu vị xAI). Ba chỗ xAI validate chặt hơn Anthropic:
 * dồn message `role:'system'` lạc vào field `system`, bơm `required:[]` cho object-schema
 * thiếu required, và bỏ các khoá null mà xAI không nuốt.
 * Chạy: `node --import tsx --test src/core/xaiShim.test.ts`.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import { adaptRequestBody, registerXaiSession, stopXaiShim, XAI_DEFAULT_BASE_URL } from './xaiShim.js';

const parse = (raw: string): any => JSON.parse(adaptRequestBody(raw));

test('dồn message role:system lạc vào field system', () => {
  const out = parse(
    JSON.stringify({
      system: 'gốc',
      messages: [
        { role: 'system', content: 'lạc-1' },
        { role: 'user', content: 'hỏi' },
      ],
    }),
  );
  // message system bị lọc khỏi mảng messages
  assert.deepEqual(
    out.messages.map((m: any) => m.role),
    ['user'],
  );
  // system gốc (chuỗi) được GIỮ, không bị đè, và stray nối vào sau
  assert.deepEqual(out.system, [
    { type: 'text', text: 'gốc' },
    { type: 'text', text: 'lạc-1' },
  ]);
});

test('system dạng mảng: nối thêm stray, không mất block cũ', () => {
  const out = parse(
    JSON.stringify({
      system: [{ type: 'text', text: 'gốc' }],
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'lạc' }] },
        { role: 'user', content: 'x' },
      ],
    }),
  );
  assert.deepEqual(out.system, [
    { type: 'text', text: 'gốc' },
    { type: 'text', text: 'lạc' },
  ]);
});

test('không có system + không có stray: giữ nguyên', () => {
  const out = parse(JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(out.system, undefined);
  assert.equal(out.messages.length, 1);
});

test('object-schema thiếu required → bơm []; required:null bị bỏ rồi bơm lại', () => {
  const out = parse(
    JSON.stringify({
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        {
          name: 'noReq',
          input_schema: { type: 'object', properties: { a: { type: 'string' } } },
        },
        {
          name: 'nullReq',
          input_schema: { type: 'object', properties: { b: { type: 'string' } }, required: null },
        },
      ],
    }),
  );
  assert.deepEqual(out.tools[0].input_schema.required, []);
  assert.deepEqual(out.tools[1].input_schema.required, []);
});

test('required đã là mảng hợp lệ → giữ nguyên', () => {
  const out = parse(
    JSON.stringify({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 't', input_schema: { type: 'object', properties: { a: {} }, required: ['a'] } }],
    }),
  );
  assert.deepEqual(out.tools[0].input_schema.required, ['a']);
});

test('body không phải JSON → trả nguyên văn', () => {
  assert.equal(adaptRequestBody('không-phải-json'), 'không-phải-json');
});

/** Upstream giả (đứng thay LiteLLM/proxy tự dựng): ghi lại path đã nhận, trả số count thật. */
function startUpstream(): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 999 }));
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

test('count_tokens: gateway tự dựng → FORWARD tới upstream (số thật, không ước lượng)', async () => {
  const up = await startUpstream();
  const { baseUrl: shimUrl, sessionKey } = await registerXaiSession({
    baseUrl: up.url,
    getToken: async () => 'tok',
  });
  const res = await fetch(`${shimUrl}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
  });
  const data = (await res.json()) as { input_tokens: number };
  assert.equal(data.input_tokens, 999); // đến từ upstream
  assert.ok(up.hits.some((h) => h.endsWith('/count_tokens')), 'upstream phải nhận count_tokens');
  await up.close();
});

test('count_tokens: xAI đi thẳng → ước lượng tại chỗ (KHÔNG gọi api.x.ai)', async () => {
  const { baseUrl: shimUrl, sessionKey } = await registerXaiSession({
    baseUrl: XAI_DEFAULT_BASE_URL,
    getToken: async () => 'tok',
  });
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'xxxx' }] });
  const res = await fetch(`${shimUrl}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionKey}`, 'content-type': 'application/json' },
    body,
  });
  const data = (await res.json()) as { input_tokens: number };
  assert.equal(data.input_tokens, Math.ceil(body.length / 4)); // nhánh ước lượng, không ra mạng
});

after(async () => {
  await stopXaiShim();
});
