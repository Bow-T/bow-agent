/**
 * MÀN BẢN ĐỒ — "BOW GLOBE". Một quả cầu lưới duy nhất gom TOÀN BỘ hiện trạng của bow-agent
 * vào một hình: mã nguồn, việc đang chạy, sprint Jira và 9 nguồn tri thức.
 *
 * KHÔNG trang trí: mỗi ô, mỗi chấm, mỗi cung nối đều trỏ về một sự thật đọc được từ API đã có
 *   • CODE   — /api/filetree (git ls-files + số dòng): 1 ô lưới = 1 thư mục gốc, 1 chấm = 1 file.
 *   • LIVE   — tab đang mở của chính web này (running / chờ duyệt) + đội agent phụ.
 *   • JIRA   — /api/jira/sprints + /api/jira/issues của sprint đang chạy (read-only).
 *   • NGUỒN  — 9 hệ tri thức, dùng CHUNG bảng định danh với Cosmos (web/cosmosSystems.ts).
 *
 * Vị trí có nghĩa (không random): quả cầu chia 4 múi kinh độ, mỗi lớp một múi cố định — nhìn một
 * lần là nhớ "code nằm bên trái, sprint bên phải, tri thức ở rìa". Trong múi JIRA, VĨ ĐỘ = trạng
 * thái (chưa làm ở dưới, đang làm ở giữa, xong ở trên) nên độ dồn việc lộ ra ngay. Tác vụ đang
 * chạy bay trên quỹ đạo cao và thả một cung sáng xuống đúng thứ nó đang đụng (ticket theo key
 * trong tiêu đề tab, không đoán bừa).
 *
 * Chỉ ĐỌC. Không đường ghi nào đi qua đây — hành động duy nhất là chuyển màn/nạp key vào ô nhập.
 * Màu trạng thái lấy từ token --step-* của theme; màu định danh vùng lấy hue trong cosmosSystems.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { PanelShell, PanelEmpty } from './PanelShell.js';
import { Icon } from '../Icon.js';
import { apiFetch } from '../App.js';
import { SYSTEMS } from '../cosmosSystems.js';
import type { NavSectionViewProps } from './NavSectionView.js';

type Layer = 'code' | 'live' | 'jira' | 'source';
type Tone = 'idle' | 'hot' | 'warn' | 'ok' | 'run';

interface MapNode {
  id: string;
  layer: Layer;
  kind: 'dir' | 'file' | 'ticket' | 'system' | 'tab';
  label: string;
  sub: string;
  /** Toạ độ trên cầu (độ) — cố định theo dữ liệu, KHÔNG ngẫu nhiên giữa các lần mở. */
  lat: number;
  lon: number;
  /** Bán kính tương đối (1 = mặt cầu; >1 = bay trên quỹ đạo). */
  alt: number;
  size: number;
  hue: number;
  tone: Tone;
  meta: [string, string][];
  action?: { type: 'tab'; id: string } | { type: 'jira'; key: string };
  /** Neo của cung nối (tab → thứ nó đang đụng). */
  linkTo?: { lat: number; lon: number };
}

interface FileEntry { path: string; lines: number }
interface Sprint { id: number; name: string; state: string }
interface Issue {
  key: string; summary: string; issueType: string; status: string;
  assignee: string | null; reporter: string | null; priority: string | null;
}

const R = 100;                       // bán kính cầu (đơn vị scene)
/** Múi kinh độ của từng lớp — hằng số bố cục, đọc ở cả phần dựng lẫn phần nhãn vùng. */
const ZONE: Record<Layer, { lon0: number; lon1: number; vi: string; en: string }> = {
  code: { lon0: -172, lon1: -14, vi: 'MÃ NGUỒN', en: 'CODEBASE' },
  jira: { lon0: 12, lon1: 104, vi: 'SPRINT', en: 'SPRINT' },
  source: { lon0: 116, lon1: 176, vi: 'TRI THỨC', en: 'KNOWLEDGE' },
  live: { lon0: -180, lon1: 180, vi: 'ĐANG CHẠY', en: 'LIVE' },
};

const LAYER_ORDER: Layer[] = ['code', 'live', 'jira', 'source'];

function topDir(p: string) { const i = p.indexOf('/'); return i < 0 ? '(root)' : p.slice(0, i); }
function hueForDir(dir: string): number {
  for (const s of SYSTEMS) if (s.dirs.includes(dir)) return s.hue;
  const known: Record<string, number> = { src: 0.55, web: 0.09, docs: 0.30, scripts: 0.14, examples: 0.90, '.github': 0.42, '(root)': 0.60 };
  if (known[dir] !== undefined) return known[dir];
  let h = 0; for (let i = 0; i < dir.length; i++) h = (h * 31 + dir.charCodeAt(i)) | 0;
  return (Math.abs(h) % 360) / 360;
}
/** Trạng thái Jira → 3 hàng vĩ độ. Khớp chữ, không phụ thuộc id workflow của từng project. */
function jiraBand(status: string): 'todo' | 'doing' | 'done' {
  const s = status.toLowerCase();
  if (/done|closed|resolved|xong|hoàn thành|complete/.test(s)) return 'done';
  if (/progress|review|test|đang|doing|qc/.test(s)) return 'doing';
  return 'todo';
}
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;

