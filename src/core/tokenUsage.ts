import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

import type { ProviderId } from '../config/env.js';

/**
 * ĐẾM TOKEN ĐÃ TIÊU THEO AI — nguồn sự thật là transcript của Claude Code, KHÔNG phải
 * control request /usage.
 *
 * Vì sao cần module này: `/usage` (xem fetchUsageSnapshot ở runner.ts) là control request
 * RIÊNG của Anthropic — nó trả hạn mức GÓI claude.ai. Chạy qua gateway (Grok/LiteLLM) thì
 * endpoint đó không tồn tại, và bản chất cũng sai: provider ngoài tính tiền PAY-AS-YOU-GO
 * theo token, không có "hạn mức phiên 5h". Cái người dùng cần thấy khi đổi sang Grok là
 * ĐÃ ĐỐT BAO NHIÊU TOKEN, nên ta đếm từ transcript — nơi SDK ghi `message.usage` thật của
 * mọi lượt gọi, kể cả lượt của subagent.
 *
 * Nguồn quét: MỌI thư mục cấu hình Claude trên máy (`~/.claude`, `~/.claude-<profile>`…),
 * vì mỗi profile Claude (CLAUDE_CONFIG_DIR) có kho transcript RIÊNG — chỉ đọc `~/.claude`
 * sẽ bỏ sót gần hết dữ liệu khi người dùng chạy tab bằng profile phụ.
 */

/** Bốn thành phần token + số lượt gọi. `total` = tổng cả bốn (cách /cost của CLI đếm). */
export interface TokenTotals {
  calls: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
}

export interface TokenUsageReport {
  /** AI được đếm ('grok' | 'anthropic'). */
  provider: ProviderId;
  totals: TokenTotals;
  byModel: Array<{ model: string } & TokenTotals>;
  /** Gần đây trước, tối đa `days` ngày (mặc định 14). */
  byDay: Array<{ day: string } & TokenTotals>;
  today: TokenTotals;
  /** Ngày đầu/cuối có dữ liệu (YYYY-MM-DD), null nếu chưa dùng AI này bao giờ. */
  firstDay: string | null;
  lastDay: string | null;
  /** Số transcript đã xét / số phải đọc lại từ đĩa lần này (còn lại lấy từ cache). */
  scannedFiles: number;
  freshFiles: number;
  scanMs: number;
}

/**
 * Một lượt gọi model: [id, model, ngày, in, out, cacheWrite, cacheRead].
 *
 * CỐ Ý giữ `id` thay vì gộp sẵn theo (model, ngày): resume/compact khiến Claude Code CHÉP
 * lại lịch sử sang transcript mới, nên CÙNG một lượt gọi nằm trong nhiều file. Gộp sớm thì
 * hết đường khử trùng chéo file và số bị thổi phồng (đo thực tế: +5,4M token chỉ riêng Grok).
 */
type UsageEntry = [string, string, string, number, number, number, number];

/** Bản ghi của MỘT transcript. Đây là đơn vị được cache theo (size, mtime). */
interface FileTally {
  size: number;
  mtimeMs: number;
  entries: UsageEntry[];
}

interface UsageCache {
  version: number;
  files: Record<string, FileTally>;
}

const CACHE_VERSION = 1;

function emptyTotals(): TokenTotals {
  return { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
}

function addEntry(t: TokenTotals, e: UsageEntry): void {
  t.calls += 1;
  t.input += e[3];
  t.output += e[4];
  t.cacheWrite += e[5];
  t.cacheRead += e[6];
  t.total += e[3] + e[4] + e[5] + e[6];
}

/** Đường dẫn cache. Cùng chỗ với các file cấu hình khác của bow (~/.bow-agent/). */
function cachePath(): string {
  return process.env.BOW_USAGE_CACHE ?? join(homedir(), '.bow-agent', 'usage-cache.json');
}

/**
 * Mọi kho transcript trên máy: thư mục `projects` trong `~/.claude` và mọi `~/.claude-<tên>`.
 * Quét theo pattern thay vì hardcode
 * để tự bắt được profile mới (`~/.claude-leo`, `~/.claude-tuan`…) mà không phải sửa code.
 */
function transcriptRoots(): string[] {
  const home = homedir();
  let entries: string[] = [];
  try {
    entries = readdirSync(home);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name === '.claude' || name.startsWith('.claude-'))
    .map((name) => join(home, name, 'projects'))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

/** Liệt kê đệ quy mọi *.jsonl dưới các kho transcript. */
function listTranscripts(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let items: Array<{ name: string; isDirectory(): boolean }>;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = join(dir, it.name);
      if (it.isDirectory()) walk(p);
      else if (it.name.endsWith('.jsonl')) out.push(p);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

/**
 * Đọc MỘT transcript, gộp usage theo (model, ngày).
 *
 * Khử trùng lặp theo `message.id` trong phạm vi file: resume/ghi lại lượt khiến một message
 * xuất hiện nhiều dòng, cộng thẳng sẽ thổi phồng số. Chỉ lọc dòng có chuỗi `"usage"` trước
 * khi JSON.parse — parse mọi dòng của kho transcript nửa GB là phần tốn thời gian nhất.
 */
async function tallyFile(path: string, size: number, mtimeMs: number): Promise<FileTally> {
  const entries: UsageEntry[] = [];
  const seen = new Set<string>();
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let o: {
      message?: { model?: string; id?: string; usage?: Record<string, number> };
      uuid?: string;
      timestamp?: string;
    };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const model = o.message?.model;
    const u = o.message?.usage;
    if (!model || !u) continue;
    const id = String(o.message?.id ?? o.uuid ?? '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const day = String(o.timestamp ?? '').slice(0, 10) || 'unknown';
    entries.push([
      id,
      model,
      day,
      u.input_tokens ?? 0,
      u.output_tokens ?? 0,
      u.cache_creation_input_tokens ?? 0,
      u.cache_read_input_tokens ?? 0,
    ]);
  }
  return { size, mtimeMs, entries };
}

function loadCache(): UsageCache {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), 'utf8')) as UsageCache;
    if (raw?.version === CACHE_VERSION && raw.files) return raw;
  } catch {
    /* cache hỏng/chưa có -> quét lại từ đầu */
  }
  return { version: CACHE_VERSION, files: {} };
}

