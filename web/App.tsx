import { useEffect, useRef, useState } from 'react';
import { PixelSelect } from './PixelSelect.js';
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
    model: string;
    jiraConfigured: boolean;
    authSource: 'api-key' | 'claude-cli' | 'none';
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
        case 'learned':
          addItem('system', `🧬 Genome: Đã học thêm ${ev.added} tri thức mới về repo này.`);
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

  // Tính toán trạng thái các nơ-ron
  const taskNodeActive = task.trim().length > 0;
  const cwdNodeActive = cwd.trim().length > 0;
 
  const parsedJiraFromTask = (() => {
    const selected = task.match(/[?&]selectedIssue=([A-Z][A-Z0-9]+-\d+)/i);
    const ticket = selected ?? task.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
    if (ticket) return ticket[1].toUpperCase();
    const board = task.match(/\/boards\/(\d+)/);
    if (board) return `board ${board[1]}`;
    const project = task.match(/\/projects\/([A-Z][A-Z0-9]+)/i);
    if (project) return `project ${project[1].toUpperCase()}`;
    return '';
  })();
  const jiraNodeActive = parsedJiraFromTask.length > 0;
  const brainActive = running;

  const getLatestToolCategory = () => {
    if (pending.length > 0) {
      const toolName = pending[0].toolName;
      if (toolName === 'Bash') return 'bash';
      if (toolName === 'Read' || toolName === 'Glob' || toolName === 'view_file' || toolName === 'grep_search') return 'read';
      if (toolName === 'Edit' || toolName === 'replace_file_content' || toolName === 'write_to_file' || toolName === 'multi_replace_file_content') return 'write';
      if (toolName.startsWith('mcp__') || toolName.includes('mcp')) return 'mcp';
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'tool') {
        const text = it.text.toLowerCase();
        if (text.includes('bash') || text.includes('command')) return 'bash';
        if (text.includes('read') || text.includes('view') || text.includes('glob') || text.includes('grep')) return 'read';
        if (text.includes('edit') || text.includes('write') || text.includes('replace') || text.includes('modify')) return 'write';
        if (text.includes('mcp') || text.includes('db') || text.includes('jira')) return 'mcp';
      }
    }
    return null;
  };

  const latestTool = getLatestToolCategory();
  const readActive = running && latestTool === 'read';
  const writeActive = running && latestTool === 'write';
  const bashActive = running && latestTool === 'bash';
  const mcpActive = running && latestTool === 'mcp';
  const outputActive = items.some((it) => it.kind === 'result' || it.kind === 'error');
  const hasErrorResult = items.some((it) => it.kind === 'error');

  const renderConnection = (x1: number, y1: number, x2: number, y2: number, active: boolean) => {
    return (
      <g key={`${x1}-${y1}-${x2}-${y2}`}>
        {/* Đường nền mờ luôn hiện */}
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(148,163,184,0.18)" strokeWidth="1" />
        {active && (
          <>
            {/* Lớp glow nền */}
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#38bdf8" strokeWidth="3" opacity="0.25" className="nn-wire-glow" />
            {/* Tín hiệu chạy */}
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#7dd3fc"
              strokeWidth="1.5"
              className="nn-wire-signal"
            />
          </>
        )}
      </g>
    );
  };

  // Bảng màu neon theo loại nơ-ron (khối này luôn tối, không phụ thuộc theme app).
  const NEON: Record<'input' | 'brain' | 'tool' | 'output', string> = {
    input: '#38bdf8', // cyan
    brain: '#a78bfa', // tím
    tool: '#4ade80', // xanh lá
    output: '#4ade80', // xanh lá (đổi đỏ khi lỗi)
  };

  const renderNode = (x: number, y: number, label: string, active: boolean, type: 'input' | 'brain' | 'tool' | 'output') => {
    const isBrain = type === 'brain';
    const r = isBrain ? 17 : 13;
    const accent = type === 'output' && hasErrorResult ? '#f87171' : NEON[type];
    // Node nghỉ: glass mờ tối, viền xám mờ. Node active: viền + lõi phát sáng neon.
    const coreFill = active ? accent : 'rgba(255,255,255,0.03)';
    const ring = active ? accent : 'rgba(148,163,184,0.25)';

    return (
      <g key={label} className={active ? 'nn-node nn-node-active' : 'nn-node'} style={{ ['--nn-accent' as string]: accent }}>
        {/* Halo glow ngoài khi active */}
        {active && <circle cx={x} cy={y} r={r + 7} fill={accent} opacity="0.12" className="nn-halo" />}
        {/* Vòng glass nền */}
        <circle cx={x} cy={y} r={r} fill="rgba(255,255,255,0.04)" stroke={ring} strokeWidth="1.5" />
        {/* Lõi neon */}
        <circle
          cx={x}
          cy={y}
          r={active ? r - 4 : 3}
          fill={coreFill}
          className={active ? 'nn-core nn-core-active' : 'nn-core'}
          style={{ ['--nn-accent' as string]: accent }}
        />
        <text
          x={x}
          y={y + r + 12}
          textAnchor="middle"
          fill={active ? accent : 'rgba(203,213,225,0.65)'}
          style={{ fontSize: '8px', fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontWeight: 600, letterSpacing: '0.08em', userSelect: 'none' }}
        >
          {label}
        </text>
      </g>
    );
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">▚ BOW-AGENT</div>
        <div className="topbar-right">
          <div className="meta">
            {cfg && (
              <>
                <span>model: {cfg.model}</span>
                <span>
                  auth:{' '}
                  {cfg.authSource === 'api-key'
                    ? '🔑 API key'
                    : cfg.authSource === 'claude-cli'
                      ? '👤 Claude CLI'
                      : '❌ chưa có'}
                </span>
                <span>Jira: {cfg.jiraConfigured ? '✅' : '—'}</span>
                {cfg.mcpServers && cfg.mcpServers.length > 0 && (
                  <span>MCP: {cfg.mcpServers.join(', ')}</span>
                )}
                <span style={{ color: accumulatedCost > 2 ? 'var(--red)' : 'inherit' }}>
                  Tích lũy: ${accumulatedCost.toFixed(4)}
                </span>
              </>
            )}
          </div>
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
            <svg width="100%" height="100%" viewBox="0 0 280 280">
              <defs>
                {/* Filter glow neon dùng chung */}
                <filter id="nn-glow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="2.5" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
                {/* Lưới nền mờ */}
                <radialGradient id="nn-bg" cx="50%" cy="35%" r="75%">
                  <stop offset="0%" stopColor="#1e293b" />
                  <stop offset="100%" stopColor="#0b1120" />
                </radialGradient>
              </defs>
              {/* Nền gradient tối */}
              <rect x="0" y="0" width="280" height="280" fill="url(#nn-bg)" />

              {/* Connections */}
              {renderConnection(50, 30, 140, 100, taskNodeActive && brainActive)}
              {renderConnection(140, 30, 140, 100, cwdNodeActive && brainActive)}
              {renderConnection(230, 30, 140, 100, jiraNodeActive && brainActive)}

              {renderConnection(140, 100, 40, 170, brainActive && readActive)}
              {renderConnection(140, 100, 105, 170, brainActive && writeActive)}
              {renderConnection(140, 100, 175, 170, brainActive && bashActive)}
              {renderConnection(140, 100, 240, 170, brainActive && mcpActive)}

              {renderConnection(40, 170, 140, 240, (readActive || (outputActive && latestTool === 'read')) && outputActive)}
              {renderConnection(105, 170, 140, 240, (writeActive || (outputActive && latestTool === 'write')) && outputActive)}
              {renderConnection(175, 170, 140, 240, (bashActive || (outputActive && latestTool === 'bash')) && outputActive)}
              {renderConnection(240, 170, 140, 240, (mcpActive || (outputActive && latestTool === 'mcp')) && outputActive)}

              {/* Nodes */}
              {renderNode(50, 30, 'TASK', taskNodeActive, 'input')}
              {renderNode(140, 30, 'CWD', cwdNodeActive, 'input')}
              {renderNode(230, 30, 'JIRA', jiraNodeActive, 'input')}

              {renderNode(140, 100, 'BRAIN', brainActive, 'brain')}

              {renderNode(40, 170, 'READ', readActive || (outputActive && latestTool === 'read'), 'tool')}
              {renderNode(105, 170, 'WRITE', writeActive || (outputActive && latestTool === 'write'), 'tool')}
              {renderNode(175, 170, 'BASH', bashActive || (outputActive && latestTool === 'bash'), 'tool')}
              {renderNode(240, 170, 'MCP', mcpActive || (outputActive && latestTool === 'mcp'), 'tool')}

              {renderNode(140, 240, outputActive ? (hasErrorResult ? 'ERROR' : 'DONE') : 'OUT', outputActive, 'output')}
            </svg>
          </div>

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

        {cfg && cfg.mcpServers && cfg.mcpServers.length > 0 && (
          <div className="mcp-selector-panel" style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
            padding: '8px 12px',
            background: 'var(--inset)',
            border: 'var(--bd-thin) solid var(--outline)',
            marginTop: '8px',
            marginBottom: '4px',
            borderRadius: '2px'
          }}>
            <span style={{ fontSize: '8px', fontFamily: '"Press Start 2P"', color: 'var(--text-2)' }}>MCP:</span>
            {cfg.mcpServers.map((name) => {
              const isChecked = selectedMcps.includes(name);
              return (
                <label key={name} className="px-check" style={{ margin: 0, fontSize: '15px' }} title={`Kích hoạt MCP: ${name}`}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={running}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedMcps((prev) => [...prev, name]);
                      } else {
                        setSelectedMcps((prev) => prev.filter((n) => n !== name));
                      }
                    }}
                  />
                  <span className="px-box">{isChecked ? '✓' : ''}</span>
                  {name}
                </label>
              );
            })}
          </div>
        )}

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
