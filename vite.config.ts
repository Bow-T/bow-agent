import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Frontend React cho bow-agent. Nguồn ở web/, build ra dist-web/ (server phục vụ).
 * Trong dev, Vite proxy /api → backend Express (cổng 4000).
 */
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
