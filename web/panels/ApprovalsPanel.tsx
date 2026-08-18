/**
 * Màn CHỜ DUYỆT — chỗ nhìn TOÀN CẢNH mọi việc đang chặn, gồm 2 loại:
 *   • Việc của chính bạn: mỗi tác vụ (tab) có bao nhiêu thẻ chờ. Nút bấm đưa thẳng vào tab đó —
 *     thao tác Cho phép/Từ chối vẫn nằm trong khung chat (nơi có đủ ngữ cảnh lệnh/diff).
 *   • Việc admin duyệt từ xa (Collab/DevOps): CTV xin chạy lệnh hủy hoại — duyệt được ngay tại đây.
 */
import { PanelShell, PanelEmpty } from './PanelShell.js';
import { Icon } from '../Icon.js';
import type { NavSectionViewProps } from './NavSectionView.js';

/** Một yêu cầu treo ở kênh admin (Collab/DevOps) — khớp state collabApprovals của App. */
export interface CollabApproval {
  id: string;
  sessionId: string;
  clientIp: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  decisionReason?: string;
  createdAt: string;
  apiOrigin?: string;
}

export function ApprovalsPanel({ language, tasks, onGoTask, cfg, collabApprovals, onDecideCollab }: NavSectionViewProps) {
  const vi = language === 'vi';
  const waiting = tasks.filter((t) => t.pendingCount > 0);
  const remote = cfg?.isAdmin ? collabApprovals : [];

  return (
    <PanelShell
      icon="block"
      title={vi ? 'Chờ duyệt' : 'Approvals'}
      subtitle={vi
        ? 'Mọi việc agent đang chờ bạn quyết định'
        : 'Everything the agent is waiting on you for'}
    >
      <h3 className="panel-sec-title">{vi ? 'Tác vụ của bạn' : 'Your tasks'}</h3>
      {waiting.length === 0 ? (
        <PanelEmpty text={vi ? 'Không có việc nào đang chờ duyệt.' : 'Nothing waiting for approval.'} />
      ) : (
        <div className="panel-list">
          {waiting.map((t) => (
            <button key={t.id} type="button" className="approval-row" onClick={() => onGoTask(t.id)}>
              <span className="approval-row-dot" />
              <span className="approval-row-title">{t.title || (vi ? 'Tác vụ' : 'Task')}</span>
              <span className="approval-row-count">{t.pendingCount}</span>
              <span className="approval-row-go">
                {vi ? 'Mở' : 'Open'} <Icon name="caretRight" size={13} />
              </span>
            </button>
          ))}
        </div>
      )}

      {cfg?.isAdmin && (
        <>
          <h3 className="panel-sec-title">{vi ? 'Duyệt từ xa (Collab / DevOps)' : 'Remote approvals (Collab / DevOps)'}</h3>
          {remote.length === 0 ? (
            <PanelEmpty text={vi ? 'Không có yêu cầu nào từ cộng tác viên.' : 'No requests from collaborators.'} />
          ) : (
            <div className="panel-list">
              {remote.map((a) => (
                <div key={a.id} className="approval-remote">
                  <div className="approval-remote-head">
                    <Icon name="block" size={15} />
                    <b>{a.title || a.toolName}</b>
                    <em>{a.clientIp}</em>
                  </div>
                  {a.description && <p>{a.description}</p>}
                  {typeof a.input?.command === 'string' && <pre className="approval-cmd">{a.input.command}</pre>}
                  {typeof a.input?.file_path === 'string' && (
                    <div className="approval-path"><Icon name="doc" size={13} /> {a.input.file_path}</div>
                  )}
                  <div className="approval-remote-actions">
                    <button className="btn deny" onClick={() => onDecideCollab(a.id, false, a.apiOrigin)}>
                      {vi ? 'Từ chối' : 'Deny'}
                    </button>
                    <button className="btn allow" onClick={() => onDecideCollab(a.id, true, a.apiOrigin)}>
                      {vi ? 'Cho phép' : 'Approve'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
}
