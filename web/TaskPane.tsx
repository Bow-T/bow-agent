import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { NeuralBrain, type CameraInfo, type NeuralBrainHandle } from './NeuralBrain.js';
import { ModeSelect, modeDef } from './ModeSelect.js';
import { PixelSelect } from './PixelSelect.js';
import { Markdown } from './Markdown.js';
import { QuestionCard } from './QuestionCard.js';
import { Icon, type IconName } from './Icon.js';
import type {
  ChatItem,
  ConversationFull,
  DetectedSource,
  DocAttachment,
  ImageAttachment,
  Mode,
  PendingApproval,
  PendingQuestion,
  UsageSnapshot,
  WebEvent,
} from './types.js';
import {
  type Accent,
  type ActivityNode,
  type AuthModalState,
  type Cfg,
  type SkillSrc,
  type SkillStatus,
  type Theme,
  type Ws,
  apiFetch,
  fmtDuration,
  formatCountdown,
  formatResetIn,
  nextId,
  QUICK_PROMPTS,
  readDataUrl,
  readImage,
  readText,
  tabKey,
  withToken,
} from './App.js';

/**
 * TaskPane — MỘT tab hội thoại độc lập (1 conversation/session). Nhận cấu hình global
 * (mode/cwd/skill…) qua props từ App; giữ RIÊNG state per-tab: model/effort/profile (mỗi
 * tab 1 setup chạy khác nhau, lưu localStorage theo tabKey) + task/items/session/pending/
 * questions/running… + logic run/stream/SSE. Tab "legacy" đọc key gốc không hậu tố nên
 * tương thích ngược dữ liệu single-view cũ.
 */
export interface TaskPaneProps {
  tabId: string;
  /** Tab đang hiển thị — dùng cho hidden attr (bước 2 nhiều tab). */
  visible: boolean;
  // ── Cấu hình global (chỉ đọc) ──
  cfg: Cfg | null;
  mode: Mode;
  useSubagents: boolean;
  language: 'vi' | 'en';
  selectedMcps: string[];
  stack: string;
  cwd: string;
  theme: Theme;
  accent: Accent;
  detected: DetectedSource | null;
  currentWs: Ws | null;
  skillStacks: { id: string; label: string; ref: string; default: boolean }[];
  skillStatus: SkillStatus | null;
  skillSyncing: boolean;
  skillSyncMsg: string;
  readonlyShare: boolean;
  qc: boolean;
  reviewer: boolean;
  collab: boolean;
  ba: boolean;
  devops: boolean;
  taskHeight: number | null;
  // ── Handlers / setters global ──
  setCfg: React.Dispatch<React.SetStateAction<Cfg | null>>;
  setSelectedMcps: React.Dispatch<React.SetStateAction<string[]>>;
  setAuthModal: React.Dispatch<React.SetStateAction<AuthModalState | null>>;
  setAccumulatedCost: React.Dispatch<React.SetStateAction<number>>;
  openPicker: (initialPath: string, target?: 'cwd' | 'dev-cwd' | 'qc-cwd' | 'collab-cwd' | 'ba-cwd' | 'reviewer-cwd' | 'devops-cwd') => void;
  openWsPanel: () => void;
  refreshCurrentWs: (dir: string) => void;
  changeActiveCwd: (newPath: string) => void;
  showClaudePrompt: (title: string, message: string, defaultValue?: string) => Promise<string | null>;
  showClaudeAlert: (title: string, message: string) => Promise<void>;
  syncSkillsNow: () => void;
  setTaskHeight: React.Dispatch<React.SetStateAction<number | null>>;
  setMode: React.Dispatch<React.SetStateAction<Mode>>;
  setStack: React.Dispatch<React.SetStateAction<string>>;
  setUseSubagents: React.Dispatch<React.SetStateAction<boolean>>;
  /**
   * Báo lên App phần state per-tab mà UI GLOBAL cần đọc (header đồng hồ lượt chạy + panel
   * Lịch sử tô cuộc đang mở). Bước 1: 1 tab nên App chỉ mirror của tab hiển thị.
   */
  onStateChange: (s: { running: boolean; runStartedAt: number | null; lastRunMs: number | null; activeConvId: string | null; title: string; model: string; claudeProfile: string; usage: UsageSnapshot | null; usageLoading: boolean }) => void;
}

/**
 * Handle imperative để App (panel Lịch sử / xoá cuộc — vốn là GLOBAL) điều khiển state
 * per-tab của pane đang hiển thị. Bước 1 chỉ có tab 'legacy' nên App gọi qua 1 ref.
 */
export interface TaskPaneHandle {
  /** id cuộc đang mở trong tab (để History biết có cần mở/không, và xoá đúng cuộc). */
  getActiveConvId: () => string | null;
  /** Mở một cuộc cũ vào tab: nạp items/conversationId/cwd. Trả lỗi (nếu có) để History hiện. */
  openConversation: (id: string) => Promise<{ ok: boolean; error?: string }>;
  /** Cuộc đang mở vừa bị xoá → dọn tab về trạng thái mới trống. */
  resetForDeleted: () => void;
  /** Làm mới hạn mức gói của TÀI KHOẢN tab này (nút "Làm mới" trong panel usage của App gọi). */
  refreshUsage: () => void;
}

