/**
 * Chuan hoa mot lenh shell TRUOC khi match cac mau nguy hiem — chong ne tranh bang
 * obfuscation. Cac danh sach chan (RISKY_COMMANDS o runner, BLOCK o sprint-scan) match
 * regex tren chuoi THO, nen `r""m -rf`, `bash -c 'rm -rf ~'`, `echo cm0= | base64 -d | sh`
 * co the lot. Ham nay bung cac lop che de danh sach cu quet duoc ca ban da bung.
 *
 * Y tuong rut gon tu `scannableCommand` cua du an QM (yc-software/qm, ~400 dong shell-parser).
 * CO Y khong phai parser day du: chi mot luoi rong bat mau ne pho bien nhat. QM tu thua nhan
 * command-policy van ne duoc — day la "speed bump", khong phai hang rao cung. Duong ghi NGOAI
 * repo van bi isPathInRepo chan o nhanh file-write cua runner.
 *
 * Cac phep bung:
 *   1) bo quote RONG va \-escape le (`r""m`, `r\m` -> `rm`); boc noi dung quote don/kep.
 *   2) trich payload cua shell-runner long: `bash/sh/zsh -c <X>`, `eval <X>`.
 *   3) trich ve TRAI cua pipe-to-shell: `<X> | bash` (X hay chua lenh bi che sau echo/base64).
 */
export function scannableCommand(cmd: string, depth = 0): string {
  const unquoted = cmd
    .replace(/"((?:[^"\\]|\\.)*)"/g, '$1')
    .replace(/'([^']*)'/g, '$1')
    .replace(/\\([\w@%+=:,./~-])/g, '$1');
  const parts = [unquoted];
  if (depth < 4) {
    const runner =
      unquoted.match(/\b(?:bash|sh|zsh)\s+-c\s+(.+)$/s) ?? unquoted.match(/\beval\s+(.+)$/s);
    if (runner?.[1]) parts.push(scannableCommand(runner[1], depth + 1));
    const piped = unquoted.match(/^(.+?)\|\s*(?:sh|bash|zsh)\b/s);
    if (piped?.[1]) parts.push(scannableCommand(piped[1], depth + 1));
  }
  return parts.join('\n');
}

/**
 * True neu BAT KY regex nao trong `patterns` khop lenh — quet ca chuoi GOC lan ban chuan-hoa.
 * Dung chung cho isRiskyCommand (runner) va autoApprovalPolicy (sprint-scan).
 */
export function matchesAnyScannable(cmd: string, patterns: readonly RegExp[]): boolean {
  const scannable = `${cmd}\n${scannableCommand(cmd)}`;
  return patterns.some((re) => re.test(scannable));
}
