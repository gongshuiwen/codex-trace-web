import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Circle, Folder, GitBranch, Layers3, LocateFixed, Search, Settings2, X } from 'lucide-react';
import type { SessionChildrenPage, SessionList, SessionSummary } from '../shared/types';
import { clock, dateGroup, sessionDisplayName, sessionTooltip, tokens } from './format';
import { api, errorMessage, sessionPath } from './api';
import { mergeSessions, sessionAncestors, sidebarSessionTree, type SessionTreeNode } from './session-tree';
import { SidebarFrame } from './SidebarFrame';
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
  const [locateVersion, setLocateVersion] = useState(0);
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
  const revealKey = JSON.stringify([filterKey, selectedId, filtering ? revealIds.sort() : [], revealParents, revealDates, locateVersion]);
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

  function clearFilters() {
    onQuery('');
    onProject('');
  }

  function locateSelected() {
    clearFilters();
    setLocateVersion(value => value + 1);
  }

  const allGroupsCollapsed = groups.length > 0 && groups.every(([label]) => collapsed.has(label));

  function renderNode(node: SessionTreeNode) {
    const session = node.session;
    const open = expanded.has(session.id);
    const branch = branches.get(session.id);
    const count = filtering ? node.children.length : session.childCount ?? Math.max(node.children.length, branch?.total ?? 0);
    const name = sessionDisplayName(session);
    const childrenId = `session-children-${encodeURIComponent(session.id)}`;
    return <li key={session.id}>
      <div className={`session-tree-row ${selectedId === session.id ? 'is-selected' : ''}`}>
        {count > 0 && <button className="session-tree-toggle" aria-label={`${open ? '收起' : '展开'}${name}的子会话`} aria-expanded={open} aria-controls={open ? childrenId : undefined} onClick={() => setExpanded(previous => {
          const next = new Set(previous);
          next.has(session.id) ? next.delete(session.id) : next.add(session.id);
          return next;
        })}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>}
        <button className={`session-item ${selectedId === session.id ? 'selected' : ''}`} data-session-id={session.id} ref={selectedId === session.id ? selectedButton : undefined} onClick={() => onSelect(session)} title={sessionTooltip(session)} aria-current={selectedId === session.id ? 'page' : undefined}>
          <div className="session-title">{session.parentId && <GitBranch size={12} className="session-agent-icon" />}<span className="session-name">{name}</span>{filtering && !matchIds.has(session.id) && <small className="session-parent-label">父级</small>}{session.status === 'running' && <Circle size={7} className="running-dot" fill="currentColor" role="img" aria-label="进行中" />}</div>
          {filtering && session.match?.excerpt && <div className="session-preview">{session.match.excerpt}</div>}
          <div className="session-meta"><span className="session-project">{session.project || session.source || 'Codex'}</span>{count > 0 && <span className="session-child-count" title={`${count} 个${filtering ? '当前结果中的' : '直接'}子会话`}><GitBranch size={11} /><span>{count}</span></span>}<span className="session-tokens">{tokens(session.usage.tokens?.totalTokens)} tok</span><time dateTime={session.startedAt} title={session.startedAt}>{clock(session.startedAt)}</time></div>
        </button>
      </div>
      {open && count > 0 && <ul className="session-children" id={childrenId} aria-label={`${name}的子会话`}>
        {node.children.map(renderNode)}
        {!filtering && branch?.loading && <li className="session-branch-status py-2 pr-2 pl-7 text-[12px] leading-relaxed text-[var(--muted)]" role="status">正在加载子会话…</li>}
        {!filtering && branch?.error && <li className="session-branch-status py-2 pr-2 pl-7 text-[12px] leading-relaxed text-[var(--muted)]"><span className="branch-error block text-[var(--danger)] [overflow-wrap:anywhere]">{branch.error}</span><button className="min-h-11 border-0 bg-transparent py-2 text-left text-[var(--accent-strong)]" onClick={() => void loadBranch(session.id, 'refresh')}>重试加载子会话</button></li>}
        {!filtering && !branch?.loading && !branch?.error && branch?.nextCursor != null && <li className="session-branch-status py-2 pr-2 pl-7 text-[12px] leading-relaxed text-[var(--muted)]"><button className="min-h-11 border-0 bg-transparent py-2 text-left text-[var(--accent-strong)]" onClick={() => void loadBranch(session.id, 'more')}>加载更多子会话 ({branch.items.length} / {branch.total})</button></li>}
      </ul>}
    </li>;
  }
  const progress = data?.progress;
  return <SidebarFrame>
    <div className="brand-row"><div className="brand-symbol"><Layers3 size={20} strokeWidth={1.6} /></div><strong>会话观察台</strong><button className="icon-button sidebar-close" onClick={onClose} title="收起侧栏" aria-label="收起侧栏"><X size={17} /></button></div>
    <div className="sidebar-controls">
      <div className="search-box"><Search size={15} aria-hidden="true" /><input id="session-search" placeholder="搜索会话与对话…" value={query} onChange={event => onQuery(event.target.value)} aria-label="搜索会话与对话正文" />{query ? <button className="search-clear" onClick={() => { onQuery(''); document.getElementById('session-search')?.focus(); }} aria-label="清空搜索" title="清空搜索"><X size={14} /></button> : <kbd aria-hidden="true">/</kbd>}</div>
      <div className={`project-filter ${project ? 'is-filtered' : ''}`}><label className="project-picker"><Folder size={14} aria-hidden="true" /><select value={project} onChange={event => onProject(event.target.value)} aria-label="筛选项目"><option value="">所有项目</option>{data?.projects.map(item => <option value={item.path} key={item.path}>{item.name} ({item.count})</option>)}</select><ChevronDown size={12} aria-hidden="true" /></label>{project && <button className="project-clear" onClick={() => onProject('')} aria-label="清除项目筛选" title="清除项目筛选"><X size={13} /></button>}</div>
    </div>
    <div className="sidebar-section-label"><div className="sidebar-list-label"><span>{filtering ? '筛选结果' : '本地会话'}</span><span className="sidebar-total" aria-live="polite" aria-atomic="true">{data ? data.total.toLocaleString() : '—'}</span></div><div className="sidebar-list-actions"><button disabled={!selectedId} onClick={locateSelected} aria-label="定位当前会话" title="定位当前会话"><LocateFixed size={14} /></button><button disabled={!groups.length} onClick={() => setCollapsed(allGroupsCollapsed ? new Set() : new Set(groups.map(([label]) => label)))} aria-label={allGroupsCollapsed ? '展开所有日期分组' : '收起所有日期分组'} title={allGroupsCollapsed ? '展开所有日期分组' : '收起所有日期分组'}>{allGroupsCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}</button></div></div>
    <nav className="session-scroll" aria-label={filtering ? '筛选后的会话列表' : '按日期分组的会话列表'}>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {loading && !data && <div className="sidebar-skeleton" role="status" aria-label="正在加载会话"><span /><span /><span /><span /><span /></div>}
      {groups.map(([label, sessions]) => <section className="date-group" key={label}>
        <button className="date-heading" onClick={() => setCollapsed(previous => { const next = new Set(previous); next.has(label) ? next.delete(label) : next.add(label); return next; })} aria-expanded={!collapsed.has(label)} aria-controls={!collapsed.has(label) ? `session-date-${encodeURIComponent(label)}` : undefined}>{collapsed.has(label) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<span>{label}</span><small title={`${sessions.length} 个已加载的主会话`}>{sessions.length}</small></button>
        {!collapsed.has(label) && <ul className="session-tree-list" id={`session-date-${encodeURIComponent(label)}`}>{sessions.map(renderNode)}</ul>}
      </section>)}
      {!loading && data?.items.length === 0 && <div className="sidebar-empty"><Search size={22} /><span>{filtering ? '没有找到匹配的会话' : progress?.status === 'scanning' ? '正在发现会话…' : '这个目录中还没有会话'}</span><small>{query ? '试试更短的关键词，或清除筛选' : project ? '试试查看所有项目' : progress?.status === 'scanning' ? '发现的会话会自动出现在这里' : '在设置中检查日志目录'}</small>{filtering && <button onClick={clearFilters}>清除全部筛选</button>}</div>}
      {data?.nextCursor != null && <button className="load-more" disabled={loading} onClick={onLoadMore}><ArrowDown size={14} />{loading ? '正在加载…' : '加载更多会话'}<span>{data.items.length.toLocaleString()} / {data.total.toLocaleString()}</span></button>}
    </nav>
    <div className="sidebar-footer"><div className="local-indicator"><span className={`dot ${progress?.status === 'error' ? 'danger-dot' : ''}`} /><div><span>{progress?.status === 'scanning' ? '正在建立索引' : progress?.status === 'error' ? '索引遇到问题' : '本地 · 只读'}</span>{progress?.status === 'scanning' && <small>{progress.indexed} / {progress.discovered} 个文件</small>}</div></div><button className="icon-button" onClick={onSettings} aria-label="设置" title="设置 (,)"><Settings2 size={16} /></button></div>
    {progress?.status === 'scanning' && <div className="index-track absolute inset-x-0 bottom-0 h-0.5 bg-[var(--border)]"><div className="h-full bg-[var(--accent)] transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${progress.discovered ? Math.min(100, progress.indexed / progress.discovered * 100) : 0}%` }} /></div>}
  </SidebarFrame>;
}
