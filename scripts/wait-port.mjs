#!/usr/bin/env node
/**
 * Chờ backend Express mở cổng rồi mới cho Vite chạy.
 *
 * Không có bước chờ này, Vite lên trước backend nên mọi request proxy đầu tiên
 * (/api/access/status, /api/events/:id) đổ ECONNREFUSED đỏ terminal và tab web
 * phải reload tay. Cổng lấy từ BOW_AGENT_PORT (mặc định 4000) — khớp vite.config.ts.
 *
 * Hết thời gian chờ vẫn thoát 0: coi như backend hỏng, để Vite lên cho người dùng
 * thấy lỗi thật thay vì treo im lặng.
 */
import net from 'node:net';

const port = Number(process.env.BOW_AGENT_PORT ?? 4000);
const timeoutMs = Number(process.env.BOW_WAIT_PORT_TIMEOUT_MS ?? 60_000);
const deadline = Date.now() + timeoutMs;

const probe = () =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

while (Date.now() < deadline) {
  if (await probe()) process.exit(0);
  await sleep(150);
}

console.warn(`[wait-port] backend chưa mở cổng ${port} sau ${timeoutMs}ms — vẫn chạy Vite.`);
process.exit(0);
