import { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Cấu hình marked một lần: xuống dòng đơn -> <br> (giống chat), bật GFM (table, ~~gạch~~).
marked.setOptions({ gfm: true, breaks: true });

/**
 * Render text Markdown của agent thành HTML đã sanitize.
 * Chỉ dùng cho bubble 'agent' — các bubble khác giữ nguyên plain text.
 *
 * Mỗi khối code (```…``` → <pre><code>) được gắn một nút Copy nổi ở góc (giống
 * Claude trong VSCode): chỉ những đoạn AI đưa ra để DÁN mới có nút, khỏi bôi đen thủ công.
 */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    // parse đồng bộ (không await) rồi làm sạch để chặn XSS từ nội dung model sinh ra.
    const raw = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [text]);

  const ref = useRef<HTMLDivElement | null>(null);

  // Sau mỗi lần render (html đổi khi stream), gắn nút Copy vào từng <pre> chưa có nút.
  // Nút copy đúng text trong khối code — thứ người dùng cần dán đi.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-copy')) return; // đã gắn rồi (stream cập nhật lại)
      const code = pre.querySelector('code');
      if (!code) return;
      pre.classList.add('has-copy');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy';
      btn.setAttribute('aria-label', 'Copy đoạn code');
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => {
        // Lấy text hiện tại của khối code (không phải lúc gắn — stream có thể đã đổi).
        const content = (code.textContent ?? '').replace(/\n$/, '');
        navigator.clipboard.writeText(content).then(
          () => {
            btn.textContent = 'Đã copy';
            btn.classList.add('copied');
            window.setTimeout(() => {
              btn.textContent = 'Copy';
              btn.classList.remove('copied');
            }, 2000);
          },
          () => { /* clipboard bị chặn (ngữ cảnh không bảo mật) — bỏ qua im lặng */ },
        );
      });
      pre.appendChild(btn);
    });
  }, [html]);

  return <div ref={ref} className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
