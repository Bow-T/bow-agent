import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';
import type { BrainStep } from './NeuralBrain.js';
import { apiFetch } from './App.js';
import { Icon } from './Icon.js';
import { SYSTEMS, type SystemDef } from './cosmosSystems.js';

/**
 * COSMOS v3 — "Interstellar". KHÔNG phải hệ Mặt Trời, KHÔNG node graph. Đây là một VŨ TRỤ khổng lồ
 * mà người dùng LÁI PHI THUYỀN bay xuyên qua để khám phá kiến trúc & ý thức của một AI agent.
 *
 * Khác biệt cốt lõi so với v2 (đã bị bác vì "giống solar-system"):
 *  1. KHÔNG có Mặt Trời trung tâm áp đảo. MONOREPO chỉ là trường hấp dẫn mờ, gần như vô hình.
 *  2. Camera là PHI THUYỀN free-fly 6-DOF có quán tính (không còn orbit-quanh-tâm). Cuộn = thrust
 *     tiến/lùi dọc trục nhìn; bay hàng nghìn đơn vị xuyên không gian; warp streak khi tăng tốc.
 *  3. 9 hệ là 9 HIỆN TƯỢNG khác nhau (nebula/energy-field/wormhole/star/pulsar/cluster/belt/beacon/
 *     satellites) đặt tại toạ độ (x,y,z) CỐ ĐỊNH bất đối xứng ở nhiều tầng độ sâu (500u→6000u).
 *  4. 6 tầng LOD LIÊN TỤC theo khoảng-cách-camera: UNIVERSE→SYSTEM→MODULE→FILE→FUNCTION→CODE.
 *     Thông tin LỘ DẦN khi bay tới gần — xa chỉ thấy ánh sáng, gần mới thấy file/hàm/source thật.
 *  5. Data-flow là HẠT chảy trong không gian (không vẽ đường A—B). Vũ trụ phản ứng theo AI activity.
 *
 * Sinh từ DỮ LIỆU THẬT: filetree (git ls-files + line-count) → thiên thể trong hệ; activeSources →
 * hệ nào "thức"; activeFiles → file nào pulse; skillList/mcpList → vệ tinh & wormhole thật; tầng
 * FUNCTION/CODE fetch /api/file-symbols + /api/file-source lazy khi bay đủ gần.
 *
 * Giữ từ v2 (xương đã chứng minh): render loop, EffectComposer, auto-degrade tier, dispose sạch.
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
  activeFiles: string[];
  activeSources: string[];
  skillList: string[];
  mcpList: string[];
  repoName: string;
  theme: 'light' | 'dark';
  language: 'vi' | 'en';
  onClose: () => void;
}

/** Nguồn (từ TaskPane) → hệ để "nóng" đúng chỗ. claudemd = đọc repo → coi như MODULE code (dùng 'code'). */
const SOURCE_TO_SYSTEM: Record<string, string> = {
  brain: 'brain', prompt: 'prompt', memory: 'memory', mcp: 'mcp', web: 'web',
  skills: 'tools', claudemd: 'code',
};

