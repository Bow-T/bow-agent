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

/* ─── PROVIDER NGOÀI (gateway nói giọng Anthropic) ──────────────────────────────
 * bow-agent chạy agent bằng binary `claude` của Agent SDK — nó CHỈ biết nói Anthropic
 * Messages API (`/v1/messages`). Muốn chạy model hãng khác (vd Grok của xAI) thì KHÔNG
 * trỏ thẳng vào API hãng đó được: xAI chỉ expose `/v1/chat/completions` + `/v1/responses`,
 * không có `/v1/messages`. Phải có GATEWAY dịch ở giữa (LiteLLM proxy phục vụ `/v1/messages`
 * rồi chuyển tiếp sang xAI).
 *
 * Bật bằng BOW_PROVIDER=grok. Khi bật, mọi lượt query() được trỏ về gateway qua
 * ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, và tên model Claude được ÁNH XẠ sang model
 * provider (xem resolveModel) — nhờ đó UI/CLI/screener/subagent giữ nguyên cách gọi cũ.
 *
 * LƯU Ý TIỀN: gói SuperGrok (grok.com / app) là gói CONSUMER, KHÔNG kèm API credits.
 * Chạy được ở đây cần key riêng ở console.x.ai, tính tiền theo token.
 *
 * CẢNH BÁO CHẤT LƯỢNG: cổng an toàn canUseTool vẫn nguyên, nhưng skills/hooks/plan-mode
 * và tool-call schema của Claude Code đi qua lớp dịch có thể lệch. Đây là cấu hình KHÔNG
 * được Anthropic hỗ trợ chính thức.
 */
export type ProviderId = 'anthropic' | 'grok';

/** Model mặc định của bow khi chạy Anthropic — bản mạnh nhất tier Opus cho agentic dài hơi. */
const DEFAULT_MODEL = 'claude-opus-4-8';

/** Model mặc định mỗi provider ngoài: `main` cho việc nặng, `fast` cho việc rẻ (screener/scout). */
const PROVIDER_MODELS: Record<Exclude<ProviderId, 'anthropic'>, { main: string; fast: string }> = {
  // Alias theo docs xAI (alias tự trỏ bản stable mới nhất, đừng ghim bản có ngày).
  grok: { main: 'grok-4.6', fast: 'grok-build-0.1' },
};

/**
 * Trần prompt THẬT (token) của provider ngoài. PHẢI khai ở đây vì CLI không biết model lạ:
 * đo thực tế `getContextUsage()` với grok-4.6 thì CLI đoán maxTokens = 200.000, trong khi xAI
 * báo lỗi "This model's maximum prompt length is 500000" — tức trần thật gấp 2,5 lần. Tin con
 * số CLI đoán thì bow tuyên bố "tràn context" lúc phiên còn thừa hơn nửa cửa sổ → tab bị dọn
 * ngữ cảnh (mất trí nhớ) sớm gấp mấy lần cần thiết. Ghi đè bằng BOW_PROVIDER_CONTEXT_TOKENS.
 */
const PROVIDER_CONTEXT_TOKENS: Record<Exclude<ProviderId, 'anthropic'>, number> = {
  grok: 500_000,
};

/** Provider đang chạy. Không set (hoặc set sai) → 'anthropic' như cũ. */
export function activeProviderId(): ProviderId {
  const raw = (optional('BOW_PROVIDER') ?? 'anthropic').toLowerCase();
  return raw === 'grok' ? 'grok' : 'anthropic';
}

/** Đang chạy bằng provider KHÁC Anthropic? */
export function isExternalProvider(): boolean {
  return activeProviderId() !== 'anthropic';
}

/**
 * Credential gateway lưu trên máy (~/.bow-agent/provider.json) — để admin nhập token NGAY
 * TRONG WEB (chỗ "Tài khoản") thay vì phải sửa .env rồi khởi động lại server. Đọc mỗi lần gọi
 * (không cache) nên vừa lưu là có tác dụng cho lượt chạy kế tiếp.
 */
