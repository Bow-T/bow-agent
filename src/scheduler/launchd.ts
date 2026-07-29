import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Sinh & cài LaunchAgent (macOS launchd) để giữ cho sprint-scan "sống" — nó gọi
 * `bow sprint-scan --tick` định kỳ; agent tự đọc sprint-schedule.json để quyết có chạy
 * thật không (xem schedule.ts). launchd chỉ lo "kích đều đặn + tự sống lại sau reboot",
 * KHÔNG giữ tri thức lịch — đúng ý "cả hai": agent giữ lịch, OS giữ cho chạy.
 *
 * Chỉ macOS (launchd). Linux/Windows: in hướng dẫn cron/Task Scheduler tương đương.
 */

const LABEL = 'com.bow-agent.sprint-scan';

/** Đường dẫn file plist trong ~/Library/LaunchAgents. */
export function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export interface LaunchdInstallOptions {
  /** Node/tsx chạy CLI. Mặc định process.execPath (node hiện tại). */
  nodePath?: string;
  /** Đường dẫn entry CLI đã build (dist/cli/index.js) hoặc src qua tsx. */
  cliEntry: string;
  /**
   * Nếu chạy src `.ts` qua tsx (chưa build), truyền loader. PHẢI là đường dẫn TUYỆT ĐỐI tới
   * gói tsx (vd `<bow>/node_modules/tsx`), KHÔNG dùng bare `'tsx'`. Lý do: launchd chạy với
   * WorkingDirectory là repo ĐÍCH (monorepo…) nơi KHÔNG có tsx trong node_modules → Node resolve
   * bare `tsx` theo cwd sẽ ERR_MODULE_NOT_FOUND và mọi tick crash. Rỗng = chạy node thẳng file .js.
   */
  tsxLoader?: string;
  /** Chu kỳ launchd kích --tick, giây. Mặc định 300 (5 phút) — đủ nhạy cho mốc giờ. */
  intervalSec?: number;
  /**
   * WorkingDirectory của tiến trình launchd. QUAN TRỌNG: đây là nơi Node resolve module (gồm tsx
   * nếu chạy dev) — nên đặt = THƯ MỤC bow-agent (có node_modules), KHÔNG phải repo đích. cwd repo
   * đích để agent thao tác do `--tick` tự đọc từ sprint-schedule.json/BOW_CWD, độc lập cái này.
   */
  cwd: string;
  /** File log stdout/stderr. Mặc định ~/.bow-agent/sprint-scan.log. */
  logPath?: string;
}

/**
 * Dựng nội dung plist. Tách riêng để test được (không đụng đĩa). ProgramArguments gọi
 * `<node> [--import tsx] <cliEntry> sprint-scan --tick`. StartInterval kích đều; agent tự
 * quyết bỏ qua nếu chưa tới giờ.
 */
export function buildPlist(opts: LaunchdInstallOptions): string {
  const node = opts.nodePath ?? process.execPath;
  const interval = opts.intervalSec ?? 300;
  const log = opts.logPath ?? join(homedir(), '.bow-agent', 'sprint-scan.log');

  const args = [node];
  if (opts.tsxLoader) {
    // tsxLoader phải TUYỆT ĐỐI (xem doc option). Nếu caller lỡ truyền bare 'tsx', cố resolve từ
    // WorkingDirectory (opts.cwd = bow-agent) sang đường dẫn thật để `--import` không phụ thuộc cwd.
    let loader = opts.tsxLoader;
    if (!loader.startsWith('/')) {
      try {
        const req = createRequire(join(resolve(opts.cwd), 'noop.js'));
        loader = req.resolve(opts.tsxLoader);
      } catch {
        /* resolve fail — giữ nguyên (sẽ lộ lỗi ở log, còn hơn im lặng dùng sai) */
      }
    }
    args.push('--import', loader);
  }
  args.push(resolve(opts.cliEntry), 'sprint-scan', '--tick');

  const argXml = args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>WorkingDirectory</key>
  <string>${escapeXml(resolve(opts.cwd))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(log)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Ghi plist ra ~/Library/LaunchAgents rồi nạp (bootstrap) vào launchd. */
export function installLaunchd(opts: LaunchdInstallOptions): { plist: string; loaded: boolean } {
  if (process.platform !== 'darwin') {
    throw new Error('installLaunchd chỉ hỗ trợ macOS. Trên Linux dùng cron, Windows dùng Task Scheduler.');
  }
  const file = plistPath();
  mkdirSync(dirname(file), { recursive: true });
  // Đảm bảo thư mục log tồn tại.
  const log = opts.logPath ?? join(homedir(), '.bow-agent', 'sprint-scan.log');
  mkdirSync(dirname(log), { recursive: true });

  const content = buildPlist(opts);
  writeFileSync(file, content, 'utf8');

  // Nạp: gỡ bản cũ (nếu có) rồi bootstrap. Dùng launchctl bootstrap (API mới) fallback load.
  const uid = process.getuid ? process.getuid() : 0;
  let loaded = false;
  try {
    try {
      execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
    } catch {
      /* chưa nạp bao giờ — bỏ qua */
    }
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, file], { stdio: 'ignore' });
    loaded = true;
  } catch {
    // Fallback API cũ.
    try {
      execFileSync('launchctl', ['unload', file], { stdio: 'ignore' });
    } catch {
      /* bỏ qua */
    }
    try {
      execFileSync('launchctl', ['load', file], { stdio: 'ignore' });
      loaded = true;
    } catch {
      loaded = false;
    }
  }
  return { plist: file, loaded };
}

/** Gỡ LaunchAgent: bootout + xoá file plist. No-op nếu chưa cài. */
export function uninstallLaunchd(): { removed: boolean } {
  const file = plistPath();
  const uid = process.getuid ? process.getuid() : 0;
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
  } catch {
    try {
      execFileSync('launchctl', ['unload', file], { stdio: 'ignore' });
    } catch {
      /* bỏ qua */
    }
  }
  if (existsSync(file)) {
    unlinkSync(file);
    return { removed: true };
  }
  return { removed: false };
}
