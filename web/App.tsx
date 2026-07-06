import { useEffect, useRef, useState } from 'react';
import { PixelSelect } from './PixelSelect.js';
import { NeuralBrain } from './NeuralBrain.js';
import type {
  ChatItem,
  DetectedSource,
  DocAttachment,
  ImageAttachment,
  Mode,
  PendingApproval,
  WebEvent,
} from './types.js';

type Theme = 'light' | 'dark';

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
const QUICK_PROMPTS: { label: string; text: string }[] = [
  { label: '🐛 Sửa bug từ Jira', text: 'Hãy đọc và giải quyết ticket Jira: ' },
  {
    label: '💡 Làm theo đề xuất',
    text: 'Phân tích vấn đề, đề xuất hướng làm rồi trình bày kế hoạch để tôi duyệt trước khi thực thi.',
  },
  {
    label: '📖 Giải thích codebase',
    text: 'Đọc và giải thích cấu trúc dự án này: các module chính, luồng dữ liệu, và điểm cần lưu ý.',
  },
];

export function App() {
  const [task, setTask] = useState(() => localStorage.getItem('bow-task') || '');
  const [cwd, setCwd] = useState(() => localStorage.getItem('bow-cwd') || '');
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('bow-mode') as Mode) || 'plan');
  const [profile, setProfile] = useState(() => localStorage.getItem('bow-profile') || 'auto');
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem('bow-selectedModel') || 'claude-opus-4-8');
  const [effort, setEffort] = useState(() => localStorage.getItem('bow-effort') || 'high');
  // Bước (điểm trên não neuron) đang được người dùng bấm chọn để xem chi tiết.
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
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
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Đồng bộ hóa cấu hình composer vào localStorage
  useEffect(() => { localStorage.setItem('bow-task', task); }, [task]);
  useEffect(() => { localStorage.setItem('bow-cwd', cwd); }, [cwd]);
  useEffect(() => { localStorage.setItem('bow-mode', mode); }, [mode]);
  useEffect(() => { localStorage.setItem('bow-profile', profile); }, [profile]);
  useEffect(() => { localStorage.setItem('bow-selectedModel', selectedModel); }, [selectedModel]);
  useEffect(() => { localStorage.setItem('bow-effort', effort); }, [effort]);
  useEffect(() => { localStorage.setItem('bow-language', language); }, [language]);
  useEffect(() => { localStorage.setItem('bow-selectedMcps', JSON.stringify(selectedMcps)); }, [selectedMcps]);

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
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('bow-theme') as Theme) || 'light',
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);

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

  // Auto-nhận diện source mỗi khi cwd đổi (debounce nhẹ).
  useEffect(() => {
    if (!cwd.trim()) return;
    const t = setTimeout(() => {
      fetch(`/api/detect?cwd=${encodeURIComponent(cwd.trim())}`)
        .then((r) => r.json())
        .then((d: DetectedSource) => {
          setDetected(d);
        })
        .catch(() => setDetected(null));
    }, 400);
    return () => clearTimeout(t);
  }, [cwd]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [items, pending]);

  const addItem = (kind: ChatItem['kind'], text: string) =>
    setItems((prev) => [...prev, { id: nextId(), kind, text }]);

  async function onFiles(files: FileList | null) {
    if (!files) return;
    for (const f of Array.from(files)) {
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

  async function start() {
    if (running) return;
    const hasInput = task.trim() || docs.length || pdfs.length || images.length;
    if (!hasInput) return;

    // Giữ lịch sử cũ — task mới nối tiếp bên dưới (chat liên tục). Chỉ dọn approval treo.
    setPending([]);
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
    // Backend replay toàn bộ history của session này từ đầu. Cắt items về mốc
    // baseline (số item trước khi session bắt đầu) để dựng lại sạch, không nhân
    // đôi, mà vẫn giữ nguyên lịch sử các task cũ nằm phía trên baseline.
    setItems((prev) => prev.slice(0, sessionBaselineRef.current));
    setPending([]);
    const src = new EventSource(`/api/events/${sid}`);
    src.onmessage = (msg) => {
      const ev = JSON.parse(msg.data) as WebEvent;
      switch (ev.type) {
        case 'text':
          addItem('agent', ev.text);
          break;
        case 'tool':
          addItem('tool', ev.describe);
          break;
        case 'result':
          addItem(
            'result',
            `Xong · ${ev.turns} lượt · ${ev.outputTokens} tokens · $${ev.costUsd.toFixed(4)}`,
          );
          setAccumulatedCost((prev) => prev + ev.costUsd);
          break;
        case 'error':
          addItem('error', `Kết thúc bất thường: ${ev.subtype}`);
          break;
        case 'approval-request':
          setPending((prev) => [
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
          ]);
          break;
        case 'done':
          setRunning(false);
          localStorage.removeItem('bow-session-id');
          src.close();
          break;
        case 'fatal':
          addItem('error', ev.message);
          setRunning(false);
          localStorage.removeItem('bow-session-id');
          src.close();
          break;
      }
    };
    src.addEventListener('end', () => {
      setRunning(false);
      src.close();
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

  async function stop() {
    if (!sessionId) return;
    setRunning(false);
    localStorage.removeItem('bow-session-id');
    addItem('system', '⏹ Yêu cầu dừng agent...');
    await fetch(`/api/stop/${sessionId}`, { method: 'POST' }).catch(() => {});
  }

  /** Xóa toàn bộ lịch sử chat (thủ công). Không đụng session đang chạy. */
  /** Mở cửa sổ xác nhận xóa chat (không xóa ngay). */
  function clearChat() {
    if (!items.length || running) return;
    setConfirmClearOpen(true);
  }

  /** Thực thi xóa sau khi người dùng xác nhận trong modal. */
  function confirmClearChat() {
    setItems([]);
    setPending([]);
    sessionBaselineRef.current = 0;
    localStorage.removeItem('bow-chat-items');
    localStorage.removeItem('bow-session-baseline');
    setConfirmClearOpen(false);
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
    const nodes: { id: string; type: string; label: string; detail?: string; active?: boolean; count?: number }[] = [];

    if (items.length > 0 || running) {
      nodes.push({
        id: 'start',
        type: 'start',
        label: 'Khởi động',
        detail: 'Đang gửi brief lên agent...',
      });
    }

    items.forEach((it) => {
      if (it.kind === 'tool') {
        // Gộp các lần dùng CÙNG một tool liên tiếp thành 1 dòng kèm số lần (×N),
        // tránh 7 dòng "🔍 tìm công cụ…" giống hệt nhau gây rối.
        const last = nodes[nodes.length - 1];
        if (last && last.type === 'tool' && last.label.replace(/ ×\d+$/, '') === it.text) {
          const n = (last.count ?? 1) + 1;
          last.count = n;
          last.label = `${it.text} ×${n}`;
        } else {
          nodes.push({
            id: it.id,
            type: 'tool',
            label: it.text,
            count: 1,
          });
        }
      } else if (it.kind === 'result') {
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
    });

    pending.forEach((p) => {
      nodes.push({
        id: p.id,
        type: 'approval',
        label: `Chờ duyệt: ${p.toolName}`,
        detail: p.title || p.description || '',
        active: true,
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">▚ BOW-AGENT</div>
        <div className="topbar-right">
          <div className="meta">
            <span style={{ color: accumulatedCost > 2 ? 'var(--red)' : 'inherit' }}>
              Tích lũy: ${accumulatedCost.toFixed(4)}
            </span>
          </div>
          <div className="lang-select" title="Ngôn ngữ trả lời của agent">
            <span aria-hidden="true">🌐</span>
            <PixelSelect
              value={language}
              onChange={setLanguage}
              options={[
                { value: 'vi', label: 'VIỆT' },
                { value: 'en', label: 'ENGLISH' },
              ]}
            />
          </div>
          <button
            className="theme-btn"
            title="Quản lý MCP server (Jira/Supabase/... cho agent)"
            onClick={openMcpPanel}
          >
            🔌
          </button>
          <button
            className="theme-btn"
            title={theme === 'light' ? 'Chuyển Dark' : 'Chuyển Light'}
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            {theme === 'light' ? '🌙' : '☀'}
          </button>
        </div>
      </header>

      <div className="main-layout">
        <aside className="sidebar-pipeline">
          <div className="sidebar-pipeline-title">◈ MẠNG NƠ-RON HOẠT ĐỘNG</div>

          <div className="neural-net-container">
            <NeuralBrain
              active={running}
              steps={pipelineNodes}
              selectedId={selectedStepId}
              onSelect={(s) => setSelectedStepId((prev) => (prev === s.id ? null : s.id))}
            />
          </div>

          {/* Chi tiết bước được bấm trên não — "đang làm gì ở bước đó". */}
          {(() => {
            const sel = selectedStepId ? pipelineNodes.find((n) => n.id === selectedStepId) : null;
            if (!sel) {
              return (
                <div className="step-detail step-detail-empty">
                  Bấm vào một điểm trên não để xem bước đó đang làm gì.
                </div>
              );
            }
            return (
              <div className={`step-detail step-${sel.type}`}>
                <div className="step-detail-head">
                  <span className="step-detail-label">
                    {sel.active ? '⏳ ' : ''}{sel.label}
                  </span>
                  <button
                    className="step-detail-close"
                    title="Đóng"
                    onClick={() => setSelectedStepId(null)}
                  >
                    ✕
                  </button>
                </div>
                {sel.detail && <div className="step-detail-body">{sel.detail}</div>}
                {!sel.detail && (
                  <div className="step-detail-body step-detail-muted">
                    {sel.active ? 'Đang thực hiện…' : 'Đã hoàn tất bước này.'}
                  </div>
                )}
              </div>
            );
          })()}

          <div className="sidebar-pipeline-title" style={{ marginTop: '8px', borderTop: 'var(--bd-thin) solid var(--outline)', paddingTop: '10px' }}>
            ☰ LỊCH SỬ HOẠT ĐỘNG
          </div>

          <div className="pipeline-flow" style={{ flex: 1, overflowY: 'auto' }}>
            {pipelineNodes.map((node) => {
              let dotClass = '';
              let dotIcon = '●';
              if (node.active) {
                dotClass = 'active';
                dotIcon = '⏳';
              } else if (node.type === 'result') {
                dotClass = 'success';
                dotIcon = '✓';
              } else if (node.type === 'error') {
                dotClass = 'error';
                dotIcon = '✗';
              } else if (node.type === 'tool') {
                dotIcon = '🔧';
              } else if (node.type === 'approval') {
                dotClass = 'active';
                dotIcon = '⛔';
              }

              return (
                <div key={node.id} className="pipeline-item">
                  <div className={`pipeline-dot ${dotClass}`}>{dotIcon}</div>
                  <div className="pipeline-content">
                    <div className="pipeline-label">{node.label}</div>
                    {node.detail && <div className="pipeline-detail">{node.detail}</div>}
                  </div>
                </div>
              );
            })}
            {pipelineNodes.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '24px 0', fontFamily: 'VT323', fontSize: '18px' }}>
                Chưa có tiến trình hoạt động
              </div>
            )}
          </div>
        </aside>

        <div className="chat-container">
          <div className="chat" ref={scrollRef}>
        {items.length === 0 && !running && (
          <div className="empty">
            Nhập đề tài / task, dán Jira ticket hoặc URL board, kéo-thả tài liệu &amp; ảnh
            (wireframe) vào đây.
            <br />
            Agent tự nhận diện <b>source</b> từ thư mục repo.
          </div>
        )}
        {items.map((it) => (
          <div key={it.id} className={`bubble ${it.kind}`}>
            {it.text}
          </div>
        ))}
        {pending.map((p) => (
          <div key={p.id} className="approval">
            <div className="approval-head">
              ⛔ {p.title || `Cần duyệt: ${p.toolName}`}
            </div>
            <div className="approval-body-custom">
              {p.description && <div className="approval-desc">{p.description}</div>}
              {p.blockedPath && (
                <div className="approval-path">
                  ⚠️ Đường dẫn bị chặn: <code>{p.blockedPath}</code>
                </div>
              )}
              {p.decisionReason && (
                <div className="approval-reason">💡 Lý do: {p.decisionReason}</div>
              )}

              {p.toolName === 'Bash' && typeof p.input.command === 'string' ? (
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
                    <code>{String(p.input.path || p.input.TargetFile || '')}</code>
                  </div>
                  {typeof (p.input.content || p.input.CodeContent) === 'string' && (
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
                    <code>{String(p.input.path || p.input.TargetFile || '')}</code>
                  </div>
                  {typeof p.input.TargetContent === 'string' && p.input.TargetContent && (
                    <>
                      <div className="diff-label deletion">- Tìm kiếm (cũ):</div>
                      <pre className="diff-del">
                        <code>{p.input.TargetContent}</code>
                      </pre>
                    </>
                  )}
                  {typeof p.input.ReplacementContent === 'string' && p.input.ReplacementContent && (
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
                  <code>{JSON.stringify(p.input, null, 2).slice(0, 1200)}</code>
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
        ))}
        {running && pending.length === 0 && <div className="thinking">⏳ Agent đang làm việc…</div>}
      </div>

      <div
        className="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onFiles(e.dataTransfer.files);
        }}
      >
        <div className="controls">
          <label>
            Chế độ:
            <PixelSelect
              value={mode}
              onChange={(v) => setMode(v as Mode)}
              disabled={running}
              options={[
                { value: 'plan', label: 'KẾ HOẠCH' },
                { value: 'execute', label: 'THỰC THI' },
              ]}
            />
          </label>
          <label>
            Model:
            <PixelSelect
              value={selectedModel}
              onChange={setSelectedModel}
              disabled={running}
              options={[
                { value: 'claude-opus-4-8', label: 'OPUS 4.8' },
                { value: 'claude-sonnet-5', label: 'SONNET 5' },
                { value: 'claude-haiku-4-5-20251001', label: 'HAIKU 4.5' },
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
                { value: 'auto', label: 'AUTO' },
                { value: 'none', label: 'NONE' },
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
                { value: 'low', label: 'LOW' },
                { value: 'medium', label: 'MEDIUM' },
                { value: 'high', label: 'HIGH' },
                { value: 'xhigh', label: 'XHIGH' },
                { value: 'max', label: 'MAX' },
              ]}
            />
          </label>

        </div>

        {detected && (
          <div className="detected">
            🔎 {detected.summary}
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
              📁
            </button>
          </div>
        </div>

        {(docs.length > 0 || pdfs.length > 0 || images.length > 0) && (
          <div className="attachments">
            {docs.map((d, i) => (
              <span key={`d${i}`} className="chip">
                📄 {d.name}
                <button onClick={() => setDocs((p) => p.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
            {pdfs.map((p, i) => (
              <span key={`p${i}`} className="chip">
                📕 {p.name}
                <button onClick={() => setPdfs((prev) => prev.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
            {images.map((im, i) => (
              <span key={`i${i}`} className="chip">
                🖼 {im.name}
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
                {qp.label}
              </button>
            ))}
          </div>
        )}

        <div className="row">
          <textarea
            ref={taskRef}
            className="task"
            placeholder="Mô tả task / đề tài… (Ctrl+Enter để chạy · kéo-thả file/ảnh vào ô này)"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') start();
            }}
            disabled={running}
            rows={3}
          />
          <div className="actions">
            <label className="btn attach">
              📎
              <input
                type="file"
                multiple
                hidden
                onChange={(e) => onFiles(e.target.files)}
                disabled={running}
              />
            </label>
            {running ? (
              <button className="btn stop" onClick={stop}>
                Dừng
              </button>
            ) : (
              <button className="btn run" onClick={start}>
                Chạy
              </button>
            )}
            <button
              className="btn clear-chat"
              onClick={clearChat}
              disabled={running || !items.length}
              title="Xóa toàn bộ lịch sử chat"
            >
              Xóa chat
            </button>
          </div>
        </div>
        </div>
      </div>
      </div>

      {pickerOpen && (
        <div className="modal-overlay" onClick={() => setPickerOpen(false)}>
          <div className="modal-content pixel-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span>📁 Chọn thư mục làm việc</span>
              <button className="close-btn" onClick={() => setPickerOpen(false)}>×</button>
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

              {pickerError && <div className="picker-error" style={{ color: 'var(--red)', marginBottom: '10px' }}>⚠️ {pickerError}</div>}

              <div className="dirs-list" style={{ maxHeight: '250px', overflowY: 'auto', border: 'var(--bd-thin) solid var(--outline)', padding: '6px', background: 'var(--inset)' }}>
                {pickerParent !== null && (
                  <div className="dir-item parent-dir" style={{ padding: '6px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }} onClick={() => fetchDirs(pickerParent)}>
                    📁 <span style={{ fontFamily: 'monospace' }}>[..] (Thư mục cha)</span>
                  </div>
                )}
                {pickerDirs.map((dir) => (
                  <div
                    key={dir}
                    className="dir-item"
                    style={{ padding: '6px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
                    onClick={() => fetchDirs(pickerPath + (pickerPath.endsWith('/') || pickerPath.endsWith('\\') ? '' : pickerPath.includes('\\') ? '\\' : '/') + dir)}
                  >
                    📁 <span style={{ fontFamily: 'monospace' }}>{dir}</span>
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
              <span>🔌 Quản lý MCP server</span>
              <button className="close-btn" onClick={() => setMcpPanelOpen(false)}>×</button>
            </div>
            <div className="modal-body">
              {mcpError && (
                <div className="picker-error" style={{ color: 'var(--red)', marginBottom: '10px' }}>⚠️ {mcpError}</div>
              )}

              {/* Danh sách MCP hiện có */}
              <div className="mcp-list-title" style={{ fontSize: '10px', fontFamily: '"Press Start 2P"', color: 'var(--text-2)', marginBottom: '8px' }}>
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
              <div className="mcp-list-title" style={{ fontSize: '10px', fontFamily: '"Press Start 2P"', color: 'var(--text-2)', marginBottom: '8px' }}>
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

      {confirmClearOpen && (
        <div className="modal-overlay" onClick={() => setConfirmClearOpen(false)}>
          <div
            className="modal-content pixel-panel"
            style={{ maxWidth: '420px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span>🗑 Xóa lịch sử chat</span>
              <button className="close-btn" onClick={() => setConfirmClearOpen(false)}>×</button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, lineHeight: 1.6 }}>
                Xóa toàn bộ <strong>{items.length}</strong> tin nhắn trong cửa sổ này?
                <br />
                Thao tác này không thể hoàn tác.
              </p>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button className="btn deny" onClick={() => setConfirmClearOpen(false)}>
                Hủy
              </button>
              <button className="btn stop" onClick={confirmClearChat}>
                Xóa hết
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
