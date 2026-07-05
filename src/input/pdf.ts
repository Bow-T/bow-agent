/**
 * Trích text từ PDF (base64) để làm tài liệu đầu vào cho agent.
 * pdf-parse là CommonJS → import động, tránh vỡ ESM.
 */
export async function pdfToText(base64: string): Promise<string> {
  const buf = Buffer.from(base64, 'base64');
  // pdf-parse export default là 1 hàm; import động cho hợp ESM/Node16.
  const mod = (await import('pdf-parse')) as unknown as {
    default: (b: Buffer) => Promise<{ text: string }>;
  };
  const parse = mod.default;
  const data = await parse(buf);
  return data.text.trim();
}
