import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';

/**
 * Tải ẢNH đính kèm của một ticket Jira để agent NHÌN được.
 *
 * Vì sao cần module này: MCP `jira_get_issue`/`jira_get_attachments` chỉ trả TEXT +
 * URL ảnh, KHÔNG trả bytes. Tải URL `/secure/attachment/...` bằng fetch trần → nhận
 * trang login, không phải ảnh. Muốn bytes phải gọi REST Jira có auth. Và `buildTaskBrief`
 * chạy TRƯỚC khi agent (và MCP) khởi động, nên ta tự gọi REST luôn — một đường duy nhất,
 * không phụ thuộc agent đã chạy hay chưa. Xem DESIGN §7.1.
 *
 * Auth lấy từ block `mcpServers.jira.env` trong ~/.claude.json (JIRA_BASE_URL/EMAIL/
 * API_TOKEN) — KHÔNG từ process.env (repo cố ý bỏ, xem env.ts:39). Token là secret cá
 * nhân: không log, chỉ gọi đúng host base URL.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Thư mục cache ảnh Jira (gitignore, cạnh generated-profiles/ — runtime per-máy). */
export const JIRA_CACHE_DIR = join(__dirname, '..', '..', '.jira-cache');

/** Bỏ ảnh lớn hơn ngưỡng này — Claude từ chối ảnh > ~5MB, và tránh phình context. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Timeout mỗi request REST (ms) — tránh treo khi mạng/Atlassian chậm. */
const FETCH_TIMEOUT_MS = 20_000;

/** Timeout tải VIDEO (ms) — video nặng hơn ảnh, cho rộng hơn. */
const VIDEO_FETCH_TIMEOUT_MS = 120_000;

/**
 * Ngưỡng bỏ qua video Jira quá lớn (bytes). Video vượt ngưỡng KHÔNG tự tải (tránh treo
 * bước chuẩn bị brief) — chỉ báo cho agent biết ticket có video lớn. 50MB đủ cho hầu hết
 * screen recording bug; video dài hơn nên xem thủ công. Xem DESIGN §7.2.
 */
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/** MIME ảnh mà Claude vision nhận (khớp media_type ở runner.ts:483). */
const SUPPORTED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Ảnh đã tải, sẵn sàng đẩy vào images[] của runner. */
export interface JiraImage {
  /** Tên file gốc trên Jira (để nhắc agent "ảnh X"). */
  filename: string;
  /** base64 KHÔNG kèm data: prefix (đúng dạng RunOptions.images mong đợi). */
  base64: string;
  /** MIME đã xác thực bằng magic bytes (không tin mimeType Jira khai). */
  mediaType: string;
}

/** Kết quả tải ảnh của một ticket. */
export interface JiraAttachmentResult {
  /** Ảnh tải & xác thực thành công — đưa vào images[] cho agent nhìn. */
  images: JiraImage[];
  /** Tên các attachment là ảnh nhưng tải/nhận diện THẤT BẠI (để báo placeholder). */
  failed: string[];
}

/** Cấu hình auth Jira đọc từ ~/.claude.json. */
interface JiraAuth {
  baseUrl: string;
  email: string;
  token: string;
}

/**
 * Đọc auth Jira từ block mcpServers.jira.env của ~/.claude.json. Trả null nếu thiếu
 * (chưa cấu hình MCP jira, hoặc thiếu biến) → caller bỏ qua ảnh, không kéo sập.
 */
function readJiraAuth(): JiraAuth | null {
  const file = config.claudeJsonPath;
  if (!existsSync(file)) return null;
  let data: { mcpServers?: Record<string, { env?: Record<string, string> }> };
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const servers = data.mcpServers ?? {};
  // Tìm server tên chứa 'jira' (bow-agent gọi nó là 'jira', nhưng chấp nhận biến thể).
  for (const [name, cfg] of Object.entries(servers)) {
    if (!name.toLowerCase().includes('jira')) continue;
    const env = cfg?.env ?? {};
    const baseUrl = env.JIRA_BASE_URL?.replace(/\/+$/, '');
    const email = env.JIRA_EMAIL;
    const token = env.JIRA_API_TOKEN;
    if (baseUrl && email && token) return { baseUrl, email, token };
  }
  return null;
}

/** Header Basic-auth cho Jira Cloud (email:token). */
function authHeader(auth: JiraAuth): string {
  return 'Basic ' + Buffer.from(`${auth.email}:${auth.token}`).toString('base64');
}

/** fetch có timeout (AbortController) — trả Response hoặc ném lỗi. */
async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/** Một attachment trong fields.attachment[] của Jira REST. */
interface RawAttachment {
  id: string;
  filename: string;
  mimeType?: string;
  size?: number;
  content: string; // URL tải nội dung
}

