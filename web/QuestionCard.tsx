import { useState } from 'react';
import type { PendingQuestion } from './types.js';

/**
 * UI cho tool AskUserQuestion: agent hỏi, người dùng bấm chọn thay vì đọc JSON thô.
 *
 * - Mỗi câu hỏi hiện header (chip), nội dung, và danh sách option (label + mô tả).
 * - multiSelect=true → chọn nhiều (checkbox-like); ngược lại chọn một (radio-like).
 * - Luôn có mục "Khác…" để người dùng tự nhập câu trả lời (giống hành vi harness).
 * - Gửi (onSubmit) map câu-hỏi → câu-trả-lời; Huỷ (onCancel) → agent nhận deny.
 */
export function QuestionCard({
  pending,
  onSubmit,
  onCancel,
}: {
  pending: PendingQuestion;
  onSubmit: (answers: Record<string, string>) => void;
  onCancel: () => void;
}) {
  // Lựa chọn theo từng câu: tập các label đã chọn (Set để bật/tắt gọn).
  const [picked, setPicked] = useState<Record<number, Set<string>>>({});
  // Nội dung ô "Khác…" theo từng câu.
  const [other, setOther] = useState<Record<number, string>>({});

  const OTHER = '__other__';

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((prev) => {
      const cur = new Set(prev[qi] ?? []);
      if (multi) {
        cur.has(label) ? cur.delete(label) : cur.add(label);
      } else {
        // Chọn một: thay thế toàn bộ lựa chọn cũ.
        cur.clear();
        cur.add(label);
      }
      return { ...prev, [qi]: cur };
    });
  };

  // Câu trả lời cuối cho một câu: nối các label đã chọn (+ text "Khác") bằng ', '.
  const answerFor = (qi: number): string => {
    const set = picked[qi] ?? new Set<string>();
    const parts: string[] = [];
    for (const label of set) {
      if (label === OTHER) {
        const txt = (other[qi] ?? '').trim();
        if (txt) parts.push(txt);
      } else {
        parts.push(label);
      }
    }
    return parts.join(', ');
  };

  // Cho gửi khi MỌI câu đã có câu trả lời (không bỏ trống câu nào).
  const allAnswered = pending.questions.every((_, qi) => answerFor(qi).length > 0);

  const submit = () => {
    if (!allAnswered) return;
    const answers: Record<string, string> = {};
    pending.questions.forEach((q, qi) => {
      answers[q.question] = answerFor(qi);
    });
    onSubmit(answers);
  };

  return (
    <div className="question-card">
      <div className="question-card-head">🤖 Agent cần bạn quyết định</div>

      {pending.questions.map((q, qi) => {
        const multi = !!q.multiSelect;
        const set = picked[qi] ?? new Set<string>();
        const otherOn = set.has(OTHER);
        return (
          <div key={qi} className="question-block">
            <div className="question-header-row">
              {q.header && <span className="question-chip">{q.header}</span>}
              {multi && <span className="question-multi-hint">chọn nhiều</span>}
            </div>
            <div className="question-text">{q.question}</div>

            <div className="question-options">
              {q.options.map((opt) => {
                const on = set.has(opt.label);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    className={`question-option${on ? ' selected' : ''}`}
                    onClick={() => toggle(qi, opt.label, multi)}
                  >
                    <span className="question-option-mark">{on ? (multi ? '☑' : '◉') : multi ? '☐' : '○'}</span>
                    <span className="question-option-body">
                      <span className="question-option-label">{opt.label}</span>
                      {opt.description && (
                        <span className="question-option-desc">{opt.description}</span>
                      )}
                    </span>
                  </button>
                );
              })}

              {/* Mục "Khác…" — luôn có, để người dùng tự nhập câu trả lời riêng. */}
              <button
                type="button"
                className={`question-option${otherOn ? ' selected' : ''}`}
                onClick={() => toggle(qi, OTHER, multi)}
              >
                <span className="question-option-mark">{otherOn ? (multi ? '☑' : '◉') : multi ? '☐' : '○'}</span>
                <span className="question-option-body">
                  <span className="question-option-label">Khác…</span>
                  <span className="question-option-desc">Tự nhập câu trả lời của bạn.</span>
                </span>
              </button>

              {otherOn && (
                <input
                  className="question-other-input"
                  autoFocus
                  placeholder="Nhập câu trả lời của bạn…"
                  value={other[qi] ?? ''}
                  onChange={(e) => setOther((prev) => ({ ...prev, [qi]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && allAnswered) submit();
                  }}
                />
              )}
            </div>
          </div>
        );
      })}

      <div className="question-actions">
        <button className="btn allow" disabled={!allAnswered} onClick={submit}>
          Gửi câu trả lời
        </button>
        <button className="btn deny" onClick={onCancel}>
          Huỷ
        </button>
      </div>
    </div>
  );
}
