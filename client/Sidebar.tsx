import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ChevronDown, ChevronRight, Circle, Folder, GitBranch, Layers3, Search, Settings2, X } from 'lucide-react';
import type { SessionChildrenPage, SessionList, SessionSummary } from '../shared/types';
import { clock, dateGroup, sessionDisplayName, sessionTooltip, tokens } from './format';
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
    const name = sessionDisplayName(session);
    const childrenId = `session-children-${encodeURIComponent(session.id)}`;
    return <li key={session.id}>
      <div className="session-tree-row flex min-w-0 items-start">
        {count > 0 ? <button className="session-tree-toggle mt-1 flex h-11 w-[22px] min-w-[22px] items-center justify-center rounded border-0 bg-transparent p-0 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] max-[900px]:w-11 max-[900px]:min-w-11" aria-label={`${open ? '收起' : '展开'}${name}的子会话`} aria-expanded={open} aria-controls={childrenId} onClick={() => setExpanded(previous => {
          const next = new Set(previous);
          next.has(session.id) ? next.delete(session.id) : next.add(session.id);
          return next;
        })}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="session-tree-spacer mt-1 h-11 w-[22px] min-w-[22px] max-[900px]:w-11 max-[900px]:min-w-11" />}
        <button className={`session-item my-0.5 mb-1 block w-0 min-w-0 flex-1 rounded-[7px] border px-2 py-3 text-left ${selectedId === session.id ? 'selected border-[var(--border)] bg-[var(--panel)]' : 'border-transparent bg-transparent hover:bg-[var(--hover)]'}`} data-session-id={session.id} ref={selectedId === session.id ? selectedButton : undefined} onClick={() => onSelect(session)} title={sessionTooltip(session)} aria-current={selectedId === session.id ? 'page' : undefined}>
          <div className={`session-title flex items-center gap-1.5 text-[13px] leading-[1.6] font-semibold ${selectedId === session.id ? 'text-[var(--accent-strong)]' : 'text-[var(--text)]'}`}>{session.parentId && <GitBranch size={12} className="shrink-0" />}<span className="min-w-0 flex-1 truncate">{name}</span>{filtering && !matchIds.has(session.id) && <small className="session-parent-label shrink-0 rounded border border-[var(--border)] px-1 text-[12px] font-normal whitespace-nowrap text-[var(--muted)]">父级</small>}{count > 0 && <small className="session-child-count shrink-0 text-[12px] font-normal text-[var(--muted)] tabular-nums" title={`${count} 个${filtering ? '当前结果中的' : '直接'}子会话`}>{count}</small>}{session.status === 'running' && <Circle size={7} className="running-dot shrink-0 text-[var(--accent)]" fill="currentColor" />}</div>
          <div className="session-preview mt-1 truncate text-[12px] leading-[1.6] text-[var(--muted)]">{session.match?.excerpt || session.cwd || '工作目录未记录'}</div>
          <div className="session-meta mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--muted)] tabular-nums"><span className="max-w-[85px] truncate">{session.project || session.source || 'Codex'}</span><span className="whitespace-nowrap">{tokens(session.usage.tokens?.totalTokens)} tok</span><time className="ml-auto whitespace-nowrap" title={session.startedAt}>{clock(session.startedAt)}</time></div>
        </button>
      </div>
      {open && count > 0 && <ul className="session-children m-0 ml-[11px] list-none border-l border-[var(--border)] p-0 pl-[5px] max-[900px]:ml-[22px] max-[900px]:pl-0" id={childrenId} aria-label={`${name}的子会话`}>
        {node.children.map(renderNode)}
        {!filtering && branch?.loading && <li className="session-branch-status py-2 pr-2 pl-7 text-[12px] leading-relaxed text-[var(--muted)]" role="status">正在加载子会话…</li>}
        {!filtering && branch?.error && <li className="session-branch-status py-2 pr-2 pl-7 text-[12px] leading-relaxed text-[var(--muted)]"><span className="branch-error block text-[var(--danger)] [overflow-wrap:anywhere]">{branch.error}</span><button className="min-h-11 border-0 bg-transparent py-2 text-left text-[var(--accent-strong)]" onClick={() => void loadBranch(session.id, 'refresh')}>重试加载子会话</button></li>}
        {!filtering && !branch?.loading && !branch?.error && branch?.nextCursor != null && <li className="session-branch-status py-2 pr-2 pl-7 text-[12px] leading-relaxed text-[var(--muted)]"><button className="min-h-11 border-0 bg-transparent py-2 text-left text-[var(--accent-strong)]" onClick={() => void loadBranch(session.id, 'more')}>加载更多子会话 ({branch.items.length} / {branch.total})</button></li>}
      </ul>}
    </li>;
  }
  const progress = data?.progress;
  return <aside className="sidebar relative z-[21] flex w-[292px] min-w-[292px] flex-col border-r border-[var(--border)] bg-[var(--sidebar)] max-[1200px]:w-[265px] max-[1200px]:min-w-[265px] max-[900px]:fixed max-[900px]:inset-y-0 max-[900px]:left-0 max-[900px]:w-[292px] max-[900px]:min-w-0 max-[900px]:shadow-[var(--shadow)] [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_button]:focus-visible:outline-[var(--accent)] [&_select]:focus-visible:outline-2 [&_select]:focus-visible:outline-offset-2 [&_select]:focus-visible:outline-[var(--accent)]">
    <div className="brand-row flex items-center gap-[11px] px-[23px] pt-[26px] pb-[25px]"><div className="brand-symbol flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--accent-strong)] text-[var(--panel)]"><Layers3 size={21} strokeWidth={1.6} /></div><div><strong className="block text-[15px] leading-snug font-semibold text-[var(--text)]">会话观察台</strong><span className="mt-1 block text-[12px] leading-snug text-[var(--muted)]">Session Lens</span></div><button className="icon-button sidebar-close ml-auto hidden size-11 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-[var(--muted)] hover:bg-[var(--hover)] max-[900px]:inline-flex" onClick={onClose} title="收起侧栏" aria-label="收起侧栏"><X size={17} /></button></div>
    <div className="sidebar-controls flex flex-col gap-2 px-[18px] pb-5">
      <label className="search-box flex min-h-[var(--control-height)] items-center gap-2 rounded-[7px] border border-[var(--border)] bg-[var(--panel)] px-2.5 text-[var(--muted)] focus-within:border-[var(--accent)]"><Search size={16} /><input className="w-full min-w-0 border-0 bg-transparent text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--muted)]" id="session-search" placeholder="搜索会话与对话…" value={query} onChange={event => onQuery(event.target.value)} aria-label="搜索会话与对话正文" /><kbd className="rounded border border-[var(--border)] bg-[var(--panel)] px-1 font-mono text-[12px] leading-[18px] text-[var(--muted)]">/</kbd></label>
      <label className="project-picker flex min-h-[var(--control-height)] items-center gap-2 px-2 text-[var(--muted)]"><Folder size={15} /><select className="min-h-[var(--control-height)] w-full min-w-0 appearance-none border-0 bg-transparent text-[12px] text-[var(--soft)] [&_option]:bg-[var(--panel)] [&_option]:text-[var(--text)]" value={project} onChange={event => onProject(event.target.value)} aria-label="筛选项目"><option value="">所有项目</option>{data?.projects.map(item => <option value={item.path} key={item.path}>{item.name} ({item.count})</option>)}</select><ChevronDown size={13} /></label>
    </div>
    <div className="sidebar-section-label flex justify-between px-[23px] pb-3 text-[12px] text-[var(--muted)]"><span>本地会话</span><span className="tabular-nums">{data ? data.total.toLocaleString() : '—'}</span></div>
    <div className="session-scroll min-h-0 flex-1 overflow-auto px-2.5 pb-[18px] [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]">
      {error && <div className="inline-error" role="alert">{error}</div>}
      {loading && !data && <div className="sidebar-skeleton px-3 py-[18px]" role="status" aria-label="正在加载会话"><span className="mb-2.5 block h-[65px] rounded-md bg-[var(--hover)]" /><span className="mb-2.5 block h-[65px] rounded-md bg-[var(--hover)]" /><span className="mb-2.5 block h-[65px] rounded-md bg-[var(--hover)]" /></div>}
      {groups.map(([label, sessions]) => <section className="date-group" key={label}>
        <button className="date-heading flex min-h-11 w-full items-center gap-1.5 border-0 bg-transparent px-2.5 pt-3 pb-2 text-left text-[12px] text-[var(--muted)]" onClick={() => setCollapsed(previous => { const next = new Set(previous); next.has(label) ? next.delete(label) : next.add(label); return next; })} aria-expanded={!collapsed.has(label)}>{collapsed.has(label) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<span>{label}</span><small className="ml-auto text-[12px] tabular-nums">{sessions.length}</small></button>
        {!collapsed.has(label) && <ul className="session-tree-list m-0 list-none p-0">{sessions.map(renderNode)}</ul>}
      </section>)}
      {!loading && data?.items.length === 0 && <div className="sidebar-empty flex flex-col items-center gap-3 px-2.5 py-9 text-center text-[12px] text-[var(--muted)]"><Search size={22} /><span>{query || project ? '没有找到匹配的会话' : progress?.status === 'scanning' ? '正在发现会话…' : '这个目录中还没有会话'}</span><small className="text-[12px]">{query ? '试试更短的关键词' : '在设置中检查日志目录'}</small></div>}
      {data?.nextCursor != null && <button className="load-more flex min-h-11 w-full items-center justify-center gap-1.5 border-0 bg-transparent p-3 text-[12px] text-[var(--muted)] hover:text-[var(--accent-strong)]" disabled={loading} onClick={onLoadMore}><ArrowDown size={14} />{loading ? '正在加载…' : '加载更多会话'}</button>}
    </div>
    <div className="sidebar-footer flex items-center justify-between gap-1.5 border-t border-[var(--border)] px-[19px] py-4"><div className="local-indicator flex items-start gap-2.5"><span className={`dot mt-1 block size-1.5 shrink-0 rounded-full ${progress?.status === 'error' ? 'danger-dot bg-[var(--danger)]' : 'bg-[var(--accent)]'}`} /><div><span className="block text-[12px] leading-snug text-[var(--soft)]">{progress?.status === 'scanning' ? '正在建立索引' : progress?.status === 'error' ? '索引遇到问题' : '本地文件 · 只读'}</span><small className="mt-1 block text-[12px] leading-snug text-[var(--muted)]">{progress?.status === 'scanning' ? `${progress.indexed} / ${progress.discovered} 个文件` : '所有数据保留在这台电脑'}</small></div></div><button className="icon-button inline-flex size-[var(--control-height)] shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-[var(--muted)] hover:bg-[var(--hover)]" onClick={onSettings} aria-label="设置" title="设置 (,)"><Settings2 size={17} /></button></div>
    {progress?.status === 'scanning' && <div className="index-track absolute inset-x-0 bottom-0 h-0.5 bg-[var(--border)]"><div className="h-full bg-[var(--accent)] transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${progress.discovered ? Math.min(100, progress.indexed / progress.discovered * 100) : 0}%` }} /></div>}
  </aside>;
}
