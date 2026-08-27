/**
 * Token đã tiêu của AI NGOÀI (Grok…) — phần thân của panel "Hạn mức sử dụng" khi tab đang
 * chạy gateway thay vì Claude.
 *
 * Vì sao khác hẳn phần hạn mức gói: provider ngoài tính tiền PAY-AS-YOU-GO theo token, không
 * có cửa sổ 5h/7 ngày để vẽ thanh %. Thứ đáng xem ở đây là ĐÃ ĐỐT BAO NHIÊU: tổng tích luỹ,
 * hôm nay, chia theo model, và nhịp mấy ngày gần đây. Số do backend đếm từ transcript
 * (/api/usage/tokens → src/core/tokenUsage.ts), không phải ước lượng phía client.
 */
import { formatTokens } from '../App.js';
import type { TokenTotals, TokenUsageReport } from '../types.js';

/** Một dòng số: nhãn trái, giá trị phải. */
function Row({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '3px 0' }}>
      <span style={{ fontSize: '12px', color: dim ? 'var(--muted)' : 'var(--ink)' }}>{label}</span>
      <span className="rv" style={{ fontSize: '12.5px', color: dim ? 'var(--muted)' : 'var(--ink)' }}>{value}</span>
    </div>
  );
}

/** Chia nhỏ một tổng thành 4 thành phần token (in/out/cache) cho người dùng soi chi phí. */
function Breakdown({ t }: { t: TokenTotals }) {
  return (
    <div style={{ marginTop: '4px' }}>
      <Row label="Input" value={formatTokens(t.input)} dim />
      <Row label="Output" value={formatTokens(t.output)} dim />
      {t.cacheWrite > 0 && <Row label="Cache ghi" value={formatTokens(t.cacheWrite)} dim />}
      <Row label="Cache đọc" value={formatTokens(t.cacheRead)} dim />
    </div>
  );
}

export function TokenUsageView({
  report,
  loading,
  providerLabel,
}: {
  report: TokenUsageReport | null;
  loading: boolean;
  providerLabel: string;
}) {
  if (!report) {
    return (
      <div style={{ padding: '18px', textAlign: 'center', color: 'var(--muted)', fontSize: '12px' }}>
        {loading ? 'Đang đếm token…' : `Chưa đọc được token đã tiêu của ${providerLabel}.`}
      </div>
    );
  }
  if (report.totals.calls === 0) {
    return (
      <div style={{ padding: '18px', textAlign: 'center', color: 'var(--muted)', fontSize: '12px' }}>
        Chưa có lượt gọi nào qua {providerLabel} trên máy này.
      </div>
    );
  }

  const { totals, today, byModel, byDay } = report;
  // Thanh ngày dài theo ngày ĐỐT NHIỀU NHẤT trong khung đang xem — nhìn ra ngay ngày bất thường.
  const peak = Math.max(...byDay.map((d) => d.total), 1);
  // Cache ghi = 0 mà cache đọc lớn: gateway KHÔNG chuyển được prompt-caching sang provider
  // ngoài, nên phần "cache đọc" nhiều khả năng vẫn bị tính giá input đầy đủ. Cảnh báo vì đây
  // là khoản đội giá lớn nhất khi chạy agent nhiều vòng tool.
  const cacheBroken = totals.cacheRead > 0 && totals.cacheWrite === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '12.5px', fontWeight: 600 }}>Tổng đã tiêu</span>
          <span className="rv" style={{ fontSize: '15px', fontWeight: 700 }}>{formatTokens(totals.total)}</span>
        </div>
        <div style={{ fontSize: '10.5px', color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: '2px' }}>
          {totals.calls.toLocaleString('vi-VN')} lượt gọi
          {report.firstDay ? ` · từ ${report.firstDay}` : ''}
        </div>
        <Breakdown t={totals} />
      </div>

      <div style={{ paddingTop: '10px', borderTop: 'var(--bd-thin) solid var(--outline)' }}>
        <Row label="Hôm nay" value={formatTokens(today.total)} />
        <div style={{ fontSize: '10.5px', color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
          {today.calls.toLocaleString('vi-VN')} lượt gọi
        </div>
      </div>

      <div style={{ paddingTop: '10px', borderTop: 'var(--bd-thin) solid var(--outline)' }}>
        <div style={{ fontSize: '12.5px', fontWeight: 600, marginBottom: '6px' }}>Theo model</div>
        {byModel.map((m) => (
          <Row key={m.model} label={m.model} value={formatTokens(m.total)} />
        ))}
      </div>

      {byDay.length > 0 && (
        <div style={{ paddingTop: '10px', borderTop: 'var(--bd-thin) solid var(--outline)' }}>
          <div style={{ fontSize: '12.5px', fontWeight: 600, marginBottom: '8px' }}>Mấy ngày gần đây</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {byDay.map((d) => (
              <div key={d.day}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '3px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{d.day}</span>
                  <span className="rv" style={{ fontSize: '11.5px' }}>{formatTokens(d.total)}</span>
                </div>
                <div style={{ height: '6px', background: 'var(--inset)', border: 'var(--bd-thin) solid var(--outline)', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.round((d.total / peak) * 100)}%`, height: '100%', background: 'var(--teal)', transition: 'width var(--med)' }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {cacheBroken && (
        <div style={{ fontSize: '10.5px', color: 'var(--brass)', lineHeight: 1.5, paddingTop: '8px', borderTop: 'var(--bd-thin) solid var(--outline)' }}>
          Cache ghi = 0: prompt-caching không đi qua gateway được, nên {formatTokens(totals.cacheRead)} token
          &quot;cache đọc&quot; nhiều khả năng vẫn bị tính giá input đầy đủ.
        </div>
      )}

      <div style={{ fontSize: '10px', color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
        Đếm từ {report.scannedFiles.toLocaleString('vi-VN')} transcript của mọi tài khoản Claude trên máy · {report.scanMs}ms
      </div>
    </div>
  );
}