/**
 * Nhận diện MIME thật từ magic bytes — KHÔNG tin mimeType Jira khai (file có thể bị đặt
 * sai đuôi; quan trọng hơn: nếu tải nhầm trang login trả HTML thì magic bytes không khớp
 * → ta loại, tránh nhét HTML vào block image khiến cả message bị Claude từ chối).
 */
function detectImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // "RIFF"
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // "WEBP"
  ) {
    return 'image/webp';
  }
  return null;
}

/** Đuôi file theo MIME (đặt tên cache cho dễ đọc). */
function extFor(mime: string): string {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime] ?? 'bin';
}

/**
 * Làm sạch issueKey thành tên thư mục an toàn (chống path-traversal — issueKey lẽ ra chỉ
 * là PROJ-123, nhưng ta không tin đầu vào). Chỉ giữ chữ/số/gạch.
 */
function safeKey(issueKey: string): string {
  return issueKey.replace(/[^A-Za-z0-9-]/g, '_');
}

/** Đường dẫn thư mục cache của một ticket. */
function issueCacheDir(issueKey: string): string {
  return join(JIRA_CACHE_DIR, safeKey(issueKey));
}

/**
 * Tìm file cache đã tải cho một attachmentId (bất kể đuôi). Trả path hoặc null.
 * Cache theo id vì id Jira ổn định khi nội dung không đổi → tải một lần, dùng lại.
 */
function findCached(dir: string, attachmentId: string): string | null {
  if (!existsSync(dir)) return null;
  const prefix = `${attachmentId}.`;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(prefix)) {
      const p = join(dir, name);
      // Chốt chặn path-traversal: file phải thực sự nằm trong dir.
      if (resolve(p).startsWith(resolve(dir) + sep)) return p;
    }
  }
  return null;
}

/** Lấy metadata attachment của ticket qua REST. Trả [] nếu lỗi/không có. */
async function fetchAttachmentList(auth: JiraAuth, issueKey: string): Promise<RawAttachment[]> {
  const url = `${auth.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=attachment`;
  const res = await fetchWithTimeout(url, { Authorization: authHeader(auth), Accept: 'application/json' });
  if (!res.ok) return [];
  const data = (await res.json()) as { fields?: { attachment?: RawAttachment[] } };
  return data.fields?.attachment ?? [];
}

/**
 * Tải & xác thực một ảnh. Ưu tiên cache đĩa; nếu chưa có thì GET content-url có auth,
 * kiểm magic bytes + kích thước, rồi ghi cache. Trả JiraImage hoặc null nếu fail
 * (quá lớn / không phải ảnh / lỗi mạng).
 */
