# COSMOS — Bản thiết kế đạo diễn (v2 · "Living Consciousness")

> Trực quan hoá **ý thức sống của bow-agent** như một vũ trụ có thể bay vào.
> Người dùng không xem một sơ đồ — họ **du hành bên trong bộ não của một AI**.
> Cảm xúc đầu tiên phải là: *"Wow… mình chưa từng thấy một giao diện nào như thế này."*
>
> Tài liệu này là **hợp đồng thiết kế**. Viết TRƯỚC khi thi công. Nền thật: `three.js 0.161`
> thuần, engine ở [web/CosmosOverlay.tsx](web/CosmosOverlay.tsx), dữ liệu thật từ
> `/api/filetree` + SSE `/api/events/:id`, token màu `--step-*` ở [styles.css](web/styles.css).

---

## 0. Chỉ thị lại (đọc trước — v2 khác v1 ở đâu)

v1 đã dựng được một engine chạy thật, nhưng **vẫn đọc như một node graph trôi trong không
gian**. Đó là thất bại về *thế giới quan*, không phải về kỹ thuật. Nguyên nhân gốc, đã chẩn đoán:

| Triệu chứng "giống graph" | Nguyên nhân trong code v1 | Chữa ở v2 |
| --- | --- | --- |
| Đối xứng như mặt đồng hồ | 7 nguồn trên 1 vòng `ang`, galaxy chia đều `(gi/nG)·2π` trên `ringR=30` | **Bất đối xứng có chủ đích**: cụm, khoảng trống, seed-noise. Không vòng tròn đều nào. |
| Không có cảm giác quy mô | lõi r≈3.4, nguồn r≈2.0, sao r≈1.2 — gần bằng nhau | **Hierarchy scale mạnh**: AI Core áp đảo (≥8×), xuống dần rõ rệt tới hạt bụi. |
| Phẳng | `depth` chỉ ±40 | **Depth hàng nghìn units trên Z**: có thiên hà rất gần, có thiên hà cực xa. |
| Đường nối giống edge | inflow là đường cong nhẹ về lõi | **Energy stream cong mạnh** (Catmull-Rom), hạt có vận tốc, sáng theo data-flow. |
| Mọi sao trông giống nhau | 1 texture, 1 shader cho tất cả | **Đa dạng thiên thể**: red giant, white pulsar, wormhole, cluster… theo *loại*. |

**Giữ lại (xương đã chứng minh — KHÔNG viết lại):** `WebGLRenderer`+`EffectComposer`, vòng lặp
`requestAnimationFrame`, dispose sạch ở cleanup, wiring SSE→nhiệt (`activeFiles`/`activeSources`
qua ref), quality-tier auto-degrade, camera damping/drift, living-universe `visitWeight`, DoF/bloom
chọn lọc. **Thay:** toàn bộ tầng *world-building & thẩm mỹ* (bố cục, hình khối, màu, chuyển động).

## Bốn định luật đạo diễn (không nhượng bộ — giữ nguyên từ v1)

1. **Đẹp phải phục vụ ý nghĩa.** Mỗi thiên thể *có ngữ nghĩa* trỏ về một sự thật của bow-agent
   (file thật, MCP thật, reasoning event thật). Sao trang trí là *nền thẩm mỹ*, tách bạch rõ.
2. **Immersion không nuốt tính dùng được.** Cosmos là *chế độ khám phá*; luôn có `ESC` thoát về
   UI phẳng. Không ép mọi thao tác thành "lái tàu vũ trụ".
3. **Performance là tính năng.** Post-process nặng đi sau **quality tier tự xuống cấp**.
4. **Không nhân đôi logic agent.** Cosmos chỉ *trực quan hoá*. Không đường ghi/chạy nào đi vòng qua đây.

---

## 1. Các định luật của vũ trụ (world-building — mở rộng cho v2)