const DIR_HUE: Record<string, number> = {
  src: 0.55, web: 0.09, docs: 0.30, '.claude': 0.79, '(root)': 0.60,
  scripts: 0.14, '.github': 0.42, '.vscode': 0.5, examples: 0.90, '.agents': 0.83,
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

/** Hệ nào nuốt top-dir này? Ưu tiên khai báo dirs; còn lại rơi vào 'code' (vùng MODULE quanh gốc). */
function systemForDir(dir: string): string {
  for (const s of SYSTEMS) if (s.dirs.includes(dir)) return s.id;
  if (dir === 'node_modules') return 'packages';
  return 'code';
}

export function CosmosOverlay({ steps, running, filetree, activeFiles, activeSources, skillList, mcpList, repoName, theme, language, onClose }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const labelsRef = useRef<HTMLDivElement | null>(null);
  const [tier, setTier] = useState<'ultra' | 'high' | 'balanced' | 'lite'>('high');
  const [fps, setFps] = useState(60);
  const [query, setQuery] = useState('');
  const [live, setLive] = useState('');
  const [depth, setDepth] = useState<'universe' | 'system' | 'module' | 'file' | 'function' | 'code'>('universe');
  const [autopilot, setAutopilot] = useState(false);
  const [sel, setSel] = useState<{ tag: string; name: string; body: string; status: string; live: boolean; meta: [string, string][] } | null>(null);
  const [codePanel, setCodePanel] = useState<{ path: string; lines: string[]; truncated?: boolean } | null>(null);
  const [coords, setCoords] = useState({ ra: '', zoom: '' });

  const totalFiles = filetree.length || 1;

  const apiRef = useRef<{ focusSystem: (id: string) => void; focusFile: (path: string) => void; reset: () => void } | null>(null);
  // props → ref để render-loop đọc mà không re-run effect nặng.
  const activeRef = useRef(activeFiles); activeRef.current = activeFiles;
  const srcActiveRef = useRef(activeSources); srcActiveRef.current = activeSources;
  const skillListRef = useRef(skillList); skillListRef.current = skillList;
  const mcpListRef = useRef(mcpList); mcpListRef.current = mcpList;
  const tierRef = useRef(tier); tierRef.current = tier;
  const queryRef = useRef(query); queryRef.current = query;
  const runningRef = useRef(running); runningRef.current = running;
  const langRef = useRef(language); langRef.current = language;
  const stepsRef = useRef(steps); stepsRef.current = steps;

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
    // Fog cực loãng + far xa → hệ ở rất xa mờ dần, "chỉ còn là ánh sáng". Đây là chìa khoá của SCALE.
    scene.fog = new THREE.FogExp2(0x02030a, 0.000055);
    const camera = new THREE.PerspectiveCamera(62, W0 / H0, 0.5, 40000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W0, H0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = theme === 'light' ? 1.0 : 1.06;
    renderer.setClearColor(0x02030a, 1);
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
    // Bloom KIỀM CHẾ (yêu cầu "controlled bloom, dark blacks"): threshold cao 0.88, strength thấp 0.5,
    // radius vừa. Chỉ vật RẤT sáng mới loang; phần lớn vũ trụ tối. Đây là điểm khác lớn so với v2.
    const bloom = new UnrealBloomPass(new THREE.Vector2(W0, H0), 0.5, 0.7, 0.88);
    composer.addPass(bloom);
    // Motion-blur chỉ khi warp mạnh (tier ultra) → cảm giác xuyên-không, tắt khi bay chậm.
    const afterimage = new AfterimagePass(0);
    afterimage.enabled = false;
    composer.addPass(afterimage);

    // ── textures dùng chung ──
    const mkGlow = (inner: number, mid: number) => {
      const s = 128; const c = document.createElement('canvas'); c.width = c.height = s;
      const g = c.getContext('2d')!;
      const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(inner, 'rgba(255,255,255,0.6)');
      gr.addColorStop(mid, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, s, s);
      return new THREE.CanvasTexture(c);
    };
    const glowTex = mkGlow(0.25, 0.5);   // quầng mềm
    const starTex = mkGlow(0.12, 0.4);   // điểm sắc
    const px = renderer.getPixelRatio();
    const tmpV = new THREE.Vector3();
    const tmpV2 = new THREE.Vector3();

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // BỐI CẢNH — 6 TẦNG ĐỘ SÂU (parallax). Yêu cầu: perceive depth from parallax, elegant & cinematic.
    //   T1 sao xa cực nhỏ (nhiều, gần như tĩnh) · T2 sao trung · T3 bụi (parallax nhanh theo camera)
    //   T4 nebula clouds xa · T5 hạt gần (streak khi warp) · T6 = celestial objects (dựng riêng bên dưới)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Số lượng theo tier (giữ 60fps): ultra dày nhất.
    const starN = curTier === 'ultra' ? 90000 : curTier === 'high' ? 55000 : curTier === 'balanced' ? 26000 : 9000;

    // T1+T2: một point cloud shell KHỔNG LỒ (r 8000..30000). Kích thước & màu biến thiên → cảm giác 2 tầng.
    const makeStarShell = (count: number, rMin: number, rMax: number, seed: number, base: THREE.Color) => {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(count * 3); const sz = new Float32Array(count); const col = new Float32Array(count * 3);
      const R = rng(seed);
      for (let i = 0; i < count; i++) {
        const u = R(), v = R(), th = u * 6.283, ph = Math.acos(2 * v - 1);
        const r = rMin + (rMax - rMin) * Math.cbrt(R());
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
        pos[i * 3 + 2] = r * Math.cos(ph);
        sz[i] = 0.6 + Math.pow(R(), 3) * 5;   // 75% nhỏ, ít cái to → visual hierarchy trong nền
        // đa số trắng-xanh lạnh, thi thoảng ngả ấm → tự nhiên hơn.
        const warm = R() > 0.92;
        const c = warm ? new THREE.Color(0xffd9a8) : base.clone().offsetHSL(0, 0, (R() - 0.5) * 0.15);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const m = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: starTex }, uTime: { value: 0 }, uPix: { value: px } },
        vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: `attribute float aSize; varying float vTw; varying vec3 vC; uniform float uTime,uPix;
          void main(){ vC=color; vTw=0.55+0.45*sin(uTime*0.8+position.x*0.02+position.y*0.013);
            vec4 mv=modelViewMatrix*vec4(position,1.0);
            gl_PointSize=aSize*uPix*(900.0/-mv.z); gl_Position=projectionMatrix*mv; }`,
        fragmentShader: `uniform sampler2D uTex; varying float vTw; varying vec3 vC;
          void main(){ vec4 t=texture2D(uTex,gl_PointCoord); gl_FragColor=vec4(vC,t.a*(0.45+vTw*0.55)); }`,
      });
      const p = new THREE.Points(g, m); p.frustumCulled = false; scene.add(p); return { p, m };
    };
    const starShell = makeStarShell(starN, 8000, 30000, 7, new THREE.Color(0xaebbe6));

    // T3: bụi gần camera (đi theo camera → parallax mạnh). Shell nhỏ tái định tâm quanh camera mỗi frame.
    const dustN = curTier === 'lite' ? 400 : 1600;
    const dust = (() => {
      const g = new THREE.BufferGeometry(); const pos = new Float32Array(dustN * 3); const R = rng(31);
      for (let i = 0; i < dustN; i++) {
        const u = R(), v = R(), th = u * 6.283, ph = Math.acos(2 * v - 1); const r = 200 + R() * 900;
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th); pos[i * 3 + 2] = r * Math.cos(ph);
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const m = new THREE.PointsMaterial({ map: starTex, color: 0x9fb0d8, size: 2.4, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
      const p = new THREE.Points(g, m); p.frustumCulled = false; scene.add(p); return p;
    })();

    // T4: nebula clouds XA (nhuốm màu chiều sâu, không noisy). Vài sprite lớn mờ, rải khắp.
    const ambNeb: { s: THREE.Sprite; baseOp: number; ph: number; spin: number }[] = [];
    ([[0x4a2f8a, 0.05, 5200, -1400, 3200, -9000], [0x243f8e, 0.045, 4600, 3000, -1200, -12000],
      [0x6a2f5e, 0.04, 4200, -3200, -2400, -8000], [0x1f5a5e, 0.035, 4800, 4200, 1800, 6000],
      [0x3a2f7a, 0.03, 5600, -5000, 800, 3000]] as const)
      .forEach(([hex, op, sc, x, y, z]) => {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: hex, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false }));
        s.position.set(x, y, z); s.scale.setScalar(sc);
        scene.add(s); ambNeb.push({ s, baseOp: op, ph: Math.random() * 6.28, spin: (Math.random() - 0.5) * 0.01 });
      });

    // T5: hạt gần streak khi warp — dùng chung starShell (uWarp trong shader), thêm vài hạt sát camera.
    // (giữ nhẹ; streak chủ đạo từ afterimage + dust parallax.)

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // TRƯỜNG HẤP DẪN TRUNG TÂM (MONOREPO) — RẤT MỜ, gần như vô hình. KHÔNG phải Mặt Trời.
    //   Chỉ một quầng lớn cực loãng + vài vòng bụi thưa quanh gốc → gợi ý "vũ trụ có trọng tâm"
    //   mà KHÔNG áp đảo. Đây thay cho AI CORE khổng lồ của v2 (đã gỡ theo yêu cầu).
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const gravGrp = new THREE.Group(); scene.add(gravGrp);
    const gravHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x3a4a7a, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false }));
    gravHalo.scale.setScalar(2600); gravGrp.add(gravHalo);
    // vòng bụi thưa quanh gốc (rất mờ) — chỉ để mắt bắt được "có gì đó ở tâm".
    const gravDust = (() => {
      const n = 900; const g = new THREE.BufferGeometry(); const pos = new Float32Array(n * 3); const R = rng(5);
      for (let i = 0; i < n; i++) { const th = R() * 6.283, r = 300 + R() * 1500; pos[i * 3] = Math.cos(th) * r; pos[i * 3 + 1] = (R() - 0.5) * 300; pos[i * 3 + 2] = Math.sin(th) * r; }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const m = new THREE.PointsMaterial({ map: starTex, color: 0x5566aa, size: 3, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
      const p = new THREE.Points(g, m); gravGrp.add(p); return p;
    })();

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // 9 HIỆN TƯỢNG — dựng tại pos cố định. Mỗi hệ một Group + hàm dựng riêng theo kind.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const mcpLower = mcpList.map((m) => m.toLowerCase()).join(' ');
    const hasDb = /supabase|postgres|mysql|sql/.test(mcpLower);

    interface SystemObj {
      def: SystemDef; grp: THREE.Group; col: THREE.Color; pos: THREE.Vector3; present: boolean;
      core?: THREE.Mesh; halo: THREE.Sprite; aura: THREE.Sprite;
      ring?: THREE.Mesh; beam?: THREE.Sprite; cloud?: THREE.Points; extras: THREE.Object3D[];
      // file container (lazy — chỉ dựng khi bay đủ gần, LOD MODULE/FILE)
      files: FileEntry[]; fileBuilt: boolean; filePoints?: THREE.Points;
      fileStars: { path: string; lines: number; worldPos: THREE.Vector3; i: number }[];
      fileGeo?: THREE.BufferGeometry;
    }
    const systems: SystemObj[] = [];

    // gom file THẬT vào từng hệ theo top-dir.
    const filesBySys = new Map<string, FileEntry[]>();
    for (const s of SYSTEMS) filesBySys.set(s.id, []);
    filesBySys.set('code', []); // hệ 'code' ảo (module quanh gốc) sẽ xử lý riêng bên dưới
    for (const f of (filetree.length ? filetree : [])) {
      const sid = systemForDir(topDir(f.path));
      if (!filesBySys.has(sid)) filesBySys.set(sid, []);
      filesBySys.get(sid)!.push(f);
    }

    const present = (id: string) => (id === 'database' ? hasDb : true);

    SYSTEMS.forEach((def) => {
      const col = new THREE.Color().setHSL(def.hue, def.kind === 'cluster' ? 0.85 : 0.62, def.kind === 'pulsar' ? 0.85 : 0.58);
      const grp = new THREE.Group();
      grp.position.set(def.pos[0], def.pos[1], def.pos[2]);
      scene.add(grp);
      const pos = grp.position.clone();
      const isPresent = present(def.id);
      const dim = isPresent ? 1 : 0.28;
      const extras: THREE.Object3D[] = [];

      // Quầng + aura chung (mọi hệ có — là "ánh sáng nhìn từ xa" ở LOD UNIVERSE).
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, opacity: 0.85 * dim, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo.scale.setScalar(def.radius * 1.8);
      const aura = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, opacity: 0.14 * dim, blending: THREE.AdditiveBlending, depthWrite: false }));
      aura.scale.setScalar(def.radius * 4.2);
      grp.add(aura, halo);

      let core: THREE.Mesh | undefined, ring: THREE.Mesh | undefined, beam: THREE.Sprite | undefined, cloud: THREE.Points | undefined;

      const seed = hashCode(def.id) || 1;
      const R = rng(seed);
      const pointCloud = (n: number, spread: (i: number) => [number, number, number], size: number, c: THREE.Color) => {
        const g = new THREE.BufferGeometry(); const p = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { const [x, y, z] = spread(i); p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z; }
        g.setAttribute('position', new THREE.BufferAttribute(p, 3));
        const m = new THREE.PointsMaterial({ map: starTex, color: c, size, transparent: true, opacity: 0.85 * dim, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
        return new THREE.Points(g, m);
      };

      if (def.kind === 'nebula') {
        // Tinh vân: hàng nghìn hạt phồng + vài lớp khói.
        const n = curTier === 'lite' ? 800 : curTier === 'balanced' ? 2000 : 4000;
        cloud = pointCloud(n, () => {
          const u = R(), v = R(), th = u * 6.283, ph = Math.acos(2 * v - 1), r = def.radius * (0.15 + 0.85 * Math.cbrt(R()));
          return [r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th) * 0.7, r * Math.cos(ph)];
        }, 5, col);
        grp.add(cloud); extras.push(cloud);
        for (let k = 0; k < 5; k++) {
          const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, opacity: 0.06 * dim, blending: THREE.AdditiveBlending, depthWrite: false }));
          s.position.set((R() - 0.5) * def.radius, (R() - 0.5) * def.radius * 0.6, (R() - 0.5) * def.radius);
          s.scale.setScalar(def.radius * (1 + k * 0.5)); grp.add(s); extras.push(s);
        }
      } else if (def.kind === 'energy') {
        // Trường năng lượng: đĩa shader flow-noise + hạt cuộn.
        const mat = new THREE.ShaderMaterial({
          uniforms: { uTime: { value: 0 }, uCol: { value: col }, uHeat: { value: 0 } },
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
          vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
          fragmentShader: `varying vec2 vUv; uniform float uTime,uHeat; uniform vec3 uCol;
            float h(vec2 p){ return fract(sin(dot(p,vec2(27.1,57.7)))*43758.5); }
            float n(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
              return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
            void main(){ vec2 uv=(vUv-0.5)*4.0; float d=length(uv);
              float t=uTime*(0.4+uHeat*0.8);
              float flow=n(uv*1.5+vec2(t,-t*0.6))*0.6+n(uv*3.0-vec2(t*0.4))*0.4;
              float a=smoothstep(2.0,0.0,d)*(0.25+0.5*flow)*(0.6+uHeat*0.6);
              gl_FragColor=vec4(uCol*(1.2+uHeat),a); }`,
        });
        const disk = new THREE.Mesh(new THREE.PlaneGeometry(def.radius * 3, def.radius * 3), mat);
        grp.add(disk); extras.push(disk);
        core = disk as unknown as THREE.Mesh;
      } else if (def.kind === 'wormhole') {
        // Wormhole: torus + xoáy hạt bị hút vào.
        const torus = new THREE.Mesh(new THREE.TorusGeometry(def.radius * 0.7, def.radius * 0.06, 24, 120),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7 * dim, blending: THREE.AdditiveBlending, depthWrite: false }));
        grp.add(torus); extras.push(torus); ring = torus;
        cloud = pointCloud(600, () => { const th = R() * 6.283, r = def.radius * (0.3 + R() * 0.6); return [Math.cos(th) * r, (R() - 0.5) * def.radius * 0.15, Math.sin(th) * r]; }, 4, col);
        grp.add(cloud); extras.push(cloud);
      } else if (def.kind === 'star') {
        // Sao vàng: nhân + corona shader plasma (giống v2 nhưng đặt ở XA, không phải tâm).
        const hot = new THREE.Mesh(new THREE.SphereGeometry(def.radius * 0.5, 32, 32), new THREE.MeshBasicMaterial({ color: 0xfff2d0 }));
        const coronaMat = new THREE.ShaderMaterial({
          uniforms: { uTime: { value: 0 }, uHeat: { value: 0 } },
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          vertexShader: `varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
          fragmentShader: `varying vec3 vP; uniform float uTime,uHeat;
            float hash(vec3 p){ return fract(sin(dot(p,vec3(27.1,57.7,113.5)))*43758.5); }
            float noise(vec3 p){ vec3 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
              return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                         mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
            void main(){ vec3 p=normalize(vP)*3.0; float t=uTime*(0.2+uHeat*0.5);
              float nn=noise(p+vec3(t,t*0.7,-t))*0.6+noise(p*2.4-vec3(t*0.5))*0.4;
              vec3 amber=vec3(1.0,0.62,0.2),hot2=vec3(1.0,0.92,0.72);
              vec3 col2=mix(amber,hot2,smoothstep(0.4,0.9,nn)+uHeat*0.4);
              gl_FragColor=vec4(col2,(0.6+0.4*nn)); }`,
        });
        const corona = new THREE.Mesh(new THREE.SphereGeometry(def.radius * 0.85, 48, 48), coronaMat);
        grp.add(hot, corona); extras.push(hot, corona); core = corona;
      } else if (def.kind === 'pulsar') {
        const sph = new THREE.Mesh(new THREE.SphereGeometry(def.radius * 0.32, 24, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: dim }));
        grp.add(sph); extras.push(sph); core = sph;
        beam = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xdfefff, transparent: true, opacity: 0.55 * dim, blending: THREE.AdditiveBlending, depthWrite: false }));
        beam.scale.set(def.radius * 0.5, def.radius * 5, 1); grp.add(beam); extras.push(beam);
        const rg = new THREE.Mesh(new THREE.RingGeometry(def.radius * 0.6, def.radius * 0.66, 96),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.45 * dim, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
        rg.rotation.x = Math.PI / 2.6; grp.add(rg); extras.push(rg); ring = rg;
      } else if (def.kind === 'cluster') {
        const n = curTier === 'lite' ? 200 : 700;
        cloud = pointCloud(n, () => {
          const u = R(), v = R(), th = u * 6.283, ph = Math.acos(2 * v - 1), r = def.radius * (0.2 + 0.8 * Math.cbrt(R()));
          return [r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph)];
        }, 4, col);
        grp.add(cloud); extras.push(cloud);
      } else if (def.kind === 'belt') {
        // Vành đai thiên thạch: InstancedMesh khối nhỏ (GPU instancing → nhẹ dù vài nghìn).
        const n = curTier === 'lite' ? 300 : curTier === 'balanced' ? 1200 : 2600;
        const geo = new THREE.IcosahedronGeometry(3, 0);
        const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9 * dim });
        const inst = new THREE.InstancedMesh(geo, mat, n);
        const dummy = new THREE.Object3D();
        for (let i = 0; i < n; i++) {
          const th = R() * 6.283, r = def.radius * (0.65 + R() * 0.5), yy = (R() - 0.5) * def.radius * 0.12;
          dummy.position.set(Math.cos(th) * r, yy, Math.sin(th) * r);
          const sc = 0.5 + R() * 2.4; dummy.scale.setScalar(sc);
          dummy.rotation.set(R() * 6.28, R() * 6.28, R() * 6.28); dummy.updateMatrix();
          inst.setMatrixAt(i, dummy.matrix);
        }
        grp.add(inst); extras.push(inst);
      } else if (def.kind === 'satellites') {
        // Vệ tinh: mỗi skill thật một khối nhỏ quanh tâm chung.
        const hub = new THREE.Mesh(new THREE.SphereGeometry(def.radius * 0.14, 16, 16), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9 * dim }));
        grp.add(hub); extras.push(hub); core = hub;
        const count = Math.max(6, Math.min(24, skillList.length || 8));
        for (let i = 0; i < count; i++) {
          const th = (i / count) * 6.283 + R(), r = def.radius * (0.5 + R() * 0.5), el = (R() - 0.5) * def.radius * 0.5;
          const s = new THREE.Mesh(new THREE.OctahedronGeometry(def.radius * 0.05, 0), new THREE.MeshBasicMaterial({ color: 0xdfffe8, transparent: true, opacity: 0.9 * dim }));
          s.position.set(Math.cos(th) * r, el, Math.sin(th) * r); s.userData.orbit = { th, r, el, sp: 0.2 + R() * 0.4 };
          grp.add(s); extras.push(s);
        }
      } else if (def.kind === 'beacon') {
        const sph = new THREE.Mesh(new THREE.SphereGeometry(def.radius * 0.28, 20, 20), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: dim }));
        grp.add(sph); extras.push(sph); core = sph;
        const rg = new THREE.Mesh(new THREE.RingGeometry(def.radius * 0.5, def.radius * 0.54, 96),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5 * dim, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
        rg.rotation.x = Math.PI / 3; grp.add(rg); extras.push(rg); ring = rg;
      }

      systems.push({
        def, grp, col, pos, present: isPresent, core, halo, aura, ring, beam, cloud, extras,
        files: filesBySys.get(def.id) || [], fileBuilt: false, fileStars: [],
      });
    });

    // Hệ 'code' ẢO: các file src/web/docs/… không thuộc hệ nào → cụm module rải quanh GỐC (không phải
    // một hệ có halo riêng; chúng chỉ hiện khi bay về vùng trung tâm ở LOD MODULE). Gộp vào systems với
    // def tối giản để tái dùng cơ chế lazy-build file.
    const codeFiles = filesBySys.get('code') || [];
    const codeSysDef: SystemDef = { id: 'code', code: 'CODEBASE', hue: 0.55, kind: 'cluster', pos: [0, 0, 0], radius: 1400, dirs: [],
      tagVi: 'Mã nguồn dự án', tagEn: 'Project source',
      bodyVi: 'Lõi mã nguồn — các module dự án trải quanh trọng tâm. Bay vào để thấy từng thư mục thành cụm sao, từng file thành thiên thể.',
      bodyEn: 'The source core — project modules spread around the barycentre. Fly in to see each folder as a star-cluster, each file as a body.' };
    const codeGrp = new THREE.Group(); scene.add(codeGrp);
    const codeSys: SystemObj = {
      def: codeSysDef, grp: codeGrp, col: new THREE.Color().setHSL(0.55, 0.5, 0.6), pos: new THREE.Vector3(0, 0, 0),
      present: true, halo: new THREE.Sprite(), aura: new THREE.Sprite(), extras: [],
      files: codeFiles, fileBuilt: false, fileStars: [],
    };
    systems.push(codeSys);

    // ── lazy build file points cho một hệ khi camera đủ gần (LOD). Mỗi thư-mục-con là một cụm nhỏ
    //    trong hệ; số dòng → cỡ + độ sáng. Chỉ upload buffer 1 lần / hệ. ──
    const buildFiles = (sys: SystemObj) => {
      if (sys.fileBuilt || sys.files.length === 0) { sys.fileBuilt = true; return; }
      sys.fileBuilt = true;
      const files = sys.files;
      const maxLines = Math.max(1, ...files.map((f) => f.lines || 1));
      // gom theo thư mục con (ngay dưới top-dir) để tạo cụm module.
      const subOf = (p: string) => { const parts = p.split('/'); return parts.length > 2 ? parts.slice(0, 2).join('/') : (parts.length > 1 ? parts[0] : '(root)'); };
      const subs = new Map<string, FileEntry[]>();
      for (const f of files) { const k = subOf(f.path); if (!subs.has(k)) subs.set(k, []); subs.get(k)!.push(f); }
      const subList = [...subs.entries()];
      const n = files.length;
      const posArr = new Float32Array(n * 3), colArr = new Float32Array(n * 3), sizeArr = new Float32Array(n), litArr = new Float32Array(n);
      const spread = sys.def.radius * 0.9;
      let idx = 0;
      subList.forEach(([sub, subFiles], si) => {
        const Rs = rng(hashCode(sub) || 1);
        const golden = 2.399963;
        const ang = si * golden;
        const rr = spread * (0.25 + 0.7 * (si / Math.max(1, subList.length)));
        const cx = Math.cos(ang) * rr, cz = Math.sin(ang) * rr, cy = (Rs() - 0.5) * spread * 0.4;
        const gcol = new THREE.Color().setHSL(DIR_HUE[topDir(subFiles[0].path)] ?? (Math.abs(hashCode(sub)) % 100) / 100, 0.6, 0.62);
        const sspread = sys.def.radius * 0.12 + Math.sqrt(subFiles.length) * 4;
        subFiles.forEach((f) => {
          const th = Rs() * 6.283, r = sspread * Math.sqrt(Rs());
          const x = cx + Math.cos(th) * r, z = cz + Math.sin(th) * r, y = cy + (Rs() - 0.5) * sspread * 0.5;
          posArr[idx * 3] = x; posArr[idx * 3 + 1] = y; posArr[idx * 3 + 2] = z;
          const big = (f.lines || 1) > 800;
          const c = big ? new THREE.Color().setHSL(0.02, 0.8, 0.62) : gcol.clone();
          const lum = 0.5 + 0.4 * Math.min(1, (f.lines || 1) / maxLines); c.offsetHSL(0, 0, lum - 0.62);
          colArr[idx * 3] = c.r; colArr[idx * 3 + 1] = c.g; colArr[idx * 3 + 2] = c.b;
          sizeArr[idx] = 2 + Math.log2((f.lines || 1) + 1) * 1.4; litArr[idx] = 0;
          const worldPos = new THREE.Vector3(x, y, z).add(sys.pos);
          sys.fileStars.push({ path: f.path, lines: f.lines || 0, worldPos, i: idx });
          idx++;
        });
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(sizeArr, 1));
      geo.setAttribute('aLit', new THREE.BufferAttribute(litArr, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: glowTex }, uTime: { value: 0 }, uPix: { value: px }, uReveal: { value: 0 } },
        vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: `attribute float aSize; attribute float aLit; varying vec3 vC; varying float vL; uniform float uTime,uPix,uReveal;
          void main(){ float pulse=1.0+aLit*0.9*sin(uTime*6.0); vC=mix(color,vec3(1.0,0.98,0.85),aLit*0.7); vL=aLit;
            vec4 mv=modelViewMatrix*vec4(position,1.0);
            gl_PointSize=aSize*uPix*(700.0/-mv.z)*(1.0+aLit*1.5)*pulse*uReveal;
            gl_Position=projectionMatrix*mv; }`,
        fragmentShader: `uniform sampler2D uTex; uniform float uReveal; varying vec3 vC; varying float vL;
          void main(){ vec4 t=texture2D(uTex,gl_PointCoord); gl_FragColor=vec4(vC,t.a*(0.7+vL*0.3)*uReveal); }`,
      });
      const pts = new THREE.Points(geo, mat); pts.position.copy(sys.pos); pts.frustumCulled = false;
      scene.add(pts); sys.filePoints = pts; sys.fileGeo = geo;
    };

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // DATA-FLOW = HẠT chảy trong không gian (KHÔNG vẽ đường A—B). Mỗi hệ có một pool hạt chảy về
    // trọng tâm khi hệ "nóng"; idle thì tắt hẳn. Yêu cầu: "the universe itself becomes the viz".
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const flows = systems.filter((s) => s.def.id !== 'code').map((sys) => {
      const N = 60;
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(N * 3); const ts = new Float32Array(N);
      for (let i = 0; i < N; i++) ts[i] = Math.random();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const m = new THREE.PointsMaterial({ map: glowTex, color: sys.col, size: 18, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
      const p = new THREE.Points(geo, m); p.frustumCulled = false; scene.add(p);
      // điểm uốn giữa (bám hệ, cong về gốc).
      const from = sys.pos.clone();
      const mid = from.clone().multiplyScalar(0.45).add(new THREE.Vector3(-from.z, from.length() * 0.2, from.x).multiplyScalar(0.001));
      const curve = new THREE.CatmullRomCurve3([from, mid, new THREE.Vector3(0, 0, 0)]);
      return { p, m, ts, N, curve, id: sys.def.id };
    });

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // CAMERA = PHI THUYỀN free-fly 6-DOF có QUÁN TÍNH. Không orbit-quanh-tâm.
    //   pos/vel : vị trí + vận tốc (thrust cuộn dọc trục nhìn; damping chậm → inertia).
    //   yaw/pitch: hướng nhìn (kéo chuột); có target + damping → xoay mượt.
    //   travel  : cinematic travel tới 1 điểm (click) — nội suy ease-in-out, KHÔNG teleport.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const camPos = new THREE.Vector3(0, 400, 9000);        // bắt đầu RẤT xa → "I am somewhere enormous"
    const camVel = new THREE.Vector3();
    let yaw = Math.PI, pitch = -0.02, tYaw = Math.PI, tPitch = -0.02;
    let thrust = 0;                                         // xung đẩy tức thời từ cuộn
    let travel: { to: THREE.Vector3; look: THREE.Vector3; t: number; dur: number; fromPos: THREE.Vector3; fromYaw: number; fromPitch: number; tYaw: number; tPitch: number } | null = null;
    let warp = 0, introT = 0, idleTime = 0, idlePtr = -1, prevQuery = '';
    let autopilotOn = false;

    const forward = () => tmpV.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));

    // ── input ──
    const el = renderer.domElement;
    let dragging = false, dpx = 0, dpy = 0, mX = 0, mY = 0;
    const resetIdle = () => { idleTime = 0; };
    const onDown = (e: MouseEvent) => { dragging = true; el.classList.add('dragging'); dpx = e.clientX; dpy = e.clientY; resetIdle(); };
    const onUp = () => { dragging = false; el.classList.remove('dragging'); };
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      mX = (e.clientX - r.left) / r.width - 0.5; mY = (e.clientY - r.top) / r.height - 0.5;
      if (dragging) {
        tYaw -= (e.clientX - dpx) * 0.0032; tPitch -= (e.clientY - dpy) * 0.0032;
        tPitch = Math.max(-1.45, Math.min(1.45, tPitch)); dpx = e.clientX; dpy = e.clientY; travel = null; resetIdle();
      }
    };
    const onWheel = (e: WheelEvent) => {
      // cuộn = THRUST dọc trục nhìn (không đổi radius). Lên = tiến sâu.
      thrust += -e.deltaY * 0.9; travel = null; resetIdle();
    };
    // WASD = strafe/thrust phi thuyền.
    const keys = new Set<string>();
    const onKeyD = (e: KeyboardEvent) => { keys.add(e.key.toLowerCase()); if ('wasd'.includes(e.key.toLowerCase())) { travel = null; resetIdle(); } };
    const onKeyU = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mousemove', onMove);
    el.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('keydown', onKeyD);
    window.addEventListener('keyup', onKeyU);

    const screenOf = (v: THREE.Vector3) => {
      const sp = tmpV2.copy(v).project(camera); const r = el.getBoundingClientRect();
      return { x: r.left + (sp.x * 0.5 + 0.5) * r.width, y: r.top + (-sp.y * 0.5 + 0.5) * r.height, behind: sp.z > 1 };
    };

    // cinematic travel tới một điểm, dừng cách nó `standoff`.
    const flyTo = (target: THREE.Vector3, standoff: number) => {
      const dir = tmpV.copy(camPos).sub(target).normalize();
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      const to = target.clone().add(dir.multiplyScalar(standoff));
      const look = target.clone();
      const dv = tmpV2.copy(look).sub(to);
      const nyaw = Math.atan2(dv.x, dv.z);
      const npitch = Math.asin(THREE.MathUtils.clamp(dv.y / (dv.length() || 1), -1, 1));
      travel = { to, look, t: 0, dur: 1.4, fromPos: camPos.clone(), fromYaw: yaw, fromPitch: pitch, tYaw: nyaw, tPitch: npitch };
      camVel.set(0, 0, 0); thrust = 0;
    };

    const vi = () => langRef.current === 'vi';
    // ── inspector + code panel ──
    function openSystem(sys: SystemObj) {
      if (sys.def.id === 'code') { flyTo(sys.pos, 2000); setSel(null); return; }
      const def = sys.def;
      let body = vi() ? def.bodyVi : def.bodyEn;
      const meta: [string, string][] = [];
      if (def.id === 'tools') {
        const list = skillListRef.current;
        if (list.length) body += `<div class="cosmos-insp-list"><b>${vi() ? 'Skill đã cấu hình' : 'Configured skills'} (${list.length})</b>${list.slice(0, 24).map((s) => `<span>${s}</span>`).join('')}${list.length > 24 ? ' …' : ''}</div>`;
        meta.push([vi() ? 'Số skill' : 'Skills', String(list.length)]);
      } else if (def.id === 'mcp') {
        const list = mcpListRef.current;
        if (list.length) body += `<div class="cosmos-insp-list"><b>${vi() ? 'Server đang bật' : 'Active servers'} (${list.length})</b>${list.map((s) => `<span>${s}</span>`).join('')}</div>`;
        meta.push([vi() ? 'Số server' : 'Servers', String(list.length)]);
      } else if (def.id === 'database') {
        meta.push([vi() ? 'Trạng thái' : 'Status', sys.present ? (vi() ? 'Đã kết nối' : 'Connected') : (vi() ? 'Chưa bật' : 'Off')]);
      }
      if (sys.files.length) meta.push([vi() ? 'File' : 'Files', String(sys.files.length)]);
      const h = heat[def.id] ?? 0; const isHot = h > 0.15;
      setSel({ tag: vi() ? def.tagVi : def.tagEn, name: def.code, body,
        status: isHot ? (vi() ? 'Đang hoạt động · agent thinking' : 'Active · agent thinking')
          : (sys.present ? (vi() ? 'Hệ tri thức' : 'Knowledge system') : (vi() ? 'Chưa hiện diện' : 'Not present')),
        live: isHot, meta });
      setCodePanel(null);
      flyTo(sys.pos, sys.def.radius * 2.2);
    }

    // fetch + hiện source thật (tầng CODE). Chống spam: chỉ fetch khi đổi path.
    let lastSrcPath = '';
    const openFile = async (star: { path: string; lines: number; worldPos: THREE.Vector3 }) => {
      setSel({ tag: (star.path.includes('/') ? star.path.slice(0, star.path.lastIndexOf('/')) : '(root)') + '/', name: star.path.split('/').pop() || star.path,
        body: '', status: vi() ? 'Thiên thể file' : 'File body', live: false,
        meta: [[vi() ? 'Số dòng' : 'Lines', star.lines.toLocaleString('en')], [vi() ? 'Đuôi' : 'Ext', '.' + (star.path.split('.').pop() || '')]] });
      flyTo(star.worldPos, 60);
      if (lastSrcPath === star.path) return;
      lastSrcPath = star.path;
      setCodePanel({ path: star.path, lines: [] });
      try {
        const [srcRes, symRes] = await Promise.all([
          apiFetch(`/api/file-source?path=${encodeURIComponent(star.path)}`),
          apiFetch(`/api/file-symbols?path=${encodeURIComponent(star.path)}`),
        ]);
        const src = srcRes.ok ? await srcRes.json() : { lines: [] };
        const sym = symRes.ok ? await symRes.json() : { symbols: [] };
        if (lastSrcPath !== star.path) return; // đã đổi file khác trong lúc chờ
        setCodePanel({ path: star.path, lines: src.binary ? [vi() ? '— file nhị phân —' : '— binary file —'] : (src.lines || []), truncated: src.truncated });
        const syms: { name: string; kind: string; line: number }[] = sym.symbols || [];
        if (syms.length) {
          setSel((prev) => prev && prev.name === (star.path.split('/').pop() || star.path)
            ? { ...prev, body: `<div class="cosmos-insp-list"><b>${vi() ? 'Hàm & symbol' : 'Functions & symbols'} (${syms.length})</b>${syms.slice(0, 40).map((s) => `<span>${s.name}</span>`).join('')}${syms.length > 40 ? ' …' : ''}</div>` }
            : prev);
        }
      } catch { /* fail-open: chỉ thiếu source */ }
    };

    apiRef.current = {
      focusSystem: (id) => { const s = systems.find((x) => x.def.id === id); if (s) openSystem(s); },
      focusFile: (path) => {
        for (const s of systems) { if (!s.fileBuilt) buildFiles(s); const st = s.fileStars.find((x) => x.path === path); if (st) { openFile(st); return; } }
      },
      reset: () => { travel = null; flyTo(new THREE.Vector3(0, 0, 0), 9000); setSel(null); setCodePanel(null); },
    };

    // hit-test: hệ gần con trỏ nhất (ưu tiên hệ, rồi file nếu đang gần).
    const pickSystem = (cx: number, cy: number): SystemObj | null => {
      let best: SystemObj | null = null, bd = 130;
      for (const s of systems) {
        if (s.def.id === 'code') continue;
        const sp = screenOf(s.pos); if (sp.behind) continue;
        const d = Math.hypot(cx - sp.x, cy - sp.y);
        if (d < bd) { bd = d; best = s; }
      }
      return best;
    };
    const pickFile = (cx: number, cy: number): { path: string; lines: number; worldPos: THREE.Vector3 } | null => {
      let best: { path: string; lines: number; worldPos: THREE.Vector3 } | null = null, bd = 26;
      for (const s of systems) {
        if (!s.fileBuilt) continue;
        if (camPos.distanceTo(s.pos) > s.def.radius * 4) continue; // chỉ xét hệ đang ở gần
        for (const st of s.fileStars) { const sp = screenOf(st.worldPos); if (sp.behind) continue; const d = Math.hypot(cx - sp.x, cy - sp.y); if (d < bd) { bd = d; best = st; } }
      }
      return best;
    };

    const onClick = (e: MouseEvent) => {
      resetIdle();
      const f = pickFile(e.clientX, e.clientY);
      if (f) { openFile(f); return; }
      const s = pickSystem(e.clientX, e.clientY);
      if (s) openSystem(s);
    };
    const onDbl = (e: MouseEvent) => {
      resetIdle();
      const s = pickSystem(e.clientX, e.clientY);
      if (s && s.def.id !== 'code') { buildFiles(s); flyTo(s.pos, s.def.radius * 0.9); } // bay VÀO TRONG hệ
    };
    el.addEventListener('click', onClick);
    el.addEventListener('dblclick', onDbl);

    // ── AI THINKING: nhiệt mỗi hệ (0..1) ──
    const heat: Record<string, number> = {};
    SYSTEMS.forEach((d) => { heat[d.id] = 0; });
    heat['code'] = 0;
    const prevHot = new Set<string>();
    const ripples: { t: number; s: THREE.Sprite }[] = [];
    const spawnRipple = (pos: THREE.Vector3, col: THREE.Color) => {
      if (ripples.length > 10) return;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.position.copy(pos); s.scale.setScalar(40); scene.add(s); ripples.push({ t: 0, s });
    };
    const heatSystem = (srcId: string): string => SOURCE_TO_SYSTEM[srcId] ?? srcId;

    // ── nhãn HTML (nhỏ, tối giản — không oversized). Chỉ hệ + file gần. ──
    const labelHost = labelsRef.current!;
    const mkLabel = (html: string) => { const d = document.createElement('div'); d.className = 'cosmos-lbl'; d.innerHTML = html; labelHost.appendChild(d); return d; };
    const sysLabels = systems.filter((s) => s.def.id !== 'code').map((s) => ({ s, el: mkLabel(`<b style="color:#${s.col.getHexString()}">${s.def.code}</b><em>${(vi() ? s.def.tagVi : s.def.tagEn).split(' · ')[0]}</em>`) }));
    const fileLabelPool: HTMLDivElement[] = [];
    for (let i = 0; i < 14; i++) { const d = document.createElement('div'); d.className = 'cosmos-file-lbl'; d.style.opacity = '0'; labelHost.appendChild(d); fileLabelPool.push(d); }

    const UNI_MSG_VI = ['Đọc CLAUDE.md…', 'Nạp memory dự án…', 'Grep repo…', 'Gọi MCP…', 'Áp skill…', 'Tổng hợp…'];
    const UNI_MSG_EN = ['Reading CLAUDE.md…', 'Loading memory…', 'Grepping repo…', 'Calling MCP…', 'Applying skill…', 'Synthesizing…'];
    let uniPtr = 0, uniTimer = 0;

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // RENDER LOOP
    // ══════════════════════════════════════════════════════════════════════════════════════════
    let raf = 0; const clock = new THREE.Clock();
    let fpsAcc = 0, fpsFrames = 0, degradeTimer = 0, hudTimer = 0, depthTimer = 0;
    // LOD ngưỡng khoảng cách camera → hệ gần nhất.
    const nearestSystem = (): { sys: SystemObj; d: number } => {
      let best = systems[0], bd = 1e12;
      for (const s of systems) { const d = camPos.distanceTo(s.pos) - s.def.radius; if (d < bd) { bd = d; best = s; } }
      return { sys: best, d: bd };
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05); const T = clock.elapsedTime;
      introT = Math.min(1, introT + dt * 0.22);

      // ── FPS + auto-degrade ──
      fpsAcc += dt; fpsFrames++;
      if (fpsAcc >= 0.5) {
        const curFps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0;
        hudTimer += 0.5; if (hudTimer >= 1) { hudTimer = 0; setFps(Math.round(curFps)); }
        if (tierRef.current !== curTier) curTier = tierRef.current;
        else if (curFps < 46 && tierRank[curTier] > 0) {
          degradeTimer += 0.5;
          if (degradeTimer >= 1.5) { degradeTimer = 0; const order = ['lite', 'balanced', 'high', 'ultra'] as const; curTier = order[tierRank[curTier] - 1]; tierRef.current = curTier; setTier(curTier); }
        } else degradeTimer = 0;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, curTier === 'lite' ? 1 : curTier === 'balanced' ? 1.5 : 2));
      }

      // ── IDLE CINEMATIC (attract): tự bay tham quan các hệ ──
      idleTime += dt;
      const attract = idleTime > 22 && !runningRef.current && !queryRef.current.trim() && !travel;
      if (attract !== autopilotOn) { autopilotOn = attract; setAutopilot(attract); }
      if (attract) {
        const period = 11;
        const ptr = Math.floor((idleTime - 22) / period);
        if (ptr !== idlePtr) { idlePtr = ptr; const s = systems.filter((x) => x.def.id !== 'code')[ptr % (systems.length - 1)]; flyTo(s.pos, s.def.radius * 2.4); }
      }

      // ── CAMERA vật lý ──
      if (travel) {
        travel.t = Math.min(1, travel.t + dt / travel.dur);
        const e = travel.t < 0.5 ? 4 * travel.t ** 3 : 1 - Math.pow(-2 * travel.t + 2, 3) / 2; // easeInOutCubic
        camPos.copy(travel.fromPos).lerp(travel.to, e);
        // yaw có thể quấn ±π → nội suy theo cung ngắn nhat.
        let dy = travel.tYaw - travel.fromYaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
        yaw = travel.fromYaw + dy * e; tYaw = yaw;
        pitch = travel.fromPitch + (travel.tPitch - travel.fromPitch) * e; tPitch = pitch;
        if (travel.t >= 1) travel = null;
      } else {
        yaw += (tYaw - yaw) * 0.08; pitch += (tPitch - pitch) * 0.08;
        const fwd = forward().clone();
        // thrust cuộn → vận tốc dọc trục nhìn.
        if (thrust !== 0) { camVel.addScaledVector(fwd, thrust * 0.02); thrust *= 0.6; if (Math.abs(thrust) < 0.5) thrust = 0; }
        // WASD
        const right = tmpV2.set(Math.sin(yaw + Math.PI / 2), 0, Math.cos(yaw + Math.PI / 2));
        const accel = 40;
        if (keys.has('w')) camVel.addScaledVector(fwd, accel * dt);
        if (keys.has('s')) camVel.addScaledVector(fwd, -accel * dt);
        if (keys.has('d')) camVel.addScaledVector(right, accel * dt);
        if (keys.has('a')) camVel.addScaledVector(right, -accel * dt);
        camVel.multiplyScalar(0.94);          // DAMPING → inertia (giảm tốc chậm)
        camPos.addScaledVector(camVel, dt * 60);
      }
      // floating vi mô (subtle) — chỉ khi không travel.
      const bobY = travel ? 0 : Math.sin(T * 0.5) * 1.5;
      const lookYaw = yaw + (travel ? 0 : mX * 0.04);
      const lookPitch = pitch + (travel ? 0 : -mY * 0.03);
      camera.position.copy(camPos); camera.position.y += bobY;
      forward();
      camera.lookAt(camPos.x + Math.sin(lookYaw) * Math.cos(lookPitch), camPos.y + Math.sin(lookPitch) + bobY, camPos.z + Math.cos(lookYaw) * Math.cos(lookPitch));

      // warp từ tốc độ thật.
      const speed = camVel.length() * 60 + (travel ? camPos.distanceTo(travel.to) * 0 : 0);
      const travelSpeed = travel ? (1 - Math.abs(travel.t - 0.5) * 2) * 60 : speed;
      warp += (Math.min(1, travelSpeed / 90) - warp) * (warp < travelSpeed / 90 ? 0.2 : 0.06);
      const wantBlur = tierRank[curTier] >= tierRank.ultra && warp > 0.12;
      afterimage.enabled = wantBlur;
      if (wantBlur) (afterimage.uniforms as { damp: { value: number } }).damp.value = Math.min(0.7, warp * 0.8);

      // ── nền ──
      (starShell.m.uniforms.uTime as { value: number }).value = T;
      dust.position.copy(camPos);            // bụi bám camera → parallax
      dust.rotation.y += dt * 0.01;
      gravGrp.rotation.y += dt * 0.004;
      (gravDust.material as THREE.PointsMaterial).opacity = 0.14 * introT;
      (gravHalo.material as THREE.SpriteMaterial).opacity = 0.06 * introT;
      ambNeb.forEach((n) => { (n.s.material as THREE.SpriteMaterial).opacity = n.baseOp * (0.7 + 0.3 * Math.sin(T * 0.05 + n.ph)) * introT; n.s.material.rotation += n.spin * dt; });

      // ── NHIỆT ──
      const hotNow = new Set(srcActiveRef.current.map(heatSystem));
      if (hotNow.has('mcp') && hasDb) hotNow.add('database');
      for (const id of Object.keys(heat)) {
        const target = hotNow.has(id) ? 1 : 0;
        heat[id] += (target - heat[id]) * (target > heat[id] ? 0.1 : 0.03);
        if (hotNow.has(id) && !prevHot.has(id)) { const s = systems.find((x) => x.def.id === id); if (s) spawnRipple(s.pos, s.col); }
      }
      prevHot.clear(); hotNow.forEach((id) => prevHot.add(id));

      // ── LOD: xác định tầng theo hệ gần nhất; lazy build file; đặt uReveal ──
      const { sys: nearSys, d: nearD } = nearestSystem();
      const R0 = nearSys.def.radius;
      let curDepth: 'universe' | 'system' | 'module' | 'file' | 'function' | 'code' = 'universe';
      if (nearD < R0 * 0.4) curDepth = 'code';
      else if (nearD < R0 * 1.0) curDepth = 'function';
      else if (nearD < R0 * 2.0) curDepth = 'file';
      else if (nearD < R0 * 4.5) curDepth = 'module';
      else if (nearD < R0 * 12) curDepth = 'system';
      // build file khi vào tầng module trở vào.
      if (curDepth === 'module' || curDepth === 'file' || curDepth === 'function' || curDepth === 'code') buildFiles(nearSys);
      // reveal file points: 0 ở xa → 1 khi ở tầng file/function/code.
      systems.forEach((s) => {
        if (!s.filePoints || !s.fileGeo) return;
        const near = s === nearSys;
        const want = near && (curDepth === 'module' || curDepth === 'file' || curDepth === 'function' || curDepth === 'code')
          ? (curDepth === 'module' ? 0.5 : 1) : 0;
        const mat = s.filePoints.material as THREE.ShaderMaterial;
        mat.uniforms.uReveal.value += (want - mat.uniforms.uReveal.value) * 0.08;
        mat.uniforms.uTime.value = T;
        s.filePoints.visible = mat.uniforms.uReveal.value > 0.01;
      });
      depthTimer += dt; if (depthTimer > 0.25) { depthTimer = 0; setDepth((d) => d === curDepth ? d : curDepth); }

      // ── HỆ: diện mạo động theo loại + nhiệt (progressive: xa mờ, gần rõ) ──
      systems.forEach((s) => {
        if (s.def.id === 'code') return;
        const h = heat[s.def.id] || 0;
        const dCam = camPos.distanceTo(s.pos);
        // fade hệ khi ta lặn vào trong nó (nhường chỗ cho file) — nhưng halo xa vẫn thấy.
        const insideFade = THREE.MathUtils.clamp((dCam - s.def.radius * 0.5) / (s.def.radius * 1.5), 0, 1);
        const pres = (s.present ? 1 : 0.28) * introT;
        (s.halo.material as THREE.SpriteMaterial).opacity = (0.55 + h * 0.6 + Math.sin(T * 1.5 + s.pos.x) * 0.08) * pres * (0.4 + 0.6 * insideFade);
        (s.aura.material as THREE.SpriteMaterial).opacity = 0.13 * pres;
        if (s.core) {
          const cm = s.core.material as THREE.Material & { color?: THREE.Color; opacity: number; uniforms?: Record<string, { value: number }> };
          if (cm.uniforms?.uHeat) cm.uniforms.uHeat.value = h;
          if (cm.uniforms?.uTime) cm.uniforms.uTime.value = T;
          if (cm.color) cm.color.copy(s.col).lerp(new THREE.Color(0xffffff), h * 0.5);
        }
        // animation riêng theo kind
        if (s.def.kind === 'wormhole' && s.ring) s.ring.rotation.z += dt * (0.5 + h * 2.5);
        if (s.def.kind === 'pulsar' && s.beam) { s.beam.material.rotation += dt * (1 + h * 3); (s.beam.material as THREE.SpriteMaterial).opacity = (0.3 + 0.35 * Math.abs(Math.sin(T * (2 + h * 4)))) * pres; if (s.ring) s.ring.rotation.z += dt * 0.6; }
        if (s.def.kind === 'star' && s.core) s.core.rotation.y += dt * (0.05 + h * 0.2);
        if (s.def.kind === 'beacon' && s.ring) { s.ring.rotation.z += dt * 0.4; (s.ring.material as THREE.MeshBasicMaterial).opacity = (0.3 + 0.4 * Math.abs(Math.sin(T * 1.5))) * pres; }
        if (s.def.kind === 'satellites') s.extras.forEach((o) => { const orb = (o as THREE.Mesh).userData?.orbit; if (orb) { orb.th += dt * orb.sp; (o as THREE.Mesh).position.set(Math.cos(orb.th) * orb.r, orb.el, Math.sin(orb.th) * orb.r); (((o as THREE.Mesh).material) as THREE.MeshBasicMaterial).opacity = (0.6 + h * 0.4) * pres; } });
        if (s.def.kind === 'nebula' || s.def.kind === 'cluster') s.grp.rotation.y += dt * (0.02 + h * 0.15);
        if (s.def.kind === 'belt') s.grp.rotation.y += dt * (0.03 + h * 0.1);
        if (s.def.kind === 'energy' && s.core) { const cm = s.core.material as THREE.ShaderMaterial; cm.uniforms.uHeat.value = h; cm.uniforms.uTime.value = T; s.grp.lookAt(camPos); }
      });

      // ── RIPPLE ──
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i]; r.t += dt * 0.6; r.s.scale.setScalar(40 + r.t * 900);
        (r.s.material as THREE.SpriteMaterial).opacity = Math.max(0, 0.5 * (1 - r.t)) * introT;
        if (r.t >= 1) { scene.remove(r.s); (r.s.material as THREE.Material).dispose(); ripples.splice(i, 1); }
      }

      // ── DATA-FLOW hạt ──
      flows.forEach((fl) => {
        const h = heat[fl.id] || 0;
        const m = fl.m; m.opacity = h * 0.7 * introT; m.size = 12 + h * 30;
        if (h < 0.02) return;
        const arr = fl.p.geometry.attributes.position.array as Float32Array;
        const spd = 0.15 + h * 0.5;
        for (let i = 0; i < fl.N; i++) { fl.ts[i] += dt * spd; if (fl.ts[i] > 1) fl.ts[i] -= 1; fl.curve.getPoint(fl.ts[i], tmpV); arr[i * 3] = tmpV.x; arr[i * 3 + 1] = tmpV.y; arr[i * 3 + 2] = tmpV.z; }
        fl.p.geometry.attributes.position.needsUpdate = true;
      });

      // ── highlight file THẬT từ activeFiles + query (chỉ trên hệ đã build) ──
      const act = activeRef.current; const q = queryRef.current.trim().toLowerCase();
      let liveFileName = '';
      systems.forEach((s) => {
        if (!s.filePoints || !s.fileGeo) return;
        const litAttr = s.fileGeo.attributes.aLit.array as Float32Array;
        for (let i = 0; i < litAttr.length; i++) litAttr[i] *= 0.94;
        for (const st of s.fileStars) {
          if (act.some((p) => p === st.path || p.endsWith('/' + st.path) || st.path.endsWith('/' + p))) { litAttr[st.i] = 1; liveFileName = st.path.split('/').pop() || st.path; }
          if (q && st.path.toLowerCase().includes(q)) litAttr[st.i] = Math.max(litAttr[st.i], 0.9);
        }
        s.fileGeo.attributes.aLit.needsUpdate = true;
      });
      // query 1-match → bay tới (build hệ chứa nó trước).
      if (q && q !== prevQuery) {
        let hit: { path: string; lines: number; worldPos: THREE.Vector3 } | null = null, cnt = 0;
        for (const s of systems) { for (const f of s.files) { if (f.path.toLowerCase().includes(q)) { cnt++; if (cnt === 1) { buildFiles(s); hit = s.fileStars.find((x) => x.path === f.path) || null; } } } }
        if (cnt === 1 && hit) flyTo(hit.worldPos, 80);
      }
      prevQuery = q;

      // live text
      if (runningRef.current) {
        if (liveFileName) setLive((vi() ? 'Agent đang làm: ' : 'Working on: ') + liveFileName);
        else { uniTimer += dt; if (uniTimer > 1.6) { uniTimer = 0; uniPtr = (uniPtr + 1) % 6; } setLive((vi() ? UNI_MSG_VI : UNI_MSG_EN)[uniPtr]); }
      } else setLive(vi() ? 'Không có agent hoạt động' : 'Agent idle');

      // ── bloom nhẹ hơn khi ở gần (tránh chói khi lặn vào), mạnh nhẹ khi có heat ──
      let heatSum = 0; for (const id of Object.keys(heat)) heatSum += heat[id];
      bloom.strength = 0.42 + Math.min(0.25, heatSum * 0.12);

      composer.render();

      // ── nhãn (LOD + chống chồng). Chỉ hiện hệ đủ gần & không sau lưng; nhãn nhỏ. ──
      const rBox = el.getBoundingClientRect();
      const setLxy = (d: HTMLElement, sx: number, sy: number, op: number) => { d.style.left = (sx - rBox.left) + 'px'; d.style.top = (sy - rBox.top) + 'px'; d.style.opacity = String(op); };
      const claimed: { x: number; y: number }[] = [];
      const ordered = sysLabels.map((e) => ({ e, dc: camPos.distanceTo(e.s.pos) })).sort((a, b) => a.dc - b.dc);
      for (const { e, dc } of ordered) {
        const sp = screenOf(e.s.pos); const sy = sp.y - 14;
        // hiện khi hệ nằm trong dải nhìn thấy được; hệ rất xa (dc rất lớn) chỉ hiện nếu là 1 trong vài hệ gần nhất.
        let op = sp.behind ? 0 : THREE.MathUtils.clamp(1 - dc / 14000, 0, 1) * introT * 0.95 * (e.s.present ? 1 : 0.5);
        if (op > 0.03) { for (const c of claimed) { if (Math.abs(sp.x - c.x) < 70 && Math.abs(sy - c.y) < 26) { op = 0; break; } } }
        if (op > 0.03) claimed.push({ x: sp.x, y: sy });
        setLxy(e.el, sp.x, sy, op);
      }
      // file labels: chỉ vài file gần nhất khi ở tầng file/code.
      let li = 0;
      if (curDepth === 'file' || curDepth === 'function' || curDepth === 'code') {
        const near = nearSys;
        if (near.fileBuilt) {
          const cand = near.fileStars
            .map((st) => ({ st, dc: camPos.distanceTo(st.worldPos) }))
            .filter((x) => x.dc < near.def.radius * 1.5)
            .sort((a, b) => a.dc - b.dc).slice(0, fileLabelPool.length);
          for (const { st } of cand) { const sp = screenOf(st.worldPos); if (sp.behind) continue; const d = fileLabelPool[li++]; d.textContent = st.path.split('/').pop() || st.path; setLxy(d, sp.x, sp.y, 0.85); }
        }
      }
      for (; li < fileLabelPool.length; li++) fileLabelPool[li].style.opacity = '0';

      // HUD coords
      const zoom = (9000 / Math.max(1, camPos.length())).toFixed(2);
      const raH = ((Math.floor((yaw / Math.PI + 1) * 12)) % 24 + 24) % 24, dec = Math.round(-pitch * 60);
      setCoords({ ra: `RA ${String(raH).padStart(2, '0')}ʰ · DEC ${dec >= 0 ? '+' : '−'}${Math.abs(dec)}°`, zoom: `×${zoom}` });
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
      window.removeEventListener('mousemove', onMove); el.removeEventListener('wheel', onWheel);
      el.removeEventListener('click', onClick); el.removeEventListener('dblclick', onDbl);
      window.removeEventListener('keydown', onKeyD); window.removeEventListener('keyup', onKeyU);
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
  const depthLabel: Record<typeof depth, [string, string]> = {
    universe: ['Vũ trụ', 'Universe'], system: ['Hệ', 'System'], module: ['Module', 'Module'],
    file: ['File', 'File'], function: ['Hàm', 'Function'], code: ['Mã nguồn', 'Code'],
  };

  return (
    <div className="cosmos-overlay">
      <div ref={mountRef} className="cosmos-canvas-host" />
      <div ref={labelsRef} className="cosmos-labels" />

      <span className="cosmos-corner tl" /><span className="cosmos-corner tr" />
      <span className="cosmos-corner bl" /><span className="cosmos-corner br" />

      <div className="cosmos-hud-title">
        <h1>Cosmos</h1>
        <div className="cosmos-sub">{t('Bay xuyên kiến trúc của AI', 'Fly through the AI’s architecture')}</div>
        <div className="cosmos-live"><b />{live}</div>
      </div>

      <div className="cosmos-coords">
        <div>{coords.ra}</div>
        <div className="zoom">{coords.zoom}</div>
        <div className="now">{t('Tầng', 'Depth')}: {t(depthLabel[depth][0], depthLabel[depth][1])} · {totalFiles} file</div>
      </div>

      <div className="cosmos-search">
        <Icon name="target" size={13} />
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={t('tìm file / hệ… (vd runner.ts, memory)', 'find file / system… (e.g. runner.ts)')} spellCheck={false} />
        {query && <button onClick={() => setQuery('')} aria-label={t('Xoá', 'Clear')}><Icon name="close" size={12} /></button>}
      </div>

      <button className="cosmos-tier" title={t('Bấm để đổi mức đồ hoạ (tự hạ khi tụt FPS)', 'Click to change quality (auto-lowers on FPS drop)')}
        onClick={() => { const order = ['lite', 'balanced', 'high', 'ultra'] as const; setTier((cur) => order[(order.indexOf(cur) + 1) % 4]); }}>
        <span className={`cosmos-tier-lv t-${tier}`}>{tier.toUpperCase()}</span>
        <span className="cosmos-tier-fps">{fps} FPS</span>
      </button>

      {autopilot && <div className="cosmos-autopilot">{t('◆ TỰ HÀNH — di chuột / cuộn để lái', '◆ AUTO-PILOT — move / scroll to fly')}</div>}

      <button className="cosmos-close" onClick={onClose} title={t('Đóng (ESC)', 'Close (ESC)')}><Icon name="close" size={18} /></button>
      <button className="cosmos-reset" onClick={() => apiRef.current?.reset()} title={t('Về toàn cảnh', 'Reset view')}><Icon name="refresh" size={14} /></button>

      <div className="cosmos-hint">{t('Cuộn = tăng tốc bay · kéo = xoay hướng · WASD = lái · bấm hệ để bay tới · bấm-đúp = bay vào trong',
        'Scroll = thrust · drag = steer · WASD = fly · click a system to travel · double-click = fly inside')}</div>

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
          {codePanel && (
            <div className="cosmos-code">
              <div className="cosmos-code-head">{codePanel.path}{codePanel.truncated ? ' · …' : ''}</div>
              <pre className="cosmos-code-body">{codePanel.lines.length ? codePanel.lines.slice(0, 400).join('\n') : (language === 'vi' ? 'Đang tải…' : 'Loading…')}</pre>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
