import { useEffect, useRef, useState } from 'react';

/**
 * Bộ não neuron TƯƠNG TÁC — vẽ bằng <canvas>, thuần code (không ảnh/CDN ngoài,
 * hợp CSP của web). Nền là hàng trăm hạt sáng xếp thành hình bộ não; PHỦ LÊN trên
 * là các "điểm liên kết" = từng BƯỚC agent đang/đã làm (start → tool → kết quả…),
 * nối tiếp nhau bằng sợi sáng theo thứ tự thời gian.
 *
 * - Bước đang chạy (`active`) đập sáng mạnh + xung điện chạy tới nó.
 * - Click vào một điểm → gọi onSelect(step) để nơi khác hiện "đang làm gì ở bước đó".
 * - Điểm đang chọn có vòng nhấn mạnh.
 *
 * Không phụ thuộc theme app: khối này luôn nền tối kiểu "ảnh não neuron".
 */

/** Một bước trong dòng hoạt động — khớp với pipelineNodes ở App.tsx. */
export interface BrainStep {
  id: string;
  type: string; // start | tool | result | error | approval | thinking
  label: string;
  detail?: string;
  active?: boolean;
  count?: number;
}

interface Particle {
  bx: number;
  by: number;
  phase: number;
  speed: number;
  size: number;
  depth: number;
}

/** Biên dạng não nhìn nghiêng trong [-1,1]². >0 = trong não. Ghép vài ellipse. */
function insideBrain(x: number, y: number): number {
  const main = 1 - ((x * 0.92) ** 2 + (y * 1.15) ** 2);
  const front = 1 - (((x + 0.55) / 0.5) ** 2 + ((y + 0.1) / 0.55) ** 2);
  const back = 1 - (((x - 0.55) / 0.5) ** 2 + ((y - 0.05) / 0.6) ** 2);
  const cere = 1 - (((x - 0.4) / 0.42) ** 2 + ((y - 0.62) / 0.42) ** 2);
  const stem = 1 - (((x - 0.15) / 0.16) ** 2 + ((y - 0.85) / 0.3) ** 2);
  return Math.max(main, front, back, cere, stem);
}

function makeParticles(n: number): Particle[] {
  let seed = 20260706;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const out: Particle[] = [];
  let guard = 0;
  while (out.length < n && guard < n * 40) {
    guard++;
    const x = rnd() * 2 - 1;
    const y = rnd() * 2 - 1;
    const d = insideBrain(x, y);
    if (d <= 0) continue;
    if (d < 0.12 && rnd() > 0.55) continue;
    out.push({
      bx: x,
      by: y,
      phase: rnd() * Math.PI * 2,
      speed: 0.6 + rnd() * 1.8,
      size: 0.5 + rnd() * 1.6,
      depth: rnd(),
    });
  }
  return out;
}

/** Màu theo loại bước. */
function stepColor(type: string): [number, number, number] {
  switch (type) {
    case 'start': return [56, 189, 248]; // cyan
    case 'tool': return [74, 222, 128]; // xanh lá
    case 'result': return [74, 222, 128]; // xanh lá
    case 'error': return [248, 113, 113]; // đỏ
    case 'approval': return [251, 191, 36]; // vàng
    case 'thinking': return [167, 139, 250]; // tím
    default: return [125, 211, 252];
  }
}

/**
 * Đặt các bước lên hình não theo một "đường xương sống" đi từ trước (trán) ra sau
 * (chẩm) rồi vòng xuống — tất định theo index, không phụ thuộc số bước, để điểm luôn
 * nằm trong não và trải đều. Trả về toạ độ chuẩn hoá [-1,1].
 */
function stepPos(i: number, total: number): { x: number; y: number } {
  if (total <= 1) return { x: -0.1, y: 0 };
  const t = i / (total - 1); // 0..1
  // Đường cong chữ S nằm trong biên dạng não: bắt đầu vùng trán trên-trái,
  // uốn xuống giữa, kết ở tiểu não/thân dưới-phải.
  const x = -0.62 + 1.15 * t + 0.12 * Math.sin(t * Math.PI * 2);
  const y = -0.42 + 0.9 * t * t + 0.18 * Math.sin(t * Math.PI * 3);
  // Kéo về trong não nếu lỡ ra ngoài.
  let px = x, py = y;
  if (insideBrain(px, py) <= 0.02) {
    const m = Math.hypot(px, py) || 1;
    px = (px / m) * 0.7;
    py = (py / m) * 0.7;
  }
  return { x: px, y: py };
}

