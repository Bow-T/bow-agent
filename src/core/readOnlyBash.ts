/**
 * Nhận diện lệnh Bash CHỈ-ĐỌC (không đổi trạng thái) — để cổng duyệt KHÔNG gắn cờ `risky`
 * oan cho các lệnh xem file, khiến toggle "Tự duyệt" của web vẫn bắt người bấm tay.
 *
 * VÌ SAO CẦN: isRiskyCommand (runner) quét regex trên chuỗi THÔ + bản đã BUNG NHÁY
 * (scannableCommand). Hệ quả là hai lớp báo động giả rất phổ biến:
 *   1) `awk 'NR>=470 && NR<=520' f.tsx`  → dấu `>` trong biểu thức so sánh bị coi là redirect ghi;
 *   2) `grep -rn "rm -rf" src`           → nháy bị bung, chuỗi TÌM KIẾM `rm -rf` thành "lệnh xoá".
 * Cả hai chỉ đọc file, nhưng bị đánh risky → người dùng phải bấm duyệt từng lần.
 *
 * CÁCH LÀM (ngược hướng với RISKY_COMMANDS): thay vì đoán "có nguy hiểm không" trên chuỗi đã bung,
 * ta CHỨNG MINH "chắc chắn vô hại" bằng một parser tôn trọng nháy:
 *   - tách lệnh theo `;` `&&` `||` `|` / xuống dòng — CHỈ ở NGOÀI nháy;
 *   - từ chối mọi thứ có thể bung thành lệnh khác: `$( )`, backtick, `<( )`, `>( )`, subshell `( )`,
 *     nhóm `{ }`, chạy nền `&`;
 *   - từ chối MỌI redirect ghi, trừ `>/dev/null` và `>&1`/`>&2` (không tạo/ghi file thật);
 *   - mỗi đoạn phải có lãnh-đạo-lệnh nằm trong danh sách ĐỌC dưới đây, và qua nốt bộ kiểm cờ
 *     riêng của lệnh đó (sed không `-i`, find không `-delete/-exec`, sort không `-o`…);
 *   - path/nội dung chạm file bí mật (.env, .ssh, credentials…) → KHÔNG nới (giữ nguyên hành vi cũ).
 *
 * FAIL-SAFE: nghi ngờ là trả false — khi đó lệnh rơi lại đúng đường cũ (risky/gate), không mất
 * an toàn, chỉ mất phần tiện. Hàm THUẦN (không I/O) để test kỹ.
 */

/** Lãnh đạo lệnh CHỈ-ĐỌC. Cố ý KHÔNG có: tee, sort -o (đã lọc cờ), npm/yarn (chạy script tuỳ ý),
 *  xargs (chạy lệnh khác), env (đổi môi trường rồi chạy), man/less (mở pager treo phiên). */
const READ_ONLY_LEADERS = new Set([
  'cat', 'bat', 'head', 'tail', 'nl', 'tac', 'rev', 'wc', 'ls', 'pwd', 'echo', 'printf',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',
  'sed', 'awk', 'gawk', 'find', 'fd',
  'file', 'stat', 'basename', 'dirname', 'realpath', 'readlink', 'tree', 'du', 'df',
  'sort', 'uniq', 'cut', 'paste', 'comm', 'diff', 'jq', 'yq', 'column', 'date', 'uname',
  'whoami', 'hostname', 'which', 'type', 'true', 'false', 'shasum', 'md5', 'md5sum',
  'git', 'gh',
]);

/** Subcommand git CHỈ-ĐỌC. `branch`/`tag`/`remote`/`stash`/`worktree` được kèm bộ lọc cờ riêng
 *  bên dưới (chúng có nhánh GHI: -d, add, set-url, drop, remove…). */
const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe',
  'shortlog', 'whatchanged', 'cat-file', 'grep', 'reflog', 'branch', 'tag', 'remote', 'stash',
  'worktree', 'config',
]);

/** Nhánh GHI của các subcommand git "lai" — có mặt là KHÔNG nới. */
const GIT_SUBCOMMAND_WRITE_ARG =
  /^(-d|-D|-m|-M|-f|--delete|--move|--force|--set-upstream|add|set-url|remove|rename|prune|push|drop|pop|apply|clear|save|store|create|lock|unlock|repair)$/;

/** gh: chỉ các lệnh XEM. `gh api` chỉ cho GET (không -X/-f/--method). */
const GH_READ =
  /^gh\s+(pr\s+(view|diff|list|checks|status)|issue\s+(view|list)|repo\s+view|run\s+(list|view)|api\s+[^\s]+)(\s|$)/;

/** File bí mật — chạm tới thì KHÔNG nới (giữ nguyên cổng duyệt cũ, kể cả khi chỉ đọc). */
const SECRET_HINT = /(\.env\b|\.env\.|\.ssh\/|id_rsa|id_ed25519|\.git-credentials|\.npmrc|\.pypirc|\.netrc|credentials|secrets?\.(ya?ml|json)|\.pem\b|\.p12\b)/i;

/**
 * Tách lệnh thành các đoạn ĐƠN, tôn trọng nháy. Trả null nếu gặp bất kỳ cấu trúc nào khiến
 * ta không suy chắc được lệnh sẽ chạy (command-substitution, subshell, chạy nền, redirect ghi).
 */
