/**
 * Màn NGUỒN MÃ — repo đang làm việc, các workspace đã khai báo, và worktree song song.
 * Chỉ đọc + mở lại các modal đã có (chọn thư mục / workspace) để không nhân đôi logic ghi.
 */
import { useEffect, useState } from 'react';
import { PanelShell, PanelEmpty } from './PanelShell.js';
import { apiFetch } from '../App.js';
import type { Ws } from '../App.js';
import type { NavSectionViewProps } from './NavSectionView.js';

/** Khớp WorktreeEntry ở src/core/gitWorktree.ts (git worktree list --porcelain). */
interface Worktree {
  path: string;
  branch?: string;
  head?: string;
}

export function ReposPanel({ language, cwd, cfg, onOpenModal }: NavSectionViewProps) {
  const vi = language === 'vi';
  const [workspaces, setWorkspaces] = useState<Ws[] | null>(null);
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    apiFetch('/api/workspaces')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { workspaces: Ws[] }) => setWorkspaces(d.workspaces ?? []))
      .catch((e: Error) => setErr(e.message));
  }, []);

  useEffect(() => {
    if (!cwd.trim() || !cfg?.isAdmin) return;
    apiFetch(`/api/worktree/list?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { worktrees: Worktree[] }) => setWorktrees(d.worktrees ?? []))
      .catch(() => setWorktrees([]));
  }, [cwd, cfg?.isAdmin]);

  return (
    <PanelShell
      icon="folder"
      title={vi ? 'Nguồn mã' : 'Repos'}
      subtitle={vi ? 'Thư mục agent đang làm việc, workspace và worktree song song' : 'Working directory, workspaces and parallel worktrees'}
      actions={cfg?.isAdmin ? (
        <>
          <button className="btn" onClick={() => onOpenModal('picker')}>{vi ? 'Đổi thư mục' : 'Change folder'}</button>
          <button className="btn" onClick={() => onOpenModal('workspace')}>{vi ? 'Workspace' : 'Workspace'}</button>
        </>
      ) : undefined}
    >
      <h3 className="panel-sec-title">{vi ? 'Đang làm việc tại' : 'Working directory'}</h3>
      <div className="repo-current">
        <code>{cwd || cfg?.defaultCwd || '—'}</code>
      </div>

      <h3 className="panel-sec-title">{vi ? 'Workspace đã khai báo' : 'Registered workspaces'}</h3>
      {err && <PanelEmpty text={err} />}
      {!err && workspaces === null && <PanelEmpty text={vi ? 'Đang tải…' : 'Loading…'} />}
      {workspaces?.length === 0 && (
        <PanelEmpty text={vi ? 'Chưa khai báo workspace nào.' : 'No workspace registered yet.'} />
      )}
      {workspaces && workspaces.length > 0 && (
        <div className="panel-list">
          {workspaces.map((ws) => (
            <div key={ws.slug} className="repo-ws">
              <b>{ws.slug}</b>
              <code>{ws.dir}</code>
              <div className="repo-ws-repos">
                {ws.repos.map((r) => (
                  <span key={r.path} className="repo-chip" title={r.path}>
                    {r.role}: {r.path.split('/').pop()}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {cfg?.isAdmin && (
        <>
          <h3 className="panel-sec-title">{vi ? 'Worktree song song' : 'Parallel worktrees'}</h3>
          {worktrees === null && <PanelEmpty text={vi ? 'Đang tải…' : 'Loading…'} />}
          {worktrees?.length === 0 && (
            <PanelEmpty text={vi ? 'Repo này chưa có worktree phụ nào.' : 'No extra worktree for this repo.'} />
          )}
          {worktrees && worktrees.length > 0 && (
            <div className="panel-list">
              {worktrees.map((w) => (
                <div key={w.path} className="repo-wt">
                  <b>{w.branch || '(detached)'}</b>
                  <code>{w.path}</code>
                  {w.path === cwd && <span className="repo-chip">{vi ? 'đang mở' : 'current'}</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
}