export const TaskPane = forwardRef<TaskPaneHandle, TaskPaneProps>(function TaskPane(props, ref) {
  const {
    tabId, visible, cfg, mode, useSubagents, language,
    selectedMcps, stack, cwd, theme, accent, detected, currentWs, skillStacks, skillStatus,
    skillSyncing, skillSyncMsg, readonlyShare, taskHeight,
    setCfg, setSelectedMcps, setAuthModal, setAccumulatedCost, openPicker, openWsPanel,
    changeActiveCwd, showClaudePrompt, showClaudeAlert, syncSkillsNow, setTaskHeight,
    setMode, setStack, setUseSubagents, onStateChange,
  } = props;

  // ── Khoá localStorage per-tab (legacy = key gốc, tab khác thêm ':<tabId>') ──
  const K = {
    items: tabKey('bow-chat-items', tabId),
    conv: tabKey('bow-conversation-id', tabId),
    activeConv: tabKey('bow-active-conv-id', tabId),
    session: tabKey('bow-session-id', tabId),
    baseline: tabKey('bow-session-baseline', tabId),
    task: tabKey('bow-task', tabId),
    // Cấu hình chạy PER-TAB (mỗi tab 1 model/effort/profile riêng). Tab legacy giữ key
    // gốc không hậu tố → tương thích ngược dữ liệu single-view cũ.
    model: tabKey('bow-selectedModel', tabId),
    effort: tabKey('bow-effort', tabId),
    profile: tabKey('bow-profile', tabId),
    claudeProfile: tabKey('bow-claudeProfile', tabId),
  };

  // ── State/refs PER-TAB ──
  const [task, setTask] = useState(() => localStorage.getItem(K.task) || '');
  // Cấu hình chạy per-tab: model / effort / profile. QC Mode read-only → mặc định Sonnet
  // (nhẹ/rẻ) khi chưa có lựa chọn lưu; các mode khác mặc định Opus.
  const [selectedModel, setSelectedModel] = useState(
    () => localStorage.getItem(K.model) || (cfg?.isQcMode ? 'claude-sonnet-5' : 'claude-opus-4-8')
  );
  const [effort, setEffort] = useState(() => localStorage.getItem(K.effort) || 'high');
  const [profile, setProfile] = useState(() => localStorage.getItem(K.profile) || 'auto');
  // Tài khoản Claude PER-TAB (mỗi tab chạy 1 tài khoản riêng). Khởi tạo: lựa chọn đã lưu của
  // tab, nếu chưa có thì theo tài khoản server đang set (cfg.currentClaudeProfile) hoặc 'default'.
  const [selectedClaudeProfile, setSelectedClaudeProfile] = useState(
    () => localStorage.getItem(K.claudeProfile) || cfg?.currentClaudeProfile || 'default'
  );
  // Tài khoản mà TAB NÀY chọn đã đăng nhập chưa (theo hasAuth per-profile từ /api/config).
  // Không dùng cfg.hasAuth (global theo env server) vì tab có thể chọn tài khoản khác.
  const tabProfileAuthed =
    cfg?.claudeProfiles?.find((p) => p.name === selectedClaudeProfile)?.hasAuth ?? cfg?.hasAuth ?? false;
  // Hạn mức gói PER-TAB: mỗi tab đọc hạn mức của ĐÚNG tài khoản nó chạy (SESSION/Weekly theo
  // account + context của chính cuộc này). App hiển thị usage của tab đang mở (báo qua onStateChange).
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [cameraInfo, setCameraInfo] = useState<CameraInfo | null>(null);
  const neuralBrainRef = useRef<NeuralBrainHandle>(null);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [configPopOpen, setConfigPopOpen] = useState(false);
  const configPopRef = useRef<HTMLDivElement | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeRailTab, setActiveRailTab] = useState<'toggle' | 'chart' | 'log'>('chart');
  const sidebarRef = useRef<HTMLElement | null>(null);
  const starChartRef = useRef<HTMLDivElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const scrollToSection = useCallback((target: 'chart' | 'log') => {
    setActiveRailTab(target);
    const triggerEffect = () => {
      const el = target === 'chart' ? starChartRef.current : logRef.current;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.remove('flash-highlight');
        void el.offsetWidth;
        el.classList.add('flash-highlight');
        setTimeout(() => el.classList.remove('flash-highlight'), 1100);
      }
    };
    if (!sidebarOpen) {
      setSidebarOpen(true);
      setTimeout(triggerEffect, 100);
    } else {
      triggerEffect();
    }
  }, [sidebarOpen]);

  // Đóng popover cấu hình khi click ngoài
  useEffect(() => {
    if (!configPopOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (configPopRef.current && !configPopRef.current.contains(e.target as Node)) {
        setConfigPopOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [configPopOpen]);
  const [expandedChatGroups, setExpandedChatGroups] = useState<Set<string>>(new Set());
  const [docs, setDocs] = useState<DocAttachment[]>([]);
  const [pdfs, setPdfs] = useState<{ name: string; base64: string }[]>([]);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [items, setItems] = useState<ChatItem[]>(() => {
    // Khôi phục lịch sử chat từ phiên trước (giữ qua refresh trang).
    try {
      const raw = localStorage.getItem(K.items);
      return raw ? (JSON.parse(raw) as ChatItem[]) : [];
    } catch {
      return [];
    }
  });
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [running, setRunning] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [lastRunMs, setLastRunMs] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(
    () => localStorage.getItem(K.conv) || null
  );
  const [autoResume, setAutoResume] = useState<{
    retryAt: string;
    resetsAt: string | null;
    attempt: number;
    maxAttempts: number;
    conversationId: string | null;
  } | null>(null);
  const [resumeTick, setResumeTick] = useState(0);
  const clientResumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRunPayloadRef = useRef<Record<string, unknown> | null>(null);
  const [activeConvId, setActiveConvId] = useState<string | null>(
    () => localStorage.getItem(K.activeConv) || null
  );
  const [needResumeContext, setNeedResumeContext] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isScrolled, setIsScrolled] = useState(false);
  const [activeQuery, setActiveQuery] = useState('');
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionBaselineRef = useRef(0);

  // ── Đồng bộ localStorage per-tab ──
  useEffect(() => { localStorage.setItem(K.task, task); }, [K.task, task]);
  useEffect(() => { localStorage.setItem(K.model, selectedModel); }, [K.model, selectedModel]);
  useEffect(() => { localStorage.setItem(K.effort, effort); }, [K.effort, effort]);
  useEffect(() => { localStorage.setItem(K.profile, profile); }, [K.profile, profile]);
  useEffect(() => { localStorage.setItem(K.claudeProfile, selectedClaudeProfile); }, [K.claudeProfile, selectedClaudeProfile]);
  // Khi cfg về mà tab CHƯA có lựa chọn tài khoản lưu riêng → theo tài khoản server đang set.
  useEffect(() => {
    if (cfg?.currentClaudeProfile && !localStorage.getItem(K.claudeProfile)) {
      setSelectedClaudeProfile(cfg.currentClaudeProfile);
    }
  }, [cfg?.currentClaudeProfile, K.claudeProfile]);
  // QC Mode LUÔN chạy Sonnet ở backend → ép UI khớp khi cfg về (nếu chưa có lựa chọn lưu
  // riêng cho tab này). Chỉ chạy khi thực sự là QC để không đè lựa chọn ở Dev.
  useEffect(() => {
    if (cfg?.isQcMode && !localStorage.getItem(K.model)) setSelectedModel('claude-sonnet-5');
  }, [cfg?.isQcMode, K.model]);

  /**
   * Làm mới hạn mức gói của ĐÚNG tài khoản tab này qua /api/usage (độc lập lượt chạy). Chỉ
   * cập nhật rateLimits/subscription; GIỮ context window cũ (đến từ event 'usage' của lượt chạy
   * — /api/usage đọc phiên trống nên context không phản ánh hội thoại thật). Per-tab: gửi model +
   * claudeProfile của chính tab để mỗi tab thấy hạn mức của tài khoản riêng, không lẫn nhau.
   */
  const refreshUsage = () => {
    setUsageLoading(true);
    apiFetch(`/api/usage?model=${encodeURIComponent(selectedModel)}&claudeProfile=${encodeURIComponent(selectedClaudeProfile)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { usage: UsageSnapshot }) => {
        setUsage((prev) => ({
          ...d.usage,
          contextTokens: prev ? prev.contextTokens : d.usage.contextTokens,
          contextMaxTokens: prev ? prev.contextMaxTokens : d.usage.contextMaxTokens,
          contextPercentage: prev ? prev.contextPercentage : d.usage.contextPercentage,
        }));
      })
      .catch(() => {})
      .finally(() => setUsageLoading(false));
  };
  // Nạp hạn mức khi tab mount VÀ mỗi khi đổi tài khoản/model của tab (số hạn mức đổi theo account).
  useEffect(() => {
    refreshUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClaudeProfile, selectedModel]);

  // Expose refreshUsage cho App (nút "Làm mới" trong panel usage global gọi tab đang mở).
  const refreshUsageRef = useRef(refreshUsage);
  refreshUsageRef.current = refreshUsage;
  useEffect(() => {
    if (conversationId) localStorage.setItem(K.conv, conversationId);
    else localStorage.removeItem(K.conv);
  }, [K.conv, conversationId]);
  useEffect(() => {
    if (activeConvId) localStorage.setItem(K.activeConv, activeConvId);
    else localStorage.removeItem(K.activeConv);
  }, [K.activeConv, activeConvId]);
  // Lưu lịch sử chat để giữ qua refresh (chỉ 300 item gần nhất, tránh vượt quota).
  useEffect(() => {
    try {
      const MAX = 300;
      const trimmed = items.length > MAX ? items.slice(-MAX) : items;
      localStorage.setItem(K.items, JSON.stringify(trimmed));
    } catch {
      // Vượt quota hoặc lỗi serialize → bỏ qua, không chặn UI.
    }
  }, [K.items, items]);

  // Tự lưu BỀN cuộc đang mở lên backend mỗi khi items đổi (debounce 800ms).
  useEffect(() => {
    if (items.length === 0) return;
    const t = setTimeout(() => {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      persistActiveConversation(items, conversationId);
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, conversationId]);

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

  /**
   * Lưu (upsert) cuộc đang mở lên backend. Tự đặt tiêu đề từ câu user đầu nếu backend
   * chưa có tên. Trả về id cuộc (tạo mới nếu chưa có activeConvId). Gọi sau mỗi lượt
   * chạy và khi có thay đổi items đáng kể.
   */
  const persistActiveConversation = async (
    convItems: ChatItem[],
    convId: string | null,
  ): Promise<string | null | 'forbidden'> => {
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
      if (res.status === 403) return 'forbidden';
      if (!res.ok) return null;
    } catch {
      return null;
    }
    return id;
  };

  /**
   * Mở một cuộc cũ VÀO TAB NÀY: nạp items + conversationId + cwd. Bật cờ needResumeContext
   * để lượt chạy kế gửi kèm tóm tắt (phòng phiên SDK đã bị dọn). Dừng phiên đang chạy (nếu có).
   * Phần global (histBusy/histError/histPanelOpen) do App xử lý quanh lời gọi này.
   */
  const openConversation = async (id: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await apiFetch(`/api/conversations/${id}`);
      if (!res.ok) return { ok: false, error: 'Không mở được cuộc trò chuyện.' };
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
      // Có conversationId (phiên SDK) thì thử resume trực tiếp; dù có, vẫn bật cờ để lượt
      // đầu kèm tóm tắt cho chắc (phiên .jsonl có thể đã bị SDK dọn) — vô hại nếu resume ok.
      setNeedResumeContext(true);
      if (conversation.cwd) changeActiveCwd(conversation.cwd);
      setSessionId(null);
      setPending([]);
      setQuestions([]);
      setSelectedStepId(null);
      // Reset context window — số của cuộc trước không còn đúng; event 'usage' lượt đầu nạp lại.
      setUsage(prev => (prev ? { ...prev, contextTokens: null, contextMaxTokens: null, contextPercentage: null } : prev));
      sessionBaselineRef.current = (conversation.items ?? []).length;
      localStorage.removeItem(K.session);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Lỗi gọi backend: ${(err as Error).message}` };
    }
  };

  /** Dọn tab về cuộc mới trống khi cuộc đang mở vừa bị xoá (gọi từ App qua handle). */
  const resetForDeleted = () => {
    setItems([]);
    setConversationId(null);
    setActiveConvId(null);
    setSessionId(null);
    sessionBaselineRef.current = 0;
    localStorage.removeItem(K.items);
    localStorage.removeItem(K.baseline);
  };

  useImperativeHandle(ref, () => ({
    getActiveConvId: () => activeConvId,
    openConversation,
    resetForDeleted,
    refreshUsage: () => refreshUsageRef.current(),
  }));

  // Kéo giãn ô nhập: App giữ state taskHeight (global), TaskPane gọi setTaskHeight (prop)
  // vì tay kéo + textarea nằm trong composer per-tab và cần taskRef riêng của tab.
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
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /** Bấm một gợi ý nhanh: điền sẵn task. */
  function applyQuickPrompt(qp: { text: string }) {
    if (running) return;
    setTask(qp.text);
    setTimeout(() => {
      const el = taskRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 0);
  }

  // Migrate 1 lần: cuộc trong localStorage chưa gắn activeConvId → tạo bản ghi ở backend.
  useEffect(() => {
    if (!activeConvId && items.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      persistActiveConversation(items, conversationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const lastQ = [...items].reverse().find((it) => it.kind === 'user')?.text || '';
    setActiveQuery(lastQ);
  }, [items]);

  // Auto-scroll xuống đáy khi có item/pending mới. Bỏ qua khi tab ẩn (hidden → scrollHeight
  // không đáng tin & thừa); khi quay lại tab, effect chạy lại theo items/pending sẽ cuộn đúng.
  useEffect(() => {
    if (!visible) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [visible, items, pending]);

  // Đồng hồ phiên: bấm giờ khi running bật, chốt thời lượng khi tắt (kể cả kết thúc bất
  // thường/stop — đo phía client thay vì chỉ dựa event 'result'). runStartedAt đọc qua
  // closure của render hiện tại, KHÔNG đưa vào deps (tránh vòng lặp tự kích).
  useEffect(() => {
    if (running) {
      setRunStartedAt(Date.now());
    } else if (runStartedAt != null) {
      setLastRunMs(Date.now() - runStartedAt);
      setRunStartedAt(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Đồng hồ tick 1s để đếm ngược tới retryAt (chỉ chạy khi có lịch tự-chạy-tiếp).
  useEffect(() => {
    if (!autoResume) return;
    const t = setInterval(() => setResumeTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [autoResume]);

  // Dọn timer fallback client khi unmount.
  useEffect(() => () => {
    if (clientResumeTimerRef.current) clearTimeout(clientResumeTimerRef.current);
  }, []);

  // Giữ sessionId hiện tại trong ref để cleanup on-unmount (đọc closure lần mount) thấy
  // giá trị MỚI NHẤT — cần khi ĐÓNG TAB: phải đóng SSE + báo backend dừng phiên để
  // không rò EventSource (trình duyệt giới hạn ~6 SSE/host) lẫn session ở Map backend.
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => () => {
    eventSourceRef.current?.close();
    const sid = sessionIdRef.current;
    if (sid) {
      // sendBeacon để lệnh stop đi được cả khi tab đang bị gỡ; fallback fetch nếu không có.
      const url = `/api/stop/${sid}`;
      if (!navigator.sendBeacon?.(withToken(url))) {
        apiFetch(url, { method: 'POST' }).catch(() => {});
      }
    }
  }, []);

  // Reconnect-on-mount: khôi phục phiên chạy cũ nếu còn sống + lịch tự-chạy-tiếp treo.
  useEffect(() => {
    const savedSessionId = localStorage.getItem(K.session);
    if (savedSessionId) {
      apiFetch(`/api/session/${savedSessionId}`)
        .then((r) => r.json())
        .then((data: { exists: boolean }) => {
          if (data.exists) {
            const savedBase = Number(localStorage.getItem(K.baseline));
            sessionBaselineRef.current = Number.isFinite(savedBase) ? savedBase : 0;
            setSessionId(savedSessionId);
            setRunning(true);
            streamEvents(savedSessionId);
          } else {
            localStorage.removeItem(K.session);
          }
        })
        .catch(() => {
          localStorage.removeItem(K.session);
        });
    }
    const savedConv = localStorage.getItem(K.conv);
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

  function clearAutoResume() {
    setAutoResume(null);
    if (clientResumeTimerRef.current) {
      clearTimeout(clientResumeTimerRef.current);
      clientResumeTimerRef.current = null;
    }
  }

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

  async function triggerClientResume(cid: string) {
    if (running) return; // server đã tự chạy tiếp rồi → thôi
    const runCfg = lastRunPayloadRef.current ?? {};
    setRunning(true);
    addItem('system', '⏳ Hết hạn mức đã reset — tự chạy tiếp phiên dở…');
    let res: Response;
    try {
      res = await apiFetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...runCfg, stack: stack || undefined, text: RESUME_PROMPT, conversationId: cid }),
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
    localStorage.setItem(K.session, sid);
    setItems((prev) => {
      sessionBaselineRef.current = prev.length;
      localStorage.setItem(K.baseline, String(prev.length));
      return prev;
    });
    streamEvents(sid);
  }

  async function start() {
    if (running) return;
    const hasInput = task.trim() || docs.length || pdfs.length || images.length;
    if (!hasInput) return;

    setPending([]);
    setQuestions([]);
    setSelectedStepId(null);
    setRunning(true);

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

    const sentResumeContext = needResumeContext ? summarizeForResume(items) : '';
    if (needResumeContext) setNeedResumeContext(false);

    const parts = [
      sentJira && `[${sentJira}]`,
      sentText,
      sentDocs.length && `📄×${sentDocs.length}`,
      sentImages.length && `🖼×${sentImages.length}`,
    ].filter(Boolean);
    addItem('user', parts.join(' ') || '(đầu vào đính kèm)');

    setTask('');
    setDocs([]);
    setPdfs([]);
    setImages([]);

    clearAutoResume();

    lastRunPayloadRef.current = {
      mcpServers: selectedMcps,
      mode,
      profile,
      effort,
      language,
      cwd: cwd.trim() || undefined,
      model: selectedModel,
      claudeProfile: selectedClaudeProfile,
      useSubagents,
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
          claudeProfile: selectedClaudeProfile,
          useSubagents,
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
    localStorage.setItem(K.session, sid);
    setItems((prev) => {
      sessionBaselineRef.current = prev.length;
      localStorage.setItem(K.baseline, String(prev.length));
      return prev;
    });
    streamEvents(sid);
  }

  function streamEvents(sid: string) {
    eventSourceRef.current?.close();

    setItems((prev) => prev.slice(0, sessionBaselineRef.current));
    setPending([]);
    setQuestions([]);
    const src = new EventSource(withToken(`/api/events/${sid}`));
    eventSourceRef.current = src;
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
          setUsage((prev) => {
            const hasRL = ev.usage.rateLimits.length > 0;
            return {
              rateLimits: hasRL ? ev.usage.rateLimits : prev?.rateLimits ?? ev.usage.rateLimits,
              subscriptionType: hasRL ? ev.usage.subscriptionType : prev?.subscriptionType ?? ev.usage.subscriptionType,
              contextTokens: ev.usage.contextTokens,
              contextMaxTokens: ev.usage.contextMaxTokens,
              contextPercentage: ev.usage.contextPercentage,
            };
          });
          break;
        case 'error':
          if (ev.isSessionLimit) {
            const when = ev.resetsAt ? formatResetIn(ev.resetsAt) : '';
            addItem('system', `⏸️ Hết hạn mức phiên (5h)${when ? ` · reset ${when.toLowerCase()}` : ''}. Đang chờ lịch tự chạy tiếp…`);
          } else {
            addItem('error', `Kết thúc bất thường: ${ev.subtype}`);
          }
          break;
        case 'auto-resume-scheduled': {
          setAutoResume({
            retryAt: ev.retryAt,
            resetsAt: ev.resetsAt,
            attempt: ev.attempt,
            maxAttempts: ev.maxAttempts,
            conversationId,
          });
          addItem('system', `🕒 Sẽ tự chạy tiếp lúc ${new Date(ev.retryAt).toLocaleTimeString('vi-VN')} (lần ${ev.attempt}/${ev.maxAttempts}).`);
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
          setQuestions((prev) =>
            prev.some((q) => q.id === ev.id)
              ? prev
              : [...prev, { id: ev.id, questions: ev.questions }],
          );
          break;
        case 'conversation':
          setConversationId(ev.conversationId);
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
          localStorage.removeItem(K.session);
          closeSrc();
          break;
        case 'fatal':
          addItem('error', ev.message);
          setRunning(false);
          localStorage.removeItem(K.session);
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
    localStorage.removeItem(K.session);
    addItem('system', '⏹ Yêu cầu dừng agent...');
    await apiFetch(`/api/stop/${sessionId}`, { method: 'POST' }).catch(() => {});
  }

  function clearChat() {
    if (!items.length && !running) {
      if (activeConvId || conversationId) resetToNewConversation();
      return;
    }
    setConfirmClearOpen(true);
  }

  async function confirmClearChat() {
    setConfirmClearOpen(false);
    if (running) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setRunning(false);
      if (sessionId) {
        await apiFetch(`/api/stop/${sessionId}`, { method: 'POST' }).catch(() => {});
      }
    }
    if (items.length > 0) {
      const savedId = await persistActiveConversation(items, conversationId);
      if (savedId === null) {
        addItem('error', 'Không lưu được cuộc trò chuyện hiện tại (mất kết nối tới máy chủ). Đã giữ nguyên tin nhắn — hãy thử lại khi có kết nối để tránh mất dữ liệu.');
        return;
      }
    }
    resetToNewConversation();
  }

  function resetToNewConversation() {
    setItems([]);
    setPending([]);
    setQuestions([]);
    setSessionId(null);
    setConversationId(null);
    setActiveConvId(null);
    setNeedResumeContext(false);
    setSelectedStepId(null);
    setUsage(prev => (prev ? { ...prev, contextTokens: null, contextMaxTokens: null, contextPercentage: null } : prev));
    localStorage.removeItem(K.conv);
    localStorage.removeItem(K.activeConv);
    localStorage.removeItem(K.session);
    sessionBaselineRef.current = 0;
    localStorage.removeItem(K.items);
    localStorage.removeItem(K.baseline);
  }

  async function genProfile() {
    if (running) return;
    setRunning(true);
    addItem('system', `🔧 Đang quét repo để sinh profile: ${cwd}`);
    try {
      const res = await apiFetch('/api/generate-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: cwd.trim() || undefined }),
      });
      const { sessionId: sid } = await res.json();
      setSessionId(sid);
      localStorage.setItem(K.session, sid);
      setItems((prev) => {
        sessionBaselineRef.current = prev.length;
        localStorage.setItem(K.baseline, String(prev.length));
        return prev;
      });
      streamEvents(sid);
    } catch (err) {
      addItem('error', `Không sinh được profile: ${(err as Error).message}`);
      setRunning(false);
    }
  }

  // Modal xác nhận "Cuộc trò chuyện mới" — per-tab (mỗi tab tự hỏi khi dọn cuộc của nó).
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

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

    let tempToolsCount: Record<string, number> = {};
    let tempToolsActive = false;
    let tempToolsIds: string[] = [];
    let tempOps: import('./types.js').ToolDetail[] = [];
    let groupSeq = 0;

    const flushTempTools = () => {
      if (tempToolsIds.length > 0) {
        const details = Object.entries(tempToolsCount)
          .map(([txt, count]) => `• ${txt} (x${count})`)
          .join('\n');
        nodes.push({
          id: 'grouped-' + groupSeq++,
          type: 'tool',
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
          flushTempTools();

          const match = it.text.match(/agent phụ:\s*([a-zA-Z0-9_-]+)/i);
          const agentName = match ? match[1] : 'Subagent';

          nodes.push({
            id: it.id,
            type: 'thinking',
            label: `🤖 Gọi Agent phụ: ${agentName}`,
            detail: it.tool?.summary || it.text,
            active: false,
            ops: it.tool ? [it.tool] : undefined,
          });
        } else {
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

  const STAR_CODES = [
    'RIGEL', 'ANTARES', 'ALTAIR', 'SIRIUS', 'DENEB', 'CAPELLA',
    'POLLUX', 'SPICA', 'MIRA', 'CASTOR', 'ATLAS', 'MAIA',
  ];
  const starCodeFor = (name: string): string => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0x7fffffff;
    return STAR_CODES[h % STAR_CODES.length];
  };

  const buildAgentNodes = () => {
    const rawNodes = pipelineNodes;
    const agentsMap = new Map<string, { id: string; label: string; role?: string; type: string; detail: string; active: boolean }>();

    agentsMap.set('main', {
      id: 'main',
      label: 'SOL',
      role: language === 'vi' ? 'Điều phối' : 'Orchestration',
      type: 'approval',
      detail: language === 'vi' ? 'Agent chính điều phối và thực thi thay đổi.' : 'Main agent orchestrating and executing changes.',
      active: false,
    });
    agentsMap.set('reviewer', {
      id: 'reviewer',
      label: 'VEGA',
      role: language === 'vi' ? 'Rà soát' : 'Review',
      type: 'thinking',
      detail: language === 'vi' ? 'Chưa hoạt động. Tự động kích hoạt khi có yêu cầu rà soát mã nguồn.' : 'Inactive. Activates automatically when source review is requested.',
      active: false,
    });
    agentsMap.set('verifier', {
      id: 'verifier',
      label: 'ORION',
      role: language === 'vi' ? 'Kiểm thử' : 'Testing',
      type: 'tool',
      detail: language === 'vi' ? 'Chưa hoạt động. Tự động kích hoạt khi cần kiểm thử và xác minh thay đổi.' : 'Inactive. Activates automatically when testing and verification are needed.',
      active: false,
    });
    agentsMap.set('impact-scout', {
      id: 'impact-scout',
      label: 'LYRA',
      role: language === 'vi' ? 'Khảo sát' : 'Impact analysis',
      type: 'start',
      detail: language === 'vi' ? 'Chưa hoạt động. Tự động kích hoạt khi cần khảo sát tác động dự án.' : 'Inactive. Activates automatically when scoping project impact.',
      active: false,
    });

    rawNodes.forEach(node => {
      const lbl = node.label || '';
      const match = lbl.match(/agent phụ:\s*([a-zA-Z0-9_-]+)/i);
      if (match && match[1]) {
        const agentName = match[1];
        const agentKey = agentName.toLowerCase();

        let type = 'thinking';
        if (agentKey === 'verifier') type = 'tool';
        if (agentKey === 'impact-scout' || agentKey === 'scout') type = 'start';

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
          const roleLabel = agentName.charAt(0).toUpperCase() + agentName.slice(1);
          agentsMap.set(agentKey, {
            id: agentKey,
            label: starCodeFor(agentKey),
            role: roleLabel,
            type,
            detail,
            active: isThisActive,
          });
        }
      } else {
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

  // Báo state per-tab (running/đồng hồ + cuộc đang mở + tiêu đề) lên App cho header,
  // panel Lịch sử, và NHÃN TAB (title = câu user đầu tiên của cuộc).
  useEffect(() => {
    onStateChange({ running, runStartedAt, lastRunMs, activeConvId, title: deriveTitle(items), model: selectedModel, claudeProfile: selectedClaudeProfile, usage, usageLoading });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onStateChange, running, runStartedAt, lastRunMs, activeConvId, items, selectedModel, selectedClaudeProfile, usage, usageLoading]);

  return (
    <div className="task-pane" hidden={!visible}>
      <div className="main-layout">
        {/* Rail thu gọn 44px bên trái */}
        <div className="m-rail">
          <button
            type="button"
            className={`m-iconbtn${sidebarOpen && activeRailTab === 'toggle' ? ' on' : ''}`}
            onClick={() => {
              setActiveRailTab('toggle');
              setSidebarOpen((o) => !o);
            }}
            title={sidebarOpen ? (language === 'vi' ? 'Thu gọn sidebar (mở rộng chat thêm 300px)' : 'Collapse sidebar (expand chat by +300px)') : (language === 'vi' ? 'Mở rộng sidebar' : 'Expand sidebar')}
          >
            <Icon name="sidebar" size={16} />
          </button>
          <button
            type="button"
            className={`m-iconbtn${sidebarOpen && activeRailTab === 'chart' ? ' on' : ''}`}
            onClick={() => scrollToSection('chart')}
            title={language === 'vi' ? 'Bản đồ sao — Xem trực quan các agent & thiên thể' : 'Star Chart — View visual agent neural map'}
          >
            <Icon name="starChart" size={16} />
          </button>
          <button
            type="button"
            className={`m-iconbtn${sidebarOpen && activeRailTab === 'log' ? ' on' : ''}`}
            onClick={() => scrollToSection('log')}
            title={language === 'vi' ? 'Nhật ký hoạt động — Xem chi tiết lệnh, file & log' : 'Activity Log — View execution logs & details'}
          >
            <Icon name="activityLog" size={16} />
          </button>
        </div>

        <aside ref={sidebarRef} className={`sidebar-pipeline${sidebarOpen ? '' : ' closed'}`}>
          {/* Usage (Session 5hr + Context) đã chuyển lên header cho gọn. */}
          {(() => {
            const liveCount = agentNodes.filter((n) => n.active).length;
            return (
              <div ref={starChartRef} className="sidebar-pipeline-title star-chart-title">
                <span>{language === 'vi' ? 'Bản đồ sao' : 'Star Chart'}</span>
                <span
                  className={`star-status${running ? ' live' : ''}`}
                  title={running ? (language === 'vi' ? 'Agent đang hoạt động' : 'Agent active') : (language === 'vi' ? 'Không có agent hoạt động' : 'Agent idle')}
                >
                  <span className="star-status-dot" />
                  {running ? (liveCount > 0 ? `TRACKING · ${liveCount}` : 'TRACKING') : 'IDLE'}
                </span>
              </div>
            );
          })()}
          <div className={`neural-net-container${running ? ' is-live' : ''}`}>
            <NeuralBrain
              ref={neuralBrainRef}
              active={running}
              steps={agentNodes}
              selectedId={selectedStepId}
              onSelect={(s) => setSelectedStepId((prev) => (prev === s.id ? null : s.id))}
              theme={theme}
              accent={accent}
              onCamera={setCameraInfo}
            />
            {/* Dấu định vị 4 góc — khung ngắm kính thiên văn */}
            <span className="viewport-corner tl" />
            <span className="viewport-corner tr" />
            <span className="viewport-corner bl" />
            <span className="viewport-corner br" />
            {/* Nhãn toạ độ động do camera phát ra (thay nhãn tĩnh cũ trong CSS) */}
            <div className="viewport-readout">
              {cameraInfo
                ? `RA ${cameraInfo.ra} · DEC ${cameraInfo.dec}`
                : 'RA 12ʰ00ᵐ · DEC +05°'}
            </div>
            {cameraInfo && cameraInfo.zoom > 1.05 && (
              <div className="viewport-zoom">×{cameraInfo.zoom.toFixed(1)}</div>
            )}
            {cameraInfo?.targetLabel && (
              <div className="viewport-target" title={language === 'vi' ? `Camera đang khoá: ${cameraInfo.targetLabel}` : `Camera locked: ${cameraInfo.targetLabel}`}>
                <Icon name="target" size={11} />
                {cameraInfo.targetLabel.replace(/ Agent$/, '')}
              </div>
            )}
            {/* Nút đưa góc nhìn về mặc định */}
            <button
              className="viewport-reset"
              title={language === 'vi' ? "Đưa góc nhìn về mặc định" : "Reset view to default"}
              onClick={() => {
                neuralBrainRef.current?.resetView();
                setSelectedStepId(null);
              }}
            >
              <Icon name="refresh" size={13} />
            </button>
          </div>

          {/* Chú giải loại thiên thể + gợi ý điều khiển. Mã sao khớp nhãn trên galaxy. */}
          <div className="star-legend">
            <span className="star-legend-item" data-k="approval"><i /> SOL<em>{language === 'vi' ? 'Điều phối' : 'Orchestration'}</em></span>
            <span className="star-legend-item" data-k="thinking"><i /> VEGA<em>{language === 'vi' ? 'Rà soát' : 'Review'}</em></span>
            <span className="star-legend-item" data-k="tool"><i /> ORION<em>{language === 'vi' ? 'Kiểm thử' : 'Testing'}</em></span>
            <span className="star-legend-item" data-k="start"><i /> LYRA<em>{language === 'vi' ? 'Khảo sát' : 'Scoping'}</em></span>
          </div>
          <div className="star-hint">
            <Icon name="info" size={11} /> {language === 'vi' ? 'Kéo để xoay · Ctrl + cuộn để phóng to · bấm thiên thể để xem chi tiết' : 'Drag to rotate · Ctrl + scroll to zoom · click celestial to inspect'}
          </div>

          {/* Chi tiết bước được bấm trên bản đồ vũ trụ — "đang làm gì ở bước đó". */}
          {(() => {
            const sel = selectedStepId ? agentNodes.find((n) => n.id === selectedStepId) : null;
            if (!sel) {
              return (
                <div className="step-detail step-detail-empty">
                  {language === 'vi' ? 'Bấm vào một thiên thể hoặc chòm sao để xem chi tiết bước hoạt động.' : 'Click a celestial body or constellation to view details.'}
                </div>
              );
            }
            return (
              <div className={`step-detail step-${sel.type}`}>
                <div className="step-detail-head">
                  <span className="step-detail-label">
                    {sel.active && <Icon name="pending" size={14} className="step-detail-spin" />}
                    {sel.label}
                    {sel.role && <span className="step-detail-role"> · {sel.role}</span>}
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

          <div ref={logRef} className="sidebar-pipeline-title" style={{ marginTop: '4px', borderTop: 'var(--bd-thin) solid var(--outline)', paddingTop: '12px' }}>
            {language === 'vi' ? 'Nhật ký hoạt động' : 'Activity Log'}
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
                {language === 'vi' ? 'Chưa có tiến trình hoạt động' : 'No activity logged yet'}
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
            <h3 className="empty-title">
              {language === 'vi' ? 'Giao việc cho agent — bắt đầu từ một câu mô tả' : 'Assign tasks to agent — start with a description'}
            </h3>
            <p className="empty-sub">
              {language === 'vi'
                ? 'Nhập đề tài, dán Jira ticket hoặc URL board, kéo-thả tài liệu & ảnh wireframe vào ô bên dưới.'
                : 'Enter topic, paste Jira ticket or board URL, drag & drop documents & wireframe images below.'}
            </p>
            <div className="empty-steps">
              <div className="empty-step">
                <b>1</b>{language === 'vi' ? 'Chọn repo nguồn' : 'Select repo source'}
              </div>
              <div className="empty-step">
                <b>2</b>{language === 'vi' ? 'Mô tả việc cần làm' : 'Describe the task'}
              </div>
              <div className="empty-step">
                <b>3</b>{language === 'vi' ? 'Duyệt kế hoạch & thay đổi' : 'Review plan & changes'}
              </div>
            </div>
            <div className="quick-prompts">
              {(readonlyShare ? QUICK_PROMPTS.filter((qp) => qp.label === 'Giải thích codebase') : QUICK_PROMPTS).map((qp) => {
                const isVi = language === 'vi';
                let label = qp.label;
                let text = qp.text;
                if (!isVi) {
                  if (qp.label === 'Sửa bug từ Jira') { label = 'Fix bug from Jira'; text = 'Fix bug from Jira ticket: '; }
                  else if (qp.label === 'Làm theo đề xuất') { label = 'Follow proposal'; text = 'Implement proposal: '; }
                  else if (qp.label === 'Giải thích codebase') { label = 'Explain codebase'; text = 'Explain codebase architecture and main flow.'; }
                  else if (qp.label === 'Viết test') { label = 'Write tests'; text = 'Write unit tests for: '; }
                  else if (qp.label === 'Review & rà lỗi') { label = 'Review code'; text = 'Review code and find potential bugs/improvements.'; }
                  else if (qp.label === 'Sinh commit / PR') { label = 'Generate commit/PR'; text = 'Generate git commit message and PR description.'; }
                  else if (qp.label === 'Refactor / dọn code') { label = 'Refactor code'; text = 'Refactor code to improve readability and structure.'; }
                }
                return (
                  <button
                    key={qp.label}
                    type="button"
                    className="quick-prompt-chip"
                    onClick={() => applyQuickPrompt({ text })}
                    title={text}
                  >
                    <Icon name={qp.icon} size={15} /> {label}
                  </button>
                );
              })}
            </div>
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
        {/* Hàng chip tóm tắt cấu hình + popover config đầy đủ */}
        {(() => {
          const modeLabel = modeDef(mode, language).label;
          const modelLabel = selectedModel === 'claude-opus-4-8' ? 'Opus 4.8' : selectedModel === 'claude-sonnet-5' ? 'Sonnet 5' : selectedModel === 'claude-haiku-4-5-20251001' ? 'Haiku 4.5' : selectedModel === 'claude-fable-5' ? 'Fable 5' : selectedModel;
          const effortLabel = effort === 'high' ? (language === 'vi' ? 'Cao' : 'High') : effort === 'low' ? (language === 'vi' ? 'Thấp' : 'Low') : effort === 'medium' ? (language === 'vi' ? 'Trung bình' : 'Med') : effort === 'xhigh' ? (language === 'vi' ? 'Rất cao' : 'Xhigh') : (language === 'vi' ? 'Tối đa' : 'Max');

          return (
            <div className="composer-cfg-row">
              <button
                type="button"
                className={`cfg-chip cfg-summary${configPopOpen ? ' open' : ''}`}
                onClick={() => setConfigPopOpen((o) => !o)}
                title={language === 'vi' ? 'Bấm để mở/đóng bảng cấu hình phiên chạy đầy đủ' : 'Click to toggle full run configuration panel'}
              >
                <Icon name="gear" size={13} />
                ⚙ <b>{modelLabel}</b> · {modeLabel} · {effortLabel}
              </button>

              {cfg?.claudeProfiles && cfg.claudeProfiles.length > 0 && (
                <button
                  type="button"
                  className="cfg-chip"
                  onClick={() => {
                    setAuthModal({ profile: selectedClaudeProfile, mode: 'select' });
                  }}
                  title={language === 'vi' ? `Tài khoản '${selectedClaudeProfile}' (bấm để xem/đổi)` : `Account '${selectedClaudeProfile}'`}
                >
                  <span className={`cfg-auth ${tabProfileAuthed ? 'ok' : 'bad'}`}>
                    👤 {selectedClaudeProfile === 'default' ? 'default' : `claude-${selectedClaudeProfile}`}
                  </span>
                  {tabProfileAuthed ? ' ✓' : ' ⚠️'}
                </button>
              )}

              {!readonlyShare && (
                <button
                  type="button"
                  className="cfg-chip"
                  onClick={() => { if (!running && cfg?.isAdmin) openPicker(cwd); }}
                  title={cwd || 'Chưa chọn thư mục repo (cwd)'}
                >
                  📁 {cwd.trim() ? (cwd.trim().split('/').filter(Boolean).pop() ?? cwd) : 'Chọn repo'}
                </button>
              )}

              {!readonlyShare && profile === 'auto' && detected && detected.profile !== 'none' && (
                <span
                  className="cfg-chip profile-badge"
                  title={language === 'vi' ? `Kiến thức repo (~${detected.profileChars ? Math.round(detected.profileChars / 1000) + 'K' : '?'} ký tự)` : `Repo knowledge (~${detected.profileChars ? Math.round(detected.profileChars / 1000) + 'K' : '?'} chars)`}
                >
                  <strong>{detected.profile}</strong>
                  {detected.profileChars ? ` ~${Math.round(detected.profileChars / 1000)}K` : ''}
                </span>
              )}
            </div>
          );
        })()}

        <div style={{ position: 'relative' }}>
          {/* Popover chứa 2 control-row đầy đủ bung lên trên */}
          <div ref={configPopRef} className={`composer-config-pop${configPopOpen ? ' open' : ''}`}>
            <div className="controls">
          {/* Hàng 1 — CẤU HÌNH CHẠY: chế độ, model, profile, stack skill.
              Nhóm theo chức năng (xuống hàng có chủ đích) cho gọn thay vì 1 hàng dài. */}
          <div className="control-row" data-group={language === 'vi' ? 'Cấu hình' : 'Config'}>
          {/* QC Mode: backend ép chế độ 'plan' → ẩn ô Chế độ (chọn cũng vô nghĩa).
              Vẫn cho QC đổi Model/Profile/Effort để chọn model nhẹ hơn khi hỏi. */}
          {!readonlyShare && (
          <div className="field">
            {language === 'vi' ? 'Chế độ:' : 'Mode:'}
            <ModeSelect value={mode} onChange={setMode} disabled={running} language={language} />
          </div>
          )}
          {readonlyShare ? (
            // QC Mode cố định Sonnet (backend cũng ép) → khoá picker, chỉ hiện nhãn.
            <label>
              {language === 'vi' ? 'Mô hình:' : 'Model:'}
              <PixelSelect
                value="claude-sonnet-5"
                onChange={() => {}}
                disabled
                options={[{ value: 'claude-sonnet-5', label: 'Sonnet 5' }]}
              />
            </label>
          ) : (
          <label>
            {language === 'vi' ? 'Mô hình:' : 'Model:'}
            <PixelSelect
              value={selectedModel}
              onChange={setSelectedModel}
              disabled={running}
              options={[
                { value: 'claude-fable-5', label: 'Fable 5' },
                { value: 'claude-opus-4-8', label: 'Opus 4.8' },
                { value: 'claude-sonnet-5', label: 'Sonnet 5' },
                { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
              ]}
            />
          </label>
          )}
          <label>
            {language === 'vi' ? 'Hồ sơ:' : 'Profile:'}
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
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              {language === 'vi' ? 'Công nghệ:' : 'Stack:'}
              <PixelSelect
                value={stack}
                onChange={setStack}
                disabled={running}
                options={[
                  { value: '', label: language === 'vi' ? 'Không (mặc định)' : 'None (default)' },
                  ...skillStacks.map((s) => ({ value: s.id, label: s.label })),
                ]}
              />
              {/* Badge trạng thái tải skill + nút Đồng bộ thủ công — chỉ admin (endpoint gate requireAdmin).
                  Badge cho biết core + stack đang chọn đã cache (chạy offline được) chưa; nút Sync tải + trải ngay.
                  Kết quả lần đồng bộ gần nhất (skillSyncMsg) gộp luôn vào tooltip của badge → không chiếm 1 dòng riêng. */}
              {cfg?.isAdmin && skillStatus && (() => {
                // Mô tả 1 nguồn cho tooltip: state + ref registry, kèm ref đã trải nếu lệch.
                const srcLine = (label: string, s: SkillSrc) => {
                  const tag =
                    s.state === 'synced' ? `✅ đã trải, đúng bản (${s.ref})`
                    : s.state === 'stale' ? `⚠️ đã trải bản cũ ${s.deployedRef || '?'} → registry đã lên ${s.ref}${s.cached ? '' : ' (chưa cache)'}`
                    : `⬇️ chưa trải vào dự án (${s.ref})${s.cached ? ', đã cache sẵn' : ''}`;
                  return `${label}: ${tag}`;
                };
                const icon = skillStatus.state === 'synced' ? '✅' : skillStatus.state === 'stale' ? '⚠️' : '⬇️';
                const head =
                  skillStatus.state === 'synced' ? 'Skill đã đồng bộ với dự án'
                  : skillStatus.state === 'stale' ? 'Skill trong dự án CŨ hơn registry — bấm 🔄 để cập nhật'
                  : 'Skill CHƯA trải vào dự án — bấm 🔄 để tải & trải';
                return (
                  <span
                    title={
                      head + '\n\n' +
                      srcLine('Core', skillStatus.core) +
                      (skillStatus.stack ? '\n' + srcLine(`Stack ${skillStatus.stack.label}`, skillStatus.stack) : '') +
                      (skillSyncMsg ? `\n\n${skillSyncMsg}` : '')
                    }
                    style={{ fontSize: '14px', lineHeight: 1, cursor: 'default' }}
                  >
                    {icon}
                  </span>
                );
              })()}
              {cfg?.isAdmin && (
                <button
                  type="button"
                  className="btn icon-only"
                  disabled={skillSyncing || running}
                  onClick={syncSkillsNow}
                  title="Đồng bộ skill: tải & trải core + stack đang chọn vào .claude/skills/ của dự án (không cần chạy phiên)"
                >
                  {skillSyncing ? '⏳' : '🔄'}
                </button>
              )}
            </label>
          )}
          </div>
          {/* Hàng 2 — TÀI KHOẢN & AGENT: profile Claude, effort, đội agent, và repo (đẩy phải). */}
          <div className="control-row" data-group={language === 'vi' ? 'Tác nhân' : 'Agent'}>
          {cfg?.claudeProfiles && cfg.claudeProfiles.length > 0 && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              {language === 'vi' ? 'Tài khoản:' : 'Account:'}
              <PixelSelect
                value={selectedClaudeProfile}
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
                        // Nếu tab đang chọn tài khoản vừa xoá → lùi về 'default'.
                        if (selectedClaudeProfile === profileToDelete) setSelectedClaudeProfile('default');
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
                          // Tab này chuyển sang dùng tài khoản vừa tạo (per-tab, không đụng tab khác).
                          setSelectedClaudeProfile(cleaned);
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
                    // Chọn tài khoản = CHỈ đổi cho TAB NÀY (per-tab). KHÔNG gọi /api/profiles để
                    // switch env server nữa — runner nhận claudeProfile trong body /api/run và
                    // dựng CLAUDE_CONFIG_DIR riêng cho query của tab này. Nhờ đó mỗi tab chạy 1
                    // tài khoản khác nhau song song, không giẫm lên nhau.
                    setSelectedClaudeProfile(newProfile);
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
              {tabProfileAuthed ? (
                <span title={`Tài khoản 'claude-${selectedClaudeProfile}' đã đăng nhập`} style={{ color: '#00e676', fontWeight: 'bold', fontSize: '13px', cursor: 'help' }}>✓</span>
              ) : (
                <span title={`Tài khoản 'claude-${selectedClaudeProfile}' CHƯA đăng nhập! Bấm khoá để đăng nhập hoặc cài token.`} style={{ color: '#ff1744', fontWeight: 'bold', fontSize: '13px', cursor: 'help' }}>⚠️</span>
              )}
              {/* Nút cài đặt đăng nhập rút thành icon (khoá) — nhãn dài "Cài đặt Login" đưa vào tooltip.
                  Chưa auth thì tô nổi (.allow) để mời người dùng bấm đăng nhập. */}
              <button
                type="button"
                className={`btn icon-only${tabProfileAuthed ? '' : ' allow'}`}
                disabled={running}
                title={tabProfileAuthed ? `Cài đặt đăng nhập / đổi token cho 'claude-${selectedClaudeProfile}'` : `Tài khoản 'claude-${selectedClaudeProfile}' chưa đăng nhập — bấm để đăng nhập hoặc cài token`}
                onClick={() => {
                  setAuthModal({
                    profile: selectedClaudeProfile,
                    mode: 'select',
                  });
                }}
              >
                <Icon name="lock" size={15} />
              </button>
            </label>
          )}
          <label>
            {language === 'vi' ? 'Nỗ lực:' : 'Effort:'}
            <PixelSelect
              value={effort}
              onChange={setEffort}
              disabled={running}
              options={[
                { value: 'low', label: language === 'vi' ? 'Thấp' : 'Low' },
                { value: 'medium', label: language === 'vi' ? 'Trung bình' : 'Medium' },
                { value: 'high', label: language === 'vi' ? 'Cao' : 'High' },
                { value: 'xhigh', label: language === 'vi' ? 'Rất cao' : 'Xhigh' },
                { value: 'max', label: language === 'vi' ? 'Tối đa' : 'Max' },
              ]}
            />
          </label>
          {/* Badge gọn: khi AUTO & có profile repo, hiện tên + cỡ kiến thức nhồi vào agent.
              Trước đây thông tin này nằm ở dòng .detected dài dòng → dời vào hàng Agent. */}
          {!readonlyShare && profile === 'auto' && detected && detected.profile !== 'none' && (
            <span className="profile-badge" title={language === 'vi' ? `Kiến thức repo này (~${detected.profileChars ? Math.round(detected.profileChars / 1000) + 'K' : '?'} ký tự) được nhồi sẵn vào agent khi PROFILE: AUTO` : `Repo knowledge (~${detected.profileChars ? Math.round(detected.profileChars / 1000) + 'K' : '?'} chars) injected when PROFILE is AUTO`}>
              <strong>{detected.profile}</strong>
              {detected.profileChars ? ` ~${Math.round(detected.profileChars / 1000)}K` : ''}
            </span>
          )}
          {/* Đội agent (multi-agent): bật reviewer/verifier/impact-scout. Tốn token hơn nên
              CHỈ admin thấy/dùng; server cũng cưỡng chế lại (allowSubagents = isAdmin && …). */}
          {cfg?.isAdmin && (
            <label
              className={`bow-switch${useSubagents ? ' on' : ''}${running ? ' disabled' : ''}`}
              title={language === 'vi' ? "Bật đội agent phụ: reviewer (phản biện kế hoạch), verifier (kiểm chứng runtime), impact-scout (quét ảnh hưởng). Chất lượng cao hơn nhưng tốn token hơn." : "Enable sub-agents: reviewer (plan review), verifier (runtime checks), impact-scout (impact scan). Higher quality but consumes more tokens."}
            >
              <input
                type="checkbox"
                checked={useSubagents}
                disabled={running}
                onChange={(e) => setUseSubagents(e.target.checked)}
              />
              <span className="bow-switch-track" aria-hidden="true"><span className="bow-switch-thumb" /></span>
              <span className="bow-switch-label">🤖 {language === 'vi' ? 'Đội agent' : 'Agent team'}</span>
            </label>
          )}
          {/* Ô chọn thư mục repo (cwd) — thu gọn, nằm cuối hàng bên phải Effort.
              Chỉ HIỂN THỊ tên folder (basename, vd "monorepo"); cwd đầy đủ vẫn giữ ở state
              để gửi backend, và hiện qua tooltip khi hover.
              Ẩn ở QC Mode: repo bị khoá vào qcCwd, chỉ Admin đổi được (chỗ khác). */}
          {!readonlyShare && (
            <div
              className="cwd-container"
              style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}
              title={cwd || 'Chưa chọn thư mục repo (cwd)'}
            >
              {cfg?.isAdmin ? (
                /* Gộp input + nút thành MỘT nút icon-thư-mục kèm tên repo gọn — bấm mở picker.
                   Bỏ ô input 130px cũ cho hàng ngắn lại; cwd đầy đủ vẫn ở tooltip cha. */
                <button
                  className="btn cwd-pick"
                  type="button"
                  disabled={running}
                  onClick={() => { if (!running) openPicker(cwd); }}
                  title="Chọn thư mục repo (cwd)"
                >
                  <Icon name="folder" size={15} />
                  <span className="cwd-pick-name">
                    {cwd.trim() ? (cwd.trim().split('/').filter(Boolean).pop() ?? cwd) : 'Chọn repo'}
                  </span>
                </button>
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
        </div>
      </div>
      </div>

        {/* Chỉ hiện khi repo CHƯA có profile — để mời "Sinh profile cho repo này".
            Khi đã có profile, thông tin tên+cỡ đã nằm gọn ở badge Hàng Agent nên ẩn hẳn dòng này. */}
        {!readonlyShare && detected && detected.profile === 'none' && !detected.empty && (
          <div className="detected">
            <Icon name="search" size={14} /> {detected.summary}
            <button className="btn genprof" disabled={running} onClick={genProfile}>
              Sinh profile cho repo này
            </button>
          </div>
        )}

        {/* Chỉ báo workspace: cwd này thuộc sản phẩm nào, gồm những repo anh em nào.
            Cho người dùng biết agent đang có ngữ cảnh cả nhóm repo + trí nhớ tích lũy. */}
        {!readonlyShare && currentWs && (
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



        {/* Tay kéo giãn ô nhập: kéo lên = cao ra, xuống = thấp lại; bấm đúp = trả về
            mặc định. Đặt trong luồng ngay trên ô nhập nên không che phần đầu khung. */}
        <div
          className="composer-resize-handle"
          onPointerDown={startTaskResize}
          onDoubleClick={() => setTaskHeight(null)}
          role="separator"
          aria-orientation="horizontal"
          title={language === 'vi' ? "Kéo để đổi chiều cao ô nhập · bấm đúp để trả về mặc định" : "Drag to resize input height · double-click to reset"}
        >
          <span className="composer-resize-grip" />
        </div>

        {/* Hàng từ gợi ý nhanh (Quick Prompts) giúp điền mẫu vào ô nhập nhanh chóng */}
        {!running && (
          <div className="composer-quick-prompts">
            {(readonlyShare ? QUICK_PROMPTS.filter((qp) => qp.label === 'Giải thích codebase') : QUICK_PROMPTS).map((qp) => {
              const isVi = language === 'vi';
              let label = qp.label;
              let text = qp.text;
              if (!isVi) {
                if (qp.label === 'Sửa bug từ Jira') { label = 'Fix bug from Jira'; text = 'Fix bug from Jira ticket: '; }
                else if (qp.label === 'Làm theo đề xuất') { label = 'Follow proposal'; text = 'Implement proposal: '; }
                else if (qp.label === 'Giải thích codebase') { label = 'Explain codebase'; text = 'Explain codebase architecture and main flow.'; }
                else if (qp.label === 'Viết test') { label = 'Write tests'; text = 'Write unit tests for: '; }
                else if (qp.label === 'Review & rà lỗi') { label = 'Review code'; text = 'Review code and find potential bugs/improvements.'; }
                else if (qp.label === 'Sinh commit / PR') { label = 'Generate commit/PR'; text = 'Generate git commit message and PR description.'; }
                else if (qp.label === 'Refactor / dọn code') { label = 'Refactor code'; text = 'Refactor code to improve readability and structure.'; }
              }
              return (
                <button
                  key={qp.label}
                  type="button"
                  className="quick-prompt-chip"
                  onClick={() => applyQuickPrompt({ text })}
                  title={text}
                >
                  <Icon name={qp.icon} size={13} /> {label}
                </button>
              );
            })}
          </div>
        )}

        <div className="composer-input">
          <textarea
            ref={taskRef}
            className="task"
            style={taskHeight != null ? { height: taskHeight, maxHeight: 'none' } : undefined}
            placeholder={language === 'vi' ? "Mô tả task / đề tài…  ·  Ctrl+Enter để chạy  ·  kéo-thả file/ảnh vào đây" : "Describe task / topic...  ·  Ctrl+Enter to run  ·  drag & drop file/image here"}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') start();
            }}
            onPaste={onPaste}
            disabled={running}
            rows={3}
            // Chặn popup iCloud Passwords / autofill mật khẩu nhảy ra khi focus ô task.
            // autoComplete giá trị lạ ("new-password" bị autofill bám; dùng token vô nghĩa
            // để Chrome/iCloud/1Password/LastPass bỏ qua hẳn field này).
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            name="bow-task-input"
            id="bow-task-input"
            data-form-type="other"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore="true"
          />
          <div className="composer-bar">
            <label className="btn attach" title={language === 'vi' ? "Đính kèm tài liệu / ảnh (hoặc kéo-thả vào ô nhập)" : "Attach documents / images (or drag & drop into the input box)"}>
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
              // Bật khi: đang chạy, có nội dung, HOẶC đang gắn một cuộc (activeConvId/
              // conversationId) — kể cả khi khung đã trống (để "rời" cuộc cũ đang xem).
              // Chỉ tắt khi đã là cuộc mới trống hoàn toàn (bấm cũng chẳng làm gì).
              disabled={!running && !items.length && !activeConvId && !conversationId}
              title={language === 'vi' ? "Bắt đầu cuộc trò chuyện mới — cuộc hiện tại vẫn được lưu vào Lịch sử (mở lại được). Dừng agent nếu đang chạy." : "Start new conversation — current session remains saved in History. Stops agent if running."}
            >
              <Icon name="newChat" size={15} /> {language === 'vi' ? 'Cuộc trò chuyện mới' : 'New chat'}
            </button>
            {running ? (
              <button className="btn stop" onClick={stop}>
                {language === 'vi' ? 'Dừng' : 'Stop'}
              </button>
            ) : (
              <button className="btn run" onClick={start}>
                {language === 'vi' ? 'Chạy' : 'Run'}
              </button>
            )}
          </div>
        </div>
        </div>
      </div>
      </div>
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
    </div>
  );
});
