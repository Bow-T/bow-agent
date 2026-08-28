# Sổ tay phiên — giữ context qua compact (PreCompact + SessionStart)

**Vấn đề:** phiên dài trong repo này liên tục báo "Phiên đã đầy context" rồi tự compact.
Compact là nén có mất mát; user muốn ở lại CÙNG cửa sổ mà không mất việc đang làm dở.

## Cơ chế (3 tầng, tầng 3 là cái đã dựng)

1. `autoCompactWindow` (setting) / `/autocompact` — ngưỡng compact = **min(setting, trần
   context của model)**. Nới lên = lâu bị dọn hơn.
2. `/compact <chỉ đạo>` chủ động — tự chọn cái được giữ, thay vì để nó tự đoán.
3. **Context bền ra file** (đã dựng):
   - `.claude/hooks/session-notes-dump.py` — hook **PreCompact**: đọc `transcript_path`
     từ stdin JSON, trích prompt người thật + file Edit/Write + `git status` + nhánh, ghi
     `.claude/session-notes.md` (giữ 3 mốc gần nhất, mới nhất trên cùng).
   - `.claude/hooks/session-notes-load.py` — hook **SessionStart**: trả
     `hookSpecificOutput.additionalContext` nạp file đó lại. **Bỏ qua khi `source == "clear"`**
     (user cố ý xoá thì đừng nhồi lại).
   - `.claude/session-notes.md` đã gitignore (riêng theo máy).

## Bẫy đã gặp

- Nhận diện prompt người: transcript mới có `origin.kind == "human"`, **bản cũ KHÔNG có
  `origin`** → phải fallback "user record không chứa block tool_use/tool_result và text
  không mở đầu bằng `<`" (system-reminder). Lọc cứng theo `origin` sẽ mất sạch phiên cũ.
- Ở auto mode agent sửa file bằng **Bash sed/heredoc**, không qua Edit/Write → danh sách
  "file đã sửa" trích từ tool_use sẽ trống. `git status --porcelain` mới là nguồn thật.
- Một phiên 3 MB có thể chỉ có **1** prompt người (agent chạy dài) — dung lượng transcript
  đến từ tool result, không từ số lượt gõ.

Pairs với [[bow-token-real-levers]], [[bow-auto-resume-session-limit]].
