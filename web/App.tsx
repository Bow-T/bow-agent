import { useEffect, useRef, useState, useCallback } from 'react';
import { PixelSelect } from './PixelSelect.js';
import { AccentPicker } from './AccentPicker.js';
import { modeDef } from './ModeSelect.js';
import { Markdown } from './Markdown.js';
import { Icon, type IconName } from './Icon.js';
import { TaskPane, type TaskPaneHandle } from './TaskPane.js';
import type {
  ChatItem,
  ConversationSummary,
  DetectedSource,
  DocAttachment,
  ImageAttachment,
  Mode,
  PendingApproval,
  ToolDetail,
  UsageSnapshot,
} from './types.js';

/** 2 phong cách UI: 'brutal' (Neo Brutalism, kem) + 'newsprint' (báo giấy editorial). */
export type Theme = 'brutal' | 'newsprint';

/** Thứ tự xoay vòng khi bấm nút phong cách ở header: brutal → newsprint → brutal. */
const THEME_CYCLE: Theme[] = ['brutal', 'newsprint'];

/** Màu nhấn chọn ở header. 'brass' = mặc định (vàng #ffcf24), không đặt data-accent. */
export type Accent = 'brass' | 'blue' | 'teal' | 'purple' | 'pink' | 'red' | 'orange';

/**
 * 7 màu nhấn hiển thị thành swatch ở header — chỉ áp cho phong cách Neo Brutalism. `swatch`
 * tô chấm màu trong picker (khớp đúng --brass mỗi accent trong CSS). Vàng + coral + tím lấy
 * đúng hex chuẩn của landing page (docs/index.html: --yellow / --coral / --lav).
 */
const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  { id: 'brass', label: 'Vàng', swatch: '#ffcf24' },
  { id: 'blue', label: 'Coral', swatch: '#ff5a5a' },
  { id: 'teal', label: 'Xanh lá', swatch: '#22c55e' },
  { id: 'purple', label: 'Tím', swatch: '#b8a4ff' },
  { id: 'pink', label: 'Hồng', swatch: '#ff6bb0' },
  { id: 'red', label: 'Lam', swatch: '#3b82f6' },
  { id: 'orange', label: 'Cam', swatch: '#ff9a3c' },
];

/** Một node trong Activity Log / Star Chart. `ops` & `approval` phục vụ khung chi tiết mở rộng. */
export interface ActivityNode {
  id: string;
  type: string;
  label: string;
  detail?: string;
  active?: boolean;
  count?: number;
  /** Các thao tác con (khi node là nhóm tool) — hiển thị từng lệnh/file/kết quả. */
  ops?: ToolDetail[];
  /** Thông tin yêu cầu duyệt (khi node là 'approval'). */
  approval?: PendingApproval;
}

let seq = 0;
export const nextId = () => `${Date.now()}-${seq++}`;

// ── Tab (multi-tab) — mỗi tab = 1 conversation/session độc lập ─────────────────
// BƯỚC 1: chỉ có ĐÚNG MỘT tab 'legacy' (giữ nguyên hành vi single-view cũ). Các key
// per-tab được thêm hậu tố tabId để bước 2 tách nhiều tab không đụng nhau.
export interface Tab {
  id: string;
  title: string;
}

/** Tab mặc định (single-view cũ). Mọi localStorage per-tab của bản legacy KHÔNG có hậu tố. */
export const LEGACY_TAB_ID = 'legacy';

/**
 * Khoá localStorage per-tab. Tab 'legacy' giữ NGUYÊN key gốc (không hậu tố) để tương thích
 * dữ liệu đã lưu từ bản single-view; tab khác thêm ':<tabId>'.
 */
export function tabKey(base: string, tabId: string): string {
  return tabId === LEGACY_TAB_ID ? base : `${base}:${tabId}`;
}

/** Các base-key state per-tab — dùng để dọn rác khi đóng tab. */
const PER_TAB_KEYS = [
  'bow-chat-items',
  'bow-conversation-id',
  'bow-active-conv-id',
  'bow-session-id',
  'bow-session-baseline',
  'bow-task',
] as const;

/**
 * Nạp danh sách tab từ localStorage 'bow-tabs'. Lần đầu bật multi-tab (chưa có) →
 * trả về [tab legacy] (tab này đọc thẳng key single-view cũ nhờ tabKey không hậu tố).
 */
function loadTabs(): Tab[] {
  try {
    const raw = localStorage.getItem('bow-tabs');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) return arr as Tab[];
    }
  } catch {
    /* parse lỗi → tab legacy mặc định */
  }
  // Tiêu đề tab legacy suy từ chat cũ (câu user đầu) nếu có.
  let title = '';
  try {
    const rawItems = localStorage.getItem('bow-chat-items');
    if (rawItems) {
      const items = JSON.parse(rawItems) as ChatItem[];
      const firstUser = items.find((it) => it.kind === 'user')?.text ?? '';
      title = firstUser.replace(/\s+/g, ' ').trim().slice(0, 40);
    }
  } catch {
    /* tiêu đề rỗng là chấp nhận được */
  }
  return [{ id: LEGACY_TAB_ID, title }];
}

/** Tab đang mở lần trước (không hợp lệ → tab đầu). */
function loadActiveTabId(tabs: Tab[]): string {
  const saved = localStorage.getItem('bow-active-tab');
  if (saved && tabs.some((t) => t.id === saved)) return saved;
  return tabs[0]?.id ?? LEGACY_TAB_ID;
}

/** Xoá mọi key localStorage của một tab (gọi khi đóng tab, tránh rác). */
function clearTabKeys(tabId: string): void {
  for (const base of PER_TAB_KEYS) {
    try {
      localStorage.removeItem(tabKey(base, tabId));
    } catch {
      /* bỏ qua */
    }
  }
}

// ── Kiểu dùng chung giữa App và TaskPane ─────────────────────────────────────
/** Cấu hình backend trả về từ /api/config. */
export type Cfg = {
  defaultCwd: string;
  repoName?: string;
  mcpServers?: string[];
  lanUrl?: string;
  lanUrls?: string[];
  isQcMode?: boolean;
  isReviewerMode?: boolean;
  isCollabMode?: boolean;
  isBaMode?: boolean;
  isDevOpsMode?: boolean;
  isAdmin?: boolean;
  claudeProfiles?: { name: string; tokenSet: boolean }[];
  currentClaudeProfile?: string;
  hasAuth?: boolean;
  tokenSet?: boolean;
  otherModes?: {
    dev: { repoName: string; defaultCwd: string; active?: boolean };
    qc: { repoName: string; defaultCwd: string; active?: boolean };
    collab: { repoName: string; defaultCwd: string; active?: boolean };
    ba: { repoName: string; defaultCwd: string; active?: boolean };
    review: { repoName: string; defaultCwd: string; active?: boolean };
    devops: { repoName: string; defaultCwd: string; active?: boolean };
  };
};

/** Một repo trong workspace. */
export type WsRepo = { path: string; role: string };
/** Workspace: nhóm repo anh em quanh 1 cwd. */
export type Ws = { slug: string; dir: string; repos: WsRepo[] };

/** Trạng thái tải skill (core/stack) — dùng cho badge synced/stale/missing. */
export type SkillState = 'synced' | 'stale' | 'missing';
export type SkillSrc = { id: string; label: string; ref: string; cached: boolean; deployedRef: string | null; state: SkillState };
/** Kiểu tổng hợp trạng thái skill từ /api/skill-status. */
export type SkillStatus = { core: SkillSrc; stack: SkillSrc | null; state: SkillState; ready: boolean };

/** Modal đăng nhập/token tài khoản Claude. */
export type AuthModalState = {
  profile: string;
  mode: 'select' | 'oauth' | 'token';
  oauthUrl?: string;
  oauthCode?: string;
  oauthLoading?: boolean;
  oauthError?: string;
  tokenValue?: string;
  tokenLoading?: boolean;
  tokenError?: string;
};

// ── Chat nhóm (người-với-người qua LAN) ──────────────────────────────────────
// Mỗi máy có một ID CÁ NHÂN cố định (sinh 1 lần, nhớ ở localStorage) để phân biệt
// người gửi, và một BIỆT DANH hiển thị (đổi được). Vào phòng bằng "mã phòng".

const CHAT_USER_ID_KEY = 'bow-chat-user-id';
const CHAT_NICKNAME_KEY = 'bow-chat-nickname';
const CHAT_LAST_GROUP_KEY = 'bow-chat-last-group';

