/**
 * Màn BẢNG ĐẤU — thành tích của hai AI qua các trận duel.
 *
 * Điểm ở đây KHÔNG khích lệ model (không AI nào nhớ trận trước, và điểm không bao giờ được nhồi
 * vào prompt — xem đầu src/core/duelScore.ts). Nó là dữ liệu cho NGƯỜI DÙNG: sau vài chục trận
 * sẽ thấy AI nào thắng loại task nào, để chọn AI mặc định cho đúng việc.
 */
import { useCallback, useEffect, useState } from 'react';
import { PanelShell, PanelEmpty } from './PanelShell.js';
import { Icon } from '../Icon.js';
import { apiFetch } from '../App.js';
import type { NavSectionViewProps } from './NavSectionView.js';
import type { DuelScoreboard } from '../types.js';

/** "/Users/x/GitProject/monorepo" → "monorepo" (bảng chỉ cần biết trận diễn ra ở repo nào). */
function repoName(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd;
}

function when(iso: string, vi: boolean): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(vi ? 'vi-VN' : 'en-US');
}

export function DuelBoardPanel({ language, cfg }: NavSectionViewProps) {
  const vi = language === 'vi';
  const [board, setBoard] = useState<DuelScoreboard | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    if (!cfg?.isAdmin) return;
    setErr('');
    apiFetch('/api/duel/scores')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: DuelScoreboard) => setBoard(d))
      .catch((e: Error) => setErr(e.message));
  }, [cfg?.isAdmin]);

  useEffect(() => { load(); }, [load]);

  const players = board?.players ?? [];
  const matches = board?.matches ?? [];
  const badgeDefs = board?.badges ?? [];

  return (
    <PanelShell
      icon="starChart"
      title={vi ? 'Bảng đấu' : 'Duel board'}
      subtitle={vi ? 'Thành tích hai AI qua các trận duel' : 'Both AIs across duel matches'}
      actions={
        <button className="btn" onClick={load}>
          <Icon name="refresh" size={13} /> {vi ? 'Làm mới' : 'Refresh'}
        </button>
      }
    >
      {!cfg?.isAdmin ? (
        <PanelEmpty text={vi ? 'Chỉ admin xem được bảng đấu.' : 'Admin only.'} />
      ) : err ? (
        <PanelEmpty text={`${vi ? 'Không đọc được bảng đấu' : 'Could not load the board'}: ${err}`} />
      ) : players.length === 0 ? (
        <PanelEmpty
          text={
            vi
              ? 'Chưa có trận nào. Bật công tắc ⚔️ Duel 2 AI ở khung chat rồi giao một task khó.'
              : 'No matches yet. Flip the ⚔️ Duel switch in the chat and hand over a hard task.'
          }
        />
      ) : (
        <>
          <h3 className="panel-sec-title">{vi ? 'Xếp hạng' : 'Standings'}</h3>
          <div className="duel-board-standings">
            {players.map((p, i) => (
              <div key={p.id} className={`duel-board-card${i === 0 ? ' leader' : ''}`}>
                <div className="duel-board-card-head">
                  <span className="duel-board-rank">#{i + 1}</span>
                  <b>{p.label}</b>
                  <span className="duel-board-points">{p.points} {vi ? 'điểm' : 'pts'}</span>
                </div>
                <div className="duel-board-record">
                  {p.wins}{vi ? ' thắng' : 'W'} · {p.losses}{vi ? ' thua' : 'L'} · {p.draws}
                  {vi ? ' hoà' : 'D'} / {p.matches}{vi ? ' trận' : ' matches'}
                  {p.streak !== 0 && (
                    <span className={p.streak > 0 ? 'duel-streak-up' : 'duel-streak-down'}>
                      {' '}· {p.streak > 0
                        ? `${vi ? 'chuỗi' : 'streak'} ${p.streak}🔥`
                        : `${vi ? 'thua' : 'losing'} ${Math.abs(p.streak)}`}
                    </span>
                  )}
                </div>
                <div className="duel-board-sub">
                  🎯 {p.disputesWon} {vi ? 'điểm bất đồng thắng' : 'disputes won'} · 🤝 {p.concessions}{' '}
                  {vi ? 'lần tự nhận sai' : 'concessions'}
                </div>
                <div className="duel-board-badges">
                  {badgeDefs.map((b) => {
                    const owned = p.badges.includes(b.code);
                    return (
                      <span
                        key={b.code}
                        className={`duel-badge-chip${owned ? ' owned' : ''}`}
                        title={`${b.label} — ${b.hint}${owned ? '' : ` (${vi ? 'chưa mở' : 'locked'})`}`}
                      >
                        {b.icon}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <h3 className="panel-sec-title">{vi ? 'Trận gần đây' : 'Recent matches'}</h3>
          <div className="panel-list">
            {matches.map((m, idx) => {
              const winner = m.sides.find((sd) => sd.side === m.winner);
              return (
                <div key={`${m.at}-${idx}`} className="duel-match-row">
                  <div className="duel-match-head">
                    <b>{m.ticket}</b>
                    <span className="duel-match-repo">{repoName(m.cwd)}</span>
                    <span className="duel-match-when">{when(m.at, vi)}</span>
                  </div>
                  <div className="duel-match-body">
                    {winner ? (
                      <span className="duel-match-winner">🏆 {winner.label}</span>
                    ) : (
                      <span className="duel-match-draw">{vi ? '— không bên nào đạt' : '— no winner'}</span>
                    )}
                    {m.sides.map((sd) => (
                      <span key={sd.side} className="duel-match-side">
                        {sd.label}: +{sd.points}
                        {sd.changedFiles > 0 && ` (${sd.changedFiles} file${sd.committed ? '' : vi ? ', chưa commit' : ', uncommitted'})`}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </PanelShell>
  );
}
