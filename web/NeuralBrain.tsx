import { useEffect, useRef, useState } from 'react';

/**
 * Bản đồ vũ trụ tương tác 3D (3D Cosmic Journey) — vẽ bằng <canvas>, thuần code.
 * Nền mô phỏng dải Ngân Hà 3D (3D Milky Way Galaxy) tự quay với:
 * - Nhân thiên hà sáng rực rỡ và các đám mây tinh vân (nebulae).
 * - Thanh ngang trung tâm (Central Bar) đặc trưng, quay đồng bộ như vật thể rắn.
 * - 4 cánh xoắn ốc lớn (Perseus, Sagittarius, Scutum-Centaurus, Cygnus-Norma) có vận tốc góc giảm dần ra xa.
 * - Hệ Mặt Trời (Solar System ☀️) tọa lạc tại nhánh phụ Orion, hiển thị nhãn khi phóng to.
 * Các bước agent hoạt động tạo thành các chòm sao dạng vòng tròn 3D nghiêng, tự quay đồng bộ và chiếu phối cảnh.
 * Hỗ trợ kéo thả để xoay góc nhìn camera (3D Orbit) và lăn chuột để Phóng to/Thu nhỏ (Zoom).
 */

export interface BrainStep {
  id: string;
  type: string; // start | tool | result | error | approval | thinking
  label: string;
  detail?: string;
  active?: boolean;
  count?: number;
}

interface Particle {
  r: number;
  theta: number;
  z: number; // 3D depth coordinate
  armOffset: number;
  spinSpeed: number;
  size: number;
  color: string;
  sparkleSpeed: number;
  phase: number;
  brightness: number;
  isSun?: boolean;
}

function makeGalaxyParticles(n: number): Particle[] {
  let seed = 20260706;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  
  const particles: Particle[] = [];
  const numArms = 4; // 4 cánh xoắn ốc lớn của dải Ngân Hà
  const spinFactor = 3.6;
  
  for (let i = 0; i < n; i++) {
    // Thiên thể đặc biệt: Hệ Mặt Trời ở nhánh Orion (r ~ 0.54)
    if (i === 0) {
      particles.push({
        r: 0.54,
        theta: 2.1,
        z: 0.01,
        armOffset: 0,
        spinSpeed: 0.35 - (0.54 - 0.18) * 0.15,
        size: 1.6, // Lớn hơn một chút
        color: '253, 186, 116', // Vàng cam ấm
        sparkleSpeed: 1.0,
        phase: 0,
        brightness: 1.0,
        isSun: true
      });
      continue;
    }
    
    // 25% số hạt sinh ra trong Thanh Ngang Trung Tâm (Central Bar) của Ngân Hà
    if (i < n * 0.25) {
      const u = (rnd() - 0.5) * 0.32; // Chiều dài thanh
      const v = (rnd() - 0.5) * 0.07 * Math.cos((u / 0.16) * Math.PI / 2); // Độ rộng thanh phình ở giữa
      const z = (rnd() - 0.5) * 0.06; // Độ dày
      
      const r = Math.sqrt(u * u + v * v);
      const theta = Math.atan2(v, u);
      
      const size = 0.5 + rnd() * 1.5;
      const phase = rnd() * Math.PI * 2;
      const sparkleSpeed = 0.8 + rnd() * 1.8;
      
      // Tông màu vàng lùn, đỏ khổng lồ ấm áp của vùng nhân (Bulge/Bar)
      let color = '';
      const roll = rnd();
      if (roll < 0.5) color = '254, 240, 138'; // Vàng nhạt
      else if (roll < 0.85) color = '251, 191, 36'; // Vàng cam/vàng kim
      else color = '248, 113, 113'; // Đỏ cam
      
      particles.push({
        r,
        theta,
        z,
        armOffset: 0,
        spinSpeed: 0.35, // Thanh ngang quay đồng bộ như vật thể rắn!
        size,
        color,
        sparkleSpeed,
        phase,
        brightness: 0.4 + rnd() * 0.6,
      });
    } else {
      // 75% số hạt còn lại phân bổ vào 4 cánh xoắn ốc lớn
      const arm = i % numArms;
      const armOffset = (arm * Math.PI) / 2;
      
      const rRaw = rnd();
      const r = 0.16 + 0.84 * Math.pow(rRaw, 1.4); // Bắt đầu từ rìa thanh ngang
      
      let theta = r * spinFactor + armOffset;
      const dispersion = 0.22 * (1.0 - r * 0.4); // Độ loãng bụi khí giảm dần ra xa
      theta += (rnd() - 0.5) * dispersion * 2;
      
      const z = (rnd() - 0.5) * 0.12 * Math.exp(-r * 1.5); // Đĩa dẹt dần ra ngoài rìa
      
      const size = 0.4 + rnd() * 1.4;
      const speed = 0.35 - (r - 0.18) * 0.15; // Vận tốc góc giảm dần ở ngoài rìa (xoắn sai biệt)
      const phase = rnd() * Math.PI * 2;
      const sparkleSpeed = 0.8 + rnd() * 1.8;
      
      // Cánh thiên hà trẻ trung: Xanh dương, Cyan, hồng tím tinh vân và sao trắng
      let color = '';
      const roll = rnd();
      if (roll < 0.45) color = '56, 189, 248'; // Cyan
      else if (roll < 0.75) color = '147, 197, 253'; // Xanh nhạt
      else if (roll < 0.9) color = '236, 72, 153'; // Hồng/Đỏ tía tinh vân
      else color = '255, 255, 255'; // Sao trắng
      
      particles.push({
        r,
        theta,
        z,
        armOffset,
        spinSpeed: speed,
        size,
        color,
        sparkleSpeed,
        phase,
        brightness: 0.3 + rnd() * 0.7,
      });
    }
  }
  return particles;
}

