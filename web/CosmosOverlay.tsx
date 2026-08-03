import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';
import type { BrainStep } from './NeuralBrain.js';
import { Icon } from './Icon.js';

/**
 * COSMOS v2 — "Living Consciousness". Vũ trụ tri thức toàn màn hình (Three.js/WebGL).
 *
 * KHÔNG phải node graph. Đây là một vũ trụ SỐNG với AI Core khổng lồ ở tâm, 9 thiên hà bất
 * đối xứng có ĐỊNH DANH màu (Memory tím, LLM vàng, Prompt xanh, Database pulsar, MCP wormhole,
 * Git red-giant, Packages cyan, Tools vành đai, Web đài quan sát) quay quanh theo quỹ đạo riêng,
 * và energy stream cong chảy khi AI suy nghĩ. Hai trục zoom:
 *  - "uni"  → toàn cảnh: Core + 9 galaxy + data-flow điện ảnh (AI thinking từ SSE thật).
 *  - "repo" → lặn vào: bản đồ file thật (mỗi thư mục một thiên hà con, số dòng → cỡ sao).
 *
 * Xương giữ nguyên từ v1 (đã chứng minh): render loop, dispose sạch, SSE→nhiệt qua ref,
 * quality-tier auto-degrade, camera damping/drift, living-universe visitWeight, bloom/DoF.
 * Thay v1: toàn bộ tầng world-building (bố cục, hình khối, màu, chuyển động). Xem COSMOS_DESIGN.md.
 * KHÔNG nhân đôi logic agent — chỉ trực quan hoá.
 */

export interface FileEntry {
  path: string;
  lines: number;
}

interface Props {
  steps: BrainStep[];
  running: boolean;
  filetree: FileEntry[];
  /** Đường dẫn (tương đối cwd) các file agent đang/vừa đụng tới — để highlight live. */
  activeFiles: string[];
  /** ID các NGUỒN tri thức agent đang dùng (brain/claudemd/memory/skills/mcp/web/prompt) —
   *  ánh xạ sang galaxy để "AI thinking" sáng thật: galaxy nóng lên, phát xung, stream chảy mạnh. */
  activeSources: string[];
  /** Tên các skill THẬT đã cấu hình (registry) — hiện trong inspector galaxy TOOLS. */
  skillList: string[];
  /** Tên các MCP server THẬT đang bật — hiện trong inspector galaxy MCP + suy DATABASE. */
  mcpList: string[];
  repoName: string;
  theme: 'light' | 'dark';
  language: 'vi' | 'en';
  onClose: () => void;
}

/**
 * 9 THIÊN HÀ có ĐỊNH DANH (COSMOS_DESIGN.md §4). Mỗi galaxy nhận ra được CHỈ QUA diện mạo.
 * - id     : khớp id nguồn từ TaskPane (activeSources) để nóng đúng chỗ; galaxy suy-từ-dữ-liệu
 *            (git/packages/database/tools) dùng id riêng, nóng theo cờ có-mặt.
 * - hue/kind: định danh màu + LOẠI thiên thể (star/nebula/pulsar/wormhole/redgiant/cluster/belt/observatory).
 * - orbit  : bán kính quỹ đạo quanh Core (dist), góc bắt đầu, elevation nghiêng, tốc độ quay (Kepler xấp xỉ).
 * KHÔNG chia đều vòng — dist/elev/ang rải bất đối xứng có chủ đích (L9). Cụm dày một phía, trống một phía.
 */
type GalaxyKind = 'star' | 'nebula' | 'pulsar' | 'wormhole' | 'redgiant' | 'cluster' | 'belt' | 'observatory' | 'energy';
interface GalaxyDef {
  id: string;
  code: string;
  hue: number;
  kind: GalaxyKind;
  dist: number;   // bán kính quỹ đạo quanh Core
  ang: number;    // góc khởi đầu (radian)
  elev: number;   // độ nghiêng khỏi mặt phẳng hoàng đạo (radian)
  spin: number;   // tốc độ quay quỹ đạo (dấu = chiều)
  scale: number;  // cỡ thiên thể lõi
  tagVi: string; tagEn: string;
  bodyVi: string; bodyEn: string;
}
const GALAXIES: GalaxyDef[] = [
  { id: 'brain', code: 'LLM', hue: 0.12, kind: 'star', dist: 92, ang: 0.35, elev: 0.28, spin: 0.018, scale: 5.4,
    tagVi: 'Não AI · model weights', tagEn: 'AI brain · model weights',
    bodyVi: 'Ngôi sao vàng kim — <strong>trọng số model</strong>, mọi thứ Claude đã học: ngôn ngữ, thuật toán, design pattern. Một mặt trời nhỏ soi sáng mọi suy luận. Giới hạn ở knowledge cutoff.',
    bodyEn: 'Golden star — <strong>model weights</strong>, everything Claude learned: language, algorithms, patterns. A small sun lighting every inference. Bounded by knowledge cutoff.' },
  { id: 'prompt', code: 'PROMPT', hue: 0.58, kind: 'energy', dist: 74, ang: 2.1, elev: -0.14, spin: -0.026, scale: 4.2,
    tagVi: 'Người dùng · lệnh + media', tagEn: 'User · prompt + media',
    bodyVi: 'Năng lượng xanh dương — <strong>câu lệnh của bạn</strong> + ảnh/video + duyệt. Nguồn khởi động mọi thứ: mỗi prompt phát một xung cầu chảy về Core.',
    bodyEn: 'Blue energy — <strong>your prompt</strong> + media + approvals. The source that starts everything: each prompt fires a shockwave toward the Core.' },
  { id: 'memory', code: 'MEMORY', hue: 0.82, kind: 'nebula', dist: 118, ang: 3.4, elev: 0.42, spin: 0.009, scale: 6.0,
    tagVi: '.claude/memory/ · ghi nhớ', tagEn: '.claude/memory/ · notes',
    bodyVi: 'Tinh vân tím cuộn — <strong>ghi nhớ cách làm việc</strong> đúc kết qua nhiều phiên. Luôn hiện diện như nền tri thức, thức dậy khi agent nhớ lại ngữ cảnh cũ.',
    bodyEn: 'A rolling purple nebula — <strong>how-we-work notes</strong> across sessions. Ever-present background knowledge that wakes when the agent recalls prior context.' },
  { id: 'mcp', code: 'MCP', hue: 0.40, kind: 'wormhole', dist: 138, ang: 4.7, elev: -0.36, spin: 0.021, scale: 4.6,
    tagVi: 'Jira · Supabase · Codemagic', tagEn: 'Jira · Supabase · Codemagic',
    bodyVi: 'Wormhole xanh lục xoáy — <strong>dữ liệu sống ngoài repo</strong>: đọc ticket Jira, truy vấn Supabase, kích build. Bẻ cong không-thời-gian khi một tool MCP mở.',
    bodyEn: 'A green wormhole — <strong>live data outside the repo</strong>: read Jira, query Supabase, trigger builds. Space bends open when an MCP tool fires.' },
  { id: 'database', code: 'DATABASE', hue: 0.55, kind: 'pulsar', dist: 106, ang: 5.6, elev: 0.5, spin: -0.015, scale: 3.8,
    tagVi: 'Supabase · Postgres', tagEn: 'Supabase · Postgres',
    bodyVi: 'Pulsar trắng quét chùm — <strong>cơ sở dữ liệu</strong>. Hiện diện khi MCP Supabase bật; chùm quét gấp khi có query. (Chỉ biết có/không — chưa đọc số liệu bảng.)',
    bodyEn: 'A white pulsar sweeping its beam — <strong>the database</strong>. Present when the Supabase MCP is on; the beam quickens on query. (Presence only — no table stats yet.)' },
  { id: 'git', code: 'GIT', hue: 0.02, kind: 'redgiant', dist: 160, ang: 0.9, elev: 0.1, spin: 0.007, scale: 7.0,
    tagVi: 'Lịch sử · commit · branch', tagEn: 'History · commits · branches',
    bodyVi: 'Sao khổng lồ đỏ — <strong>lịch sử phiên bản</strong>. Phồng-xẹp chậm, đỏ trầm như một red giant; bùng cực quang khi có commit thành công.',
    bodyEn: 'A red giant — <strong>version history</strong>. Slowly swelling, deep-red; flares into an aurora on a successful commit.' },
  { id: 'packages', code: 'PACKAGES', hue: 0.50, kind: 'cluster', dist: 128, ang: 1.7, elev: -0.5, spin: 0.013, scale: 4.0,
    tagVi: 'node_modules · dependencies', tagEn: 'node_modules · dependencies',
    bodyVi: 'Cụm sao cyan dày đặc — <strong>các dependency</strong> dự án dựa vào. Hàng trăm điểm sáng lạnh quần tụ chặt, lấp lánh đều.',
    bodyEn: 'A dense cyan cluster — <strong>the dependencies</strong> the project stands on. Hundreds of cold points packed tight, twinkling together.' },
  { id: 'tools', code: 'TOOLS', hue: 0.45, kind: 'belt', dist: 84, ang: 5.1, elev: -0.05, spin: 0.03, scale: 3.4,
    tagVi: 'Skills · tool calls', tagEn: 'Skills · tool calls',
    bodyVi: 'Vành đai phi thuyền — <strong>skills & tool calls</strong>. Hạt bay quanh một tâm; sáng bừng theo tool đang chạy, như đội tàu con thoi làm việc.',
    bodyEn: 'A ship belt — <strong>skills & tool calls</strong>. Particles orbit a hub, brightening with the running tool, like a fleet at work.' },
  { id: 'web', code: 'WEB', hue: 0.07, kind: 'observatory', dist: 168, ang: 3.9, elev: 0.52, spin: -0.011, scale: 4.4,
    tagVi: 'WebSearch · WebFetch', tagEn: 'WebSearch · WebFetch',
    bodyVi: 'Đài quan sát cam ở rìa vũ trụ — <strong>tra cứu ngoài</strong>: tài liệu, docs online khi thứ cần không có trong repo hay kiến thức nền. Xa nhất, mảnh nhất.',
    bodyEn: 'An orange observatory at the rim — <strong>external lookup</strong>: online docs when what is needed is not in the repo or base knowledge. Farthest, thinnest.' },
];

