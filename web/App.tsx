import { useEffect, useRef, useState, useCallback } from 'react';
import { PixelSelect } from './PixelSelect.js';
import { AccentPicker } from './AccentPicker.js';
import { ModeSelect, modeDef } from './ModeSelect.js';
import { NeuralBrain } from './NeuralBrain.js';
import { Markdown } from './Markdown.js';
import { QuestionCard } from './QuestionCard.js';
import { Icon, type IconName } from './Icon.js';
import type {
  ChatItem,
  ConversationFull,
  ConversationSummary,
  DetectedSource,
  DocAttachment,
  ImageAttachment,
  Mode,
  PendingApproval,
  PendingQuestion,
  ToolDetail,
  UsageSnapshot,
  WebEvent,
} from './types.js';

type Theme = 'light' | 'dark';

/** Màu nhấn chọn ở header. 'brass' = mặc định (đồng thau), không đặt data-accent. */
type Accent = 'brass' | 'blue' | 'teal' | 'purple' | 'pink' | 'red' | 'orange';

/**
 * 7 màu nhấn hiển thị thành swatch ở header — bảng đã kiểm định bằng dataviz palette
 * (CVD-safe, tương phản ≥3:1). `swatch` chỉ tô chấm màu trong picker (dùng sắc DARK cho
 * đẹp trên nút header tối); màu thật khi áp do CSS [data-accent] quyết định.
 */
const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  { id: 'brass', label: 'Đồng thau', swatch: '#d6a441' },
  { id: 'blue', label: 'Lam', swatch: '#5c9fea' },
  { id: 'teal', label: 'Xanh vịt', swatch: '#3bb89d' },
  { id: 'purple', label: 'Tím', swatch: '#9085e9' },
  { id: 'pink', label: 'Hồng', swatch: '#e084ac' },
  { id: 'red', label: 'Đỏ', swatch: '#e66767' },
  { id: 'orange', label: 'Cam', swatch: '#e88f4c' },
];

/** Một node trong Activity Log / Star Chart. `ops` & `approval` phục vụ khung chi tiết mở rộng. */
interface ActivityNode {
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
const nextId = () => `${Date.now()}-${seq++}`;

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
function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('x-bow-token', token);
  return fetch(input, { ...init, headers });
}

/** Thêm token vào query string cho URL SSE (EventSource không set được header). */
function withToken(url: string): string {
  const token = getAccessToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

/** Đọc file text → {name, content}. */
function readText(file: File): Promise<DocAttachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, content: String(r.result ?? '') });
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

/** Đọc file → data URL (base64 kèm prefix). */
function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Đọc file ảnh → {name, base64, mediaType}. */
async function readImage(file: File): Promise<ImageAttachment> {
  const base64 = (await readDataUrl(file)).split(',')[1] ?? '';
  return { name: file.name, base64, mediaType: file.type || 'image/png' };
}

/**
 * Gợi ý bấm nhanh ở khung nhập. Thêm mẫu mới = thêm 1 phần tử vào đây.
 * - target 'task': điền vào ô mô tả task.
 * - target 'jira': đưa con trỏ vào ô Jira (điền text gợi ý làm placeholder hành động).
 */
const QUICK_PROMPTS: { icon: IconName; label: string; text: string }[] = [
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
];

/** "trong 2h", "trong 1d"… từ ISO reset time. Rỗng nếu không có/đã qua. */
function formatResetIn(iso: string | null): string {
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
function formatCountdown(iso: string): string {
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
function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}g ${m}p ${s}s`;
  if (m > 0) return `${m}p ${s}s`;
  return `${s}s`;
}

/** Gọn số token: 21592 → "21.6k", 1000000 → "1M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

/** Một thanh usage: nhãn + % + bar. severity đổi màu khi gần đầy. */
const API_PORTS = [4000, 4001, 4002];

function getAdminApiOrigins(): string[] {
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (!isLocal) return ['']; // non-admin LAN clients only talk to their own origin
  return API_PORTS.map(p => `http://localhost:${p}`);
}

