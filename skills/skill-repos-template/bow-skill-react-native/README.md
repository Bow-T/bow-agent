# bow-skill-react-native

Bộ **skill dùng chung** cho stack **React Native + Supabase** của team Bow, dùng
với [bow-agent](https://github.com/Bow-T/bow-agent). Đây là repo mẫu — copy cấu
trúc này để tạo skill cho stack khác.

## Repo này chứa gì

```
bow-skill-react-native/
├── bow-skill.json          # manifest: id stack, version, danh sách skill, targets
├── skills/                 # mỗi folder con = 1 skill (có SKILL.md)
│   ├── rn-realtime/SKILL.md
│   ├── rn-convention/SKILL.md
│   └── rn-supabase-data/SKILL.md
└── README.md
```

bow-agent tải repo này (ghim theo tag), rồi **trải** các folder trong `skills/`
vào `.claude/skills/` của repo đích để Claude tự nhận và dùng qua tool `Skill`.

## Cách tạo repo skill cho stack mới (dành cho maintainer)

1. **Copy repo mẫu này**, đổi tên (vd `bow-skill-vue`, `bow-skill-nextjs`).
2. Sửa `bow-skill.json`:
   - `id`: định danh stack, kebab-case, duy nhất (vd `vue-supabase`).
   - `label`: tên hiển thị trong UI chọn stack (vd `Vue + Supabase`).
   - `version`: semver — **tăng mỗi lần đổi nội dung skill**.
   - `skills`: liệt kê đúng tên các folder trong `skills/`.
   - `targets.detect`: dấu hiệu nhận ra repo hợp stack này (file/thư mục đặc
     trưng) — giúp bow gợi ý stack đúng cho repo kiểu monorepo.
3. Viết từng `skills/<tên>/SKILL.md`:
   - **Bắt buộc** frontmatter `name` + `description` (Claude dùng `description`
     để quyết định khi nào gọi skill — viết rõ *khi nào dùng*).
   - Thân bài: hướng dẫn/checklist/ví dụ code cụ thể của team.
   - Liên kết skill khác bằng `[[tên-skill]]`.
4. **Gắn tag** cho mỗi bản phát hành: `git tag v0.1.0 && git push --tags`.
   bow-agent luôn tải theo tag (không lấy `main`) để bản đã duyệt không đổi ngầm.
5. Gửi URL repo + tag cho **admin bow-agent** để thêm vào registry (chỉ repo
   trong registry mới được tải).

## Định dạng SKILL.md

Giống hệt skill nội bộ của bow-agent — xem ví dụ trong `skills/*/SKILL.md`.
Trường hay dùng trong frontmatter:

| Trường | Bắt buộc | Ý nghĩa |
|---|---|---|
| `name` | ✅ | Định danh skill, kebab-case, khớp tên folder |
| `description` | ✅ | Mô tả + **khi nào dùng** — Claude đọc để tự chọn skill |
| `version` | — | Semver của riêng skill |
| `allowed-tools` | — | Giới hạn tool skill được dùng |
| `user-invocable` | — | Cho gọi trực tiếp bằng `/tên-skill` |