function getProviderConfigPath(): string {
  return optional('BOW_PROVIDER_CONFIG') ?? join(homedir(), '.bow-agent', 'provider.json');
}

/**
 * Một tài khoản AI ngoài đã lưu. Hai kiểu đăng nhập:
 *  - `oauth`: đăng nhập bằng tài khoản Grok (gói SuperGrok/Heavy) — access token sống ~6h,
 *    bow tự refresh bằng refresh_token (xAI XOAY refresh_token mỗi lần, phải lưu lại bản mới);
 *  - `token`: dán tay một API key / token gateway (cho ai tự dựng proxy hoặc dùng API trả phí).
 * `token`/`oauth.*` là bí mật — KHÔNG bao giờ trả ra client.
 */
type ProviderOAuth = {
  accessToken: string;
  refreshToken?: string;
  /** ISO time hết hạn của accessToken. */
  expiresAt?: string;
  clientId?: string;
  issuer?: string;
  email?: string;
};
type ProviderProfile = { token?: string; baseUrl?: string; oauth?: ProviderOAuth };

/**
 * Kho tài khoản gateway. NHIỀU tài khoản như profile Claude (grok cá nhân / grok công ty…):
 * mỗi cái có token + URL gateway riêng, tab nào chạy tài khoản nào là chuyện của tab đó.
 * Tự nâng cấp file format cũ ({token, baseUrl} phẳng) thành profile 'default'.
 */
function readProviderStore(): Record<string, ProviderProfile> {
  try {
    const data = JSON.parse(readFileSync(getProviderConfigPath(), 'utf8'));
    const clean = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() ? v.trim() : undefined;
    if (data?.profiles && typeof data.profiles === 'object') {
      const out: Record<string, ProviderProfile> = {};
      for (const [name, p] of Object.entries<any>(data.profiles)) {
        out[name] = {
          token: clean(p?.token),
          baseUrl: clean(p?.baseUrl),
          oauth: p?.oauth?.accessToken
            ? {
                accessToken: String(p.oauth.accessToken),
                refreshToken: clean(p.oauth.refreshToken),
                expiresAt: clean(p.oauth.expiresAt),
                clientId: clean(p.oauth.clientId),
                issuer: clean(p.oauth.issuer),
                email: clean(p.oauth.email),
              }
            : undefined,
        };
      }
      return out;
    }
    // Format cũ (một tài khoản, không tên) → coi là 'default'.
    const legacy = { token: clean(data?.token), baseUrl: clean(data?.baseUrl) };
    return legacy.token || legacy.baseUrl ? { default: legacy } : {};
  } catch {
    return {};
  }
}

/** Ghi kho tài khoản. chmod 600 vì file chứa token. */
function writeProviderStore(profiles: Record<string, ProviderProfile>): void {
  const p = getProviderConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ profiles }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** Token đặt bằng biến môi trường — thắng mọi tài khoản lưu trên máy (xem providerCreds). */
function envProviderToken(): string | undefined {
  return optional('BOW_PROVIDER_TOKEN') ?? optional('XAI_API_KEY');
}

/** Tên tài khoản mặc định khi tab/CLI không chỉ định. */
export const DEFAULT_PROVIDER_PROFILE = 'default';

/**
 * Tài khoản AI ngoài dùng khi không ai chỉ định: BOW_PROVIDER_PROFILE → 'default' (nếu đã
 * đăng nhập) → tài khoản ĐẦU TIÊN có token. Nhờ nhánh cuối, đăng nhập một acc tên bất kỳ
 * (vd 'ryan') là CLI chạy được ngay, không bắt phải đặt tên 'default'.
 */
export function defaultProviderProfileName(): string {
  const pinned = optional('BOW_PROVIDER_PROFILE');
  if (pinned) return pinned;
  const store = readProviderStore();
  if (store[DEFAULT_PROVIDER_PROFILE]?.oauth?.accessToken || store[DEFAULT_PROVIDER_PROFILE]?.token) {
    return DEFAULT_PROVIDER_PROFILE;
  }
  const firstReady = Object.keys(store).find((n) => store[n].oauth?.accessToken || store[n].token);
  return firstReady ?? DEFAULT_PROVIDER_PROFILE;
}