async function loadOneImage(auth: JiraAuth, issueKey: string, att: RawAttachment): Promise<JiraImage | null> {
  const dir = issueCacheDir(issueKey);

  // 1) Cache hit → đọc từ đĩa (vẫn xác thực magic bytes phòng file hỏng).
  const cached = findCached(dir, att.id);
  if (cached) {
    const buf = readFileSync(cached);
    const mime = detectImageMime(buf);
    if (mime && buf.length <= MAX_IMAGE_BYTES) {
      return { filename: att.filename, base64: buf.toString('base64'), mediaType: mime };
    }
    // Cache hỏng → rơi xuống tải lại.
  }

  // 2) Chỉ tải content-url thuộc ĐÚNG host base URL (chống SSRF nếu URL bị chỉnh).
  if (!att.content || !att.content.startsWith(auth.baseUrl)) return null;

  // Chặn sớm theo size Jira khai (nếu có) để khỏi tải file khổng lồ.
  if (typeof att.size === 'number' && att.size > MAX_IMAGE_BYTES) return null;

  const res = await fetchWithTimeout(att.content, { Authorization: authHeader(auth), Accept: '*/*' });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) return null;

  const mime = detectImageMime(buf);
  if (!mime) return null; // HTML/login page hay file lạ → loại.

  // 3) Ghi cache (best-effort — lỗi ghi không chặn việc dùng ảnh trong phiên này).
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${att.id}.${extFor(mime)}`), buf);
  } catch {
    /* bỏ qua lỗi cache */
  }

  return { filename: att.filename, base64: buf.toString('base64'), mediaType: mime };
}

/**
 * Tải mọi ảnh đính kèm của một ticket cho agent nhìn. Fail-open toàn phần: thiếu auth,
 * lỗi mạng, hay không có ảnh đều trả kết quả rỗng — KHÔNG ném, để việc đọc ticket không
 * bị kéo sập. `failed` liệt kê ảnh lấy hụt để caller chèn placeholder.
 */
export async function fetchJiraTicketImages(issueKey: string): Promise<JiraAttachmentResult> {
  const empty: JiraAttachmentResult = { images: [], failed: [] };
  const auth = readJiraAuth();
  if (!auth) return empty;

  let list: RawAttachment[];
  try {
    list = await fetchAttachmentList(auth, issueKey);
  } catch {
    return empty;
  }

  // Chỉ giữ attachment là ẢNH (theo mimeType Jira khai — lọc thô, magic bytes xác thực sau).
  const imageAtts = list.filter((a) => a.mimeType && SUPPORTED_MIME.has(a.mimeType));
  if (imageAtts.length === 0) return empty;

  const images: JiraImage[] = [];
  const failed: string[] = [];
  // Tuần tự để không nã nhiều request cùng lúc lên Jira (số ảnh/ticket thường nhỏ).
  for (const att of imageAtts) {
    let img: JiraImage | null = null;
    try {
      img = await loadOneImage(auth, issueKey, att);
    } catch {
      img = null;
    }
    if (img) images.push(img);
    else failed.push(att.filename);
  }
  return { images, failed };
}

// ── VIDEO ─────────────────────────────────────────────────────────────────────
// Khác ảnh: Claude KHÔNG "xem" video trực tiếp (không có content block video). Video được
// tải xuống ĐĨA rồi để skill /watch (ffmpeg tách frame + transcript) xử lý. Nên hàm video
// trả ĐƯỜNG DẪN file, không phải base64. Xem DESIGN §7.2.

/** Một video ticket đã tải về đĩa, sẵn cho skill /watch. */
export interface JiraVideo {
  /** Tên file gốc trên Jira. */
  filename: string;
  /** Đường dẫn tuyệt đối file video đã tải (trong .jira-cache/). */
  path: string;
  /** Kích thước (bytes). */
  size: number;
}

/** Kết quả tải video của một ticket. */
export interface JiraVideoResult {
  /** Video tải thành công — đưa đường dẫn cho agent dùng /watch. */
  videos: JiraVideo[];
  /** Video là ảnh-động/clip nhưng BỎ QUA vì quá lớn (> MAX_VIDEO_BYTES): tên + size(MB). */
  skippedTooLarge: { filename: string; sizeMb: number }[];
  /** Video tải THẤT BẠI (lỗi mạng...). */
  failed: string[];
}

/** Đuôi file video an toàn từ filename (giữ đuôi gốc nếu là video phổ biến, mặc định mp4). */
function videoExt(filename: string): string {
  const m = filename.toLowerCase().match(/\.(mp4|mov|mkv|webm|avi|m4v)$/);
  return m ? m[1] : 'mp4';
}

/**
 * Tải một video về đĩa (ưu tiên cache). Trả JiraVideo hoặc null nếu lỗi. Không xác thực
 * magic bytes như ảnh (nhiều container video, để ffmpeg của /watch tự kiểm) — nhưng vẫn
 * chỉ tải từ đúng host base URL (chống SSRF).
 */
async function loadOneVideo(auth: JiraAuth, issueKey: string, att: RawAttachment): Promise<JiraVideo | null> {
  const dir = issueCacheDir(issueKey);

  // Cache hit.
  const cached = findCached(dir, att.id);
  if (cached) {
    return { filename: att.filename, path: cached, size: statSync(cached).size };
  }

  if (!att.content || !att.content.startsWith(auth.baseUrl)) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VIDEO_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(att.content, {
      headers: { Authorization: authHeader(auth), Accept: '*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_VIDEO_BYTES) return null; // phòng khi size khai sai
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `${att.id}.${videoExt(att.filename)}`);
    writeFileSync(out, buf);
    return { filename: att.filename, path: out, size: buf.length };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tải video đính kèm của một ticket cho skill /watch xử lý. Video quá lớn (> MAX_VIDEO_BYTES)
 * bị BỎ QUA để không treo bước chuẩn bị brief — chỉ báo tên+size. Fail-open toàn phần.
 */
export async function fetchJiraTicketVideos(issueKey: string): Promise<JiraVideoResult> {
  const empty: JiraVideoResult = { videos: [], skippedTooLarge: [], failed: [] };
  const auth = readJiraAuth();
  if (!auth) return empty;

  let list: RawAttachment[];
  try {
    list = await fetchAttachmentList(auth, issueKey);
  } catch {
    return empty;
  }

  const videoAtts = list.filter((a) => a.mimeType?.startsWith('video/'));
  if (videoAtts.length === 0) return empty;

  const videos: JiraVideo[] = [];
  const skippedTooLarge: { filename: string; sizeMb: number }[] = [];
  const failed: string[] = [];
  for (const att of videoAtts) {
    // Bỏ qua sớm nếu size Jira khai vượt ngưỡng — không tải.
    if (typeof att.size === 'number' && att.size > MAX_VIDEO_BYTES) {
      skippedTooLarge.push({ filename: att.filename, sizeMb: Math.round((att.size / 1024 / 1024) * 10) / 10 });
      continue;
    }
    let vid: JiraVideo | null = null;
    try {
      vid = await loadOneVideo(auth, issueKey, att);
    } catch {
      vid = null;
    }
    if (vid) videos.push(vid);
    else failed.push(att.filename);
  }
  return { videos, skippedTooLarge, failed };
}
