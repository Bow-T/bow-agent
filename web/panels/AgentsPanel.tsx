/**
 * Màn ĐỘI AGENT — ai đang làm gì trong "vũ trụ" của tab đang mở.
 *
 * Hai nguồn dữ liệu, cố ý tách bạch:
 *   • /api/agents  → ĐỊNH NGHĨA subagent thật của backend (buildSubagents ở src/core/subagents.ts):
 *     tên, mô tả, model, bộ tool. Không đoán, không hardcode lại ở client.
 *   • props.agents → TRẠNG THÁI live (SOL/VEGA/ORION/LYRA đang sáng hay không) do TaskPane suy
 *     từ dòng sự kiện của phiên đang chạy.
 */
import { useEffect, useState } from 'react';
import { PanelShell, PanelEmpty } from './PanelShell.js';
import { apiFetch } from '../App.js';
import type { NavSectionViewProps } from './NavSectionView.js';

interface AgentDef {
  id: string;
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  /** Subagent riêng của profile repo (không thuộc bộ chuẩn). */
  fromProfile?: boolean;
}

export function AgentsPanel({ language, cfg, agents, useSubagents, setUseSubagents }: NavSectionViewProps) {
  const vi = language === 'vi';
  const [defs, setDefs] = useState<AgentDef[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    apiFetch('/api/agents')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { agents: AgentDef[] }) => setDefs(d.agents ?? []))
      .catch((e: Error) => setErr(e.message));
  }, []);

  const liveById = new Map(agents.map((a) => [a.id, a]));
  const mainStar = liveById.get('main');

  return (
    <PanelShell
      icon="agent"
      title={vi ? 'Đội agent' : 'Agent crew'}
      subtitle={vi
        ? 'Agent chính và các agent phụ được phép giao việc trong phiên'
        : 'Main agent and the subagents it may delegate to'}
      actions={cfg?.isAdmin ? (
        <label className="panel-toggle">
          <input
            type="checkbox"
            checked={useSubagents}
            onChange={(e) => setUseSubagents(e.target.checked)}
          />
          <span>{vi ? 'Bật đội agent' : 'Enable crew'}</span>
        </label>
      ) : undefined}
    >
      {/* Agent chính luôn có, không đến từ /api/agents (nó LÀ phiên đang chạy). */}
      <div className="agent-card-grid">
        <article className={`agent-card${mainStar?.active ? ' live' : ''}`} data-k="approval">
          <header>
            <b>{mainStar?.label || 'SOL'}</b>
            <span className="agent-card-role">{mainStar?.role || (vi ? 'Điều phối' : 'Orchestration')}</span>
            <em className={`agent-card-state${mainStar?.active ? ' on' : ''}`}>
              {mainStar?.active ? (vi ? 'ĐANG CHẠY' : 'RUNNING') : (vi ? 'RẢNH' : 'IDLE')}
            </em>
          </header>
          <p>
            {vi
              ? 'Agent chính của phiên: đọc yêu cầu, lập kế hoạch và thực thi thay đổi. Mọi thao tác ghi vẫn phải qua cổng duyệt.'
              : 'Main session agent: reads the request, plans and executes changes. Every write still goes through the approval gate.'}
          </p>
          <footer>{vi ? 'Luôn hoạt động' : 'Always on'}</footer>
        </article>

        {(defs ?? []).map((d) => {
          const live = liveById.get(d.id) ?? liveById.get(d.name.toLowerCase());
          return (
            <article key={d.id} className={`agent-card${live?.active ? ' live' : ''}`} data-k={live?.type || 'thinking'}>
              <header>
                <b>{live?.label || d.name.toUpperCase()}</b>
                <span className="agent-card-role">{live?.role || d.name}</span>
                <em className={`agent-card-state${live?.active ? ' on' : ''}`}>
                  {live?.active ? (vi ? 'ĐANG CHẠY' : 'RUNNING') : (vi ? 'CHỜ' : 'STANDBY')}
                </em>
              </header>
              <p>{d.description}</p>
              <footer>
                <span className="agent-card-name">{d.name}</span>
                {d.model && <span className="agent-card-model">{d.model}</span>}
                {d.fromProfile && <span className="agent-card-model">{vi ? 'từ profile' : 'from profile'}</span>}
                {d.tools && d.tools.length > 0 && (
                  <span className="agent-card-tools" title={d.tools.join(', ')}>
                    {d.tools.slice(0, 4).join(' · ')}{d.tools.length > 4 ? ' …' : ''}
                  </span>
                )}
              </footer>
            </article>
          );
        })}
      </div>

      {err && <PanelEmpty text={vi ? `Không đọc được danh sách agent: ${err}` : `Could not load agents: ${err}`} />}
      {!err && defs === null && <PanelEmpty text={vi ? 'Đang tải…' : 'Loading…'} />}
      {!err && defs !== null && defs.length === 0 && (
        <PanelEmpty text={vi ? 'Chưa có agent phụ nào được định nghĩa.' : 'No subagents defined.'} />
      )}
      {!useSubagents && cfg?.isAdmin && (
        <div className="panel-note">
          {vi
            ? 'Đội agent đang TẮT — phiên chạy một mình agent chính. Bật ở góc phải để agent chính được giao việc cho các agent phụ.'
            : 'The crew is OFF — only the main agent runs. Turn it on (top right) to let it delegate.'}
        </div>
      )}
    </PanelShell>
  );
}
