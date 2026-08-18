/**
 * Nội dung 3 tab phụ của một tác vụ (tab "Hội thoại" vẫn là khung chat cũ):
 *   • File     — cây file thật của workspace (/api/filetree) + xem nội dung (/api/file-source).
 *   • Ngữ cảnh — những gì agent sẽ mang theo lượt chạy: thư mục, workspace, profile nhận diện,
 *                bộ skill, MCP, và mức dùng context hiện tại.
 *   • Lịch sử  — các cuộc đã lưu của chính tab này (/api/conversations), mở lại tại chỗ.
 *
 * Tất cả CHỈ ĐỌC — không ghi gì, nên không đụng tới cổng duyệt.
 */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon.js';
import { apiFetch, formatTokens } from '../App.js';
import type { Cfg, SkillStatus, Ws } from '../App.js';
import type { ConversationSummary, DetectedSource, UsageSnapshot } from '../types.js';

/* ─────────────────────────────── Tab FILE ─────────────────────────────── */

/**
 * Icon theo LOẠI file — kiểu explorer của VSCode: hình dáng phân nhóm (code / dữ liệu /
 * style / ảnh / shell / văn bản) + màu riêng cho từng đuôi quen thuộc, để liếc là nhận ra
 * file gì. Vẽ SVG tại chỗ (16px, currentColor) thay vì thêm bộ icon ngoài: nhẹ hơn và tô
 * màu được tự do theo đuôi file.
 */
type GlyphKind = 'code' | 'data' | 'style' | 'image' | 'shell' | 'text' | 'lock';

/** Đuôi → [nhóm hình, màu]. Màu mượn bảng quen thuộc của Seti/VSCode để đọc theo phản xạ. */
const FILE_KINDS: Record<string, [GlyphKind, string]> = {
  ts: ['code', '#3178c6'], tsx: ['code', '#3178c6'], mts: ['code', '#3178c6'], cts: ['code', '#3178c6'],
  js: ['code', '#e8bf46'], jsx: ['code', '#e8bf46'], mjs: ['code', '#e8bf46'], cjs: ['code', '#e8bf46'],
  dart: ['code', '#40c4ff'], py: ['code', '#519aba'], go: ['code', '#00add8'], rs: ['code', '#dea584'],
  java: ['code', '#cc3e44'], kt: ['code', '#a97bff'], swift: ['code', '#f05138'], rb: ['code', '#cc3e44'],
  php: ['code', '#a074c4'], sql: ['data', '#3fa5a5'], html: ['code', '#e37933'], vue: ['code', '#41b883'],
  json: ['data', '#cbcb41'], jsonc: ['data', '#cbcb41'], yml: ['data', '#cc6d2e'], yaml: ['data', '#cc6d2e'],
  toml: ['data', '#9c9c6b'], env: ['data', '#8dc149'], xml: ['data', '#e37933'], plist: ['data', '#9c9c6b'],
  css: ['style', '#519aba'], scss: ['style', '#cd6799'], sass: ['style', '#cd6799'], less: ['style', '#519aba'],
  png: ['image', '#a074c4'], jpg: ['image', '#a074c4'], jpeg: ['image', '#a074c4'], gif: ['image', '#a074c4'],
  svg: ['image', '#ffb13b'], webp: ['image', '#a074c4'], ico: ['image', '#a074c4'], pdf: ['text', '#cc3e44'],
  sh: ['shell', '#4d9e46'], bash: ['shell', '#4d9e46'], zsh: ['shell', '#4d9e46'], fish: ['shell', '#4d9e46'],
  md: ['text', '#6a9fb5'], mdx: ['text', '#6a9fb5'], txt: ['text', '#9aa0a6'], csv: ['data', '#8dc149'],
  lock: ['lock', '#9aa0a6'],
};

/** Tên đặc biệt (không có đuôi hoặc đuôi không nói lên gì) — nhận diện theo tên đầy đủ. */
const FILE_NAMES: Record<string, [GlyphKind, string]> = {
  dockerfile: ['data', '#0db7ed'],
  makefile: ['shell', '#9aa0a6'],
  '.gitignore': ['data', '#f14e32'],
  '.dockerignore': ['data', '#0db7ed'],
  '.bow-skip': ['data', '#9aa0a6'],
};

