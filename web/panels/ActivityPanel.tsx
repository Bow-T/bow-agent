/**
 * Màn HOẠT ĐỘNG — nhìn toàn phiên làm việc, không chỉ một tab:
 *   • Các tác vụ đang mở + trạng thái (ai đang chạy, ai đang chờ bạn).
 *   • (Admin) thiết bị LAN đang kết nối + nhật ký kiểm toán chia sẻ.
 * Nhật ký chi tiết từng bước của MỘT tác vụ vẫn nằm ở cột phải khung chat (per-tab).
 */
import { useCallback, useEffect, useState } from 'react';
import { PanelShell, PanelEmpty } from './PanelShell.js';
import { Icon } from '../Icon.js';
import { apiFetch } from '../App.js';
import type { NavSectionViewProps } from './NavSectionView.js';

export function ActivityPanel({ language, cfg, tasks, onGoTask }: NavSectionViewProps) {
  const vi = language === 'vi';
  const [clients, setClients] = useState<{ ip: string; device: string; lastSeen: string }[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    if (!cfg?.isAdmin) return;
    setErr('');
    apiFetch('/api/active-clients')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { clients: { ip: string; device: string; lastSeen: string }[] }) => setClients(d.clients ?? []))
      .catch((e: Error) => setErr(e.message));
    apiFetch('/api/audit-logs')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { logs: string[] }) => setLogs(d.logs ?? []))
      .catch((e: Error) => setErr(e.message));
  }, [cfg?.isAdmin]);

  useEffect(() => { load(); }, [load]);

  return (
    <PanelShell
      icon="activityLog"
      title={vi ? 'Hoạt động' : 'Activity'}
      subtitle={vi ? 'Toàn cảnh phiên làm việc' : 'Whole-session overview'}
      actions={cfg?.isAdmin ? (
        <button className="btn" onClick={load}><Icon name="refresh" size={13} /> {vi ? 'Làm mới' : 'Refresh'}</button>
      ) : undefined}
    >
      <h3 className="panel-sec-title">{vi ? 'Tác vụ đang mở' : 'Open tasks'}</h3>
      {tasks.length === 0 ? (
        <PanelEmpty text={vi ? 'Chưa có tác vụ nào.' : 'No tasks yet.'} />
      ) : (
        <div className="panel-list">
          {tasks.map((t) => (
            <button key={t.id} type="button" className="task-row" onClick={() => onGoTask(t.id)}>
              <s className={t.pendingCount > 0 ? 'warn' : t.running ? 'live' : ''} />
              <span className="task-row-title">{t.title || (vi ? 'Tác vụ mới' : 'New task')}</span>
              <span className="task-row-state">
                {t.pendingCount > 0
                  ? (vi ? `CHỜ DUYỆT ${t.pendingCount}` : `PENDING ${t.pendingCount}`)
                  : t.running
                    ? (vi ? 'ĐANG CHẠY' : 'RUNNING')
                    : t.hasContent ? (vi ? 'XONG' : 'DONE') : (vi ? 'TRỐNG' : 'EMPTY')}
              </span>
            </button>
          ))}
        </div>
      )}

      {cfg?.isAdmin && (
        <>
          <h3 className="panel-sec-title">{vi ? 'Thiết bị đang kết nối' : 'Connected devices'}</h3>
          {clients.length === 0 ? (
            <PanelEmpty text={vi ? 'Không có thiết bị LAN nào đang mở.' : 'No LAN device connected.'} />
          ) : (
            <div className="panel-list">
              {clients.map((c) => (
                <div key={c.ip} className="client-row">
                  <b>{c.ip}</b>
                  <span>{c.device}</span>
                  <em>{c.lastSeen}</em>
                </div>
              ))}
            </div>
          )}

          <h3 className="panel-sec-title">{vi ? 'Nhật ký kiểm toán' : 'Audit log'}</h3>
          {err && <PanelEmpty text={err} />}
          {logs.length === 0 ? (
            <PanelEmpty text={vi ? 'Chưa có bản ghi nào.' : 'No entries yet.'} />
          ) : (
            <pre className="audit-log">{logs.join('\n')}</pre>
          )}
        </>
      )}
    </PanelShell>
  );
}