// Vector tạm dùng chung cho mọi phép đổi toạ độ trong module (tránh cấp phát mỗi frame).
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const mouseScreen = new THREE.Vector2();

/** (lat°, lon°, r) → điểm 3D. Kinh tuyến 0 hướng về +Z để múi CODE nằm bên trái khung mặc định. */
function toVec(lat: number, lon: number, r: number, out = new THREE.Vector3()) {
  const p = (90 - lat) * (Math.PI / 180);
  const t = (lon + 180) * (Math.PI / 180);
  return out.set(-r * Math.sin(p) * Math.cos(t), r * Math.cos(p), r * Math.sin(p) * Math.sin(t));
}

/** Đọc token màu của theme (có resolve chuỗi var(--x)) — không tự chế bảng màu riêng. */
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const raw = (name: string, depth = 0): string => {
    const v = cs.getPropertyValue(name).trim();
    if (v.startsWith('var(') && depth < 4) return raw(v.slice(4, v.indexOf(')')).trim(), depth + 1);
    return v;
  };
  const col = (name: string, fb: string) => {
    const v = raw(name);
    try { return new THREE.Color(v || fb); } catch { return new THREE.Color(fb); }
  };
  const bg = col('--bg', '#0c0c0c');
  const light = bg.r * 0.299 + bg.g * 0.587 + bg.b * 0.114 > 0.5;
  return {
    light,
    bg,
    ink: col('--ink', light ? '#0a0a0a' : '#ffffff'),
    grid: col('--brass', '#e2ff00'),
    ocean: col('--surface', light ? '#fffdf5' : '#141414'),
    hot: col('--step-error', '#e5484d'),
    ok: col('--step-approval', '#14ae5c'),
    run: col('--step-tool', '#e2ff00'),
    warn: col('--step-thinking', '#ffcd29'),
  };
}