export function NeuralBrain({
  active,
  steps,
  selectedId,
  onSelect,
}: {
  active: boolean;
  steps: BrainStep[];
  selectedId: string | null;
  onSelect: (step: BrainStep) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(active);
  const stepsRef = useRef(steps);
  const selRef = useRef(selectedId);
  activeRef.current = active;
  stepsRef.current = steps;
  selRef.current = selectedId;

  // Lưu vùng bấm của mỗi điểm (pixel) để hit-test khi click.
  const hitsRef = useRef<{ id: string; x: number; y: number; r: number }[]>([]);
  const [hoverId, setHoverId] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const particles = makeParticles(480);
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

    const draw = () => {
      const W = canvas.width;
      const H = canvas.height;
      t += 0.016;
      const on = activeRef.current;
      const st = stepsRef.current;
      const sel = selRef.current;

      // Nền tối gradient tròn.
      ctx.clearRect(0, 0, W, H);
      const bg = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.7);
      bg.addColorStop(0, '#0a1a33');
      bg.addColorStop(1, '#03060f');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      const cx = W * 0.5;
      const cy = H * 0.47;
      const scale = Math.min(W, H) * 0.42;
      const sway = Math.sin(t * 0.35) * 0.03;

      // ── Lớp 1: hạt "mô não" nền (cộng sáng) ──
      ctx.globalCompositeOperation = 'lighter';
      for (const p of particles) {
        const px = p.bx + sway * p.by;
        const py = p.by - sway * p.bx;
        const x = cx + px * scale;
        const y = cy + py * scale;
        const flick = 0.5 + 0.5 * Math.sin(t * p.speed + p.phase);
        const base = on ? 0.28 : 0.15;
        const amp = on ? 0.5 : 0.32;
        const alpha = Math.min(1, (base + amp * flick) * (0.4 + 0.6 * p.depth));
        const r = p.size * (0.6 + 0.7 * p.depth) * dpr;
        ctx.beginPath();
        ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(56,189,248,${alpha * 0.18})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(186,230,253,${alpha * 0.85})`;
        ctx.fill();
      }

      // ── Lớp 2: các BƯỚC (điểm liên kết) + sợi nối theo thứ tự ──
      const total = st.length;
      const pts = st.map((s, i) => {
        const pos = stepPos(i, total);
        const px = pos.x + sway * pos.y;
        const py = pos.y - sway * pos.x;
        return { s, x: cx + px * scale, y: cy + py * scale };
      });

      // Sợi nối giữa các bước liên tiếp.
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const [r, g, bl] = stepColor(b.s.type);
        // Sợi nền mờ.
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = `rgba(${r},${g},${bl},0.28)`;
        ctx.lineWidth = 1.4 * dpr;
        ctx.stroke();
        // Xung điện chạy dọc sợi tới bước đang active.
        if (on && b.s.active) {
          const k = (t * 0.9) % 1;
          const ex = a.x + (b.x - a.x) * k;
          const ey = a.y + (b.y - a.y) * k;
          ctx.beginPath();
          ctx.arc(ex, ey, 2.4 * dpr, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${r},${g},${bl},0.95)`;
          ctx.fill();
        }
      }

      // Điểm của từng bước — lưu hit vùng bấm.
      const hits: { id: string; x: number; y: number; r: number }[] = [];
      pts.forEach((p, i) => {
        const [r, g, bl] = stepColor(p.s.type);
        const isSel = sel === p.s.id;
        const isLast = i === pts.length - 1;
        const pulse = p.s.active ? 0.5 + 0.5 * Math.sin(t * 3.2) : 1;
        const baseR = (p.s.active ? 6 : 4.5) * dpr;
        const rr = baseR * (p.s.active ? 0.85 + 0.3 * pulse : 1);

        // Halo ngoài (active hoặc chọn thì rõ hơn).
        const haloA = isSel ? 0.4 : p.s.active ? 0.3 * pulse : 0.16;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr + 8 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${bl},${haloA})`;
        ctx.fill();

        // Vòng chọn.
        if (isSel) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr + 5 * dpr, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,255,255,0.85)`;
          ctx.lineWidth = 1.6 * dpr;
          ctx.stroke();
        }

        // Lõi điểm.
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${bl},1)`;
        ctx.fill();
        // Chấm trắng lõi cho nổi.
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fill();

        // Nhãn số thứ tự nhỏ trên bước cuối/active để dễ định vị "đang ở đâu".
        if (isLast || p.s.active) {
          ctx.font = `${9 * dpr}px ui-sans-serif, system-ui, sans-serif`;
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
          ctx.textAlign = 'center';
          ctx.fillText(`${i + 1}`, p.x, p.y - rr - 6 * dpr);
        }

        // Vùng bấm rộng hơn lõi cho dễ chạm (chia dpr về toạ độ CSS).
        hits.push({ id: p.s.id, x: p.x / dpr, y: p.y / dpr, r: (rr + 8 * dpr) / dpr });
      });
      hitsRef.current = hits;

      ctx.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // Hit-test: trả bước tại toạ độ CSS (x,y) trong canvas, hoặc null.
  const pick = (clientX: number, clientY: number): BrainStep | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    // Duyệt ngược để ưu tiên điểm vẽ sau (trên cùng).
    const hits = hitsRef.current;
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
        borderRadius: '4px',
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
