# Thiết kế: Genome — "ADN sống" của Bow-Agent

Tài liệu này mô tả cơ chế **tự tiến hóa** của bow-agent: agent giữ lại tri thức về
từng repo qua các lần chạy, và tri thức đó tự tốt lên theo kết quả thật — thay vì
"đóng băng" sau khi sinh như profile tĩnh.

## 1. Vì sao có genome

Ẩn dụ khởi nguồn (từ sinh học phân tử):

- **ADN không "suy nghĩ"** — nó là *công thức* để dựng bộ máy suy nghĩ, và công thức đó
  *tiến hóa qua từng thế hệ* nhờ chọn lọc tự nhiên.
- Áp vào agent: profile dự án hiện tại (`generated-profiles/*.md`) là **tĩnh** — quét
  repo một lần rồi đóng băng. **Genome** là phần tri thức **động**: mỗi task để lại một
  "gen" (một điều đã học về repo), có điểm sức khỏe (fitness), và bộ gen tự tiến hóa để
  lần sau làm nhanh + ít sai hơn.

Đây là lời giải cho giới hạn "học suốt đời, không quên" của agent LLM: tri thức được
**củng cố qua các phiên** thay vì mất đi khi phiên kết thúc.

Ánh xạ sinh học → code:

| Sinh học | Trong bow-agent | Vị trí |
|---|---|---|
| ADN (bộ gen) | `Genome.traits[]` — các câu tri thức về repo | `core/genome.ts` |
| Phiên mã (ADN→protein) | Nạp gen khỏe nhất vào system prompt | `expressGenome()` |
| Cá thể sống | Một lần `runAgent()` execute trên 1 task | `core/runner.ts` |
| Chọn lọc (fitness) | Task thành công? Ít turn? | `reward()` + `applySelection()` |
| Đột biến | Agent tự phản tư → sinh gen mới | `core/reflect.ts` |
| Đào thải | Gen vừa yếu vừa già bị xóa | `applySelection()` (cull) |

## 2. Cấu trúc dữ liệu

Một genome cho mỗi repo, lưu ở `memory/genome/<repo>.json` (khóa = tên chuẩn hóa từ
đường dẫn cwd, tái dùng `profileNameFromCwd`).

```jsonc
{
  "repo": "/path/to/repo",
  "generation": 7,           // số task execute đã trải qua
  "traits": [                // các "gen"
    {
      "id": "g4",            // định danh ổn định trong 1 genome
      "gene": "Repo dùng Riverpod, không setState",
      "fitness": 0.88,       // 0..1, tiến hóa theo kết quả
      "bornGen": 2,          // thế hệ gen ra đời (để tính tuổi khi đào thải)
      "usedCount": 5         // số lần được biểu hiện vào prompt
    }
  ],
  "history": [               // dấu vết mỗi task (áp lực chọn lọc)
    { "gen": 6, "task": "JIRA-812 ...", "success": true, "turns": 14,
      "outputTokens": 3200, "expressedIds": ["g4","g1"] }
  ]
}
```

## 3. Vòng đời — 4 lực tiến hóa

```
        ┌──────────── GENOME (memory/genome/<repo>.json) ────────────┐
        │  traits[] có fitness tiến hóa  +  history[]  +  generation  │
        └───────┬────────────────────────────────────────▲───────────┘
      EXPRESS   │ (gen khỏe nhất → prompt)                │
                ▼                                          │
         [runner chạy task execute]                       │
                │                                          │
    RECORD +    │  SELECTION (EMA + cull)     MUTATION (reflect → gen mới)
                └──────────────► GENOME ◄──────────────────┘
```

### (1) EXPRESS — biểu hiện

`expressGenome(genome)` chọn tối đa **12 gen khỏe nhất** (fitness giảm dần) và dựng
thành một đoạn nhồi vào system prompt, ngay sau `projectProfile`. Gen yếu im lặng —
đây là "áp lực chọn lọc ở tầng dùng". Genome rỗng → trả `''` (agent chạy như thường).

`expressedIds(genome)` trả đúng tập id vừa được biểu hiện, để bước chọn lọc gán
công/tội chính xác cho những gen thực sự tham gia task.

### (2) RECORD — ghi dấu vết

Sau một task **execute** (không tính `plan` — chưa tạo hệ quả đúng/sai),
`recordTaskOutcome()` +1 thế hệ và đẩy một dòng vào `history` (kèm `expressedIds`).
Ghi **cả thất bại** — chọn lọc cần biết gen nào dẫn tới hỏng.

### (3) SELECTION — chọn lọc (áp lực Darwin)

`applySelection(genome, expressedIds, outcome)`:

- **Reward** một task (`reward()`): thất bại → 0.1. Thành công gọn (≤15 turn) → ~1.0;
  càng nhiều turn reward càng về 0.6 → thưởng gen giúp làm **gọn**, không chỉ **xong**
  (tinh thần "não 20W: rẻ = tốt").
