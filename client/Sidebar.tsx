import { useMemo, useState } from 'react';
import { ArrowDown, ChevronDown, ChevronRight, Circle, Folder, GitBranch, Layers3, Search, Settings2, X } from 'lucide-react';
import type { SessionList, SessionSummary } from '../shared/types';
import { clock, dateGroup, tokens } from './format';

interface Props {
  data: SessionList | null;
  selectedId: string | null;
  query: string;
  project: string;
  loading: boolean;
  error: string;
  onQuery: (query: string) => void;
  onProject: (project: string) => void;
  onSelect: (session: SessionSummary) => void;
  onLoadMore: () => void;
  onSettings: () => void;
  onClose: () => void;
}

export function Sidebar({ data, selectedId, query, project, loading, error, onQuery, onProject, onSelect, onLoadMore, onSettings, onClose }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const result = new Map<string, SessionSummary[]>();
    for (const session of data?.items ?? []) {
      const key = dateGroup(session.startedAt);
      result.set(key, [...(result.get(key) ?? []), session]);
    }
    return [...result];
  }, [data?.items]);
  const progress = data?.progress;
  return <aside className="sidebar">
    <div className="brand-row"><div className="brand-symbol"><Layers3 size={21} strokeWidth={1.6} /></div><div><strong>会话观察台</strong><span>SESSION LENS</span></div><button className="icon-button sidebar-close" onClick={onClose} title="收起侧栏" aria-label="收起侧栏"><X size={17} /></button></div>
    <div className="sidebar-controls">
      <label className="search-box"><Search size={16} /><input id="session-search" placeholder="搜索会话与对话…" value={query} onChange={event => onQuery(event.target.value)} aria-label="搜索会话与对话正文" /><kbd>/</kbd></label>
      <label className="project-picker"><Folder size={15} /><select value={project} onChange={event => onProject(event.target.value)} aria-label="筛选项目"><option value="">所有项目</option>{data?.projects.map(item => <option value={item.path} key={item.path}>{item.name} ({item.count})</option>)}</select><ChevronDown size={13} /></label>
    </div>
    <div className="sidebar-section-label"><span>本地会话</span><span>{data ? data.total.toLocaleString() : '—'}</span></div>
    <div className="session-scroll">
      {error && <div className="inline-error" role="alert">{error}</div>}
      {loading && !data && <div className="sidebar-skeleton"><span /><span /><span /></div>}
      {groups.map(([label, sessions]) => <section className="date-group" key={label}>
        <button className="date-heading" onClick={() => setCollapsed(previous => { const next = new Set(previous); next.has(label) ? next.delete(label) : next.add(label); return next; })} aria-expanded={!collapsed.has(label)}>{collapsed.has(label) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<span>{label}</span><small>{sessions.length}</small></button>
        {!collapsed.has(label) && sessions.map(session => <button className={`session-item ${selectedId === session.id ? 'selected' : ''} ${session.parentId ? 'child-session' : ''}`} key={session.id} onClick={() => onSelect(session)} title={`${session.title}\n${session.cwd}`} aria-current={selectedId === session.id ? 'page' : undefined}>
          <div className="session-title">{session.parentId && <GitBranch size={12} />}<span>{session.title || session.project || '未命名会话'}</span>{session.status === 'running' && <Circle size={7} className="running-dot" fill="currentColor" />}</div>
          <div className="session-preview">{session.match?.excerpt || session.cwd || '工作目录未记录'}</div>
          <div className="session-meta"><span>{session.project || session.source || 'Codex'}</span><span>{tokens(session.usage.tokens?.totalTokens)} tok</span><time>{clock(session.startedAt)}</time></div>
        </button>)}
      </section>)}
      {!loading && data?.items.length === 0 && <div className="sidebar-empty"><Search size={22} /><span>{query || project ? '没有找到匹配的会话' : progress?.status === 'scanning' ? '正在发现会话…' : '这个目录中还没有会话'}</span><small>{query ? '试试更短的关键词' : '在设置中检查日志目录'}</small></div>}
      {data?.nextCursor != null && <button className="load-more" disabled={loading} onClick={onLoadMore}><ArrowDown size={14} />{loading ? '正在加载…' : '加载更多会话'}</button>}
    </div>
    <div className="sidebar-footer"><div className="local-indicator"><span className={`dot ${progress?.status === 'error' ? 'danger-dot' : ''}`} /><div><span>{progress?.status === 'scanning' ? '正在建立索引' : progress?.status === 'error' ? '索引遇到问题' : '本地文件 · 只读'}</span><small>{progress?.status === 'scanning' ? `${progress.indexed} / ${progress.discovered} 个文件` : '所有数据保留在这台电脑'}</small></div></div><button className="icon-button" onClick={onSettings} aria-label="设置" title="设置 (,)"><Settings2 size={17} /></button></div>
    {progress?.status === 'scanning' && <div className="index-track"><div style={{ width: `${progress.discovered ? Math.min(100, progress.indexed / progress.discovered * 100) : 0}%` }} /></div>}
  </aside>;
}