/**
 * Credential của MỘT tài khoản gateway. Env thắng file: máy đã set BOW_PROVIDER_TOKEN thì mọi
 * tài khoản đều dùng token đó (và UI khoá phần sửa) — không lặng lẽ đè biến môi trường.
 */
function providerCreds(profileName?: string): ProviderProfile {
  const envToken = envProviderToken();
  if (envToken) return { token: envToken, baseUrl: optional('BOW_PROVIDER_BASE_URL') };
  const store = readProviderStore();
  return store[profileName?.trim() || defaultProviderProfileName()] ?? {};
}

/**
 * Lưu/cập nhật một tài khoản gateway. token/baseUrl rỗng = xoá khoá đó khỏi tài khoản.
 * CHỈ gọi từ nhánh admin (server.ts requireAdmin) — đây là credential của host.
 */
export function saveProviderProfile(name: string, patch: ProviderProfile): void {
  const key = name.trim() || DEFAULT_PROVIDER_PROFILE;
  const store = readProviderStore();
  const current = store[key] ?? {};
  store[key] = {
    token: patch.token === undefined ? current.token : patch.token.trim() || undefined,
    baseUrl: patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl.trim() || undefined,
    oauth: patch.oauth === undefined ? current.oauth : patch.oauth,
  };
  writeProviderStore(store);
}

/** Đường dẫn phiên đăng nhập của `grok` CLI chính thức. */
function grokCliAuthPath(): string {
  return optional('GROK_AUTH_FILE') ?? join(homedir(), '.grok', 'auth.json');
}

/**
 * Nhập phiên đăng nhập vừa tạo bởi `grok login` vào MỘT tài khoản của bow.
 *
 * `~/.grok/auth.json` chỉ giữ MỘT phiên (login sau ghi đè login trước), nên bow chép ra bản
 * riêng cho từng tài khoản — nhờ đó giữ song song nhiều acc Grok như nhiều profile Claude.
 * Trả email đã đăng nhập, hoặc null nếu không đọc được phiên nào.
 */
export function importGrokCliSession(profileName: string): string | null {
  try {
    const data = JSON.parse(readFileSync(grokCliAuthPath(), 'utf8')) as Record<string, any>;
    const entries = Object.entries(data);
    if (entries.length === 0) return null;
    // Nhiều entry thì lấy phiên tạo gần nhất (create_time ISO).
    const [issuerKey, sess] = entries.sort(
      (a, b) => String(b[1]?.create_time ?? '').localeCompare(String(a[1]?.create_time ?? '')),
    )[0];
    if (!sess?.key) return null;
    saveProviderProfile(profileName, {
      oauth: {
        accessToken: String(sess.key),
        refreshToken: sess.refresh_token ? String(sess.refresh_token) : undefined,
        expiresAt: sess.expires_at ? String(sess.expires_at) : undefined,
        clientId: sess.oidc_client_id ? String(sess.oidc_client_id) : undefined,
        issuer: String(sess.oidc_issuer ?? issuerKey.split('::')[0] ?? 'https://auth.x.ai'),
        email: sess.email ? String(sess.email) : undefined,
      },
    });
    return sess.email ? String(sess.email) : '';
  } catch {
    return null;
  }
}

/**
 * Access token DÙNG ĐƯỢC NGAY cho một tài khoản: refresh trước nếu sắp hết hạn.
 * Thứ tự: env (ghim cứng) → OAuth (tự refresh) → token dán tay.
 *
 * xAI xoay refresh_token mỗi lần refresh nên bản mới PHẢI được ghi lại, nếu không lần sau
 * refresh sẽ hỏng và người dùng phải đăng nhập lại.
 */