| Định luật | Phát biểu | Hệ quả kỹ thuật v2 |
| --- | --- | --- |
| **L1 — Sự thật là ánh sáng** | Chỉ thứ *có thật* mới phát sáng có-ngữ-nghĩa. Sao nền chỉ là bụi. | Tầng ngữ nghĩa `AdditiveBlending`+bloom; trang trí `depthWrite:false`, mờ. |
| **L2 — Hấp dẫn = phụ thuộc** | Vật liên quan hút nhau; file cùng thư mục co cụm thành thiên hà. | Galaxy = seed-noise quanh một *tâm bất đối xứng*, KHÔNG chia đều vòng. |
| **L3 — Khối lượng = tầm quan trọng** | Nhiều dòng = sao to/sáng. Nhiều file = thiên hà lớn. **AI Core là khối lượng tối thượng.** | Hierarchy scale rõ rệt (mục 4). Halo thiên hà `∝√count`. |
| **L4 — Không gì tức thời** | Mọi thay đổi diễn ra qua thời gian. Không teleport. | Mọi giá trị qua `lerp`/damping. Xương engine hiện tại. |
| **L5 — Nhiệt = hoạt động** | Vật vừa được agent đụng thì *nóng* rồi *nguội dần*. | `lit *= 0.94/frame`, chuẩn hoá theo `dt`. Mở cho mọi loại vật thể. |
| **L6 — Vũ trụ có trí nhớ** | Nơi hay ghé sáng bền; nơi lâu không đụng mờ đi. | `visitWeight[path]` lưu `localStorage`, cộng dồn qua phiên. |
| **L7 — Chết thì đẹp** | File xoá → siêu tân tinh; lỗi nghiêm trọng → hố đen bẻ cong. | Event-driven từ SSE. |
| **L8 — Thời gian trôi** | Đứng yên thì vũ trụ vẫn thở: drift, twinkle, tinh vân cuộn. | `clock.elapsedTime` lái mọi dao động nền. |
| **L9 (mới) — Bất đối xứng là sự sống** | Không có gì đều nhau. Cụm dày, khoảng trống, trục nghiêng, độ sâu lệch. | Layout dùng seed-noise + golden-angle nhiễu, KHÔNG lưới đều. |
| **L10 (mới) — Mọi thứ có quy mô riêng** | Người dùng nhận ra "quan trọng" chỉ qua kích thước, tức thì, không cần nhãn. | Bảng scale cố định (mục 4). AI Core luôn là vật lớn nhất khung. |

**Đơn vị & thang không gian v2** (bất đối xứng có chủ đích):
- **AI Core** ở gốc `(0,0,0)`, bán kính hiệu dụng ~**26** (áp đảo). Là mặt trời sống của vũ trụ.
- **9 galaxy** rải trên vỏ cầu méo, `dist ∈ [70, 340]`, elevation nghiêng `∈ [−90, 90]`, **không**
  cùng một mặt phẳng. Vài galaxy cực gần (chi tiết cao), vài galaxy rất xa (chỉ là quầng sáng mờ).
- Sao nền vỏ cầu `r≈600`; bụi parallax 3 lớp `r ∈ [90, 460]`; tinh vân xa `z ≤ −260`.
- Camera dist `10`(lặn vào galaxy) … `120`(quanh Core) … `420`(toàn cảnh cả vũ trụ).

---

## 2. Phân cấp quy mô (Object Scale Hierarchy) — trái tim của v2

Người dùng phải *lập tức* hiểu cái gì quan trọng, chỉ bằng mắt. Đây là bảng scale **cố định**,
mọi vật thể tuân theo — vi phạm bảng này là quay lại "graph phẳng".

```
AI CORE          ~26   mặt trời sống ở tâm — luôn là vật lớn nhất, sáng nhất khung
  ↓
GALAXY           halo ∝ √(#file) · 6   thiên hà = 1 topDir; xoay quanh Core theo quỹ đạo riêng
  ↓
SOLAR SYSTEM     cụm con trong galaxy (thư mục con sâu) — GĐ sau, hiện gộp
  ↓
STAR (file)      1.2 + log2(lines)·0.85   một file = một sao; đỏ khổng lồ nếu >800 dòng
  ↓
PLANET / MOON    file nhỏ quay quanh sao lớn cùng thư mục — GĐ sau
  ↓
SATELLITE        node ngữ nghĩa phụ (skill trong stack) — chấm nhỏ nối bằng đường mảnh
  ↓
DUST / VARIABLE  starfield trang trí (KHÔNG ngữ nghĩa — L1)
```

