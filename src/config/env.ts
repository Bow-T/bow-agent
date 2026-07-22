import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';


/**
 * Cấu hình đọc từ biến môi trường (.env). Đây là NGUỒN DUY NHẤT đọc process.env —
 * mọi nơi khác import từ đây, không đọc process.env rải rác.
 */

function optional(key: string): string | undefined {
  const value = process.env[key];
  return value && value.trim() !== '' ? value : undefined;
}

/**
 * Tự động tải token từ file token.txt của profile Claude đang chạy và thiết lập vào
 * process.env tương ứng để SDK và CLI tự dùng.
 *
 * CHỈ nhận API key dài hạn (`sk-ant-api…`) từ token.txt. OAuth access token của login
 * Claude Code (`sk-ant-oat…`) CỐ Ý bị bỏ qua vì token.txt là snapshot TĨNH không bao giờ
 * refresh, còn OAuth access token sống ngắn (~vài giờ) → sau khi hết hạn, ép nó qua
 * CLAUDE_CODE_OAUTH_TOKEN khiến CLI dùng token chết → 401 "Invalid authentication
 * credentials", trong khi login-of-directory (Keychain/`.credentials.json` của CLAUDE_CONFIG_DIR)
 * VẪN còn hạn nhờ CLI tự refresh. Bỏ qua OAuth ở đây = để CLI tự đọc login gốc thư mục đã
 * refresh, khỏi phải re-login mỗi vài giờ. Muốn ghim token bền → dùng API key (sk-ant-api).
 */
export function loadActiveProfileToken(): void {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const tokenFile = join(configDir, 'token.txt');
  if (existsSync(tokenFile)) {
    try {
      const token = readFileSync(tokenFile, 'utf8').trim();
      // CHỈ API key thật (`sk-ant-api…`) mới ghim vào env. OAuth (`sk-ant-oat…`) rơi xuống
      // nhánh dưới (xóa env) để CLI tự dùng login-of-directory đã auto-refresh.
      if (token && token.startsWith('sk-ant-api')) {
        process.env.ANTHROPIC_API_KEY = token;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        return;
      }
    } catch (e) {
      console.error('Lỗi khi đọc token.txt cho profile:', e);
    }
  }
  // Không có API key trong token.txt (rỗng / OAuth / thiếu file) → xóa biến môi trường để
  // CLI dùng auth gốc của thư mục profile (Keychain/.credentials.json, tự refresh).
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

// Chạy khởi tạo token ngay khi nạp env config
loadActiveProfileToken();

/**
 * Đường dẫn thư mục config của một profile Claude theo TÊN. 'default' (hoặc rỗng) = login
 * mặc định máy (~/.claude) → trả undefined để KHÔNG set CLAUDE_CONFIG_DIR tường minh (xem
 * saveActiveProfileToEnv/loadActiveProfileToken: set path ~/.claude trỏ nhầm Keychain key).
 * Profile phụ → ~/.claude-<name>.
 */
export function profileConfigDir(profileName: string | undefined): string | undefined {
  const name = (profileName ?? 'default').trim();
  if (!name || name === 'default') return undefined;
  return join(homedir(), `.claude-${name}`);
}

/**
 * Tính env-PATCH auth cho một profile Claude theo TÊN, KHÔNG đụng process.env toàn cục —
 * để mỗi query() (mỗi tab) chạy đúng tài khoản riêng qua options.env. Trả về các biến CẦN
 * ĐẶT và các biến CẦN GỠ (đặt undefined) so với môi trường sạch:
 *  - CLAUDE_CONFIG_DIR: path profile phụ, hoặc undefined cho 'default'.
 *  - ANTHROPIC_API_KEY: chỉ khi token.txt của profile là API key dài hạn (`sk-ant-api…`);
 *    OAuth (`sk-ant-oat…`) CỐ Ý bỏ qua để CLI dùng login-of-directory tự refresh (xem
 *    loadActiveProfileToken). Ngược lại gỡ API key + OAuth token để không rò auth profile khác.
 * Áp bằng cách spread lên { ...process.env } rồi xoá key nào có giá trị undefined.
 */
export function resolveProfileEnvPatch(profileName: string | undefined): Record<string, string | undefined> {
  const configDir = profileConfigDir(profileName);
  const patch: Record<string, string | undefined> = {
    CLAUDE_CONFIG_DIR: configDir, // undefined cho 'default' → gỡ khỏi env
    // Mặc định gỡ mọi auth ép sẵn; nhánh dưới bật lại nếu profile có API key thật.
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  };
  const tokenFile = join(configDir ?? join(homedir(), '.claude'), 'token.txt');
  if (existsSync(tokenFile)) {
    try {
      const token = readFileSync(tokenFile, 'utf8').trim();
      if (token.startsWith('sk-ant-api')) patch.ANTHROPIC_API_KEY = token;
    } catch {
      /* đọc lỗi → coi như không có API key, dùng login-of-directory */
    }
  }
  return patch;
}

/**
 * Đã có credential login cho một profile Claude theo TÊN chưa? Bản THUẦN của hasClaudeCliLogin
 * (không đọc process.env.CLAUDE_CONFIG_DIR toàn cục) — để UI/runner kiểm auth ĐÚNG tài khoản
 * mà tab định chạy, không nhầm sang profile đang set ở env server.
 */
export function hasProfileAuth(profileName: string | undefined): boolean {
  const configDir = profileConfigDir(profileName);
  const defaultDir = join(homedir(), '.claude');
  // Profile default: tin thư mục tồn tại (login có thể ở Keychain, không kiểm được bằng file).
  if (!configDir) return existsSync(defaultDir);
  if (!existsSync(configDir)) return false;
  if (existsSync(join(configDir, '.credentials.json')) || existsSync(join(configDir, 'token.txt'))) {
    return true;
  }
  // macOS/Windows: login ở Keychain, chỉ ghi account vào .claude.json.
  for (const p of [configDir + '.json', join(configDir, 'claude.json'), join(configDir, '.claude.json')]) {
    if (existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, 'utf8'));
        if (data && data.oauthAccount) return true;
      } catch {
        /* bỏ qua parse lỗi */
      }
      break;
    }
  }
  return false;
}