export function GlobeMapPanel({ language, tasks, agents, cwd, onGoTask, onUseJiraKey }: NavSectionViewProps) {
  const vi = language === 'vi';
  const mountRef = useRef<HTMLDivElement | null>(null);

  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [repoName, setRepoName] = useState('');
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [sprintName, setSprintName] = useState('');
  const [jiraErr, setJiraErr] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [on, setOn] = useState<Record<Layer, boolean>>({ code: true, live: true, jira: true, source: true });
  const [hover, setHover] = useState<{ node: MapNode; x: number; y: number } | null>(null);
  const [sel, setSel] = useState<MapNode | null>(null);
  /** Theme/accent đổi → dựng lại màu canvas (CSS var đã đổi nhưng WebGL không tự biết). */
  const [themeKey, setThemeKey] = useState(0);
  /** Góc nhìn giữ qua các lần dựng lại — trạng thái tab đổi thì dữ liệu đổi, KHÔNG được giật camera. */
  const viewRef = useRef({ yaw: -0.35, pitch: 0.28, dist: 300 });

  // ── Nạp dữ liệu thật ────────────────────────────────────────────────────────────────────────
  const loadAll = useCallback(() => {
    setLoading(true); setErr(''); setJiraErr('');
    apiFetch('/api/filetree')
      .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<{ repoName: string; files: FileEntry[] }>; })
      .then((d) => { setFiles(d.files ?? []); setRepoName(d.repoName ?? ''); })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));

    // Jira là tuỳ chọn: chưa cấu hình thì lớp SPRINT trống, không coi là lỗi của cả màn.
    apiFetch('/api/jira/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(async (c: { projectKey: string | null }) => {
        if (!c.projectKey) throw new Error(vi ? 'Chưa cấu hình Jira' : 'Jira not configured');
        const rs = await apiFetch(`/api/jira/sprints?project=${encodeURIComponent(c.projectKey)}`);
        const ds = await rs.json();
        if (!rs.ok) throw new Error(ds.error || `HTTP ${rs.status}`);
        const list: Sprint[] = ds.sprints ?? [];
        const active = list.find((s) => s.state === 'active') ?? list[0];
        if (!active) throw new Error(vi ? 'Không có sprint' : 'No sprint');
        setSprintName(active.name);
        const ri = await apiFetch(`/api/jira/issues?sprint=${active.id}`);
        const di = await ri.json();
        if (!ri.ok) throw new Error(di.error || `HTTP ${ri.status}`);
        setIssues(di.issues ?? []);
      })
      .catch((e: Error) => { setIssues([]); setJiraErr(e.message); });
  }, [vi]);

  useEffect(() => { loadAll(); }, [loadAll, cwd]);

  useEffect(() => {
    const ob = new MutationObserver(() => setThemeKey((k) => k + 1));
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] });
    return () => ob.disconnect();
  }, []);

  // ── Dữ liệu → node trên cầu ────────────────────────────────────────────────────────────────
  const { nodes, dirs, stats } = useMemo(() => {
    const out: MapNode[] = [];
    const dirRows: { dir: string; count: number; lines: number; lat: number; lon: number; hue: number }[] = [];

    // 1) CODE — thư mục gốc thành ô lưới, file thành chấm quanh ô. To = nhiều dòng.
    const byDir = new Map<string, FileEntry[]>();
    for (const f of files ?? []) {
      const d = topDir(f.path);
      const arr = byDir.get(d); if (arr) arr.push(f); else byDir.set(d, [f]);
    }
    const dirList = [...byDir.entries()]
      .map(([dir, fs]) => ({ dir, fs, lines: fs.reduce((s, f) => s + f.lines, 0) }))
      .sort((a, b) => b.fs.length - a.fs.length)
      .slice(0, 24);
    const cols = Math.max(1, Math.ceil(Math.sqrt(dirList.length * 1.7)));
    const rows = Math.max(1, Math.ceil(dirList.length / cols));
    const zc = ZONE.code;
    const cellW = (zc.lon1 - zc.lon0) / cols;
    const cellH = 116 / rows;
    // Trần chấm để repo khổng lồ vẫn 60fps; ưu tiên file nhiều dòng (thứ đáng nhìn).
    const budget = 1400;
    const perDir = Math.max(6, Math.floor(budget / Math.max(1, dirList.length)));
    dirList.forEach((d, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const lon = zc.lon0 + (c + 0.5) * cellW;
      const lat = 58 - (r + 0.5) * cellH;
      const hue = hueForDir(d.dir);
      dirRows.push({ dir: d.dir, count: d.fs.length, lines: d.lines, lat, lon, hue });
      out.push({
        id: `dir:${d.dir}`, layer: 'code', kind: 'dir', label: d.dir,
        sub: vi ? `${d.fs.length} file · ${d.lines.toLocaleString()} dòng` : `${d.fs.length} files · ${d.lines.toLocaleString()} lines`,
        lat, lon, alt: 1, size: Math.min(cellW, cellH) * 0.42, hue, tone: 'idle',
        meta: [[vi ? 'Thư mục' : 'Directory', d.dir], [vi ? 'Số file' : 'Files', String(d.fs.length)], [vi ? 'Số dòng' : 'Lines', d.lines.toLocaleString()]],
      });
      const spread = Math.min(cellW, cellH) * 0.4;
      d.fs.slice().sort((a, b) => b.lines - a.lines).slice(0, perDir).forEach((f, j, arr) => {
        const ang = j * 2.39996;                                   // golden angle → không thành vòng đều
        const rad = arr.length === 1 ? 0 : spread * Math.sqrt(j / arr.length);
        out.push({
          id: `file:${f.path}`, layer: 'code', kind: 'file', label: f.path.split('/').pop() ?? f.path,
          sub: f.path,
          lat: lat + rad * Math.sin(ang), lon: lon + rad * Math.cos(ang) / Math.max(0.35, Math.cos(lat * Math.PI / 180)),
          alt: 1.005, size: 0.7 + Math.log2(1 + f.lines) * 0.22, hue, tone: f.lines > 800 ? 'warn' : 'idle',
          meta: [[vi ? 'Đường dẫn' : 'Path', f.path], [vi ? 'Số dòng' : 'Lines', String(f.lines)]],
        });
      });
    });

    // 2) JIRA — vĩ độ = trạng thái (chưa làm dưới → xong trên), kinh độ rải đều trong hàng.
    const zj = ZONE.jira;
    const bands: Record<'todo' | 'doing' | 'done', Issue[]> = { todo: [], doing: [], done: [] };
    for (const it of issues ?? []) bands[jiraBand(it.status)].push(it);
    const bandLat: Record<'todo' | 'doing' | 'done', number> = { todo: -46, doing: 2, done: 48 };
    const issuePos = new Map<string, { lat: number; lon: number }>();
    (Object.keys(bands) as ('todo' | 'doing' | 'done')[]).forEach((b) => {
      const arr = bands[b];
      const perRow = Math.max(1, Math.min(14, Math.ceil(Math.sqrt(arr.length * 2.2))));
      arr.forEach((it, i) => {
        const c = i % perRow, r = Math.floor(i / perRow);
        const lon = zj.lon0 + ((c + 0.5) / perRow) * (zj.lon1 - zj.lon0);
        const lat = bandLat[b] + (r - (Math.floor((arr.length - 1) / perRow)) / 2) * 9;
        issuePos.set(it.key, { lat, lon });
        const t = it.issueType.toLowerCase();
        out.push({
          id: `jira:${it.key}`, layer: 'jira', kind: 'ticket', label: it.key, sub: it.summary,
          lat, lon, alt: 1.01,
          size: /bug/.test(t) ? 2.1 : 1.7,
          hue: /bug/.test(t) ? 0.0 : /story/.test(t) ? 0.33 : 0.57,
          tone: b === 'done' ? 'ok' : /bug/.test(t) ? 'hot' : b === 'doing' ? 'run' : 'idle',
          meta: [[vi ? 'Loại' : 'Type', it.issueType], [vi ? 'Trạng thái' : 'Status', it.status],
            [vi ? 'Người làm' : 'Assignee', it.assignee ?? '—'], [vi ? 'Ưu tiên' : 'Priority', it.priority ?? '—']],
          action: { type: 'jira', key: it.key },
        });
      });
    });

    // 3) NGUỒN TRI THỨC — 9 hệ, lưới 3×3 ở rìa phải. Cùng bảng định danh với Cosmos.
    const zs = ZONE.source;
    SYSTEMS.forEach((s, i) => {
      const c = i % 3, r = Math.floor(i / 3);
      out.push({
        id: `sys:${s.id}`, layer: 'source', kind: 'system', label: s.code,
        sub: vi ? s.tagVi : s.tagEn,
        lat: 44 - r * 44, lon: zs.lon0 + ((c + 0.5) / 3) * (zs.lon1 - zs.lon0),
        alt: 1.02, size: 4.2, hue: s.hue, tone: 'idle',
        meta: [[vi ? 'Nguồn' : 'Source', vi ? s.tagVi : s.tagEn]],
      });
    });

    // 4) LIVE — tác vụ đang mở bay trên quỹ đạo cao; cung nối xuống ticket nếu tiêu đề có Jira key.
    let running = 0, waiting = 0;
    (tasks ?? []).forEach((t, i, arr) => {
      const key = JIRA_KEY_RE.exec(t.title)?.[1];
      const anchor = key ? issuePos.get(key) : undefined;
      const base = anchor ?? { lat: 8, lon: (ZONE.code.lon0 + ZONE.code.lon1) / 2 };
      if (t.running) running++;
      if (t.pendingCount > 0) waiting++;
      out.push({
        id: `tab:${t.id}`, layer: 'live', kind: 'tab', label: t.title || (vi ? 'Tác vụ' : 'Task'),
        sub: t.pendingCount > 0 ? (vi ? `${t.pendingCount} thẻ chờ duyệt` : `${t.pendingCount} pending`) : t.running ? (vi ? 'Đang chạy' : 'Running') : (vi ? 'Nghỉ' : 'Idle'),
        lat: Math.max(-70, Math.min(70, base.lat + 14)), lon: base.lon + (i - (arr.length - 1) / 2) * 7,
        alt: 1.3, size: 3.4, hue: 0.13,
        tone: t.pendingCount > 0 ? 'hot' : t.running ? 'run' : 'idle',
        meta: [[vi ? 'Trạng thái' : 'State', t.running ? (vi ? 'đang chạy' : 'running') : (vi ? 'nghỉ' : 'idle')],
          [vi ? 'Chờ duyệt' : 'Pending', String(t.pendingCount)],
          ...(key ? [[vi ? 'Ticket' : 'Ticket', key] as [string, string]] : [])],
        action: { type: 'tab', id: t.id },
        linkTo: base,
      });
    });
    // Agent phụ của tab đang mở: vệ tinh nhỏ quanh cực bắc — chỉ hiện khi thật sự có đội.
    (agents ?? []).forEach((a, i, arr) => {
      out.push({
        id: `agent:${a.id}`, layer: 'live', kind: 'tab', label: a.label || a.id,
        sub: vi ? 'Agent phụ' : 'Subagent',
        lat: 74, lon: -180 + ((i + 0.5) / Math.max(1, arr.length)) * 360,
        alt: 1.22, size: 2.4, hue: 0.13,
        tone: a.active ? 'run' : 'idle',
        meta: [[vi ? 'Agent' : 'Agent', a.id], [vi ? 'Hoạt động' : 'Active', a.active ? '✓' : '—']],
      });
    });

    return {
      nodes: out,
      dirs: dirRows,
      stats: {
        files: (files ?? []).length,
        lines: (files ?? []).reduce((s, f) => s + f.lines, 0),
        tickets: (issues ?? []).length,
        bugs: (issues ?? []).filter((i) => /bug/i.test(i.issueType)).length,
        done: bands.done.length,
        doing: bands.doing.length,
        todo: bands.todo.length,
        running, waiting,
      },
    };
  }, [files, issues, tasks, agents, vi]);

  const onRef = useRef(on); onRef.current = on;
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  /** Chữ ký hình học: chỉ dựng lại cầu khi node THẬT SỰ đổi (App tạo mảng tasks mới mỗi lần render). */
  const sig = useMemo(
    () => nodes.map((n) => `${n.id}|${n.tone}|${n.lat.toFixed(1)},${n.lon.toFixed(1)}`).join(';'),
    [nodes],
  );

  // ── Dựng cầu (three.js) ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current;
    const nodes = nodesRef.current;
    if (!mount || nodes.length === 0) return;

    const C = themeColors();
    const W0 = mount.clientWidth || 800;
    const H0 = mount.clientHeight || 520;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, W0 / H0, 1, 4000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W0, H0);
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const world = new THREE.Group();
    scene.add(world);

    // Quả cầu đục: che nửa sau để chấm mặt khuất không lẫn vào mặt trước (đọc được là ưu tiên số 1).
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(R, 64, 48),
      new THREE.MeshBasicMaterial({ color: C.ocean.clone().lerp(C.bg, C.light ? 0.25 : 0.55), transparent: true, opacity: C.light ? 0.97 : 0.94 }),
    );
    world.add(shell);

    // Lưới kinh–vĩ tuyến: 24 kinh × 11 vĩ (đủ dày để đọc ra hình cầu, chưa thành rối).
    const gridPts: number[] = [];
    for (let k = 0; k < 24; k++) {
      const lon = -180 + k * 15;
      for (let a = -88; a < 88; a += 4) {
        toVec(a, lon, R * 1.001, tmpA); toVec(a + 4, lon, R * 1.001, tmpB);
        gridPts.push(tmpA.x, tmpA.y, tmpA.z, tmpB.x, tmpB.y, tmpB.z);
      }
    }
    for (let lat = -75; lat <= 75; lat += 15) {
      for (let a = -180; a < 180; a += 4) {
        toVec(lat, a, R * 1.001, tmpA); toVec(lat, a + 4, R * 1.001, tmpB);
        gridPts.push(tmpA.x, tmpA.y, tmpA.z, tmpB.x, tmpB.y, tmpB.z);
      }
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
    const gridMat = new THREE.LineBasicMaterial({ color: C.light ? C.ink : C.grid, transparent: true, opacity: C.light ? 0.16 : 0.13 });
    const grid = new THREE.LineSegments(gridGeo, gridMat);
    world.add(grid);

    // Viền chân trời (rim) — vòng sáng quanh mép cầu, giữ cho quả cầu tách khỏi nền.
    const rim = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.02, 48, 32),
      new THREE.ShaderMaterial({
        transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uCol: { value: new THREE.Color(C.grid) }, uPow: { value: C.light ? 3.4 : 2.6 } },
        vertexShader: 'varying vec3 vN; varying vec3 vP; void main(){ vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vP=mv.xyz; gl_Position=projectionMatrix*mv; }',
        fragmentShader: 'uniform vec3 uCol; uniform float uPow; varying vec3 vN; varying vec3 vP; void main(){ float f=pow(1.0-abs(dot(normalize(vN),normalize(-vP))),uPow); gl_FragColor=vec4(uCol,f*0.55); }',
      }),
    );
    world.add(rim);

    // Texture đĩa mềm (ô thư mục) + texture chấm sắc (file/ticket) — vẽ tại chỗ, không tải ảnh.
    const mkTex = (stops: [number, string][]) => {
      const s = 128, c = document.createElement('canvas'); c.width = c.height = s;
      const g = c.getContext('2d')!;
      const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      for (const [o, col] of stops) gr.addColorStop(o, col);
      g.fillStyle = gr; g.fillRect(0, 0, s, s);
      return new THREE.CanvasTexture(c);
    };
    const cellTex = mkTex([[0, 'rgba(255,255,255,0.95)'], [0.32, 'rgba(255,255,255,0.35)'], [0.72, 'rgba(255,255,255,0.14)'], [0.92, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]);
    const dotTex = mkTex([[0, 'rgba(255,255,255,1)'], [0.28, 'rgba(255,255,255,0.75)'], [0.6, 'rgba(255,255,255,0.14)'], [1, 'rgba(255,255,255,0)']]);

    const toneColor = (t: Tone, hue: number) => {
      if (t === 'hot') return C.hot.clone();
      if (t === 'ok') return C.ok.clone();
      if (t === 'run') return C.run.clone();
      if (t === 'warn') return C.warn.clone();
      return new THREE.Color().setHSL(hue, C.light ? 0.62 : 0.68, C.light ? 0.42 : 0.6);
    };

    // ── Ô thư mục: đĩa dán tiếp tuyến mặt cầu (không phải sprite) → cong theo cầu như bản đồ thật.
    const cellMeshes: THREE.Mesh[] = [];
    const cellGeo = new THREE.CircleGeometry(1, 28);
    for (const n of nodes.filter((x) => x.kind === 'dir')) {
      const rad = (n.size * Math.PI / 180) * R;
      const m = new THREE.Mesh(cellGeo, new THREE.MeshBasicMaterial({
        map: cellTex, color: toneColor(n.tone, n.hue), transparent: true,
        opacity: C.light ? 0.5 : 0.62, depthWrite: false, blending: C.light ? THREE.NormalBlending : THREE.AdditiveBlending,
      }));
      m.scale.setScalar(rad);
      toVec(n.lat, n.lon, R * 1.004, tmpA);
      m.position.copy(tmpA);
      m.lookAt(tmpA.clone().multiplyScalar(2));
      m.userData.node = n;
      m.userData.layer = n.layer;
      world.add(m); cellMeshes.push(m);
    }

    // ── Nhãn nổi: tên MÚI + tên thư mục lớn. Không có chữ thì quả cầu chỉ là hoa văn đẹp —
    //    người xem phải đọc được mình đang nhìn vùng nào, thư mục nào, ngay khi xoay tới.
    const labelTex: THREE.Texture[] = [];
    const labels: { sp: THREE.Sprite; anchor: THREE.Vector3; layer: Layer }[] = [];
    const mkLabel = (text: string, px: number, color: THREE.Color, scale: number) => {
      const font = `${px}px ui-monospace, "SFMono-Regular", "IBM Plex Mono", monospace`;
      const c = document.createElement('canvas');
      const probe = c.getContext('2d')!;
      probe.font = font;
      c.width = Math.ceil(probe.measureText(text).width) + 16;
      c.height = px + 14;
      const g = c.getContext('2d')!;
      g.font = font; g.textBaseline = 'middle';
      g.fillStyle = `#${color.getHexString()}`;
      g.fillText(text, 8, c.height / 2);
      const tex = new THREE.CanvasTexture(c);
      labelTex.push(tex);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, opacity: 0 }));
      sp.scale.set(c.width * scale, c.height * scale, 1);
      return sp;
    };
    (['code', 'jira', 'source'] as Layer[]).forEach((l) => {
      const z = ZONE[l];
      const sp = mkLabel(vi ? z.vi : z.en, 34, C.light ? C.ink : C.grid, 0.075);
      const at = toVec(70, (z.lon0 + z.lon1) / 2, R * 1.2, new THREE.Vector3());
      sp.position.copy(at);
      world.add(sp);
      labels.push({ sp, anchor: at, layer: l });
    });
    nodes.filter((x) => x.kind === 'dir').slice(0, 10).forEach((nd) => {
      const sp = mkLabel(nd.label, 22, C.light ? C.ink : C.ink, 0.05);
      const at = toVec(nd.lat - nd.size * 0.9, nd.lon, R * 1.03, new THREE.Vector3());
      sp.position.copy(at);
      world.add(sp);
      labels.push({ sp, anchor: at, layer: 'code' });
    });

    // ── Chấm (file / ticket / hệ / tác vụ): gộp vào MỘT Points cho nhẹ; index → node để hover.
    const dotNodes = nodes.filter((x) => x.kind !== 'dir');
    const n = dotNodes.length;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), siz = new Float32Array(n), pul = new Float32Array(n), lay = new Float32Array(n);
    dotNodes.forEach((d, i) => {
      toVec(d.lat, d.lon, R * d.alt, tmpA);
      pos[i * 3] = tmpA.x; pos[i * 3 + 1] = tmpA.y; pos[i * 3 + 2] = tmpA.z;
      const c = toneColor(d.tone, d.hue);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      siz[i] = d.size;
      pul[i] = d.tone === 'hot' || d.tone === 'run' ? 1 : 0;
      lay[i] = LAYER_ORDER.indexOf(d.layer);
    });
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dotGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    dotGeo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
    dotGeo.setAttribute('aPulse', new THREE.BufferAttribute(pul, 1));
    dotGeo.setAttribute('aLayer', new THREE.BufferAttribute(lay, 1));
    const dotMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, vertexColors: true,
      blending: C.light ? THREE.NormalBlending : THREE.AdditiveBlending,
      uniforms: {
        uTex: { value: dotTex }, uTime: { value: 0 }, uPix: { value: renderer.getPixelRatio() },
        uOn: { value: new THREE.Vector4(1, 1, 1, 1) }, uDim: { value: C.light ? 1.0 : 0.9 },
      },
      vertexShader: `attribute float aSize; attribute float aPulse; attribute float aLayer;
        varying vec3 vC; varying float vA; uniform float uTime,uPix,uDim; uniform vec4 uOn;
        void main(){
          vC=color;
          float on = aLayer<0.5?uOn.x : aLayer<1.5?uOn.y : aLayer<2.5?uOn.z : uOn.w;
          float pulse = 1.0 + aPulse*0.45*sin(uTime*3.2 + position.x*0.08);
          vA = on*uDim*(0.55+0.45*pulse);
          vec4 mv = modelViewMatrix*vec4(position,1.0);
          gl_PointSize = aSize*pulse*uPix*(420.0/-mv.z)*on;
          gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader: `uniform sampler2D uTex; varying vec3 vC; varying float vA;
        void main(){ vec4 t=texture2D(uTex,gl_PointCoord); if(t.a<0.02) discard; gl_FragColor=vec4(vC,t.a*vA); }`,
    });
    const dots = new THREE.Points(dotGeo, dotMat);
    dots.frustumCulled = false;
    world.add(dots);

    // ── Cung nối: tác vụ đang chạy → thứ nó đang đụng. Cong ra ngoài như đường bay.
    const arcs: { line: THREE.Line; mat: THREE.LineBasicMaterial; head: THREE.Sprite; curve: THREE.QuadraticBezierCurve3; t: number }[] = [];
    for (const t of nodes.filter((x) => x.kind === 'tab' && x.linkTo)) {
      const a = toVec(t.lat, t.lon, R * t.alt, new THREE.Vector3());
      const b = toVec(t.linkTo!.lat, t.linkTo!.lon, R * 1.01, new THREE.Vector3());
      const mid = a.clone().add(b).multiplyScalar(0.5).normalize().multiplyScalar(R * 1.45);
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const g = new THREE.BufferGeometry().setFromPoints(curve.getPoints(48));
      const m = new THREE.LineBasicMaterial({ color: toneColor(t.tone, t.hue), transparent: true, opacity: 0.5 });
      const line = new THREE.Line(g, m);
      world.add(line);
      const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: toneColor(t.tone, t.hue), transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
      head.scale.setScalar(4);
      world.add(head);
      arcs.push({ line, mat: m, head, curve, t: Math.random() });
    }

    // ── Camera + tương tác: kéo xoay, cuộn zoom, tự quay chậm khi rảnh ──────────────────────────
    let { yaw, pitch, dist } = viewRef.current;
    let tYaw = yaw, tPitch = pitch, tDist = dist;
    let dragging = false, lastX = 0, lastY = 0, idle = 0;
    const el = renderer.domElement;

    const onDown = (e: PointerEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY; idle = 0; el.setPointerCapture(e.pointerId); };
    const onUp = (e: PointerEvent) => { dragging = false; try { el.releasePointerCapture(e.pointerId); } catch { /* pointer đã mất */ } };
    const pointer = new THREE.Vector2(-2, -2);
    let hoverDirty = false;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      mouseScreen.set(e.clientX - r.left, e.clientY - r.top);
      hoverDirty = true;
      if (!dragging) return;
      tYaw -= (e.clientX - lastX) * 0.005;
      tPitch = Math.max(-1.2, Math.min(1.2, tPitch + (e.clientY - lastY) * 0.005));
      lastX = e.clientX; lastY = e.clientY; idle = 0;
    };
    const onWheel = (e: WheelEvent) => { e.preventDefault(); tDist = Math.max(140, Math.min(560, tDist + e.deltaY * 0.35)); idle = 0; };
    const onLeave = () => { pointer.set(-2, -2); hoverDirty = true; };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('wheel', onWheel, { passive: false });

    const ray = new THREE.Raycaster();
    ray.params.Points!.threshold = 2.2;
    let hoverId: string | null = null;

    const pick = (): MapNode | null => {
      ray.setFromCamera(pointer, camera);
      // Chấm trước (thứ người ta thật sự trỏ vào), rồi mới tới ô thư mục nền.
      const hitDots = ray.intersectObject(dots, false);
      const vis = onRef.current;
      for (const h of hitDots) {
        const nd = dotNodes[h.index ?? -1];
        if (!nd || !vis[nd.layer]) continue;
        // bỏ điểm nằm sau quả cầu (bị che) — nếu không, mặt sau cũng bắt chuột.
        if (h.point.clone().sub(camera.position).normalize().dot(h.point.clone().normalize()) > 0) continue;
        return nd;
      }
      const hitCells = ray.intersectObjects(cellMeshes, false);
      for (const h of hitCells) {
        const nd = h.object.userData.node as MapNode;
        if (nd && vis[nd.layer]) return nd;
      }
      return null;
    };

    const onClick = () => {
      const nd = pick();
      if (nd) setSel(nd);
    };
    el.addEventListener('click', onClick);

    const onResize = () => {
      const w = mount.clientWidth || W0, h = mount.clientHeight || H0;
      camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.05);
      const time = clock.elapsedTime;
      idle += dt;
      if (idle > 2.5 && !dragging) tYaw += dt * 0.045;      // tự quay chậm khi không ai đụng
      yaw += (tYaw - yaw) * Math.min(1, dt * 8);
      pitch += (tPitch - pitch) * Math.min(1, dt * 8);
      dist += (tDist - dist) * Math.min(1, dt * 6);
      camera.position.set(
        dist * Math.cos(pitch) * Math.sin(yaw),
        dist * Math.sin(pitch),
        dist * Math.cos(pitch) * Math.cos(yaw),
      );
      camera.lookAt(0, 0, 0);
      viewRef.current = { yaw: tYaw, pitch: tPitch, dist: tDist };

      const vis = onRef.current;
      dotMat.uniforms.uTime.value = time;
      (dotMat.uniforms.uOn.value as THREE.Vector4).set(vis.code ? 1 : 0, vis.live ? 1 : 0, vis.jira ? 1 : 0, vis.source ? 1 : 0);
      for (const m of cellMeshes) {
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.opacity = (vis.code ? (C.light ? 0.5 : 0.62) : 0) * (1 + 0.06 * Math.sin(time * 0.6));
        mat.visible = vis.code;
      }
      for (const a of arcs) {
        a.line.visible = vis.live;
        a.head.visible = vis.live;
        a.t = (a.t + dt * 0.22) % 1;
        a.curve.getPoint(a.t, tmpA);
        a.head.position.copy(tmpA);
        a.mat.opacity = 0.28 + 0.28 * Math.sin(time * 1.6 + a.t * 6.28);
      }
      for (const lb of labels) {
        // Mặt trước = pháp tuyến hướng về camera. Ra sau lưng cầu thì tắt hẳn cho khỏi chữ ngược.
        const face = tmpB.copy(lb.anchor).normalize().dot(tmpA.copy(camera.position).normalize());
        const mat = lb.sp.material as THREE.SpriteMaterial;
        mat.opacity = onRef.current[lb.layer] ? Math.max(0, (face - 0.25) / 0.5) * 0.9 : 0;
        lb.sp.visible = mat.opacity > 0.02;
      }
      if (hoverDirty) {
        hoverDirty = false;
        const nd = pick();
        if ((nd?.id ?? null) !== hoverId) {
          hoverId = nd?.id ?? null;
          el.style.cursor = nd ? 'pointer' : dragging ? 'grabbing' : 'grab';
          setHover(nd ? { node: nd, x: mouseScreen.x, y: mouseScreen.y } : null);
        } else if (nd) {
          setHover({ node: nd, x: mouseScreen.x, y: mouseScreen.y });
        }
      }
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('click', onClick);
      scene.traverse((o) => {
        const any = o as THREE.Mesh & { material?: THREE.Material | THREE.Material[]; geometry?: THREE.BufferGeometry };
        any.geometry?.dispose?.();
        const mat = any.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose()); else mat?.dispose?.();
      });
      cellTex.dispose(); dotTex.dispose();
      for (const t of labelTex) t.dispose();
      renderer.dispose();
      if (el.parentNode === mount) mount.removeChild(el);
    };
  }, [sig, themeKey, vi]);

  // ── Hành động khi bấm một điểm ─────────────────────────────────────────────────────────────
  const runAction = (nd: MapNode) => {
    if (!nd.action) return;
    if (nd.action.type === 'tab') onGoTask(nd.action.id);
    else onUseJiraKey(nd.action.key);
  };

  const toggle = (l: Layer) => setOn((s) => ({ ...s, [l]: !s[l] }));
  const layerLabel: Record<Layer, string> = {
    code: vi ? 'Mã nguồn' : 'Code',
    live: vi ? 'Đang chạy' : 'Live',
    jira: vi ? 'Sprint' : 'Sprint',
    source: vi ? 'Tri thức' : 'Knowledge',
  };

  return (
    <PanelShell
      icon="target"
      bodyClass="globe-body"
      title={vi ? 'Bản đồ' : 'Map'}
      subtitle={vi
        ? `Một quả cầu — mã nguồn, việc đang chạy, sprint và nguồn tri thức${repoName ? ` · ${repoName}` : ''}`
        : `One globe — code, live work, sprint and knowledge sources${repoName ? ` · ${repoName}` : ''}`}
      actions={
        <>
          {LAYER_ORDER.map((l) => (
            <button
              key={l}
              type="button"
              className={`globe-chip${on[l] ? ' on' : ''}`}
              data-l={l}
              onClick={() => toggle(l)}
              title={vi ? `Bật/tắt lớp ${layerLabel[l]}` : `Toggle ${layerLabel[l]} layer`}
            >
              <i /> {layerLabel[l]}
            </button>
          ))}
          <button type="button" className="btn" onClick={loadAll} title={vi ? 'Nạp lại dữ liệu' : 'Reload'}>
            <Icon name="refresh" size={14} />
          </button>
        </>
      }
    >
      <div className="globe-wrap">
        {err && <PanelEmpty text={vi ? `Không đọc được cây file: ${err}` : `Cannot read file tree: ${err}`} />}
        {loading && !files && <PanelEmpty text={vi ? 'Đang quét kho mã…' : 'Scanning repository…'} />}

        <div className="globe-canvas" ref={mountRef} />

        {/* Nhãn vùng — người xem phải biết mình đang nhìn múi nào, không phải đoán. */}
        <div className="globe-zones">
          {LAYER_ORDER.filter((l) => l !== 'live').map((l) => (
            <span key={l} className={`globe-zone${on[l] ? '' : ' off'}`} data-l={l}>{vi ? ZONE[l].vi : ZONE[l].en}</span>
          ))}
        </div>

        {/* Số liệu thật quanh viền (kiểu bảng điều khiển) — cùng nguồn với các chấm trên cầu. */}
        <div className="globe-stats">
          <div className="globe-stat"><b>{stats.files.toLocaleString()}</b><span>{vi ? 'file' : 'files'}</span></div>
          <div className="globe-stat"><b>{Math.round(stats.lines / 1000)}k</b><span>{vi ? 'dòng' : 'lines'}</span></div>
          <div className="globe-stat" data-t="run"><b>{stats.running}</b><span>{vi ? 'đang chạy' : 'running'}</span></div>
          <div className="globe-stat" data-t="hot"><b>{stats.waiting}</b><span>{vi ? 'chờ duyệt' : 'pending'}</span></div>
          <div className="globe-stat"><b>{stats.tickets}</b><span>{vi ? 'ticket' : 'tickets'}</span></div>
          <div className="globe-stat" data-t="hot"><b>{stats.bugs}</b><span>bug</span></div>
        </div>

        <div className="globe-side">
          <div className="globe-side-t">{vi ? 'Thư mục lớn nhất' : 'Largest directories'}</div>
          {dirs.slice(0, 6).map((d) => (
            <div key={d.dir} className="globe-side-row">
              <i style={{ background: `hsl(${Math.round(d.hue * 360)} 70% 55%)` }} />
              <span className="globe-side-n">{d.dir}</span>
              <span className="globe-side-v">{d.count}</span>
            </div>
          ))}
          <div className="globe-side-t">{sprintName || (vi ? 'Sprint' : 'Sprint')}</div>
          {jiraErr ? (
            <div className="globe-side-row muted">{jiraErr}</div>
          ) : (
            <>
              <div className="globe-side-row"><span className="globe-side-n">{vi ? 'Chưa làm' : 'To do'}</span><span className="globe-side-v">{stats.todo}</span></div>
              <div className="globe-side-row"><span className="globe-side-n">{vi ? 'Đang làm' : 'In progress'}</span><span className="globe-side-v">{stats.doing}</span></div>
              <div className="globe-side-row"><span className="globe-side-n">{vi ? 'Xong' : 'Done'}</span><span className="globe-side-v">{stats.done}</span></div>
            </>
          )}
        </div>

        <div className="globe-legend">
          <span data-t="hot">{vi ? 'cần xử lý' : 'needs attention'}</span>
          <span data-t="run">{vi ? 'đang chạy' : 'running'}</span>
          <span data-t="ok">{vi ? 'xong' : 'done'}</span>
          <span data-t="idle">{vi ? 'nghỉ' : 'idle'}</span>
        </div>

        {hover && !sel && (
          <div className="globe-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
            <b>{hover.node.label}</b>
            <span>{hover.node.sub}</span>
          </div>
        )}

        {sel && (
          <div className="globe-detail">
            <div className="globe-detail-h">
              <b>{sel.label}</b>
              <button type="button" className="globe-x" onClick={() => setSel(null)} title={vi ? 'Đóng' : 'Close'}>
                <Icon name="close" size={14} />
              </button>
            </div>
            <p>{sel.sub}</p>
            <dl>
              {sel.meta.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
            </dl>
            {sel.action && (
              <button type="button" className="btn" onClick={() => runAction(sel)}>
                {sel.action.type === 'tab' ? (vi ? 'Mở tác vụ' : 'Open task') : (vi ? 'Nạp ticket vào ô nhập' : 'Send ticket to input')}
              </button>
            )}
          </div>
        )}
      </div>
    </PanelShell>
  );
}
