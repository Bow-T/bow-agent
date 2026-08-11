/**
 * fileApi — hai endpoint CHỈ ĐỌC cho các tầng sâu của Cosmos (FILE→FUNCTION→CODE):
 *  - GET /api/file-source  : nội dung thật một file (tầng CODE).
 *  - GET /api/file-symbols : symbol cấp cao (function/class/…) làm "moon" quanh file (tầng FUNCTION).
 * Tách khỏi server.ts (đã ~2500 dòng) để không phình lõi. Không ghi gì, không đụng cổng an toàn.
 * `resolveCwd` do server truyền vào (cùng nguồn cwd với /api/filetree) — tránh nhân đôi logic mode.
 */
import type { Express, Request, Response } from 'express';
import fs from 'node:fs';
import { resolve, sep } from 'node:path';

const BINARY = /\.(gif|mp4|mov|png|jpe?g|webp|ico|woff2?|ttf|otf|pdf|zip|lock)$/i;
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|dart|java|kt|rb|c|cc|cpp|h|hpp|cs|php|swift)$/i;

/** (regex, kind) — quét theo dòng, tên ở group 1. Rộng-rãi có chủ đích; chấp nhận vài false-positive. */
const PATTERNS: [RegExp, string][] = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface'],
  [/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, 'type'],
  [/^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
  [/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'function'],
  [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_$][\w$]*)/, 'function'],  // rust
  [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/, 'function'],       // go
  [/^\s*def\s+([A-Za-z_$][\w$]*)/, 'function'],                        // python
];

/** Resolve path trong cwd + chống ../../ escape. Trả abs hợp lệ, hoặc null nếu thoát gốc. */
function safeAbs(cwd: string, rel: string): string | null {
  const abs = resolve(cwd, rel);
  if (abs !== cwd && !abs.startsWith(cwd + sep)) return null;
  return abs;
}

export function mountFileApi(app: Express, resolveCwd: () => string): void {
  app.get('/api/file-source', (req: Request, res: Response) => {
    const rel = String(req.query.path || '').trim();
    if (!rel) { res.status(400).json({ error: 'thiếu path' }); return; }
    const abs = safeAbs(resolveCwd(), rel);
    if (!abs) { res.status(403).json({ error: 'ngoài workspace' }); return; }
    if (BINARY.test(rel)) { res.json({ path: rel, binary: true, lines: [] }); return; }
    try {
      const buf = fs.readFileSync(abs);
      if (buf.length > 1_000_000 || buf.includes(0)) { res.json({ path: rel, binary: true, lines: [] }); return; }
      const lines = buf.toString('utf8').split('\n').slice(0, 2000);
      res.json({ path: rel, binary: false, lines, truncated: lines.length >= 2000 });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.get('/api/file-symbols', (req: Request, res: Response) => {
    const rel = String(req.query.path || '').trim();
    if (!rel) { res.status(400).json({ error: 'thiếu path' }); return; }
    const abs = safeAbs(resolveCwd(), rel);
    if (!abs) { res.status(403).json({ error: 'ngoài workspace' }); return; }
    if (!CODE.test(rel)) { res.json({ path: rel, symbols: [] }); return; }
    try {
      const buf = fs.readFileSync(abs);
      if (buf.length > 1_000_000 || buf.includes(0)) { res.json({ path: rel, symbols: [] }); return; }
      const src = buf.toString('utf8').split('\n');
      const symbols: { name: string; kind: string; line: number }[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < src.length && symbols.length < 200; i++) {
        for (const [re, kind] of PATTERNS) {
          const m = src[i].match(re);
          if (m && m[1] && !seen.has(m[1])) { seen.add(m[1]); symbols.push({ name: m[1], kind, line: i + 1 }); break; }
        }
      }
      res.json({ path: rel, symbols });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });
}