/**
 * Có credential Claude Code CLI đã login sẵn không?
 * Hỗ trợ các biến môi trường ANTHROPIC_API_KEY hoặc CLAUDE_CODE_OAUTH_TOKEN.
 *
 * Lưu ý phân biệt profile:
 * - Profile DEFAULT (không set CLAUDE_CONFIG_DIR, hoặc trỏ ~/.claude): CLI có thể lưu login
 *   trong Keychain (macOS) → KHÔNG kiểm được bằng file. Chỉ cần thư mục tồn tại là coi có login,
 *   giữ nguyên hành vi cũ (login mặc định máy chạy tốt, đừng phá).
 * - Profile PHỤ (CLAUDE_CONFIG_DIR set tường minh sang ~/.claude-<name>): login luôn ghi ra
 *   file .credentials.json (OAuth) hoặc token.txt (API key) TRONG thư mục đó. Thư mục rỗng =
 *   ĐÃ TẠO nhưng CHƯA login xong → phải trả false, nếu không cổng hasAuth cho qua rồi mới nổ
 *   500 "Not logged in" khó hiểu ở tầng SDK. Xem hasClaudeCliLogin.
 */
function hasClaudeCliLogin(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return true;
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const defaultDir = join(homedir(), '.claude');
  // Profile default (biến vắng mặt hoặc trỏ ~/.claude): tin thư mục tồn tại (có thể login qua Keychain).
  if (!configDir || configDir === defaultDir) {
    return existsSync(defaultDir);
  }
  // Profile phụ: thư mục phải tồn tại VÀ có bằng chứng login thật (không chỉ .claude.json rỗng).
  if (!existsSync(configDir)) return false;
  if (existsSync(join(configDir, '.credentials.json')) || existsSync(join(configDir, 'token.txt'))) {
    return true;
  }
  // Trên macOS/Windows, CLI có thể lưu login trong Keychain và chỉ ghi thông tin account vào .claude.json
  const jsonPath = getClaudeJsonPath();
  if (existsSync(jsonPath)) {
    try {
      const configData = JSON.parse(readFileSync(jsonPath, 'utf8'));
      if (configData && configData.oauthAccount) {
        return true;
      }
    } catch {
      // bỏ qua nếu lỗi parse
    }
  }
  return false;
}