function fileKind(name: string): [GlyphKind, string] {
  const lower = name.toLowerCase();
  const byName = FILE_NAMES[lower];
  if (byName) return byName;
  const ext = lower.includes('.') ? lower.split('.').pop()! : '';
  return FILE_KINDS[ext] ?? ['text', '#9aa0a6'];
}

/** Nét vẽ riêng của từng nhóm, đặt trong khung tờ giấy chung. */
const GLYPH_MARKS: Record<GlyphKind, JSX.Element> = {
  code: <path d="M6 9.5 4 11.5l2 2M10 9.5l2 2-2 2" />,
  data: <path d="M6.2 9.5c-.9 0-1.2.5-1.2 1.2v.8c0 .6-.3 1-.9 1 .6 0 .9.4.9 1v.8c0 .7.3 1.2 1.2 1.2M9.8 9.5c.9 0 1.2.5 1.2 1.2v.8c0 .6.3 1 .9 1-.6 0-.9.4-.9 1v.8c0 .7-.3 1.2-1.2 1.2" />,
  style: <path d="M8 9.3c1.6 1.7 2.6 3 2.6 4a2.6 2.6 0 1 1-5.2 0c0-1 1-2.3 2.6-4Z" />,
  image: <><rect x="4.4" y="9.6" width="7.2" height="5.4" rx="1" /><path d="m4.8 14 2-2.2 1.7 1.6 1.3-1.1 1.4 1.4" /></>,
  shell: <path d="m4.8 10 2.2 2-2.2 2M8.6 14.2h2.8" />,
  text: <path d="M5 10h6M5 12.2h6M5 14.4h4" />,
  lock: <><rect x="5.4" y="11.6" width="5.2" height="3.6" rx="0.8" /><path d="M6.8 11.6v-1a1.2 1.2 0 0 1 2.4 0v1" /></>,
};

/** Icon một file: khung tờ giấy góc gập + nét của nhóm, tô màu theo đuôi. */
function FileGlyph({ name }: { name: string }) {
  const [kind, color] = fileKind(name);
  return (
    <svg className="ftree-ico" width="16" height="16" viewBox="0 0 16 16" fill="none"
      stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 1.8H4.6a1.3 1.3 0 0 0-1.3 1.3v9.8a1.3 1.3 0 0 0 1.3 1.3h6.8a1.3 1.3 0 0 0 1.3-1.3V5.2Z" opacity=".45" />
      <path d="M9 1.8v2.6a.8.8 0 0 0 .8.8h2.9" opacity=".45" />
      {GLYPH_MARKS[kind]}
    </svg>
  );
}

/** Icon thư mục — mở/đóng như explorer, dùng màu accent của theme (không bảng màu riêng). */
function FolderGlyph({ open }: { open: boolean }) {
  return (
    <svg className="ftree-ico ftree-ico-dir" width="16" height="16" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {open
        ? <path d="M2.2 12.6V4.4a1 1 0 0 1 1-1h2.9l1.4 1.6h4.3a1 1 0 0 1 1 1v1.1M2.2 12.6l1.7-4.4a1 1 0 0 1 .9-.6h9.1a.7.7 0 0 1 .7.9l-1.2 3.5a1 1 0 0 1-1 .6Z" />
        : <path d="M2.2 4.4a1 1 0 0 1 1-1h2.9l1.4 1.6h5.3a1 1 0 0 1 1 1v6.6a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1Z" />}
    </svg>
  );
}

/** Một nút trong cây: thư mục (có children) hoặc file (có số dòng). */
interface TreeNode {
  name: string;
  /** Đường dẫn đầy đủ tính từ gốc repo — cũng là khoá đóng/mở và khoá đọc nội dung. */
  path: string;
  dir: boolean;
  lines: number;
  children: TreeNode[];
}

/**
 * Dựng cây từ danh sách đường dẫn phẳng của `/api/filetree`. Sắp xếp kiểu explorer:
 * thư mục trước, rồi theo alphabet (so sánh tự nhiên để "file10" không đứng trước "file2").
 */