export function App() {
  const [cfg, setCfg] = useState<{
    defaultCwd: string;
    repoName?: string;
    mcpServers?: string[];
    lanUrl?: string;
    lanUrls?: string[];
    isSafeMode?: boolean;
    isCollabMode?: boolean;
    isAdmin?: boolean;
    claudeProfiles?: { name: string; tokenSet: boolean }[];
    currentClaudeProfile?: string;
    hasAuth?: boolean;
    tokenSet?: boolean;
    otherModes?: {
      dev: { repoName: string; defaultCwd: string };
      safe: { repoName: string; defaultCwd: string };
      collab: { repoName: string; defaultCwd: string };
    };
  } | null>(null);
  const [otherModes, setOtherModes] = useState<{
    dev: { repoName: string; defaultCwd: string };
    safe: { repoName: string; defaultCwd: string };
    collab: { repoName: string; defaultCwd: string };
  } | null>(null);
  const [task, setTask] = useState(() => localStorage.getItem('bow-task') || '');
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
  // Bước (điểm trên não neuron) đang được người dùng bấm chọn để xem chi tiết.
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  // Item Activity Log đang mở rộng để xem chi tiết (từng thao tác/lệnh/kết quả).
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  // Nhóm tool liên tiếp trong khung chat đang được mở (bung ra xem từng thao tác).
  const [expandedChatGroups, setExpandedChatGroups] = useState<Set<string>>(new Set());
  const [language, setLanguage] = useState(() => localStorage.getItem('bow-language') || 'vi');
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
    const origins = ['http://localhost:4000'];
    if (otherModes?.safe?.defaultCwd) {
      origins.push('http://localhost:4001');
    }
    if (otherModes?.collab?.defaultCwd) {
      origins.push('http://localhost:4002');
    }
    return origins;
  }, [otherModes]);

  const [docs, setDocs] = useState<DocAttachment[]>([]);
  const [pdfs, setPdfs] = useState<{ name: string; base64: string }[]>([]);
  const [images, setImages] = useState<ImageAttachment[]>([]);

  const [items, setItems] = useState<ChatItem[]>(() => {
    // Khôi phục lịch sử chat từ phiên trước (giữ qua refresh trang).
    try {
      const raw = localStorage.getItem('bow-chat-items');
      return raw ? (JSON.parse(raw) as ChatItem[]) : [];
    } catch {
      return [];
    }
  });
  const [pending, setPending] = useState<PendingApproval[]>([]);
  // Câu hỏi AskUserQuestion đang chờ người dùng chọn (thường chỉ có 1 tại một thời điểm).
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [running, setRunning] = useState(false);
  // Đồng hồ phiên: mốc bắt đầu lượt chạy hiện tại + thời lượng lượt gần nhất (đo phía
  // client — bao gồm cả thời gian chờ duyệt; dòng "Xong · …" trong chat dùng duration_ms
  // chính xác của SDK). Render tick nhờ đồng hồ UTC đã setInterval 1s sẵn.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [lastRunMs, setLastRunMs] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(
    () => localStorage.getItem('bow-conversation-id') || null
  );

  // ── Tự chạy tiếp khi hết hạn mức phiên (5h) ──
  // Khi phiên dừng vì "You've hit your session limit", server lên lịch chạy tiếp lúc reset.
  // `autoResume` giữ thông tin lịch để hiện thẻ đếm ngược + nút huỷ. null = không có lịch.
  const [autoResume, setAutoResume] = useState<{
    retryAt: string;
    resetsAt: string | null;
    attempt: number;
    maxAttempts: number;
    conversationId: string | null;
  } | null>(null);
  // Đồng hồ tick 1s để đếm ngược tới retryAt (chỉ chạy khi có lịch).
  const [resumeTick, setResumeTick] = useState(0);
  // Timer fallback client-side: nếu tới giờ mà server IM (đã tắt?), client tự gọi lại.
  const clientResumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Giữ payload lượt vừa chạy để client-side fallback gửi lại được (resume + prompt tiếp tục).
  const lastRunPayloadRef = useRef<Record<string, unknown> | null>(null);

  // ── Lịch sử nhiều cuộc trò chuyện (lưu bền ở backend) ──
  // id cuộc đang mở. Mọi item/agent hiện trên màn hình thuộc về cuộc này; auto-lưu đẩy
  // items+conversationId vào đúng bản ghi này. null = chưa gắn cuộc nào (sẽ tạo khi cần).
  const [activeConvId, setActiveConvId] = useState<string | null>(
    () => localStorage.getItem('bow-active-conv-id') || null
  );
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
  // true khi cuộc đang mở được nạp LẠI từ lịch sử (phiên SDK có thể đã bị dọn) → lượt
  // chạy kế tiếp gửi kèm resumeContext (tóm tắt) để agent không mất ngữ cảnh. Về false
  // sau lượt đầu tiên (từ đó có conversationId mới, resume bình thường).
  const [needResumeContext, setNeedResumeContext] = useState(false);

  // Đồng bộ hóa cấu hình composer vào localStorage
  useEffect(() => { localStorage.setItem('bow-task', task); }, [task]);
  useEffect(() => { localStorage.setItem('bow-cwd', cwd); }, [cwd]);
  useEffect(() => { localStorage.setItem('bow-mode', mode); }, [mode]);
  useEffect(() => { localStorage.setItem('bow-profile', profile); }, [profile]);
  useEffect(() => { localStorage.setItem('bow-selectedModel', selectedModel); }, [selectedModel]);
  useEffect(() => { localStorage.setItem('bow-effort', effort); }, [effort]);
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
  useEffect(() => {
    if (conversationId) {
      localStorage.setItem('bow-conversation-id', conversationId);
    } else {
      localStorage.removeItem('bow-conversation-id');
    }
  }, [conversationId]);
  useEffect(() => {
    if (activeConvId) {
      localStorage.setItem('bow-active-conv-id', activeConvId);
    } else {
      localStorage.removeItem('bow-active-conv-id');
    }
  }, [activeConvId]);

  // Lưu lịch sử chat để giữ qua refresh. Chỉ giữ 300 item gần nhất để không vượt
  // quota localStorage (~5MB); chat rất dài thì tin cũ nhất bị lược, tránh crash.
  useEffect(() => {
    try {
      const MAX = 300;
      const trimmed = items.length > MAX ? items.slice(-MAX) : items;
      localStorage.setItem('bow-chat-items', JSON.stringify(trimmed));
    } catch {
      // Vượt quota hoặc lỗi serialize → bỏ qua, không chặn UI.
    }
  }, [items]);

  // Tự lưu BỀN cuộc đang mở lên backend mỗi khi items đổi (debounce 800ms để gộp các
  // cập nhật dồn dập khi agent đang stream). Lưu CẢ khi đang chạy dở → tắt trình duyệt
  // giữa chừng vẫn không mất lượt. Cuộc trống thì bỏ qua (chưa có gì để nhớ).
  useEffect(() => {
    if (items.length === 0) return;
    const t = setTimeout(() => {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      persistActiveConversation(items, conversationId);
    }, 800);
    return () => clearTimeout(t);
    // Chỉ chạy theo items/conversationId; persistActiveConversation đọc state mới nhất
    // qua closure mỗi lần render nên không cần liệt kê (tránh vòng lặp tái tạo timer).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, conversationId]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Đích của picker: 'cwd' = chọn thư mục làm việc thường; 'safe-cwd' = Admin đổi
  // source mà QC hỏi đáp (Safe Mode). Quyết định nút "Chọn thư mục này" làm gì.
  const [pickerTarget, setPickerTarget] = useState<'cwd' | 'dev-cwd' | 'safe-cwd' | 'collab-cwd'>('cwd');
  const [pickerPath, setPickerPath] = useState('');
  const [pickerParent, setPickerParent] = useState<string | null>(null);
  const [pickerDirs, setPickerDirs] = useState<string[]>([]);
  const [pickerError, setPickerError] = useState('');
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

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

  const [authModal, setAuthModal] = useState<{
    profile: string;
    mode: 'select' | 'oauth' | 'token';
    oauthUrl?: string;
    oauthCode?: string;
    oauthLoading?: boolean;
    oauthError?: string;
    tokenValue?: string;
    tokenLoading?: boolean;
    tokenError?: string;
  } | null>(null);

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
  type WsRepo = { path: string; role: string };
  type Ws = { slug: string; dir: string; repos: WsRepo[] };
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
          contextTokens: prev?.contextTokens ?? d.usage.contextTokens,
          contextMaxTokens: prev?.contextMaxTokens ?? d.usage.contextMaxTokens,
          contextPercentage: prev?.contextPercentage ?? d.usage.contextPercentage,
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
  const deriveTitle = (list: ChatItem[]): string => {
    const firstUser = list.find((it) => it.kind === 'user')?.text?.trim();
    if (!firstUser) return '';
    const oneLine = firstUser.replace(/\s+/g, ' ');
    return oneLine.length > 60 ? oneLine.slice(0, 57) + '…' : oneLine;
  };

  /**
   * Cô đọng items → text ngữ cảnh cho fallback trí nhớ (gửi kèm khi mở lại cuộc cũ).
   * Chỉ lấy phần hội thoại có nghĩa (user hỏi / agent trả lời), bỏ log tool cho gọn;
   * cắt tổng độ dài để không phình prompt.
   */
  const summarizeForResume = (list: ChatItem[]): string => {
    const lines: string[] = [];
    for (const it of list) {
      if (it.kind === 'user') lines.push(`NGƯỜI DÙNG: ${it.text.trim()}`);
      else if (it.kind === 'agent') lines.push(`AGENT: ${it.text.trim()}`);
    }
    let out = lines.join('\n');
    const MAX = 6000; // ~ vài nghìn token; đủ ngữ cảnh mà không quá tốn
    if (out.length > MAX) out = '…(lược phần đầu)…\n' + out.slice(-MAX);
    return out;
  };

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
   * Lưu (upsert) cuộc đang mở lên backend. Tự đặt tiêu đề từ câu user đầu nếu backend
   * chưa có tên. Trả về id cuộc (tạo mới nếu chưa có activeConvId). Gọi sau mỗi lượt
   * chạy và khi có thay đổi items đáng kể.
   */
  const persistActiveConversation = async (
    convItems: ChatItem[],
    convId: string | null,
  ): Promise<string | null> => {
    // Không lưu cuộc trống (chưa có gì để nhớ).
    if (convItems.length === 0) return activeConvId;
    let id = activeConvId;
    if (!id) {
      id = (crypto as Crypto).randomUUID();
      setActiveConvId(id);
    }
    try {
      const res = await apiFetch(`/api/conversations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: deriveTitle(convItems) || undefined,
          conversationId: convId,
          items: convItems,
          cwd: cwd.trim(),
        }),
      });
      // Lưu thất bại (backend từ chối) → báo cho caller biết để không dọn màn hình.
      if (!res.ok) return null;
    } catch {
      // Lưu thất bại (mạng/đứt kết nối) → trả null, không chặn UI ở lượt auto-lưu.
      return null;
    }
    return id;
  };

  /**
   * Mở một cuộc cũ: nạp items + conversationId + cwd. Bật cờ needResumeContext để lượt
   * chạy kế gửi kèm tóm tắt (phòng phiên SDK đã bị dọn). Dừng phiên đang chạy (nếu có).
   */
  const openConversation = async (id: string) => {
    if (id === activeConvId && !histPanelOpen) return;
    setHistBusy(true);
    try {
      const res = await apiFetch(`/api/conversations/${id}`);
      if (!res.ok) { setHistError('Không mở được cuộc trò chuyện.'); return; }
      const { conversation } = (await res.json()) as { conversation: ConversationFull };

      // Dừng phiên đang chạy trước khi chuyển cuộc — tránh event phiên cũ đổ nhầm.
      if (running) {
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        setRunning(false);
        if (sessionId) await apiFetch(`/api/stop/${sessionId}`, { method: 'POST' }).catch(() => {});
      }

      setActiveConvId(conversation.id);
      setItems(conversation.items ?? []);
      setConversationId(conversation.conversationId);
      // Có conversationId (phiên SDK) thì thử resume trực tiếp; nếu không có thì chắc chắn
      // cần nhồi ngữ cảnh. Dù có, ta vẫn bật cờ để lượt đầu kèm tóm tắt cho chắc (phiên
      // .jsonl có thể đã bị SDK dọn) — vô hại nếu resume thành công.
      setNeedResumeContext(true);
      if (conversation.cwd) setCwd(conversation.cwd);
      setSessionId(null);
      setPending([]);
      setQuestions([]);
      setSelectedStepId(null);
      sessionBaselineRef.current = (conversation.items ?? []).length;
      localStorage.removeItem('bow-session-id');
      setHistPanelOpen(false);
    } catch (err) {
      setHistError(`Lỗi gọi backend: ${(err as Error).message}`);
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

  /** Xóa một cuộc (sau xác nhận). Nếu là cuộc đang mở → dọn màn hình về trạng thái mới. */
  const confirmDeleteConversation = async (id: string) => {
    setHistDeleteId(null);
    try {
      const res = await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' });
      const data = await res.json();
      setHistList(data.conversations ?? []);
      // Xóa đúng cuộc đang mở → reset về phiên mới trống.
      if (id === activeConvId) {
        setItems([]);
        setConversationId(null);
        setActiveConvId(null);
        setSessionId(null);
        sessionBaselineRef.current = 0;
        localStorage.removeItem('bow-chat-items');
        localStorage.removeItem('bow-session-baseline');
      }
    } catch {
      setHistError('Xóa thất bại.');
    }
  };

  const [devRepoLabel, setDevRepoLabel] = useState('');
  const [devCwd, setDevCwd] = useState('');
  const [safeRepoLabel, setSafeRepoLabel] = useState('');
  const [safeCwd, setSafeCwd] = useState('');
  const [collabRepoLabel, setCollabRepoLabel] = useState('');
  const [collabCwd, setCollabCwd] = useState('');

  // Nạp repo của các chế độ khác khi là admin
  useEffect(() => {
    if (!cfg?.isAdmin) return;
    
    const fetchConfigs = () => {
      apiFetch('/api/config')
        .then((r) => r.json())
        .then((c) => {
          if (c.otherModes) {
            setDevRepoLabel(c.otherModes.dev.repoName);
            setDevCwd(c.otherModes.dev.defaultCwd);
            setSafeRepoLabel(c.otherModes.safe.repoName);
            setSafeCwd(c.otherModes.safe.defaultCwd);
            setCollabRepoLabel(c.otherModes.collab.repoName);
            setCollabCwd(c.otherModes.collab.defaultCwd);
          }
        })
        .catch(() => {});
    };

    fetchConfigs();
    const interval = setInterval(fetchConfigs, 5000); // cập nhật trạng thái folder mỗi 5s
    return () => clearInterval(interval);
  }, [cfg?.isAdmin]);

  const openPicker = (initialPath: string, target: 'cwd' | 'dev-cwd' | 'safe-cwd' | 'collab-cwd' = 'cwd') => {
    setPickerError('');
    setPickerTarget(target);
    setPickerOpen(true);
    fetchDirs(initialPath || cfg?.defaultCwd || '');
  };

  const applyPortCwd = async (target: 'dev-cwd' | 'safe-cwd' | 'collab-cwd', dir: string) => {
    try {
      const port = target === 'dev-cwd' ? 4000 : target === 'safe-cwd' ? 4001 : 4002;
      const res = await fetch(`http://localhost:${port}/api/safe-cwd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: dir }),
      });
      const data = await res.json();
      if (!res.ok) { setPickerError(data.error ?? 'Đổi source thất bại.'); return; }
      
      if (target === 'safe-cwd') {
        setSafeRepoLabel(data.repoName);
        setSafeCwd(data.cwd);
        if (cfg?.isSafeMode) {
          setCfg((c) => (c ? { ...c, defaultCwd: data.cwd, repoName: data.repoName } : c));
        }
      } else if (target === 'collab-cwd') {
        setCollabRepoLabel(data.repoName);
        setCollabCwd(data.cwd);
        if (cfg?.isCollabMode) {
          setCfg((c) => (c ? { ...c, defaultCwd: data.cwd, repoName: data.repoName } : c));
        }
      } else if (target === 'dev-cwd') {
        setDevRepoLabel(data.repoName);
        setDevCwd(data.cwd);
        if (!cfg?.isSafeMode && !cfg?.isCollabMode) {
          setCfg((c) => (c ? { ...c, defaultCwd: data.cwd, repoName: data.repoName } : c));
        }
      }
      setPickerOpen(false);
    } catch (err) {
      setPickerError((err as Error).message);
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
    // Lần đầu: theo cài đặt hệ điều hành. Sau đó ưu tiên lựa chọn user đã lưu.
    const saved = localStorage.getItem('bow-theme') as Theme | null;
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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

  // Tick 1s để đếm ngược tới giờ tự-chạy-tiếp — chỉ chạy khi có lịch (đỡ tốn khi rảnh).
  useEffect(() => {
    if (!autoResume) return;
    const id = setInterval(() => setResumeTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [autoResume]);

  // Dọn timer fallback client khi component unmount.
  useEffect(() => () => {
    if (clientResumeTimerRef.current) clearTimeout(clientResumeTimerRef.current);
  }, []);

  // Đồng hồ phiên: bấm giờ khi running bật, chốt thời lượng khi tắt (kể cả kết thúc
  // bất thường/stop — nên đo phía client thay vì chỉ dựa event 'result'). runStartedAt
  // đọc qua closure của render hiện tại, KHÔNG đưa vào deps (tránh vòng lặp tự kích).
  useEffect(() => {
    if (running) {
      setRunStartedAt(Date.now());
    } else if (runStartedAt != null) {
      setLastRunMs(Date.now() - runStartedAt);
      setRunStartedAt(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [isScrolled, setIsScrolled] = useState(false);
  const [activeQuery, setActiveQuery] = useState('');

  useEffect(() => {
    const lastQ = [...items].reverse().find((it) => it.kind === 'user')?.text || '';
    setActiveQuery(lastQ);
  }, [items]);

  const taskRef = useRef<HTMLTextAreaElement>(null);
  // Kết nối SSE hiện tại. Giữ ở ref để đảm bảo mỗi lúc chỉ có ĐÚNG MỘT EventSource
  // sống — nếu không, StrictMode (dev chạy effect 2 lần) hoặc reconnect chồng lấn sẽ
  // mở 2 SSE cùng session, backend phát event cho cả hai → mọi tin bị nhân đôi.
  const eventSourceRef = useRef<EventSource | null>(null);

  // ── Kéo giãn ô nhập (INPUT CHANNEL) ──
  // Chiều cao ô nhập task (px) người dùng tự kéo. null = mặc định (co theo nội dung).
  // Kéo dải mỏng ngay trên ô nhập; .chat phía trên tự co/giãn nhường chỗ.
  const [taskHeight, setTaskHeight] = useState<number | null>(() => {
    const saved = Number(localStorage.getItem('bow-task-height'));
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  });
  // Kéo lên = ô nhập cao thêm, xuống = thấp lại. Đo từ chiều cao THẬT lúc bắt đầu kéo
  // (getBoundingClientRect) để không nhảy giật. Kẹp trong [60, 55% cửa sổ] — chừa chỗ
  // cho phần đầu khung (chế độ/model…) + nút Chạy + vùng chat, không đẩy gì ra ngoài.
  const startTaskResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = taskRef.current?.getBoundingClientRect().height ?? 60;
    const maxH = () => Math.round(window.innerHeight * 0.55);
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(Math.max(startH + (startY - ev.clientY), 60), maxH());
      setTaskHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    // Chặn bôi đen text + đổi con trỏ toàn trang trong lúc kéo cho mượt.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  useEffect(() => {
    if (taskHeight == null) localStorage.removeItem('bow-task-height');
    else localStorage.setItem('bow-task-height', String(taskHeight));
  }, [taskHeight]);

  /** Bấm một gợi ý nhanh: điền sẵn task. */
  function applyQuickPrompt(qp: { text: string }) {
    if (running) return;
    setTask(qp.text);
    // Chờ state cập nhật rồi focus + đưa con trỏ về cuối để sửa tiếp.
    setTimeout(() => {
      const el = taskRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 0);
  }
  // Số item có TRƯỚC khi session hiện tại bắt đầu. Backend replay toàn bộ history
  // của session khi reconnect (refresh giữa chừng) → ta cắt items về mốc này rồi
  // dựng lại từ event, tránh nhân đôi mà vẫn giữ lịch sử các task cũ phía trên.
  const sessionBaselineRef = useRef(0);

  // Áp theme lên <html data-theme> và nhớ vào localStorage.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('bow-theme', theme);
  }, [theme]);

  // Áp màu nhấn lên <html data-accent> và nhớ. 'brass' = mặc định → gỡ attribute
  // để :root/[data-theme] chi phối (không cần block CSS riêng cho brass).
  useEffect(() => {
    if (accent === 'brass') document.documentElement.removeAttribute('data-accent');
    else document.documentElement.setAttribute('data-accent', accent);
    localStorage.setItem('bow-accent', accent);
  }, [accent]);

  // Migrate 1 lần: cuộc trò chuyện đang có trong localStorage (từ trước khi có tính năng
  // lịch sử) mà chưa gắn activeConvId → tạo thành bản ghi cuộc đầu tiên ở backend, không
  // để mất. persistActiveConversation tự sinh id + set activeConvId.
  useEffect(() => {
    if (!activeConvId && items.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      persistActiveConversation(items, conversationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        if (!cwd && c.defaultCwd) setCwd(c.defaultCwd);
        // Safe/QC Mode chỉ hỏi đáp read-only → LUÔN dùng Sonnet (nhẹ/rẻ), bất kể
        // localStorage. Backend cũng ép Sonnet ở mode này nên UI phải khớp để không
        // hiển thị Opus mà thực chất chạy Sonnet.
        if (c.isSafeMode) {
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

  // Collab Mode + admin (localhost): mở kênh SSE riêng nhận yêu cầu duyệt lệnh hủy hoại
  // từ CTV. Kênh toàn cục /api/admin/events (trên cả các cổng đang hoạt động).
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

  // Khôi phục phiên chạy cũ nếu có và đang hoạt động
  useEffect(() => {
    const savedSessionId = localStorage.getItem('bow-session-id');
    if (savedSessionId) {
      apiFetch(`/api/session/${savedSessionId}`)
        .then((r) => r.json())
        .then((data: { exists: boolean }) => {
          if (data.exists) {
            // Khôi phục mốc baseline đã lưu để replay không xóa lịch sử task cũ.
            const savedBase = Number(localStorage.getItem('bow-session-baseline'));
            sessionBaselineRef.current = Number.isFinite(savedBase) ? savedBase : 0;
            setSessionId(savedSessionId);
            setRunning(true);
            streamEvents(savedSessionId);
          } else {
            localStorage.removeItem('bow-session-id');
          }
        })
        .catch(() => {
          localStorage.removeItem('bow-session-id');
        });
    }
    // Không có phiên sống nhưng có conversationId → hỏi server còn lịch tự-chạy-tiếp treo
    // không (server còn giữ dù client từng đóng tab), để dựng lại thẻ đếm ngược.
    const savedConv = localStorage.getItem('bow-conversation-id');
    if (!savedSessionId && savedConv) {
      apiFetch(`/api/resume/pending?conversationId=${encodeURIComponent(savedConv)}`)
        .then((r) => r.json())
        .then((d: { pending: boolean; retryAt?: string }) => {
          if (d.pending && d.retryAt) {
            setAutoResume({
              retryAt: d.retryAt,
              resetsAt: null,
              attempt: 1,
              maxAttempts: 3,
              conversationId: savedConv,
            });
            // Đặt lại fallback client theo retryAt server báo.
            if (clientResumeTimerRef.current) clearTimeout(clientResumeTimerRef.current);
            const delay = Math.max(0, new Date(d.retryAt).getTime() - Date.now()) + 20_000;
            clientResumeTimerRef.current = setTimeout(() => {
              clientResumeTimerRef.current = null;
              triggerClientResume(savedConv);
            }, delay);
          }
        })
        .catch(() => { /* server có thể đã tắt — bỏ qua */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [items, pending]);

  const addItem = (kind: ChatItem['kind'], text: string, tool?: ChatItem['tool']) =>
    setItems((prev) => [...prev, { id: nextId(), kind, text, tool }]);

  async function addFiles(files: File[]) {
    for (const f of files) {
      if (f.type.startsWith('image/')) {
        const img = await readImage(f);
        setImages((prev) => [...prev, img]);
      } else if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
        const base64 = (await readDataUrl(f)).split(',')[1] ?? '';
        setPdfs((prev) => [...prev, { name: f.name, base64 }]);
      } else {
        const doc = await readText(f);
        setDocs((prev) => [...prev, doc]);
      }
    }
  }

  function onFiles(files: FileList | null) {
    if (!files) return;
    return addFiles(Array.from(files));
  }

  // Dán (Ctrl+V/Cmd+V) ảnh từ clipboard — chỉ nuốt sự kiện khi thực sự có file,
  // để dán text bình thường vẫn hoạt động.
  async function onPaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (!files.length) return;
    e.preventDefault();
    await addFiles(files);
  }

  // Prompt "tiếp tục" — khớp AUTO_RESUME_PROMPT ở server (dùng cho client-side fallback).
  const RESUME_PROMPT =
    'Phiên trước bị ngắt do hết hạn mức sử dụng. Hãy tiếp tục công việc đang làm dở từ chỗ ' +
    'bạn dừng lại, không cần hỏi lại từ đầu.';

  // Xoá mọi trạng thái lịch tự-chạy-tiếp: ẩn thẻ đếm ngược + huỷ timer fallback client.
  function clearAutoResume() {
    setAutoResume(null);
    if (clientResumeTimerRef.current) {
      clearTimeout(clientResumeTimerRef.current);
      clientResumeTimerRef.current = null;
    }
  }

  // Người dùng bấm "Huỷ tự chạy tiếp": báo server huỷ lịch + xoá trạng thái client.
  async function cancelAutoResume() {
    const cid = autoResume?.conversationId || conversationId;
    clearAutoResume();
    if (cid) {
      try {
        await apiFetch('/api/resume/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: cid }),
        });
      } catch {
        // Server có thể đã tắt — thẻ đã ẩn phía client là đủ.
      }
    }
    addItem('system', 'Đã huỷ tự động chạy tiếp.');
  }

  // Gửi một lượt "tiếp tục" resume phiên cũ. Dùng cho CLIENT-SIDE FALLBACK: khi tới giờ
  // reset mà server IM (đã tắt), client tự khởi động lại từ localStorage cấu hình đã lưu.
  async function triggerClientResume(cid: string) {
    if (running) return; // server đã tự chạy tiếp rồi → thôi
    const cfg = lastRunPayloadRef.current ?? {};
    setRunning(true);
    addItem('system', '⏳ Hết hạn mức đã reset — tự chạy tiếp phiên dở…');
    let res: Response;
    try {
      res = await apiFetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cfg, stack: stack || undefined, text: RESUME_PROMPT, conversationId: cid }),
      });
    } catch (err) {
      addItem('error', `Không tự chạy tiếp được: ${(err as Error).message}`);
      setRunning(false);
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'lỗi không rõ' }));
      addItem('error', body.error ?? `HTTP ${res.status}`);
      setRunning(false);
      return;
    }
    const { sessionId: sid } = await res.json();
    setSessionId(sid);
    localStorage.setItem('bow-session-id', sid);
    setItems((prev) => {
      sessionBaselineRef.current = prev.length;
      localStorage.setItem('bow-session-baseline', String(prev.length));
      return prev;
    });
    streamEvents(sid);
  }

  async function start() {
    if (running) return;
    const hasInput = task.trim() || docs.length || pdfs.length || images.length;
    if (!hasInput) return;

    // Giữ lịch sử cũ — task mới nối tiếp bên dưới (chat liên tục). Chỉ dọn approval/câu hỏi treo.
    setPending([]);
    setQuestions([]);
    setSelectedStepId(null); // bỏ chọn bước cũ khi bắt đầu task mới
    setRunning(true);

    // Chốt dữ liệu đầu vào vào biến local TRƯỚC khi xóa ô nhập, để vẫn gửi đúng
    // lên backend. Xóa ô nhập ngay sau khi gửi (hành vi chat quen thuộc).
    const sentText = task.trim();
    
    let sentJira = '';
    const selected = sentText.match(/[?&]selectedIssue=([A-Z][A-Z0-9]+-\d+)/i);
    const ticket = selected ?? sentText.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
    if (ticket) {
      sentJira = ticket[1].toUpperCase();
    } else {
      const board = sentText.match(/\/boards\/(\d+)/);
      if (board) {
        sentJira = `board ${board[1]}`;
      } else {
        const project = sentText.match(/\/projects\/([A-Z][A-Z0-9]+)/i);
        if (project) {
          sentJira = `project ${project[1].toUpperCase()}`;
        }
      }
    }

    const sentDocs = docs;
    const sentPdfs = pdfs;
    const sentImages = images;

    // Fallback trí nhớ: nếu vừa mở lại một cuộc cũ (needResumeContext), gửi kèm tóm tắt
    // hội thoại trước để agent giữ ngữ cảnh dù phiên SDK có thể đã bị dọn. Chỉ lượt đầu.
    const sentResumeContext = needResumeContext ? summarizeForResume(items) : '';
    if (needResumeContext) setNeedResumeContext(false);

    const parts = [
      sentJira && `[${sentJira}]`,
      sentText,
      sentDocs.length && `📄×${sentDocs.length}`,
      sentImages.length && `🖼×${sentImages.length}`,
    ].filter(Boolean);
    addItem('user', parts.join(' ') || '(đầu vào đính kèm)');

    // Xóa ô nhập + file đính kèm (task được persist nên xóa cả localStorage).
    setTask('');
    setDocs([]);
    setPdfs([]);
    setImages([]);

    // Nếu đang có lịch tự-chạy-tiếp treo (từ lượt trước), người dùng gửi tay = đã tiếp tục —
    // xoá thẻ đếm ngược + huỷ timer fallback client (server tự huỷ theo conversationId).
    clearAutoResume();

    // Lưu cấu hình chạy (không kèm file đính kèm/tài liệu — resume chỉ cần "tiếp tục") để
    // client-side fallback gửi lại được nếu server im lúc tới giờ reset.
    lastRunPayloadRef.current = {
      mcpServers: selectedMcps,
      mode,
      profile,
      effort,
      language,
      cwd: cwd.trim() || undefined,
      model: selectedModel,
    };

    let res: Response;
    try {
      res = await apiFetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: sentText || undefined,
          jiraRef: sentJira || undefined,
          docs: sentDocs.length ? sentDocs : undefined,
          pdfs: sentPdfs.length ? sentPdfs : undefined,
          images: sentImages.length ? sentImages : undefined,
          mcpServers: selectedMcps,
          stack: stack || undefined,
          mode,
          profile,
          effort,
          language,
          cwd: cwd.trim() || undefined,
          model: selectedModel,
          conversationId: conversationId || undefined,
          resumeContext: sentResumeContext || undefined,
        }),
      });
    } catch (err) {
      addItem('error', `Không gọi được backend: ${(err as Error).message}`);
      setRunning(false);
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'lỗi không rõ' }));
      addItem('error', body.error ?? `HTTP ${res.status}`);
      setRunning(false);
      return;
    }

    const { sessionId: sid } = await res.json();
    setSessionId(sid);
    // conversationId THẬT đến qua event SSE 'conversation' (session_id của SDK), không
    // phải từ response này — xử lý ở streamEvents. Lượt sau gửi lại để agent nhớ hội thoại.
    localStorage.setItem('bow-session-id', sid);
    // Mốc baseline = mọi item hiện có (gồm dòng 'user' vừa thêm). Session này sẽ
    // append event của nó SAU mốc này. Dùng updater để đọc độ dài items mới nhất.
    setItems((prev) => {
      sessionBaselineRef.current = prev.length;
      localStorage.setItem('bow-session-baseline', String(prev.length));
      return prev;
    });
    streamEvents(sid);
  }

  function streamEvents(sid: string) {
    // Đóng kết nối SSE cũ (nếu còn) TRƯỚC khi mở cái mới. Không có bước này thì
    // StrictMode (dev) hay reconnect chồng lấn sẽ để 2 EventSource cùng session
    // sống song song → mỗi event tới UI 2 lần → tin bị nhân đôi.
    eventSourceRef.current?.close();

    // Backend replay toàn bộ history của session này từ đầu. Cắt items về mốc
    // baseline (số item trước khi session bắt đầu) để dựng lại sạch, không nhân
    // đôi, mà vẫn giữ nguyên lịch sử các task cũ nằm phía trên baseline.
    setItems((prev) => prev.slice(0, sessionBaselineRef.current));
    setPending([]);
    setQuestions([]);
    const src = new EventSource(withToken(`/api/events/${sid}`));
    eventSourceRef.current = src;
    // Đóng SSE + xóa ref (chỉ khi ref vẫn trỏ chính src này, tránh xóa nhầm kết nối
    // mới hơn đã thay chỗ).
    const closeSrc = () => {
      src.close();
      if (eventSourceRef.current === src) eventSourceRef.current = null;
    };
    src.onmessage = (msg) => {
      const ev = JSON.parse(msg.data) as WebEvent;
      switch (ev.type) {
        case 'text':
          addItem('agent', ev.text);
          break;
        case 'tool':
          // Dedup theo toolId: replay lịch sử / 2 EventSource chồng lấn có thể giao
          // cùng một sự kiện tool nhiều lần → tránh nhân đôi dòng ở Activity Log.
          setItems((prev) =>
            ev.id && prev.some((it) => it.kind === 'tool' && it.tool?.toolId === ev.id)
              ? prev
              : [
                  ...prev,
                  {
                    id: nextId(),
                    kind: 'tool',
                    text: ev.describe,
                    tool: { toolId: ev.id, name: ev.name, summary: ev.summary },
                  },
                ],
          );
          break;
        case 'tool-result':
          // Khớp kết quả về đúng item tool (theo toolId) để hiện "→ ...".
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'tool' && it.tool?.toolId === ev.toolId
                ? { ...it, tool: { ...it.tool, result: ev.text, resultError: ev.isError } }
                : it,
            ),
          );
          break;
        case 'result':
          addItem(
            'result',
            `Xong · ${fmtDuration(ev.durationMs)} · ${ev.turns} lượt · ${ev.outputTokens} tokens · $${ev.costUsd.toFixed(4)}`,
          );
          setAccumulatedCost((prev) => prev + ev.costUsd);
          break;
        case 'usage':
          // Snapshot đầy đủ trong lượt chạy: hạn mức + context window THẬT của hội thoại.
          setUsage(ev.usage);
          break;
        case 'error':
          if (ev.isSessionLimit) {
            // Hết hạn mức phiên (5h). Server sẽ gửi 'auto-resume-scheduled' ngay sau đây
            // (nếu đủ điều kiện) — thẻ đếm ngược dựng từ event đó. Ở đây chỉ báo ngắn gọn.
            const when = ev.resetsAt ? formatResetIn(ev.resetsAt) : '';
            addItem('system', `⏸️ Hết hạn mức phiên (5h)${when ? ` · reset ${when.toLowerCase()}` : ''}. Đang chờ lịch tự chạy tiếp…`);
          } else {
            addItem('error', `Kết thúc bất thường: ${ev.subtype}`);
          }
          break;
        case 'auto-resume-scheduled': {
          // Server đã lên lịch tự chạy tiếp. Lưu để hiện thẻ đếm ngược + đặt fallback client.
          setAutoResume({
            retryAt: ev.retryAt,
            resetsAt: ev.resetsAt,
            attempt: ev.attempt,
            maxAttempts: ev.maxAttempts,
            conversationId,
          });
          addItem('system', `🕒 Sẽ tự chạy tiếp lúc ${new Date(ev.retryAt).toLocaleTimeString('vi-VN')} (lần ${ev.attempt}/${ev.maxAttempts}).`);
          // Fallback client: nếu tới giờ + 20s mà server chưa khởi động lại (running vẫn false),
          // client tự gọi. Server-first nên đệm thêm 20s để không chạy trùng.
          if (clientResumeTimerRef.current) clearTimeout(clientResumeTimerRef.current);
          const cid = conversationId;
          const delay = Math.max(0, new Date(ev.retryAt).getTime() - Date.now()) + 20_000;
          clientResumeTimerRef.current = setTimeout(() => {
            clientResumeTimerRef.current = null;
            if (cid) triggerClientResume(cid);
          }, delay);
          break;
        }
        case 'auto-resume-cancelled':
          clearAutoResume();
          if (ev.reason === 'exhausted') {
            addItem('error', `Đã tự chạy tiếp tối đa số lần cho phép mà vẫn hết hạn mức. Hãy tiếp tục thủ công khi hạn mức mở lại.`);
          }
          break;
        case 'approval-request':
          // Dedup theo id: replay lịch sử hoặc 2 EventSource chồng lấn (StrictMode /
          // reconnect) có thể giao CÙNG một approval-request nhiều lần → nếu chỉ append
          // sẽ hiện thẻ duyệt double. Bỏ qua khi id đã có trong hàng chờ.
          setPending((prev) =>
            prev.some((p) => p.id === ev.id)
              ? prev
              : [
                  ...prev,
                  {
                    id: ev.id,
                    toolName: ev.toolName,
                    input: ev.input,
                    title: ev.title,
                    description: ev.description,
                    blockedPath: ev.blockedPath,
                    decisionReason: ev.decisionReason,
                  },
                ],
          );
          break;
        case 'question-request':
          // Dedup theo id (xem giải thích ở approval-request) — tránh câu hỏi double.
          setQuestions((prev) =>
            prev.some((q) => q.id === ev.id)
              ? prev
              : [...prev, { id: ev.id, questions: ev.questions }],
          );
          break;
        case 'conversation':
          // session_id THẬT của SDK. Lưu để lượt sau gửi lại làm conversationId →
          // agent resume đúng phiên và nhớ toàn bộ hội thoại trước.
          setConversationId(ev.conversationId);
          // Phiên tự-chạy-tiếp đã KHỞI ĐỘNG (resume đúng hội thoại đang chờ) → xoá thẻ đếm
          // ngược + huỷ timer fallback client (tránh gọi trùng). setRunning(true) để UI khoá
          // ô nhập như một lượt chạy bình thường.
          setAutoResume((prev) => {
            if (prev && prev.conversationId === ev.conversationId) {
              if (clientResumeTimerRef.current) {
                clearTimeout(clientResumeTimerRef.current);
                clientResumeTimerRef.current = null;
              }
              setRunning(true);
              return null;
            }
            return prev;
          });
          break;
        case 'done':
          setRunning(false);
          localStorage.removeItem('bow-session-id');
          closeSrc();
          break;
        case 'fatal':
          addItem('error', ev.message);
          setRunning(false);
          localStorage.removeItem('bow-session-id');
          closeSrc();
          break;
      }
    };
    src.addEventListener('end', () => {
      setRunning(false);
      closeSrc();
    });
  }

  async function decide(approval: PendingApproval, approved: boolean) {
    setPending((prev) => prev.filter((p) => p.id !== approval.id));
    addItem('system', `${approved ? '✅ Cho phép' : '⛔ Từ chối'}: ${approval.toolName}`);
    await apiFetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, id: approval.id, approved }),
    }).catch(() => {});
  }

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

  /**
   * Trả lời một câu hỏi AskUserQuestion. answers=null = huỷ (agent nhận deny).
   * Ghi lại lựa chọn vào chat để có dấu vết, rồi gửi về backend giải Promise treo.
   */
  async function answerQuestion(q: PendingQuestion, answers: Record<string, string> | null) {
    setQuestions((prev) => prev.filter((x) => x.id !== q.id));
    if (answers) {
      const summary = Object.entries(answers)
        .map(([, val]) => `→ ${val}`)
        .join('\n');
      addItem('system', `💬 Bạn đã trả lời:\n${summary}`);
    } else {
      addItem('system', '⛔ Đã huỷ câu hỏi của agent.');
    }
    await apiFetch('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, id: q.id, answers }),
    }).catch(() => {});
  }

  async function stop() {
    if (!sessionId) return;
    setRunning(false);
    localStorage.removeItem('bow-session-id');
    addItem('system', '⏹ Yêu cầu dừng agent...');
    await apiFetch(`/api/stop/${sessionId}`, { method: 'POST' }).catch(() => {});
  }

  /**
   * Mở cửa sổ xác nhận xóa chat (không xóa ngay). Cho bấm CẢ KHI agent đang chạy —
   * lúc đó xác nhận sẽ dừng phiên rồi mới xóa (xem confirmClearChat). Chỉ chặn khi
   * chat hoàn toàn trống và không có gì đang chạy (không có gì để xóa).
   */
  function clearChat() {
    if (!items.length && !running) return;
    setConfirmClearOpen(true);
  }

  /**
   * Bắt đầu CUỘC TRÒ CHUYỆN MỚI sau khi người dùng xác nhận. KHÔNG mất cuộc cũ: nó đã
   * được auto-lưu bền ở backend (mở lại từ panel Lịch sử). Ở đây chỉ: dừng phiên đang
   * chạy (nếu có) → lưu chốt cuộc hiện tại lần cuối → dọn sạch màn hình + bỏ activeConvId
   * để lượt kế tạo bản ghi cuộc mới hoàn toàn (agent không nhớ hội thoại cũ).
   */
  async function confirmClearChat() {
    setConfirmClearOpen(false);
    // Dừng phiên đang chạy trước khi dọn — tránh event của phiên cũ đổ về sau khi đã dọn.
    if (running) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setRunning(false);
      if (sessionId) {
        await apiFetch(`/api/stop/${sessionId}`, { method: 'POST' }).catch(() => {});
      }
    }
    // Lưu chốt cuộc hiện tại lần cuối (auto-lưu có thể chưa kịp chạy debounce).
    // CHỈ dọn màn hình khi lưu thành công — nếu lưu lỗi, giữ nguyên tin nhắn để
    // người dùng không mất dữ liệu, và báo cho họ biết.
    if (items.length > 0) {
      const savedId = await persistActiveConversation(items, conversationId);
      if (!savedId) {
        addItem('error', 'Không lưu được cuộc trò chuyện hiện tại (mất kết nối tới máy chủ). Đã giữ nguyên tin nhắn — hãy thử lại khi có kết nối để tránh mất dữ liệu.');
        return;
      }
    }
    setItems([]);
    setPending([]);
    setQuestions([]);
    setSessionId(null);
    setConversationId(null);
    setActiveConvId(null); // cuộc kế tiếp = bản ghi mới
    setNeedResumeContext(false);
    setSelectedStepId(null);
    localStorage.removeItem('bow-conversation-id');
    localStorage.removeItem('bow-active-conv-id');
    localStorage.removeItem('bow-session-id');
    sessionBaselineRef.current = 0;
    localStorage.removeItem('bow-chat-items');
    localStorage.removeItem('bow-session-baseline');
  }

  async function genProfile() {
    if (running) return;
    setRunning(true);
    // Giữ lịch sử cũ, nối tiếp bên dưới (như start).
    addItem('system', `🔧 Đang quét repo để sinh profile: ${cwd}`);
    try {
      const res = await apiFetch('/api/generate-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: cwd.trim() || undefined }),
      });
      const { sessionId: sid } = await res.json();
      setSessionId(sid);
      localStorage.setItem('bow-session-id', sid);
      setItems((prev) => {
        sessionBaselineRef.current = prev.length;
        localStorage.setItem('bow-session-baseline', String(prev.length));
        return prev;
      });
      streamEvents(sid);
    } catch (err) {
      addItem('error', `Không sinh được profile: ${(err as Error).message}`);
      setRunning(false);
    }
  }

  const buildActivityNodes = () => {
    const nodes: ActivityNode[] = [];

    if (items.length > 0 || running) {
      nodes.push({
        id: 'start',
        type: 'start',
        label: 'Khởi động',
        detail: 'Đang gửi brief lên agent...',
      });
    }

    // Bộ tích lũy các tool thông thường (đọc/tìm/sửa code...) — giữ cả bản ĐẦY ĐỦ
    // từng thao tác (ops) để mở rộng xem "đã chạy lệnh gì / sửa file nào".
    let tempToolsCount: Record<string, number> = {};
    let tempToolsActive = false;
    let tempToolsIds: string[] = [];
    let tempOps: ToolDetail[] = [];
    // Số thứ tự nhóm trong lượt build. Dùng làm mỏ neo id BỀN cho node nhóm:
    // id không được phụ thuộc phần tử đầu (nó đổi khi có result/agent phụ xen
    // giữa gây flush), nếu không node sẽ đổi id mỗi lần stream và panel mở-rộng
    // tự sập vì expandedLogId không còn khớp node.id.
    let groupSeq = 0;

    const flushTempTools = () => {
      if (tempToolsIds.length > 0) {
        const details = Object.entries(tempToolsCount)
          .map(([txt, count]) => `• ${txt} (x${count})`)
          .join('\n');
        nodes.push({
          id: 'grouped-' + groupSeq++,
          type: 'tool', // Hành tinh xanh lá đại diện cho nhóm
          label: `⚙️ Xử lý mã nguồn (${tempToolsIds.length} thao tác)`,
          detail: `Chi tiết các thao tác thực hiện:\n${details}`,
          active: tempToolsActive,
          ops: tempOps,
        });
        tempToolsIds = [];
        tempToolsActive = false;
        tempToolsCount = {};
        tempOps = [];
      }
    };

    items.forEach((it) => {
      if (it.kind === 'tool') {
        const isAgentCall = it.text.includes('agent phụ:');

        if (isAgentCall) {
          // Dồn các tool thường tích lũy trước đó trước khi gọi agent phụ
          flushTempTools();

          const match = it.text.match(/agent phụ:\s*([a-zA-Z0-9_-]+)/i);
          const agentName = match ? match[1] : 'Subagent';

          nodes.push({
            id: it.id,
            type: 'thinking', // Sao xung tím
            label: `🤖 Gọi Agent phụ: ${agentName}`,
            detail: it.tool?.summary || it.text,
            active: false,
            ops: it.tool ? [it.tool] : undefined,
          });
        } else {
          // Tích lũy các tool đọc, tìm, sửa, chạy lệnh... vào nhóm
          const cleanText = it.text.replace(/ ×\d+$/, '');
          const countMatch = it.text.match(/×(\d+)$/);
          const increment = countMatch ? parseInt(countMatch[1], 10) : 1;

          tempToolsCount[cleanText] = (tempToolsCount[cleanText] || 0) + increment;
          tempToolsIds.push(it.id);
          if (it.tool) tempOps.push(it.tool);
        }
      } else {
        flushTempTools();
        
        if (it.kind === 'result') {
          nodes.push({
            id: it.id,
            type: 'result',
            label: 'Hoàn thành',
            detail: it.text,
          });
        } else if (it.kind === 'error') {
          nodes.push({
            id: it.id,
            type: 'error',
            label: 'Lỗi',
            detail: it.text,
          });
        }
      }
    });

    flushTempTools();

    pending.forEach((p) => {
      const bits = [p.title, p.description, p.blockedPath && `Đường dẫn bị chặn: ${p.blockedPath}`, p.decisionReason]
        .filter(Boolean)
        .join('\n');
      nodes.push({
        id: p.id,
        type: 'approval',
        label: `Chờ duyệt: ${p.toolName}`,
        detail: bits || '',
        active: true,
        approval: p,
      });
    });

    if (running && pending.length === 0) {
      nodes.push({
        id: 'thinking',
        type: 'thinking',
        label: 'Đang suy nghĩ...',
        active: true,
      });
    }

    return nodes;
  };

  const pipelineNodes = buildActivityNodes();

  const buildAgentNodes = () => {
    const rawNodes = pipelineNodes;
    const agentsMap = new Map<string, { id: string; label: string; type: string; detail: string; active: boolean }>();

    // Luôn hiển thị 4 default agents cốt lõi từ đầu
    agentsMap.set('main', {
      id: 'main',
      label: 'Bow Agent (Main)',
      type: 'approval', // Thái dương vàng
      detail: 'Agent chính điều phối và thực thi thay đổi.',
      active: false,
    });
    agentsMap.set('reviewer', {
      id: 'reviewer',
      label: 'Reviewer Agent',
      type: 'thinking', // Sao xung tím
      detail: 'Chưa hoạt động. Tự động kích hoạt khi có yêu cầu rà soát mã nguồn.',
      active: false,
    });
    agentsMap.set('verifier', {
      id: 'verifier',
      label: 'Verifier Agent',
      type: 'tool', // Hành tinh xanh lá
      detail: 'Chưa hoạt động. Tự động kích hoạt khi cần kiểm thử và xác minh thay đổi.',
      active: false,
    });
    agentsMap.set('impact-scout', {
      id: 'impact-scout',
      label: 'Impact Scout Agent',
      type: 'start', // Sao xanh lam khổng lồ
      detail: 'Chưa hoạt động. Tự động kích hoạt khi cần khảo sát tác động dự án.',
      active: false,
    });

    // Quét qua các node hoạt động để phát hiện các subagent
    rawNodes.forEach(node => {
      const lbl = node.label || '';
      // Tìm mẫu: "giao việc cho agent phụ: [tên]…"
      const match = lbl.match(/agent phụ:\s*([a-zA-Z0-9_-]+)/i);
      if (match && match[1]) {
        const agentName = match[1];
        const agentKey = agentName.toLowerCase();
        
        let type = 'thinking'; // Mặc định: sao xung tím
        if (agentKey === 'verifier') type = 'tool'; // Hành tinh xanh lá
        if (agentKey === 'impact-scout' || agentKey === 'scout') type = 'start'; // Sao xanh lam khổng lồ
        
        const isThisActive = !!node.active;
        const detail = isThisActive
          ? `ĐANG HOẠT ĐỘNG:\n${node.label}${node.detail ? `\n\nChi tiết: ${node.detail}` : ''}`
          : `Hoạt động gần nhất:\n${node.label}${node.detail ? `\n\nChi tiết: ${node.detail}` : ''}`;

        const existing = agentsMap.get(agentKey);
        if (existing) {
          if (isThisActive) {
            existing.active = true;
            existing.detail = detail;
          } else if (!existing.active) {
            existing.detail = detail;
          }
        } else {
          // Viết hoa chữ cái đầu
          const formattedLabel = agentName.charAt(0).toUpperCase() + agentName.slice(1) + ' Agent';
          agentsMap.set(agentKey, {
            id: agentKey,
            label: formattedLabel,
            type,
            detail,
            active: isThisActive,
          });
        }
      } else {
        // Cập nhật hoạt động cho Main Agent
        const main = agentsMap.get('main')!;
        const isThisActive = !!node.active;
        const detail = isThisActive
          ? `ĐANG HOẠT ĐỘNG:\n${node.label}${node.detail ? `\n\nChi tiết: ${node.detail}` : ''}`
          : `Hoạt động gần nhất:\n${node.label}${node.detail ? `\n\nChi tiết: ${node.detail}` : ''}`;

        if (isThisActive) {
          main.active = true;
          main.detail = detail;
        } else if (!main.active && node.type !== 'start') {
          main.detail = detail;
        }
      }
    });

    // Nếu chạy mà chưa có subagent nào hoạt động, thì kích hoạt Main Agent
    const hasActiveSub = Array.from(agentsMap.values()).some(a => a.id !== 'main' && a.active);
    if (running) {
      const main = agentsMap.get('main')!;
      main.active = !hasActiveSub;
    } else {
      agentsMap.get('main')!.active = false;
    }

    return Array.from(agentsMap.values());
  };

  const agentNodes = buildAgentNodes();
  const lastUserQuery = [...items].reverse().find((it) => it.kind === 'user')?.text;

  const itemToQueryMap = new Map<string, string>();
  let currentQueryText = '';
  for (const it of items) {
    if (it.kind === 'user') {
      currentQueryText = it.text;
    }
    if (currentQueryText) {
      itemToQueryMap.set(it.id, currentQueryText);
    }
  }

  // Safe Mode (QC hỏi đáp read-only): ẩn bớt các nút/điều khiển kỹ thuật, khoá repo.
  // Bật bằng cách chạy `npm run ui:safe` (đặt BOW_SAFE_MODE=true ở backend).
  const safe = cfg ? !!cfg.isSafeMode : true;
  const collab = cfg ? !!cfg.isCollabMode : false;
  const pendingAccessCount = accessUsers.filter((u) => u.status === 'pending').length;
  // Tên repo hiển thị ở badge "Source" trên header:
  // - Safe Mode: repo bị khoá vào cfg (safeCwd) → dùng repoName/defaultCwd từ backend.
  // - Thường: repo là cwd người dùng đang chọn ở composer (thứ lượt chạy sẽ dùng) →
  //   lấy tên thư mục từ chính cwd, để QC/mọi người luôn biết đang hỏi source nào.
  const cwdRepoLabel = cwd?.trim() ? cwd.trim().split('/').filter(Boolean).pop() : '';
  const localSafeRepoLabel = cfg?.repoName || (cfg?.defaultCwd ? cfg.defaultCwd.split('/').filter(Boolean).pop() : '') || 'monorepo';
  const repoLabel = safe ? localSafeRepoLabel : (cwdRepoLabel || '(chưa chọn)');

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
          {gateState === 'checking' && (
            <p className="access-gate-hint">Đang kiểm tra quyền truy cập…</p>
          )}
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
    <div className={`app${safe ? ' safe-mode' : ''}${collab ? ' collab-mode' : ''}`}>
      {collab && (
        <div className="collab-banner" role="status">
          🤝 <strong>Collab Mode</strong> — bạn code như dev; lệnh hủy hoại (xoá, deploy, ghi ngoài repo)
          {cfg?.isAdmin ? ' bạn tự duyệt.' : ' cần admin duyệt từ xa. Git tự do.'}
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
            <>
              {devRepoLabel && (
                <button
                  className="readout readout-btn"
                  title={`Dev Mode Repo: ${devCwd} — bấm để đổi`}
                  onClick={() => openPicker(devCwd || '', 'dev-cwd')}
                >
                  <span className="rl">Dev Src</span>
                  <span className="rv" style={{ color: 'var(--brass)' }}>{devRepoLabel}</span>
                </button>
              )}
              {safeRepoLabel && (
                <button
                  className="readout readout-btn"
                  title={`Safe Mode Repo: ${safeCwd} — bấm để đổi`}
                  onClick={() => openPicker(safeCwd || '', 'safe-cwd')}
                >
                  <span className="rl">Safe Src</span>
                  <span className="rv" style={{ color: 'var(--teal)' }}>{safeRepoLabel}</span>
                </button>
              )}
              {collabRepoLabel && (
                <button
                  className="readout readout-btn"
                  title={`Collab Mode Repo: ${collabCwd} — bấm để đổi`}
                  onClick={() => openPicker(collabCwd || '', 'collab-cwd')}
                >
                  <span className="rl">Collab Src</span>
                  <span className="rv" style={{ color: 'var(--red)' }}>{collabRepoLabel}</span>
                </button>
              )}
            </>
          ) : (
            (safe || collab) && (
              <span className="readout" title={`Đang hỏi đáp source: ${repoLabel}`}>
                <span className="rl">Source</span>
                <span className="rv" style={{ color: 'var(--brass)' }}>{repoLabel}</span>
              </span>
            )
          )}
          <span className="readout" title="Giờ UTC">
            <span className="rl">UTC</span>
            <span className="rv">{utc}</span>
          </span>
          {/* Đồng hồ phiên: đang chạy → tick mỗi giây (nhờ interval UTC); xong → đứng ở
              tổng thời lượng lượt gần nhất. Ẩn khi chưa chạy lượt nào. */}
          {(running && runStartedAt != null) || lastRunMs != null ? (
            <span
              className="readout"
              title={
                running
                  ? 'Thời gian lượt chạy hiện tại (tính cả lúc chờ duyệt)'
                  : 'Thời lượng lượt chạy gần nhất'
              }
            >
              <span className="rl">Time</span>
              <span className="rv" style={{ color: running ? 'var(--brass)' : undefined }}>
                {running && runStartedAt != null
                  ? fmtDuration(Date.now() - runStartedAt)
                  : fmtDuration(lastRunMs!)}
              </span>
            </span>
          ) : null}
          {!safe && (
            <span className="readout" title="Chi phí tích lũy phiên này">
              <span className="rl">Cost</span>
              <span className="rv" style={{ color: accumulatedCost > 2 ? 'var(--danger)' : undefined }}>
                ${accumulatedCost.toFixed(4)}
              </span>
            </span>
          )}
          {!safe && (
            <span className="readout" title={modeDef(mode).desc}>
              <span className="rl">Mode</span>
              <span className={`rv mode-${mode}`}>
                {modeDef(mode).short}
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
          {!safe && (() => {
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
          {!safe && (() => {
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
                <span className="rl">Context</span>
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
          <div className="lang-select" title="Ngôn ngữ trả lời của agent">
            <PixelSelect
              value={language}
              onChange={setLanguage}
              direction="down"
              options={[
                { value: 'vi', label: 'Tiếng Việt' },
                { value: 'en', label: 'English' },
              ]}
            />
          </div>
          <button
            className="theme-btn"
            title="Lịch sử — các cuộc trò chuyện đã lưu (mở lại, đổi tên, xóa)"
            onClick={openHistPanel}
          >
            <Icon name="history" size={18} />
          </button>
          <button
            className="theme-btn"
            title="Chat nhóm — nhắn tin với đồng nghiệp cùng mạng (vào phòng theo mã, đặt biệt danh)"
            onClick={openChatPanel}
          >
            <Icon name="chat" size={18} />
          </button>
          {/* Admin: MCP CHUNG (mọi mode trừ Safe read-only). User LAN đã duyệt: MCP RIÊNG
              của họ — hiện KỂ CẢ Safe/Collab, vì chỉ ảnh hưởng chính họ, không đụng chung. */}
          {((cfg?.isAdmin && !safe) || (!cfg?.isAdmin && gateState === 'open')) && (
            <button
              className="theme-btn"
              title={cfg?.isAdmin ? 'Quản lý MCP server chung (Jira/Supabase/... cho agent)' : 'MCP riêng của bạn (ghi đè MCP trùng tên do admin cấu hình)'}
              onClick={openMcpPanel}
            >
              <Icon name="mcp" size={18} />
            </button>
          )}
          {!safe && (
            <button
              className="theme-btn"
              title="Workspace — nhóm nhiều repo (BE/FE/...) thành 1 sản phẩm + trí nhớ chung"
              onClick={openWsPanel}
            >
              <Icon name="routing" size={18} />
            </button>
          )}

          {cfg?.isAdmin && (
            <button
              className={`theme-btn${pendingAccessCount > 0 ? ' has-pending' : ''}`}
              title={`LAN Dashboard — Quản lý thiết bị & xem log hoạt động${pendingAccessCount > 0 ? ` (${pendingAccessCount} yêu cầu đang chờ)` : ''}`}
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
          <AccentPicker value={accent} options={ACCENTS} onChange={(id) => setAccent(id as Accent)} />
          <button
            className="theme-btn"
            title={theme === 'light' ? 'Chuyển giao diện tối' : 'Chuyển giao diện sáng'}
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            <Icon name={theme === 'light' ? 'moon' : 'sun'} size={18} />
          </button>
        </div>
      </header>

      <div className="main-layout">
        <aside className="sidebar-pipeline">
          {/* Usage (Session 5hr + Context) đã chuyển lên header cho gọn. */}
          <div className="sidebar-pipeline-title">Star Chart</div>
          <div className="neural-net-container">
            <NeuralBrain
              active={running}
              steps={agentNodes}
              selectedId={selectedStepId}
              onSelect={(s) => setSelectedStepId((prev) => (prev === s.id ? null : s.id))}
              theme={theme}
              accent={accent}
            />
          </div>

          {/* Chi tiết bước được bấm trên bản đồ vũ trụ — "đang làm gì ở bước đó". */}
          {(() => {
            const sel = selectedStepId ? agentNodes.find((n) => n.id === selectedStepId) : null;
            if (!sel) {
              return (
                <div className="step-detail step-detail-empty">
                  Bấm vào một thiên thể hoặc chòm sao để xem chi tiết bước hoạt động.
                </div>
              );
            }
            return (
              <div className={`step-detail step-${sel.type}`}>
                <div className="step-detail-head">
                  <span className="step-detail-label">
                    {sel.active && <Icon name="pending" size={14} className="step-detail-spin" />}{sel.label}
                  </span>
                  <button
                    className="step-detail-close"
                    title="Đóng"
                    onClick={() => setSelectedStepId(null)}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
                {sel.detail && <div className="step-detail-body" style={{ whiteSpace: 'pre-wrap' }}>{sel.detail}</div>}
              </div>
            );
          })()}

          <div className="sidebar-pipeline-title" style={{ marginTop: '4px', borderTop: 'var(--bd-thin) solid var(--outline)', paddingTop: '12px' }}>
            Activity Log
          </div>

          <div className="pipeline-flow" style={{ flex: 1, overflowY: 'auto' }}>
            {pipelineNodes.map((node) => {
              let dotClass = '';
              let dotIcon: IconName = 'dot';
              if (node.active) {
                dotClass = 'active';
                dotIcon = 'pending';
              } else if (node.type === 'result') {
                dotClass = 'success';
                dotIcon = 'success';
              } else if (node.type === 'error') {
                dotClass = 'error';
                dotIcon = 'error';
              } else if (node.type === 'tool') {
                dotIcon = 'tool';
              } else if (node.type === 'approval') {
                dotClass = 'active';
                dotIcon = 'block';
              }

              const expanded = expandedLogId === node.id;
              // Có gì để mở rộng: danh sách thao tác con, detail dài, hoặc thông tin duyệt.
              const hasDetail =
                (node.ops && node.ops.length > 0) || !!node.detail || !!node.approval;
              // Dòng preview 1 hàng khi CHƯA mở. Với node có thao tác con, ưu tiên hiện
              // thao tác GẦN NHẤT (đã làm gì cụ thể) thay vì dòng tiêu đề "Chi tiết...".
              let preview = node.detail ? node.detail.split('\n')[0] : '';
              if (node.ops && node.ops.length > 0) {
                const last = node.ops[node.ops.length - 1];
                preview = last.summary ? `${last.name}: ${last.summary}` : last.name;
              }

              return (
                <div
                  key={node.id}
                  className={`pipeline-item${hasDetail ? ' clickable' : ''}${expanded ? ' expanded' : ''}`}
                  onClick={
                    hasDetail
                      ? () => setExpandedLogId((prev) => (prev === node.id ? null : node.id))
                      : undefined
                  }
                >
                  <div className="pipeline-item-row">
                    <div className={`pipeline-dot ${dotClass}${dotIcon === 'pending' ? ' spin' : ''}`}>
                      <Icon name={dotIcon} size={14} />
                    </div>
                    <div className="pipeline-content">
                      <div className="pipeline-label">
                        {node.label}
                        {hasDetail && (
                          <span className="pipeline-caret">
                            <Icon name={expanded ? 'caretDown' : 'caretRight'} size={14} />
                          </span>
                        )}
                      </div>
                      {!expanded && preview && <div className="pipeline-detail">{preview}</div>}
                    </div>
                  </div>

                  {/* Luôn render (không mount/unmount) để animate mở/đóng mượt bằng grid-rows. */}
                  <div className={`pipeline-expand-wrap${expanded ? ' open' : ''}`} aria-hidden={!expanded}>
                    <div className="pipeline-expand-inner">
                      <div className="pipeline-expand" onClick={(e) => e.stopPropagation()}>
                        {/* Danh sách thao tác con: đã chạy lệnh gì / đọc-sửa file nào + kết quả. */}
                        {node.ops && node.ops.length > 0 && (
                          <ul className="op-list">
                            {node.ops.map((op, i) => (
                              <li key={op.toolId || i} className={`op-row${op.resultError ? ' op-error' : ''}`}>
                                <div className="op-head">
                                  <span className="op-name">{op.name}</span>
                                  {op.summary && <span className="op-summary">{op.summary}</span>}
                                </div>
                                {op.result && (
                                  <div className="op-result">
                                    <span className="op-arrow"><Icon name="caretRight" size={13} /></span>
                                    <Markdown text={op.result} />
                                  </div>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}

                        {/* Chi tiết yêu cầu duyệt. */}
                        {node.approval && (
                          <div className="approval-detail">
                            <div>
                              <b>Tool:</b> {node.approval.toolName}
                            </div>
                            {node.approval.title && <div>{node.approval.title}</div>}
                            {node.approval.description && <div>{node.approval.description}</div>}
                            {node.approval.blockedPath && (
                              <div className="op-error"><Icon name="lock" size={13} /> {node.approval.blockedPath}</div>
                            )}
                            {node.approval.decisionReason && (
                              <div className="approval-reason">{node.approval.decisionReason}</div>
                            )}
                            <div className="approval-hint">
                              Bấm nút Cho phép / Từ chối ở khung chat để tiếp tục.
                            </div>
                          </div>
                        )}

                        {/* Node không có ops/approval (start/result/error/agent phụ): hiện detail đầy đủ (markdown). */}
                        {!node.ops?.length && !node.approval && node.detail && (
                          <div className="pipeline-expand-text md-compact">
                            <Markdown text={node.detail} />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {pipelineNodes.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '28px 12px', fontSize: '13px', lineHeight: 1.5 }}>
                Chưa có tiến trình hoạt động
              </div>
            )}
          </div>
        </aside>

        <div className="chat-container">
          {isScrolled && activeQuery && (
            <button
              type="button"
              className="chat-pinned-query"
              key={activeQuery}
              title={`${activeQuery}\n(bấm để cuộn tới câu hỏi này)`}
              onClick={() => {
                // Cuộn tới ĐÚNG câu user đang hiển thị trên pill. Tìm item 'user' cuối
                // cùng có text khớp activeQuery (khớp bản đã gom khoảng trắng để an toàn),
                // rồi đưa phần tử data-id của nó lên đầu vùng cuộn.
                const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
                const target = [...items]
                  .reverse()
                  .find((it) => it.kind === 'user' && norm(it.text) === norm(activeQuery));
                const container = scrollRef.current;
                if (!target || !container) return;
                const el = container.querySelector<HTMLElement>(`[data-id="${target.id}"]`);
                if (!el) return;
                // Chừa 8px phía trên cho thoáng; cuộn mượt trong khung chat.
                container.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior: 'smooth' });
              }}
            >
              <span className="pinned-icon"><Icon name="pin" size={14} /></span>
              <span className="pinned-text">{activeQuery.replace(/\s+/g, ' ')}</span>
              <span className="pinned-up"><Icon name="caretUp" size={14} /></span>
            </button>
          )}
          <div
            className="chat"
            ref={scrollRef}
            onScroll={(e) => {
              const container = e.currentTarget;
              const scrollTop = container.scrollTop;
              setIsScrolled(scrollTop > 60);

              const children = Array.from(container.children) as HTMLElement[];
              const threshold = scrollTop + 24;
              let currentActiveId = '';

              for (const child of children) {
                const childBottom = child.offsetTop + child.offsetHeight;
                if (childBottom > threshold) {
                  const id = child.getAttribute('data-id');
                  if (id) {
                    currentActiveId = id;
                    break;
                  }
                }
              }

              if (currentActiveId) {
                const q = itemToQueryMap.get(currentActiveId);
                if (q) {
                  setActiveQuery(q);
                  return;
                }
              }

              const lastQ = [...items].reverse().find((it) => it.kind === 'user')?.text || '';
              setActiveQuery(lastQ);
            }}
          >
        {items.length === 0 && !running && (
          <div className="empty">
            Nhập đề tài / task, dán Jira ticket hoặc URL board, kéo-thả tài liệu &amp; ảnh
            (wireframe) vào đây.
            <br />
            Agent tự nhận diện <b>source</b> từ thư mục repo.
          </div>
        )}
        {(() => {
          // Gộp các dòng tool LIÊN TIẾP (đọc file, tìm code, chạy lệnh…) thành MỘT
          // nhóm gấp/mở gọn, thay vì đổ hàng chục dòng "đọc file…" ra khung chat.
          // Các dòng khác (user hỏi / agent trả lời / kết quả) vẫn hiện inline như cũ.
          // Riêng "gọi agent phụ" giữ nguyên là 1 dòng riêng vì đó là mốc đáng chú ý.
          const isAgentCall = (it: ChatItem) =>
            it.kind === 'tool' && it.text.includes('agent phụ');

          type Row =
            | { kind: 'item'; it: ChatItem }
            | { kind: 'group'; id: string; tools: ChatItem[] };
          const rows: Row[] = [];
          let buf: ChatItem[] = [];
          const flush = () => {
            if (buf.length === 0) return;
            if (buf.length === 1) {
              // 1 tool đơn lẻ: không cần gộp, hiện thẳng cho gọn.
              rows.push({ kind: 'item', it: buf[0] });
            } else {
              rows.push({ kind: 'group', id: `tg-${buf[0].id}`, tools: buf });
            }
            buf = [];
          };
          items.forEach((it) => {
            if (it.kind === 'tool' && !isAgentCall(it)) {
              buf.push(it);
            } else {
              flush();
              rows.push({ kind: 'item', it });
            }
          });
          flush();

          const lastToolItem = running && pending.length === 0 && questions.length === 0
            ? [...items].reverse().find((n) => n.kind === 'tool')
            : undefined;

          return rows.map((row) => {
            if (row.kind === 'group') {
              const open = expandedChatGroups.has(row.id);
              const groupRunning = lastToolItem
                ? row.tools.some((t) => t.id === lastToolItem.id)
                : false;
              // Đếm theo nhãn để hiện "đọc file… ×3" cho gọn.
              const counts: Record<string, number> = {};
              row.tools.forEach((t) => {
                counts[t.text] = (counts[t.text] || 0) + 1;
              });
              const summary = Object.entries(counts)
                .map(([txt, c]) => (c > 1 ? `${txt} ×${c}` : txt))
                .join(' · ');
              return (
                <div
                  key={row.id}
                  className={`bubble tool tool-group${groupRunning ? ' running' : ''}`}
                >
                  <button
                    type="button"
                    className="tool-group-head"
                    onClick={() =>
                      setExpandedChatGroups((prev) => {
                        const next = new Set(prev);
                        next.has(row.id) ? next.delete(row.id) : next.add(row.id);
                        return next;
                      })
                    }
                  >
                    <Icon name={open ? 'caretDown' : 'caretRight'} size={13} />
                    <span className="tool-group-title">
                      ⚙️ {row.tools.length} thao tác mã nguồn
                    </span>
                    {!open && <span className="tool-group-preview">{summary}</span>}
                  </button>
                  {open && (
                    <ul className="tool-group-list">
                      {row.tools.map((t) => (
                        <li key={t.id} className="tool-group-row">
                          <span className="tg-name">{t.text}</span>
                          {t.tool?.summary && (
                            <span className="tg-summary">{t.tool.summary}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            }

            const it = row.it;
            const isLastToolRunning = lastToolItem?.id === it.id;
            return (
              <div
                key={it.id}
                data-id={it.id}
                className={`bubble ${it.kind}${isLastToolRunning ? ' running' : ''}`}
              >
                {it.kind === 'agent' ? <Markdown text={it.text} /> : it.text}
              </div>
            );
          });
        })()}
        {running && pending.length === 0 && questions.length === 0 && (
          <div className="thinking">
            Agent đang làm việc
            <span className="thinking-dots"><i></i><i></i><i></i></span>
          </div>
        )}
      </div>

      {/* Thẻ tự-chạy-tiếp: hiện khi phiên dừng vì hết hạn mức 5h và server đã lên lịch.
          Đếm ngược tới giờ reset; người dùng có thể huỷ để tự tiếp tục thủ công. */}
      {autoResume && (
        <div className="chat-action-dock">
          <div className="auto-resume-card" data-tick={resumeTick}>
            <div className="auto-resume-head">
              <Icon name="pending" size={16} /> Hết hạn mức phiên (5h) — sẽ tự chạy tiếp
            </div>
            <div className="auto-resume-body">
              Tự động resume phiên và tiếp tục việc dở sau{' '}
              <strong className="auto-resume-count">{formatCountdown(autoResume.retryAt)}</strong>
              {' '}(lần {autoResume.attempt}/{autoResume.maxAttempts}).
              {autoResume.resetsAt && (
                <span className="auto-resume-when">
                  {' '}Hạn mức reset lúc {new Date(autoResume.resetsAt).toLocaleTimeString('vi-VN')}.
                </span>
              )}
            </div>
            <div className="auto-resume-actions">
              <button className="btn deny" onClick={cancelAutoResume}>Huỷ tự chạy tiếp</button>
            </div>
          </div>
        </div>
      )}

      {/* Bến neo hành động — khung duyệt / câu hỏi ghim ngay trên composer, LUÔN
          hiển thị (không nằm trong vùng cuộn) nên nút bấm không bao giờ bị khuất.

          CHỈ hiện MỘT thẻ tại một thời điểm: agent chờ duyệt tuần tự (canUseTool
          block từng tool), nên xếp chồng nhiều thẻ chỉ làm tràn màn hình và giấu
          mất nút Cho phép/Từ chối. Ưu tiên approval trước, rồi tới câu hỏi. Số thẻ
          còn lại trong hàng chờ hiện ở badge để người dùng biết còn việc phía sau. */}
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
                    ({a.apiOrigin.includes('4002') ? 'Collab' : a.apiOrigin.includes('4001') ? 'Safe' : 'Dev'})
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
      {(pending.length > 0 || questions.length > 0) && (() => {
        const p = pending[0];
        const q = !p ? questions[0] : undefined;
        const queued = pending.length + questions.length - 1;
        return (
        <div className="chat-action-dock">
          {queued > 0 && (
            <div className="action-queue-badge">
              <Icon name="pending" size={13} /> Còn {queued} yêu cầu nữa trong hàng chờ
            </div>
          )}
          {p && (
            <div key={p.id} className="approval">
              <div className="approval-head">
                <Icon name="block" size={16} /> {p.title || `Cần duyệt: ${p.toolName}`}
              </div>
              <div className="approval-body-custom">
                {p.description && <div className="approval-desc">{p.description}</div>}
                {p.blockedPath && (
                  <div className="approval-path">
                    <Icon name="warning" size={14} /> Đường dẫn bị chặn: <code>{p.blockedPath}</code>
                  </div>
                )}
                {p.decisionReason && (
                  <div className="approval-reason"><Icon name="info" size={14} /> Lý do: {p.decisionReason}</div>
                )}

                {p.toolName === 'Bash' && typeof p.input?.command === 'string' ? (
                  <div className="approval-code-block">
                    <div className="block-title">Lệnh chạy:</div>
                    <pre>
                      <code>{p.input.command}</code>
                    </pre>
                  </div>
                ) : p.toolName === 'write_file' || p.toolName === 'write_to_file' ? (
                  <div className="approval-code-block">
                    <div className="block-title">
                      Ghi tệp:{' '}
                      <code>{String(p.input?.path || p.input?.TargetFile || '')}</code>
                    </div>
                    {typeof (p.input?.content || p.input?.CodeContent) === 'string' && (
                      <pre>
                        <code>
                          {String(p.input.content || p.input.CodeContent).slice(0, 1000)}
                        </code>
                      </pre>
                    )}
                  </div>
                ) : p.toolName === 'edit_file' || p.toolName === 'replace_file_content' ? (
                  <div className="approval-code-block">
                    <div className="block-title">
                      Chỉnh sửa tệp:{' '}
                      <code>{String(p.input?.path || p.input?.TargetFile || '')}</code>
                    </div>
                    {typeof p.input?.TargetContent === 'string' && p.input.TargetContent && (
                      <>
                        <div className="diff-label deletion">- Tìm kiếm (cũ):</div>
                        <pre className="diff-del">
                          <code>{p.input.TargetContent}</code>
                        </pre>
                      </>
                    )}
                    {typeof p.input?.ReplacementContent === 'string' && p.input.ReplacementContent && (
                      <>
                        <div className="diff-label addition">+ Thay thế (mới):</div>
                        <pre className="diff-add">
                          <code>{p.input.ReplacementContent}</code>
                        </pre>
                      </>
                    )}
                  </div>
                ) : (
                  <pre>
                    <code>{JSON.stringify(p.input ?? {}, null, 2).slice(0, 1200)}</code>
                  </pre>
                )}
              </div>
              <div className="approval-actions">
                <button className="btn allow" onClick={() => decide(p, true)}>
                  Cho phép
                </button>
                <button className="btn deny" onClick={() => decide(p, false)}>
                  Từ chối
                </button>
              </div>
            </div>
          )}
          {q && (
            <QuestionCard
              key={q.id}
              pending={q}
              onSubmit={(answers) => answerQuestion(q, answers)}
              onCancel={() => answerQuestion(q, null)}
            />
          )}
        </div>
        );
      })()}

      <div
        className="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onFiles(e.dataTransfer.files);
        }}
      >
        <div className="controls">
          {/* Safe/QC Mode: backend ép chế độ 'plan' → ẩn ô Chế độ (chọn cũng vô nghĩa).
              Vẫn cho QC đổi Model/Profile/Effort để chọn model nhẹ hơn khi hỏi. */}
          {!safe && (
          <div className="field">
            Chế độ:
            <ModeSelect value={mode} onChange={setMode} disabled={running} />
          </div>
          )}
          {safe ? (
            // Safe/QC Mode cố định Sonnet (backend cũng ép) → khoá picker, chỉ hiện nhãn.
            <label>
              Model:
              <PixelSelect
                value="claude-sonnet-5"
                onChange={() => {}}
                disabled
                options={[{ value: 'claude-sonnet-5', label: 'Sonnet 5' }]}
              />
            </label>
          ) : (
          <label>
            Model:
            <PixelSelect
              value={selectedModel}
              onChange={setSelectedModel}
              disabled={running}
              options={[
                { value: 'claude-opus-4-8', label: 'Opus 4.8' },
                { value: 'claude-sonnet-5', label: 'Sonnet 5' },
                { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
              ]}
            />
          </label>
          )}
          <label>
            Profile:
            <PixelSelect
              value={profile}
              onChange={setProfile}
              disabled={running}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'none', label: 'None' },
              ]}
            />
          </label>
          {/* Stack skill external (RN+Supabase, …) — chỉ hiện khi registry admin duyệt có stack.
              Chọn stack → backend tải bộ skill của stack (repo GitHub ghim tag) rồi trải vào
              .claude/skills/ cho agent dùng. 'Không' = chỉ skill nội bộ. */}
          {skillStacks.length > 0 && (
            <label>
              Stack:
              <PixelSelect
                value={stack}
                onChange={setStack}
                disabled={running}
                options={[
                  { value: '', label: 'Không (mặc định)' },
                  ...skillStacks.map((s) => ({ value: s.id, label: s.label })),
                ]}
              />
            </label>
          )}
          {cfg?.claudeProfiles && cfg.claudeProfiles.length > 0 && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              Tài khoản:
              <PixelSelect
                value={cfg.currentClaudeProfile || 'default'}
                disabled={running}
                onDelete={async (profileToDelete) => {
                  setTimeout(async () => {
                    const confirmDel = await showClaudePrompt(
                      'Xác nhận Xóa',
                      `Bạn có chắc chắn muốn xóa tài khoản 'claude-${profileToDelete}'? Nhập chữ "xoa" để xác nhận:`
                    );
                    if (confirmDel !== 'xoa') {
                      if (confirmDel !== null) {
                        await showClaudeAlert('Lỗi', 'Xác nhận xóa không chính xác.');
                      }
                      return;
                    }
                    try {
                      const res = await apiFetch('/api/profiles', {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ profile: profileToDelete }),
                      });
                      if (res.ok) {
                        const configRes = await apiFetch('/api/config');
                        if (configRes.ok) {
                          const newCfg = await configRes.json();
                          setCfg(newCfg);
                          if (newCfg.mcpServers) {
                            setSelectedMcps(newCfg.mcpServers);
                          }
                        }
                        await showClaudeAlert('Thành công', `Đã xóa tài khoản 'claude-${profileToDelete}'.`);
                      } else {
                        const err = await res.json();
                        await showClaudeAlert('Lỗi', `Lỗi: ${err.error || 'Không thể xóa tài khoản'}`);
                      }
                    } catch (e) {
                      console.error('Lỗi khi xóa tài khoản:', e);
                    }
                  }, 100);
                }}
                onChange={async (newProfile) => {
                  if (running) return;
                  if (newProfile === '__new__') {
                    setTimeout(async () => {
                      const name = await showClaudePrompt('Tài khoản mới', 'Nhập tên tài khoản Claude mới (chỉ dùng chữ thường không dấu, số, gạch ngang, ví dụ: personal, work):');
                      if (!name) return;
                      const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
                      if (!cleaned) {
                        await showClaudeAlert('Lỗi', 'Tên tài khoản không hợp lệ.');
                        return;
                      }
                      try {
                        const res = await apiFetch('/api/profiles', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ profile: cleaned }),
                        });
                        if (res.ok) {
                          const configRes = await apiFetch('/api/config');
                          if (configRes.ok) {
                            const newCfg = await configRes.json();
                            setCfg(newCfg);
                            if (newCfg.mcpServers) {
                              setSelectedMcps(newCfg.mcpServers);
                            }
                          }
                          setAuthModal({
                            profile: cleaned,
                            mode: 'select',
                          });
                        } else {
                          const err = await res.json();
                          await showClaudeAlert('Lỗi', `Lỗi: ${err.error || 'Không thể tạo tài khoản'}`);
                        }
                      } catch (e) {
                        console.error('Lỗi khi tạo profile Claude:', e);
                      }
                    }, 100);
                  } else {
                    try {
                      const res = await apiFetch('/api/profiles', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ profile: newProfile }),
                      });
                      if (res.ok) {
                        const configRes = await apiFetch('/api/config');
                        if (configRes.ok) {
                          const newCfg = await configRes.json();
                          setCfg(newCfg);
                          if (newCfg.mcpServers) {
                            setSelectedMcps(newCfg.mcpServers);
                          }
                        }
                      } else {
                        const err = await res.json();
                        await showClaudeAlert('Lỗi', `Lỗi: ${err.error || 'Không thể chuyển đổi'}`);
                      }
                    } catch (e) {
                      console.error('Lỗi khi chuyển profile Claude:', e);
                    }
                  }
                }}
                options={[
                  ...cfg.claudeProfiles.map((p) => ({
                    value: p.name,
                    label: p.name === 'default' 
                      ? `claude (Default)${p.tokenSet ? ' (Token)' : ''}` 
                      : `claude-${p.name}${p.tokenSet ? ' (Token)' : ''}`,
                  })),
                  { value: '__new__', label: '+ Thêm tài khoản...' },
                ]}
              />
              {cfg.hasAuth ? (
                <span title="Đã đăng nhập" style={{ color: '#00e676', fontWeight: 'bold', fontSize: '14px', cursor: 'help' }}>✓</span>
              ) : (
                <span title="Chưa đăng nhập! Vui lòng cấu hình token hoặc chọn Đăng nhập." style={{ color: '#ff1744', fontWeight: 'bold', fontSize: '14px', cursor: 'help' }}>⚠️</span>
              )}
              <button
                type="button"
                className={`btn${cfg.hasAuth ? '' : ' allow'}`}
                style={{ padding: '2px 8px', fontSize: '11px', marginLeft: '4px' }}
                disabled={running}
                onClick={() => {
                  setAuthModal({
                    profile: cfg.currentClaudeProfile || 'default',
                    mode: 'select',
                  });
                }}
              >
                {cfg.hasAuth ? 'Cài đặt Login' : 'Đăng nhập / Cài Token'}
              </button>
            </label>
          )}
          <label>
            Effort:
            <PixelSelect
              value={effort}
              onChange={setEffort}
              disabled={running}
              options={[
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
                { value: 'xhigh', label: 'Xhigh' },
                { value: 'max', label: 'Max' },
              ]}
            />
          </label>
          {/* Ô chọn thư mục repo (cwd) — thu gọn, nằm cuối hàng bên phải Effort.
              Chỉ HIỂN THỊ tên folder (basename, vd "monorepo"); cwd đầy đủ vẫn giữ ở state
              để gửi backend, và hiện qua tooltip khi hover.
              Ẩn ở Safe/QC Mode: repo bị khoá vào safeCwd, chỉ Admin đổi được (chỗ khác). */}
          {!safe && (
            <div
              className="cwd-container"
              style={{ display: 'flex', gap: '6px', alignItems: 'stretch', marginLeft: 'auto', flexShrink: 0 }}
              title={cwd || 'Chưa chọn thư mục repo (cwd)'}
            >
              {cfg?.isAdmin ? (
                <>
                  <input
                    className="cwd"
                    placeholder="Chọn repo"
                    value={cwd.trim() ? (cwd.trim().split('/').filter(Boolean).pop() ?? cwd) : ''}
                    readOnly
                    onClick={() => { if (!running) openPicker(cwd); }}
                    disabled={running}
                    style={{
                      width: '130px',
                      cursor: running ? 'not-allowed' : 'pointer',
                    }}
                  />
                  <button
                    className="btn folder-picker-btn"
                    type="button"
                    disabled={running}
                    onClick={() => openPicker(cwd)}
                    title="Chọn thư mục"
                    style={{ padding: '0 10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Icon name="folder" size={16} />
                  </button>
                </>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 10px',
                    fontSize: '11px',
                    borderRadius: '4px',
                    background: 'var(--inset)',
                    border: 'var(--bd-thin) solid var(--outline)',
                    color: 'var(--muted)',
                  }}
                >
                  📁 {cwd.trim() ? (cwd.trim().split('/').filter(Boolean).pop() ?? cwd) : 'Chưa chọn repo'}
                </div>
              )}
            </div>
          )}
        </div>

        {!safe && detected && (
          <div className="detected">
            <Icon name="search" size={14} /> {detected.summary}
            {profile === 'auto' && detected.profile !== 'none' && ` → profile: ${detected.profile}`}
            {detected.profile === 'none' && !detected.empty && (
              <button className="btn genprof" disabled={running} onClick={genProfile}>
                Sinh profile cho repo này
              </button>
            )}
          </div>
        )}

        {/* Chỉ báo workspace: cwd này thuộc sản phẩm nào, gồm những repo anh em nào.
            Cho người dùng biết agent đang có ngữ cảnh cả nhóm repo + trí nhớ tích lũy. */}
        {!safe && currentWs && (
          <div className="detected" style={{ cursor: 'pointer' }} onClick={openWsPanel}
               title="Bấm để quản lý workspace / xem nhật ký">
            <Icon name="routing" size={14} /> Workspace <b>{currentWs.slug}</b> · {currentWs.repos.length} repo:{' '}
            {currentWs.repos.map((r, i) => {
              const here = cwd.trim() && (r.path === cwd.trim() || cwd.trim().startsWith(r.path + '/') || r.path.startsWith(cwd.trim() + '/'));
              return (
                <span key={r.path}>
                  {i > 0 && ', '}
                  <span style={here ? { fontWeight: 700, textDecoration: 'underline' } : undefined}>{r.role}</span>
                </span>
              );
            })}
            {currentWs.repos.length > 1 && ' — agent đọc chéo được repo anh em (read-only)'}
          </div>
        )}

        {(docs.length > 0 || pdfs.length > 0 || images.length > 0) && (
          <div className="attachments">
            {docs.map((d, i) => (
              <span key={`d${i}`} className="chip">
                <Icon name="doc" size={14} /> {d.name}
                <button onClick={() => setDocs((p) => p.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
            {pdfs.map((p, i) => (
              <span key={`p${i}`} className="chip">
                <Icon name="pdf" size={14} /> {p.name}
                <button onClick={() => setPdfs((prev) => prev.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
            {images.map((im, i) => (
              <span key={`i${i}`} className="chip chip-image" title={im.name}>
                <img
                  className="chip-thumb"
                  src={`data:${im.mediaType};base64,${im.base64}`}
                  alt={im.name}
                />
                <span className="chip-name">{im.name}</span>
                <button onClick={() => setImages((p) => p.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        )}

        {!running && (
          <div className="quick-prompts">
            {/* Safe Mode (QC read-only): chỉ giữ gợi ý "Giải thích codebase" —
                ẩn các gợi ý hướng tới sửa/thực thi (Sửa bug, Làm theo đề xuất). */}
            {(safe ? QUICK_PROMPTS.filter((qp) => qp.label === 'Giải thích codebase') : QUICK_PROMPTS).map((qp) => (
              <button
                key={qp.label}
                type="button"
                className="quick-prompt-chip"
                onClick={() => applyQuickPrompt(qp)}
                title={qp.text}
              >
                <Icon name={qp.icon} size={15} /> {qp.label}
              </button>
            ))}
          </div>
        )}

        {/* Tay kéo giãn ô nhập: kéo lên = cao ra, xuống = thấp lại; bấm đúp = trả về
            mặc định. Đặt trong luồng ngay trên ô nhập nên không che phần đầu khung. */}
        <div
          className="composer-resize-handle"
          onPointerDown={startTaskResize}
          onDoubleClick={() => setTaskHeight(null)}
          role="separator"
          aria-orientation="horizontal"
          title="Kéo để đổi chiều cao ô nhập · bấm đúp để trả về mặc định"
        >
          <span className="composer-resize-grip" />
        </div>

        <div className="composer-input">
          <textarea
            ref={taskRef}
            className="task"
            style={taskHeight != null ? { height: taskHeight, maxHeight: 'none' } : undefined}
            placeholder="Mô tả task / đề tài…  ·  Ctrl+Enter để chạy  ·  kéo-thả file/ảnh vào đây"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') start();
            }}
            onPaste={onPaste}
            disabled={running}
            rows={3}
          />
          <div className="composer-bar">
            <label className="btn attach" title="Đính kèm tài liệu / ảnh (hoặc kéo-thả vào ô nhập)">
              <Icon name="attach" size={18} />
              <input
                type="file"
                multiple
                hidden
                onChange={(e) => onFiles(e.target.files)}
                disabled={running}
              />
            </label>
            <span className="composer-spacer" />
            <button
              className="btn clear-chat"
              onClick={clearChat}
              disabled={!running && !items.length}
              title="Bắt đầu cuộc trò chuyện mới — cuộc hiện tại vẫn được lưu vào Lịch sử (mở lại được). Dừng agent nếu đang chạy."
            >
              <Icon name="newChat" size={15} /> Cuộc trò chuyện mới
            </button>
            {running ? (
              <button className="btn stop" onClick={stop}>
                Dừng
              </button>
            ) : (
              <button className="btn run" onClick={start}>
                Chạy
              </button>
            )}
          </div>
        </div>
        </div>
      </div>
      </div>

      {pickerOpen && (
        <div className="modal-overlay" onClick={() => setPickerOpen(false)}>
          <div className="modal-content pixel-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title"><Icon name="folder" size={16} /> {pickerTarget === 'safe-cwd' ? 'Chọn source để hỏi đáp' : 'Chọn thư mục làm việc'}</span>
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
                  placeholder="Đường dẫn thư mục..."
                  style={{ flex: 1, padding: '8px', fontFamily: 'monospace' }}
                />
                <button className="btn" style={{ padding: '0 16px' }} onClick={() => fetchDirs(pickerPath)}>Đi</button>
              </div>

              {pickerError && <div className="picker-error" style={{ color: 'var(--red)', marginBottom: '10px' }}><Icon name="warning" size={14} /> {pickerError}</div>}

              <div className="dirs-list" style={{ maxHeight: '250px', overflowY: 'auto', border: 'var(--bd-thin) solid var(--outline)', padding: '6px', background: 'var(--inset)' }}>
                {pickerParent !== null && (
                  <div className="dir-item parent-dir" style={{ padding: '6px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }} onClick={() => fetchDirs(pickerParent)}>
                    <Icon name="folder" size={16} /> <span style={{ fontFamily: 'monospace' }}>[..] (Thư mục cha)</span>
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
                {pickerDirs.length === 0 && <div className="no-subdirs" style={{ padding: '12px', textAlign: 'center', color: 'var(--muted)' }}>Không có thư mục con</div>}
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button className="btn deny" onClick={() => setPickerOpen(false)}>
                Hủy
              </button>
              <button
                className="btn allow"
                onClick={() => {
                  if (pickerTarget === 'cwd') {
                    setCwd(pickerPath);
                    setPickerOpen(false);
                  } else {
                    applyPortCwd(pickerTarget, pickerPath);
                  }
                }}
              >
                Chọn thư mục này
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
                    const isActive = c.id === activeConvId;
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
                                title="Mở lại cuộc này"
                              >
                                Mở
                              </button>
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
                {histDeleteId === activeConvId && (
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

      {confirmClearOpen && (
        <div className="modal-overlay" onClick={() => setConfirmClearOpen(false)}>
          <div
            className="modal-content pixel-panel"
            style={{ maxWidth: '420px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span className="modal-title"><Icon name="newChat" size={16} /> Cuộc trò chuyện mới</span>
              <button className="close-btn" onClick={() => setConfirmClearOpen(false)}><Icon name="close" size={16} /></button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, lineHeight: 1.6 }}>
                {running && (
                  <>
                    <Icon name="stopCircle" size={14} /> Agent đang chạy sẽ bị <strong>dừng</strong>.
                    <br />
                  </>
                )}
                Cuộc trò chuyện hiện tại (<strong>{items.length}</strong> tin nhắn) sẽ được{' '}
                <strong>lưu vào Lịch sử</strong> và màn hình được dọn để bắt đầu cuộc mới.
                <br />
                Bạn có thể mở lại và chat tiếp bất cứ lúc nào từ panel{' '}
                <Icon name="history" size={13} /> Lịch sử.
              </p>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button className="btn deny" onClick={() => setConfirmClearOpen(false)}>
                Hủy
              </button>
              <button className="btn stop" onClick={confirmClearChat}>
                Bắt đầu mới
              </button>
            </div>
          </div>
        </div>
      )}

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
                                    {u.apiOrigin.includes('4002') ? 'Collab' : u.apiOrigin.includes('4001') ? 'Safe' : 'Dev'}
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
                  className="btn allow"
                  style={{ padding: '12px', fontSize: '14px', textAlign: 'center', display: 'block', width: '100%', cursor: 'pointer' }}
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
                  <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>Cách 1: Đăng nhập OAuth (Khuyên dùng)</div>
                  <div style={{ fontSize: '11px', opacity: 0.8, fontWeight: 'normal' }}>
                    Tự động mở trình duyệt xác thực thông qua tài khoản Claude sẵn có của bạn
                  </div>
                </button>

                <button
                  type="button"
                  className="btn"
                  style={{ padding: '12px', fontSize: '14px', textAlign: 'center', display: 'block', width: '100%', cursor: 'pointer' }}
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
                  <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>Cách 2: Dùng API Key hoặc Token thủ công</div>
                  <div style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 'normal' }}>
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
    </div>
  );
}
