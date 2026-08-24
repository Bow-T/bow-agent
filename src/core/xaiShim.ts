/**
 * Shim Anthropic → xAI. Chạy trong tiến trình bow, KHÔNG cần LiteLLM/Python.
 *
 * xAI CÓ endpoint `/v1/messages` nói đúng giọng Anthropic (docs không liệt kê nhưng nó tồn
 * tại và trả `content` blocks / `thinking` / `cache_read_input_tokens`), nên không phải dịch
 * gì nhiều — chỉ GỌT ba chỗ Claude Code gửi mà xAI validate chặt hơn Anthropic:
 *
 *  1. Claude Code đôi khi để một message `role: 'system'` trong mảng `messages`
 *     → xAI trả 400 "Invalid message role". Dồn nó vào field `system` (đúng chỗ của nó).
 *  2. `/v1/messages/count_tokens` xAI không có → 404. Trả ước lượng tại chỗ.
 *  3. Object-schema của tool thiếu `required` (hoặc để null) → 400
 *     "/required: null is not of type array". Bơm `required: []`.
 *
 * Cả ba đã kiểm chứng bằng phiên agent thật chạy hết plan-mode + tool use trên grok-4.6.
 *
 * BẢO MẬT: chỉ nghe 127.0.0.1. Token THẬT không bao giờ đi vào env của subprocess `claude` —
 * bow phát cho mỗi lượt chạy một `sessionKey` ngẫu nhiên, shim tra ngược ra tài khoản rồi tự
 * lấy access token (đã refresh) lúc gửi lên xAI.
 */
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

/** Upstream mặc định: API của xAI. Profile có baseUrl riêng (gateway tự dựng) thì dùng cái đó. */
export const XAI_DEFAULT_BASE_URL = 'https://api.x.ai';

/** Thứ shim cần biết về một lượt chạy: gọi ai, bằng token nào. */
type ShimSession = { baseUrl: string; getToken: () => Promise<string | undefined> };

const sessions = new Map<string, ShimSession>();
let server: Server | null = null;
let starting: Promise<string> | null = null;

/** xAI validate JSON Schema chặt hơn Anthropic — chuẩn hoá để không nổ 400. */
function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (v === null && k === 'required') continue; // sẽ bơm lại thành [] bên dưới
      if (v === null && (k === 'properties' || k === 'items' || k === 'additionalProperties')) continue;
      out[k] = sanitizeSchema(v);
    }
    if (out.type === 'object' && out.properties && !Array.isArray(out.required)) out.required = [];
    return out;
  }
  return node;
}

/** Gọt body một request /v1/messages cho vừa khẩu vị xAI. Không parse được → trả nguyên. */
export function adaptRequestBody(raw: string): string {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return raw;
  }
  const messages = payload.messages;
  if (Array.isArray(messages)) {
    const strays: Record<string, unknown>[] = [];
    payload.messages = messages.filter((m: Record<string, unknown>) => {
      if (m?.role === 'system') {
        strays.push(m);
        return false;
      }
      return true;
    });
    if (strays.length > 0) {
      const asText = (m: Record<string, unknown>): string =>
        Array.isArray(m.content)
          ? (m.content as { text?: string }[]).map((b) => b.text ?? '').join('\n')
          : String(m.content ?? '');
      const extra = strays.map(asText).filter(Boolean).map((text) => ({ type: 'text', text }));
      // Giữ nguyên `system` sẵn có: Anthropic cho phép nó là CHUỖI — nếu chỉ gán `extra` khi
      // không phải mảng thì mất luôn system prompt gốc. Chuẩn hoá chuỗi → block rồi nối thêm.
      const prior = Array.isArray(payload.system)
        ? payload.system
        : typeof payload.system === 'string' && payload.system
          ? [{ type: 'text', text: payload.system }]
          : [];
      payload.system = [...prior, ...extra];
    }
  }
  return JSON.stringify(sanitizeSchema(payload));
}

/**
 * Đăng ký một lượt chạy và nhận `sessionKey` để đặt vào ANTHROPIC_AUTH_TOKEN của subprocess.
 * Trả cả base URL trỏ về shim. Gọi trước mỗi lần spawn `claude`.
 */
export async function registerXaiSession(session: ShimSession): Promise<{ baseUrl: string; sessionKey: string }> {
  const shimUrl = await ensureShim();
  const sessionKey = `bow-${randomBytes(24).toString('hex')}`;
  sessions.set(sessionKey, session);
  return { baseUrl: shimUrl, sessionKey };
}

/** Thu hồi session sau khi lượt chạy kết thúc (không giữ map phình mãi). */
export function releaseXaiSession(sessionKey: string): void {
  sessions.delete(sessionKey);
}

/** Bật shim nếu chưa chạy. Cổng do OS cấp — không đụng cổng nào của bow. */
function ensureShim(): Promise<string> {
  if (starting) return starting;
  starting = new Promise<string>((resolve, reject) => {
    const s = createServer(handleRequest);
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        server = s;
        resolve(`http://127.0.0.1:${addr.port}`);
      } else {
        reject(new Error('Không lấy được cổng cho shim xAI.'));
      }
    });
    s.unref(); // shim không giữ tiến trình sống
  });
  return starting;
}

/** Đóng shim (dùng trong test). */
export async function stopXaiShim(): Promise<void> {
  const s = server;
  server = null;
  starting = null;
  sessions.clear();
  if (s) await new Promise<void>((r) => s.close(() => r()));
}

function handleRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    void forward(req, res, Buffer.concat(chunks).toString('utf8'));
  });
}

async function forward(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  raw: string,
): Promise<void> {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  const session = sessions.get(bearer);
  if (!session) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Phiên shim không hợp lệ.' } }));
    return;
  }

  const path = (req.url ?? '').split('?')[0];
  // count_tokens: gateway tự dựng (LiteLLM…) CÓ endpoint này → để rơi xuống forward bên dưới
  // cho số CHÍNH XÁC. Chỉ xAI đi thẳng mới không có → ước lượng thô (~4 ký tự/token) tại chỗ,
  // tránh 404 + round-trip thừa trên đúng luồng chính.
  const isXaiDirect = session.baseUrl.replace(/\/$/, '') === XAI_DEFAULT_BASE_URL;
  if (path.endsWith('/count_tokens') && isXaiDirect) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) }));
    return;
  }

  const token = await session.getToken();
  if (!token) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'Tài khoản Grok chưa đăng nhập (hoặc token hết hạn và không refresh được).' },
      }),
    );
    return;
  }

  try {
    const upstream = await fetch(session.baseUrl.replace(/\/$/, '') + (req.url ?? ''), {
      method: req.method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'anthropic-version': (req.headers['anthropic-version'] as string) ?? '2023-06-01',
      },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : adaptRequestBody(raw),
    });
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    if (upstream.body) Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res);
    else res.end();
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: (e as Error).message } }));
  }
}
