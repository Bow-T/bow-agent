import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Frontend React cho bow-agent. Nguồn ở web/, build ra dist-web/ (server phục vụ).
 * Trong dev, Vite proxy /api → backend Express.
 *
 * Cổng lấy từ env để chạy song song nhiều bản (vd dev + QC Mode cùng máy):
 * - BOW_WEB_PORT: cổng Vite (mặc định 5173).
 * - BOW_AGENT_PORT: cổng backend Express để proxy /api trỏ tới (mặc định 4000).
 * Hai giá trị phải khớp cặp cổng của backend đi kèm.
 */
const webPort = Number(process.env.BOW_WEB_PORT ?? 5173);
const apiPort = Number(process.env.BOW_AGENT_PORT ?? 4000);

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
  server: {
    port: webPort,
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        xfwd: true,
        // Backend (tsx transpile server.ts) lên CHẬM hơn Vite vài giây → trong cửa sổ đó
        // mọi /api bị ECONNREFUSED và Vite mặc định trả 500 khó hiểu. Bắt lỗi proxy để
        // trả 503 kèm message rõ ràng: "backend đang khởi động, thử lại" thay vì 500.
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            const connRefused = (err as NodeJS.ErrnoException).code === 'ECONNREFUSED';
            // res có thể là ServerResponse (HTTP) hoặc Socket (WebSocket upgrade) — chỉ
            // ghi JSON khi là HTTP response chưa gửi header.
            if ('writeHead' in res && !res.headersSent) {
              res.writeHead(connRefused ? 503 : 502, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: connRefused
                    ? `Backend (cổng ${apiPort}) chưa sẵn sàng — có thể đang khởi động hoặc đã tắt. Đợi vài giây rồi thử lại.`
                    : `Lỗi proxy tới backend cổng ${apiPort}: ${err.message}`,
                })
              );
            } else if ('destroy' in res) {
              res.destroy();
            }
          });
        },
      },
    },
  },
});