/** Màu RGB theo loại bước */
function stepColor(type: string): [number, number, number] {
  switch (type) {
    case 'start': return [56, 189, 248]; // Cyan
    case 'tool': return [74, 222, 128]; // Green
    case 'result': return [251, 191, 36]; // Gold
    case 'error': return [248, 113, 113]; // Red
    case 'approval': return [245, 158, 11]; // Orange/Yellow
    case 'thinking': return [167, 139, 250]; // Purple
    default: return [125, 211, 252];
  }
}

/**
 * Định vị các bước dọc theo vòng tròn khép kín trong không gian 3D
 */
function stepPos(i: number, total: number): { r: number; theta: number } {
  if (total === 0) return { r: 0, theta: 0 };
  const radius = 0.58;
  // Phân bố đều các nút xung quanh vòng tròn
  const theta = (i / total) * 2 * Math.PI - Math.PI / 2;
  return { r: radius, theta };
}

/** Vẽ thiên thể phối cảnh 3D đặc thù cho từng loại nút */
function drawSpaceObject(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  type: string,
  time: number
) {
  switch (type) {
    case 'start': {
      // Swirling Wormhole / Blue Giant
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
      ctx.lineWidth = 1.2;
      for (let j = 0; j < 3; j++) {
        ctx.beginPath();
        for (let a = 0; a < Math.PI * 2; a += 0.2) {
          const rr = size * (0.3 + 0.7 * ((a + time * 1.5 + j * 1.8) % (Math.PI * 2)) / (Math.PI * 2));
          const xx = x + Math.cos(a) * rr;
          const yy = y + Math.sin(a) * rr;
          if (a === 0) ctx.moveTo(xx, yy);
          else ctx.lineTo(xx, yy);
        }
        ctx.stroke();
      }
      // Bright core
      ctx.beginPath();
      ctx.arc(x, y, size * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      break;
    }
    
    case 'tool': {
      // Green planet with ring
      ctx.beginPath();
      ctx.arc(x, y, size * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = 'rgb(74, 222, 128)';
      ctx.fill();
      
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 6);
      ctx.scale(1.8, 0.4);
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.6, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(187, 247, 208, 0.85)';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.restore();
      break;
    }
    
    case 'result': {
      // Golden star with 4-point lens flare
      ctx.beginPath();
      ctx.arc(x, y, size * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgb(251, 191, 36)';
      ctx.fill();
      
      ctx.strokeStyle = 'rgba(253, 224, 71, 0.9)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(x - size * 1.5, y);
      ctx.lineTo(x + size * 1.5, y);
      ctx.moveTo(x, y - size * 1.5);
      ctx.lineTo(x, y + size * 1.5);
      ctx.stroke();
      break;
    }
    
    case 'error': {
      // Black hole with red accretion disk swirl
      ctx.beginPath();
      ctx.arc(x, y, size * 1.3, 0, Math.PI * 2);
      const grad = ctx.createRadialGradient(x, y, size * 0.4, x, y, size * 1.3);
      grad.addColorStop(0, 'rgba(239, 68, 68, 0.9)');
      grad.addColorStop(0.5, 'rgba(249, 115, 22, 0.45)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fill();
      
      // Event horizon (black)
      ctx.beginPath();
      ctx.arc(x, y, size * 0.45, 0, Math.PI * 2);
      ctx.fillStyle = '#050505';
      ctx.fill();
      ctx.strokeStyle = 'rgb(239, 68, 68)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      break;
    }
    
    case 'approval': {
      // Yellow sun with waving solar flares
      ctx.beginPath();
      ctx.arc(x, y, size * 0.65, 0, Math.PI * 2);
      ctx.fillStyle = 'rgb(245, 158, 11)';
      ctx.fill();
      
      ctx.beginPath();
      for (let a = 0; a < Math.PI * 2; a += 0.3) {
        const wave = Math.sin(a * 8 + time * 12) * size * 0.15;
        const rr = size * 0.65 + wave;
        const xx = x + Math.cos(a) * rr;
        const yy = y + Math.sin(a) * rr;
        if (a === 0) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(253, 224, 71, 0.55)';
      ctx.fill();
      break;
    }
    
    case 'thinking': {
      // Pulsar emitting two rotating high-energy beams
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(time * 2.2);
      
      const beamGrad = ctx.createLinearGradient(0, -size * 3.5, 0, size * 3.5);
      beamGrad.addColorStop(0, 'rgba(167, 139, 250, 0)');
      beamGrad.addColorStop(0.3, 'rgba(167, 139, 250, 0.6)');
      beamGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.95)');
      beamGrad.addColorStop(0.7, 'rgba(167, 139, 250, 0.6)');
      beamGrad.addColorStop(1, 'rgba(167, 139, 250, 0)');
      
      ctx.fillStyle = beamGrad;
      ctx.fillRect(-1.5, -size * 3.5, 3, size * 7);
      ctx.restore();
      
      // Core
      ctx.beginPath();
      ctx.arc(x, y, size * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = 'rgb(139, 92, 246)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, size * 0.25, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      break;
    }
    
    default: {
      ctx.beginPath();
      ctx.arc(x, y, size * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgb(125, 211, 252)';
      ctx.fill();
    }
  }
}

export function NeuralBrain({
  active,
  steps,
  selectedId,
  onSelect,
  theme,
}: {
  active: boolean;
  steps: BrainStep[];
  selectedId: string | null;
  onSelect: (step: BrainStep) => void;
  theme?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(active);
  const stepsRef = useRef(steps);
  const selRef = useRef(selectedId);
  const themeRef = useRef(theme);
  activeRef.current = active;
  stepsRef.current = steps;
  selRef.current = selectedId;
  themeRef.current = theme;

  const hitsRef = useRef<{ id: string; x: number; y: number; r: number }[]>([]);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const timeRef = useRef(0);

  // States and refs for interactive drag/rotate and scroll/pinch zoom
  const zoomRef = useRef(1.0);
  const rotXRef = useRef(0); // pitch offset
  const rotYRef = useRef(0); // yaw offset
  const offsetXRef = useRef(0); // 2D offset X for centering/panning
  const offsetYRef = useRef(0); // 2D offset Y for centering/panning
  const isDraggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const particles = makeGalaxyParticles(480);
    let raf = 0;
    let t = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Mouse events
    const onMouseDown = (e: MouseEvent) => {
      isDraggingRef.current = true;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const dx = e.clientX - lastMouseRef.current.x;
      const dy = e.clientY - lastMouseRef.current.y;
      
      // Update camera rotation offsets
      rotYRef.current += dx * 0.006;
      rotXRef.current += dy * 0.006;

      // Bound pitch to prevent flipping upside down
      const basePitch = Math.PI / 3.2;
      const minRotX = 0.05 - basePitch;
      const maxRotX = Math.PI / 2.05 - basePitch;
      rotXRef.current = Math.max(minRotX, Math.min(maxRotX, rotXRef.current));
      
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
    };

    // Touch events for mobile/trackpad dragging
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        isDraggingRef.current = true;
        lastMouseRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isDraggingRef.current || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - lastMouseRef.current.x;
      const dy = e.touches[0].clientY - lastMouseRef.current.y;
      
      rotYRef.current += dx * 0.007;
      rotXRef.current += dy * 0.007;

      const basePitch = Math.PI / 3.2;
      const minRotX = 0.05 - basePitch;
      const maxRotX = Math.PI / 2.05 - basePitch;
      rotXRef.current = Math.max(minRotX, Math.min(maxRotX, rotXRef.current));
      
      lastMouseRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };

    const onTouchEnd = () => {
      isDraggingRef.current = false;
    };

    // Scroll wheel zoom event — chỉ khi giữ Ctrl
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // Không giữ Ctrl → để trang cuộn bình thường
      e.preventDefault();
      zoomRef.current = Math.max(0.35, Math.min(3.0, zoomRef.current + e.deltaY * -0.0012));
    };

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    canvas.addEventListener('touchstart', onTouchStart, { passive: true });
    canvas.addEventListener('touchmove', onTouchMove, { passive: true });
    canvas.addEventListener('touchend', onTouchEnd, { passive: true });

    canvas.addEventListener('wheel', onWheel, { passive: false });

    const draw = () => {
      const W = canvas.width;
      const H = canvas.height;
      t += 0.012; // slow, cosmic speed
      timeRef.current = t;
      
      const on = activeRef.current;
      const st = stepsRef.current;
      const sel = selRef.current;
      const theme = themeRef.current;
      const isLight = theme === 'light' || theme === 'simple';

      ctx.clearRect(0, 0, W, H);
      
      // Deep space radial background — thích ứng theo theme
      const bg = ctx.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.7);
      if (isLight) {
        // Light & Simple theme: nền sáng ấm/thanh lịch
        bg.addColorStop(0, theme === 'simple' ? '#ffffff' : '#fefce8');  // Trắng hoặc Kem nhạt ở tâm
        bg.addColorStop(0.5, theme === 'simple' ? '#fafafa' : '#f5f5f4'); // Off-white hoặc Stone 100
        bg.addColorStop(1, theme === 'simple' ? '#f4f4f5' : '#e7e5e4');  // Zinc 100 hoặc Stone 200 ở rìa
      } else {
        // Dark theme: nền vũ trụ sâu thẳm
        bg.addColorStop(0, '#04091a');
        bg.addColorStop(0.5, '#02040b');
        bg.addColorStop(1, '#000002');
      }
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      const cx = W * 0.5;
      const cy = H * 0.5;
      const scale = Math.min(W, H) * 0.44;

      // Camera parameters for 3D rotation, including user drag rotation
      const basePitch = Math.PI / 3.2 + Math.sin(t * 0.15) * 0.04;
      const pitch = Math.max(0.05, Math.min(Math.PI / 2.05, basePitch + rotXRef.current));
      const yaw = t * 0.05 + rotYRef.current;
      const focalLength = 1.8;

      // Apply zoom to core scale
      const currentScale = scale * zoomRef.current;

      // ── Lớp 0: Các đám mây bụi vũ trụ (Nebulae) trôi chậm ở nền ──
      ctx.globalCompositeOperation = isLight ? 'multiply' : 'screen';
      const nebulae = isLight
        ? [
            { color: 'rgba(120, 113, 108, 0.06)', x: Math.sin(t * 0.08) * 0.12, y: Math.cos(t * 0.1) * 0.12, size: 0.8 },
            { color: 'rgba(87, 83, 78, 0.05)', x: Math.cos(t * 0.07) * 0.15, y: Math.sin(t * 0.09) * 0.15, size: 0.95 },
            { color: 'rgba(68, 64, 60, 0.04)', x: Math.sin(t * 0.11) * 0.08, y: -Math.cos(t * 0.08) * 0.08, size: 0.7 }
          ]
        : [
            { color: 'rgba(99, 102, 241, 0.09)', x: Math.sin(t * 0.08) * 0.12, y: Math.cos(t * 0.1) * 0.12, size: 0.8 },
            { color: 'rgba(217, 70, 239, 0.07)', x: Math.cos(t * 0.07) * 0.15, y: Math.sin(t * 0.09) * 0.15, size: 0.95 },
            { color: 'rgba(6, 182, 212, 0.08)', x: Math.sin(t * 0.11) * 0.08, y: -Math.cos(t * 0.08) * 0.08, size: 0.7 }
          ];

      for (const n of nebulae) {
        const nx = cx + n.x * currentScale;
        const ny = cy + n.y * currentScale;
        const rad = currentScale * n.size * 1.4;
        const grad = ctx.createRadialGradient(nx, ny, 0, nx, ny, rad);
        grad.addColorStop(0, n.color);
        grad.addColorStop(0.4, n.color.replace('0.', '0.04'));
        grad.addColorStop(1, isLight ? 'rgba(255,255,255,0)' : 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(nx, ny, rad, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Lớp 1: Tính toán phép chiếu 3D cho các ngôi sao thiên hà ──
      const backStars: any[] = [];
      const frontStars: any[] = [];

      for (const p of particles) {
        // Orbit around galactic axis (Z-axis spin)
        const spinTheta = p.theta + t * p.spinSpeed;
        const x1 = Math.cos(spinTheta) * p.r;
        const y1 = Math.sin(spinTheta) * p.r;
        const z1 = p.z;

        // Yaw transformation (rotation around Y-axis)
        const x2 = x1 * Math.cos(yaw) - z1 * Math.sin(yaw);
        const z2 = x1 * Math.sin(yaw) + z1 * Math.cos(yaw);

        // Pitch transformation (rotation around X-axis)
        const y3 = y1 * Math.cos(pitch) - z2 * Math.sin(pitch);
        const z3 = y1 * Math.sin(pitch) + z2 * Math.cos(pitch);

        // Perspective projection
        const perspective = focalLength / (focalLength + z3);
        const sx = cx + x2 * currentScale * perspective;
        const sy = cy + y3 * currentScale * perspective;

        const twinkle = 0.4 + 0.6 * Math.sin(t * p.sparkleSpeed + p.phase);
        const alpha = p.brightness * twinkle * (p.r < 0.22 ? 0.95 : 0.65);
        const size = p.size * (0.8 + 0.4 * twinkle) * dpr * perspective;

        const starDraw = {
          x: sx,
          y: sy,
          size,
          alpha,
           color: isLight ? '28, 25, 23' : p.color,
          large: p.size > 1.25,
          z3, // store depth for classification
          isSun: p.isSun,
          perspective
        };

        if (z3 > 0) {
          backStars.push(starDraw);
        } else {
          frontStars.push(starDraw);
        }
      }

      // ── Lớp 2: Tính toán phép chiếu 3D cho các bước chòm sao (Constellation nodes) ──
      const total = st.length;
      const pts = st.map((s, i) => {
        // Ghim thẳng các nút đại diện cho Agent vào các ngôi sao cụ thể của Dải Ngân Hà
        // i = 0 (Main Agent) → Hệ Mặt Trời (particle[0], isSun: true)
        // Các agent phụ → ghim vào sao ở các cánh xoắn ốc khác nhau (r lớn, dễ nhìn)
        // Particles 0..119 = thanh ngang trung tâm (quá gần nhau), 120..479 = 4 cánh xoắn ốc
        // Chọn sao trên các arm khác nhau: arm0 starts at 120, arm1 at 121, arm2 at 122, arm3 at 123
        // Mỗi arm có ~90 sao. Chọn sao ở giữa arm (~index 45) để có r vừa phải
        const armStarIndices = [0, 165, 256, 347, 210, 300, 390, 180, 270, 360]; // pre-computed good positions
        const pIdx = i < armStarIndices.length ? armStarIndices[i] : (120 + ((i * 37) % 360));
        const p = particles[pIdx];

        // Orbit around Z-axis spin (quay đồng bộ theo vòng quay cánh xoắn ốc của ngôi sao)
        const spinTheta = p.theta + t * p.spinSpeed;
        const sx = Math.cos(spinTheta) * p.r;
        const sy = Math.sin(spinTheta) * p.r;
        const sz = p.z;

        // Yaw transformation
        const sx2 = sx * Math.cos(yaw) - sz * Math.sin(yaw);
        const sz2 = sx * Math.sin(yaw) + sz * Math.cos(yaw);

        // Pitch transformation
        const sy3 = sy * Math.cos(pitch) - sz2 * Math.sin(pitch);
        const sz3 = sy * Math.sin(pitch) + sz2 * Math.cos(pitch);

        // Perspective projection
        const perspective = focalLength / (focalLength + sz3);
        const rawX = sx2;
        const rawY = sy3;

        return { s, rawX, rawY, zDepth: sz3, index: i, perspective };
      });

      // Điều khiển Camera Zoom & Pan để hướng vào ngôi sao được chọn (Virtual world camera control)
      let targetZoom = 1.0;
      let targetOffsetX = 0;
      let targetOffsetY = 0;

      if (sel) {
        const selPt = pts.find((p) => p.s.id === sel);
        if (selPt) {
          targetZoom = 2.4;
          targetOffsetX = selPt.rawX * currentScale * selPt.perspective;
          targetOffsetY = selPt.rawY * currentScale * selPt.perspective;
        }
      }

      // Nội suy mượt mà camera
      zoomRef.current += (targetZoom - zoomRef.current) * 0.08;
      offsetXRef.current += (targetOffsetX - offsetXRef.current) * 0.08;
      offsetYRef.current += (targetOffsetY - offsetYRef.current) * 0.08;

      const ptsProjected = pts.map((p) => {
        const screenX = cx + p.rawX * currentScale * p.perspective - offsetXRef.current;
        const screenY = cy + p.rawY * currentScale * p.perspective - offsetYRef.current;
        return { ...p, x: screenX, y: screenY };
      });

      // Hàm vẽ hạt sao
      const drawStarGroup = (group: any[]) => {
        for (const star of group) {
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${star.color},${star.alpha})`;
          ctx.fill();

          if (star.large) {
            ctx.beginPath();
            ctx.arc(star.x, star.y, star.size * 2.5, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${star.color},${star.alpha * 0.22})`;
            ctx.fill();
          }

          // Vẽ nhãn của Hệ Mặt Trời nếu được phóng to đủ gần
          if (star.isSun && zoomRef.current > 1.25) {
            ctx.save();
            ctx.font = theme === 'simple'
              ? `500 ${8.5 * dpr * star.perspective}px 'Inter', sans-serif`
              : `${8 * dpr * star.perspective}px ui-sans-serif, system-ui, sans-serif`;
            ctx.fillStyle = theme === 'simple' ? 'rgba(37, 99, 235, 0.95)' : 'rgba(253, 186, 116, 0.9)';
            ctx.textAlign = 'left';
            ctx.fillText('Hệ Mặt Trời ☀️', star.x + star.size + 3 * dpr, star.y + 2 * dpr);
            ctx.restore();
          }
        }
      };

      // ── RENDER PASS 1: Vẽ các ngôi sao ở phía sau (Z3 > 0) ──
      ctx.globalCompositeOperation = 'lighter';
      drawStarGroup(backStars);

      // ── RENDER PASS 2: Vẽ Nhân Thiên Hà 3D (Galactic Core) ──
      const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, currentScale * 0.16);
      coreGrad.addColorStop(0, isLight ? 'rgba(28, 25, 23, 0.7)' : 'rgba(255, 255, 255, 0.95)');
      coreGrad.addColorStop(0.2, isLight ? 'rgba(87, 83, 78, 0.35)' : 'rgba(254, 240, 138, 0.65)');
      coreGrad.addColorStop(0.5, isLight ? 'rgba(168, 162, 158, 0.12)' : 'rgba(236, 72, 153, 0.18)');
      coreGrad.addColorStop(1, isLight ? 'rgba(255, 255, 255, 0)' : 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, currentScale * 0.16, 0, Math.PI * 2);
      ctx.fill();

      // ── RENDER PASS 3: Vẽ các đường liên kết chòm sao 3D ──
      ctx.globalCompositeOperation = isLight ? 'source-over' : 'screen';
      for (let i = 0; i < ptsProjected.length; i++) {
        // Chỉ khép kín nếu N > 2. Với N=2 chỉ vẽ 1 đường thẳng
        if (i === ptsProjected.length - 1 && ptsProjected.length <= 2) {
          continue;
        }

        const a = ptsProjected[i];
        const b = ptsProjected[(i + 1) % ptsProjected.length];
        const [r, g, bl] = stepColor(b.s.type);
        const avgPersp = (a.perspective + b.perspective) / 2;

        // Glowing 3D constellation line
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = `rgba(${r},${g},${bl},${0.32 * avgPersp})`;
        ctx.lineWidth = 1.2 * dpr * avgPersp;
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.stroke();
        ctx.restore();

        // 3D Plasma spark (meteor)
        if (on && b.s.active) {
          const k = (t * 0.7) % 1;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          
          for (let j = 0; j < 3; j++) {
            const tk = k - j * 0.04;
            if (tk >= 0) {
               const tx = a.x + dx * tk;
               const ty = a.y + dy * tk;
               const size = (2.2 - j * 0.5) * dpr * b.perspective;
               ctx.beginPath();
               ctx.arc(tx, ty, size, 0, Math.PI * 2);
               ctx.fillStyle = `rgba(${r},${g},${bl},${(0.9 - j * 0.28) * b.perspective})`;
               ctx.fill();
            }
          }
        }
      }

      // ── RENDER PASS 4: Vẽ các nút chòm sao 3D (Đã nhân tỷ lệ Perspective) ──
      ctx.globalCompositeOperation = 'source-over';
      const hits: { id: string; x: number; y: number; r: number }[] = [];
      ptsProjected.forEach((p) => {
        const [r, g, bl] = stepColor(p.s.type);
        const isSel = sel === p.s.id;
        const isLast = p.index === ptsProjected.length - 1;
        
        const baseR = (p.s.active ? 7.2 : 5.8) * dpr;
        const pulse = p.s.active ? 0.8 + 0.2 * Math.sin(t * 3.5) : 1;
        
        // 3D perspective scales sizes!
        const size = baseR * pulse * p.perspective;

        // Expanding 3D stellar ripples
        if (p.s.active) {
          const waveT = (t * 2.5) % 1.0;
          const waveR = size + waveT * 22 * dpr * p.perspective;
          const waveA = (1 - waveT) * p.perspective;
          ctx.beginPath();
          ctx.arc(p.x, p.y, waveR, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${r},${g},${bl},${waveA * 0.7})`;
          ctx.lineWidth = 1 * dpr;
          ctx.stroke();
        }

        // Selected halo outer rings
        if (isSel) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, size + 6 * dpr * p.perspective, 0, Math.PI * 2);
          ctx.strokeStyle = isLight
            ? `rgba(28, 25, 23, ${0.9 * p.perspective})`
            : `rgba(255, 255, 255, ${0.9 * p.perspective})`;
          ctx.lineWidth = 1.6 * dpr * p.perspective;
          ctx.stroke();
          
          ctx.beginPath();
          ctx.arc(p.x, p.y, size + 9 * dpr * p.perspective, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${r},${g},${bl},${0.4 * p.perspective})`;
          ctx.lineWidth = 1.0 * dpr * p.perspective;
          ctx.stroke();
        }

        // Draw the 3D space object
        drawSpaceObject(ctx, p.x, p.y, size, p.s.type, t);

        // Hover or selected aura
        if (isSel || hoverId === p.s.id) {
          const haloA = (isSel ? 0.35 : 0.2) * p.perspective;
          ctx.beginPath();
          ctx.arc(p.x, p.y, size + 10 * dpr * p.perspective, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${r},${g},${bl},${haloA})`;
          ctx.fill();
        }

        // Draw agent name label — luôn hiển thị tên agent bên cạnh ngôi sao
        {
          const labelFont = theme === 'simple'
            ? `500 ${9 * dpr * p.perspective}px 'Inter', sans-serif`
            : `${8.5 * dpr * p.perspective}px ui-sans-serif, system-ui, sans-serif`;
          ctx.font = labelFont;
          const labelAlpha = (isSel || p.s.active) ? 0.95 : 0.7;
          ctx.fillStyle = isLight
            ? `rgba(28, 25, 23, ${labelAlpha * p.perspective})`
            : `rgba(255, 255, 255, ${labelAlpha * p.perspective})`;
          ctx.textAlign = 'center';
          // Hiển thị tên agent (bỏ "Agent" suffix nếu label quá dài)
          const shortLabel = p.s.label.replace(/ Agent$/, '');
          ctx.fillText(shortLabel, p.x, p.y - size - 6 * dpr * p.perspective);
        }

        // Save hit targets (convert to CSS coordinates)
        hits.push({
          id: p.s.id,
          x: p.x / dpr,
          y: p.y / dpr,
          r: (size + 10 * dpr) / dpr,
        });
      });

      hitsRef.current = hits;

      // ── RENDER PASS 5: Vẽ các ngôi sao ở phía trước (Z3 <= 0, che phủ nhẹ lên chòm sao) ──
      ctx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';
      drawStarGroup(frontStars);

      ctx.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Hit-test on rotated screen coordinates
  const pick = (clientX: number, clientY: number): BrainStep | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const hits = hitsRef.current;
    // Check in reverse order (closest first)
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (Math.hypot(x - h.x, y - h.y) <= h.r) {
        return stepsRef.current.find((s) => s.id === h.id) ?? null;
      }
    }
    return null;
  };

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        borderRadius: '12px',
        cursor: hoverId ? 'pointer' : 'default',
      }}
      onClick={(e) => {
        const step = pick(e.clientX, e.clientY);
        if (step) onSelect(step);
      }}
      onMouseMove={(e) => {
        const step = pick(e.clientX, e.clientY);
        setHoverId(step ? step.id : null);
      }}
      onMouseLeave={() => setHoverId(null)}
    />
  );
}