/** Nguồn 'claudemd' (chỉ dẫn dự án) & 'skills' hoà vào Core/TOOLS thay vì một galaxy riêng.
 *  Ánh xạ id-nguồn-từ-TaskPane → id-galaxy để nóng đúng chỗ. */
const SOURCE_TO_GALAXY: Record<string, string> = {
  brain: 'brain', prompt: 'prompt', memory: 'memory', mcp: 'mcp', web: 'web',
  skills: 'tools', claudemd: 'brain', // chỉ dẫn = một phần "não codebase" ở Core → dùng LLM galaxy làm proxy nhiệt
};

const DIR_HUE: Record<string, number> = {
  src: 0.55, web: 0.08, docs: 0.28, '.claude': 0.78, '(root)': 0.6,
  scripts: 0.13, '.github': 0.42, '.vscode': 0.5, examples: 0.9, '.agents': 0.83,
};

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
function rng(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
}
function topDir(p: string) { const i = p.indexOf('/'); return i < 0 ? '(root)' : p.slice(0, i); }

export function CosmosOverlay({ steps, running, filetree, activeFiles, activeSources, skillList, mcpList, repoName, theme, language, onClose }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const labelsRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<'uni' | 'repo'>('uni');
  const [live, setLive] = useState('');
  const [tier, setTier] = useState<'ultra' | 'high' | 'balanced' | 'lite'>('high');
  const [fps, setFps] = useState(60);
  const [query, setQuery] = useState('');
  const [autopilot, setAutopilot] = useState(false);
  const [sel, setSel] = useState<{ tag: string; name: string; body: string; status: string; live: boolean; meta: [string, string][] } | null>(null);
  const [coords, setCoords] = useState({ ra: 'RA 11ʰ38ᵐ · DEC −23°', zoom: '×1.0' });

  const totalFiles = filetree.length || 1;
  const dirCount = (() => { const s = new Set<string>(); filetree.forEach((f) => s.add(topDir(f.path))); return s.size || 1; })();

  const apiRef = useRef<{ setMode: (m: 'uni' | 'repo') => void; focusGalaxy: (id: string) => void; focusFile: (path: string) => void; focusDir: (dir: string) => void; reset: () => void } | null>(null);
  const activeRef = useRef<string[]>(activeFiles);
  activeRef.current = activeFiles;
  const srcActiveRef = useRef<string[]>(activeSources);
  srcActiveRef.current = activeSources;
  const skillListRef = useRef<string[]>(skillList);
  skillListRef.current = skillList;
  const mcpListRef = useRef<string[]>(mcpList);
  mcpListRef.current = mcpList;
  const tierRef = useRef(tier);
  tierRef.current = tier;
  const queryRef = useRef(query);
  queryRef.current = query;
  const autopilotRef = useRef(false);
  const runningRef = useRef(running);
  runningRef.current = running;
  const langRef = useRef(language);
  langRef.current = language;
  // steps đổi mỗi tick agent → qua ref để loop đọc (phát hiện step 'error' → hố đen), không re-run effect.
  const stepsRef = useRef<BrainStep[]>(steps);
  stepsRef.current = steps;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const W0 = mount.clientWidth || window.innerWidth;
    const H0 = mount.clientHeight || window.innerHeight;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x03040a, 0.0011); // fog rất loãng → thấy được thiên hà XA + starfield dày (depth thật)
    const camera = new THREE.PerspectiveCamera(56, W0 / H0, 0.1, 3000);
    camera.position.set(0, 40, 300);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W0, H0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = theme === 'light' ? 1.02 : 1.14;
    mount.appendChild(renderer.domElement);

    // ── Quality tier (auto-degrade trong loop) ──
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const detectTier = (): 'ultra' | 'high' | 'balanced' | 'lite' => {
      if (reducedMotion) return 'lite';
      const gl = renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const gpu = (dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '').toLowerCase();
      const integrated = /intel|swiftshader|llvmpipe|apple gpu|mali|adreno 3|powervr/.test(gpu);
      const dpr = window.devicePixelRatio || 1;
      if (integrated) return 'balanced';
      if (dpr >= 2) return 'ultra';
      return 'high';
    };
    let curTier = detectTier();
    tierRef.current = curTier; setTier(curTier);
    const tierRank = { lite: 0, balanced: 1, high: 2, ultra: 3 } as const;

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // Bloom chọn lọc (threshold 0.82) — chỉ vật RẤT sáng loang, sao điểm vẫn sắc. Bí quyết "rực mà nét".
    const bloom = new UnrealBloomPass(new THREE.Vector2(W0, H0), 0.85, 0.55, 0.82);
    composer.addPass(bloom);
    const bokeh = new BokehPass(scene, camera, { focus: 200, aperture: 0.00012, maxblur: 0.006 });
    bokeh.enabled = tierRank[curTier] >= tierRank.high;
    composer.addPass(bokeh);
    // Motion-blur (afterimage) — CHỈ bật lúc warp ở tier ultra. `damp` thấp = vệt mờ dài. Loop
    // chỉnh damp theo `warp`: đứng yên damp≈0 (không lưu ảnh cũ), warp mạnh damp cao → xuyên-không.
    const afterimage = new AfterimagePass(0);
    afterimage.enabled = false;
    composer.addPass(afterimage);

    // ── textures dùng chung ──
    const glowTex = (() => {
      const s = 128; const c = document.createElement('canvas'); c.width = c.height = s;
      const g = c.getContext('2d')!;
      const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.5)');
      gr.addColorStop(0.5, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, s, s);
      return new THREE.CanvasTexture(c);
    })();
    const starTex = (() => {
      const s = 64; const c = document.createElement('canvas'); c.width = c.height = s;
      const g = c.getContext('2d')!;
      const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.12, 'rgba(255,255,255,0.95)');
      gr.addColorStop(0.35, 'rgba(255,255,255,0.25)'); gr.addColorStop(0.7, 'rgba(255,255,255,0.04)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, s, s);
      return new THREE.CanvasTexture(c);
    })();
    const px = renderer.getPixelRatio();

    // ── SAO NỀN (vỏ cầu XA — r≈600, độ sâu thật) ──
    const bgStars = (() => {
      const count = 3200; const g = new THREE.BufferGeometry();
      const pos = new Float32Array(count * 3); const sz = new Float32Array(count); const R = rng(7);
      for (let i = 0; i < count; i++) {
        const u = R(), v = R(), th = u * 6.283, ph = Math.acos(2 * v - 1); const r = 600 * (0.5 + 0.5 * Math.cbrt(R()));
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.7; pos[i * 3 + 2] = r * Math.cos(ph); sz[i] = 0.5 + R() * 1.6;
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
      const m = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: starTex }, uTime: { value: 0 }, uPix: { value: px }, uWarp: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: `attribute float aSize; varying float vTw; uniform float uTime,uPix,uWarp;
          void main(){ vTw=0.5+0.5*sin(uTime*1.5+position.x*0.6); vec4 mv=modelViewMatrix*vec4(position,1.0);
            gl_PointSize=aSize*uPix*(340.0/-mv.z)*(1.0+uWarp*3.0); gl_Position=projectionMatrix*mv; }`,
        fragmentShader: `uniform sampler2D uTex; uniform float uWarp; varying float vTw;
          void main(){ vec4 t=texture2D(uTex,gl_PointCoord); gl_FragColor=vec4(vec3(0.72,0.78,1.0),t.a*(0.5+vTw*0.65)*(0.85+uWarp*0.6)); }`,
      });
      const p = new THREE.Points(g, m); scene.add(p); return { p, m };
    })();

    // ── BỤI parallax (vỏ cầu quanh camera) ──
    const dustGroup = new THREE.Group(); scene.add(dustGroup);
    const dustLayers = ([[800, 100, 1.6, 0.85], [900, 200, 1.2, 0.65], [800, 340, 0.9, 0.45]] as const).map(([n, rad, size, op]) => {
      const g = new THREE.BufferGeometry(); const pos = new Float32Array(n * 3); const R = rng(rad | 0);
      for (let i = 0; i < n; i++) {
        const u = R(), v = R(), th = u * 6.283, ph = Math.acos(2 * v - 1); const r = rad * (1 + 0.8 * R());
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.8; pos[i * 3 + 2] = r * Math.cos(ph);
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const m = new THREE.PointsMaterial({ map: starTex, color: 0xaebfe8, size, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: false });
      const p = new THREE.Points(g, m); dustGroup.add(p); return p;
    });

    // ── TINH VÂN XA (đẩy z≤−260, chỉ nhuốm màu chiều sâu) ──
    const ambNeb: { s: THREE.Sprite; ph: number; baseOp: number; spin: number }[] = [];
    ([[0x5a3fa0, 0.04, 380, -320], [0x2f5f9e, 0.034, 320, -300], [0x7a3f6e, 0.03, 300, -380], [0x2f7a6e, 0.026, 260, -280]] as const)
      .forEach(([hex, op, sc, z]) => {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: hex, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false }));
        s.position.set((Math.random() - 0.5) * 240, (Math.random() - 0.5) * 140, z); s.scale.setScalar(sc);
        scene.add(s); ambNeb.push({ s, ph: Math.random() * 6.28, baseOp: op, spin: (Math.random() - 0.5) * 0.02 });
      });

    const CORE = new THREE.Vector3(0, 0, 0);
    const tmpV = new THREE.Vector3(); // vector tạm tái dùng (không cấp phát trong loop)

    // ══════════════════════════════════════════════════════════════════════════════════════
    // AI CORE — nhân vật chính (COSMOS_DESIGN.md §3). Khối khổng lồ nhiều lớp, áp đảo mọi thứ.
    // ══════════════════════════════════════════════════════════════════════════════════════
    const coreGrp = new THREE.Group(); scene.add(coreGrp);
    const CORE_R = 26; // bán kính hiệu dụng — luôn là vật lớn nhất khung (hierarchy scale)
    // Nhân trắng-nóng (thở) + vỏ hổ phách. Corona là shader nhiễu cuộn (bề mặt sao thật, không sprite phẳng).
    const coreHot = new THREE.Mesh(new THREE.SphereGeometry(CORE_R * 0.34, 32, 32), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const coronaMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uHeat: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
      // Nhiễu value-noise 3D rẻ (không texture): plasma cuộn trên bề mặt cầu. uHeat → cuộn nhanh + sáng.
      vertexShader: `varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vP; uniform float uTime,uHeat;
        float hash(vec3 p){ return fract(sin(dot(p,vec3(27.1,57.7,113.5)))*43758.5); }
        float noise(vec3 p){ vec3 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
          float n=mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                      mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
          return n; }
        void main(){ vec3 p=normalize(vP)*3.0; float t=uTime*(0.25+uHeat*0.6);
          float n=noise(p+vec3(t,t*0.7,-t))*0.6+noise(p*2.4-vec3(t*0.5))*0.3+noise(p*5.0+vec3(t))*0.1;
          vec3 amber=vec3(1.0,0.66,0.24), hot=vec3(1.0,0.92,0.7);
          vec3 col=mix(amber,hot,smoothstep(0.45,0.9,n)+uHeat*0.4);
          float a=(0.55+0.45*n)*(0.85+uHeat*0.4);
          gl_FragColor=vec4(col,a); }`,
    });
    const corona = new THREE.Mesh(new THREE.SphereGeometry(CORE_R * 0.62, 48, 48), coronaMat);
    // Quầng volumetric lớn (nhiều lớp sprite chồng → khối sáng có chiều sâu, không đĩa phẳng).
    const coreHalos: THREE.Sprite[] = [];
    ([[CORE_R * 3.4, 0.5], [CORE_R * 5.6, 0.26], [CORE_R * 8.2, 0.12]] as const).forEach(([sc, op]) => {
      const h = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffb347, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false }));
      h.scale.setScalar(sc); coreGrp.add(h); coreHalos.push(h);
    });
    coreGrp.add(coreHot, corona);
    // Nhiều VÀNH năng lượng nghiêng lệch trục, quay ngược nhau (accretion rings).
    const coreRings: { m: THREE.Mesh; sp: number }[] = [];
    ([[CORE_R * 1.3, 0.06, 0.5, 0.9], [CORE_R * 1.7, 0.05, 1.1, -0.6], [CORE_R * 2.3, 0.04, 0.2, 0.35]] as const).forEach(([r, w, tilt, sp]) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(r, r + r * w, 128),
        new THREE.MeshBasicMaterial({ color: 0xffcf8a, transparent: true, opacity: 0.42, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.rotation.x = Math.PI / 2.1 + tilt; m.rotation.y = tilt * 0.6; coreGrp.add(m); coreRings.push({ m, sp });
    });
    // God-rays xấp xỉ rẻ (6 tia kéo giãn từ Core) — tier high/ultra.
    const godRays: THREE.Sprite[] = [];
    for (let i = 0; i < 6; i++) {
      const g = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffcf8a, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }));
      g.scale.set(CORE_R * 0.5, CORE_R * 6, 1); g.material.rotation = (i / 6) * Math.PI; coreGrp.add(g); godRays.push(g);
    }

    // ══════════════════════════════════════════════════════════════════════════════════════
    // 9 THIÊN HÀ — rải BẤT ĐỐI XỨNG quanh Core theo quỹ đạo (COSMOS_DESIGN.md §4, L9).
    // Suy galaxy có-thật từ dữ liệu: git & packages luôn có (repo TS/Node); database từ MCP supabase.
    // ══════════════════════════════════════════════════════════════════════════════════════
    const mcpLower = mcpList.map((m) => m.toLowerCase()).join(' ');
    const hasDb = /supabase|postgres|mysql|sql/.test(mcpLower);
    const galaxyGroups: {
      def: GalaxyDef; grp: THREE.Group; col: THREE.Color; core: THREE.Mesh; hotMat: THREE.MeshBasicMaterial;
      halo: THREE.Sprite; ring?: THREE.Mesh; beam?: THREE.Sprite; present: boolean;
      orbitR: number; orbitAng: number; orbitElev: number; spin: number; extras: THREE.Object3D[];
    }[] = [];

    const present = (id: string) => {
      if (id === 'database') return hasDb;
      return true; // các galaxy khác luôn hiện diện (nguồn tri thức nền / suy được từ repo)
    };

    GALAXIES.forEach((def) => {
      const col = new THREE.Color().setHSL(def.hue, def.kind === 'redgiant' ? 0.85 : 0.6, def.kind === 'pulsar' ? 0.9 : 0.6);
      const grp = new THREE.Group();
      // Vị trí ban đầu trên quỹ đạo (bất đối xứng: dist/ang/elev đã lệch nhau trong GALAXIES).
      const orbitR = def.dist, orbitAng = def.ang, orbitElev = def.elev;
      grp.position.set(Math.cos(orbitAng) * orbitR * Math.cos(orbitElev), Math.sin(orbitElev) * orbitR, Math.sin(orbitAng) * orbitR * Math.cos(orbitElev));
      scene.add(grp);

      const isPresent = present(def.id);
      const dim = isPresent ? 1 : 0.32; // galaxy không-hiện-diện (vd DB chưa bật) mờ đi, không giả sống

      // Lõi galaxy — hình khối theo LOẠI (đa dạng thiên thể, COSMOS_DESIGN.md §4).
      const core = new THREE.Mesh(new THREE.SphereGeometry(def.scale * 0.5, 28, 28), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: dim }));
      const hotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: dim });
      const hot = new THREE.Mesh(new THREE.SphereGeometry(def.scale * 0.24, 20, 20), hotMat);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, opacity: 0.7 * dim, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo.scale.setScalar(def.scale * 5.5);
      const aura = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, opacity: 0.12 * dim, blending: THREE.AdditiveBlending, depthWrite: false }));
      aura.scale.setScalar(def.scale * 10);
      grp.add(aura, core, hot, halo);
      const extras: THREE.Object3D[] = [];

      // ── Diện mạo đặc trưng theo LOẠI ──
      if (def.kind === 'nebula') {
        // Tinh vân tím: nhiều đám khói chồng
        for (let k = 0; k < 6; k++) {
          const n = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, opacity: 0.08 * dim, blending: THREE.AdditiveBlending, depthWrite: false }));
          n.position.set((Math.random() - 0.5) * def.scale * 5, (Math.random() - 0.5) * def.scale * 3.5, (Math.random() - 0.5) * def.scale * 5);
          n.scale.setScalar(def.scale * (5 + k * 2.5)); grp.add(n); extras.push(n);
        }
      } else if (def.kind === 'wormhole') {
        // Wormhole: vòng xoáy bẹt (torus mảnh)
        const ring = new THREE.Mesh(new THREE.TorusGeometry(def.scale * 1.6, def.scale * 0.12, 16, 96),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.6 * dim, blending: THREE.AdditiveBlending, depthWrite: false }));
        grp.add(ring); extras.push(ring);
        galaxyGroups.push({ def, grp, col, core, hotMat, halo, ring, present: isPresent, orbitR, orbitAng, orbitElev, spin: def.spin, extras });
        return;
      } else if (def.kind === 'pulsar') {
        // Pulsar: hai chùm quét đối xứng (lighthouse)
        const beam = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, transparent: true, opacity: 0.5 * dim, blending: THREE.AdditiveBlending, depthWrite: false }));
        beam.scale.set(def.scale * 0.4, def.scale * 9, 1); grp.add(beam); extras.push(beam);
        galaxyGroups.push({ def, grp, col, core, hotMat, halo, beam, present: isPresent, orbitR, orbitAng, orbitElev, spin: def.spin, extras });
        return;
      } else if (def.kind === 'redgiant') {
        // Red giant: quầng đỏ trầm cực lớn
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, opacity: 0.2 * dim, blending: THREE.AdditiveBlending, depthWrite: false }));
        glow.scale.setScalar(def.scale * 8); grp.add(glow); extras.push(glow);
      } else if (def.kind === 'cluster' || def.kind === 'belt') {
        // Cụm sao / vành đai: nhiều điểm sáng nhỏ quần tụ / bay quanh
        const n = def.kind === 'cluster' ? 260 : 90;
        const g = new THREE.BufferGeometry(); const pos = new Float32Array(n * 3); const R = rng(hashCode(def.id));
        for (let i = 0; i < n; i++) {
          if (def.kind === 'cluster') { // cụm cầu chặt
            const u = R(), v = R(), th = u * 6.283, ph = Math.acos(2 * v - 1), r = def.scale * (0.6 + 1.8 * Math.cbrt(R()));
            pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th); pos[i * 3 + 2] = r * Math.cos(ph);
          } else { // vành đai: đĩa mỏng
            const th = R() * 6.283, r = def.scale * (1.6 + 1.2 * R());
            pos[i * 3] = Math.cos(th) * r; pos[i * 3 + 1] = (R() - 0.5) * def.scale * 0.4; pos[i * 3 + 2] = Math.sin(th) * r;
          }
        }
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const m = new THREE.PointsMaterial({ map: starTex, color: col, size: def.kind === 'cluster' ? 1.3 : 1.6, transparent: true, opacity: 0.9 * dim, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
        const pts = new THREE.Points(g, m); grp.add(pts); extras.push(pts);
      } else if (def.kind === 'observatory') {
        // Đài quan sát: vòng orbit mảnh nghiêng
        const ring = new THREE.Mesh(new THREE.RingGeometry(def.scale * 2, def.scale * 2.15, 96),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5 * dim, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
        ring.rotation.x = Math.PI / 3; grp.add(ring); extras.push(ring);
      }
      galaxyGroups.push({ def, grp, col, core, hotMat, halo, present: isPresent, orbitR, orbitAng, orbitElev, spin: def.spin, extras });
    });

    // ══════════════════════════════════════════════════════════════════════════════════════
    // ENERGY STREAM — dòng năng lượng CONG (Catmull-Rom) từ mỗi galaxy về Core. Hạt chạy dọc
    // với vận tốc; sáng theo nhiệt (data-flow). Bất hoạt gần tàng hình, hoạt động thì rực (§5).
    // ══════════════════════════════════════════════════════════════════════════════════════
    const streams = galaxyGroups.map((gg) => {
      const from = gg.grp.position.clone();
      // Điểm uốn giữa: đẩy lệch để đường CONG rõ, không thẳng. Lệch theo pháp tuyến ngẫu nhiên có seed.
      const mid = from.clone().multiplyScalar(0.5);
      const perp = new THREE.Vector3(-from.z, from.x * 0.3, from.x).normalize().multiplyScalar(from.length() * 0.35);
      mid.add(perp).add(new THREE.Vector3(0, from.length() * 0.15, 0));
      const curve = new THREE.CatmullRomCurve3([from.clone(), mid, CORE.clone()]);
      const n = 40; const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(n * 3); const ts = new Float32Array(n);
      for (let i = 0; i < n; i++) ts[i] = Math.random();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const m = new THREE.PointsMaterial({ map: glowTex, color: gg.col, size: 1.6, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false });
      const p = new THREE.Points(geo, m); scene.add(p);
      // Đường cong nền mảnh (để "thấy" luồng cả khi bất hoạt). Geometry được REBUILD mỗi frame trong
      // loop từ curve đã cập nhật — vì galaxy quay quanh Core, đường tĩnh sẽ lệch khỏi galaxy ("đường ma").
      const LN = 48; const lpos = new Float32Array(LN * 3);
      const lineGeo = new THREE.BufferGeometry(); lineGeo.setAttribute('position', new THREE.BufferAttribute(lpos, 3));
      const lineMat = new THREE.LineBasicMaterial({ color: gg.col, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false });
      const line = new THREE.Line(lineGeo, lineMat); scene.add(line);
      return { p, m, line, lineGeo, lpos, LN, lineMat, curve, ts, n, id: gg.def.id };
    });

    // ══════════════════════════════════════════════════════════════════════════════════════
    // BẢN ĐỒ FILE (repo mode) — mỗi thư mục một thiên hà con, số dòng → cỡ sao. Giữ từ v1
    // nhưng scale-down để lọt bên trong Core khi lặn (hierarchy: file < galaxy < Core).
    // ══════════════════════════════════════════════════════════════════════════════════════
    const galaxies = new Map<string, FileEntry[]>();
    (filetree.length ? filetree : [{ path: 'app', lines: 1 }]).forEach((f) => {
      const d = topDir(f.path); if (!galaxies.has(d)) galaxies.set(d, []); galaxies.get(d)!.push(f);
    });
    const dirColor = (d: string) => new THREE.Color().setHSL(DIR_HUE[d] ?? (Math.abs(hashCode(d)) % 100) / 100, 0.6, 0.62);
    const galList = [...galaxies.entries()].sort((a, b) => b[1].length - a[1].length);
    const nG = galList.length;
    const total = filetree.length || 1;
    const maxLines = Math.max(1, ...filetree.map((f) => f.lines || 1));
    const posArr = new Float32Array(total * 3), colArr = new Float32Array(total * 3), sizeArr = new Float32Array(total), litArr = new Float32Array(total);
    const stars: { path: string; lines: number; dir: string; ext: string; worldPos: THREE.Vector3; i: number }[] = [];
    const dirInfo: { dir: string; center: THREE.Vector3; count: number; color: THREE.Color; halo?: THREE.Sprite }[] = [];
    const idxByPath = new Map<string, number>();
    let idx = 0;
    galList.forEach(([dir, files], gi) => {
      // Bất đối xứng: golden-angle + nhiễu seed thay vì chia đều (gi/nG)·2π (L9).
      const golden = 2.399963; const Rd = rng(hashCode(dir) || 1);
      const ang = gi * golden + (Rd() - 0.5) * 0.5;
      const ringR = 34 + (gi % 3) * 5 + Rd() * 8; // bán kính lệch nhau → không thành một vòng
      const cx = Math.cos(ang) * ringR, cz = Math.sin(ang) * ringR, cy = (Rd() - 0.5) * 22;
      const center = new THREE.Vector3(cx, cy, cz); const gcol = dirColor(dir);
      dirInfo.push({ dir, center, count: files.length, color: gcol });
      const Rg = rng((hashCode(dir) & 0xffff) || 1); const spread = 4 + Math.sqrt(files.length) * 1.6;
      files.forEach((f, fi) => {
        const arm = fi % 3; const rr = spread * (0.2 + 0.8 * Math.sqrt(Rg())); const th = rr * 0.4 + arm * (Math.PI * 2 / 3) + (Rg() - 0.5) * 0.7;
        const x = cx + Math.cos(th) * rr, z = cz + Math.sin(th) * rr, y = cy + (Rg() - 0.5) * spread * 0.4;
        posArr[idx * 3] = x; posArr[idx * 3 + 1] = y; posArr[idx * 3 + 2] = z;
        // Red-giant cho file rất lớn (>800 dòng) → ngả đỏ; file nhỏ giữ hue thư mục.
        const big = (f.lines || 1) > 800;
        const c = big ? new THREE.Color().setHSL(0.02, 0.8, 0.6) : gcol.clone();
        const lum = 0.5 + 0.4 * Math.min(1, (f.lines || 1) / maxLines); c.offsetHSL(0, 0, lum - 0.62);
        colArr[idx * 3] = c.r; colArr[idx * 3 + 1] = c.g; colArr[idx * 3 + 2] = c.b;
        sizeArr[idx] = 1.2 + Math.log2((f.lines || 1) + 1) * 0.85; litArr[idx] = 0;
        stars.push({ path: f.path, lines: f.lines || 0, dir, ext: (f.path.split('.').pop() || ''), worldPos: new THREE.Vector3(x, y, z), i: idx });
        idxByPath.set(f.path, idx);
        idx++;
      });
    });
    const fileGeo = new THREE.BufferGeometry();
    fileGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    fileGeo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    fileGeo.setAttribute('aSize', new THREE.BufferAttribute(sizeArr, 1));
    fileGeo.setAttribute('aLit', new THREE.BufferAttribute(litArr, 1));
    const fileMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: glowTex }, uTime: { value: 0 }, uPix: { value: px }, uReveal: { value: 0 } },
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float aSize; attribute float aLit; varying vec3 vColor; varying float vLit; uniform float uTime,uPix,uReveal;
        void main(){ float pulse=1.0+aLit*0.8*sin(uTime*6.0); vColor=mix(color,vec3(1.0,1.0,0.85),aLit*0.7); vLit=aLit;
          vec4 mv=modelViewMatrix*vec4(position,1.0);
          gl_PointSize=aSize*uPix*(300.0/-mv.z)*(1.0+aLit*1.4)*pulse*uReveal;
          gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `uniform sampler2D uTex; uniform float uReveal; varying vec3 vColor; varying float vLit;
        void main(){ vec4 t=texture2D(uTex,gl_PointCoord); gl_FragColor=vec4(vColor,t.a*(0.75+vLit*0.25)*uReveal); }`,
    });
    const filePoints = new THREE.Points(fileGeo, fileMat); scene.add(filePoints);
    dirInfo.forEach((g) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: g.color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.scale.setScalar(5 + Math.sqrt(g.count) * 3); s.position.copy(g.center); scene.add(s); g.halo = s;
    });

    // ── state camera ──
    let yaw = 0.2, pitch = 0.14, tYaw = 0.2, tPitch = 0.14, dist = 300, tDist = 300;
    let dragging = false, dpx = 0, dpy = 0, mX = 0, mY = 0;
    const orbitTarget = new THREE.Vector3(0, 0, 0), tOrbitTarget = new THREE.Vector3(0, 0, 0);
    let modeState: 'uni' | 'repo' = 'uni';
    let reveal = 0, warp = 0, prevQuery = '', idleTime = 0, idlePtr = 0, introT = 0;
    const litVal = new Float32Array(total);

    // ── LIVING UNIVERSE: visitWeight (L6) ──
    const visitKey = `bow-cosmos-visits:${repoName || 'repo'}`;
    const visitWeight: Record<string, number> = (() => {
      try { return JSON.parse(localStorage.getItem(visitKey) || '{}'); } catch { return {}; }
    })();
    const bumpVisit = (path: string) => {
      visitWeight[path] = Math.min(1, (visitWeight[path] || 0) + 0.34);
      try { localStorage.setItem(visitKey, JSON.stringify(visitWeight)); } catch { /* quota */ }
    };

    // ── AI THINKING: nhiệt mỗi galaxy (0..1), nóng khi agent dùng nguồn tương ứng rồi nguội ──
    const heat: Record<string, number> = {};
    GALAXIES.forEach((d) => { heat[d.id] = 0; });
    const prevHot = new Set<string>();
    const approvalCol = (() => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--step-approval').trim();
      try { return new THREE.Color(raw || '#ffcf24'); } catch { return new THREE.Color('#ffcf24'); }
    })();
    const ripples: { col: THREE.Color; t: number; s: THREE.Sprite }[] = [];
    const spawnRipple = (pos: THREE.Vector3, col: THREE.Color) => {
      if (ripples.length > 14) return;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.position.copy(pos); s.scale.setScalar(2); scene.add(s);
      ripples.push({ col, t: 0, s });
    };
    // Map id-nguồn (từ TaskPane) → id-galaxy để nóng đúng chỗ.
    const heatSource = (srcId: string): string => SOURCE_TO_GALAXY[srcId] ?? srcId;

    // ── HỐ ĐEN (L7) — khi stream có step type 'error' (LỖI THẬT). Vùng tối + vành sáng méo xoáy,
    //    bẻ cong ánh sáng lân cận (approx, KHÔNG mô phỏng vật lý). Nở ra khi lỗi, TAN khi hết lỗi. ──
    const blackHoleGrp = new THREE.Group(); blackHoleGrp.position.set(-30, 14, 20); scene.add(blackHoleGrp);
    const bhVoid = new THREE.Mesh(new THREE.SphereGeometry(3, 24, 24), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    const bhDisk = new THREE.Mesh(new THREE.RingGeometry(3.4, 7, 96),
      new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    bhDisk.rotation.x = Math.PI / 2.4;
    const bhLens = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x8844ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    bhLens.scale.setScalar(22);
    blackHoleGrp.add(bhVoid, bhDisk, bhLens);
    blackHoleGrp.visible = false; // ẩn tới khi có lỗi thật (tránh nháy 1 frame sphere đen lúc mount)
    blackHoleGrp.scale.setScalar(0);
    let bhLife = 0; // 0..1 mức hiện diện hố đen (lerp theo có/không lỗi)

    const applyMode = (m: 'uni' | 'repo') => {
      modeState = m; setMode(m);
      if (m === 'repo') { tOrbitTarget.set(0, 0, 0); tDist = 60; }
      else { tOrbitTarget.set(0, 0, 0); tDist = 300; }
    };

    const el = renderer.domElement;
    const resetIdle = () => { idleTime = 0; };
    const onDown = (e: MouseEvent) => { dragging = true; el.classList.add('dragging'); dpx = e.clientX; dpy = e.clientY; resetIdle(); };
    const onUp = () => { dragging = false; el.classList.remove('dragging'); };
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      mX = (e.clientX - r.left) / r.width - 0.5; mY = (e.clientY - r.top) / r.height - 0.5;
      if (dragging) { tYaw += (e.clientX - dpx) * 0.005; tPitch += (e.clientY - dpy) * 0.005; tPitch = Math.max(-1.3, Math.min(1.3, tPitch)); dpx = e.clientX; dpy = e.clientY; resetIdle(); }
    };
    const onWheel = (e: WheelEvent) => {
      tDist = Math.max(10, Math.min(420, tDist + e.deltaY * 0.14));
      if (tDist < 55 && modeState === 'uni') applyMode('repo');
      if (tDist > 95 && modeState === 'repo') applyMode('uni');
      resetIdle();
    };
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mousemove', onMove);
    el.addEventListener('wheel', onWheel, { passive: true });

    const screenOf = (v: THREE.Vector3) => {
      const sp = tmpV.copy(v).project(camera); const r = el.getBoundingClientRect();
      return { x: r.left + (sp.x * 0.5 + 0.5) * r.width, y: r.top + (-sp.y * 0.5 + 0.5) * r.height, behind: sp.z > 1 };
    };

    const onClick = (e: MouseEvent) => {
      resetIdle();
      if (modeState === 'uni') {
        let best: typeof galaxyGroups[number] | null = null, bd = 1e9;
        for (const gg of galaxyGroups) { const s = screenOf(gg.grp.position); if (s.behind) continue; const d = Math.hypot(e.clientX - s.x, e.clientY - s.y); if (d < bd) { bd = d; best = gg; } }
        const cs = screenOf(CORE); const cd = Math.hypot(e.clientX - cs.x, e.clientY - cs.y);
        if (!cs.behind && cd < 120 && cd < bd) { openCore(); return; }
        if (best && bd < 110) openGalaxy(best.def);
      } else {
        let best: typeof stars[number] | null = null, bd = 1e9;
        for (const st of stars) { const s = screenOf(st.worldPos); if (s.behind) continue; const d = Math.hypot(e.clientX - s.x, e.clientY - s.y); if (d < bd && d < 24) { bd = d; best = st; } }
        if (best) openFile(best);
      }
    };
    el.addEventListener('click', onClick);

    // BẤM ĐÚP = WARP: phóng thẳng tới vật gần con trỏ nhất, cắt phần lớn khoảng cách trong 1 nhịp
    // (snap orbitTarget + hạ tDist mạnh) → travelSpeed vọt → sao kéo vệt + motion-blur, rồi hãm mềm.
    const onDbl = (e: MouseEvent) => {
      resetIdle();
      if (modeState === 'uni') {
        let best: typeof galaxyGroups[number] | null = null, bd = 1e9;
        for (const gg of galaxyGroups) { const s = screenOf(gg.grp.position); if (s.behind) continue; const d = Math.hypot(e.clientX - s.x, e.clientY - s.y); if (d < bd) { bd = d; best = gg; } }
        if (best && bd < 160) { orbitTarget.copy(camera.position).lerp(best.grp.position, 0.5); tOrbitTarget.copy(best.grp.position); tDist = Math.max(28, best.def.scale * 6); openGalaxy(best.def); }
      } else {
        let best: typeof stars[number] | null = null, bd = 1e9;
        for (const st of stars) { const s = screenOf(st.worldPos); if (s.behind) continue; const d = Math.hypot(e.clientX - s.x, e.clientY - s.y); if (d < bd && d < 40) { bd = d; best = st; } }
        if (best) { orbitTarget.copy(camera.position).lerp(best.worldPos, 0.5); tOrbitTarget.copy(best.worldPos); tDist = 16; openFile(best); }
      }
    };
    el.addEventListener('dblclick', onDbl);

    const vi = () => langRef.current === 'vi';
    function openGalaxy(def: GalaxyDef) {
      let body = vi() ? def.bodyVi : def.bodyEn;
      const meta: [string, string][] = [];
      const h = heat[def.id] ?? 0;
      const gg = galaxyGroups.find((x) => x.def.id === def.id);
      if (def.id === 'tools') {
        const list = skillListRef.current;
        if (list.length) body += `<div class="cosmos-insp-list"><b>${vi() ? 'Skill đã cấu hình' : 'Configured skills'} (${list.length}):</b> ${list.slice(0, 24).map((s) => `<span>${s}</span>`).join('')}${list.length > 24 ? ' …' : ''}</div>`;
        meta.push([vi() ? 'Số skill' : 'Skills', String(list.length)]);
      } else if (def.id === 'mcp') {
        const list = mcpListRef.current;
        if (list.length) body += `<div class="cosmos-insp-list"><b>${vi() ? 'Server đang bật' : 'Active servers'} (${list.length}):</b> ${list.map((s) => `<span>${s}</span>`).join('')}</div>`;
        else body += `<div class="cosmos-insp-list">${vi() ? 'Chưa bật MCP nào.' : 'No MCP enabled.'}</div>`;
        meta.push([vi() ? 'Số server' : 'Servers', String(list.length)]);
      } else if (def.id === 'database') {
        meta.push([vi() ? 'Trạng thái' : 'Status', gg?.present ? (vi() ? 'Đã kết nối' : 'Connected') : (vi() ? 'Chưa bật' : 'Off')]);
      }
      const isHot = h > 0.15;
      setSel({ tag: vi() ? def.tagVi : def.tagEn, name: def.code, body,
        status: isHot ? (vi() ? 'Đang hoạt động · agent thinking' : 'Active · agent thinking')
          : (gg?.present === false ? (vi() ? 'Chưa hiện diện' : 'Not present') : (vi() ? 'Thiên hà tri thức' : 'Knowledge galaxy')),
        live: isHot, meta });
      if (gg) { tOrbitTarget.copy(gg.grp.position); tDist = Math.max(30, def.scale * 7); }
    }
    function openCore() {
      setSel({ tag: vi() ? 'AI Core · lõi tổng hợp' : 'AI Core · synthesis core', name: repoName || 'AI CORE',
        body: vi() ? `Bộ não sống của agent — nơi mọi tri thức hội tụ và <strong>nung nấu thành hành động</strong>. Cuộn tới để lặn vào bản đồ ${total} file.` : `The agent's living brain — where all knowledge converges and <strong>turns into action</strong>. Zoom in to dive into the ${total}-file map.`,
        status: vi() ? 'Lõi đang tổng hợp' : 'Synthesizing', live: true,
        meta: [[vi() ? 'File' : 'Files', String(total)], [vi() ? 'Thư mục' : 'Folders', String(nG)], [vi() ? 'Thiên hà' : 'Galaxies', String(galaxyGroups.filter((g) => g.present).length)]] });
      tOrbitTarget.set(0, 0, 0);
    }
    function openFile(st: typeof stars[number]) {
      bumpVisit(st.path);
      const lit = litVal[st.i] > 0.5;
      setSel({ tag: (st.path.includes('/') ? st.path.slice(0, st.path.lastIndexOf('/')) : '(root)') + '/', name: st.path.split('/').pop() || st.path,
        body: '', status: lit ? (vi() ? 'Agent đang làm file này' : 'Agent working on this') : (vi() ? 'Không hoạt động' : 'Idle'), live: lit,
        meta: [[vi() ? 'Thư mục' : 'Folder', st.dir], [vi() ? 'Số dòng' : 'Lines', st.lines.toLocaleString('vi')], [vi() ? 'Đuôi' : 'Ext', '.' + st.ext]] });
      tOrbitTarget.copy(st.worldPos); tDist = 20;
    }

    apiRef.current = {
      setMode: applyMode,
      focusGalaxy: (id) => { const d = GALAXIES.find((x) => x.id === id); if (d) openGalaxy(d); },
      focusFile: (path) => { const st = stars.find((x) => x.path === path); if (st) openFile(st); },
      focusDir: (dir) => { const g = dirInfo.find((x) => x.dir === dir); if (g) { tOrbitTarget.copy(g.center); tDist = Math.max(18, 6 + Math.sqrt(g.count) * 3); setSel(null); } },
      reset: () => { applyMode('uni'); tYaw = 0.2; tPitch = 0.14; setSel(null); },
    };

    // ── nhãn HTML ──
    const labelHost = labelsRef.current!;
    const mkLabel = (html: string) => { const d = document.createElement('div'); d.className = 'cosmos-lbl'; d.innerHTML = html; labelHost.appendChild(d); return d; };
    const glxLabelEls = galaxyGroups.map((gg) => ({ gg, el: mkLabel(`<b style="color:#${gg.col.getHexString()}">${gg.def.code}</b><em>${(vi() ? gg.def.tagVi : gg.def.tagEn).split(' · ')[0]}</em>`) }));
    const coreLabelEl = mkLabel(`<b style="color:#FFB347">${repoName || 'AI CORE'}</b><em>${vi() ? 'lõi tổng hợp' : 'synthesis core'}</em>`);
    const dirLabelEls = dirInfo.map((g) => ({ g, el: mkLabel(`<b style="color:#${g.color.getHexString()}">${g.dir}</b><em>${g.count}</em>`) }));

    // ── luân phiên text "đang làm" ──
    const UNI_MSG = ['Đọc CLAUDE.md…', 'Nạp memory dự án…', 'Grep repo…', 'Gọi Jira MCP…', 'Áp skill…', 'Tổng hợp ở Core…'];
    let uniPtr = 0, uniTimer = 0;

    let raf = 0; const clock = new THREE.Clock();
    let fpsAcc = 0, fpsFrames = 0, degradeTimer = 0, hudTimer = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05); const T = clock.elapsedTime;
      introT = Math.min(1, introT + dt * 0.28); // fade-in điện ảnh (Hồi 1)

      // ── FPS + auto-degrade ──
      fpsAcc += dt; fpsFrames++;
      if (fpsAcc >= 0.5) {
        const curFps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0;
        hudTimer += 0.5; if (hudTimer >= 1) { hudTimer = 0; setFps(Math.round(curFps)); }
        if (tierRef.current !== curTier) { curTier = tierRef.current; }
        else if (curFps < 48 && tierRank[curTier] > 0) {
          degradeTimer += 0.5;
          if (degradeTimer >= 1.5) {
            degradeTimer = 0;
            const order = ['lite', 'balanced', 'high', 'ultra'] as const;
            curTier = order[tierRank[curTier] - 1];
            tierRef.current = curTier; setTier(curTier);
          }
        } else degradeTimer = 0;
        bokeh.enabled = tierRank[curTier] >= tierRank.high;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, curTier === 'lite' ? 1 : curTier === 'balanced' ? 1.5 : 2));
        bgStars.p.visible = curTier !== 'lite';
      }

      reveal += ((modeState === 'repo' ? 1 : 0) - reveal) * 0.06;
      fileMat.uniforms.uReveal.value = reveal;
      const uniVis = 1 - reveal;

      // ── IDLE CINEMATIC (attract mode) ──
      idleTime += dt;
      const attract = idleTime > 20 && !runningRef.current && !queryRef.current.trim();
      if (attract !== autopilotRef.current) { autopilotRef.current = attract; setAutopilot(attract); }
      if (attract) {
        const period = 10;
        const nextPtr = Math.floor((idleTime - 20) / period);
        if (nextPtr !== idlePtr) {
          idlePtr = nextPtr;
          if (modeState === 'repo' && dirInfo.length) {
            const g = dirInfo[idlePtr % dirInfo.length];
            tOrbitTarget.copy(g.center); tDist = Math.max(20, 8 + Math.sqrt(g.count) * 3);
          } else {
            const gg = galaxyGroups[idlePtr % galaxyGroups.length];
            tOrbitTarget.copy(gg.grp.position).multiplyScalar(0.55); tDist = Math.max(70, gg.def.scale * 10);
          }
        }
        tYaw += dt * 0.05;
      }

      const distBefore = dist;
      // Camera nặng hơn v1 (k thấp hơn) → cảm giác trọng lượng khi warp.
      yaw += (tYaw - yaw) * 0.055; pitch += (tPitch - pitch) * 0.055; dist += (tDist - dist) * 0.045;
      orbitTarget.lerp(tOrbitTarget, 0.055);
      const travelSpeed = Math.abs(dist - distBefore) + orbitTarget.distanceTo(tOrbitTarget) * 0.02;
      warp += (Math.min(1, travelSpeed * 0.4) - warp) * (warp < travelSpeed ? 0.25 : 0.06);
      (bgStars.m.uniforms.uWarp as { value: number }).value = warp;
      // MOTION-BLUR khi warp (tier ultra): damp cao lúc phóng → sao & vật kéo vệt xuyên-không, tắt khi hãm.
      const wantBlur = tierRank[curTier] >= tierRank.ultra && warp > 0.08;
      afterimage.enabled = wantBlur;
      if (wantBlur) (afterimage.uniforms as { damp: { value: number } }).damp.value = Math.min(0.72, warp * 0.85);
      const driftYaw = Math.sin(T * 0.11) * 0.05 + Math.sin(T * 0.29) * 0.02;
      const driftPitch = Math.sin(T * 0.15) * 0.03;
      const px2 = yaw + driftYaw + mX * 0.08, py2 = pitch + driftPitch + mY * 0.05;
      const bob = Math.sin(T * 0.21) * 3.2;
      camera.position.x = orbitTarget.x + Math.sin(px2) * Math.cos(py2) * dist;
      camera.position.y = orbitTarget.y + Math.sin(py2) * dist + 10 + bob;
      camera.position.z = orbitTarget.z + Math.cos(px2) * Math.cos(py2) * dist;
      camera.lookAt(orbitTarget.x + Math.sin(T * 0.17) * 2, orbitTarget.y, orbitTarget.z);

      dustGroup.rotation.y += dt * 0.005; dustGroup.rotation.x = Math.sin(T * 0.07) * 0.05;
      dustLayers.forEach((p, i) => { p.rotation.z += dt * (0.008 + i * 0.004); });
      ambNeb.forEach((n) => {
        (n.s.material as THREE.SpriteMaterial).opacity = n.baseOp * (0.7 + 0.3 * Math.sin(T * 0.07 + n.ph)) * introT;
        n.s.material.rotation += n.spin * dt;
      });
      bgStars.p.rotation.y += dt * 0.002; (bgStars.m.uniforms.uTime as { value: number }).value = T;
      fileMat.uniforms.uTime.value = T;

      // ── NHIỆT galaxy (AI thinking) ──
      const hotNow = new Set(srcActiveRef.current.map(heatSource));
      // supabase MCP đang chạy → database galaxy nóng theo (suy từ mcp active + có DB).
      if (hotNow.has('mcp') && hasDb) hotNow.add('database');
      for (const d of GALAXIES) {
        const target = hotNow.has(d.id) ? 1 : 0;
        heat[d.id] += (target - heat[d.id]) * (target > heat[d.id] ? 0.12 : 0.03);
        if (hotNow.has(d.id) && !prevHot.has(d.id)) {
          const gg = galaxyGroups.find((x) => x.def.id === d.id);
          if (gg) spawnRipple(gg.grp.position, gg.col);
        }
      }
      prevHot.clear(); hotNow.forEach((id) => prevHot.add(id));
      const approvalPulse = hotNow.has('prompt') ? 0.5 + 0.5 * Math.sin(T * 7) : 0;

      // ── GALAXY: quỹ đạo quanh Core + diện mạo theo loại + nhiệt ──
      galaxyGroups.forEach((gg) => {
        const h = heat[gg.def.id];
        // Quỹ đạo Kepler xấp xỉ (đã có elevation nghiêng riêng → không đồng phẳng).
        const a = gg.orbitAng + T * gg.spin * (attract ? 1 : 0.5);
        gg.grp.position.set(
          Math.cos(a) * gg.orbitR * Math.cos(gg.orbitElev),
          Math.sin(gg.orbitElev) * gg.orbitR + Math.sin(T * 0.2 + gg.orbitAng) * 3,
          Math.sin(a) * gg.orbitR * Math.cos(gg.orbitElev),
        );
        const s = 1 + Math.sin(T * 1.5 + gg.orbitAng) * 0.07 + h * 0.5;
        gg.core.scale.setScalar(s);
        (gg.halo.material as THREE.SpriteMaterial).opacity = (0.6 + Math.sin(T * 1.8 + gg.orbitAng) * 0.15 + h * 0.7) * introT * (gg.present ? 1 : 0.32);
        const cm = gg.core.material as THREE.MeshBasicMaterial;
        if (gg.def.id === 'prompt' && approvalPulse > 0) cm.color.copy(gg.col).lerp(approvalCol, approvalPulse);
        else cm.color.copy(gg.col).lerp(new THREE.Color(0xffffff), h * 0.6);
        cm.opacity = introT * (gg.present ? 1 : 0.32);
        gg.hotMat.opacity = introT * (gg.present ? 1 : 0.32);
        // Diện mạo động theo loại
        if (gg.def.kind === 'redgiant') gg.core.scale.setScalar(s * (1 + Math.sin(T * 0.4) * 0.12)); // phồng-xẹp
        if (gg.ring) gg.ring.rotation.z += dt * (0.4 + h * 2); // wormhole xoáy
        if (gg.beam) { gg.beam.material.rotation += dt * (1.2 + h * 3); (gg.beam.material as THREE.SpriteMaterial).opacity = (0.35 + 0.35 * Math.abs(Math.sin(T * (2 + h * 4)))) * introT; } // pulsar quét
        gg.grp.rotation.y += dt * (0.06 + h * 0.2); // cụm/vành đai/tinh vân xoay
      });

      // ── RIPPLE ──
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i]; r.t += dt * 0.7;
        r.s.scale.setScalar(2 + r.t * 60);
        (r.s.material as THREE.SpriteMaterial).opacity = Math.max(0, 0.5 * (1 - r.t)) * introT;
        if (r.t >= 1) { scene.remove(r.s); (r.s.material as THREE.Material).dispose(); ripples.splice(i, 1); }
      }

      // ── HỐ ĐEN: hiện khi có step 'error' đang active (lỗi thật), tan khi hết. ──
      const hasError = stepsRef.current.some((s) => s.type === 'error' && s.active !== false);
      bhLife += ((hasError ? 1 : 0) - bhLife) * (hasError ? 0.06 : 0.02); // nở chậm, tan chậm hơn
      blackHoleGrp.visible = bhLife > 0.01;
      if (blackHoleGrp.visible) {
        blackHoleGrp.scale.setScalar(bhLife * uniVis);
        bhDisk.rotation.z += dt * 1.4; // đĩa bồi tụ xoáy
        (bhDisk.material as THREE.MeshBasicMaterial).opacity = (0.5 + 0.3 * Math.sin(T * 4)) * bhLife * uniVis;
        (bhLens.material as THREE.SpriteMaterial).opacity = 0.28 * bhLife * uniVis;
        bhVoid.scale.setScalar(1 + Math.sin(T * 2) * 0.08); // "thở" tối
      }

      // ── ENERGY STREAM: hạt chạy dọc đường cong về Core; sáng theo nhiệt (data-flow §5) ──
      streams.forEach((s) => {
        const h = heat[s.id] || 0;
        const gg = galaxyGroups.find((x) => x.def.id === s.id)!;
        const gp = gg.grp.position;
        // Điểm đầu & điểm uốn giữa BÁM theo galaxy đang quay quanh Core (không cấp phát vector mới).
        s.curve.points[0].copy(gp);
        const gpLen = gp.length();
        s.curve.points[1].set(gp.x * 0.5 - gp.z * 0.3, gp.y * 0.5 + gpLen * 0.18, gp.z * 0.5 + gp.x * 0.3);
        // REBUILD đường cong nền từ curve đã cập nhật (diệt "đường ma" khi galaxy di chuyển).
        for (let i = 0; i < s.LN; i++) { s.curve.getPoint(i / (s.LN - 1), tmpV); s.lpos[i * 3] = tmpV.x; s.lpos[i * 3 + 1] = tmpV.y; s.lpos[i * 3 + 2] = tmpV.z; }
        s.lineGeo.attributes.position.needsUpdate = true;
        const speed = 0.35 + h * 1.3;
        const arr = s.p.geometry.attributes.position.array as Float32Array;
        for (let i = 0; i < s.n; i++) {
          s.ts[i] += dt * speed; if (s.ts[i] > 1) s.ts[i] -= 1;
          s.curve.getPoint(s.ts[i], tmpV);
          arr[i * 3] = tmpV.x; arr[i * 3 + 1] = tmpV.y; arr[i * 3 + 2] = tmpV.z;
        }
        s.p.geometry.attributes.position.needsUpdate = true;
        s.m.opacity = (0.22 + h * 0.65) * uniVis * introT; // idle vẫn THẤY được mạng lưới, nóng thì rực
        s.m.size = 1.5 + h * 2.2;
        s.lineMat.opacity = (0.09 + h * 0.24) * uniVis * introT;
      });

      // ── AI CORE: thở + tổng hợp ──
      let heatSum = 0; for (const d of GALAXIES) heatSum += heat[d.id];
      const coreHeat = Math.min(1, heatSum * 0.4);
      coronaMat.uniforms.uTime.value = T; coronaMat.uniforms.uHeat.value = coreHeat;
      const breathe = 1 + Math.sin(T * 0.8) * 0.05 + coreHeat * 0.18;
      coreGrp.scale.setScalar(introT * (uniVis * breathe + reveal * 0.12)); // lặn repo → Core co nhỏ, để file bung ra
      coreHot.scale.setScalar(1 + Math.sin(T * 2.5) * 0.1 + coreHeat * 0.2);
      corona.rotation.y += dt * (0.05 + coreHeat * 0.2); corona.rotation.x = Math.sin(T * 0.3) * 0.1;
      coreHalos.forEach((h, i) => { (h.material as THREE.SpriteMaterial).opacity = ((i === 0 ? 0.5 : i === 1 ? 0.26 : 0.12) + Math.sin(T * 1.5 + i) * 0.05 + coreHeat * 0.3) * introT; });
      coreRings.forEach((r) => { r.m.rotation.z += dt * r.sp * (1 + coreHeat * 1.5); (r.m.material as THREE.MeshBasicMaterial).opacity = (0.32 + coreHeat * 0.4) * introT; });
      const godVis = tierRank[curTier] >= tierRank.high ? introT : 0;
      godRays.forEach((g, i) => { g.material.rotation += dt * 0.06 * (i % 2 ? 1 : -1);
        (g.material as THREE.SpriteMaterial).opacity = (0.08 + coreHeat * 0.22 + Math.sin(T * 0.5 + i) * 0.02) * godVis; });

      dirInfo.forEach((g) => { (g.halo!.material as THREE.SpriteMaterial).opacity = (0.09 + 0.03 * Math.sin(T * 0.5 + g.center.x)) * reveal; });

      // ── highlight file THẬT từ activeFiles ──
      for (let i = 0; i < total; i++) litVal[i] *= 0.94;
      const act = activeRef.current;
      let liveFileName = '';
      if (act.length) {
        for (const p of act) { const i = idxByPath.get(p); if (i != null) { litVal[i] = 1; liveFileName = p.split('/').pop() || p; } }
      }
      const q = queryRef.current.trim().toLowerCase();
      if (q) {
        const matched: typeof stars[number][] = [];
        for (const st of stars) if (st.path.toLowerCase().includes(q)) { litVal[st.i] = Math.max(litVal[st.i], 0.9); matched.push(st); }
        if (q !== prevQuery && matched.length === 1) { tOrbitTarget.copy(matched[0].worldPos); tDist = 20; if (modeState === 'uni') applyMode('repo'); }
      }
      prevQuery = q;
      const litAttr = fileGeo.attributes.aLit.array as Float32Array;
      for (let i = 0; i < total; i++) {
        const vw = reveal > 0.3 ? (visitWeight[stars[i].path] || 0) * 0.32 : 0;
        litAttr[i] = Math.max(litVal[i], vw);
      }
      fileGeo.attributes.aLit.needsUpdate = true;

      if (runningRef.current) {
        if (liveFileName) setLive((vi() ? 'Agent đang làm: ' : 'Working on: ') + liveFileName);
        else { uniTimer += dt; if (uniTimer > 1.6) { uniTimer = 0; uniPtr = (uniPtr + 1) % UNI_MSG.length; } setLive(UNI_MSG[uniPtr]); }
      } else setLive(vi() ? 'Không có agent hoạt động' : 'Agent idle');

      bloom.strength = 0.82 + uniVis * 0.14 + coreHeat * 0.2;
      if (bokeh.enabled) {
        const focusDist = camera.position.distanceTo(orbitTarget);
        const u = (bokeh as unknown as { uniforms: Record<string, { value: number }> }).uniforms;
        if (u?.focus) u.focus.value += (focusDist - u.focus.value) * 0.1;
      }
      composer.render();

      // ── nhãn (LOD: ẩn khi quá xa + CHỐNG CHỒNG — nhãn gần hơn thắng, nhãn bị đè ẩn đi) ──
      const rBox = el.getBoundingClientRect();
      const setLxy = (d: HTMLElement, sx: number, sy: number, op: number) => { d.style.left = (sx - rBox.left) + 'px'; d.style.top = (sy - rBox.top) + 'px'; d.style.opacity = String(op); };
      // Core luôn hiện (là mốc). Ghi vị trí đã chiếm để galaxy tránh đè.
      const claimed: { x: number; y: number }[] = [];
      const cs = screenOf(CORE);
      if (!cs.behind) { setLxy(coreLabelEl, cs.x, cs.y - 46, uniVis * introT * 0.95); claimed.push({ x: cs.x, y: cs.y - 46 }); }
      else coreLabelEl.style.opacity = '0';
      // Galaxy: gần camera trước → được ưu tiên chỗ; galaxy chiếu sát nhãn đã chiếm (<64px) thì ẩn.
      const ordered = glxLabelEls.map((e) => ({ e, dc: camera.position.distanceTo(e.gg.grp.position) })).sort((a, b) => a.dc - b.dc);
      for (const { e, dc } of ordered) {
        const s = screenOf(e.gg.grp.position); const sy = s.y - 18;
        let op = s.behind || dc > 380 ? 0 : uniVis * introT * 0.95 * (e.gg.present ? 1 : 0.5);
        if (op > 0.02) { for (const c of claimed) { if (Math.abs(s.x - c.x) < 64 && Math.abs(sy - c.y) < 26) { op = 0; break; } } }
        if (op > 0.02) claimed.push({ x: s.x, y: sy });
        setLxy(e.el, s.x, sy, op);
      }
      const showDir = reveal > 0.5 && dist > 26;
      dirLabelEls.forEach(({ g, el: d }) => { const s = screenOf(g.center); setLxy(d, s.x, s.y, s.behind ? 0 : (showDir ? reveal * 0.9 : 0)); });

      const raH = ((Math.floor((yaw / Math.PI + 1) * 12)) % 24 + 24) % 24, raM = Math.floor(Math.abs(yaw * 120) % 60), dec = Math.round(-pitch * 60);
      setCoords({ ra: `RA ${String(raH).padStart(2, '0')}ʰ${String(raM).padStart(2, '0')}ᵐ · DEC ${dec >= 0 ? '+' : '−'}${Math.abs(dec)}°`, zoom: `×${(300 / dist).toFixed(1)}` });
    };
    loop();

    const onResize = () => {
      const w = mount.clientWidth || window.innerWidth, h = mount.clientHeight || window.innerHeight;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setSize(w, h); composer.setSize(w, h); bloom.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      el.removeEventListener('mousedown', onDown); window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mousemove', onMove); el.removeEventListener('wheel', onWheel); el.removeEventListener('click', onClick); el.removeEventListener('dblclick', onDbl);
      apiRef.current = null;
      labelHost.innerHTML = '';
      renderer.dispose();
      scene.traverse((o) => {
        const any = o as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
        any.geometry?.dispose?.();
        const m = any.material; if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose?.();
      });
      glowTex.dispose(); starTex.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filetree, theme, repoName]);

  const t = (vi: string, en: string) => (language === 'vi' ? vi : en);

  return (
    <div className="cosmos-overlay">
      <div ref={mountRef} className="cosmos-canvas-host" />
      <div ref={labelsRef} className="cosmos-labels" />

      <span className="cosmos-corner tl" /><span className="cosmos-corner tr" />
      <span className="cosmos-corner bl" /><span className="cosmos-corner br" />

      <div className="cosmos-hud-title">
        <h1>Cosmos</h1>
        <div className="cosmos-sub">{mode === 'uni' ? t('Ý thức sống của AI', 'The AI’s living mind') : t('Bản đồ codebase · mỗi file một ngôi sao', 'Codebase map · one star per file')}</div>
        <div className="cosmos-live"><b />{live}</div>
      </div>

      <div className="cosmos-modebar">
        <button className={mode === 'uni' ? 'on' : ''} onClick={() => apiRef.current?.setMode('uni')}>{t('Vũ trụ', 'Universe')}</button>
        <button className={mode === 'repo' ? 'on' : ''} onClick={() => apiRef.current?.setMode('repo')}>{t('Bản đồ code', 'Codebase')}</button>
      </div>

      {/* Search chỉ hữu ích ở repo-mode (tìm file) — ẩn ở uni để không che vũ trụ. */}
      {mode === 'repo' && (
        <div className="cosmos-search">
          <Icon name="target" size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={t('tìm file… (vd runner.ts)', 'find file… (e.g. runner.ts)')} spellCheck={false} autoFocus />
          {query && <button onClick={() => setQuery('')} aria-label={t('Xoá', 'Clear')}><Icon name="close" size={12} /></button>}
        </div>
      )}

      <div className="cosmos-coords"><div>{coords.ra}</div><div className="zoom">{coords.zoom}</div><div className="now">{totalFiles} file · {dirCount} {t('thư mục', 'folders')}</div></div>

      <button className="cosmos-tier" title={t('Bấm để đổi mức đồ hoạ (tự hạ khi tụt FPS)', 'Click to change quality (auto-lowers on FPS drop)')}
        onClick={() => { const order = ['lite', 'balanced', 'high', 'ultra'] as const; setTier((cur) => order[(order.indexOf(cur) + 1) % 4]); }}>
        <span className={`cosmos-tier-lv t-${tier}`}>{tier.toUpperCase()}</span>
        <span className="cosmos-tier-fps">{fps} FPS</span>
      </button>

      {autopilot && <div className="cosmos-autopilot">{t('◆ TỰ HÀNH — di chuột để điều khiển', '◆ AUTO-PILOT — move to take control')}</div>}

      <button className="cosmos-close" onClick={onClose} title={t('Đóng (ESC)', 'Close (ESC)')}><Icon name="close" size={18} /></button>
      <button className="cosmos-reset" onClick={() => apiRef.current?.reset()} title={t('Về toàn cảnh', 'Reset view')}><Icon name="refresh" size={14} /></button>

      <div className="cosmos-hint">{mode === 'repo'
        ? t('Kéo xoay · cuộn phóng · bấm sao để mở file · sao sáng = file đang làm', 'Drag · scroll · click a star for its file · bright = active')
        : t('Kéo xoay · cuộn phóng · bấm thiên hà để xem · cuộn vào Core để LẶN vào codebase', 'Drag · scroll · click a galaxy · zoom into the Core to dive in')}</div>

      {sel && (
        <aside className="cosmos-inspector">
          <button className="cosmos-insp-close" onClick={() => setSel(null)}><Icon name="close" size={16} /></button>
          <div className="cosmos-insp-tag">{sel.tag}</div>
          <h2 className="cosmos-insp-name">{sel.name}</h2>
          <div className={`cosmos-insp-status${sel.live ? ' live' : ''}`}><b />{sel.status}</div>
          {sel.body && <div className="cosmos-insp-body" dangerouslySetInnerHTML={{ __html: sel.body }} />}
          {sel.meta.length > 0 && (
            <div className="cosmos-insp-meta">
              {sel.meta.map(([k, v]) => (<div key={k} className="cosmos-insp-row"><span>{k}</span><span>{v}</span></div>))}
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