**Quy tắc:** khoảng cách scale giữa hai bậc kề nhau phải **≥ 3×** để mắt phân biệt được ngay.
AI Core so với một sao trung bình phải chênh ~**20×** — đó là thứ tạo "sense of scale" mà v1 thiếu.

---

## 3. AI CORE — nhân vật chính

Ở tâm vũ trụ là **một vật thể khổng lồ duy nhất**: bộ não sống của bow-agent. Không phải "một
node to hơn chút" — mà là **mặt trời** áp đảo mọi thứ, ngay lập tức là tiêu điểm.

- **Cấu tạo nhiều lớp** (từ trong ra): nhân trắng-nóng thở → vỏ hổ phách (`#ffb347`) → **corona**
  (shell shader nhiễu Perlin cuộn chậm, như bề mặt sao thật) → nhiều **vành năng lượng** nghiêng
  lệch trục quay ngược nhau → **quầng volumetric** lớn → **god-rays** toả ra.
- **Nó thở.** Nhịp `sin` chậm (~0.4Hz) trên scale nhân + độ sáng corona. Khi agent tổng hợp
  (nhiều nguồn nóng) → Core **bùng sáng**, corona cuộn nhanh, vành quay gấp, phun năng lượng ra
  các galaxy (data-flow ngược — mục 5).
- **Mọi thứ revolve quanh nó.** 9 galaxy có quỹ đạo (tốc độ ∝ 1/√dist — luật Kepler xấp xỉ, chỉ
  để *cảm giác* đúng, không mô phỏng vật lý). Đây là điều khiến vũ trụ "có hấp dẫn".
- **Trung thực:** Core = codebase + LLM hội tụ (đã là nguồn `brain` thật). "Thở/phun" phản ứng
  theo SSE thật (prompt tới → xung; nguồn nóng → sáng), không animation vô cớ.

---

## 4. GALAXY — mỗi hệ thống một thiên hà có ĐỊNH DANH

Mỗi hệ thống lớn của bow-agent là **một thiên hà nguyên vẹn**, nhận ra được *chỉ qua diện mạo*
(brief của user). Bảng định danh — nguồn sự thật duy nhất về màu & tính cách:

| Galaxy | Nguồn thật | Diện mạo (định danh) | Chuyển động đặc trưng |
| --- | --- | --- | --- |
| **MEMORY** | `.claude/memory/*.md` | **Tinh vân tím** cuộn, khói lan | cuộn *rất* chậm, thở — luôn hiện diện (nền tri thức) |
| **PROMPT** | `POST /api/run` (SSE) | **Năng lượng xanh** dương, tia điện | phát xung cầu khi có prompt mới |
| **LLM / NÃO** | nguồn `brain` | **Ngôi sao vàng** kim (mini-Core) | nhấp nháy vàng, phun tia khi suy luận |
| **DATABASE** | MCP `supabase` có/không | **Pulsar trắng** quét chùm | chùm quét quay đều (lighthouse), nhịp gấp khi query |
| **MCP** | `config.mcpServers` | **Wormhole xanh** lục xoáy | xoáy chậm; *mở* (bẻ sáng mạnh) khi tool MCP chạy |
| **GIT** | ops git (suy từ stream) | **Sao khổng lồ đỏ** (red giant) | phồng-xẹp chậm, đỏ trầm; cực quang khi commit |
| **PACKAGES** | `package.json`/`node_modules` | **Cụm sao cyan** dày đặc | lấp lánh cyan lạnh, cụm chặt |
| **TOOLS** | tool calls (SSE) | **Vành đai** phi thuyền hạt | hạt bay quanh, sáng lên theo tool đang chạy |
| **WEB** | `WebSearch`/`WebFetch` (SSE) | **Đài quan sát cam** | vòng orbit cam mảnh, sáng khi tra cứu ngoài |

**Bất đối xứng (L9):** 9 galaxy KHÔNG chia đều. Rải bằng golden-angle + nhiễu seed, elevation
nghiêng khác nhau, khoảng cách khác nhau (vài cái gần & chi tiết, vài cái xa & chỉ là quầng). Kết
quả: *cụm dày một phía, khoảng trống một phía* — như ảnh Hubble thật, không như sơ đồ.