- **Cập nhật fitness (EMA, α=0.2)**: chỉ các gen **đã biểu hiện** được kéo về phía
  reward; gen không tham gia giữ nguyên. `fitness ← 0.8·fitness + 0.2·reward`.
- **Đào thải (cull)**: gen bị xóa khi **fitness < 0.25 VÀ tuổi ≥ 3 thế hệ**. Điều kiện
  tuổi là "thời gian ân xá" — gen mới không bị giết trước khi kịp chứng minh.

### (4) MUTATION — đột biến

`reflectAndMutate()` (trong `reflect.ts`): sau task, chạy **một lượt agent phản tư
ngắn** (`effort: low`, `maxTurns: 2`, không tool, không đọc lại repo) nhìn đề bài +
kết quả, rút **tối đa 3 câu** tri thức mới về repo. Các câu này qua `mutateGenome`:

- chống trùng (chuẩn hóa dấu câu/hoa-thường),
- gen mới nhận fitness trung tính **0.6** (không cho model tự đặt điểm),
- giới hạn ≤3 gen mới/lần, tổng ≤40 gen (đẩy gen yếu nhất ra khi vượt).

Bước này **không bao giờ ném lỗi** — mọi trục trặc trả 0, không ảnh hưởng task.

## 4. Tham số (chỗ chỉnh khi tinh chỉnh)

Tất cả nằm ở đầu `core/genome.ts`:

| Hằng | Giá trị | Ý nghĩa |
|---|---|---|
| `MAX_EXPRESSED` | 12 | Số gen tối đa nhồi vào prompt mỗi task |
| `MAX_NEW_PER_MUTATION` | 3 | Số gen mới tối đa nhận mỗi lần đột biến |
| `INITIAL_FITNESS` | 0.6 | Fitness khởi tạo cho gen mới |
| `MAX_TRAITS` | 40 | Tổng gen tối đa một genome giữ |
| `MAX_HISTORY` | 200 | Số dòng history giữ lại |
| `FITNESS_ALPHA` | 0.2 | Tốc độ học fitness (EMA) |
| `EFFICIENT_TURNS` | 15 | Ngưỡng turn coi là "hiệu quả tốt" |
| `CULL_FITNESS` | 0.25 | Ngưỡng fitness để xét đào thải |
| `CULL_MIN_AGE` | 3 | Tuổi tối thiểu trước khi đào thải gen yếu |

## 5. Bật/tắt & an toàn

- **MẶC ĐỊNH TẮT (opt-in).** Bật bằng cờ CLI `--genome` hoặc `RunOptions.useGenome =
  true`. Chỉ ghi + tiến hóa genome ở mode `execute` khi đã bật.
- Genome chỉ **thêm tri thức vào prompt** — không cấp quyền mới, không bỏ qua cổng
  duyệt. Quy trình plan-then-approve giữ nguyên.
- Prompt biểu hiện dặn rõ: *"nếu thực tế repo mâu thuẫn với một mục, tin repo và bỏ
  mục đó"* — gen là gợi ý, không phải luật.
- File genome nằm trong `memory/genome/` — đã gitignore (dữ liệu runtime per-repo,
  không thuộc repo công cụ).

## 5b. Vì sao opt-in — bằng chứng A/B

Đã chạy 5 thí nghiệm A/B (cùng task, chỉ khác genome bật/tắt). Kết luận có bằng chứng:

- **Repo nhỏ / task rõ / model mạnh (Opus 4.8)** → genome **KHÔNG** tạo khác biệt.
  Với bẫy quy ước (đọc code là thấy) và cả bẫy runtime (null-deref), agent-không-genome
  vẫn tự làm đúng. Genome chỉ lặp lại thứ model đã suy ra được → **chi phí token thừa**.
- **Repo LỚN thật (monorepo Octopus, Flutter)** → genome **CÓ** tạo khác biệt. Nó học
  được tri thức cross-cutting không nằm gọn trong một file, ví dụ: *"thêm service phải
  cập nhật 3 nơi: locator.dart + base_vm.dart + VM"*, *"repo dùng AutoRoute, thêm route
  phải regen .gr.dart"*. Trong A/B, kế hoạch **có genome** nhắc đúng `locator.dart` +
  `base_vm` (nơi phải sửa khi thêm service); kế hoạch **không genome** bỏ sót chúng.

→ Vì vậy để mặc định TẮT, chỉ bật cho repo lớn nơi lợi ích vượt chi phí prompt.

## 6. Chưa làm (hướng mở rộng)

- **User-edit signal**: `HistoryEntry.userEdits` đã có chỗ nhưng chưa nối — đo việc
  người dùng sửa tay sau task là signal chất lượng mạnh nhất.
- **Sinh sản hữu tính**: trộn gen giữa hai repo cùng stack (2 dự án Flutter+Supabase
  chia sẻ gen chung) — lúc ẩn dụ ADN thành thật nhất.
- **UI genome**: hiển thị traits + fitness trên web để người dùng xem/sửa/xóa gen tay.
