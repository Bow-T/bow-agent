# Đáp án cho comment — chuẩn bị trước cho 2 giờ vàng

> **Cách dùng:** mở file này khi ngồi canh comment. Copy, chỉnh vài chữ cho tự nhiên, gửi.
>
> **Nguyên tắc trả lời:**
> - Thừa nhận thẳng cái chưa làm được. Đừng phòng thủ. Trên HN/Reddit, thành thật ăn điểm.
> - Người chê gay gắt thường là người quan tâm nhất. Trả lời tử tế → họ thành contributor.
> - Không tranh cãi. Nói *"đúng, đó là hạn chế thật"* rồi nói mình định làm gì.
> - Trả lời trong **2-3 giờ đầu**. Sau đó bài chìm, comment không ai đọc nữa.

---

## 🔴 NHÓM 1 — Chắc chắn bị hỏi

### "Sao không dùng git branch + PR cho xong? Đó là cổng duyệt sẵn có rồi."

*(Đây là câu khó nhất, và là câu thông minh nhất. Trả lời tốt câu này là bài thành công.)*

> Câu hỏi hay, và với contractor viết code thì đúng — PR là cổng duyệt sẵn có, tôi không thay
> thế nó.
>
> Khác biệt là **thời điểm** và **phạm vi**.
>
> PR chặn ở *cuối*: agent đã chạy xong, đã sửa 20 file, đã chạy lệnh gì đó trên máy, đã (có thể)
> gọi `execute_sql` lên DB thật. PR chỉ review được **kết quả cuối cùng trên git**. Nó không thấy
> lệnh shell agent đã chạy, không thấy migration đã apply, không thấy comment đã ghi lên Jira.
>
> Cổng của tôi chặn ở *từng thao tác*: từng lần ghi file, từng lệnh bash có side-effect, từng
> lần ghi DB — dừng lại, hiện diff, chờ người bấm.
>
> Và PR không giúp gì cho **QC/BA** — họ đâu có mở PR. QC cần đọc code + chấm ticket Jira. BA
> cần viết tài liệu. Với họ, "cổng duyệt" phải là *giới hạn agent làm được gì ngay từ đầu*, chứ
> không phải review sau.
>
> Nói ngắn: PR bảo vệ **branch**. Cái này bảo vệ **máy bạn, DB bạn, và Jira của bạn** — những
> thứ agent đụng được mà git không thấy.

---

### "Chỉ chạy được với Claude à? Bao giờ có OpenAI / local model?"

*(Sẽ bị hỏi ngay. Đã viết trong bài rồi nhưng vẫn có người hỏi lại.)*

> Đúng, chỉ Claude. Nó dựng trên Claude Agent SDK nên bị buộc vào đó.
>
> Không phải lựa chọn triết lý — chỉ là tôi xây trên cái tôi đang dùng hằng ngày. Cổng duyệt bản
> thân nó không phụ thuộc model; về nguyên tắc bọc được engine khác.
>
> **Đây là thứ tôi muốn có người giúp nhất.** Nếu bạn quan tâm thì mở issue, tôi sẽ chỉ chỗ cần
> đụng.

---

### "Sao không dùng Cursor / Aider / Continue / Windsurf?"

> Mấy cái đó tốt, và nếu bạn là dev ngồi một mình thì cứ dùng — tôi cũng dùng Claude Code hằng
> ngày.
>
> Chúng giải bài toán *"làm sao tôi code nhanh hơn"*. Bài toán của tôi là *"làm sao **QC của
> tôi** dùng được agent mà không sửa được code"*.
>
> Không tool nào ở trên cho bạn giao agent cho một người, giới hạn theo vai trò, rồi **duyệt
> từng thao tác ghi của họ từ máy mình**. Chúng thiết kế cho một người dùng, một mức tin cậy.

---

### "LAN-only thì khác gì cho họ SSH vào máy bạn?"

> Khác ở chỗ SSH cho họ **toàn quyền**, còn cái này cho họ **đúng phần việc của họ**.
>
> QC vào được, nhưng agent của bạn ấy không có tool ghi file — không phải "được khuyên đừng
> sửa", mà là **không có khả năng** sửa. BA ghi được `docs/` và `*.md`, còn source thì bị deny
> cứng.
>
> Với Collab (contractor code thật) thì gần nhất với SSH — nhưng mọi thao tác ghi, **kể cả git**,
> hiện thẻ duyệt trên màn hình tôi kèm diff, và chờ tôi bấm.
>
> Nói thẳng: nếu bạn hỏi *"LAN + duyệt theo tên có phải auth thật không?"* thì **không**. Nó đủ
> cho team ngồi cùng văn phòng. Tôi sẽ không mở nó ra internet, và trong README tôi ghi rõ vậy.
> Auth thật là việc tôi cần người giúp.

---

## 🟡 NHÓM 2 — Rất có thể bị hỏi

### "Agent lách cổng duyệt được không? Nó chạy `sed -i` là xong mà."

*(Câu này là dấu hiệu người hỏi rất giỏi. Trả lời tự tin — vì bạn ĐÃ vá.)*