**Trung thực:** GALAXY có nguồn thật thì *phản ứng theo dữ liệu*; DATABASE chỉ biết "có/không" MCP
→ hiện diện tĩnh, không giả vờ có số liệu. Không mục nào giả dữ liệu (Phụ lục A).

---

## 5. DATA FLOW — xem AI suy nghĩ (phần gây choáng nhất)

Khi agent chạy thật (SSE), vũ trụ **phản ứng như một hệ thần kinh**:

1. **Prompt lights up** → galaxy PROMPT phát xung cầu năng lượng xanh.
2. **Năng lượng chảy về Core** theo **energy stream cong** — KHÔNG đường thẳng: đường
   Catmull-Rom uốn, hạt sáng chạy dọc với vận tốc, cường độ = mức data-flow. Stream *bất hoạt*
   gần như tàng hình; *hoạt động* thì rực rỡ (brief của user).
3. **Core tổng hợp** → bùng sáng, corona cuộn nhanh.
4. **Core phun ngược** năng lượng ra galaxy liên quan (MEMORY thức dậy, MCP mở wormhole, DATABASE
   pulsar nhịp gấp) — mỗi loại theo nhiệt nguồn thật.
5. **File được đụng tới nóng lên** (repo mode) — sao trắng-vàng, rung, to, rồi nguội.
6. **Response trở về** → cực quang lan (suy từ SSE `done`).

Người dùng **không đọc log — họ xem trí tuệ diễn ra**. Đây là hồi 3 của hành trình cảm xúc.

---

## 6. Hành trình cảm xúc (3 hồi — giữ, tinh chỉnh cho v2)

1. **Hồi 1 — Choáng ngợp (0–6s):** fade từ đen. Sao xa hiện trước → tinh vân → 9 galaxy *trôi vào
   từ độ sâu khác nhau* (parallax mạnh) → cuối cùng **AI Core bùng cháy ở tâm**, áp đảo. Camera
   drift chậm, chưa HUD. *"Wow."*
2. **Hồi 2 — Tò mò:** HUD mờ hiện. Rê chuột → galaxy gần phản ứng. Bấm một galaxy → **bay tới**
   (warp nhẹ) → nó lớn dần, lộ các sao/file bên trong. *"Mình đang đi trong một thứ sống."*
3. **Hồi 3 — Thấu hiểu:** agent chạy → data-flow điện ảnh (mục 5). *"Mình hiểu nó nghĩ thế nào."*

Nhịp **chậm, có trọng lượng**. Mọi chuyển cảnh ≥ 0.6s. Không gì giật.

---

## 7. Camera như phi thuyền (giữ mô hình v1, nâng cảm giác)

Orbit quanh `orbitTarget` qua `yaw/pitch/dist`, tất cả qua target+damping (đã đúng). Nâng cấp:
- **Trọng lượng:** gia tốc/giảm tốc chậm hơn (`k=0.045` cho dist khi warp) → cảm giác "nặng".
- **Warp (bấm đúp / bay xa):** sao nền kéo vệt (shader `uWarp` đã có), motion-blur nhẹ (tier ultra),
  galaxy đích *lấy nét dần* khi tới. Đích "slowly comes into focus".
- **Zoom vô tận:** Core ↔ Galaxy ↔ Star ↔ File — mỗi ngưỡng dist lộ thêm chi tiết (LOD).
- **Idle cinematic:** >20s không tương tác → camera tự bay chậm qua các galaxy (attract mode).
- **Back stack + ESC** thoát: không bao giờ teleport, luôn có đường ra (L2).

---

## 8. Ngôn ngữ hình ảnh (giữ triết lý v1)

Interstellar × Space Engine × Vision Pro. Khoa học, tối giản, đắt tiền. **KHÔNG** cyberpunk/neon loạn.
- Nền xanh-đen sâu (`fog #03040a`). Màu vật thể lấy *hue định danh galaxy* (mục 4). Nhấn ấm ở Core.
- `ACESFilmicToneMapping` + **bloom chọn lọc** (threshold 0.8 — vật rất sáng mới loang, sao điểm
  vẫn sắc). Đây là bí quyết "vừa rực vừa nét" — tuyệt đối giữ.