/** ID cá nhân của máy này (sinh & nhớ 1 lần). Dùng để tô "tin của mình" vs người khác. */
function getChatUserId(): string {
  try {
    let id = localStorage.getItem(CHAT_USER_ID_KEY);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `u-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      localStorage.setItem(CHAT_USER_ID_KEY, id);
    }
    return id;
  } catch {
    // localStorage bị chặn → ID tạm theo phiên (không bền, nhưng vẫn chat được).
    return `u-${Date.now()}`;
  }
}

/** Một tin nhắn chat như server trả về. */
interface ChatMsg {
  id: string;
  userId: string;
  nickname: string;
  text: string;
  createdAt: number;
}

// ── Cổng mã truy cập ─────────────────────────────────────────────────────────
// Client LAN (không phải admin/localhost) phải nhập mã do admin cấp → server trả
// token → nhớ ở localStorage. apiFetch tự đính token vào header; SSE đính qua query.

const ACCESS_TOKEN_KEY = 'bow-access-token';

/** Token truy cập đã lưu (rỗng nếu chưa có). */
function getAccessToken(): string {
  try {
    return localStorage.getItem(ACCESS_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function setAccessToken(token: string): void {
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, token);
  } catch {
    /* localStorage bị chặn (chế độ riêng tư) — bỏ qua, chỉ mất nhớ. */
  }
}

function clearAccessToken(): void {
  try {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
  } catch {
    /* bỏ qua */
  }
}

/**
 * fetch bọc: tự đính header 'x-bow-token' để qua cổng mã truy cập. Dùng cho MỌI gọi
 * /api/* nghiệp vụ (thay cho fetch trần). SSE (EventSource) không dùng được cái này —
 * đính token qua query '?token=' (xem withToken).
 */
export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('x-bow-token', token);
  return fetch(input, { ...init, headers });
}

/** Thêm token vào query string cho URL SSE (EventSource không set được header). */
export function withToken(url: string): string {
  const token = getAccessToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

/** Đọc file text → {name, content}. */
export function readText(file: File): Promise<DocAttachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, content: String(r.result ?? '') });
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

/** Đọc file → data URL (base64 kèm prefix). */
export function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Đọc file ảnh → {name, base64, mediaType}. */
export async function readImage(file: File): Promise<ImageAttachment> {
  const base64 = (await readDataUrl(file)).split(',')[1] ?? '';
  return { name: file.name, base64, mediaType: file.type || 'image/png' };
}

/**
 * Gợi ý bấm nhanh ở khung nhập. Thêm mẫu mới = thêm 1 phần tử vào đây.
 * - target 'task': điền vào ô mô tả task.
 * - target 'jira': đưa con trỏ vào ô Jira (điền text gợi ý làm placeholder hành động).
 */
export const QUICK_PROMPTS: { icon: IconName; label: string; text: string }[] = [
  { icon: 'bug', label: 'Sửa bug từ Jira', text: 'Hãy đọc và giải quyết ticket Jira: ' },
  {
    icon: 'lamp',
    label: 'Làm theo đề xuất',
    text: 'Phân tích vấn đề, đề xuất hướng làm rồi trình bày kế hoạch để tôi duyệt trước khi thực thi.',
  },
  {
    icon: 'book',
    label: 'Giải thích codebase',
    text: 'Đọc và giải thích cấu trúc dự án này: các module chính, luồng dữ liệu, và điểm cần lưu ý.',
  },
  {
    icon: 'test',
    label: 'Viết test',
    text: 'Viết unit/widget test cho phần code vừa thay đổi (hoặc module tôi chỉ định), bám theo test có sẵn của dự án.',
  },
  {
    icon: 'review',
    label: 'Review & rà lỗi',
    text: 'Rà soát code tìm bug, lỗi tiềm ẩn và điểm dễ vỡ, rồi đề xuất cách sửa cụ thể.',
  },
  {
    icon: 'commit',
    label: 'Sinh commit / PR',
    text: 'Tóm tắt các thay đổi hiện tại và soạn message commit + mô tả PR theo quy ước của dự án.',
  },
  {
    icon: 'refactor',
    label: 'Refactor / dọn code',
    text: 'Đề xuất rồi thực hiện refactor cho đoạn code tôi chỉ định, giữ nguyên hành vi (không đổi chức năng).',
  },
];

/** "trong 2h", "trong 1d"… từ ISO reset time. Rỗng nếu không có/đã qua. */
export function formatResetIn(iso: string | null): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `Còn ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Còn ${hours}h`;
  return `Còn ${Math.round(hours / 24)}d`;
}

/** Đếm ngược tới thời điểm ISO → "1:23:45" / "12:07" / "0:09". Rỗng nếu đã qua. */
export function formatCountdown(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Format thời lượng ms → chuỗi gọn kiểu "1g 23p 45s" / "3p 42s" / "58s". */
export function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}g ${m}p ${s}s`;
  if (m > 0) return `${m}p ${s}s`;
  return `${s}s`;
}

/** Gọn số token: 21592 → "21.6k", 1000000 → "1M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

/** Một thanh usage: nhãn + % + bar. severity đổi màu khi gần đầy. */
const API_PORTS = [4000, 4001, 4002, 4003, 4004, 4005];

function getAdminApiOrigins(): string[] {
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (!isLocal) return ['']; // non-admin LAN clients only talk to their own origin
  return API_PORTS.map(p => `http://localhost:${p}`);
}

/** State per-tab mà UI global cần đọc (báo lên từ mỗi TaskPane qua onStateChange). */
interface PaneState {
  running: boolean;
  runStartedAt: number | null;
  lastRunMs: number | null;
  activeConvId: string | null;
  title: string;
}
const EMPTY_PANE_STATE: PaneState = { running: false, runStartedAt: null, lastRunMs: null, activeConvId: null, title: '' };

export function App() {
  // ── Multi-tab: nhiều conversation/session chạy SONG SONG, mỗi tab một <TaskPane> ──
  const [tabs, setTabs] = useState<Tab[]>(() => loadTabs());
  const [activeTabId, setActiveTabId] = useState<string>(() => loadActiveTabId(loadTabs()));
  // Handle imperative của TỪNG tab (panel Lịch sử/xoá cuộc điều khiển pane đang hiển thị).
  const paneRefs = useRef<Record<string, TaskPaneHandle | null>>({});
  // Mirror state per-tab: header (đồng hồ) + panel Lịch sử (tô cuộc) đọc tab ĐANG MỞ;
  // thanh tab đọc mọi tab (chấm chạy + tiêu đề). TaskPane báo lên qua onStateChange.
  const [paneStates, setPaneStates] = useState<Record<string, PaneState>>({});
  const activePane = paneStates[activeTabId] ?? EMPTY_PANE_STATE;
  const { running: paneRunning, runStartedAt: paneRunStartedAt, lastRunMs: paneLastRunMs, activeConvId: paneActiveConvId } = activePane;
  /** Handle của tab đang hiển thị (để History/xoá cuộc gọi imperative đúng pane). */
  const activePaneRef = () => paneRefs.current[activeTabId] ?? null;

  // Persist danh sách tab + tab đang mở qua reload.
  useEffect(() => { localStorage.setItem('bow-tabs', JSON.stringify(tabs)); }, [tabs]);
  useEffect(() => { localStorage.setItem('bow-active-tab', activeTabId); }, [activeTabId]);

  /** Nhận state báo lên từ một tab (keyed theo tabId). */
  const reportPaneState = useCallback((tabId: string, s: PaneState) => {
    setPaneStates((prev) => {
      const cur = prev[tabId];
      if (cur && cur.running === s.running && cur.runStartedAt === s.runStartedAt &&
          cur.lastRunMs === s.lastRunMs && cur.activeConvId === s.activeConvId && cur.title === s.title) {
        return prev; // không đổi → tránh render thừa
      }
      return { ...prev, [tabId]: s };
    });
  }, []);

  /** Mở một tab mới (trống) và chuyển tới nó. */
  const newTab = useCallback(() => {
    const id = crypto.randomUUID();
    setTabs((prev) => [...prev, { id, title: '' }]);
    setActiveTabId(id);
  }, []);

  /** Đóng một tab: gỡ khỏi danh sách (TaskPane unmount tự đóng SSE + stop session),
   *  dọn key localStorage của nó. Không cho đóng tab cuối (giữ UI không rỗng). */
  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      if (prev.length <= 1) return prev; // giữ ít nhất 1 tab
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== id);
      // Nếu đóng tab đang mở → chuyển sang tab kề (ưu tiên bên trái).
      setActiveTabId((cur) => (cur === id ? (next[Math.max(0, idx - 1)]?.id ?? next[0].id) : cur));
      clearTabKeys(id);
      delete paneRefs.current[id];
      setPaneStates((ps) => { const { [id]: _drop, ...rest } = ps; return rest; });
      return next;
    });
  }, []);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [otherModes, setOtherModes] = useState<{
    dev: { repoName: string; defaultCwd: string; active?: boolean };
    qc: { repoName: string; defaultCwd: string; active?: boolean };
    collab: { repoName: string; defaultCwd: string; active?: boolean };
    ba: { repoName: string; defaultCwd: string; active?: boolean };
    review: { repoName: string; defaultCwd: string; active?: boolean };
    devops: { repoName: string; defaultCwd: string; active?: boolean };
  } | null>(null);
  const [cwd, setCwd] = useState(() => localStorage.getItem('bow-cwd') || '');
  const [mode, setMode] = useState<Mode>(() => {
    // Migrate giá trị cũ: 'execute' (2-mode trước đây) → 'manual'. Giá trị lạ → 'plan'.
    const saved = localStorage.getItem('bow-mode');
    if (saved === 'execute') return 'manual';
    const valid: Mode[] = ['plan', 'manual', 'edit-auto', 'auto'];
    return (valid as string[]).includes(saved ?? '') ? (saved as Mode) : 'plan';
  });
  const [profile, setProfile] = useState(() => localStorage.getItem('bow-profile') || 'auto');
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem('bow-selectedModel') || 'claude-opus-4-8');
  const [effort, setEffort] = useState(() => localStorage.getItem('bow-effort') || 'high');
  // Đội agent (multi-agent): bật reviewer/verifier/impact-scout. Chỉ admin. Mặc định tắt.
  const [useSubagents, setUseSubagents] = useState(() => localStorage.getItem('bow-subagents') === '1');
  const [language, setLanguage] = useState<'vi' | 'en'>(() => {
    const saved = localStorage.getItem('bow-language');
    return saved === 'en' ? 'en' : 'vi';
  });
  const [selectedMcps, setSelectedMcps] = useState<string[]>(() => {
    try {
      const val = localStorage.getItem('bow-selectedMcps');
      return val ? JSON.parse(val) : [];
    } catch {
      return [];
    }
  });
  // Stack skill external (id trong registry admin duyệt). '' = chỉ dùng skill nội bộ.
  const [stack, setStack] = useState<string>(() => localStorage.getItem('bow-stack') || '');
  // Danh sách stack có sẵn (nạp từ GET /api/skill-stacks lúc mount).
  const [skillStacks, setSkillStacks] = useState<{ id: string; label: string; ref: string; default: boolean }[]>([]);
  // Trạng thái TẢI skill (core + stack đang chọn) — badge cạnh dropdown Stack. null = chưa biết.
  const [skillStatus, setSkillStatus] = useState<SkillStatus | null>(null);
  const [skillSyncing, setSkillSyncing] = useState(false); // đang chạy Đồng bộ thủ công
  const [skillSyncMsg, setSkillSyncMsg] = useState(''); // kết quả lần đồng bộ gần nhất (hiện qua toast + tooltip badge)
  const [accumulatedCost, setAccumulatedCost] = useState(0);
  // Snapshot hạn mức gói + context window (đến từ event 'usage' trong lượt chạy, hoặc
  // /api/usage khi mở trang). null = chưa có dữ liệu.
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  // Panel usage đầy đủ (liệt kê MỌI cửa sổ hạn mức: Session 5h, Weekly 7d, per-model).
  // Mở khi bấm ô Session trên header. false = đóng.
  const [usagePanelOpen, setUsagePanelOpen] = useState(false);

  const getActiveOrigins = useCallback(() => {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!isLocal) return [''];
    // Chỉ nối tới cổng có tiến trình ĐANG chạy (cờ active do server ping) — defaultCwd
    // luôn có giá trị fallback nên không dùng được để đoán mode nào sống.
    if (!otherModes) return ['http://localhost:4000'];
    const origins: string[] = [];
    if (otherModes.dev?.active) {
      origins.push('http://localhost:4000');
    }
    if (otherModes.qc?.active) {
      origins.push('http://localhost:4001');
    }
    if (otherModes.collab?.active) {
      origins.push('http://localhost:4002');
    }
    if (otherModes.ba?.active) {
      origins.push('http://localhost:4003');
    }
    if (otherModes.review?.active) {
      origins.push('http://localhost:4004');
    }
    if (otherModes.devops?.active) {
      origins.push('http://localhost:4005');
    }
    return origins;
  }, [otherModes]);

  // ── Lịch sử nhiều cuộc trò chuyện (lưu bền ở backend) ── (state per-tab đã dời sang TaskPane)
  const [histPanelOpen, setHistPanelOpen] = useState(false);
  const [histList, setHistList] = useState<ConversationSummary[]>([]);
  const [histSearch, setHistSearch] = useState('');
  const [histError, setHistError] = useState('');
  const [histBusy, setHistBusy] = useState(false);
  // id cuộc đang chờ xác nhận xóa (mở hộp xác nhận riêng). null = không xóa.
  const [histDeleteId, setHistDeleteId] = useState<string | null>(null);
  // id cuộc đang sửa tên tại chỗ + giá trị nháp. null = không sửa.
  const [histRenameId, setHistRenameId] = useState<string | null>(null);
  const [histRenameText, setHistRenameText] = useState('');

  // Đồng bộ hóa cấu hình composer vào localStorage (per-tab task/conversationId đã dời sang TaskPane)
  useEffect(() => { localStorage.setItem('bow-cwd', cwd); }, [cwd]);
  useEffect(() => { localStorage.setItem('bow-mode', mode); }, [mode]);
  useEffect(() => { localStorage.setItem('bow-profile', profile); }, [profile]);
  useEffect(() => { localStorage.setItem('bow-selectedModel', selectedModel); }, [selectedModel]);
  useEffect(() => { localStorage.setItem('bow-effort', effort); }, [effort]);
  useEffect(() => { localStorage.setItem('bow-subagents', useSubagents ? '1' : '0'); }, [useSubagents]);
  useEffect(() => { localStorage.setItem('bow-language', language); }, [language]);
  useEffect(() => { localStorage.setItem('bow-selectedMcps', JSON.stringify(selectedMcps)); }, [selectedMcps]);
  useEffect(() => { localStorage.setItem('bow-stack', stack); }, [stack]);
  // Nạp danh sách stack skill external (admin duyệt) một lần lúc mount — để dựng dropdown.
  useEffect(() => {
    apiFetch('/api/skill-stacks')
      .then((r) => (r.ok ? r.json() : { stacks: [] }))
      .then((d) => setSkillStacks(Array.isArray(d.stacks) ? d.stacks : []))
      .catch(() => setSkillStacks([]));
  }, []);
  // Soi trạng thái skill mỗi khi đổi stack HOẶC đổi thư mục dự án (chỉ admin — endpoint gate
  // requireAdmin). Không tải gì, chỉ đọc để dựng badge synced/stale/missing. Gửi kèm cwd để
  // backend biết ĐÃ TRẢI vào project chưa (không có cwd chỉ báo được cache, không biết bản project).
  const refreshSkillStatus = useCallback(() => {
    if (!cfg?.isAdmin) { setSkillStatus(null); return; }
    apiFetch(`/api/skill-status?stack=${encodeURIComponent(stack)}&cwd=${encodeURIComponent(cwd || '')}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setSkillStatus(d && d.core ? d : null))
      .catch(() => setSkillStatus(null));
  }, [cfg?.isAdmin, stack, cwd]);
  useEffect(() => { refreshSkillStatus(); }, [refreshSkillStatus]);
  // ĐỒNG BỘ THỦ CÔNG: tải + trải core + stack đang chọn vào .claude/skills/ của cwd, không cần chạy phiên.
  const syncSkillsNow = useCallback(async () => {
    if (skillSyncing) return;
    if (!cwd) { setSkillSyncMsg('⚠️ Chưa chọn thư mục dự án.'); return; }
    setSkillSyncing(true);
    setSkillSyncMsg('');
    try {
      const r = await apiFetch('/api/skill-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, stack: stack || undefined }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setSkillSyncMsg(`⚠️ Đồng bộ lỗi: ${d?.error || r.status}`);
      } else {
        const parts = [`core${d.core.ok ? ' ✓' : ` ✗ (${d.core.error})`}`];
        if (d.stack) parts.push(`${d.stack.label}${d.stack.ok ? ' ✓' : ` ✗ (${d.stack.error})`}`);
        setSkillSyncMsg(`${d.ok ? '✅ Đã đồng bộ' : '⚠️ Chưa đủ'}: ${parts.join(' · ')}`);
      }
      refreshSkillStatus();
    } catch (e) {
      setSkillSyncMsg(`⚠️ Đồng bộ lỗi: ${(e as Error).message}`);
    } finally {
      setSkillSyncing(false);
    }
  }, [skillSyncing, cwd, stack, refreshSkillStatus]);
  // Toast kết quả đồng bộ tự ẩn sau 5s — phản hồi rõ ràng khi bấm nút 🔄 mà không phá layout hàng.
  useEffect(() => {
    if (!skillSyncMsg) return;
    const t = setTimeout(() => setSkillSyncMsg(''), 5000);
    return () => clearTimeout(t);
  }, [skillSyncMsg]);
  // (Các effect lưu items/conversationId/activeConvId + auto-save cuộc đã dời sang TaskPane.)
  const [pickerOpen, setPickerOpen] = useState(false);
  // Đích của picker: 'cwd' = chọn thư mục làm việc thường; 'qc-cwd' = Admin đổi
  // source mà QC hỏi đáp (QC Mode). Quyết định nút "Chọn thư mục này" làm gì.
  const [pickerTarget, setPickerTarget] = useState<'cwd' | 'dev-cwd' | 'qc-cwd' | 'collab-cwd' | 'ba-cwd' | 'reviewer-cwd' | 'devops-cwd'>('cwd');
  const [pickerPath, setPickerPath] = useState('');
  const [pickerParent, setPickerParent] = useState<string | null>(null);
  const [pickerDirs, setPickerDirs] = useState<string[]>([]);
  const [pickerError, setPickerError] = useState('');

  // State for Custom Claude Account Modal
  const [claudeModal, setClaudeModal] = useState<{
    type: 'prompt' | 'alert';
    title: string;
    message: string;
    onConfirm: (val?: string) => void;
    onCancel?: () => void;
  } | null>(null);
  const [claudeModalInput, setClaudeModalInput] = useState('');

  const showClaudePrompt = (title: string, message: string, defaultValue = ''): Promise<string | null> => {
    return new Promise((resolve) => {
      setClaudeModalInput(defaultValue);
      setClaudeModal({
        type: 'prompt',
        title,
        message,
        onConfirm: (val) => {
          resolve(val || null);
        },
        onCancel: () => {
          resolve(null);
        }
      });
    });
  };

  const showClaudeAlert = (title: string, message: string): Promise<void> => {
    return new Promise((resolve) => {
      setClaudeModal({
        type: 'alert',
        title,
        message,
        onConfirm: () => {
          resolve();
        }
      });
    });
  };

  const [authModal, setAuthModal] = useState<AuthModalState | null>(null);

  const [copiedOauthUrl, setCopiedOauthUrl] = useState(false);

  const submitOauthCode = async () => {
    if (!authModal || authModal.mode !== 'oauth') return;
    setAuthModal(prev => prev ? { ...prev, oauthLoading: true, oauthError: '' } : null);
    try {
      const res = await apiFetch('/api/profiles/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: authModal.profile, code: authModal.oauthCode }),
      });
      if (res.ok) {
        setAuthModal(null);
        const configRes = await apiFetch('/api/config');
        if (configRes.ok) {
          const newCfg = await configRes.json();
          setCfg(newCfg);
          if (newCfg.mcpServers) {
            setSelectedMcps(newCfg.mcpServers);
          }
        }
        await showClaudeAlert('Đăng nhập thành công', `Tài khoản 'claude-${authModal.profile}' đã được đăng nhập thành công.`);
      } else {
        const err = await res.json();
        setAuthModal(prev => prev ? { ...prev, oauthLoading: false, oauthError: err.error || 'Xác thực thất bại.' } : null);
      }
    } catch (e) {
      console.error(e);
      setAuthModal(prev => prev ? { ...prev, oauthLoading: false, oauthError: 'Lỗi kết nối.' } : null);
    }
  };

  const submitManualToken = async () => {
    if (!authModal || authModal.mode !== 'token') return;
    setAuthModal(prev => prev ? { ...prev, tokenLoading: true, tokenError: '' } : null);
    try {
      const res = await apiFetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: authModal.profile, token: authModal.tokenValue }),
      });
      if (res.ok) {
        setAuthModal(null);
        const configRes = await apiFetch('/api/config');
        if (configRes.ok) {
          const newCfg = await configRes.json();
          setCfg(newCfg);
          if (newCfg.mcpServers) {
            setSelectedMcps(newCfg.mcpServers);
          }
        }
        await showClaudeAlert('Thành công', 'Đã cập nhật token cấu hình cho tài khoản này.');
      } else {
        const err = await res.json();
        setAuthModal(prev => prev ? { ...prev, tokenLoading: false, tokenError: err.error || 'Lưu token thất bại.' } : null);
      }
    } catch (e) {
      console.error(e);
      setAuthModal(prev => prev ? { ...prev, tokenLoading: false, tokenError: 'Lỗi kết nối.' } : null);
    }
  };

  // ── Panel quản lý MCP server ──
  const [mcpPanelOpen, setMcpPanelOpen] = useState(false);
  const [mcpList, setMcpList] = useState<
    { name: string; command: string; args: string[]; envKeys: string[]; stdio: boolean }[]
  >([]);
  const [mcpForm, setMcpForm] = useState({ name: '', command: '', args: '', env: '' });
  const [mcpError, setMcpError] = useState('');
  const [mcpBusy, setMcpBusy] = useState(false);
  // MCP RIÊNG của user LAN (overlay lên MCP chung). Chỉ dùng khi KHÔNG phải admin.
  const [myMcpList, setMyMcpList] = useState<
    { name: string; command: string; args: string[]; envKeys: string[]; stdio: boolean }[]
  >([]);

  // ── Workspace (nhóm nhiều repo + trí nhớ tích lũy) — xem DESIGN §9 ──
  const [wsPanelOpen, setWsPanelOpen] = useState(false);
  const [wsList, setWsList] = useState<Ws[]>([]);
  const [wsError, setWsError] = useState('');
  const [wsBusy, setWsBusy] = useState(false);
  // Form gán repo: tên workspace + path + vai trò. Prefill path = cwd hiện tại cho tiện.
  const [wsForm, setWsForm] = useState({ name: '', path: '', role: '' });
  // Workspace mà cwd hiện tại thuộc về (cho badge chỉ báo ở composer). null = không thuộc.
  const [currentWs, setCurrentWs] = useState<Ws | null>(null);
  // Slug workspace đang mở xem tri thức (shared.md + journal) trong panel. null = chưa mở.
  const [wsViewSlug, setWsViewSlug] = useState<string | null>(null);
  const [wsShared, setWsShared] = useState('');
  const [wsJournal, setWsJournal] = useState('');
  const [wsSharedDirty, setWsSharedDirty] = useState(false);

  // ── Panel "Cấu trúc dự án" (header) — AI quét cwd rồi mô tả kiến trúc ──
  const [structPanelOpen, setStructPanelOpen] = useState(false);
  const [structBusy, setStructBusy] = useState(false);
  const [structText, setStructText] = useState('');       // mô tả markdown AI trả về
  const [structCwd, setStructCwd] = useState('');          // cwd đã phân tích (để biết đang xem repo nào)
  const [structError, setStructError] = useState('');

  // ── Chat nhóm (người-với-người qua LAN) ──
  const chatUserId = useRef(getChatUserId()).current;
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  const [chatNickname, setChatNickname] = useState(() => {
    try { return localStorage.getItem(CHAT_NICKNAME_KEY) || ''; } catch { return ''; }
  });
  const [chatGroupInput, setChatGroupInput] = useState(() => {
    try { return localStorage.getItem(CHAT_LAST_GROUP_KEY) || ''; } catch { return ''; }
  });
  const [chatJoinedGroup, setChatJoinedGroup] = useState<string | null>(null); // đã vào phòng nào (null = màn hình nhập)
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatError, setChatError] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const chatSseRef = useRef<EventSource | null>(null);   // SSE realtime của phòng đang mở
  const chatScrollRef = useRef<HTMLDivElement | null>(null); // khung tin để auto-cuộn xuống đáy

  useEffect(() => { try { localStorage.setItem(CHAT_NICKNAME_KEY, chatNickname); } catch {} }, [chatNickname]);

  /**
   * Làm mới snapshot hạn mức gói qua /api/usage (độc lập lượt chạy). Chỉ cập nhật phần
   * rateLimits/subscription; GIỮ context window cũ (đến từ event 'usage' trong lượt chạy
   * — /api/usage đọc từ phiên trống nên context không phản ánh hội thoại thật).
   */
  const refreshUsage = () => {
    setUsageLoading(true);
    apiFetch(`/api/usage?model=${encodeURIComponent(selectedModel)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { usage: UsageSnapshot }) => {
        setUsage((prev) => ({
          ...d.usage,
          // Luôn kế thừa context từ prev (kể cả null sau khi reset cuộc mới) — /api/usage
          // đọc phiên trống nên context của nó không đáng tin; chỉ event 'usage' của lượt
          // chạy mới đặt số thật. Không dùng `??` để tránh nạp lại context phiên trống.
          contextTokens: prev ? prev.contextTokens : d.usage.contextTokens,
          contextMaxTokens: prev ? prev.contextMaxTokens : d.usage.contextMaxTokens,
          contextPercentage: prev ? prev.contextPercentage : d.usage.contextPercentage,
        }));
      })
      .catch(() => {})
      .finally(() => setUsageLoading(false));
  };

  /** Tải danh sách MCP từ backend (che token). */
  const loadMcpList = () => {
    apiFetch('/api/mcp')
      .then((r) => r.json())
      .then((d) => setMcpList(d.servers ?? []))
      .catch(() => setMcpError('Không tải được danh sách MCP.'));
  };

  const openMcpPanel = () => {
    setMcpError('');
    setMcpForm({ name: '', command: '', args: '', env: '' });
    setMcpPanelOpen(true);
    // Admin quản MCP CHUNG (~/.claude.json); user LAN quản MCP RIÊNG của chính họ.
    if (cfg?.isAdmin) loadMcpList();
    else loadMyMcpList();
  };

  /** Thêm MCP mới: parse args (mỗi dòng/khoảng trắng) + env (mỗi dòng KEY=VALUE). */
  const submitMcp = async () => {
    setMcpError('');
    const name = mcpForm.name.trim();
    const command = mcpForm.command.trim();
    if (!name || !command) {
      setMcpError('Cần nhập Tên và Command.');
      return;
    }
    // Args: tách theo dòng, mỗi dòng có thể chứa nhiều token phân tách bởi khoảng trắng.
    const args = mcpForm.args
      .split('\n')
      .flatMap((line) => line.trim().split(/\s+/))
      .filter(Boolean);
    // Env: mỗi dòng "KEY=VALUE". Bỏ dòng rỗng / không có '='.
    const env: Record<string, string> = {};
    for (const line of mcpForm.env.split('\n')) {
      const t = line.trim();
      if (!t || !t.includes('=')) continue;
      const idx = t.indexOf('=');
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    setMcpBusy(true);
    try {
      const res = await apiFetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, command, args, env }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMcpError(data.error ?? 'Thêm MCP thất bại.');
        return;
      }
      setMcpList(data.servers ?? []);
      setMcpForm({ name: '', command: '', args: '', env: '' });
      // Refresh /api/config để checkbox MCP ở composer cập nhật danh sách mới.
      apiFetch('/api/config')
        .then((r) => r.json())
        .then((c) => { if (c.mcpServers) setCfg((prev) => (prev ? { ...prev, mcpServers: c.mcpServers } : prev)); })
        .catch(() => {});
    } catch (err) {
      setMcpError(`Lỗi gọi backend: ${(err as Error).message}`);
    } finally {
      setMcpBusy(false);
    }
  };

  /** Xóa một MCP. */
  const deleteMcp = async (name: string) => {
    setMcpError('');
    setMcpBusy(true);
    try {
      const res = await apiFetch(`/api/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        setMcpError(data.error ?? 'Xóa thất bại.');
        return;
      }
      setMcpList(data.servers ?? []);
      apiFetch('/api/config')
        .then((r) => r.json())
        .then((c) => {
          if (c.mcpServers) {
            setCfg((prev) => (prev ? { ...prev, mcpServers: c.mcpServers } : prev));
            // Bỏ MCP vừa xóa khỏi danh sách đang chọn.
            setSelectedMcps((prev) => prev.filter((n) => c.mcpServers.includes(n)));
          }
        })
        .catch(() => {});
    } catch (err) {
      setMcpError(`Lỗi gọi backend: ${(err as Error).message}`);
    } finally {
      setMcpBusy(false);
    }
  };

  // ── MCP RIÊNG của user LAN (/api/my-mcp) — overlay lên MCP chung, chỉ ảnh hưởng chính họ.
  //    Dùng lại state form/error/busy chung; danh sách riêng ở myMcpList. Không đụng
  //    /api/config (MCP riêng tự áp mọi lần chạy, không nằm trong checkbox composer).

  /** Tải danh sách MCP RIÊNG của user (che token). */
  const loadMyMcpList = () => {
    apiFetch('/api/my-mcp')
      .then((r) => r.json())
      .then((d) => setMyMcpList(d.servers ?? []))
      .catch(() => setMcpError('Không tải được danh sách MCP riêng.'));
  };

  /** Thêm MCP RIÊNG mới: parse args/env giống submitMcp. */
  const submitMyMcp = async () => {
    setMcpError('');
    const name = mcpForm.name.trim();
    const command = mcpForm.command.trim();
    if (!name || !command) {
      setMcpError('Cần nhập Tên và Command.');
      return;
    }
    const args = mcpForm.args
      .split('\n')
      .flatMap((line) => line.trim().split(/\s+/))
      .filter(Boolean);
    const env: Record<string, string> = {};
    for (const line of mcpForm.env.split('\n')) {
      const t = line.trim();
      if (!t || !t.includes('=')) continue;
      const idx = t.indexOf('=');
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    setMcpBusy(true);
    try {
      const res = await apiFetch('/api/my-mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, command, args, env }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMcpError(data.error ?? 'Thêm MCP thất bại.');
        return;
      }
      setMyMcpList(data.servers ?? []);
      setMcpForm({ name: '', command: '', args: '', env: '' });
    } catch (err) {
      setMcpError(`Lỗi gọi backend: ${(err as Error).message}`);
    } finally {
      setMcpBusy(false);
    }
  };

  /** Xóa một MCP RIÊNG của user. */
  const deleteMyMcp = async (name: string) => {
    setMcpError('');
    setMcpBusy(true);
    try {
      const res = await apiFetch(`/api/my-mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        setMcpError(data.error ?? 'Xóa thất bại.');
        return;
      }
      setMyMcpList(data.servers ?? []);
    } catch (err) {
      setMcpError(`Lỗi gọi backend: ${(err as Error).message}`);
    } finally {
      setMcpBusy(false);
    }
  };

  // ── Workspace: tải danh sách, gán/gỡ repo, xem/sửa tri thức ──

  /** Tải danh sách workspace từ backend. */
  const loadWsList = () => {
    apiFetch('/api/workspaces')
      .then((r) => r.json())
      .then((d) => setWsList(d.workspaces ?? []))
      .catch(() => setWsError('Không tải được danh sách workspace.'));
  };

  const openWsPanel = () => {
    setWsError('');
    // Prefill: path = cwd hiện tại (thứ hay muốn gán nhất), tên = workspace hiện tại nếu có.
    setWsForm({ name: currentWs?.slug ?? '', path: cwd.trim(), role: '' });
    setWsViewSlug(null);
    setWsPanelOpen(true);
    loadWsList();
  };

  /** Cập nhật badge "cwd thuộc workspace nào" — gọi khi cwd đổi hoặc sau khi gán/gỡ. */
  const refreshCurrentWs = (dir: string) => {
    const d = dir.trim();
    if (!d) { setCurrentWs(null); return; }
    apiFetch(`/api/workspace/current?cwd=${encodeURIComponent(d)}`)
      .then((r) => r.json())
      .then((res) => setCurrentWs(res.workspace ?? null))
      .catch(() => setCurrentWs(null));
  };

  /** Gán repo vào workspace (tạo nếu chưa có). */
  const submitWsRepo = async () => {
    setWsError('');
    const name = wsForm.name.trim();
    const path = wsForm.path.trim();
    if (!name || !path) { setWsError('Cần nhập Tên workspace và Đường dẫn repo.'); return; }
    setWsBusy(true);
    try {
      const res = await apiFetch('/api/workspace/repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path, role: wsForm.role.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setWsError(data.error ?? 'Gán repo thất bại.'); return; }
      loadWsList();
      setWsForm((f) => ({ ...f, path: '', role: '' })); // giữ tên để gán tiếp repo khác
      refreshCurrentWs(cwd);
    } catch (err) {
      setWsError(`Lỗi gọi backend: ${(err as Error).message}`);
    } finally {
      setWsBusy(false);
    }
  };

  /** Gỡ một repo khỏi workspace. */
  const removeWsRepo = async (name: string, path: string) => {
    setWsError('');
    setWsBusy(true);
    try {
      const res = await apiFetch('/api/workspace/repo', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path }),
      });
      const data = await res.json();
      if (!res.ok) { setWsError(data.error ?? 'Gỡ repo thất bại.'); return; }
      setWsList(data.workspaces ?? []);
      if (wsViewSlug === name && !(data.workspaces ?? []).some((w: Ws) => w.slug === name)) {
        setWsViewSlug(null); // workspace vừa bị xóa (hết repo) → đóng khung xem
      }
      refreshCurrentWs(cwd);
    } catch (err) {
      setWsError(`Lỗi gọi backend: ${(err as Error).message}`);
    } finally {
      setWsBusy(false);
    }
  };

  /** Mở khung xem tri thức (shared.md + journal) của một workspace. */
  const openWsKnowledge = (slug: string) => {
    setWsError('');
    setWsViewSlug(slug);
    setWsSharedDirty(false);
    apiFetch(`/api/workspace/${encodeURIComponent(slug)}/knowledge`)
      .then((r) => r.json())
      .then((d) => { setWsShared(d.shared ?? ''); setWsJournal(d.journal ?? ''); })
      .catch(() => setWsError('Không tải được tri thức workspace.'));
  };

  /** Lưu shared.md của workspace đang xem. */
  const saveWsShared = async () => {
    if (!wsViewSlug) return;
    setWsBusy(true);
    try {
      const res = await apiFetch(`/api/workspace/${encodeURIComponent(wsViewSlug)}/shared`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: wsShared }),
      });
      if (!res.ok) { const d = await res.json(); setWsError(d.error ?? 'Lưu thất bại.'); return; }
      setWsSharedDirty(false);
    } catch (err) {
      setWsError(`Lỗi gọi backend: ${(err as Error).message}`);
    } finally {
      setWsBusy(false);
    }
  };

  // ── Cấu trúc dự án: mở panel + chạy AI phân tích cwd ──

  /**
   * Chạy AI quét cwd rồi hiện mô tả cấu trúc. Dùng SSE (KHÔNG treo HTTP request 60s —
   * đó là nguyên nhân lỗi "Unexpected end of JSON input" khi proxy/browser cắt kết nối):
   * POST trả sessionId ngay → mở EventSource nghe tiến độ + kết quả cuối ('done').
   * SSE riêng cho panel, không đổ vào chat.
   */
  const runAnalyzeStructure = async () => {
    const dir = cwd.trim();
    if (!dir) { setStructError('Chưa có thư mục repo (cwd) để phân tích.'); return; }
    setStructError('');
    setStructBusy(true);
    setStructText('');
    try {
      const res = await apiFetch('/api/analyze-structure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: dir }),
      });
      // Lỗi sớm (vd thư mục không tồn tại) trả JSON {error} kèm status != 200.
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStructError((data as { error?: string }).error ?? 'Phân tích thất bại.');
        setStructBusy(false);
        return;
      }
      const { sessionId: sid } = await res.json();
      const src = new EventSource(withToken(`/api/events/${sid}`));
      // Gom các text block tiến độ để hiện dần (agent vừa quét vừa mô tả).
      let acc = '';
      src.onmessage = (msg) => {
        const ev = JSON.parse(msg.data) as
          | { type: 'text'; text: string }
          | { type: 'done'; result: string | null }
          | { type: 'fatal'; message: string }
          | { type: string };
        if (ev.type === 'text') {
          acc += (acc ? '\n\n' : '') + (ev as { text: string }).text;
          setStructText(acc);
        } else if (ev.type === 'done') {
          // Kết quả cuối = mô tả đầy đủ (ưu tiên hơn bản gom dần).
          const result = (ev as { result: string | null }).result;
          if (result) setStructText(result);
          setStructCwd(dir);
          setStructBusy(false);
          src.close();
        } else if (ev.type === 'fatal') {
          setStructError((ev as { message: string }).message || 'Phân tích thất bại.');
          setStructBusy(false);
          src.close();
        }
      };
      src.onerror = () => {
        // SSE đứt: nếu chưa có kết quả thì báo lỗi; có rồi thì coi như xong.
        setStructBusy(false);
        if (!acc) setStructError('Mất kết nối khi phân tích. Thử lại.');
        src.close();
      };
    } catch (err) {
      setStructError(`Lỗi gọi backend: ${(err as Error).message}`);
      setStructBusy(false);
    }
  };

  /** Mở panel cấu trúc; nếu chưa có kết quả cho cwd hiện tại thì tự chạy phân tích. */
  const openStructPanel = () => {
    setStructPanelOpen(true);
    // Tự phân tích nếu chưa có kết quả, hoặc cwd đã đổi so với lần phân tích trước.
    if (!structBusy && (!structText || structCwd !== cwd.trim())) {
      runAnalyzeStructure();
    }
  };

  // ── Chat nhóm: vào phòng, gửi tin, realtime SSE ──

  /** Đóng SSE phòng đang mở (nếu có). */
  const closeChatSse = () => {
    chatSseRef.current?.close();
    chatSseRef.current = null;
  };

  /**
   * Vào một phòng: nạp lịch sử (REST) rồi mở SSE nghe tin mới. Cần biệt danh + mã phòng.
   */
  const joinChatGroup = async () => {
    const gid = chatGroupInput.trim();
    const nick = chatNickname.trim();
    if (!gid) { setChatError('Nhập mã phòng để vào nhóm.'); return; }
    if (!nick) { setChatError('Đặt biệt danh trước khi vào phòng.'); return; }
    setChatError('');
    setChatBusy(true);
    try {
      // Vào/tạo phòng — trả về lịch sử tin.
      const res = await apiFetch('/api/chat/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: gid, name: gid }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Không vào được phòng.');
      const group = data.group as { id: string; messages: ChatMsg[] };
      setChatJoinedGroup(group.id);
      setChatMessages(Array.isArray(group.messages) ? group.messages : []);
      try { localStorage.setItem(CHAT_LAST_GROUP_KEY, group.id); } catch {}

      // Mở SSE realtime — chỉ giữ ĐÚNG MỘT stream.
      closeChatSse();
      const src = new EventSource(withToken(`/api/chat/groups/${encodeURIComponent(group.id)}/events`));
      chatSseRef.current = src;
      src.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.type === 'message' && ev.message) {
            const m = ev.message as ChatMsg;
            // Dedup theo id (phòng SSE chồng lấn / gửi tin của chính mình cũng vọng về).
            setChatMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
          }
        } catch { /* bỏ qua dòng lỗi */ }
      };
      src.onerror = () => { /* LAN chập chờn — EventSource tự reconnect, không cần báo. */ };
    } catch (err) {
      setChatError((err as Error).message);
    } finally {
      setChatBusy(false);
    }
  };

  /** Rời phòng: đóng SSE, về màn hình nhập. */
  const leaveChatGroup = () => {
    closeChatSse();
    setChatJoinedGroup(null);
    setChatMessages([]);
    setChatDraft('');
  };

  /** Gửi một tin nhắn vào phòng đang mở. */
  const sendChatMessage = async () => {
    const text = chatDraft.trim();
    if (!text || !chatJoinedGroup) return;
    const nick = chatNickname.trim() || 'Ẩn danh';
    setChatDraft(''); // xoá ô ngay cho mượt; tin thật hiện lại qua SSE
    try {
      const res = await apiFetch(`/api/chat/groups/${encodeURIComponent(chatJoinedGroup)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: chatUserId, nickname: nick, text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setChatError(data?.error || 'Gửi tin thất bại.');
        setChatDraft(text); // trả lại nội dung để gửi lại
      }
    } catch (err) {
      setChatError((err as Error).message);
      setChatDraft(text);
    }
  };

  /** Mở panel chat: nếu đã có biệt danh + mã phòng nhớ sẵn thì vào thẳng. */
  const openChatPanel = () => {
    setChatPanelOpen(true);
    setChatError('');
  };

  // Auto-cuộn xuống đáy khi có tin mới (nếu panel đang mở).
  useEffect(() => {
    if (chatPanelOpen && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, chatPanelOpen]);

  // Dọn SSE khi component unmount.
  useEffect(() => () => closeChatSse(), []);

  // ── Lịch sử nhiều cuộc trò chuyện: tóm tắt, tải danh sách, lưu, mở, đổi tên, xóa ──

  /** Rút tiêu đề từ items = câu user đầu tiên (cắt gọn). Rỗng nếu chưa có câu nào. */
  // (deriveTitle/summarizeForResume/persistActiveConversation đã dời sang TaskPane.)

  /** Tải danh sách cuộc trò chuyện từ backend. */
  const loadHistList = () => {
    apiFetch('/api/conversations')
      .then((r) => r.json())
      .then((d) => setHistList(d.conversations ?? []))
      .catch(() => setHistError('Không tải được lịch sử chat.'));
  };

  const openHistPanel = () => {
    setHistError('');
    setHistSearch('');
    setHistRenameId(null);
    setHistDeleteId(null);
    setHistPanelOpen(true);
    loadHistList();
  };

  /**
   * Mở một cuộc cũ vào tab đang hiển thị. Phần global (busy/error/đóng panel) do App giữ;
   * việc nạp items/conversationId/cwd giao cho TaskPane qua handle (state per-tab nằm bên đó).
   */
  const openConversation = async (id: string) => {
    const pane = activePaneRef();
    if (id === pane?.getActiveConvId() && !histPanelOpen) return;
    setHistBusy(true);
    try {
      const r = await pane?.openConversation(id);
      if (r && !r.ok) { setHistError(r.error || 'Không mở được cuộc trò chuyện.'); return; }
      setHistPanelOpen(false);
    } finally {
      setHistBusy(false);
    }
  };

  /** Mở một cuộc cũ vào MỘT TAB MỚI (giống Claude VSCode: mỗi lịch sử một tab). */
  const openConversationInNewTab = async (id: string) => {
    setHistBusy(true);
    try {
      // Tạo tab mới rồi chờ pane của nó mount xong mới gọi openConversation qua handle.
      const tabId = crypto.randomUUID();
      setTabs((prev) => [...prev, { id: tabId, title: '' }]);
      setActiveTabId(tabId);
      setHistPanelOpen(false);
      // Pane mount ở lần render kế; thử gọi handle sau vài nhịp (retry ngắn).
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 25));
        const pane = paneRefs.current[tabId];
        if (pane) { await pane.openConversation(id); break; }
      }
    } finally {
      setHistBusy(false);
    }
  };

  /** Lưu tên mới cho một cuộc (đổi tên tại chỗ trong panel). */
  const submitRename = async (id: string) => {
    const title = histRenameText.trim();
    setHistRenameId(null);
    if (!title) return;
    try {
      await apiFetch(`/api/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      loadHistList();
    } catch {
      setHistError('Đổi tên thất bại.');
    }
  };

  /** Xóa một cuộc (sau xác nhận). Nếu là cuộc đang mở → dọn tab về trạng thái mới (qua handle). */
  const confirmDeleteConversation = async (id: string) => {
    setHistDeleteId(null);
    try {
      const res = await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' });
      const data = await res.json();
      setHistList(data.conversations ?? []);
      // Xóa cuộc đang mở ở BẤT KỲ tab nào → reset tab đó về phiên mới trống.
      for (const pane of Object.values(paneRefs.current)) {
        if (pane && id === pane.getActiveConvId()) pane.resetForDeleted();
      }
    } catch {
      setHistError('Xóa thất bại.');
    }
  };

  const [devRepoLabel, setDevRepoLabel] = useState('');
  const [devCwd, setDevCwd] = useState('');
  const [qcRepoLabel, setQcRepoLabel] = useState('');
  const [qcCwd, setQcCwd] = useState('');
  const [collabRepoLabel, setCollabRepoLabel] = useState('');
  const [collabCwd, setCollabCwd] = useState('');
  const [baRepoLabel, setBaRepoLabel] = useState('');
  const [baCwd, setBaCwd] = useState('');
  const [reviewerRepoLabel, setReviewerRepoLabel] = useState('');
  const [reviewerCwd, setReviewerCwd] = useState('');
  const [devopsRepoLabel, setDevopsRepoLabel] = useState('');
  const [devopsCwd, setDevopsCwd] = useState('');

  // Nạp repo của các chế độ khác khi là admin
  useEffect(() => {
    if (!cfg?.isAdmin) return;

    const fetchConfigs = () => {
      apiFetch('/api/config')
        .then((r) => r.json())
        .then((c) => {
          if (c.otherModes) {
            // Cập nhật cả otherModes để cờ active bám theo mode bật/tắt sau khi trang
            // đã mở. Giữ nguyên object cũ khi nội dung không đổi — tránh đổi identity
            // mỗi 5s làm getActiveOrigins đổi → các EventSource bị đóng/mở lại liên tục.
            setOtherModes((prev) =>
              JSON.stringify(prev) === JSON.stringify(c.otherModes) ? prev : c.otherModes,
            );
            setDevRepoLabel(c.otherModes.dev.repoName);
            setDevCwd(c.otherModes.dev.defaultCwd);
            setQcRepoLabel(c.otherModes.qc.repoName);
            setQcCwd(c.otherModes.qc.defaultCwd);
            setCollabRepoLabel(c.otherModes.collab.repoName);
            setCollabCwd(c.otherModes.collab.defaultCwd);
            if (c.otherModes.ba) {
              setBaRepoLabel(c.otherModes.ba.repoName);
              setBaCwd(c.otherModes.ba.defaultCwd);
            }
            if (c.otherModes.review) {
              setReviewerRepoLabel(c.otherModes.review.repoName);
              setReviewerCwd(c.otherModes.review.defaultCwd);
            }
            if (c.otherModes.devops) {
              setDevopsRepoLabel(c.otherModes.devops.repoName);
              setDevopsCwd(c.otherModes.devops.defaultCwd);
            }
          }
        })
        .catch(() => {});
    };

    fetchConfigs();
    const interval = setInterval(fetchConfigs, 5000); // cập nhật trạng thái folder mỗi 5s
    return () => clearInterval(interval);
  }, [cfg?.isAdmin]);

  const openPicker = (initialPath: string, target: 'cwd' | 'dev-cwd' | 'qc-cwd' | 'collab-cwd' | 'ba-cwd' | 'reviewer-cwd' | 'devops-cwd' = 'cwd') => {
    setPickerError('');
    setPickerTarget(target);
    setPickerOpen(true);
    fetchDirs(initialPath || cfg?.defaultCwd || '');
  };

  const applyPortCwd = async (target: 'dev-cwd' | 'qc-cwd' | 'collab-cwd' | 'ba-cwd' | 'reviewer-cwd' | 'devops-cwd', dir: string) => {
    try {
      const port = target === 'dev-cwd' ? 4000 : target === 'qc-cwd' ? 4001 : target === 'collab-cwd' ? 4002 : target === 'ba-cwd' ? 4003 : target === 'reviewer-cwd' ? 4004 : 4005;
      const res = await fetch(`http://localhost:${port}/api/qc-cwd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: dir }),
      });
      const data = await res.json();
      if (!res.ok) { setPickerError(data.error ?? 'Đổi source thất bại.'); return; }
      
      if (target === 'qc-cwd') {
        setQcRepoLabel(data.repoName);
        setQcCwd(data.cwd);
        if (cfg?.isQcMode) {
          setCfg((c) => (c ? { ...c, defaultCwd: data.cwd, repoName: data.repoName } : c));
          setCwd(data.cwd);
        }
      } else if (target === 'collab-cwd') {
        setCollabRepoLabel(data.repoName);
        setCollabCwd(data.cwd);
        if (cfg?.isCollabMode) {
          setCfg((c) => (c ? { ...c, defaultCwd: data.cwd, repoName: data.repoName } : c));
          setCwd(data.cwd);
        }
      } else if (target === 'ba-cwd') {
        setBaRepoLabel(data.repoName);
        setBaCwd(data.cwd);
        if (cfg?.isBaMode) {
          setCfg((c) => (c ? { ...c, defaultCwd: data.cwd, repoName: data.repoName } : c));
          setCwd(data.cwd);
        }
      } else if (target === 'reviewer-cwd') {
        setReviewerRepoLabel(data.repoName);
        setReviewerCwd(data.cwd);
        if (cfg?.isReviewerMode) {
          setCfg((c) => (c ? { ...c, defaultCwd: data.cwd, repoName: data.repoName } : c));
          setCwd(data.cwd);
        }
      } else if (target === 'devops-cwd') {
        setDevopsRepoLabel(data.repoName);
        setDevopsCwd(data.cwd);
        if (cfg?.isDevOpsMode) {
          setCfg((c) => (c ? { ...c, defaultCwd: data.cwd, repoName: data.repoName } : c));
          setCwd(data.cwd);
        }
      } else if (target === 'dev-cwd') {
        setDevRepoLabel(data.repoName);
        setDevCwd(data.cwd);
        if (!cfg?.isQcMode && !cfg?.isReviewerMode && !cfg?.isCollabMode && !cfg?.isBaMode && !cfg?.isDevOpsMode) {
          setCfg((c) => (c ? { ...c, defaultCwd: data.cwd, repoName: data.repoName } : c));
          setCwd(data.cwd);
        }
      }
      setPickerOpen(false);
    } catch (err) {
      setPickerError((err as Error).message);
    }
  };

  const changeActiveCwd = (newPath: string) => {
    setCwd(newPath);
    if (cfg?.isAdmin) {
      const activeTarget = cfg?.isQcMode
        ? 'qc-cwd'
        : cfg?.isReviewerMode
          ? 'reviewer-cwd'
          : cfg?.isCollabMode
            ? 'collab-cwd'
            : cfg?.isBaMode
              ? 'ba-cwd'
              : cfg?.isDevOpsMode
                ? 'devops-cwd'
                : 'dev-cwd';
      applyPortCwd(activeTarget, newPath);
      // Collab bám theo nguồn chọn ở thanh dưới: nếu tiến trình Collab (4002) đang
      // chạy và mode hiện tại không phải Collab, đồng bộ luôn thư mục Collab sang
      // cùng nguồn để pill "Nguồn Collab" và phiên CTV khớp thư mục đang thao tác.
      if (activeTarget !== 'collab-cwd' && otherModes?.collab?.active) {
        applyPortCwd('collab-cwd', newPath);
      }
    }
  };

  const fetchDirs = (path: string) => {
    setPickerError('');
    apiFetch(`/api/browse-dirs?path=${encodeURIComponent(path)}`)
      .then((r) => {
        if (!r.ok) throw new Error('Không thể đọc thư mục');
        return r.json();
      })
      .then((data) => {
        setPickerPath(data.currentPath);
        setPickerParent(data.parent);
        setPickerDirs(data.dirs);
      })
      .catch((err) => {
        setPickerError(err.message);
      });
  };



  // ── Cổng duyệt truy cập theo tên ──────────────────────────────────────────
  const [gateState, setGateState] = useState<'checking' | 'locked' | 'pending' | 'rejected' | 'open'>('checking');
  const [nameInput, setNameInput] = useState('');
  const [codeError, setCodeError] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [accessUsers, setAccessUsers] = useState<any[]>([]);
  const [adminCodeBusy, setAdminCodeBusy] = useState(false);
  const [adminCodeMsg, setAdminCodeMsg] = useState('');

  const refreshAccessUsers = useCallback(() => {
    if (!cfg?.isAdmin) return;
    const origins = getActiveOrigins();
    setAccessUsers([]);
    origins.forEach((origin) => {
      fetch(`${origin}/api/access/users`)
        .then((r) => r.json())
        .then((data: { users?: any[] }) => {
          if (data.users) {
            const mapped = data.users.map((u) => ({ ...u, apiOrigin: origin }));
            setAccessUsers((prev) => {
              const filtered = prev.filter((p) => !mapped.some((m) => m.id === p.id));
              return [...filtered, ...mapped];
            });
          }
        })
        .catch(() => {});
    });
  }, [cfg?.isAdmin, getActiveOrigins]);

  // Kiểm tra cổng lúc mở app và định kỳ 2s/lần
  useEffect(() => {
    let isMounted = true;
    const checkStatus = () => {
      apiFetch('/api/access/status')
        .then((r) => r.json())
        .then((s: { allowed?: boolean; status?: 'none' | 'pending' | 'approved' | 'rejected'; isAdmin?: boolean }) => {
          if (!isMounted) return;
          if (s.allowed) {
            setGateState('open');
          } else if (s.status === 'pending') {
            setGateState('pending');
          } else if (s.status === 'rejected') {
            setGateState('rejected');
          } else {
            setGateState('locked');
          }
        })
        .catch(() => {
          if (isMounted) setGateState('open'); // Lỗi mạng: không khoá cứng
        });
    };

    checkStatus();

    const interval = setInterval(checkStatus, 2000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // Gửi tên lên server để xin duyệt truy cập.
  const submitAccessName = async () => {
    const name = nameInput.trim();
    if (!name) return;
    setCodeBusy(true);
    setCodeError('');
    try {
      // Gửi kèm token đã lưu (nếu có) để server nhận lại ĐÚNG bản ghi của chính mình khi
      // reload — server che token của người khác cùng tên+IP (chống rò token, M6).
      const savedToken = localStorage.getItem(ACCESS_TOKEN_KEY) || '';
      const reqHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (savedToken) reqHeaders['x-bow-token'] = savedToken;
      const res = await fetch('/api/access/request', {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (res.ok && data.token) {
        setAccessToken(data.token);
        setGateState(data.status || 'pending');
      } else {
        setCodeError(data.error || 'Lỗi gửi yêu cầu.');
      }
    } catch {
      setCodeError('Không kết nối được server.');
    } finally {
      setCodeBusy(false);
    }
  };

  const handleApproveAccess = async (id: string, apiOrigin?: string) => {
    try {
      const origin = apiOrigin || '';
      await fetch(`${origin}/api/access/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setAccessUsers((prev) =>
        prev.map((u) => (u.id === id ? { ...u, status: 'approved', updatedAt: Date.now() } : u)),
      );
    } catch {}
  };

  const handleRejectAccess = async (id: string, apiOrigin?: string) => {
    try {
      const origin = apiOrigin || '';
      await fetch(`${origin}/api/access/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setAccessUsers((prev) =>
        prev.map((u) => (u.id === id ? { ...u, status: 'rejected', updatedAt: Date.now() } : u)),
      );
    } catch {}
  };

  const handleRevokeAccess = async (id: string, apiOrigin?: string) => {
    try {
      const origin = apiOrigin || '';
      await fetch(`${origin}/api/access/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setAccessUsers((prev) =>
        prev.map((u) => (u.id === id ? { ...u, status: 'rejected', updatedAt: Date.now() } : u)),
      );
    } catch {}
  };

  // Nạp danh sách khi là admin
  useEffect(() => {
    if (cfg?.isAdmin) {
      refreshAccessUsers();
    }
  }, [cfg?.isAdmin, refreshAccessUsers]);

  // Nhận sự kiện realtime về yêu cầu truy cập từ LAN (trên cả các cổng đang hoạt động)
  useEffect(() => {
    if (!cfg?.isAdmin) return;
    const origins = getActiveOrigins();
    const sources: EventSource[] = [];

    origins.forEach((origin) => {
      const src = new EventSource(`${origin}/api/access/events`);
      src.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data);
          if (ev.type === 'access-request' && ev.user) {
            setAccessUsers((prev) => {
              const userWithOrigin = { ...ev.user, apiOrigin: origin };
              const exists = prev.some((u) => u.id === ev.user.id);
              if (exists) {
                return prev.map((u) => (u.id === ev.user.id ? userWithOrigin : u));
              }
              return [...prev, userWithOrigin];
            });
          } else if (ev.type === 'access-resolved') {
            setAccessUsers((prev) =>
              prev.map((u) => (u.id === ev.id ? { ...u, status: ev.status, updatedAt: Date.now() } : u)),
            );
          }
        } catch {}
      };
      sources.push(src);
    });

    return () => {
      sources.forEach((s) => s.close());
    };
  }, [cfg?.isAdmin, getActiveOrigins]);

  // Collab Mode: yêu cầu duyệt lệnh hủy hoại do CTV phát lên, admin (localhost) duyệt.
  const [collabApprovals, setCollabApprovals] = useState<
    {
      id: string;
      sessionId: string;
      clientIp: string;
      toolName: string;
      input: Record<string, unknown>;
      title?: string;
      description?: string;
      decisionReason?: string;
      createdAt: string;
      apiOrigin?: string;
    }[]
  >([]);
  const [activeClientsOpen, setActiveClientsOpen] = useState(false);
  const [activeClients, setActiveClients] = useState<{ ip: string; device: string; lastSeen: string }[]>([]);
  const [loadingActiveClients, setLoadingActiveClients] = useState(false);
  const [activeTab, setActiveTab] = useState<'clients' | 'logs'>('clients');
  const [auditLogs, setAuditLogs] = useState<string[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  // URL vừa được copy (để hiện "ĐÃ COPY!"); null = chưa copy gì.
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  // Dropdown danh sách host LAN đang mở hay không.
  const [lanMenuOpen, setLanMenuOpen] = useState(false);
  // Dropdown nguồn mã của các mode đang mở hay không.
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);


  // Tất cả host LAN của máy. Ưu tiên lanUrls (nhiều host); fallback lanUrl (bản cũ).
  const lanUrls = cfg?.lanUrls?.length ? cfg.lanUrls : cfg?.lanUrl ? [cfg.lanUrl] : [];

  const copyLanUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl((c) => (c === url ? null : c)), 2000);
  };

  const fetchActiveClients = () => {
    setLoadingActiveClients(true);
    apiFetch('/api/active-clients')
      .then((r) => r.json())
      .then((data) => {
        setActiveClients(data.clients || []);
        setLoadingActiveClients(false);
      })
      .catch(() => {
        setLoadingActiveClients(false);
      });
  };

  const fetchAuditLogs = () => {
    setLoadingLogs(true);
    apiFetch('/api/audit-logs')
      .then((r) => r.json())
      .then((data) => {
        setAuditLogs(data.logs || []);
        setLoadingLogs(false);
      })
      .catch(() => {
        setLoadingLogs(false);
      });
  };

  const openActiveClientsPanel = () => {
    fetchActiveClients();
    fetchAuditLogs();
    setActiveTab('clients');
    setActiveClientsOpen(true);
  };

  const [detected, setDetected] = useState<DetectedSource | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    // Lần đầu: 'brutal' (Neo Brutalism) — khớp landing page. Sau đó ưu tiên lựa chọn user đã lưu.
    const saved = localStorage.getItem('bow-theme') as Theme | null;
    if (saved && THEME_CYCLE.includes(saved)) return saved;
    return 'brutal';
  });
  // Màu nhấn (accent) — độc lập với sáng/tối. 'brass' = mặc định (không đặt data-accent).
  const [accent, setAccent] = useState<Accent>(() => {
    const saved = localStorage.getItem('bow-accent');
    return ACCENTS.some((a) => a.id === saved) ? (saved as Accent) : 'brass';
  });

  // Đồng hồ UTC sống ở header (chi tiết "bảng điều khiển đài quan sát").
  const [utc, setUtc] = useState('');
  useEffect(() => {
    const tick = () => setUtc(new Date().toISOString().slice(11, 19));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // (Tick autoResume + dọn clientResume + đồng hồ phiên + scroll/activeQuery/eventSource/
  //  sessionBaseline + startTaskResize/applyQuickPrompt đã dời sang TaskPane.)

  // ── Kéo giãn ô nhập (INPUT CHANNEL) — GIỮ GLOBAL ──
  // Chiều cao ô nhập task (px) người dùng tự kéo (key 'bow-task-height' là GLOBAL, không
  // hậu tố tab). App giữ state, truyền value + setTaskHeight xuống TaskPane cho composer.
  const [taskHeight, setTaskHeight] = useState<number | null>(() => {
    const saved = Number(localStorage.getItem('bow-task-height'));
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  });
  useEffect(() => {
    if (taskHeight == null) localStorage.removeItem('bow-task-height');
    else localStorage.setItem('bow-task-height', String(taskHeight));
  }, [taskHeight]);

  // Áp theme lên <html data-theme> và nhớ vào localStorage. 'brutal' cũng set tường minh để
  // đồng bộ với block CSS [data-theme='brutal'] (dù :root đã là brutal — set cho chắc & rõ ý).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('bow-theme', theme);
  }, [theme]);

  // Áp màu nhấn lên <html data-accent> và nhớ. 'brass' = mặc định → gỡ attribute
  // để :root chi phối (không cần block CSS riêng cho brass).
  useEffect(() => {
    if (accent === 'brass') document.documentElement.removeAttribute('data-accent');
    else document.documentElement.setAttribute('data-accent', accent);
    localStorage.setItem('bow-accent', accent);
  }, [accent]);

  // (Migrate-1-lần đã dời sang TaskPane.)

  // Nạp cấu hình backend.
  useEffect(() => {
    apiFetch('/api/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        // LAN chưa được duyệt → /api/config trả 401; c=null. Bỏ qua để cổng
        // truy cập tự hiện (đừng setCfg bằng body lỗi → tránh setCwd(undefined)).
        if (!c) return;
        setCfg(c);
        if (c.otherModes) {
          setOtherModes(c.otherModes);
        }
        // Mode chia sẻ (QC/Collab/BA/Reviewer/DevOps) ép cwd cố định theo server —
        // luôn ghi đè. Dev mode để người dùng tự chọn: chỉ dùng defaultCwd làm fallback
        // lần đầu (localStorage rỗng), KHÔNG ghi đè lựa chọn đã nhớ mỗi lần reload.
        const sharedMode =
          c.isQcMode || c.isCollabMode || c.isBaMode || c.isReviewerMode || c.isDevOpsMode;
        if (c.defaultCwd && (sharedMode || !localStorage.getItem('bow-cwd'))) {
          setCwd(c.defaultCwd);
        }
        // QC Mode chỉ hỏi đáp read-only → LUÔN dùng Sonnet (nhẹ/rẻ), bất kể
        // localStorage. Backend cũng ép Sonnet ở mode này nên UI phải khớp để không
        // hiển thị Opus mà thực chất chạy Sonnet.
        if (c.isQcMode) {
          setSelectedModel('claude-sonnet-5');
        }
        if (c.mcpServers) {
          const saved = localStorage.getItem('bow-selectedMcps');
          if (!saved) {
            setSelectedMcps(c.mcpServers);
          }
        }
      })
      .catch(() => {});
    // Nạp hạn mức gói ngay khi mở trang (trước khi chạy task nào).
    refreshUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Collab/DevOps Mode + admin (localhost): mở kênh SSE riêng nhận yêu cầu duyệt lệnh hủy hoại
  // (Collab) / deploy-apply (DevOps) từ CTV. Kênh toàn cục /api/admin/events (trên MỌI cổng đang
  // hoạt động — gồm 4002 Collab và 4005 DevOps nhờ getActiveOrigins), nên admin nhận chung một chỗ.
  useEffect(() => {
    if (!cfg?.isAdmin) return;
    const origins = getActiveOrigins();
    const sources: EventSource[] = [];

    origins.forEach((origin) => {
      const src = new EventSource(`${origin}/api/admin/events`);
      src.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data);
          if (ev.type === 'admin-approval-request' && ev.request) {
            setCollabApprovals((prev) => {
              const reqWithOrigin = { ...ev.request, apiOrigin: origin };
              return prev.some((a) => a.id === ev.request.id) ? prev : [...prev, reqWithOrigin];
            });
          } else if (ev.type === 'admin-approval-resolved') {
            setCollabApprovals((prev) => prev.filter((a) => a.id !== ev.id));
          }
        } catch {
          /* bỏ qua dòng ping/keep-alive */
        }
      };
      sources.push(src);
    });

    return () => {
      sources.forEach((s) => s.close());
    };
  }, [cfg?.isAdmin, getActiveOrigins]);

  // (Reconnect-on-mount phiên cũ + lịch tự-chạy-tiếp đã dời sang TaskPane.)

  // Auto-nhận diện source + workspace mỗi khi cwd đổi (debounce nhẹ, dùng chung).
  useEffect(() => {
    if (!cwd.trim()) { setDetected(null); setCurrentWs(null); return; }
    const t = setTimeout(() => {
      apiFetch(`/api/detect?cwd=${encodeURIComponent(cwd.trim())}`)
        .then((r) => r.json())
        .then((d: DetectedSource) => {
          setDetected(d);
        })
        .catch(() => setDetected(null));
      refreshCurrentWs(cwd);
    }, 400);
    return () => clearTimeout(t);
  }, [cwd]);


  // Admin duyệt/từ chối một yêu cầu Collab (lệnh hủy hoại của CTV). Gỡ lạc quan khỏi UI
  // rồi POST /api/admin/approve — server giải Promise treo bên phiên CTV.
  async function decideCollab(id: string, approved: boolean, apiOrigin?: string) {
    setCollabApprovals((prev) => prev.filter((a) => a.id !== id));
    const origin = apiOrigin || '';
    await fetch(`${origin}/api/admin/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, approved }),
    }).catch(() => {});
  }


  // QC Mode (QC hỏi đáp read-only + Skill + Jira): ẩn bớt các nút/điều khiển kỹ thuật, khoá repo.
  // Bật bằng cách chạy `npm run ui:qc` (đặt BOW_QC_MODE=true ở backend).
  const qc = cfg ? !!cfg.isQcMode : true;
  const reviewer = cfg ? !!cfg.isReviewerMode : false;
  const collab = cfg ? !!cfg.isCollabMode : false;
  const ba = cfg ? !!cfg.isBaMode : false;
  const devops = cfg ? !!cfg.isDevOpsMode : false;
  const pendingAccessCount = accessUsers.filter((u) => u.status === 'pending').length;
  // Tên repo hiển thị ở badge "Source" trên header:
  // - QC Mode: repo bị khoá vào cfg (qcCwd) → dùng repoName/defaultCwd từ backend.
  // - Thường: repo là cwd người dùng đang chọn ở composer (thứ lượt chạy sẽ dùng) →
  //   lấy tên thư mục từ chính cwd, để QC/mọi người luôn biết đang hỏi source nào.
  const cwdRepoLabel = cwd?.trim() ? cwd.trim().split('/').filter(Boolean).pop() : '';
  const localQcRepoLabel = cfg?.repoName || (cfg?.defaultCwd ? cfg.defaultCwd.split('/').filter(Boolean).pop() : '') || 'monorepo';
  // QC và Reviewer đều là read-only-share: ẩn UI kỹ thuật + khoá repo giống nhau. Gộp vào 1 cờ.
  const readonlyShare = qc || reviewer;
  const repoLabel = readonlyShare ? localQcRepoLabel : (cwdRepoLabel || '(chưa chọn)');

  // Lúc mở/reload web, trong khi chờ /api/access/status trả về (gateState==='checking'),
  // hiện màn LOADING mượt thay vì nhảy thẳng cái card "Yêu cầu truy cập" 🔒 — với admin/
  // localhost (đa số) nó chỉ thoáng qua nên không được giật/nhấp nháy khó chịu.
  if (gateState === 'checking') {
    return (
      <div className="app-splash" role="status" aria-label="Đang tải">
        <div className="app-splash-orb">
          <span className="app-splash-spinner" />
          <span className="app-splash-emoji">🏹</span>
        </div>
        <div className="app-splash-title">bow</div>
        <div className="app-splash-hint">Đang khởi động…</div>
      </div>
    );
  }

  // Cổng duyệt truy cập theo tên: chưa được vào thì chặn toàn bộ app bằng màn khoá.
  if (gateState !== 'open') {
    return (
      <div className="access-gate">
        <div className="access-gate-card">
          <div className="access-gate-icon">
            {gateState === 'pending' ? '⏳' : gateState === 'rejected' ? '🚫' : '🔒'}
          </div>
          <h1>
            {gateState === 'pending'
              ? 'Đang chờ duyệt'
              : gateState === 'rejected'
                ? 'Bị từ chối'
                : 'Yêu cầu truy cập'}
          </h1>
          {gateState === 'pending' && (
            <p className="access-gate-hint" style={{ color: 'var(--brass)' }}>
              Yêu cầu của bạn đã gửi đi. Vui lòng đợi Admin phê duyệt để tiếp tục...
            </p>
          )}
          {gateState === 'rejected' && (
            <>
              <p className="access-gate-hint" style={{ color: 'var(--red)' }}>
                Yêu cầu truy cập của bạn đã bị Admin từ chối hoặc thu hồi.
              </p>
              <button
                className="btn deny"
                style={{ width: '100%', marginTop: '12px', padding: '8px' }}
                onClick={() => {
                  setGateState('locked');
                  setCodeError('');
                }}
              >
                Gửi lại yêu cầu
              </button>
            </>
          )}
          {gateState === 'locked' && (
            <>
              <p className="access-gate-hint">Nhập tên của bạn để gửi yêu cầu truy cập đến Admin.</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submitAccessName();
                }}
              >
                <input
                  type="text"
                  className="access-gate-input"
                  placeholder="Họ và tên của bạn"
                  value={nameInput}
                  autoFocus
                  onChange={(e) => {
                    setNameInput(e.target.value);
                    if (codeError) setCodeError('');
                  }}
                />
                {codeError && <div className="access-gate-error">{codeError}</div>}
                <button type="submit" className="access-gate-btn" disabled={codeBusy || !nameInput.trim()}>
                  {codeBusy ? 'Đang gửi…' : 'Gửi yêu cầu'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`app${qc ? ' qc-mode' : ''}${reviewer ? ' reviewer-mode' : ''}${collab ? ' collab-mode' : ''}${ba ? ' ba-mode' : ''}${devops ? ' devops-mode' : ''}`}>
      {collab && (
        <div className="collab-banner" role="status">
          🤝 <strong>Collab Mode</strong> — bạn code như dev; lệnh hủy hoại (xoá, deploy, ghi ngoài repo)
          {cfg?.isAdmin ? ' bạn tự duyệt.' : ' cần admin duyệt từ xa. Git tự do.'}
        </div>
      )}
      {ba && (
        <div className="ba-banner" role="status">
          📋 <strong>BA Mode</strong> — bạn ĐỌC repo, ghi TÀI LIỆU (docs/, *.md) và tạo/sửa Jira ticket.
          Không sửa source code, không đổi DB/hạ tầng.
        </div>
      )}
      {reviewer && (
        <div className="reviewer-banner" role="status">
          🔍 <strong>Reviewer Mode</strong> — bạn ĐỌC code, review PR (git/gh diff) và comment/approve
          qua <code>gh pr</code>. Không sửa code, không merge/push.
        </div>
      )}
      {devops && (
        <div className="devops-banner" role="status">
          🛠️ <strong>DevOps Mode</strong> — bạn ĐỌC repo, ghi FILE HẠ TẦNG (Dockerfile, compose, workflows,
          *.tf, k8s/Helm) và tài liệu vận hành. Không sửa source ứng dụng; lệnh deploy/apply
          {cfg?.isAdmin ? ' bạn tự duyệt.' : ' cần admin duyệt từ xa.'}
        </div>
      )}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="16" r="10.5" stroke="currentColor" strokeWidth="1.6" />
              <path d="M16 3.5v25M3.5 16h25" stroke="currentColor" strokeWidth="1" />
              <circle cx="16" cy="16" r="2.6" fill="currentColor" />
            </svg>
          </span>
          <span className="brand-name">BOW</span>
          <span className="brand-tag">Observatory</span>
        </div>
        <div className="obs-readouts">
          {cfg?.isAdmin ? (
            <div className="lan-url-wrap">
              <button
                className="readout readout-btn"
                title={language === 'vi' ? 'Nguồn mã của các chế độ chạy. Bấm để xem chi tiết / đổi.' : 'Source directories of execution modes. Click to view or change.'}
                onClick={() => setSourceMenuOpen((o) => !o)}
              >
                <span className="rl">{language === 'vi' ? 'Nguồn' : 'Source'}</span>
                <span className="rv" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {(() => {
                    const activeMode = cfg?.isQcMode
                      ? { label: 'QC', repo: qcRepoLabel }
                      : cfg?.isReviewerMode
                        ? { label: 'Review', repo: reviewerRepoLabel }
                        : cfg?.isCollabMode
                          ? { label: 'Collab', repo: collabRepoLabel }
                          : cfg?.isBaMode
                            ? { label: 'BA', repo: baRepoLabel }
                            : cfg?.isDevOpsMode
                              ? { label: 'DevOps', repo: devopsRepoLabel }
                              : { label: 'Dev', repo: devRepoLabel };
                    return `${activeMode.label}: ${activeMode.repo || '...'}`;
                  })()}
                  <span className="lan-url-caret">{sourceMenuOpen ? '▴' : '▾'}</span>
                </span>
              </button>
              {sourceMenuOpen && (
                <>
                  <div className="lan-url-backdrop" onClick={() => setSourceMenuOpen(false)} />
                  <div className="lan-url-menu" role="menu" style={{ right: 'auto', left: 0, minWidth: '260px' }}>
                    <div className="lan-url-menu-head">
                      {language === 'vi' ? 'Nguồn mã theo chế độ' : 'Sources by Mode'}
                    </div>
                    {[
                      { id: 'dev-cwd', modeLabel: 'Dev Mode', label: devRepoLabel, path: devCwd, color: 'var(--brass)' },
                      { id: 'qc-cwd', modeLabel: 'QC Mode', label: qcRepoLabel, path: qcCwd, color: 'var(--teal)' },
                      { id: 'collab-cwd', modeLabel: 'Collab Mode', label: collabRepoLabel, path: collabCwd, color: 'var(--red)' },
                      { id: 'ba-cwd', modeLabel: 'BA Mode', label: baRepoLabel, path: baCwd, color: 'var(--gold, #c9a227)' },
                      { id: 'reviewer-cwd', modeLabel: 'Reviewer Mode', label: reviewerRepoLabel, path: reviewerCwd, color: 'var(--violet, #8b5cf6)' },
                      { id: 'devops-cwd', modeLabel: 'DevOps Mode', label: devopsRepoLabel, path: devopsCwd, color: 'var(--devops, #10b981)' },
                    ].map((item) => (
                      <div
                        key={item.id}
                        className="lan-url-item"
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '6px 8px',
                          gap: '12px',
                          borderBottom: '1px solid var(--hairline-2)',
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, textAlign: 'left' }}>
                          <span style={{ fontSize: '10px', fontWeight: 'bold', color: item.color }}>{item.modeLabel}</span>
                          <span
                            title={item.path}
                            style={{
                              fontSize: '11px',
                              fontFamily: 'var(--mono)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              maxWidth: '160px',
                              color: 'var(--ink)',
                            }}
                          >
                            {item.label || '...'}
                          </span>
                        </div>
                        <button
                          className="btn-tiny"
                          style={{
                            padding: '2px 6px',
                            fontSize: '9px',
                            fontFamily: 'var(--mono)',
                            border: '1px solid var(--hairline)',
                            borderRadius: '2px',
                            background: 'var(--surface-2)',
                            cursor: 'pointer',
                            color: 'var(--ink)',
                          }}
                          onClick={() => {
                            setSourceMenuOpen(false);
                            openPicker(item.path || '', item.id as any);
                          }}
                        >
                          {language === 'vi' ? 'Đổi' : 'Change'}
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            (readonlyShare || collab || devops) && (
              <span className="readout" title={language === 'vi' ? `Đang thao tác nguồn: ${repoLabel}` : `Working on source: ${repoLabel}`}>
                <span className="rl">{language === 'vi' ? 'Nguồn' : 'Source'}</span>
                <span className="rv rv-source" style={{ color: 'var(--brass)' }}>{repoLabel}</span>
              </span>
            )
          )}
          <span className="readout" title={language === 'vi' ? "Giờ UTC" : "UTC Time"}>
            <span className="rl">UTC</span>
            <span className="rv">{utc}</span>
          </span>
          {/* Đồng hồ phiên: đang chạy → tick mỗi giây (nhờ interval UTC); xong → đứng ở
              tổng thời lượng lượt gần nhất. Ẩn khi chưa chạy lượt nào. */}
          {(paneRunning && paneRunStartedAt != null) || paneLastRunMs != null ? (
            <span
              className="readout"
              title={
                paneRunning
                  ? (language === 'vi' ? 'Thời gian lượt chạy hiện tại (tính cả lúc chờ duyệt)' : 'Current run duration (including pending approval time)')
                  : (language === 'vi' ? 'Thời lượng lượt chạy gần nhất' : 'Last run duration')
              }
            >
              <span className="rl">{language === 'vi' ? 'Thời gian' : 'Time'}</span>
              <span className="rv" style={{ color: paneRunning ? 'var(--brass)' : undefined }}>
                {paneRunning && paneRunStartedAt != null
                  ? fmtDuration(Date.now() - paneRunStartedAt)
                  : fmtDuration(paneLastRunMs!)}
              </span>
            </span>
          ) : null}
          {!readonlyShare && (
            <span className="readout" title={language === 'vi' ? "Chi phí tích lũy phiên này" : "Accumulated session cost"}>
              <span className="rl">{language === 'vi' ? 'Chi phí' : 'Cost'}</span>
              <span className="rv" style={{ color: accumulatedCost > 2 ? 'var(--danger)' : undefined }}>
                ${accumulatedCost.toFixed(4)}
              </span>
            </span>
          )}
          {!readonlyShare && (
            <span className="readout" title={modeDef(mode, language).desc}>
              <span className="rl">{language === 'vi' ? 'Chế độ' : 'Mode'}</span>
              <span className={`rv mode-${mode}`}>
                {modeDef(mode, language).short}
              </span>
            </span>
          )}
          {lanUrls.length > 0 && (
            <div className="lan-url-wrap">
              <button
                className="readout readout-btn"
                title={
                  lanUrls.length > 1
                    ? `Máy có ${lanUrls.length} địa chỉ LAN. Bấm để chọn/copy đúng địa chỉ máy khách dùng.`
                    : 'Địa chỉ mạng LAN của trang này. Bấm để copy.'
                }
                onClick={() => {
                  // 1 host → copy luôn. Nhiều host → mở menu cho chọn.
                  if (lanUrls.length === 1) copyLanUrl(lanUrls[0]);
                  else setLanMenuOpen((o) => !o);
                }}
              >
                <span className="rl">LAN</span>
                <span
                  className="rv"
                  style={{
                    color: copiedUrl && lanUrls.includes(copiedUrl) ? 'var(--teal)' : 'var(--brass)',
                    textDecoration:
                      copiedUrl && lanUrls.includes(copiedUrl) ? 'none' : lanUrls.length > 1 ? 'none' : 'underline',
                  }}
                >
                  {/* Nhiều host: chỉ hiện số host (địa chỉ đầy đủ nằm trong dropdown) → gọn header. */}
                  {copiedUrl && lanUrls.includes(copiedUrl)
                    ? 'ĐÃ COPY!'
                    : lanUrls.length > 1
                    ? `${lanUrls.length} host`
                    : lanUrls[0].replace(/^https?:\/\//, '')}
                  {lanUrls.length > 1 && <span className="lan-url-caret">{lanMenuOpen ? '▴' : '▾'}</span>}
                </span>
              </button>
              {lanMenuOpen && lanUrls.length > 1 && (
                <>
                  {/* Backdrop trong suốt: bấm ra ngoài để đóng menu. */}
                  <div className="lan-url-backdrop" onClick={() => setLanMenuOpen(false)} />
                  <div className="lan-url-menu" role="menu">
                    <div className="lan-url-menu-head">
                      Máy có nhiều địa chỉ mạng — chọn địa chỉ khớp mạng của máy khách
                    </div>
                    {lanUrls.map((url) => {
                      const isCopied = copiedUrl === url;
                      return (
                        <button
                          key={url}
                          className="lan-url-item"
                          onClick={() => copyLanUrl(url)}
                          title="Bấm để copy"
                        >
                          <span className="lan-url-item-addr">{url.replace(/^https?:\/\//, '')}</span>
                          <span className={`lan-url-item-copy${isCopied ? ' copied' : ''}`}>
                            {isCopied ? 'ĐÃ COPY!' : 'Copy'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
          {/* Hạn mức phiên 5 giờ (Session) — gọn trên header. Bấm để mở panel usage đầy đủ. */}
          {!readonlyShare && (() => {
            const s = usage?.rateLimits.find((w) => /session|5\s*h|5hr/i.test(w.label));
            const pct = s && s.utilization != null ? Math.round(s.utilization) : null;
            return (
              <button
                className="readout readout-btn"
                title={
                  s
                    ? `Hạn mức phiên (5hr) — ${formatResetIn(s.resetsAt)}. Bấm để xem tất cả hạn mức.`
                    : 'Hạn mức sử dụng. Bấm để xem tất cả.'
                }
                onClick={() => { setUsagePanelOpen(true); refreshUsage(); }}
                disabled={usageLoading}
              >
                <span className="rl">Session</span>
                <span
                  className="rv"
                  style={{ color: pct != null && pct >= 80 ? 'var(--danger)' : undefined }}
                >
                  {usageLoading ? '…' : pct != null ? `${pct}%` : '—'}
                </span>
              </button>
            );
          })()}
          {/* Context window — dung lượng token đã dùng / tối đa (vd 22.0k / 1M) của
              hội thoại hiện tại, kèm % trong tooltip. */}
          {!readonlyShare && (() => {
            const has = usage?.contextTokens != null && !!usage.contextMaxTokens;
            const pct = has && usage!.contextPercentage != null ? Math.round(usage!.contextPercentage) : null;
            const used = has ? formatTokens(usage!.contextTokens!) : null;
            const max = has ? formatTokens(usage!.contextMaxTokens!) : null;
            return (
              <span
                className="readout"
                title={
                  has
                    ? `Context window — đã dùng ${used} / ${max} token (${pct}%).`
                    : 'Context window — chạy một task để đo.'
                }
              >
                <span className="rl">{language === 'vi' ? 'Ngữ cảnh' : 'Context'}</span>
                <span
                  className="rv"
                  style={{ color: pct != null && pct >= 80 ? 'var(--danger)' : undefined }}
                >
                  {has ? `${used} / ${max}` : '—'}
                </span>
              </span>
            );
          })()}
        </div>
        <div className="topbar-right">
          <div className="lang-select" title={language === 'vi' ? "Ngôn ngữ trả lời của agent" : "Agent response language"}>
            <PixelSelect
              value={language}
              onChange={(val) => setLanguage(val as 'vi' | 'en')}
              direction="down"
              options={[
                { value: 'vi', label: 'Tiếng Việt' },
                { value: 'en', label: 'English' },
              ]}
            />
          </div>
          <button
            className="theme-btn"
            title={language === 'vi' ? "Lịch sử — các cuộc trò chuyện đã lưu (mở lại, đổi tên, xóa)" : "History — saved chats (reopen, rename, delete)"}
            onClick={openHistPanel}
          >
            <Icon name="history" size={18} />
          </button>
          <button
            className="theme-btn"
            title={language === 'vi' ? "Chat nhóm — nhắn tin với đồng nghiệp cùng mạng (vào phòng theo mã, đặt biệt danh)" : "Group chat — message LAN colleagues (join room, nickname)"}
            onClick={openChatPanel}
          >
            <Icon name="chat" size={18} />
          </button>
          {/* Admin: MCP CHUNG (mọi mode trừ QC read-only). User LAN đã duyệt: MCP RIÊNG
              của họ — hiện KỂ CẢ QC/Collab, vì chỉ ảnh hưởng chính họ, không đụng chung. */}
          {((cfg?.isAdmin && !readonlyShare) || (!cfg?.isAdmin && gateState === 'open')) && (
            <button
              className="theme-btn"
              title={cfg?.isAdmin ? (language === 'vi' ? 'Quản lý MCP server chung (Jira/Supabase/... cho agent)' : 'Manage shared MCP servers (Jira/Supabase/...)') : (language === 'vi' ? 'MCP riêng của bạn (ghi đè MCP trùng tên do admin cấu hình)' : 'Your private MCP servers (overrides admin config)')}
              onClick={openMcpPanel}
            >
              <Icon name="mcp" size={18} />
            </button>
          )}
          {!readonlyShare && (
            <button
              className="theme-btn"
              title={language === 'vi' ? "Workspace — nhóm nhiều repo (BE/FE/...) thành 1 sản phẩm + trí nhớ chung" : "Workspace — group multiple repos (BE/FE/...) and shared memory"}
              onClick={openWsPanel}
            >
              <Icon name="routing" size={18} />
            </button>
          )}

          {cfg?.isAdmin && (
            <button
              className={`theme-btn${pendingAccessCount > 0 ? ' has-pending' : ''}`}
              title={language === 'vi' ? `LAN Dashboard — Quản lý thiết bị & xem log hoạt động${pendingAccessCount > 0 ? ` (${pendingAccessCount} yêu cầu đang chờ)` : ''}` : `LAN Dashboard — Manage devices & view activity logs${pendingAccessCount > 0 ? ` (${pendingAccessCount} pending requests)` : ''}`}
              onClick={openActiveClientsPanel}
              style={{ position: 'relative' }}
            >
              <Icon name="users" size={18} />
              {pendingAccessCount > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: '-2px',
                    right: '-2px',
                    background: 'var(--danger)',
                    color: 'white',
                    borderRadius: '50%',
                    width: '14px',
                    height: '14px',
                    fontSize: '9px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 'bold',
                    boxShadow: '0 0 4px var(--danger)',
                  }}
                >
                  {pendingAccessCount}
                </span>
              )}
            </button>
          )}
          {/* Accent chỉ áp cho Neo Brutalism — Newsprint dùng cực ít màu (đỏ editorial) nên ẩn picker. */}
          {theme !== 'newsprint' && (
            <AccentPicker value={accent} options={ACCENTS} onChange={(id) => setAccent(id as Accent)} />
          )}
          <button
            className="theme-btn"
            title={language === 'vi' ? (theme === 'brutal' ? 'Chuyển sang phong cách Newsprint (báo giấy editorial)' : 'Chuyển sang phong cách Neo Brutalism (kem)') : (theme === 'brutal' ? 'Switch to Newsprint theme' : 'Switch to Neo Brutalism theme')}
            onClick={() => setTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length])}
          >
            {/* Icon = đích của lần bấm kế tiếp: brutal → hiện tờ báo (sẽ sang newsprint) & ngược lại. */}
            <Icon name={theme === 'brutal' ? 'newsprint' : 'brutal'} size={18} />
          </button>
        </div>
      </header>

      {/* Thanh tab: nhiều tác vụ/hội thoại chạy SONG SONG. Mỗi tab một <TaskPane> (SSE +
          session riêng); tab nền vẫn chạy thật (ẩn bằng CSS, không unmount). Chỉ hiện khi
          có >1 tab hoặc admin — ở mode chia sẻ (QC/BA/…) giữ 1 tab cho gọn. */}
      {(!readonlyShare || tabs.length > 1) && (
        <div className="tab-bar" role="tablist" aria-label={language === 'vi' ? 'Các tác vụ đang mở' : 'Open tasks'}>
          {tabs.map((t, i) => {
            const st = paneStates[t.id];
            const title = (t.title || st?.title || '').trim() || `${language === 'vi' ? 'Tác vụ' : 'Task'} ${i + 1}`;
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={t.id === activeTabId}
                className={`tab-bar-item${t.id === activeTabId ? ' active' : ''}`}
                onClick={() => setActiveTabId(t.id)}
                title={title}
              >
                <span className={`tab-bar-dot${st?.running ? ' live' : ''}`} aria-hidden="true" />
                <span className="tab-bar-title">{title}</span>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    className="tab-bar-close"
                    title={language === 'vi' ? 'Đóng tác vụ (dừng agent nếu đang chạy)' : 'Close task (stops agent if running)'}
                    onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                  >
                    <Icon name="close" size={13} />
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="tab-bar-add"
            onClick={newTab}
            title={language === 'vi' ? 'Tác vụ mới (tab)' : 'New task (tab)'}
            aria-label={language === 'vi' ? 'Mở tác vụ mới' : 'Open new task'}
          >
            <Icon name="newChat" size={15} />
          </button>
        </div>
      )}

      {/* Mỗi tab = 1 instance TaskPane (SSE/session riêng). visible điều khiển hidden —
          tab nền vẫn mounted nên vẫn chạy. TaskPane render .main-layout + docks + composer;
          collab dock (overlay ADMIN duyệt Collab) App render riêng bên dưới (kênh global). */}
      {tabs.map((t) => (
        <TaskPane
          key={t.id}
          ref={(h) => { if (h) paneRefs.current[t.id] = h; else delete paneRefs.current[t.id]; }}
          tabId={t.id}
          visible={t.id === activeTabId}
          cfg={cfg}
          mode={mode}
          profile={profile}
          selectedModel={selectedModel}
          effort={effort}
          useSubagents={useSubagents}
          language={language}
          selectedMcps={selectedMcps}
          stack={stack}
          cwd={cwd}
          theme={theme}
          accent={accent}
          detected={detected}
          currentWs={currentWs}
          skillStacks={skillStacks}
          skillStatus={skillStatus}
          skillSyncing={skillSyncing}
          skillSyncMsg={skillSyncMsg}
          readonlyShare={readonlyShare}
          qc={qc}
          reviewer={reviewer}
          collab={collab}
          ba={ba}
          devops={devops}
          taskHeight={taskHeight}
          usage={usage}
          setCfg={setCfg}
          setSelectedMcps={setSelectedMcps}
          setAuthModal={setAuthModal}
          setUsage={setUsage}
          setAccumulatedCost={setAccumulatedCost}
          openPicker={openPicker}
          openWsPanel={openWsPanel}
          refreshCurrentWs={refreshCurrentWs}
          changeActiveCwd={changeActiveCwd}
          showClaudePrompt={showClaudePrompt}
          showClaudeAlert={showClaudeAlert}
          syncSkillsNow={syncSkillsNow}
          setTaskHeight={setTaskHeight}
          setMode={setMode}
          setProfile={setProfile}
          setSelectedModel={setSelectedModel}
          setEffort={setEffort}
          setStack={setStack}
          setUseSubagents={setUseSubagents}
          onStateChange={(s) => reportPaneState(t.id, s)}
        />
      ))}
      {/* Panel ADMIN duyệt Collab: yêu cầu duyệt lệnh hủy hoại do CTV phát lên. Kênh
          riêng, độc lập với approval của chính admin. Chỉ hiện cho admin ở Collab Mode. */}
      {cfg?.isAdmin && collabApprovals.length > 0 && (
        <div className="chat-action-dock collab-approvals">
          {collabApprovals.map((a) => (
            <div key={a.id} className="approval collab-approval">
              <div className="approval-head">
                <Icon name="block" size={16} /> {a.title || `CTV xin duyệt: ${a.toolName}`}
              </div>
              <div className="approval-who">
                👤 Từ <strong>{a.clientIp}</strong> · phiên <code>{a.sessionId.slice(0, 8)}</code>
                {a.apiOrigin && (
                  <span style={{ marginLeft: '6px', color: 'var(--brass)', fontSize: '11px' }}>
                    ({a.apiOrigin.includes('4002') ? 'Collab' : a.apiOrigin.includes('4001') ? 'QC' : a.apiOrigin.includes('4003') ? 'BA' : a.apiOrigin.includes('4004') ? 'Review' : a.apiOrigin.includes('4005') ? 'DevOps' : 'Dev'})
                  </span>
                )}
              </div>
              {a.decisionReason && <div className="approval-reason">{a.decisionReason}</div>}
              {typeof a.input?.command === 'string' && (
                <pre className="approval-cmd">{a.input.command as string}</pre>
              )}
              {typeof a.input?.file_path === 'string' && (
                <div className="approval-path">📄 {a.input.file_path as string}</div>
              )}
              <div className="approval-actions">
                <button className="btn allow" onClick={() => decideCollab(a.id, true, a.apiOrigin)}>Cho phép</button>
                <button className="btn deny" onClick={() => decideCollab(a.id, false, a.apiOrigin)}>Từ chối</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {pickerOpen && (
        <div className="modal-overlay" onClick={() => setPickerOpen(false)}>
          <div className="modal-content pixel-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title"><Icon name="folder" size={16} /> {pickerTarget === 'qc-cwd' ? (language === 'vi' ? 'Chọn source để hỏi đáp' : 'Select source to verify') : (language === 'vi' ? 'Chọn thư mục làm việc' : 'Select working directory')}</span>
              <button className="close-btn" onClick={() => setPickerOpen(false)}><Icon name="close" size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="picker-path-input-row" style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                <input
                  type="text"
                  value={pickerPath}
                  onChange={(e) => setPickerPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') fetchDirs(pickerPath);
                  }}
                  placeholder={language === 'vi' ? "Đường dẫn thư mục..." : "Directory path..."}
                  style={{ flex: 1, padding: '8px', fontFamily: 'monospace' }}
                />
                <button className="btn" style={{ padding: '0 16px' }} onClick={() => fetchDirs(pickerPath)}>{language === 'vi' ? 'Đi' : 'Go'}</button>
              </div>

              {pickerError && <div className="picker-error" style={{ color: 'var(--red)', marginBottom: '10px' }}><Icon name="warning" size={14} /> {pickerError}</div>}

              <div className="dirs-list" style={{ maxHeight: '250px', overflowY: 'auto', border: 'var(--bd-thin) solid var(--outline)', padding: '6px', background: 'var(--inset)' }}>
                {pickerParent !== null && (
                  <div className="dir-item parent-dir" style={{ padding: '6px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }} onClick={() => fetchDirs(pickerParent)}>
                    <Icon name="folder" size={16} /> <span style={{ fontFamily: 'monospace' }}>[..] {language === 'vi' ? '(Thư mục cha)' : '(Parent directory)'}</span>
                  </div>
                )}
                {pickerDirs.map((dir) => (
                  <div
                    key={dir}
                    className="dir-item"
                    style={{ padding: '6px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
                    onClick={() => fetchDirs(pickerPath + (pickerPath.endsWith('/') || pickerPath.endsWith('\\') ? '' : pickerPath.includes('\\') ? '\\' : '/') + dir)}
                  >
                    <Icon name="folder" size={16} /> <span style={{ fontFamily: 'monospace' }}>{dir}</span>
                  </div>
                ))}
                {pickerDirs.length === 0 && <div className="no-subdirs" style={{ padding: '12px', textAlign: 'center', color: 'var(--muted)' }}>{language === 'vi' ? 'Không có thư mục con' : 'No subdirectories'}</div>}
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button className="btn deny" onClick={() => setPickerOpen(false)}>
                {language === 'vi' ? 'Hủy' : 'Cancel'}
              </button>
              <button
                className="btn allow"
                onClick={() => {
                  if (pickerTarget === 'cwd') {
                    changeActiveCwd(pickerPath);
                    setPickerOpen(false);
                  } else {
                    applyPortCwd(pickerTarget, pickerPath);
                  }
                }}
              >
                {language === 'vi' ? 'Chọn thư mục này' : 'Select this directory'}
              </button>
            </div>
          </div>
        </div>
      )}

      {mcpPanelOpen && (
        <div className="modal-overlay" onClick={() => setMcpPanelOpen(false)}>
          <div
            className="modal-content pixel-panel"
            style={{ maxWidth: '640px', width: '92%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span className="modal-title"><Icon name="mcp" size={16} /> {cfg?.isAdmin ? 'Quản lý MCP server chung' : 'MCP riêng của bạn'}</span>
              <button className="close-btn" onClick={() => setMcpPanelOpen(false)}><Icon name="close" size={16} /></button>
            </div>
            <div className="modal-body">
              {mcpError && (
                <div className="picker-error" style={{ color: 'var(--red)', marginBottom: '10px' }}><Icon name="warning" size={14} /> {mcpError}</div>
              )}

              {/* User LAN: nhắc rõ ranh giới overlay để không hiểu nhầm là sửa MCP chung. */}
              {!cfg?.isAdmin && (
                <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px', lineHeight: 1.5 }}>
                  MCP ở đây là <b>của riêng bạn</b> — tự bật cho mọi lần chạy của bạn và
                  <b> ghi đè</b> MCP trùng tên do admin cấu hình. Không ảnh hưởng người khác.
                </div>
              )}

              {/* Danh sách MCP hiện có (admin = chung; user = riêng) */}
              <div className="mcp-list-title" style={{ marginBottom: '8px' }}>
                {cfg?.isAdmin ? `ĐÃ CẤU HÌNH (${mcpList.length})` : `MCP CỦA BẠN (${myMcpList.length})`}
              </div>
              <div className="mcp-list" style={{ maxHeight: '180px', overflowY: 'auto', border: 'var(--bd-thin) solid var(--outline)', padding: '6px', background: 'var(--inset)', marginBottom: '16px' }}>
                {(cfg?.isAdmin ? mcpList : myMcpList).length === 0 && (
                  <div style={{ padding: '10px', textAlign: 'center', color: 'var(--muted)' }}>Chưa có MCP nào</div>
                )}
                {(cfg?.isAdmin ? mcpList : myMcpList).map((m) => (
                  <div key={m.name} className="mcp-row" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', padding: '6px 8px', borderBottom: 'var(--bd-thin) solid var(--outline)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {m.name} {!m.stdio && <span style={{ color: 'var(--muted)', fontSize: '12px' }}>(không phải stdio)</span>}
                      </div>
                      <div style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                        {m.command} {m.args.join(' ')}
                      </div>
                      {m.envKeys.length > 0 && (
                        <div style={{ fontSize: '11px', color: 'var(--muted)' }}>env: {m.envKeys.join(', ')}</div>
                      )}
                    </div>
                    <button
                      className="btn deny"
                      style={{ padding: '2px 10px', fontSize: '12px' }}
                      disabled={mcpBusy}
                      onClick={() => (cfg?.isAdmin ? deleteMcp(m.name) : deleteMyMcp(m.name))}
                      title={`Xóa MCP ${m.name}`}
                    >
                      Xóa
                    </button>
                  </div>
                ))}
              </div>

              {/* Form thêm mới */}
              <div className="mcp-list-title" style={{ marginBottom: '8px' }}>
                {cfg?.isAdmin ? 'THÊM MCP MỚI (stdio)' : 'THÊM MCP RIÊNG (stdio)'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <input
                  placeholder="Tên (vd: jira, my-server) — chỉ chữ/số/gạch"
                  value={mcpForm.name}
                  onChange={(e) => setMcpForm((f) => ({ ...f, name: e.target.value }))}
                  style={{ padding: '8px' }}
                />
                <input
                  placeholder="Command (vd: npx, /opt/homebrew/bin/npx)"
                  value={mcpForm.command}
                  onChange={(e) => setMcpForm((f) => ({ ...f, command: e.target.value }))}
                  style={{ padding: '8px', fontFamily: 'monospace' }}
                />
                <textarea
                  placeholder="Args — mỗi dòng hoặc cách nhau bởi khoảng trắng (vd: -y mcp-jira-stdio)"
                  value={mcpForm.args}
                  onChange={(e) => setMcpForm((f) => ({ ...f, args: e.target.value }))}
                  rows={2}
                  style={{ padding: '8px', fontFamily: 'monospace', resize: 'vertical' }}
                />
                <textarea
                  placeholder={'Env — mỗi dòng KEY=VALUE\nGiá trị $TEN_BIEN sẽ lấy từ env server (vd: API_TOKEN=$JIRA_TOKEN)'}
                  value={mcpForm.env}
                  onChange={(e) => setMcpForm((f) => ({ ...f, env: e.target.value }))}
                  rows={3}
                  style={{ padding: '8px', fontFamily: 'monospace', resize: 'vertical' }}
                />
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button className="btn deny" onClick={() => setMcpPanelOpen(false)}>
                Đóng
              </button>
              <button className="btn allow" disabled={mcpBusy} onClick={() => (cfg?.isAdmin ? submitMcp() : submitMyMcp())}>
                {mcpBusy ? 'Đang lưu…' : 'Thêm MCP'}
              </button>
            </div>
          </div>
        </div>
      )}

      {wsPanelOpen && (
        <div className="modal-overlay" onClick={() => setWsPanelOpen(false)}>
          <div
            className="modal-content pixel-panel"
            style={{ maxWidth: '720px', width: '94%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span className="modal-title"><Icon name="routing" size={16} /> Workspace — nhóm nhiều repo</span>
              <button className="close-btn" onClick={() => setWsPanelOpen(false)}><Icon name="close" size={16} /></button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                Gom BE / FE / infra (ở các thư mục khác nhau) thành MỘT sản phẩm. Trỏ agent vào một repo →
                nó biết bản đồ cả nhóm, đọc chéo được repo anh em (read-only) & nhớ các phiên trước.
              </div>
              {wsError && (
                <div className="picker-error" style={{ color: 'var(--red)', marginBottom: '10px' }}><Icon name="warning" size={14} /> {wsError}</div>
              )}

              {/* Danh sách workspace + repo */}
              <div className="mcp-list-title" style={{ marginBottom: '8px' }}>
                WORKSPACE ĐÃ CÓ ({wsList.length})
              </div>
              <div className="mcp-list" style={{ maxHeight: '220px', overflowY: 'auto', border: 'var(--bd-thin) solid var(--outline)', padding: '6px', background: 'var(--inset)', marginBottom: '16px' }}>
                {wsList.length === 0 && (
                  <div style={{ padding: '10px', textAlign: 'center', color: 'var(--muted)' }}>Chưa có workspace nào</div>
                )}
                {wsList.map((ws) => (
                  <div key={ws.slug} style={{ padding: '6px 8px', borderBottom: 'var(--bd-thin) solid var(--outline)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '4px' }}>
                      <div style={{ fontWeight: 700 }}>📦 {ws.slug} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: '12px' }}>({ws.repos.length} repo)</span></div>
                      <button
                        className="btn"
                        style={{ padding: '2px 10px', fontSize: '12px' }}
                        onClick={() => (wsViewSlug === ws.slug ? setWsViewSlug(null) : openWsKnowledge(ws.slug))}
                        title="Xem tri thức chung + nhật ký các phiên"
                      >
                        {wsViewSlug === ws.slug ? 'Ẩn tri thức' : 'Tri thức & nhật ký'}
                      </button>
                    </div>
                    {ws.repos.map((r) => (
                      <div key={r.path} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', paddingLeft: '12px' }}>
                        <div style={{ flex: 1, minWidth: 0, fontSize: '12px' }}>
                          <span style={{ fontWeight: 600 }}>{r.role}</span>
                          <span style={{ fontFamily: 'monospace', color: 'var(--muted)', overflowWrap: 'anywhere' }}> · {r.path}</span>
                        </div>
                        <button
                          className="btn deny"
                          style={{ padding: '1px 8px', fontSize: '11px' }}
                          disabled={wsBusy}
                          onClick={() => removeWsRepo(ws.slug, r.path)}
                          title={`Gỡ ${r.path} khỏi ${ws.slug}`}
                        >
                          Gỡ
                        </button>
                      </div>
                    ))}

                    {/* Khung xem/sửa tri thức của workspace này */}
                    {wsViewSlug === ws.slug && (
                      <div style={{ marginTop: '10px', paddingLeft: '12px', borderLeft: '2px solid var(--outline)' }}>
                        <div className="mcp-list-title" style={{ marginBottom: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span>TRI THỨC CHUNG (shared.md)</span>
                          <button className="btn allow" style={{ padding: '2px 10px', fontSize: '12px' }} disabled={wsBusy || !wsSharedDirty} onClick={saveWsShared}>
                            {wsBusy ? 'Đang lưu…' : wsSharedDirty ? 'Lưu' : 'Đã lưu'}
                          </button>
                        </div>
                        <textarea
                          placeholder={'Contract API BE↔FE, quyết định kiến trúc chung, quy ước cả sản phẩm…\nAgent đọc phần này ở MỌI repo trong workspace.'}
                          value={wsShared}
                          onChange={(e) => { setWsShared(e.target.value); setWsSharedDirty(true); }}
                          rows={5}
                          style={{ width: '100%', padding: '8px', fontFamily: 'monospace', fontSize: '12px', resize: 'vertical' }}
                        />
                        <div className="mcp-list-title" style={{ margin: '10px 0 6px' }}>
                          NHẬT KÝ CÁC PHIÊN (journal.md — tự động ghi)
                        </div>
                        <div style={{ maxHeight: '160px', overflowY: 'auto', padding: '8px', background: 'var(--inset)', border: 'var(--bd-thin) solid var(--outline)', fontSize: '12px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                          {wsJournal.trim() ? wsJournal : <span style={{ color: 'var(--muted)' }}>Chưa có nhật ký. Sau mỗi phiên thực thi trong workspace này, agent tự cô đọng & ghi vào đây.</span>}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Form gán repo vào workspace */}
              <div className="mcp-list-title" style={{ marginBottom: '8px' }}>
                GÁN REPO VÀO WORKSPACE
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <input
                  placeholder="Tên workspace (vd: app-giao-hang) — gõ tên đã có để thêm repo vào đó"
                  value={wsForm.name}
                  onChange={(e) => setWsForm((f) => ({ ...f, name: e.target.value }))}
                  style={{ padding: '8px' }}
                />
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    placeholder="Đường dẫn repo (path tuyệt đối)"
                    value={wsForm.path}
                    onChange={(e) => setWsForm((f) => ({ ...f, path: e.target.value }))}
                    style={{ padding: '8px', fontFamily: 'monospace', flex: 1 }}
                  />
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setWsForm((f) => ({ ...f, path: cwd.trim() }))}
                    title="Điền path = cwd hiện tại ở composer"
                    style={{ padding: '0 12px', whiteSpace: 'nowrap' }}
                  >
                    Dùng cwd
                  </button>
                </div>
                <input
                  placeholder="Vai trò (vd: BE, FE, infra) — mặc định 'repo'"
                  value={wsForm.role}
                  onChange={(e) => setWsForm((f) => ({ ...f, role: e.target.value }))}
                  style={{ padding: '8px' }}
                />
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button className="btn deny" onClick={() => setWsPanelOpen(false)}>
                Đóng
              </button>
              <button className="btn allow" disabled={wsBusy} onClick={submitWsRepo}>
                {wsBusy ? 'Đang lưu…' : 'Gán repo'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Panel usage đầy đủ: liệt kê MỌI cửa sổ hạn mức dạng thanh bar có % ── */}
      {usagePanelOpen && (
        <div className="modal-overlay" onClick={() => setUsagePanelOpen(false)}>
          <div
            className="modal-content pixel-panel"
            style={{ maxWidth: '460px', width: '92%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span className="modal-title"><Icon name="info" size={16} /> Hạn mức sử dụng</span>
              <button className="close-btn" onClick={() => setUsagePanelOpen(false)}><Icon name="close" size={16} /></button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                  {usage?.subscriptionType
                    ? `Gói: ${usage.subscriptionType.toUpperCase()}`
                    : 'Hạn mức gói claude.ai (dùng chung với Claude Code).'}
                </span>
                <button
                  className="readout readout-btn"
                  style={{ border: 'var(--bd-thin) solid var(--outline)', height: 'auto', padding: '4px 10px' }}
                  onClick={refreshUsage}
                  disabled={usageLoading}
                  title="Làm mới hạn mức"
                >
                  <span className="rl">{usageLoading ? 'Đang tải…' : 'Làm mới'}</span>
                </button>
              </div>

              {(() => {
                const windows = usage?.rateLimits ?? [];
                if (windows.length === 0) {
                  return (
                    <div style={{ padding: '18px', textAlign: 'center', color: 'var(--muted)', fontSize: '12px' }}>
                      {usageLoading
                        ? 'Đang đọc hạn mức…'
                        : 'Chưa có dữ liệu hạn mức. Thường do dùng API key/Bedrock/Vertex (không áp hạn mức gói) hoặc chưa đăng nhập Claude.'}
                    </div>
                  );
                }
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    {windows.map((w) => {
                      const pct = w.utilization != null ? Math.round(w.utilization) : null;
                      const danger = pct != null && pct >= 80;
                      const warn = pct != null && pct >= 50 && pct < 80;
                      const resetIn = formatResetIn(w.resetsAt);
                      const barColor = danger ? 'var(--danger)' : warn ? 'var(--brass)' : 'var(--teal)';
                      return (
                        <div key={w.label}>
                          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '5px' }}>
                            <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--ink)' }}>{w.label}</span>
                            <span
                              className="rv"
                              style={{ fontSize: '12.5px', color: danger ? 'var(--danger)' : 'var(--ink)' }}
                            >
                              {pct != null ? `${pct}%` : '—'}
                            </span>
                          </div>
                          <div style={{ height: '8px', background: 'var(--inset)', border: 'var(--bd-thin) solid var(--outline)', overflow: 'hidden' }}>
                            <div style={{ width: `${pct ?? 0}%`, height: '100%', background: barColor, transition: 'width var(--med)' }} />
                          </div>
                          {resetIn && (
                            <div style={{ fontSize: '10.5px', color: 'var(--muted)', marginTop: '4px', fontFamily: 'var(--mono)' }}>
                              Reset {resetIn.toLowerCase()}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* Context window của hội thoại hiện tại (nếu đã đo trong lượt chạy). */}
              {usage?.contextTokens != null && !!usage.contextMaxTokens && (
                <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: 'var(--bd-thin) solid var(--outline)' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '5px' }}>
                    <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--ink)' }}>Context (hội thoại này)</span>
                    <span className="rv" style={{ fontSize: '12.5px' }}>
                      {formatTokens(usage.contextTokens)} / {formatTokens(usage.contextMaxTokens)}
                    </span>
                  </div>
                  <div style={{ height: '8px', background: 'var(--inset)', border: 'var(--bd-thin) solid var(--outline)', overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${usage.contextPercentage != null ? Math.round(usage.contextPercentage) : 0}%`,
                        height: '100%',
                        background: 'var(--teal)',
                        transition: 'width var(--med)',
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {histPanelOpen && (
        <div className="modal-overlay" onClick={() => setHistPanelOpen(false)}>
          <div
            className="modal-content pixel-panel"
            style={{ maxWidth: '640px', width: '94%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span className="modal-title"><Icon name="history" size={16} /> Lịch sử cuộc trò chuyện</span>
              <button className="close-btn" onClick={() => setHistPanelOpen(false)}><Icon name="close" size={16} /></button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                Các cuộc đã lưu bền (giữ qua restart & đổi máy). Bấm để mở lại — nội dung hiện lại đầy đủ,
                gõ tiếp thì agent nhớ hội thoại cũ (resume phiên; nếu phiên đã hết hạn, tự nhồi tóm tắt).
              </div>
              {histError && (
                <div className="picker-error" style={{ color: 'var(--red)', marginBottom: '10px' }}><Icon name="warning" size={14} /> {histError}</div>
              )}

              {/* Ô tìm kiếm theo tiêu đề */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
                <Icon name="search" size={14} />
                <input
                  placeholder="Tìm theo tiêu đề…"
                  value={histSearch}
                  onChange={(e) => setHistSearch(e.target.value)}
                  style={{ padding: '8px', flex: 1 }}
                />
              </div>

              <div className="mcp-list" style={{ maxHeight: '420px', overflowY: 'auto', border: 'var(--bd-thin) solid var(--outline)', padding: '6px', background: 'var(--inset)' }}>
                {(() => {
                  const q = histSearch.trim().toLowerCase();
                  const filtered = q
                    ? histList.filter((c) => c.title.toLowerCase().includes(q))
                    : histList;
                  if (histList.length === 0) {
                    return <div style={{ padding: '14px', textAlign: 'center', color: 'var(--muted)' }}>Chưa có cuộc trò chuyện nào được lưu.</div>;
                  }
                  if (filtered.length === 0) {
                    return <div style={{ padding: '14px', textAlign: 'center', color: 'var(--muted)' }}>Không có cuộc nào khớp "{histSearch}".</div>;
                  }
                  return filtered.map((c) => {
                    const isActive = c.id === paneActiveConvId;
                    const isRenaming = c.id === histRenameId;
                    return (
                      <div
                        key={c.id}
                        style={{
                          padding: '8px 10px',
                          borderBottom: 'var(--bd-thin) solid var(--outline)',
                          background: isActive ? 'var(--outline)' : undefined,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {isRenaming ? (
                              <input
                                autoFocus
                                value={histRenameText}
                                onChange={(e) => setHistRenameText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') submitRename(c.id);
                                  if (e.key === 'Escape') setHistRenameId(null);
                                }}
                                onBlur={() => submitRename(c.id)}
                                style={{ width: '100%', padding: '4px 6px', fontSize: '13px' }}
                              />
                            ) : (
                              <div
                                onDoubleClick={() => { setHistRenameId(c.id); setHistRenameText(c.title); }}
                                title="Bấm để mở · double-click để đổi tên"
                                style={{ fontWeight: isActive ? 700 : 600, fontSize: '13px', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                onClick={() => openConversation(c.id)}
                              >
                                {isActive && '● '}{c.title}
                              </div>
                            )}
                            <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {c.itemCount} dòng · {new Date(c.updatedAt).toLocaleString('vi-VN')}
                              {c.cwd && <> · <span style={{ fontFamily: 'monospace' }}>{c.cwd}</span></>}
                            </div>
                          </div>
                          {!isRenaming && (
                            <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                              <button
                                className="btn"
                                style={{ padding: '2px 8px', fontSize: '11px' }}
                                disabled={histBusy}
                                onClick={() => openConversation(c.id)}
                                title="Mở lại cuộc này (trong tab hiện tại)"
                              >
                                Mở
                              </button>
                              {!readonlyShare && (
                                <button
                                  className="btn"
                                  style={{ padding: '2px 6px', fontSize: '11px' }}
                                  disabled={histBusy}
                                  onClick={() => openConversationInNewTab(c.id)}
                                  title="Mở trong TAB MỚI (chạy song song, giữ tab hiện tại)"
                                >
                                  <Icon name="newChat" size={13} />
                                </button>
                              )}
                              <button
                                className="btn"
                                style={{ padding: '2px 6px', fontSize: '11px' }}
                                onClick={() => { setHistRenameId(c.id); setHistRenameText(c.title); }}
                                title="Đổi tên"
                              >
                                <Icon name="rename" size={13} />
                              </button>
                              <button
                                className="btn deny"
                                style={{ padding: '2px 6px', fontSize: '11px' }}
                                onClick={() => setHistDeleteId(c.id)}
                                title="Xóa cuộc này"
                              >
                                <Icon name="trash" size={13} />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '12px', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px' }}>
              <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{histList.length} cuộc đã lưu</span>
              <button className="btn deny" onClick={() => setHistPanelOpen(false)}>Đóng</button>
            </div>
          </div>
        </div>
      )}

      {/* Xác nhận xóa một cuộc trò chuyện */}
      {histDeleteId && (
        <div className="modal-overlay" onClick={() => setHistDeleteId(null)}>
          <div className="modal-content pixel-panel" style={{ maxWidth: '400px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title"><Icon name="trash" size={16} /> Xóa cuộc trò chuyện</span>
              <button className="close-btn" onClick={() => setHistDeleteId(null)}><Icon name="close" size={16} /></button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, lineHeight: 1.6 }}>
                {histDeleteId === paneActiveConvId && (
                  <><Icon name="warning" size={14} /> Đây là cuộc <strong>đang mở</strong> — màn hình sẽ được dọn về phiên mới.<br /></>
                )}
                Xóa vĩnh viễn cuộc <strong>{histList.find((c) => c.id === histDeleteId)?.title}</strong>?
                <br />Thao tác này không thể hoàn tác.
              </p>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button className="btn deny" onClick={() => setHistDeleteId(null)}>Hủy</button>
              <button className="btn stop" onClick={() => confirmDeleteConversation(histDeleteId)}>Xóa</button>
            </div>
          </div>
        </div>
      )}

      {chatPanelOpen && (
        <div className="modal-overlay" onClick={() => setChatPanelOpen(false)}>
          <div
            className="modal-content pixel-panel chat-panel"
            style={{ maxWidth: '560px', width: '94%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span className="modal-title">
                <Icon name="chat" size={16} />{' '}
                {chatJoinedGroup ? `Phòng: ${chatJoinedGroup}` : 'Chat nhóm'}
              </span>
              <button className="close-btn" onClick={() => setChatPanelOpen(false)}><Icon name="close" size={16} /></button>
            </div>
            <div className="modal-body">
              {chatError && (
                <div className="picker-error" style={{ color: 'var(--red)', marginBottom: '10px' }}>
                  <Icon name="warning" size={14} /> {chatError}
                </div>
              )}

              {!chatJoinedGroup ? (
                /* Màn hình VÀO PHÒNG: biệt danh + mã phòng */
                <div className="chat-join">
                  <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                    Nhắn tin với đồng nghiệp cùng mạng LAN. Nhập <strong>mã phòng</strong> giống nhau để
                    vào cùng nhóm; đặt <strong>biệt danh</strong> để mọi người biết ai đang nói. Tin nhắn
                    được lưu lại — người vào sau vẫn đọc được.
                  </div>
                  <label className="chat-field">
                    <span>Biệt danh của bạn</span>
                    <input
                      placeholder="VD: Bow, Cường, QC-Ánh…"
                      value={chatNickname}
                      onChange={(e) => setChatNickname(e.target.value)}
                      maxLength={40}
                      style={{ padding: '9px', width: '100%' }}
                    />
                  </label>
                  <label className="chat-field" style={{ marginTop: '10px' }}>
                    <span>Mã phòng</span>
                    <input
                      placeholder="VD: team-fe, hop-thu-2, du-an-x…"
                      value={chatGroupInput}
                      onChange={(e) => setChatGroupInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') joinChatGroup(); }}
                      style={{ padding: '9px', width: '100%' }}
                    />
                  </label>
                  <button
                    className="btn primary"
                    onClick={joinChatGroup}
                    disabled={chatBusy}
                    style={{ marginTop: '14px', width: '100%' }}
                  >
                    {chatBusy ? 'Đang vào…' : 'Vào phòng'}
                  </button>
                </div>
              ) : (
                /* Màn hình TRONG PHÒNG: danh sách tin + ô nhập */
                <div className="chat-room">
                  <div className="chat-room-bar">
                    <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                      Bạn: <strong>{chatNickname.trim() || 'Ẩn danh'}</strong>
                    </span>
                    <button className="btn deny chat-leave-btn" onClick={leaveChatGroup}>Rời phòng</button>
                  </div>

                  <div className="chat-messages" ref={chatScrollRef}>
                    {chatMessages.length === 0 ? (
                      <div style={{ padding: '20px', textAlign: 'center', color: 'var(--muted)', fontSize: '13px' }}>
                        Chưa có tin nhắn. Gửi lời chào đầu tiên!
                      </div>
                    ) : (
                      chatMessages.map((m) => {
                        const mine = m.userId === chatUserId;
                        const time = new Date(m.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
                        return (
                          <div key={m.id} className={`chat-msg ${mine ? 'chat-msg-mine' : ''}`}>
                            <div className="chat-msg-meta">
                              <span className="chat-msg-nick">{mine ? 'Bạn' : m.nickname}</span>
                              <span className="chat-msg-time">{time}</span>
                            </div>
                            <div className="chat-msg-text">{m.text}</div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  <div className="chat-composer">
                    <input
                      placeholder="Nhập tin nhắn…"
                      value={chatDraft}
                      onChange={(e) => setChatDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } }}
                      maxLength={4000}
                      style={{ flex: 1, padding: '9px' }}
                    />
                    <button className="btn primary chat-send-btn" onClick={sendChatMessage} disabled={!chatDraft.trim()}>
                      <Icon name="send" size={16} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {structPanelOpen && (
        <div className="modal-overlay" onClick={() => setStructPanelOpen(false)}>
          <div
            className="modal-content pixel-panel"
            style={{ maxWidth: '760px', width: '94%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span className="modal-title"><Icon name="structure" size={16} /> Cấu trúc dự án</span>
              <button className="close-btn" onClick={() => setStructPanelOpen(false)}><Icon name="close" size={16} /></button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '10px' }}>
                <div style={{ fontSize: '12px', color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                  <Icon name="folder" size={13} /> {cwd.trim() || '(chưa chọn cwd)'}
                </div>
                <button
                  className="btn"
                  style={{ padding: '3px 12px', fontSize: '12px', whiteSpace: 'nowrap' }}
                  disabled={structBusy || !cwd.trim()}
                  onClick={runAnalyzeStructure}
                  title="Phân tích lại (quét mới)"
                >
                  {structBusy ? 'Đang quét…' : structText ? 'Phân tích lại' : 'Phân tích'}
                </button>
              </div>

              {structError && (
                <div className="picker-error" style={{ color: 'var(--red)', marginBottom: '10px' }}><Icon name="warning" size={14} /> {structError}</div>
              )}

              <div style={{ maxHeight: '60vh', overflowY: 'auto', padding: '12px', background: 'var(--inset)', border: 'var(--bd-thin) solid var(--outline)' }}>
                {structBusy && !structText && (
                  <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '24px' }}>
                    <div style={{ marginBottom: '6px' }}>🔍 Agent đang đọc repo…</div>
                    <div style={{ fontSize: '12px' }}>Quét chỉ-đọc, thường mất 30–60 giây. Không sửa gì trong repo.</div>
                  </div>
                )}
                {!structBusy && !structText && !structError && (
                  <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '24px' }}>
                    Bấm <b>Phân tích</b> để agent quét cấu trúc repo hiện tại.
                  </div>
                )}
                {structText && <Markdown text={structText} />}
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button className="btn deny" onClick={() => setStructPanelOpen(false)}>Đóng</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal xác nhận "Cuộc trò chuyện mới" đã dời sang TaskPane (state per-tab). */}

      {activeClientsOpen && (
        <div className="modal-overlay" onClick={() => setActiveClientsOpen(false)}>
          <div
            className="modal-content pixel-panel"
            style={{ maxWidth: '640px', width: '92%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span className="modal-title">
                <Icon name="users" size={16} /> Bảng điều khiển LAN (LAN Dashboard)
              </span>
              <button className="close-btn" onClick={() => setActiveClientsOpen(false)}>
                <Icon name="close" size={16} />
              </button>
            </div>
            
            <div className="modal-tabs" style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--hairline)', paddingBottom: '8px', marginBottom: '12px' }}>
              <button
                className={`btn ${activeTab === 'clients' ? 'active' : ''}`}
                style={{
                  padding: '4px 12px',
                  fontSize: '12px',
                  background: activeTab === 'clients' ? 'var(--brass)' : 'transparent',
                  color: activeTab === 'clients' ? 'var(--on-brass)' : 'var(--ink)',
                  border: '1px solid var(--hairline)'
                }}
                onClick={() => setActiveTab('clients')}
              >
                Thiết bị online ({activeClients.length})
              </button>
              <button
                className={`btn ${activeTab === 'logs' ? 'active' : ''}`}
                style={{
                  padding: '4px 12px',
                  fontSize: '12px',
                  background: activeTab === 'logs' ? 'var(--brass)' : 'transparent',
                  color: activeTab === 'logs' ? 'var(--on-brass)' : 'var(--ink)',
                  border: '1px solid var(--hairline)'
                }}
                onClick={() => {
                  setActiveTab('logs');
                  fetchAuditLogs();
                }}
              >
                Nhật ký Audit ({auditLogs.length})
              </button>
            </div>

            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Mã truy cập — chỉ admin thấy panel này nên đặt luôn ở đây. */}
              <div
                style={{
                  border: 'var(--bd-thin) solid var(--outline)',
                  padding: '10px',
                  background: 'var(--inset)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Icon name="lock" size={14} />
                    <strong style={{ fontSize: '13px' }}>Quản lý truy cập LAN ({accessUsers.length})</strong>
                  </div>
                  <button
                    className="btn"
                    onClick={refreshAccessUsers}
                    style={{ fontSize: '11px', padding: '2px 8px' }}
                  >
                    Tải lại 🔄
                  </button>
                </div>
                <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
                  Duyệt hoặc thu hồi quyền truy cập của các máy tính khác trong mạng LAN.
                </span>
                
                <div
                  style={{
                    maxHeight: '240px',
                    overflowY: 'auto',
                    border: 'var(--bd-thin) solid var(--outline)',
                    borderRadius: '4px',
                    fontSize: '12px',
                    background: 'var(--paper)',
                  }}
                >
                  {accessUsers.length === 0 ? (
                    <div style={{ padding: '12px', textAlign: 'center', color: 'var(--muted)' }}>
                      Chưa có yêu cầu truy cập nào.
                    </div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                      <thead>
                        <tr style={{ borderBottom: 'var(--bd-thin) solid var(--outline)', background: 'var(--inset)', color: 'var(--muted)', fontSize: '11px' }}>
                          <th style={{ padding: '6px 8px' }}>Tên</th>
                          <th style={{ padding: '6px 8px' }}>IP / Thời gian</th>
                          <th style={{ padding: '6px 8px', textAlign: 'right' }}>Thao tác</th>
                        </tr>
                      </thead>
                      <tbody>
                        {accessUsers.map((u) => {
                          const dateStr = new Date(u.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                          return (
                            <tr key={u.id} style={{ borderBottom: 'var(--bd-thin) solid var(--outline)' }}>
                              <td style={{ padding: '6px 8px', fontWeight: 'bold' }}>
                                <div>{u.name}</div>
                                {u.apiOrigin && (
                                  <span style={{
                                    fontSize: '9px',
                                    padding: '1px 4px',
                                    borderRadius: '3px',
                                    background: u.apiOrigin.includes('4002') ? 'var(--brass)' : u.apiOrigin.includes('4001') ? 'var(--hairline)' : 'var(--inset)',
                                    color: u.apiOrigin.includes('4002') ? 'var(--on-brass)' : 'var(--muted)',
                                    display: 'inline-block',
                                    marginTop: '2px'
                                  }}>
                                    {u.apiOrigin.includes('4002') ? 'Collab' : u.apiOrigin.includes('4001') ? 'QC' : u.apiOrigin.includes('4003') ? 'BA' : u.apiOrigin.includes('4004') ? 'Review' : 'Dev'}
                                  </span>
                                )}
                              </td>
                              <td style={{ padding: '6px 8px', color: 'var(--muted)', fontSize: '11px' }}>
                                <div>{u.ip}</div>
                                <div>{dateStr}</div>
                              </td>
                              <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                                {u.status === 'pending' && (
                                  <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end' }}>
                                    <button
                                      className="btn allow"
                                      onClick={() => handleApproveAccess(u.id, u.apiOrigin)}
                                      style={{ padding: '2px 6px', fontSize: '11px' }}
                                    >
                                      Duyệt
                                    </button>
                                    <button
                                      className="btn deny"
                                      onClick={() => handleRejectAccess(u.id, u.apiOrigin)}
                                      style={{ padding: '2px 6px', fontSize: '11px' }}
                                    >
                                      Từ chối
                                    </button>
                                  </div>
                                )}
                                {u.status === 'approved' && (
                                  <button
                                    className="btn deny"
                                    onClick={() => handleRevokeAccess(u.id, u.apiOrigin)}
                                    style={{ padding: '2px 6px', fontSize: '11px' }}
                                  >
                                    Thu hồi
                                  </button>
                                )}
                                {u.status === 'rejected' && (
                                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center', justifyContent: 'flex-end' }}>
                                    <span style={{ color: 'var(--muted)', fontSize: '11px', marginRight: '4px' }}>Bị chặn</span>
                                    <button
                                      className="btn allow"
                                      onClick={() => handleApproveAccess(u.id, u.apiOrigin)}
                                      style={{ padding: '2px 6px', fontSize: '11px' }}
                                    >
                                      Cho vào
                                    </button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {activeTab === 'clients' ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                      Các IP đã gọi API tới máy bạn trong 45s qua:
                    </span>
                    <button
                      className="btn"
                      style={{ padding: '2px 8px', fontSize: '11px' }}
                      onClick={fetchActiveClients}
                      disabled={loadingActiveClients}
                    >
                      {loadingActiveClients ? 'Đang tải...' : 'Làm mới'}
                    </button>
                  </div>
                  <div
                    style={{
                      maxHeight: '300px',
                      overflowY: 'auto',
                      border: 'var(--bd-thin) solid var(--outline)',
                      padding: '6px',
                      background: 'var(--inset)',
                    }}
                  >
                    {activeClients.length === 0 ? (
                      <div style={{ padding: '20px', textAlign: 'center', color: 'var(--muted)' }}>
                        Chưa có thiết bị LAN nào kết nối
                      </div>
                    ) : (
                      activeClients.map((client, idx) => (
                        <div
                          key={idx}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '8px 10px',
                            borderBottom: idx < activeClients.length - 1 ? 'var(--bd-thin) solid var(--outline)' : 'none',
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span
                                style={{
                                  width: '8px',
                                  height: '8px',
                                  borderRadius: '50%',
                                  background: 'var(--teal)',
                                  display: 'inline-block',
                                }}
                              ></span>
                              {client.ip}{' '}
                              {client.ip === '127.0.0.1' && (
                                <span style={{ color: 'var(--muted)', fontSize: '11px', fontWeight: 'normal' }}>
                                  (Bạn)
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px' }}>
                              Trình duyệt: {client.device}
                            </div>
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
                            Hoạt động: {new Date(client.lastSeen).toLocaleTimeString()}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                      150 dòng nhật ký mới nhất ghi lại câu hỏi & hoạt động của client:
                    </span>
                    <button
                      className="btn"
                      style={{ padding: '2px 8px', fontSize: '11px' }}
                      onClick={fetchAuditLogs}
                      disabled={loadingLogs}
                    >
                      {loadingLogs ? 'Đang tải...' : 'Làm mới'}
                    </button>
                  </div>
                  <div
                    style={{
                      maxHeight: '300px',
                      overflowY: 'auto',
                      border: 'var(--bd-thin) solid var(--outline)',
                      padding: '8px',
                      background: '#05070c',
                      color: '#a79e88',
                      fontFamily: 'var(--mono)',
                      fontSize: '11px',
                      whiteSpace: 'pre-wrap',
                      lineHeight: '1.4'
                    }}
                  >
                    {auditLogs.length === 0 ? (
                      <div style={{ padding: '20px', textAlign: 'center', color: 'var(--muted)' }}>
                        Chưa có lịch sử hoạt động nào được ghi lại.
                      </div>
                    ) : (
                      auditLogs.map((logLine, idx) => (
                        <div key={idx} style={{ 
                          borderBottom: '1px solid rgba(231, 223, 204, 0.05)', 
                          paddingBottom: '4px', 
                          marginBottom: '4px',
                          color: logLine.includes('BỊ CHẶN') ? '#d9603f' : (logLine.includes('THẤT BẠI') ? '#d9603f' : '#a79e88')
                        }}>
                          {logLine}
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
            <div
              className="modal-footer"
              style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}
            >
              <button className="btn deny" onClick={() => setActiveClientsOpen(false)}>
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {claudeModal && (
        <div className="modal-overlay" onClick={() => {
          if (claudeModal.type === 'prompt' && claudeModal.onCancel) {
            claudeModal.onCancel();
          }
          setClaudeModal(null);
        }}>
          <div
            className="modal-content pixel-panel"
            style={{ maxWidth: '400px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span className="modal-title">
                <Icon name="users" size={16} /> {claudeModal.title}
              </span>
              <button
                className="close-btn"
                onClick={() => {
                  if (claudeModal.type === 'prompt' && claudeModal.onCancel) {
                    claudeModal.onCancel();
                  }
                  setClaudeModal(null);
                }}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ margin: '0 0 12px 0', lineHeight: 1.6 }}>{claudeModal.message}</p>
              {claudeModal.type === 'prompt' && (
                <input
                  type="text"
                  value={claudeModalInput}
                  onChange={(e) => setClaudeModalInput(e.target.value)}
                  placeholder="ví dụ: work"
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    boxSizing: 'border-box',
                    marginTop: '6px'
                  }}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      claudeModal.onConfirm(claudeModalInput);
                      setClaudeModal(null);
                    } else if (e.key === 'Escape') {
                      if (claudeModal.onCancel) claudeModal.onCancel();
                      setClaudeModal(null);
                    }
                  }}
                />
              )}
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}>
              {claudeModal.type === 'prompt' && (
                <button
                  className="btn deny"
                  onClick={() => {
                    if (claudeModal.onCancel) claudeModal.onCancel();
                    setClaudeModal(null);
                  }}
                >
                  Hủy
                </button>
              )}
              <button
                className="btn allow"
                onClick={() => {
                  claudeModal.onConfirm(claudeModal.type === 'prompt' ? claudeModalInput : undefined);
                  setClaudeModal(null);
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {authModal && (
        <div className="modal-overlay" onClick={() => {
          if (!authModal.oauthLoading && !authModal.tokenLoading) setAuthModal(null);
        }}>
          <div
            className="modal-content pixel-panel"
            style={{ maxWidth: '450px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span className="modal-title">
                <Icon name="users" size={16} /> {authModal.mode === 'oauth' ? 'Continue in browser' : `Đăng nhập tài khoản '${authModal.profile}'`}
              </span>
              <button
                className="close-btn"
                disabled={authModal.oauthLoading || authModal.tokenLoading}
                onClick={() => setAuthModal(null)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            {authModal.mode === 'select' && (
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '10px 0' }}>
                <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)', lineHeight: 1.5 }}>
                  Chọn phương thức đăng nhập và xác thực cho tài khoản này:
                </p>
                
                <button
                  type="button"
                  className="btn allow auth-method-btn"
                  onClick={async () => {
                    setAuthModal(prev => prev ? { ...prev, oauthLoading: true } : null);
                    try {
                      const res = await apiFetch('/api/profiles/login/start', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ profile: authModal.profile }),
                      });
                      if (res.ok) {
                        const data = await res.json();
                        setAuthModal({
                          profile: authModal.profile,
                          mode: 'oauth',
                          oauthUrl: data.url,
                          oauthCode: '',
                          oauthLoading: false,
                          oauthError: '',
                        });
                      } else {
                        const err = await res.json();
                        await showClaudeAlert('Lỗi', err.error || 'Không thể bắt đầu đăng nhập OAuth.');
                        setAuthModal(prev => prev ? { ...prev, oauthLoading: false } : null);
                      }
                    } catch (e) {
                      console.error(e);
                      await showClaudeAlert('Lỗi', 'Lỗi kết nối.');
                      setAuthModal(prev => prev ? { ...prev, oauthLoading: false } : null);
                    }
                  }}
                >
                  <div className="auth-method-title">Cách 1: Đăng nhập OAuth (Khuyên dùng)</div>
                  <div className="auth-method-desc">
                    Tự động mở trình duyệt xác thực thông qua tài khoản Claude sẵn có của bạn
                  </div>
                </button>

                <button
                  type="button"
                  className="btn auth-method-btn"
                  onClick={() => {
                    setAuthModal({
                      profile: authModal.profile,
                      mode: 'token',
                      tokenValue: '',
                      tokenLoading: false,
                      tokenError: '',
                    });
                  }}
                >
                  <div className="auth-method-title">Cách 2: Dùng API Key hoặc Token thủ công</div>
                  <div className="auth-method-desc">
                    Nhập trực tiếp API Key (sk-ant-...) hoặc OAuth Token riêng biệt
                  </div>
                </button>
              </div>
            )}

            {authModal.mode === 'oauth' && (
              <div className="modal-body" style={{ lineHeight: 1.6 }}>
                <p style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--muted)' }}>
                  If the browser didn't open, visit this URL:
                </p>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                  <input
                    type="text"
                    readOnly
                    value={authModal.oauthUrl || ''}
                    style={{
                      flex: 1,
                      padding: '8px 10px',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--hairline)',
                      borderRadius: '4px',
                      fontFamily: 'monospace',
                      fontSize: '12px',
                      color: 'var(--muted)',
                      textOverflow: 'ellipsis',
                    }}
                    onClick={(e) => {
                      (e.target as HTMLInputElement).select();
                    }}
                  />
                  <button
                    type="button"
                    className="btn"
                    style={{ padding: '0 10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    title="Copy URL"
                    onClick={() => {
                      if (authModal.oauthUrl) {
                        navigator.clipboard.writeText(authModal.oauthUrl);
                        setCopiedOauthUrl(true);
                        setTimeout(() => setCopiedOauthUrl(false), 2000);
                      }
                    }}
                  >
                    <Icon name={copiedOauthUrl ? 'success' : 'copy'} size={16} />
                  </button>
                </div>
                
                <p style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--muted)' }}>
                  Or, paste your authorization code manually:
                </p>
                <input
                  type="text"
                  value={authModal.oauthCode}
                  disabled={authModal.oauthLoading}
                  onChange={(e) => {
                    const val = e.target.value;
                    setAuthModal(prev => prev ? { ...prev, oauthCode: val } : null);
                  }}
                  placeholder="012345"
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    boxSizing: 'border-box'
                  }}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && authModal.oauthCode?.trim() && !authModal.oauthLoading) {
                      submitOauthCode();
                    }
                  }}
                />
                {authModal.oauthError && (
                  <div style={{ color: '#ff1744', marginTop: '10px', fontSize: '13px' }}>
                    ⚠️ {authModal.oauthError}
                  </div>
                )}
              </div>
            )}

            {authModal.mode === 'token' && (
              <div className="modal-body" style={{ lineHeight: 1.6 }}>
                <p style={{ margin: '0 0 8px 0' }}>
                  Nhập API Key (sk-ant-...) hoặc OAuth Token cho tài khoản này (hoặc để trống để xoá token và dùng CLI login):
                </p>
                <input
                  type="text"
                  value={authModal.tokenValue}
                  disabled={authModal.tokenLoading}
                  onChange={(e) => {
                    const val = e.target.value;
                    setAuthModal(prev => prev ? { ...prev, tokenValue: val } : null);
                  }}
                  placeholder="Dán API Key hoặc Token tại đây"
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    boxSizing: 'border-box'
                  }}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !authModal.tokenLoading) {
                      submitManualToken();
                    }
                  }}
                />
                {authModal.tokenError && (
                  <div style={{ color: '#ff1744', marginTop: '10px', fontSize: '13px' }}>
                    ⚠️ {authModal.tokenError}
                  </div>
                )}
              </div>
            )}

            <div className="modal-footer" style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}>
              {authModal.mode === 'oauth' ? (
                <>
                  <button
                    className="btn deny"
                    disabled={authModal.oauthLoading}
                    onClick={() => {
                      setAuthModal(prev => prev ? { ...prev, mode: 'select', oauthError: '', tokenError: '' } : null);
                    }}
                  >
                    Back
                  </button>
                  <button
                    className="btn allow"
                    disabled={!authModal.oauthCode?.trim() || authModal.oauthLoading}
                    onClick={submitOauthCode}
                  >
                    {authModal.oauthLoading ? 'Verifying...' : 'Continue'}
                  </button>
                </>
              ) : (
                <>
                  {authModal.mode !== 'select' && (
                    <button
                      className="btn deny"
                      disabled={authModal.tokenLoading}
                      onClick={() => {
                        setAuthModal(prev => prev ? { ...prev, mode: 'select', tokenError: '' } : null);
                      }}
                    >
                      Quay lại
                    </button>
                  )}
                  {authModal.mode === 'select' && (
                    <button
                      className="btn deny"
                      onClick={() => setAuthModal(null)}
                    >
                      Hủy
                    </button>
                  )}
                  {authModal.mode === 'token' && (
                    <button
                      className="btn allow"
                      disabled={authModal.tokenLoading}
                      onClick={submitManualToken}
                    >
                      {authModal.tokenLoading ? 'Đang lưu...' : 'Lưu'}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {cfg?.isAdmin && pendingAccessCount > 0 && !activeClientsOpen && (
        <div
          className="access-notification-toast"
          onClick={openActiveClientsPanel}
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            background: 'var(--paper)',
            border: '1px solid var(--brass)',
            borderRadius: '6px',
            padding: '12px 16px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            cursor: 'pointer',
            borderLeft: '4px solid var(--brass)',
          }}
        >
          <div style={{ fontSize: '20px' }}>🔔</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <strong style={{ fontSize: '13px', color: 'var(--brass)' }}>Yêu cầu truy cập LAN mới</strong>
            <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
              Có {pendingAccessCount} máy đang chờ duyệt. Bấm để mở panel.
            </span>
          </div>
        </div>
      )}

      {/* Toast kết quả đồng bộ skill — hiện khi bấm nút 🔄, tự ẩn sau 5s (hoặc bấm để đóng ngay).
          Cho phản hồi rõ ràng thay cho dòng text cũ đã gỡ khỏi hàng điều khiển. */}
      {skillSyncMsg && (
        <div
          className="skill-sync-toast"
          onClick={() => setSkillSyncMsg('')}
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            maxWidth: '360px',
            background: 'var(--surface)',
            border: '1px solid var(--brass)',
            borderLeft: '4px solid var(--brass)',
            borderRadius: '6px',
            padding: '12px 16px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            cursor: 'pointer',
            fontFamily: 'var(--mono)',
            fontSize: '12px',
            color: 'var(--ink)',
            lineHeight: 1.5,
          }}
        >
          {skillSyncMsg}
        </div>
      )}
    </div>
  );
}
