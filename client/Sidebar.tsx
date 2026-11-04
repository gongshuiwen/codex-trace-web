import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Circle, Folder, Layers3, LocateFixed, Search, Settings2, X } from 'lucide-react';
import type { LiveEvent, SessionChildrenPage, SessionList, SessionSummary } from '../shared/types';
import { clock, dateGroup, sessionDisplayName, sessionTooltip, tokens } from './format';
import { api, errorMessage, sessionPath } from './api';
import { mergeSessions, sessionAncestors, sidebarSessionTree, type SessionTreeNode } from './session-tree';
import { SidebarFrame } from './SidebarFrame';
import { beginBranchLoad, branchControls, sidebarListRevision, sidebarRowNeedsReveal, type BranchLoadMode, type SidebarBranch } from './sidebar-refresh';
import './Sidebar.css';

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
  const [branches, setBranches] = useState<Map<string, SidebarBranch>>(new Map());
  const [locateVersion, setLocateVersion] = useState(0);
  const branchRef = useRef(branches);
  const pending = useRef(new Map<string, AbortController>());
  const queuedRefresh = useRef(new Set<string>());
  const expandedRef = useRef(expanded); expandedRef.current = expanded;
  const dataAvailable = useRef(Boolean(data)); dataAvailable.current = Boolean(data);
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const liveRevision = useRef(0);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const filterKey = query.trim() || project ? JSON.stringify([query.trim(), project]) : '';
  const filtering = Boolean(filterKey);
  const filterRef = useRef(filterKey);
  filterRef.current = filterKey;
  const updateBranch = useCallback((id: string, value: SidebarBranch) => {
    const next = new Map(branchRef.current);
    next.set(id, value);
    branchRef.current = next;
    setBranches(next);
  }, []);

  const loadBranch = useCallback(async (id: string, mode: BranchLoadMode): Promise<void> => {
    if (filterRef.current || !dataAvailable.current) return;
    const previous = branchRef.current.get(id);
    if (mode === 'initial' && previous && (previous.loaded || previous.error || pending.current.has(id))) return;
    if (pending.current.has(id)) {
      if (mode === 'refresh') queuedRefresh.current.add(id);
      return;
    }
    if (mode === 'more' && (!previous?.loaded || previous.nextCursor == null)) return;
    const controller = new AbortController();
    pending.current.set(id, controller);
    const old = beginBranchLoad(previous, mode);
    updateBranch(id, old);
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
      if (controller.signal.aborted || filterRef.current || !dataAvailable.current || pending.current.get(id) !== controller) return;
      updateBranch(id, { items: mode === 'more' ? mergeSessions(old.items, items) : items, total, nextCursor: cursor, loaded: true, loading: null, error: '' });
    } catch (failure) {
      if (!controller.signal.aborted && pending.current.get(id) === controller) updateBranch(id, { ...old, loading: null, error: errorMessage(failure) });
    } finally {
      if (pending.current.get(id) === controller) {
        pending.current.delete(id);
        if (queuedRefresh.current.delete(id) && expandedRef.current.has(id) && !filterRef.current && dataAvailable.current) void loadBranch(id, 'refresh');
      }
    }
  }, [updateBranch]);

  useEffect(() => {
    if (filtering || !data) {
      for (const controller of pending.current.values()) controller.abort();
      pending.current.clear();
      queuedRefresh.current.clear();
      const next = !data ? new Map<string, SidebarBranch>() : new Map([...branchRef.current].map(([id, branch]) => [id, { ...branch, loading: null }]));
      branchRef.current = next;
      setBranches(next);
    }
  }, [filtering, data === null]);
  useEffect(() => () => {
    for (const controller of pending.current.values()) controller.abort();
    pending.current.clear(); queuedRefresh.current.clear();
  }, []);
  useEffect(() => {
    let readySelection = selectedRef.current;
    function onChange(event: Event) {
      const change = (event as CustomEvent<LiveEvent>).detail;
      if (!change) return;
      // App reconnects its stream on a selection change. That ready event is not an archive mutation.
      if (change.type === 'ready') {
        const selectionChanged = readySelection !== selectedRef.current;
        readySelection = selectedRef.current;
        if (selectionChanged) return;
      } else if (change.type !== 'sessions-changed') return;
      liveRevision.current++;
    }
    window.addEventListener('session-lens:change', onChange);
    return () => window.removeEventListener('session-lens:change', onChange);
  }, []);

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
  const knownIds = useRef(new Set<string>());
  const revealPending = useRef<string | null>(null);
  const previousLocate = useRef(locateVersion);
  const previousSelection = useRef<string | null>(null);
  const pointerSelection = useRef<string | null>(null);
  const revealKey = JSON.stringify([filterKey, selectedId, Boolean(selectedId && tree.byId.has(selectedId)), filtering ? revealIds.sort() : [], revealParents, revealDates, locateVersion]);
  useEffect(() => {
    const explicitLocate = previousLocate.current !== locateVersion;
    previousLocate.current = locateVersion;
    const selectionChanged = previousSelection.current !== selectedId;
    previousSelection.current = selectedId;
    const localPointerSelection = pointerSelection.current === selectedId;
    if (selectionChanged) pointerSelection.current = null;
    const missingPath = revealParents.some(id => !expanded.has(id)) || revealDates.some(label => collapsed.has(label));
    if (revealPending.current !== selectedId) revealPending.current = null;
    if (selectedId && (explicitLocate || !filtering && (missingPath || !knownIds.current.has(selectedId) || selectionChanged && !localPointerSelection))) revealPending.current = selectedId;
    setExpanded(previous => revealParents.some(id => !previous.has(id)) ? new Set([...previous, ...revealParents]) : previous);
    setCollapsed(previous => revealDates.some(label => previous.has(label)) ? new Set([...previous].filter(label => !revealDates.includes(label))) : previous);
  }, [revealKey]);
  useEffect(() => {
    if (!revealPending.current || filtering) return;
    const frame = requestAnimationFrame(() => {
      if (selectedButton.current && revealPending.current === selectedId) {
        const button = selectedButton.current;
        const scroller = button.closest<HTMLElement>('.session-scroll');
        if (scroller) {
          const viewport = scroller.getBoundingClientRect();
          const style = getComputedStyle(scroller);
          const stickyBottom = [...scroller.querySelectorAll<HTMLElement>('.date-heading')].reduce((bottom, heading) => {
            const rect = heading.getBoundingClientRect();
            return rect.top <= viewport.top + 1 && rect.bottom > viewport.top ? Math.max(bottom, rect.bottom) : bottom;
          }, viewport.top);
          if (sidebarRowNeedsReveal(button.getBoundingClientRect(), viewport, Number.parseFloat(style.scrollPaddingTop) || 0, Number.parseFloat(style.scrollPaddingBottom) || 0, stickyBottom)) button.scrollIntoView({ block: 'nearest' });
        }
        revealPending.current = null;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [tree, expanded, collapsed, filtering, selectedId, locateVersion]);
  useEffect(() => { knownIds.current = new Set(tree.byId.keys()); }, [tree]);

  const previousRevision = useRef('');
  const previousLiveRevision = useRef(0);
  const previousExpanded = useRef<Set<string>>(new Set());
  const previousFiltering = useRef(filtering);
  useEffect(() => {
    const revision = sidebarListRevision(data);
    const changed = previousRevision.current !== revision || previousLiveRevision.current !== liveRevision.current || previousFiltering.current !== filtering;
    const opened = previousExpanded.current;
    previousRevision.current = revision;
    previousLiveRevision.current = liveRevision.current;
    previousExpanded.current = expanded;
    previousFiltering.current = filtering;
    if (!data || filtering) return;
    for (const id of expanded) {
      // Reopening always revalidates its cache, including changes received while collapsed.
      if (tree.byId.has(id)) void loadBranch(id, (changed || !opened.has(id)) && branchRef.current.has(id) ? 'refresh' : 'initial');
    }
  }, [data?.items, data?.ancestors, data?.selected, expanded, filtering, loadBranch, tree]);

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
    const controls = branchControls(branch);
    const count = filtering ? node.children.length : session.childCount ?? Math.max(node.children.length, branch?.total ?? 0);
    const name = sessionDisplayName(session);
    const projectScoped = Boolean(project && session.cwd === project);
    const childrenId = `session-children-${encodeURIComponent(session.id)}`;
    return <li key={session.id} data-has-children={count > 0 || undefined}>
      <div className={`session-tree-row ${selectedId === session.id ? 'is-selected' : ''}`}>
        {count > 0 && <button className="session-tree-toggle" aria-label={`${open ? '收起' : '展开'}${name}的子会话`} aria-expanded={open} aria-controls={open ? childrenId : undefined} title={branch?.loaded && branch.error ? `子会话更新失败：${branch.error}；重新展开可重试` : undefined} onClick={() => setExpanded(previous => {
          const next = new Set(previous);
          next.has(session.id) ? next.delete(session.id) : next.add(session.id);
          return next;
        })}>{open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}</button>}
        <button className={`session-item ${selectedId === session.id ? 'selected' : ''}`} data-session-id={session.id} ref={selectedId === session.id ? selectedButton : undefined} onClick={event => { pointerSelection.current = event.detail > 0 ? session.id : null; onSelect(session); }} title={sessionTooltip(session)} aria-current={selectedId === session.id ? 'page' : undefined}>
          <div className="session-title"><span className="session-name">{name}</span>{filtering && !matchIds.has(session.id) && <small className="session-parent-label">父级</small>}{session.status === 'running' && <Circle size={7} className="running-dot" fill="currentColor" role="img" aria-label="进行中" />}</div>
          {filtering && session.match?.excerpt && <div className="session-preview">{session.match.excerpt}</div>}
          <div className={`session-meta${projectScoped ? ' project-scoped' : ''}`}>{!projectScoped && <span className="session-project">{session.project || session.source || 'Codex'}</span>}{count > 0 && <span className="session-child-count" title={`${count} 个${filtering ? '当前结果中的' : '直接'}子会话`}><span>{count}</span><span>子</span></span>}<span className="session-tokens" title={session.usage.tokens ? `${session.usage.tokens.totalTokens.toLocaleString()} tokens` : '用量未记录'}>{tokens(session.usage.tokens?.totalTokens)} tok</span><time dateTime={session.startedAt} title={session.startedAt}>{clock(session.startedAt)}</time></div>
        </button>
      </div>
      {open && count > 0 && <ul className="session-children" id={childrenId} aria-label={`${name}的子会话`}>
        {node.children.map(renderNode)}
        {!filtering && controls.initialLoading && <li className="session-branch-status py-2 pr-2 pl-7 text-[12px] leading-relaxed text-[var(--muted)]" role="status">正在加载子会话…</li>}
        {!filtering && controls.error && <li className="session-branch-status py-2 pr-2 pl-7 text-[12px] leading-relaxed text-[var(--muted)]"><span className="branch-error block text-[var(--danger)] [overflow-wrap:anywhere]">{branch?.error}</span><button className="min-h-11 border-0 bg-transparent py-2 text-left text-[var(--accent-strong)]" onClick={() => void loadBranch(session.id, 'refresh')}>重试加载子会话</button></li>}
        {!filtering && controls.more && branch && <li className="session-branch-status py-2 pr-2 pl-7 text-[12px] leading-relaxed text-[var(--muted)]"><button className="min-h-11 border-0 bg-transparent py-2 text-left text-[var(--accent-strong)]" disabled={Boolean(branch.loading)} aria-busy={controls.paging || undefined} title={branch.error || undefined} onClick={() => void loadBranch(session.id, 'more')}>{controls.paging ? '正在加载子会话' : '加载更多子会话'} ({branch.items.length} / {branch.total})</button></li>}
      </ul>}
    </li>;
  }
  const progress = data?.progress;
  return <SidebarFrame>
    <div className="brand-row"><div className="brand-symbol"><Layers3 size={21} strokeWidth={1.6} /></div><strong title="会话观察台">Session Lens</strong><button className="icon-button sidebar-close" onClick={onClose} title="收起侧栏" aria-label="收起侧栏"><X size={17} /></button></div>
    <div className="sidebar-controls">
      <div className="search-box"><Search size={15} aria-hidden="true" /><input id="session-search" placeholder="搜索会话与对话…" value={query} onChange={event => onQuery(event.target.value)} aria-label="搜索会话与对话正文" />{query ? <button className="search-clear" onClick={() => { onQuery(''); document.getElementById('session-search')?.focus(); }} aria-label="清空搜索" title="清空搜索"><X size={14} /></button> : <kbd aria-hidden="true">/</kbd>}</div>
      <div className={`project-filter ${project ? 'is-filtered' : ''}`}><label className="project-picker"><Folder size={14} aria-hidden="true" /><select value={project} onChange={event => onProject(event.target.value)} aria-label="筛选项目"><option value="">所有项目</option>{data?.projects.map(item => <option value={item.path} key={item.path}>{item.name} ({item.count})</option>)}</select><ChevronDown size={12} aria-hidden="true" /></label>{project && <button className="project-clear" onClick={() => onProject('')} aria-label="清除项目筛选" title="清除项目筛选"><X size={13} /></button>}</div>
    </div>
    <div className="sidebar-section-label"><div className="sidebar-list-label"><span>{filtering ? '筛选结果' : '本地会话'}</span><span className="sidebar-total" aria-live="polite" aria-atomic="true">{data ? data.total.toLocaleString() : '—'}</span></div><div className="sidebar-list-actions"><button disabled={!selectedId} onClick={locateSelected} aria-label="定位当前会话" title="定位当前会话"><LocateFixed size={14} /></button><button disabled={!groups.length} onClick={() => setCollapsed(allGroupsCollapsed ? new Set() : new Set(groups.map(([label]) => label)))} aria-label={allGroupsCollapsed ? '展开所有日期分组' : '收起所有日期分组'} title={allGroupsCollapsed ? '展开所有日期分组' : '收起所有日期分组'}>{allGroupsCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}</button></div></div>
    <nav className="session-scroll" aria-label={filtering ? '筛选后的会话列表' : '按日期分组的会话列表'}>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {loading && !data && <div className="sidebar-skeleton" role="status" aria-label="正在加载会话"><span /><span /><span /><span /><span /></div>}
      {groups.map(([label, sessions]) => <section className="date-group" key={label}>
        <button className="date-heading" onClick={() => setCollapsed(previous => { const next = new Set(previous); next.has(label) ? next.delete(label) : next.add(label); return next; })} aria-expanded={!collapsed.has(label)} aria-controls={!collapsed.has(label) ? `session-date-${encodeURIComponent(label)}` : undefined}><span>{label}</span><small title={`${sessions.length} 个已加载的主会话`}>{sessions.length}</small>{collapsed.has(label) ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}</button>
        {!collapsed.has(label) && <ul className="session-tree-list" id={`session-date-${encodeURIComponent(label)}`}>{sessions.map(renderNode)}</ul>}
      </section>)}
      {!loading && data?.items.length === 0 && <div className="sidebar-empty"><Search size={22} /><span>{filtering ? '没有找到匹配的会话' : progress?.status === 'scanning' ? '正在发现会话…' : '这个目录中还没有会话'}</span><small>{query ? '试试更短的关键词，或清除筛选' : project ? '试试查看所有项目' : progress?.status === 'scanning' ? '发现的会话会自动出现在这里' : '在设置中检查日志目录'}</small>{filtering && <button onClick={clearFilters}>清除全部筛选</button>}</div>}
      {data?.nextCursor != null && <button className="load-more" disabled={loading} onClick={onLoadMore}><ArrowDown size={14} />{loading ? '正在加载…' : '加载更多会话'}<span>{data.items.length.toLocaleString()} / {data.total.toLocaleString()}</span></button>}
    </nav>
    <div className="sidebar-footer"><div className="local-indicator" title="Session Lens v0.1 · 本地日志只读"><span className={`dot ${progress?.status === 'error' ? 'danger-dot' : ''}`} /><div><span>{progress?.status === 'scanning' ? '正在建立索引' : progress?.status === 'error' ? '索引遇到问题' : '本地 · 只读'}</span>{progress?.status === 'scanning' && <small>{progress.indexed} / {progress.discovered} 个文件</small>}</div></div><button className="icon-button" onClick={onSettings} aria-label="设置" title="设置 (,)"><Settings2 size={16} /></button></div>
    {progress?.status === 'scanning' && <div className="index-track absolute inset-x-0 bottom-0 h-0.5 bg-[var(--border)]"><div className="h-full bg-[var(--accent)] transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${progress.discovered ? Math.min(100, progress.indexed / progress.discovered * 100) : 0}%` }} /></div>}
  </SidebarFrame>;
}