/**
 * Đường dẫn file cấu hình .claude.json (hoặc claude.json tùy theo CLAUDE_CONFIG_DIR).
 */
function getClaudeJsonPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) {
    const pathsToTry = [
      configDir + '.json',
      join(configDir, 'claude.json'),
      join(configDir, '.claude.json'),
    ];
    for (const p of pathsToTry) {
      if (existsSync(p)) return p;
    }
    return configDir + '.json';
  }
  return join(homedir(), '.claude.json');
}

/**
 * Đường dẫn file MCP CHUNG của bow-agent — TÁCH KHỎI profile/acc. Vì sao tách: MCP trước
 * đây nằm trong .claude.json của profile đang login, nên đổi acc là mất MCP, phải khai lại.
 * File này cố định (~/.bow-agent/mcp.json), độc lập mọi profile → config MCP một lần, đổi
 * acc bao nhiêu lần vẫn thấy. Chỉ chứa { mcpServers: {...} }. Override qua BOW_MCP_CONFIG.
 */
function getMcpConfigPath(): string {
  return optional('BOW_MCP_CONFIG') ?? join(homedir(), '.bow-agent', 'mcp.json');
}

/**
 * Seed file MCP mới LẦN ĐẦU từ ~/.claude.json (nơi người dùng thường đã cấu hình MCP bằng
 * Claude Code CLI). Chỉ chạy khi file mới CHƯA tồn tại — để không mất supabase/jira đang có.
 * Không seed đè nếu file đã có. Lỗi seed không kéo sập app (chỉ là tiện lợi ban đầu).
 */
function seedMcpConfigIfMissing(mcpPath: string): void {
  if (existsSync(mcpPath)) return;
  try {
    // Nguồn seed: ~/.claude.json mặc định (KHÔNG theo CLAUDE_CONFIG_DIR — đó là nơi CLI
    // thường lưu MCP; profile bow-agent thường rỗng mcpServers).
    const source = join(homedir(), '.claude.json');
    let mcpServers: Record<string, unknown> = {};
    if (existsSync(source)) {
      const data = JSON.parse(readFileSync(source, 'utf8')) as { mcpServers?: Record<string, unknown> };
      mcpServers = data.mcpServers ?? {};
    }
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(mcpPath, JSON.stringify({ mcpServers }, null, 2), 'utf8');
  } catch {
    // Seed thất bại → cứ để file chưa có; mcp.ts sẽ tự tạo {} khi ghi lần đầu.
  }
}

/**
 * Đường dẫn REGISTRY skill của bow-agent — allowlist các stack skill được duyệt + repo core.
 * TÁCH KHỎI repo bow-agent (khung để rỗng, không chứa skills/). File cố định
 * ~/.bow-agent/registry.json, seed lần đầu từ DEFAULT_REGISTRY dưới đây. Override qua BOW_REGISTRY.
 */
function getRegistryPath(): string {
  return optional('BOW_REGISTRY') ?? join(homedir(), '.bow-agent', 'registry.json');
}

/**
 * Registry MẶC ĐỊNH — nhúng trong code (KHÔNG đọc từ skills/ vì thư mục đó đã gỡ khỏi khung).
 * `core` = repo skill LUÔN tải (watch/coding-convention). `stacks` = allowlist stack người dùng
 * chọn (hoặc auto: BA→ba, QC→qc). Admin sửa ~/.bow-agent/registry.json để ghim ref hoặc thêm
 * stack, không cần sửa code. Đây chỉ là bản seed lần đầu.
 */