function saveCache(cache: UsageCache): void {
  try {
    mkdirSync(dirname(cachePath()), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(cache), 'utf8');
  } catch {
    /* không ghi được cache thì chỉ chậm lần sau, không phải lỗi chức năng */
  }
}

/** Model nào thuộc AI nào. Gateway đặt tên tuỳ ý -> mọi thứ KHÔNG phải claude coi là provider ngoài. */
function matchesProvider(model: string, provider: ProviderId): boolean {
  const isClaude = /claude/i.test(model);
  return provider === 'anthropic' ? isClaude : !isClaude;
}

/**
 * Tổng hợp token đã tiêu của một AI. Lần đầu quét toàn bộ transcript (~vài giây với kho
 * nửa GB); các lần sau chỉ đọc lại file có size/mtime đổi nên gần như tức thì.
 */
export async function readTokenUsage(opts: { provider: ProviderId; days?: number }): Promise<TokenUsageReport> {
  const started = Date.now();
  const days = opts.days ?? 14;
  const cache = loadCache();
  const files = listTranscripts(transcriptRoots());
  const next: UsageCache = { version: CACHE_VERSION, files: {} };

  let fresh = 0;
  // Đọc song song có giới hạn: I/O-bound, chạy tuần tự sẽ lâu gấp nhiều lần trên kho lớn.
  const CONCURRENCY = 8;
  let cursor = 0;
  const worker = async () => {
    while (cursor < files.length) {
      const path = files[cursor++];
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = statSync(path);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      const hit = cache.files[path];
      if (hit && hit.size === size && hit.mtimeMs === mtimeMs) {
        next.files[path] = hit;
        continue;
      }
      fresh++;
      try {
        next.files[path] = await tallyFile(path, size, mtimeMs);
      } catch {
        /* file bị xoá/đang ghi dở giữa chừng -> bỏ qua lượt này */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  if (fresh > 0) saveCache(next);

  const totals = emptyTotals();
  const today = emptyTotals();
  const perModel = new Map<string, TokenTotals>();
  const perDay = new Map<string, TokenTotals>();
  const todayKey = new Date().toISOString().slice(0, 10);

  // Khử trùng TOÀN CỤC: cùng một lượt gọi nằm ở nhiều transcript sau resume/compact.
  const counted = new Set<string>();
  for (const tally of Object.values(next.files)) {
    for (const e of tally.entries) {
      const [id, model, day] = e;
      // '<synthetic>' là message do CLI tự dựng khi lỗi/hết hạn mức — không phải lượt gọi model.
      if (model === '<synthetic>' || !matchesProvider(model, opts.provider)) continue;
      if (id) {
        if (counted.has(id)) continue;
        counted.add(id);
      }
      addEntry(totals, e);
      const m = perModel.get(model) ?? emptyTotals();
      addEntry(m, e);
      perModel.set(model, m);
      const d = perDay.get(day) ?? emptyTotals();
      addEntry(d, e);
      perDay.set(day, d);
      if (day === todayKey) addEntry(today, e);
    }
  }

  const daysSorted = [...perDay.keys()].filter((d) => d !== 'unknown').sort();
  return {
    provider: opts.provider,
    totals,
    byModel: [...perModel.entries()].map(([model, t]) => ({ model, ...t })).sort((a, b) => b.total - a.total),
    byDay: daysSorted
      .slice(-days)
      .reverse()
      .map((day) => ({ day, ...(perDay.get(day) as TokenTotals) })),
    today,
    firstDay: daysSorted[0] ?? null,
    lastDay: daysSorted[daysSorted.length - 1] ?? null,
    scannedFiles: files.length,
    freshFiles: fresh,
    scanMs: Date.now() - started,
  };
}