function buildTree(files: { path: string; lines: number }[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', dir: true, lines: 0, children: [] };
  const dirIndex = new Map<string, TreeNode>([['', root]]);

  for (const f of files) {
    const parts = f.path.split('/');
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let node = dirIndex.get(path);
      if (!node) {
        node = { name: parts[i], path, dir: true, lines: 0, children: [] };
        dirIndex.set(path, node);
        parent.children.push(node);
      }
      parent = node;
    }
    parent.children.push({ name: parts[parts.length - 1], path: f.path, dir: false, lines: f.lines, children: [] });
  }

  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.dir === b.dir
      ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      : a.dir ? -1 : 1));
    for (const n of nodes) if (n.dir) sort(n.children);
  };
  sort(root.children);
  return root.children;
}

export function FilesTab({ language }: { language: 'vi' | 'en' }) {
  const vi = language === 'vi';
  const [files, setFiles] = useState<{ path: string; lines: number }[] | null>(null);
  const [repo, setRepo] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [source, setSource] = useState<string>('');
  const [err, setErr] = useState('');
  /** Thư mục đang mở (đóng hết lúc đầu — repo lớn mở sẵn là ngợp). */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    apiFetch('/api/filetree')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { files?: { path: string; lines: number }[]; repoName?: string }) => {
        setFiles(d.files ?? []);
        setRepo(d.repoName ?? '');
      })
      .catch((e: Error) => setErr(e.message));
  }, []);

  const openFile = useCallback((path: string) => {
    setOpen(path);
    setSource('');
    apiFetch(`/api/file-source?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        return d as { binary: boolean; lines: string[]; truncated?: boolean };
      })
      .then((d) => setSource(
        d.binary
          ? (vi ? '(file nhị phân — không xem được)' : '(binary file — not previewable)')
          : d.lines.join('\n') + (d.truncated ? (vi ? '\n… (đã cắt ở 2000 dòng)' : '\n… (truncated at 2000 lines)') : ''),
      ))
      .catch((e: Error) => setSource(`${vi ? 'Không đọc được file' : 'Could not read file'}: ${e.message}`));
  }, [vi]);

  const query = q.trim().toLowerCase();
  // Có từ khoá → danh sách PHẲNG kết quả (như ô Go-to-file của VSCode); không → cây thư mục.
  const matches = query ? (files ?? []).filter((f) => f.path.toLowerCase().includes(query)) : [];
  const tree = !query && files ? buildTree(files) : [];

  const toggleDir = (path: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (!next.delete(path)) next.add(path);
    return next;
  });

  /** Vẽ đệ quy một mức cây; chỉ dựng con của thư mục ĐANG MỞ nên repo lớn vẫn nhẹ. */
  const renderNodes = (nodes: TreeNode[], depth: number): JSX.Element[] =>
    nodes.flatMap((n) => {
      const pad = { paddingLeft: `${8 + depth * 13}px` };
      if (!n.dir) {
        return [(
          <button
            key={n.path}
            type="button"
            className={`ftree-row${open === n.path ? ' on' : ''}`}
            style={pad}
            onClick={() => openFile(n.path)}
            title={n.path}
          >
            <FileGlyph name={n.name} />
            <span className="ftree-name">{n.name}</span>
            <em>{n.lines}</em>
          </button>
        )];
      }
      const isOpen = expanded.has(n.path);
      return [
        (
          <button
            key={n.path}
            type="button"
            className={`ftree-row ftree-dir${isOpen ? ' open' : ''}`}
            style={pad}
            onClick={() => toggleDir(n.path)}
            title={n.path}
            aria-expanded={isOpen}
          >
            <Icon name={isOpen ? 'caretDown' : 'caretRight'} size={12} />
            <FolderGlyph open={isOpen} />
            <span className="ftree-name">{n.name}</span>
          </button>
        ),
        ...(isOpen ? renderNodes(n.children, depth + 1) : []),
      ];
    });

  return (
    <div className="ws-tabview files-tab">
      <div className="files-head">
        <b>{repo || (vi ? 'Workspace' : 'Workspace')}</b>
        <input
          className="panel-input"
          placeholder={vi ? 'Lọc theo tên file…' : 'Filter by file name…'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="files-count">{query ? matches.length : (files?.length ?? 0)}</span>
      </div>
      {err && <div className="panel-empty">{err}</div>}
      {!err && files === null && <div className="panel-empty">{vi ? 'Đang tải cây file…' : 'Loading file tree…'}</div>}
      <div className="files-body">
        <div className="files-list">
          {query
            ? matches.slice(0, 500).map((f) => {
              const name = f.path.split('/').pop() ?? f.path;
              const dir = f.path.slice(0, f.path.length - name.length - 1);
              return (
                <button
                  key={f.path}
                  type="button"
                  className={`ftree-row${open === f.path ? ' on' : ''}`}
                  onClick={() => openFile(f.path)}
                  title={f.path}
                >
                  <FileGlyph name={name} />
                  <span className="ftree-name">{name}</span>
                  {/* Kết quả tìm cần biết file nằm ở đâu → kèm thư mục mờ phía sau. */}
                  {dir && <span className="ftree-dirhint">{dir}</span>}
                  <em>{f.lines}</em>
                </button>
              );
            })
            : renderNodes(tree, 0)}
          {files !== null && query && matches.length === 0 && (
            <div className="panel-empty">{vi ? 'Không có file khớp.' : 'No matching file.'}</div>
          )}
        </div>
        <div className="files-view">
          {open ? (
            <>
              <div className="files-view-head">{open}</div>
              <pre className="files-source">{source || (vi ? 'Đang đọc…' : 'Reading…')}</pre>
            </>
          ) : (
            <div className="panel-empty">{vi ? 'Chọn một file để xem nội dung.' : 'Pick a file to preview.'}</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────── Tab NGỮ CẢNH ────────────────────────────── */

interface ContextTabProps {
  language: 'vi' | 'en';
  cwd: string;
  cfg: Cfg | null;
  currentWs: Ws | null;
  detected: DetectedSource | null;
  skillStatus: SkillStatus | null;
  skillStacks: { id: string; label: string; ref: string; default: boolean }[];
  stack: string;
  selectedMcps: string[];
  usage: UsageSnapshot | null;
}

export function ContextTab({
  language, cwd, cfg, currentWs, detected, skillStatus, skillStacks, stack, selectedMcps, usage,
}: ContextTabProps) {
  const vi = language === 'vi';
  const stackLabel = skillStacks.find((s) => s.id === stack)?.label ?? stack;
  const ctxPct = usage?.contextPercentage != null ? Math.round(usage.contextPercentage) : null;

  return (
    <div className="ws-tabview context-tab">
      <div className="ctx-grid">
        <article className="ctx-card">
          <h4><Icon name="folder" size={14} /> {vi ? 'Thư mục làm việc' : 'Working directory'}</h4>
          <code>{cwd || cfg?.defaultCwd || '—'}</code>
          {currentWs && (
            <p>{vi ? 'Thuộc workspace' : 'In workspace'} <b>{currentWs.slug}</b> · {currentWs.repos.length} repo</p>
          )}
        </article>

        <article className="ctx-card">
          <h4><Icon name="search" size={14} /> {vi ? 'Nhận diện nguồn' : 'Detected source'}</h4>
          {detected ? (
            <>
              <p>{detected.summary}</p>
              <div className="settings-card-meta">
                <span className="repo-chip">{detected.profile || (vi ? 'không profile' : 'no profile')}</span>
                <span className="repo-chip">{detected.stack}</span>
                {detected.profileChars != null && <span className="repo-chip">{formatTokens(detected.profileChars)} ký tự</span>}
              </div>
            </>
          ) : (
            <p>{vi ? 'Chưa nhận diện.' : 'Not detected yet.'}</p>
          )}
        </article>

        <article className="ctx-card">
          <h4><Icon name="magic" size={14} /> {vi ? 'Bộ kỹ năng' : 'Skill bundles'}</h4>
          <div className="settings-card-meta">
            <span className="repo-chip">core: {skillStatus?.core.state ?? '—'}</span>
            <span className="repo-chip">{stackLabel || (vi ? 'không stack' : 'no stack')}: {skillStatus?.stack?.state ?? '—'}</span>
          </div>
        </article>

        <article className="ctx-card">
          <h4><Icon name="mcp" size={14} /> MCP</h4>
          <div className="settings-card-meta">
            {selectedMcps.length > 0
              ? selectedMcps.map((m) => <span key={m} className="repo-chip">{m}</span>)
              : <span className="repo-chip">{vi ? 'không dùng' : 'none'}</span>}
          </div>
        </article>

        <article className="ctx-card">
          <h4><Icon name="info" size={14} /> {vi ? 'Cửa sổ ngữ cảnh' : 'Context window'}</h4>
          {usage?.contextTokens != null && usage.contextMaxTokens ? (
            <>
              <p>
                {formatTokens(usage.contextTokens)} / {formatTokens(usage.contextMaxTokens)}
                {ctxPct != null ? ` · ${ctxPct}%` : ''}
              </p>
              <div className="ctx-bar"><i style={{ width: `${Math.min(ctxPct ?? 0, 100)}%` }} /></div>
            </>
          ) : (
            <p>{vi ? 'Chưa có số liệu (chạy một lượt để đo).' : 'No data yet (run once to measure).'}</p>
          )}
        </article>
      </div>
    </div>
  );
}

/* ─────────────────────────────── Tab LỊCH SỬ ─────────────────────────────── */

interface HistoryTabProps {
  language: 'vi' | 'en';
  activeConvId: string | null;
  /** Cửa sổ chat đang mở — mặc định chỉ hiện lịch sử của CHÍNH nó. */
  tabId: string;
  onOpen: (id: string) => void;
}

/**
 * Lịch sử CỦA CỬA SỔ CHAT NÀY: `/api/conversations` trả mọi cuộc người dùng được xem, nên
 * lọc theo `tabId` ngay ở client (danh sách là summary, không kèm items → nhẹ). Cuộc tạo
 * trước khi có field tabId nằm ở nhóm "không thuộc cửa sổ nào" — vẫn mở được qua nút
 * "Tất cả cửa sổ" để không mất truy cập.
 */
export function HistoryTab({ language, activeConvId, tabId, onOpen }: HistoryTabProps) {
  const vi = language === 'vi';
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    apiFetch('/api/conversations')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { conversations: ConversationSummary[] }) => setList(d.conversations ?? []))
      .catch((e: Error) => setErr(e.message));
  }, []);

  const mine = (list ?? []).filter((c) => c.tabId === tabId);
  const rows = (all ? (list ?? []) : mine)
    .filter((c) => !q.trim() || c.title.toLowerCase().includes(q.trim().toLowerCase()));
  const otherCount = (list ?? []).length - mine.length;

  return (
    <div className="ws-tabview history-tab">
      <div className="files-head">
        <b>{all ? (vi ? 'Mọi cửa sổ' : 'All windows') : (vi ? 'Cửa sổ này' : 'This window')}</b>
        <input
          className="panel-input"
          placeholder={vi ? 'Tìm theo tiêu đề…' : 'Search by title…'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {otherCount > 0 && (
          <button
            type="button"
            className={`hist-scope${all ? ' on' : ''}`}
            onClick={() => setAll((v) => !v)}
            title={
              vi
                ? 'Lịch sử mặc định chỉ gồm các cuộc của cửa sổ chat này. Bật để xem cả cuộc của cửa sổ khác (và cuộc cũ chưa gắn cửa sổ).'
                : 'History defaults to this chat window only. Toggle to include other windows (and older unassigned chats).'
            }
          >
            {vi ? `Tất cả (+${otherCount})` : `All (+${otherCount})`}
          </button>
        )}
        <span className="files-count">{rows.length}</span>
      </div>
      {err && <div className="panel-empty">{err}</div>}
      {!err && list === null && <div className="panel-empty">{vi ? 'Đang tải…' : 'Loading…'}</div>}
      <div className="panel-list">
        {rows.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`hist-row${c.id === activeConvId ? ' on' : ''}`}
            onClick={() => onOpen(c.id)}
            title={c.cwd}
          >
            <span className="hist-row-title">{c.title || (vi ? '(không tiêu đề)' : '(untitled)')}</span>
            {all && c.tabId !== tabId && <em className="hist-row-tag">{vi ? 'cửa sổ khác' : 'other window'}</em>}
            <span className="hist-row-meta">{c.itemCount} · {new Date(c.updatedAt).toLocaleString(vi ? 'vi-VN' : 'en-US')}</span>
          </button>
        ))}
        {list !== null && rows.length === 0 && (
          <div className="panel-empty">
            {q.trim()
              ? (vi ? 'Không có cuộc nào khớp.' : 'No matching conversation.')
              : (vi ? 'Cửa sổ chat này chưa có cuộc nào được lưu.' : 'This chat window has no saved conversation yet.')}
          </div>
        )}
      </div>
    </div>
  );
}
