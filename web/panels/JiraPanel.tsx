/**
 * Màn JIRA — xem sprint và ticket ngay trong bow, rồi ném ticket sang khung chat cho agent.
 *
 * Chỉ ĐỌC: dùng lại đúng module REST đã chạy thật ở dashboard sprint-scan
 * (src/scheduler/jiraApi.ts) qua các route /api/jira/* — không thêm client Jira thứ hai.
 * Ghi Jira (comment/transition) vẫn chỉ đi qua agent + MCP, tức là vẫn qua cổng duyệt.
 */
import { useCallback, useEffect, useState } from 'react';
import { PanelShell, PanelEmpty } from './PanelShell.js';
import { Icon } from '../Icon.js';
import { apiFetch } from '../App.js';
import type { NavSectionViewProps } from './NavSectionView.js';

interface Sprint {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
}
interface Issue {
  key: string;
  summary: string;
  issueType: string;
  status: string;
  assignee: string | null;
  reporter: string | null;
  priority: string | null;
}

export function JiraPanel({ language, onUseJiraKey }: NavSectionViewProps) {
  const vi = language === 'vi';
  const [project, setProject] = useState('');
  const [projectInput, setProjectInput] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [sprints, setSprints] = useState<Sprint[] | null>(null);
  const [sprintId, setSprintId] = useState<number | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  // Project mặc định + base URL lấy từ server (đọc env MCP jira) — client không tự đoán.
  useEffect(() => {
    apiFetch('/api/jira/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { projectKey: string | null; baseUrl: string | null }) => {
        setBaseUrl(d.baseUrl ?? '');
        if (d.projectKey) { setProject(d.projectKey); setProjectInput(d.projectKey); }
      })
      .catch((e: Error) => setErr(e.message));
  }, []);

  const loadSprints = useCallback((key: string) => {
    if (!key.trim()) return;
    setLoading(true); setErr(''); setSprints(null); setIssues(null); setSprintId(null);
    apiFetch(`/api/jira/sprints?project=${encodeURIComponent(key.trim())}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        return d as { sprints: Sprint[] };
      })
      .then((d) => setSprints(d.sprints ?? []))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (project) loadSprints(project); }, [project, loadSprints]);

  const openSprint = (id: number) => {
    setSprintId(id); setIssues(null); setErr(''); setLoading(true);
    apiFetch(`/api/jira/issues?sprint=${id}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        return d as { issues: Issue[] };
      })
      .then((d) => setIssues(d.issues ?? []))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  };

  return (
    <PanelShell
      icon="target"
      title="Jira"
      subtitle={vi ? 'Sprint và ticket — bấm một ticket để giao cho agent' : 'Sprints and tickets — click one to hand it to the agent'}
      actions={
        <form
          className="panel-inline-form"
          onSubmit={(e) => { e.preventDefault(); setProject(projectInput.trim().toUpperCase()); }}
        >
          <input
            className="panel-input"
            value={projectInput}
            placeholder={vi ? 'Mã project' : 'Project key'}
            onChange={(e) => setProjectInput(e.target.value)}
          />
          <button type="submit" className="btn">{vi ? 'Tải' : 'Load'}</button>
        </form>
      }
    >
      {err && <PanelEmpty text={err} />}
      {loading && <PanelEmpty text={vi ? 'Đang tải từ Jira…' : 'Loading from Jira…'} />}
      {/* Chưa biết project nào: server không đoán hộ (BOW_PROJECT_KEY chưa đặt) → chỉ đường rõ. */}
      {!loading && !err && sprints === null && (
        <PanelEmpty
          text={vi
            ? 'Nhập mã project (ví dụ DUOCT) ở ô góc phải rồi bấm "Tải" để xem sprint. Đặt BOW_PROJECT_KEY trong .env để lần sau tự điền.'
            : 'Type a project key (e.g. DUOCT) in the top-right box and press "Load" to list sprints. Set BOW_PROJECT_KEY in .env to prefill it next time.'}
        />
      )}

      {sprints && sprints.length > 0 && (
        <>
          <h3 className="panel-sec-title">{vi ? 'Sprint' : 'Sprints'}</h3>
          <div className="jira-sprint-row">
            {sprints.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`jira-sprint${sprintId === s.id ? ' on' : ''}`}
                data-state={s.state}
                onClick={() => openSprint(s.id)}
              >
                <b>{s.name}</b>
                <em>{s.state}</em>
              </button>
            ))}
          </div>
        </>
      )}
      {sprints && sprints.length === 0 && !loading && (
        <PanelEmpty text={vi ? 'Project này không có sprint (board Scrum) nào.' : 'No Scrum sprints for this project.'} />
      )}

      {issues && (
        <>
          <h3 className="panel-sec-title">
            {vi ? `Ticket (${issues.length})` : `Tickets (${issues.length})`}
          </h3>
          {issues.length === 0 ? (
            <PanelEmpty text={vi ? 'Sprint rỗng.' : 'Empty sprint.'} />
          ) : (
            <div className="jira-issue-list">
              {issues.map((it) => (
                <div key={it.key} className="jira-issue">
                  <span className="jira-issue-key">{it.key}</span>
                  <span className="jira-issue-sum" title={it.summary}>{it.summary}</span>
                  <span className="jira-issue-type" data-t={it.issueType.toLowerCase()}>{it.issueType}</span>
                  <span className="jira-issue-status">{it.status}</span>
                  <span className="jira-issue-who">{it.assignee || (vi ? 'Chưa gán' : 'Unassigned')}</span>
                  <button
                    type="button"
                    className="btn jira-issue-go"
                    title={vi ? 'Đưa ticket này vào ô nhập của tác vụ đang mở' : 'Send this ticket to the open task input'}
                    onClick={() => onUseJiraKey(it.key)}
                  >
                    {vi ? 'Giao cho agent' : 'Hand to agent'}
                  </button>
                  {baseUrl && (
                    <a
                      className="jira-issue-link"
                      href={`${baseUrl.replace(/\/$/, '')}/browse/${it.key}`}
                      target="_blank"
                      rel="noreferrer"
                      title={vi ? 'Mở trên Jira' : 'Open in Jira'}
                    >
                      <Icon name="expand" size={13} />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
}
