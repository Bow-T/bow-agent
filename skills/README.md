# Skill của bow-agent

Thư mục này chứa các **skill dùng chung** — áp cho MỌI repo mà agent thao tác
(khác với `.claude/skills/` của từng repo đích, do SDK tự nạp).

Có 2 loại skill:

## 1. Skill prompt-only (`prompt/*.md`)

Mỗi file `.md` là một hướng dẫn/quy trình. Toàn bộ được gộp vào system prompt
của agent qua `src/skills/index.ts`. Không cần code. Dùng cho: quy ước code,
checklist, quy trình nghiệp vụ.

Định dạng: Markdown thường. Nên có tiêu đề `#` ngắn gọn ở đầu để agent nhận diện.

## 2. Skill kèm code (`src/skills/*.ts`)

Skill cần chạy logic thật (đọc file, chạy lệnh, gọi API) — viết bằng TypeScript
dùng `tool()` của Claude Agent SDK, gom vào server nội bộ `bow-skills`
(xem `src/skills/code.ts`). Agent gọi qua tool `mcp__bow-skills__<tên>`.

- Skill chỉ ĐỌC / kiểm chứng an toàn → auto-allow.
- Skill có side-effect (ghi/xóa/gọi API thay đổi) → phải qua cổng duyệt.

## Skill của repo đích

Ngoài 2 loại trên, agent còn tự nạp `.claude/skills/*/SKILL.md` của repo đang
làm việc (SDK auto-discover khi `settingSources: ['project']` + `skills: 'all'`).
Không cần khai báo gì thêm ở đây.
