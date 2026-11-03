import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ChevronDown, ChevronRight, Circle, Folder, GitBranch, Layers3, Search, Settings2, X } from 'lucide-react';
import type { SessionChildrenPage, SessionList, SessionSummary } from '../shared/types';
import { clock, dateGroup, tokens } from './format';
import { api, errorMessage, sessionPath } from './api';
import { mergeSessions, sessionAncestors, sidebarSessionTree, type SessionTreeNode } from './session-tree';
import './Sidebar.css';

interface Branch extends SessionChildrenPage { loading: boolean; error: string }

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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [branches, setBranches] = useState<Map<string, Branch>>(new Map());
  const branchRef = useRef(branches);
  const pending = useRef(new Map<string, AbortController>());
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const filterKey = query.trim() || project ? JSON.stringify([query.trim(), project]) : '';
  const filtering = Boolean(filterKey);
  const filterRef = useRef(filterKey);
  filterRef.current = filterKey;
  const updateBranch = useCallback((id: string, value: Branch) => {
    const next = new Map(branchRef.current);
    next.set(id, value);
    branchRef.current = next;
    setBranches(next);
  }, []);

  const loadBranch = useCallback(async (id: string, mode: 'initial' | 'refresh' | 'more') => {
    if (filterRef.current) return;
    const previous = branchRef.current.get(id);
    if (mode === 'initial' && previous) return;
    if (mode === 'more' && (!previous || previous.nextCursor == null || pending.current.has(id))) return;
    pending.current.get(id)?.abort();
    const controller = new AbortController();
    pending.current.set(id, controller);
    const old = previous ?? { items: [], total: 0, nextCursor: null, loading: false, error: '' };
    updateBranch(id, { ...old, loading: true, error: '' });
    try {
      let cursor: number | null = mode === 'more' ? old.nextCursor : 0;
      const targetCount = mode === 'refresh' ? Math.max(50, old.items.length) : 50;
      let items: SessionSummary[] = [];
      let total = old.total;
      do {
        const page: SessionChildrenPage = await api(`${sessionPath(id)}/children?cursor=${cursor}&limit=50`, { signal: controller.signal });
        items = mergeSessions(items, page.items);
        total = page.total;
        cursor = page.nextCursor;
      } while (mode === 'refresh' && cursor != null && items.length < targetCount && !controller.signal.aborted);
      if (controller.signal.aborted || filterRef.current || pending.current.get(id) !== controller) return;
      updateBranch(id, { items: mode === 'more' ? mergeSessions(old.items, items) : items, total, nextCursor: cursor, loading: false, error: '' });
    } catch (failure) {
      if (!controller.signal.aborted && pending.current.get(id) === controller) updateBranch(id, { ...old, loading: false, error: errorMessage(failure) });
    } finally {
      if (pending.current.get(id) === controller) pending.current.delete(id);
    }
  }, [updateBranch]);

  useEffect(() => {
    if (filtering || !data) {
      for (const controller of pending.current.values()) controller.abort();
      pending.current.clear();
      const next = !data ? new Map<string, Branch>() : new Map([...branchRef.current].map(([id, branch]) => [id, { ...branch, loading: false }]));
      branchRef.current = next;
      setBranches(next);
    }
  }, [filtering, data === null]);
  useEffect(() => () => { for (const controller of pending.current.values()) controller.abort(); }, []);

  const tree = useMemo(() => sidebarSessionTree(data, branches, filtering), [data?.items, data?.ancestors, data?.selected, branches, filtering]);
  const matchIds = useMemo(() => new Set(data?.items.map(session => session.id)), [data?.items]);
  const groups = useMemo(() => {
    const result = new Map<string, SessionTreeNode[]>();
    for (const node of tree.roots) {
      const key = dateGroup(node.session.startedAt);
      result.set(key, [...(result.get(key) ?? []), node]);
    }
    return [...result];
  }, [tree]);

  const revealIds = filtering ? [...matchIds] : selectedId ? [selectedId] : [];
  const revealParents = [...new Set(revealIds.flatMap(id => sessionAncestors(tree, id)))].sort();
  const revealDates = [...new Set(revealIds.flatMap(id => {
    const parents = sessionAncestors(tree, id);
    const root = tree.byId.get(parents.at(-1) ?? id);
    return root ? [dateGroup(root.session.startedAt)] : [];
  }))].sort();
  // A stable path signature permits manual collapse even while SSE updates summaries.
  const revealKey = JSON.stringify([filterKey, selectedId, filtering ? revealIds.sort() : [], revealParents, revealDates]);
  useEffect(() => {
    setExpanded(previous => new Set([...previous, ...revealParents]));
    setCollapsed(previous => new Set([...previous].filter(label => !revealDates.includes(label))));
    const frame = requestAnimationFrame(() => selectedButton.current?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [revealKey]);

  const previousData = useRef<SessionList | null>(null);
  const previousExpanded = useRef<Set<string>>(new Set());
  const previousFiltering = useRef(filtering);
  useEffect(() => {
    const changed = previousData.current?.items !== data?.items || previousData.current?.ancestors !== data?.ancestors || previousData.current?.selected !== data?.selected || previousFiltering.current !== filtering;
    const opened = previousExpanded.current;
    previousData.current = data;
    previousExpanded.current = expanded;
    previousFiltering.current = filtering;
    if (!data || filtering) return;
    for (const id of expanded) {
      // Reopening always revalidates its cache, including changes received while collapsed.
      if (tree.byId.has(id)) void loadBranch(id, (changed || !opened.has(id)) && branchRef.current.has(id) ? 'refresh' : 'initial');
    }
  }, [data?.items, data?.ancestors, data?.selected, expanded, filtering, loadBranch]);

  function renderNode(node: SessionTreeNode) {
    const session = node.session;
    const open = expanded.has(session.id);
    const branch = branches.get(session.id);
    const count = filtering ? node.children.length : session.childCount ?? Math.max(node.children.length, branch?.total ?? 0);
    const name = session.title || session.project || '未命名会话';
    const childrenId = `session-children-${encodeURIComponent(session.id)}`;
    return <li key={session.id}>
      <div className="session-tree-row">
        {count > 0 ? <button className="session-tree-toggle" aria-label={`${open ? '收起' : '展开'}${name}的子会话`} aria-expanded={open} aria-controls={childrenId} onClick={() => setExpanded(previous => {
          const next = new Set(previous);
          next.has(session.id) ? next.delete(session.id) : next.add(session.id);
          return next;
        })}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="session-tree-spacer" />}
        <button className={`session-item ${selectedId === session.id ? 'selected' : ''}`} data-session-id={session.id} ref={selectedId === session.id ? selectedButton : undefined} onClick={() => onSelect(session)} title={`${session.title}\n${session.cwd}`} aria-current={selectedId === session.id ? 'page' : undefined}>
          <div className="session-title">{session.parentId && <GitBranch size={12} />}<span>{name}</span>{filtering && !matchIds.has(session.id) && <small className="session-parent-label">父级</small>}{count > 0 && <small className="session-child-count" title={`${count} 个${filtering ? '当前结果中的' : '直接'}子会话`}>{count}</small>}{session.status === 'running' && <Circle size={7} className="running-dot" fill="currentColor" />}</div>
          <div className="session-preview">{session.match?.excerpt || session.cwd || '工作目录未记录'}</div>
          <div className="session-meta"><span>{session.project || session.source || 'Codex'}</span><span>{tokens(session.usage.tokens?.totalTokens)} tok</span><time title={session.startedAt}>{clock(session.startedAt)}</time></div>
        </button>
      </div>
      {open && count > 0 && <ul className="session-children" id={childrenId} aria-label={`${name}的子会话`}>
        {node.children.map(renderNode)}
        {!filtering && branch?.loading && <li className="session-branch-status" role="status">正在加载子会话…</li>}
        {!filtering && branch?.error && <li className="session-branch-status"><span className="branch-error">{branch.error}</span><button onClick={() => void loadBranch(session.id, 'refresh')}>重试加载子会话</button></li>}
        {!filtering && !branch?.loading && !branch?.error && branch?.nextCursor != null && <li className="session-branch-status"><button onClick={() => void loadBranch(session.id, 'more')}>加载更多子会话 ({branch.items.length} / {branch.total})</button></li>}
      </ul>}
    </li>;
  }
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
        {!collapsed.has(label) && <ul className="session-tree-list">{sessions.map(renderNode)}</ul>}
      </section>)}
      {!loading && data?.items.length === 0 && <div className="sidebar-empty"><Search size={22} /><span>{query || project ? '没有找到匹配的会话' : progress?.status === 'scanning' ? '正在发现会话…' : '这个目录中还没有会话'}</span><small>{query ? '试试更短的关键词' : '在设置中检查日志目录'}</small></div>}
      {data?.nextCursor != null && <button className="load-more" disabled={loading} onClick={onLoadMore}><ArrowDown size={14} />{loading ? '正在加载…' : '加载更多会话'}</button>}
    </div>
    <div className="sidebar-footer"><div className="local-indicator"><span className={`dot ${progress?.status === 'error' ? 'danger-dot' : ''}`} /><div><span>{progress?.status === 'scanning' ? '正在建立索引' : progress?.status === 'error' ? '索引遇到问题' : '本地文件 · 只读'}</span><small>{progress?.status === 'scanning' ? `${progress.indexed} / ${progress.discovered} 个文件` : '所有数据保留在这台电脑'}</small></div></div><button className="icon-button" onClick={onSettings} aria-label="设置" title="设置 (,)"><Settings2 size={17} /></button></div>
    {progress?.status === 'scanning' && <div className="index-track"><div style={{ width: `${progress.discovered ? Math.min(100, progress.indexed / progress.discovered * 100) : 0}%` }} /></div>}
  </aside>;
}