export async function providerAccessToken(profileName?: string): Promise<string | undefined> {
  const envToken = envProviderToken();
  if (envToken) return envToken;
  const key = profileName?.trim() || defaultProviderProfileName();
  const profile = readProviderStore()[key];
  if (!profile) return undefined;
  const oauth = profile.oauth;
  if (!oauth) return profile.token;

  const expiresAt = oauth.expiresAt ? Date.parse(oauth.expiresAt) : 0;
  const stillFresh = expiresAt > Date.now() + 120_000; // đệm 2 phút
  if (stillFresh || !oauth.refreshToken || !oauth.clientId) return oauth.accessToken;

  try {
    const res = await fetch(`${(oauth.issuer ?? 'https://auth.x.ai').replace(/\/$/, '')}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: oauth.clientId,
      }),
    });
    if (!res.ok) return oauth.accessToken; // hết hạn thật thì shim sẽ báo 401 rõ ràng
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) return oauth.accessToken;
    saveProviderProfile(key, {
      oauth: {
        ...oauth,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? oauth.refreshToken,
        expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
      },
    });
    return data.access_token;
  } catch {
    return oauth.accessToken;
  }
}

/** Xoá hẳn một tài khoản gateway. Trả false nếu không có tài khoản tên đó. */
export function deleteProviderProfile(name: string): boolean {
  const store = readProviderStore();
  const key = name.trim();
  if (!(key in store)) return false;
  delete store[key];
  writeProviderStore(store);
  return true;
}

/**
 * Danh sách tài khoản gateway cho UI. KHÔNG trả token — chỉ cho biết đã có hay chưa.
 * Token đặt bằng env → chỉ có MỘT tài khoản ảo tên 'env' (không sửa được từ web).
 */
export function listProviderProfiles(): {
  name: string;
  baseUrl: string;
  hasToken: boolean;
  authMode: 'oauth' | 'token' | 'none';
  email?: string;
}[] {
  if (envProviderToken()) {
    return [{ name: 'env', baseUrl: providerBaseUrl(), hasToken: true, authMode: 'token' }];
  }
  const store = readProviderStore();
  return Object.keys(store).map((name) => {
    const p = store[name];
    return {
      name,
      baseUrl: p.baseUrl ?? providerBaseUrl(),
      hasToken: Boolean(p.oauth?.accessToken || p.token),
      authMode: p.oauth ? 'oauth' : p.token ? 'token' : 'none',
      email: p.oauth?.email,
    };
  });
}

/** Token gửi cho gateway (Authorization). Với LiteLLM là master key/virtual key của proxy. */
function providerToken(profileName?: string): string | undefined {
  const creds = providerCreds(profileName);
  return creds.oauth?.accessToken ?? creds.token;
}

/** Trạng thái gateway cho UI: danh sách tài khoản + token có đang bị env ghim không. */
export function providerCredsInfo(): {
  profiles: { name: string; baseUrl: string; hasToken: boolean }[];
  fromEnv: boolean;
  defaultBaseUrl: string;
} {
  return {
    profiles: listProviderProfiles(),
    // Token đến từ env → UI phải nói rõ "sửa trong .env", vì lưu qua web sẽ không có tác dụng.
    fromEnv: Boolean(envProviderToken()),
    defaultBaseUrl: providerBaseUrl(),
  };
}

/**
 * Upstream THẬT của một tài khoản. Mặc định là API của xAI: nó có sẵn `/v1/messages` nói giọng
 * Anthropic nên bow đi thẳng, KHÔNG cần LiteLLM/gateway ngoài nữa (shim trong tiến trình chỉ
 * gọt vài chỗ schema — xem src/core/xaiShim.ts). Đặt baseUrl riêng nếu ai đó tự dựng proxy.
 */
export function providerBaseUrl(profileName?: string): string {
  const store = readProviderStore();
  return (
    optional('BOW_PROVIDER_BASE_URL') ??
    store[profileName?.trim() || defaultProviderProfileName()]?.baseUrl ??
    'https://api.x.ai'
  );
}

/**
 * Model của MỘT provider theo bậc. Ghi đè qua BOW_PROVIDER_MODEL / BOW_PROVIDER_FAST_MODEL
 * (áp cho provider ngoài đang dùng — hiện chỉ có một). Anthropic không đi qua bảng này.
 */
export function providerModelTiers(id: ProviderId): { main: string; fast: string } | null {
  if (id === 'anthropic') return null;
  const base = PROVIDER_MODELS[id];
  return {
    main: optional('BOW_PROVIDER_MODEL') ?? base.main,
    fast: optional('BOW_PROVIDER_FAST_MODEL') ?? base.fast,
  };
}

/**
 * Trần prompt THẬT của provider (token) — dùng THAY cho con số CLI tự đoán khi chạy AI ngoài.
 * Anthropic → null (CLI biết đúng trần model của chính hãng, đừng đụng vào).
 */
export function providerContextTokens(id: ProviderId): number | null {
  if (id === 'anthropic') return null;
  const override = Number(optional('BOW_PROVIDER_CONTEXT_TOKENS') ?? '');
  if (Number.isFinite(override) && override > 0) return override;
  return PROVIDER_CONTEXT_TOKENS[id] ?? null;
}

/**
 * Ánh xạ tên model sang MỘT provider. Anthropic → giữ nguyên (không đổi hành vi cũ một chút
 * nào). Provider ngoài → model Claude nào cũng quy về 2 bậc:
 *  - có 'haiku' trong tên (screener, impact-scout) → bậc `fast` (rẻ/nhanh);
 *  - còn lại (opus/sonnet/fable) → bậc `main`.
 * Tên KHÔNG phải model Claude thì để nguyên — cho phép chỉ đích danh 'grok-4.5' khi cần.
 */
export function resolveModelFor<T extends string | undefined>(id: ProviderId, model: T): T | string {
  const tiers = providerModelTiers(id);
  if (!model || !tiers || !model.startsWith('claude')) return model;
  return model.includes('haiku') ? tiers.fast : tiers.main;
}

/** Như resolveModelFor nhưng theo provider MẶC ĐỊNH của tiến trình (CLI, screener, subagent). */
export function resolveModel<T extends string | undefined>(model: T): T | string {
  return resolveModelFor(activeProviderId(), model);
}

/**
 * Env-patch trỏ subprocess `claude` về ĐÚNG provider của lượt chạy. Đây là thứ quyết định
 * "đổi AI": mỗi tab web có thể chạy provider khác nhau vì SDK nhận env riêng cho mỗi query().
 *
 * - provider ngoài → trỏ base URL + token gateway, gỡ credential Anthropic (không trộn hai hãng);
 * - 'anthropic' → GỠ lại các biến gateway (cần khi tiến trình đang mặc định chạy gateway mà
 *   tab này chọn Claude), ngược lại không đụng gì.
 *
 * ANTHROPIC_*_MODEL đặt kèm cho những lượt CLI TỰ chọn model (tóm tắt, tác vụ nền) — bow không
 * truyền `model:` cho các lượt đó nên thiếu biến này CLI sẽ hỏi model Claude mà gateway không có.
 */
export function providerEnvPatchFor(id: ProviderId, profileName?: string): Record<string, string | undefined> {
  const tiers = providerModelTiers(id);
  if (!tiers) {
    // Tiến trình không chạy gateway → không có gì để gỡ, giữ env sạch như trước.
    if (activeProviderId() === 'anthropic') return {};
    return {
      ANTHROPIC_BASE_URL: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_MODEL: undefined,
      ANTHROPIC_SMALL_FAST_MODEL: undefined,
      ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
      ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined,
    };
  }
  return {
    ANTHROPIC_BASE_URL: providerBaseUrl(profileName),
    ANTHROPIC_AUTH_TOKEN: providerToken(profileName),
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ANTHROPIC_MODEL: tiers.main,
    ANTHROPIC_SMALL_FAST_MODEL: tiers.fast,
    ANTHROPIC_DEFAULT_OPUS_MODEL: tiers.main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: tiers.main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: tiers.fast,
  };
}

/** Env-patch theo provider MẶC ĐỊNH của tiến trình. */
export function providerEnvPatch(): Record<string, string | undefined> {
  return providerEnvPatchFor(activeProviderId());
}

/**
 * Provider này chạy được chưa? Anthropic = có login/API key Claude; provider ngoài = có token
 * gateway. UI dùng để khoá lựa chọn thay vì cho chọn rồi mới nổ lỗi giữa lượt chạy.
 */
export function providerReady(id: ProviderId, profileName?: string): boolean {
  if (id === 'anthropic') return hasClaudeCliLogin({ ignoreProvider: true });
  // Không chỉ định tài khoản = "AI này dùng được không" → đủ khi CÓ MỘT tài khoản có token.
  if (!profileName) return listProviderProfiles().some((p) => p.hasToken);
  return Boolean(providerToken(profileName));
}

/** Danh sách provider cho UI: nhãn hiển thị + đã sẵn sàng chưa + model của nó. */
export function availableProviders(): { id: ProviderId; label: string; ready: boolean; models: { main: string; fast: string } | null }[] {
  return (['anthropic', 'grok'] as ProviderId[]).map((id) => ({
    id,
    label: id === 'anthropic' ? 'Claude' : 'Grok',
    ready: providerReady(id),
    models: providerModelTiers(id),
  }));
}

/**
 * Áp phần AN TOÀN của patch provider lên process.env: chỉ tên model + gỡ credential Anthropic.
 * CỐ Ý không ghim ANTHROPIC_BASE_URL/AUTH_TOKEN ở đây — mọi lượt chạy phải đi qua shim (nó
 * gọt schema và cấp token đã refresh), nên base/token do runner dựng riêng cho từng lượt.
 */
function applyProviderEnv(): void {
  for (const [k, v] of Object.entries(providerEnvPatch())) {
    if (k === 'ANTHROPIC_BASE_URL' || k === 'ANTHROPIC_AUTH_TOKEN') continue;
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// Provider chạy SAU loadActiveProfileToken: nếu bật gateway thì nó gỡ luôn key Anthropic
// vừa nạp ở trên — một nguồn auth tại một thời điểm, không trộn.
applyProviderEnv();

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
  // Provider ngoài (gateway) ĐÈ LÊN auth profile: một nguồn auth tại một thời điểm.
  return { ...patch, ...providerEnvPatch() };
}

/**
 * Đã có credential login cho một profile Claude theo TÊN chưa? Bản THUẦN của hasClaudeCliLogin
 * (không đọc process.env.CLAUDE_CONFIG_DIR toàn cục) — để UI/runner kiểm auth ĐÚNG tài khoản
 * mà tab định chạy, không nhầm sang profile đang set ở env server.
 */
export function hasProfileAuth(profileName: string | undefined): boolean {
  // Provider ngoài: không có login Claude nào để kiểm — auth là token của gateway.
  if (isExternalProvider()) return Boolean(providerToken());
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
function hasClaudeCliLogin(opts?: { ignoreProvider?: boolean }): boolean {
  // Provider ngoài: auth = token gateway (ANTHROPIC_AUTH_TOKEN), không phải login Claude.
  // `ignoreProvider` = hỏi riêng "có login Claude không" (providerReady dùng để chấm từng
  // provider độc lập, kể cả khi tiến trình đang mặc định chạy gateway).
  if (!opts?.ignoreProvider && isExternalProvider()) return Boolean(providerToken());
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
    if (isExternalProvider()) return Boolean(providerToken());
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
   * Chạy provider ngoài (BOW_PROVIDER) thì trả model tương ứng của provider đó.
   */
  get model(): string {
    return resolveModel(DEFAULT_MODEL);
  },

  /** Provider đang chạy — CLI/web in ra để người dùng biết mình đang đốt token của hãng nào. */
  get provider(): ProviderId {
    return activeProviderId();
  },

  /** Model của provider ngoài (null khi chạy Anthropic) — web dùng để hiện đúng tên model. */
  get providerModels(): { main: string; fast: string } | null {
    return providerModelTiers(activeProviderId());
  },

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
