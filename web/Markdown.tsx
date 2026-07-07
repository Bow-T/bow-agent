import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Cấu hình marked một lần: xuống dòng đơn -> <br> (giống chat), bật GFM (table, ~~gạch~~).
marked.setOptions({ gfm: true, breaks: true });

/**
 * Render text Markdown của agent thành HTML đã sanitize.
 * Chỉ dùng cho bubble 'agent' — các bubble khác giữ nguyên plain text.
 */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    // parse đồng bộ (không await) rồi làm sạch để chặn XSS từ nội dung model sinh ra.
    const raw = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [text]);

  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
