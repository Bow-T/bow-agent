import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Frontend React cho bow-agent. Nguồn ở web/, build ra dist-web/ (server phục vụ).
 * Trong dev, Vite proxy /api → backend Express.
 *
 * Cổng lấy từ env để chạy song song nhiều bản (vd dev + QC/Safe Mode cùng máy):
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
      },
    },
  },
});