const DEFAULT_REGISTRY = {
  version: 2,
  core: { id: 'core', repo: 'github.com/Bow-T/bow-skill-core', ref: 'v1.1.0' },
  stacks: [
    { id: 'flutter-supabase', label: 'Flutter + Supabase', repo: 'github.com/Bow-T/bow-skill-flutter', ref: 'v1.1.0', default: true },
    { id: 'react-native-supabase', label: 'React Native + Supabase', repo: 'github.com/Bow-T/bow-skill-react-native', ref: 'v1.0.0' },
    { id: 'nextjs-supabase', label: 'Next.js + Supabase', repo: 'github.com/Bow-T/bow-skill-nextjs', ref: 'v1.0.0' },
    { id: 'qc', label: 'QC', repo: 'github.com/Bow-T/bow-skill-qc', ref: 'v1.0.0' },
    { id: 'review', label: 'Reviewer', repo: 'github.com/Bow-T/bow-skill-review', ref: 'v1.0.0' },
  ],
};

/** Seed registry LẦN ĐẦU từ DEFAULT_REGISTRY nếu file chưa có. Fail-open. */
function seedRegistryIfMissing(regPath: string): void {
  if (existsSync(regPath)) return;
  try {
    mkdirSync(dirname(regPath), { recursive: true });
    writeFileSync(regPath, JSON.stringify(DEFAULT_REGISTRY, null, 2), 'utf8');
  } catch {
    // Seed thất bại → externalSkills sẽ dùng hằng fallback CORE_REPO/CORE_REF cho core.
  }
}

export const config = {
  /** Agent có auth để chạy không? = đã login Claude CLI hoặc có Token config sẵn. */
  get hasAuth(): boolean {
    return hasClaudeCliLogin();
  },

  /** Có cấu hình token riêng cho profile này không? */
  get hasTokenSet(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
  },

  /** Đường dẫn file cấu hình Claude Code (login/token theo profile đang chạy). */
  get claudeJsonPath(): string {
    return getClaudeJsonPath();
  },

  /**
   * Đường dẫn file MCP CHUNG của bow-agent — TÁCH KHỎI profile. Seed lần đầu từ
   * ~/.claude.json để không mất MCP đã cấu hình. Đọc getter này = đảm bảo file đã tồn tại.
   */
  get mcpConfigPath(): string {
    const p = getMcpConfigPath();
    seedMcpConfigIfMissing(p);
    return p;
  },

  /**
   * Đường dẫn REGISTRY skill (allowlist stack + repo core), tách khỏi repo bow-agent.
   * Seed lần đầu từ DEFAULT_REGISTRY. Đọc getter này = đảm bảo file đã tồn tại.
   */
  get registryPath(): string {
    const p = getRegistryPath();
    seedRegistryIfMissing(p);
    return p;
  },

  /**
   * Model mặc định (CLI luôn dùng giá trị này). Opus 4.8 là bản mạnh nhất tier Opus
   * cho agentic dài hơi. Web tự chọn model riêng (gửi qua opts.model, ghi đè giá trị này).
   */
  model: 'claude-opus-4-8' as const,

  /**
   * Mã dự án mặc định (ví dụ: DEAR, PROJ). Không cấu hình → tự phát hiện từ git branch/commit.
   * (Jira đọc qua MCP jira của Claude Code — không cần JIRA_BASE_URL/EMAIL/TOKEN nữa.)
   */
  defaultProjectKey: optional('BOW_PROJECT_KEY') ?? optional('JIRA_PROJECT_KEY'),

  /**
   * Thư mục dự án mặc định nếu không truyền cwd. Mặc định là BOW_CWD từ env hoặc process.cwd().
   */
  get defaultCwd(): string {
    return resolve(process.env.BOW_CWD || process.cwd());
  },
} as const;
