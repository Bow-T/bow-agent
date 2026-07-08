import { useEffect, useRef, useState } from 'react';
import { PixelSelect } from './PixelSelect.js';
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

/** Gọn số token: 21592 → "21.6k", 1000000 → "1M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

/** Một thanh usage: nhãn + % + bar. severity đổi màu khi gần đầy. */
export function App() {
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
  const [language, setLanguage] = useState(() => localStorage.getItem('bow-language') || 'vi');
  const [selectedMcps, setSelectedMcps] = useState<string[]>(() => {
    try {
      const val = localStorage.getItem('bow-selectedMcps');
      return val ? JSON.parse(val) : [];
    } catch {
      return [];
    }
  });
  const [accumulatedCost, setAccumulatedCost] = useState(0);
  // Snapshot hạn mức gói + context window (đến từ event 'usage' trong lượt chạy, hoặc
  // /api/usage khi mở trang). null = chưa có dữ liệu.
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);

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
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(
    () => localStorage.getItem('bow-conversation-id') || null
  );

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
  const [pickerPath, setPickerPath] = useState('');
  const [pickerParent, setPickerParent] = useState<string | null>(null);
  const [pickerDirs, setPickerDirs] = useState<string[]>([]);
  const [pickerError, setPickerError] = useState('');
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  // ── Panel quản lý MCP server ──
  const [mcpPanelOpen, setMcpPanelOpen] = useState(false);
  const [mcpList, setMcpList] = useState<
    { name: string; command: string; args: string[]; envKeys: string[]; stdio: boolean }[]
  >([]);
  const [mcpForm, setMcpForm] = useState({ name: '', command: '', args: '', env: '' });
  const [mcpError, setMcpError] = useState('');
  const [mcpBusy, setMcpBusy] = useState(false);

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

  /**
   * Làm mới snapshot hạn mức gói qua /api/usage (độc lập lượt chạy). Chỉ cập nhật phần
   * rateLimits/subscription; GIỮ context window cũ (đến từ event 'usage' trong lượt chạy
   * — /api/usage đọc từ phiên trống nên context không phản ánh hội thoại thật).
   */
  const refreshUsage = () => {
    setUsageLoading(true);
    fetch(`/api/usage?model=${encodeURIComponent(selectedModel)}`)
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
    fetch('/api/mcp')
      .then((r) => r.json())
      .then((d) => setMcpList(d.servers ?? []))
      .catch(() => setMcpError('Không tải được danh sách MCP.'));
  };

  const openMcpPanel = () => {
    setMcpError('');
    setMcpForm({ name: '', command: '', args: '', env: '' });
    setMcpPanelOpen(true);
    loadMcpList();
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
      const res = await fetch('/api/mcp', {
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
      fetch('/api/config')
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
      const res = await fetch(`/api/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        setMcpError(data.error ?? 'Xóa thất bại.');
        return;
      }
      setMcpList(data.servers ?? []);
      fetch('/api/config')
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

  // ── Workspace: tải danh sách, gán/gỡ repo, xem/sửa tri thức ──

  /** Tải danh sách workspace từ backend. */
  const loadWsList = () => {
    fetch('/api/workspaces')
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
    fetch(`/api/workspace/current?cwd=${encodeURIComponent(d)}`)
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
      const res = await fetch('/api/workspace/repo', {
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
      const res = await fetch('/api/workspace/repo', {
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
    fetch(`/api/workspace/${encodeURIComponent(slug)}/knowledge`)
      .then((r) => r.json())
      .then((d) => { setWsShared(d.shared ?? ''); setWsJournal(d.journal ?? ''); })
      .catch(() => setWsError('Không tải được tri thức workspace.'));
  };

  /** Lưu shared.md của workspace đang xem. */
  const saveWsShared = async () => {
    if (!wsViewSlug) return;
    setWsBusy(true);
    try {
      const res = await fetch(`/api/workspace/${encodeURIComponent(wsViewSlug)}/shared`, {
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
      const res = await fetch('/api/analyze-structure', {
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
      const src = new EventSource(`/api/events/${sid}`);
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
    fetch('/api/conversations')
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
      await fetch(`/api/conversations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: deriveTitle(convItems) || undefined,
          conversationId: convId,
          items: convItems,
          cwd: cwd.trim(),
        }),
      });
    } catch {
      // Lưu thất bại → bỏ qua, không chặn UI (thử lại ở lượt sau).
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
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) { setHistError('Không mở được cuộc trò chuyện.'); return; }
      const { conversation } = (await res.json()) as { conversation: ConversationFull };

      // Dừng phiên đang chạy trước khi chuyển cuộc — tránh event phiên cũ đổ nhầm.
      if (running) {
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        setRunning(false);
        if (sessionId) await fetch(`/api/stop/${sessionId}`, { method: 'POST' }).catch(() => {});
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
      await fetch(`/api/conversations/${id}`, {
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
      const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
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

  const openPicker = (initialPath: string) => {
    setPickerError('');
    setPickerOpen(true);
    fetchDirs(initialPath || cfg?.defaultCwd || '');
  };

  const fetchDirs = (path: string) => {
    setPickerError('');
    fetch(`/api/browse-dirs?path=${encodeURIComponent(path)}`)
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

  const [cfg, setCfg] = useState<{
    defaultCwd: string;
    mcpServers?: string[];
  } | null>(null);
  const [detected, setDetected] = useState<DetectedSource | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    // Lần đầu: theo cài đặt hệ điều hành. Sau đó ưu tiên lựa chọn user đã lưu.
    const saved = localStorage.getItem('bow-theme') as Theme | null;
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  // Đồng hồ UTC sống ở header (chi tiết "bảng điều khiển đài quan sát").
  const [utc, setUtc] = useState('');
  useEffect(() => {
    const tick = () => setUtc(new Date().toISOString().slice(11, 19));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

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
    fetch('/api/config')
      .then((r) => r.json())
      .then((c) => {
        setCfg(c);
        if (!cwd) setCwd(c.defaultCwd);
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

  // Khôi phục phiên chạy cũ nếu có và đang hoạt động
  useEffect(() => {
    const savedSessionId = localStorage.getItem('bow-session-id');
    if (savedSessionId) {
      fetch(`/api/session/${savedSessionId}`)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-nhận diện source + workspace mỗi khi cwd đổi (debounce nhẹ, dùng chung).
  useEffect(() => {
    if (!cwd.trim()) { setDetected(null); setCurrentWs(null); return; }
    const t = setTimeout(() => {
      fetch(`/api/detect?cwd=${encodeURIComponent(cwd.trim())}`)
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

    let res: Response;
    try {
      res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: sentText || undefined,
          jiraRef: sentJira || undefined,
          docs: sentDocs.length ? sentDocs : undefined,
          pdfs: sentPdfs.length ? sentPdfs : undefined,
          images: sentImages.length ? sentImages : undefined,
          mcpServers: selectedMcps,
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
    const src = new EventSource(`/api/events/${sid}`);
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
            `Xong · ${ev.turns} lượt · ${ev.outputTokens} tokens · $${ev.costUsd.toFixed(4)}`,
          );
          setAccumulatedCost((prev) => prev + ev.costUsd);
          break;
        case 'usage':
          // Snapshot đầy đủ trong lượt chạy: hạn mức + context window THẬT của hội thoại.
          setUsage(ev.usage);
          break;
        case 'error':
          addItem('error', `Kết thúc bất thường: ${ev.subtype}`);
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
    await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, id: approval.id, approved }),
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
    await fetch('/api/answer', {
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
    await fetch(`/api/stop/${sessionId}`, { method: 'POST' }).catch(() => {});
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
        await fetch(`/api/stop/${sessionId}`, { method: 'POST' }).catch(() => {});
      }
    }
    // Lưu chốt cuộc hiện tại lần cuối (auto-lưu có thể chưa kịp chạy debounce).
    await persistActiveConversation(items, conversationId);
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
      const res = await fetch('/api/generate-profile', {
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

  return (
    <div className="app">
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
          <span className="readout" title="Giờ UTC">
            <span className="rl">UTC</span>
            <span className="rv">{utc}</span>
          </span>
          <span className="readout" title="Chi phí tích lũy phiên này">
            <span className="rl">Cost</span>
            <span className="rv" style={{ color: accumulatedCost > 2 ? 'var(--danger)' : undefined }}>
              ${accumulatedCost.toFixed(4)}
            </span>
          </span>
          <span className="readout" title={modeDef(mode).desc}>
            <span className="rl">Mode</span>
            <span className={`rv mode-${mode}`}>
              {modeDef(mode).short}
            </span>
          </span>
          {/* Hạn mức phiên 5 giờ (Session) — gọn trên header. Bấm để làm mới. */}
          {(() => {
            const s = usage?.rateLimits.find((w) => /session|5\s*h|5hr/i.test(w.label));
            const pct = s && s.utilization != null ? Math.round(s.utilization) : null;
            return (
              <button
                className="readout readout-btn"
                title={
                  s
                    ? `Hạn mức phiên (5hr) — ${formatResetIn(s.resetsAt)}. Bấm để làm mới.`
                    : 'Hạn mức phiên. Bấm để làm mới.'
                }
                onClick={refreshUsage}
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
          {(() => {
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
            <span className="lang-icon" aria-hidden="true"><Icon name="lang" size={16} /></span>
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
            title="Quản lý MCP server (Jira/Supabase/... cho agent)"
            onClick={openMcpPanel}
          >
            <Icon name="mcp" size={18} />
          </button>
          <button
            className="theme-btn"
            title="Workspace — nhóm nhiều repo (BE/FE/...) thành 1 sản phẩm + trí nhớ chung"
            onClick={openWsPanel}
          >
            <Icon name="routing" size={18} />
          </button>
          <button
            className="theme-btn"
            title="Cấu trúc dự án — AI quét repo (cwd) rồi mô tả kiến trúc & cây thư mục"
            onClick={openStructPanel}
          >
            <Icon name="structure" size={18} />
          </button>
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
            <div className="chat-pinned-query" key={activeQuery} title={activeQuery}>
              <span className="pinned-icon"><Icon name="pin" size={14} /></span>
              <span className="pinned-text">{activeQuery.replace(/\s+/g, ' ')}</span>
            </div>
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
        {items.map((it, idx) => {
          // Dòng tool cuối cùng khi agent đang chạy = tool ĐANG thực thi → gắn class
          // `running` để CSS hiện spinner quay + chấm nhấp nháy, phân biệt với dòng đã xong.
          const isLastToolRunning =
            running &&
            it.kind === 'tool' &&
            pending.length === 0 &&
            questions.length === 0 &&
            !items.slice(idx + 1).some((n) => n.kind === 'tool');
          return (
            <div
              key={it.id}
              data-id={it.id}
              className={`bubble ${it.kind}${isLastToolRunning ? ' running' : ''}`}
            >
              {it.kind === 'agent' ? <Markdown text={it.text} /> : it.text}
            </div>
          );
        })}
        {running && pending.length === 0 && questions.length === 0 && (
          <div className="thinking">
            Agent đang làm việc
            <span className="thinking-dots"><i></i><i></i><i></i></span>
          </div>
        )}
      </div>

      {/* Bến neo hành động — khung duyệt / câu hỏi ghim ngay trên composer, LUÔN
          hiển thị (không nằm trong vùng cuộn) nên nút bấm không bao giờ bị khuất.

          CHỈ hiện MỘT thẻ tại một thời điểm: agent chờ duyệt tuần tự (canUseTool
          block từng tool), nên xếp chồng nhiều thẻ chỉ làm tràn màn hình và giấu
          mất nút Cho phép/Từ chối. Ưu tiên approval trước, rồi tới câu hỏi. Số thẻ
          còn lại trong hàng chờ hiện ở badge để người dùng biết còn việc phía sau. */}
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
          <div className="field">
            Chế độ:
            <ModeSelect value={mode} onChange={setMode} disabled={running} />
          </div>
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
        </div>

        {detected && (
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

        <div className="row">
          <div className="cwd-container" style={{ display: 'flex', flex: 1, gap: '6px', alignItems: 'stretch' }}>
            <input
              className="cwd"
              placeholder="Thư mục repo (cwd)"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              disabled={running}
              style={{ flex: 1 }}
            />
            <button
              className="btn folder-picker-btn"
              type="button"
              disabled={running}
              onClick={() => openPicker(cwd)}
              title="Chọn thư mục"
              style={{ padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="folder" size={18} />
            </button>
          </div>
        </div>

        {/* Chỉ báo workspace: cwd này thuộc sản phẩm nào, gồm những repo anh em nào.
            Cho người dùng biết agent đang có ngữ cảnh cả nhóm repo + trí nhớ tích lũy. */}
        {currentWs && (
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
            {QUICK_PROMPTS.map((qp) => (
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

        <div className="composer-input">
          <textarea
            ref={taskRef}
            className="task"
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
              <span className="modal-title"><Icon name="folder" size={16} /> Chọn thư mục làm việc</span>
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
                  setCwd(pickerPath);
                  setPickerOpen(false);
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
              <span className="modal-title"><Icon name="mcp" size={16} /> Quản lý MCP server</span>
              <button className="close-btn" onClick={() => setMcpPanelOpen(false)}><Icon name="close" size={16} /></button>
            </div>
            <div className="modal-body">
              {mcpError && (
                <div className="picker-error" style={{ color: 'var(--red)', marginBottom: '10px' }}><Icon name="warning" size={14} /> {mcpError}</div>
              )}

              {/* Danh sách MCP hiện có */}
              <div className="mcp-list-title" style={{ marginBottom: '8px' }}>
                ĐÃ CẤU HÌNH ({mcpList.length})
              </div>
              <div className="mcp-list" style={{ maxHeight: '180px', overflowY: 'auto', border: 'var(--bd-thin) solid var(--outline)', padding: '6px', background: 'var(--inset)', marginBottom: '16px' }}>
                {mcpList.length === 0 && (
                  <div style={{ padding: '10px', textAlign: 'center', color: 'var(--muted)' }}>Chưa có MCP nào</div>
                )}
                {mcpList.map((m) => (
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
                      onClick={() => deleteMcp(m.name)}
                      title={`Xóa MCP ${m.name}`}
                    >
                      Xóa
                    </button>
                  </div>
                ))}
              </div>

              {/* Form thêm mới */}
              <div className="mcp-list-title" style={{ marginBottom: '8px' }}>
                THÊM MCP MỚI (stdio)
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
              <button className="btn allow" disabled={mcpBusy} onClick={submitMcp}>
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
                Xóa toàn bộ <strong>{items.length}</strong> tin nhắn và bắt đầu hội thoại mới?
                <br />
                Thao tác này không thể hoàn tác.
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
    </div>
  );
}