> Đúng, và đó chính là lỗ đầu tiên tôi phải vá.
>
> Deny cứng tool `Edit`/`Write` là vô nghĩa nếu `Bash` vẫn chạy được `sed -i`, `patch`, hay
> `git apply`. Nên các lệnh sửa-file-tại-chỗ **luôn** phải qua cổng duyệt — kể cả với admin,
> kể cả ở chế độ auto.
>
> Có ba lỗ kiểu này tôi đã bịt:
> 1. `Bash` lách deny của `Edit` (sed -i / patch / git apply)
> 2. MCP write (`execute_sql`, `apply_migration`) — ép duyệt kể cả admin, để không ai auto-allow
>    một câu `DROP TABLE`
> 3. `Read`/`Grep` phải rời khỏi auto-approve, không thì check file nhạy cảm (`.env`, `.ssh/`,
>    `.git-credentials`) không bao giờ chạy
>
> Nếu bạn tìm ra lỗ thứ tư thì **thật sự** cho tôi biết — mở issue, hoặc nhắn riêng nếu nó
> nghiêm trọng.

---

### "Admin = localhost. Tôi giả header `X-Forwarded-For: 127.0.0.1` là thành admin?"

> Không. Đó đúng là lỗ tôi từng có và đã vá.
>
> Quyền admin xác định bằng **socket IP thật** (`req.socket.remoteAddress`), không phải header.
> Header `X-Forwarded-For` chỉ dùng để **hiển thị/log**, không dùng cho quyết định quyền — vì
> client tự đặt được.
>
> Nếu bạn tìm được cách lách, tôi rất muốn nghe.

---

### "Sao không dùng Docker / sandbox cho gọn?"

> Sandbox giải bài toán khác: *chặn agent phá máy*. Của tôi là *chặn agent ghi cái nó không nên
> ghi, và cho người xem trước khi ghi*.
>
> Bỏ agent vào container thì nó vẫn tự do sửa mọi file trong container đó — mà repo của bạn thì
> nằm trong đó. Bạn được cách ly khỏi máy, nhưng không được cách ly khỏi **code của mình**.
>
> Hai thứ bổ sung nhau chứ không thay thế. Chạy cái này trong container cũng chẳng sao.

---

### "Có audit log không? Ai duyệt cái gì lúc nào?"

> Có, log theo IP người dùng. Thành thật mà nói phần này còn thô — đủ để biết ai chạy gì, chưa
> phải audit trail nghiêm túc.
>
> Nếu bạn cần audit thật (dạng compliance) thì mở issue mô tả nhu cầu, đó là hướng tốt.

---

### "Bao nhiêu tiền? Nó ăn token của tôi à?"

> Miễn phí, MIT. Nó dùng **login Claude CLI sẵn có** của bạn (gói Pro/Max) — không cần API key,
> không phát sinh hóa đơn riêng, không có server của tôi ở giữa.
>
> Code không rời khỏi máy bạn. Agent chạy local, chỉ nói chuyện với Anthropic đúng như Claude
> Code vẫn làm.

---

## 🟢 NHÓM 3 — Có thể gặp

### "Sao code/comment còn tiếng Việt?"

> Vì nó vốn là tool nội bộ, tôi ở Việt Nam. Đang dịch dần.
>
> Nếu thấy phiền thì đây đúng là việc dễ đóng góp nhất — mỗi PR một file:
> https://github.com/Bow-T/bow-agent/issues/26

---

### "Chỉ hợp Flutter + Supabase à?"

> Nó chạy trên **repo bất kỳ** — trỏ `--cwd` vào đâu cũng được, nó đọc `CLAUDE.md` của repo đó và
> tự nhận diện stack.
>
> Cái thiên về Flutter/Supabase chỉ là **profile kiến thức mặc định** (tôi build cái đó nên tôi
> viết cái đó). Thêm profile cho stack khác **chỉ cần thả một file markdown** — không đụng code,
> không sửa registry. Tôi thử rồi, thật sự chỉ vậy:
> https://github.com/Bow-T/bow-agent/issues/25

---

### "Có làm được với GitLab / Bitbucket không? Tôi không dùng Jira."

> Jira và GitHub đi qua MCP, nên về nguyên tắc thay bằng MCP khác được. Nhưng tôi **chưa test**
> GitLab/Bitbucket — nói trước để bạn khỏi mất công.
>
> Không có Jira thì vẫn dùng bình thường: đưa task bằng file markdown hoặc gõ thẳng câu lệnh.

---

### "Trông giống [tool X] quá."

> Có thể, tôi chưa thấy X. Cho tôi link, tôi đọc thật.
>
> Nếu X làm tốt hơn thì tôi nói thẳng vậy trong README — người ta đáng được biết.

---

## ⚫ Nếu bị chê nặng

### "Cái này vô dụng / ai cần / over-engineer"

Đừng cãi. Trả lời ngắn, tử tế, rồi thôi:

> Fair. Nó sinh ra từ một vấn đề rất cụ thể của team tôi — nếu team bạn không gặp thì đúng là
> không cần thật.

**Rồi dừng.** Đừng trả lời tiếp. Cãi nhau trong comment kéo cả bài xuống, và người đọc thấy tác
giả gắt là đóng tab.

---

## 📌 Nhớ

- Ai hỏi câu hay → mời họ mở issue. **Comment gay gắt nhất thường thành contributor tốt nhất.**
- Ai báo lỗ bảo mật → cảm ơn thật lòng, bảo họ nhắn riêng nếu nghiêm trọng.
- Ai hỏi "sao không hỗ trợ X" → hỏi ngược *"team bạn cần gì?"*. Đó là research miễn phí.
- Không biết thì nói **không biết**. Đừng bịa.
