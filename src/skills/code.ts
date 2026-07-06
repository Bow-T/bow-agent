import { execSync } from 'node:child_process';
import { z } from 'zod';
import { tool, createSdkMcpServer, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

/**
 * Skill KÈM CODE của bow-agent — chạy logic thật trong tiến trình, gom vào một
 * server nội bộ tên "bow-skills". Agent gọi qua tool mcp__bow-skills__<tên>.
 *
 * Quy ước: skill chỉ ĐỌC / kiểm chứng an toàn → auto-allow (xem READ_TOOLS bên
 * dưới, runner tự thêm vào allowedTools). Skill có side-effect thì KHÔNG liệt vào
 * READ_TOOLS để nó phải qua cổng duyệt.
 */

/** Skill: chạy lệnh test/kiểm tra của repo rồi tóm tắt pass/fail. */
const runTests = tool(
  'run_tests',
  'Chạy lệnh test/kiểm tra của repo (vd "npm test", "fvm flutter test", "tsc --noEmit") ' +
    'trong thư mục làm việc và trả về tóm tắt kết quả pass/fail cùng đuôi log. ' +
    'Dùng để KIỂM CHỨNG sau khi sửa code. Chỉ chạy lệnh test/analyze, không dùng cho lệnh thay đổi trạng thái.',
  {
    command: z.string().describe('Lệnh test cần chạy, vd "npm test" hoặc "fvm flutter analyze".'),
    cwd: z.string().describe('Thư mục làm việc (đường dẫn tuyệt đối của repo đích).'),
  },
  async ({ command, cwd }) => {
    try {
      const out = execSync(command, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000, // 5 phút — test lớn có thể lâu.
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        content: [{ type: 'text' as const, text: summarize(command, 0, out) }],
      };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      const combined = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || 'Không có output.';
      return {
        content: [{ type: 'text' as const, text: summarize(command, e.status ?? 1, combined) }],
      };
    }
  },
);

/** Gói output test thành tóm tắt gọn: trạng thái + đuôi log (tránh nhồi cả nghìn dòng). */
function summarize(command: string, exitCode: number, output: string): string {
  const status = exitCode === 0 ? '✅ PASS (exit 0)' : `❌ FAIL (exit ${exitCode})`;
  const lines = output.split('\n');
  const TAIL = 60;
  const tail = lines.length > TAIL ? lines.slice(-TAIL).join('\n') : output;
  const note = lines.length > TAIL ? `\n… (${lines.length - TAIL} dòng đầu đã lược)\n` : '';
  return `Lệnh: ${command}\nKết quả: ${status}\n${note}\n--- Log ---\n${tail}`;
}

/** Tên các tool skill ĐỌC/kiểm-chứng an toàn — runner auto-allow (không phải duyệt). */
export const BOW_SKILLS_READ_TOOLS = ['mcp__bow-skills__run_tests'];

/** Server nội bộ gom mọi skill kèm code. Truyền vào option mcpServers của query(). */
export function buildSkillsServer(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'bow-skills',
    version: '1.0.0',
    tools: [runTests],
  });
}