- Ba tầng chiều sâu; DoF nhoè hậu cảnh khi focus. Không cạnh cứng — sprite/point quầng mềm.
- HUD mảnh, mono (`Space Mono`), như HUD tàu — không phải nút web. Overlay **luôn nền tối**.
- **Taxonomy màu ngữ nghĩa** đọc từ `--step-*`: `start/tool/result/error/approval/thinking` cho hạt
  & xung reasoning → ăn đúng theme. Nguồn sự thật duy nhất về màu bước — không hardcode lại.

---

## 9. Render & Performance (giữ nguyên chiến lược v1)

- **Một draw call cho N sao** (`THREE.Points` trên 1 `BufferGeometry`). Không 1 mesh/1 file.
- **Shader gánh hoạt ảnh** (pulse/twinkle/lit từ `uTime`,`aLit`). CPU chỉ cập nhật `aLit`.
- **Nhãn HTML** chiếu theo `screenOf()` — chữ sắc, rẻ, i18n dễ. LOD nhãn (ẩn khi xa/khuất).
- **Quality tiers** `ultra/high/balanced/lite` tự dò + auto-degrade khi FPS tụt (đã có, giữ).
- **Không cấp phát trong loop** — tái dùng vector tạm (nợ kỹ thuật v1, dọn dần).
- Tôn trọng `prefers-reduced-motion` (accessibility).

**Cam kết trung thực về con số:** starfield ~10⁵ điểm là *bụi trang trí* (1 draw call). Hạt
reasoning là *hàng nghìn*, không hàng triệu — ta chọn ý nghĩa, không đốt GPU.

---

## Phụ lục A — Ranh giới thật/thẩm mỹ (giữ kỷ luật v1 — đọc trước khi duyệt)

| Làm THẬT ngay | Thẩm mỹ / suy diễn | Đợi nguồn (chưa hứa) |
| --- | --- | --- |
| Bản đồ file (filetree) | Sao nền 10⁵, bụi, tinh vân xa | DATABASE Pulsar (chỉ biết có/không) |
| Nhiệt file khi agent đụng (SSE) | Solar-system/moon (gộp, GĐ sau) | Dependency graph (import) → cần parse |
| 9 galaxy từ nguồn thật | Red-giant/pulsar/wormhole (diện mạo) | Cực quang deploy → cần hook git/CI |
| Reasoning path từ SSE thật | Hố đen bẻ cong (xấp xỉ) | Living universe đa máy → chỉ localStorage/máy này |
| MCP/Skills có mặt (config) | Hạt "hàng triệu" → ta làm hàng nghìn | Audio-reactive → GĐ sau, mặc định tắt |

**Cam kết:** không mục nào ở cột 2–3 được trình bày như thể mang dữ liệu thật. Immersion không nói dối.

## Phụ lục B — Lộ trình thi công (lát cắt dọc trước, hiệu ứng nặng sau)

1. **GĐ1 — Thế giới v2.** Thay tầng world-building: AI Core khổng lồ nhiều lớp, 9 galaxy bất đối
   xứng có định danh màu, depth hàng nghìn units, hierarchy scale. *Kết quả: hết cảm giác "graph".*
2. **GĐ2 — Data-flow điện ảnh.** Energy stream cong + hạt vận tốc; SSE lái xung/nhiệt/phun. *Choáng nhất.*
3. **GĐ3 — Đa dạng thiên thể.** Red-giant/pulsar/wormhole shader riêng; sao file theo lines/ext.
4. **GĐ4 — Bom tấn post.** DoF+godrays theo tier; warp lấy-nét-dần; motion-blur (ultra).
5. **GĐ5 — Living universe.** `visitWeight`, siêu tân tinh/hố đen theo event, idle cinematic, audio (tắt mặc định).

Mỗi giai đoạn *đứng độc lập* — dừng ở đâu vẫn ra sản phẩm hoàn chỉnh, không dở dang.