function splitSegments(cmd: string): string[] | null {
  const segments: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      cur += ch;
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') { cur += ch + (cmd[i + 1] ?? ''); i += 2; continue; }
      if (ch === '`' || (ch === '$' && cmd[i + 1] === '(')) return null; // bung lệnh trong nháy kép
      if (ch === '"') quote = null;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; i++; continue; }
    if (ch === '\\') { cur += ch + (cmd[i + 1] ?? ''); i += 2; continue; }
    if (ch === '`') return null;
    if (ch === '$' && cmd[i + 1] === '(') return null;
    if ((ch === '<' || ch === '>') && cmd[i + 1] === '(') return null; // process substitution
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') return null; // subshell / nhóm lệnh
    if (ch === '>') {
      // Redirect: chỉ chấp nhận thứ KHÔNG tạo/ghi file thật (>/dev/null, >&1, >&2).
      let j = i + 1;
      if (cmd[j] === '>') j++;
      while (cmd[j] === ' ') j++;
      const ok = cmd.slice(j).match(/^(?:&[12]|\/dev\/null)(?=$|[\s;&|])/);
      if (!ok) return null;
      i = j + ok[0].length;
      continue;
    }
    if (ch === '\n' || ch === ';') { segments.push(cur); cur = ''; i++; continue; }
    if (ch === '|') { segments.push(cur); cur = ''; i += cmd[i + 1] === '|' ? 2 : 1; continue; }
    if (ch === '&') {
      if (cmd[i + 1] === '&') { segments.push(cur); cur = ''; i += 2; continue; }
      return null; // chạy nền `cmd &` — không nới
    }
    cur += ch;
    i++;
  }
  if (quote) return null; // nháy chưa đóng
  segments.push(cur);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Tách token của một đoạn, giữ nguyên phần trong nháy làm MỘT token. */
function tokenize(segment: string): string[] {
  return segment.match(/'[^']*'|"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
}

const unquote = (t: string): string =>
  (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))
    ? t.slice(1, -1)
    : t;

/** Một đoạn lệnh đơn có chắc chắn chỉ đọc không? */
function segmentIsReadOnly(segment: string): boolean {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return false;
  const leader = unquote(tokens[0]);
  if (!/^[a-z0-9_.-]+$/i.test(leader)) return false; // path tuyệt đối (/bin/rm), gán biến FOO=bar…
  if (!READ_ONLY_LEADERS.has(leader)) return false;
  const args = tokens.slice(1);
  const flags = args.filter((a) => a.startsWith('-'));

  switch (leader) {
    case 'sed':
      // -i / --in-place ghi đè file; lệnh `w`/`W` trong script ghi ra file.
      if (flags.some((f) => /^-[a-z]*i/.test(f) || f.startsWith('--in-place'))) return false;
      if (args.some((a) => !a.startsWith('-') && /\bw\b|\/w|W/.test(unquote(a)))) return false;
      return true;
    case 'awk':
    case 'gawk': {
      const script = args.filter((a) => !a.startsWith('-')).map(unquote).join(' ');
      // awk ghi được file (`print > "f"`), chạy được lệnh (`system(...)`, `| "sh"`).
      if (/\b(system|close|printf?)\s*\(?[^;{}]*>/.test(script)) return false;
      if (/\bsystem\s*\(|\|\s*["'&]|>\s*["'$]/.test(script)) return false;
      return true;
    }
    case 'find':
    case 'fd':
      if (args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls|x|X)$/.test(unquote(a)))) return false;
      if (args.some((a) => /^(--exec|--exec-batch|-x|-X)$/.test(unquote(a)))) return false;
      return true;
    case 'sort':
      if (flags.some((f) => f === '-o' || f.startsWith('--output'))) return false;
      return true;
    case 'diff':
      if (flags.some((f) => /^--(to-file|from-file)/.test(f))) return true;
      return true;
    case 'git': {
      const sub = args.find((a) => !a.startsWith('-'));
      if (!sub || !GIT_READ_SUBCOMMANDS.has(unquote(sub))) return false;
      const after = args.slice(args.indexOf(sub) + 1).map(unquote);
      if (after.some((a) => GIT_SUBCOMMAND_WRITE_ARG.test(a))) return false;
      if (unquote(sub) === 'config' && !after.some((a) => a === '--get' || a === '--list' || a === '-l'))
        return false;
      return true;
    }
    case 'gh':
      return GH_READ.test(segment.trim()) && !/(-X|--method|-f\s|--field)/.test(segment);
    default:
      return true;
  }
}

/**
 * True nếu lệnh Bash CHẮC CHẮN chỉ đọc/không đổi trạng thái → cổng duyệt có thể tự cho chạy
 * (và tuyệt đối KHÔNG gắn `risky`, để toggle Tự duyệt không phải hỏi lại).
 */
export function isReadOnlyBash(cmd: string): boolean {
  const c = cmd.trim();
  if (!c || c.length > 4000) return false;
  if (SECRET_HINT.test(c)) return false;
  const segments = splitSegments(c);
  if (!segments || segments.length === 0) return false;
  return segments.every(segmentIsReadOnly);
}
