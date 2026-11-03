import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ArrowDown, ArrowLeft, Check, ChevronRight, Circle, FileSearch, FolderOpen, GitBranch, Layers3, LoaderCircle, Menu, Moon, PanelLeftClose, Search, Sun, Monitor, X } from 'lucide-react';
import type { IndexProgress, LiveEvent, SessionDetail, SessionList, SessionSummary } from '../shared/types';
import { api, errorMessage, isAbort, sessionPath } from './api';
import { Sidebar } from './Sidebar';
import { SessionStats } from './Stats';
import { TurnCard, type Inspection } from './TurnCard';
import { sessionDisplayName, sessionTooltip, statusLabels } from './format';
import { useReadingPosition } from './useReadingPosition';

const DetailDrawer = lazy(() => import('./DetailDrawer').then(module => ({ default: module.DetailDrawer })));
const SettingsModal = lazy(() => import('./SettingsModal').then(module => ({ default: module.SettingsModal })));
const SessionOverview = lazy(() => import('./SessionOverview'));

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  return { session: params.get('session'), turn: params.get('turn') };
}

type Theme = 'system' | 'dark' | 'light';

function initialTheme(): Theme {
  try { const value = localStorage.getItem('session-lens-theme'); return value === 'dark' || value === 'light' ? value : 'system'; } catch { return 'system'; }
}

function writeLocation(session: string, turn?: string, replace = false) {
  const url = new URL(window.location.href);
  url.searchParams.set('session', session);
  turn ? url.searchParams.set('turn', turn) : url.searchParams.delete('turn');
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

function mergeSessionPages(previous: SessionList | null, page: SessionList): SessionList {
  if (!previous) return page;
  return { ...page,
    ancestors: [...new Map([...(previous.ancestors ?? []), ...(page.ancestors ?? [])].map(item => [item.id, item])).values()],
    items: [...new Map([...previous.items, ...page.items].map(item => [item.id, item])).values()],
  };
}

export function App() {
  const [location, setLocation] = useState(readLocation);
  const [navigationVersion, setNavigationVersion] = useState(0);
  const [sessions, setSessions] = useState<SessionList | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [project, setProject] = useState('');
  const [listVersion, setListVersion] = useState(0);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [sessionLoading, setSessionLoading] = useState(false);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 900);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [connected, setConnected] = useState(false);
  const listRequest = useRef<AbortController | null>(null);
  const listGeneration = useRef(0);
  const listKeyRef = useRef('');
  const listStateRef = useRef(sessions);
  listStateRef.current = sessions;
  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    function apply() { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; }
    apply(); media.addEventListener('change', apply);
    try { localStorage.setItem('session-lens-theme', theme); } catch { /* Theme still works when browser storage is unavailable. */ }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { const timer = setTimeout(() => setDebouncedQuery(query.trim()), 220); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const foldNavigation = () => { if (media.matches) setSidebarOpen(false); };
    media.addEventListener('change', foldNavigation);
    return () => media.removeEventListener('change', foldNavigation);
  }, []);
  useEffect(() => {
    const handler = () => { setLocation(readLocation()); setNavigationVersion(value => value + 1); setInspection(null); };
    window.addEventListener('popstate', handler); return () => window.removeEventListener('popstate', handler);
  }, []);

  const treeSelectedId = !debouncedQuery && !project ? location.session : null;
  const fetchList = useCallback(async (cursor = 0) => {
    listRequest.current?.abort();
    const controller = new AbortController(); listRequest.current = controller;
    const generation = ++listGeneration.current;
    setListLoading(true); setListError('');
    const listKey = `${debouncedQuery}\u0000${project}`;
    const wanted = cursor || listKey !== listKeyRef.current ? 50 : Math.max(50, listStateRef.current?.items.length ?? 0);
    const limit = Math.min(100, wanted);
    const params = new URLSearchParams({ query: debouncedQuery, project, cursor: String(cursor), limit: String(limit) });
    if (treeSelectedId) params.set('selectedId', treeSelectedId);
    try {
      let value = await api<SessionList>(`/api/sessions?${params}`, { signal: controller.signal });
      while (!cursor && value.nextCursor != null && value.items.length < wanted) {
        params.set('cursor', String(value.nextCursor));
        params.set('limit', String(Math.min(100, wanted - value.items.length)));
        const page = await api<SessionList>(`/api/sessions?${params}`, { signal: controller.signal });
        value = mergeSessionPages(value, page);
      }
      if (controller.signal.aborted || generation !== listGeneration.current) return;
      listKeyRef.current = listKey;
      setSessions(previous => cursor ? mergeSessionPages(previous, value) : value);
      if (!locationRef.current.session && value.items[0]) {
        writeLocation(value.items[0].id, undefined, true); setLocation({ session: value.items[0].id, turn: null });
      }
    } catch (cause) { if (!isAbort(cause) && generation === listGeneration.current) setListError(errorMessage(cause)); }
    finally { if (generation === listGeneration.current) setListLoading(false); }
  }, [debouncedQuery, project, treeSelectedId]);
  useEffect(() => { void fetchList(); return () => listRequest.current?.abort(); }, [fetchList, listVersion]);

  useEffect(() => {
    if (!location.session) return;
    const controller = new AbortController();
    setSessionLoading(true); setSessionError('');
    api<SessionDetail>(sessionPath(location.session), { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setSession(value); setSessionLoading(false); }
    }).catch(cause => { if (!isAbort(cause)) { setSessionError(errorMessage(cause)); setSessionLoading(false); } });
    return () => controller.abort();
  }, [location.session, sessionVersion]);

  useEffect(() => {
    const source = new EventSource(`/api/events${location.session ? `?sessionId=${encodeURIComponent(location.session)}` : ''}`);
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    let listTimer: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    function onEvent(event: MessageEvent) {
      let data: LiveEvent;
      try { data = JSON.parse(event.data) as LiveEvent; } catch { return; }
      if (data.progress) setSessions(previous => previous ? { ...previous, progress: data.progress as IndexProgress } : previous);
      if (data.type === 'ready' || data.type === 'session-changed' && (!data.sessionId || data.sessionId === locationRef.current.session)) {
        if (!sessionTimer) sessionTimer = setTimeout(() => { sessionTimer = undefined; setSessionVersion(value => value + 1); }, 900);
      }
      if (data.type === 'sessions-changed' || data.type === 'ready') {
        if (!listTimer) listTimer = setTimeout(() => { listTimer = undefined; setListVersion(value => value + 1); }, 1300);
      }
    }
    for (const name of ['session-changed', 'sessions-changed', 'index-progress', 'ready']) source.addEventListener(name, onEvent as EventListener);
    source.onmessage = onEvent;
    return () => { source.close(); clearTimeout(sessionTimer); clearTimeout(listTimer); };
  }, [location.session]);

  const selectSession = useCallback((value: SessionSummary) => {
    writeLocation(value.id, value.match?.turnId); setLocation({ session: value.id, turn: value.match?.turnId ?? null }); setInspection(null);
    setNavigationVersion(version => version + 1);
    if (window.innerWidth < 900) setSidebarOpen(false);
  }, []);
  const navigateTurn = useCallback((turnId: string) => {
    const sessionId = locationRef.current.session;
    if (!sessionId) return;
    writeLocation(sessionId, turnId); setLocation({ session: sessionId, turn: turnId });
    setNavigationVersion(version => version + 1); setInspection(null);
  }, []);

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'Escape') { setShowSettings(false); setShowShortcuts(false); setInspection(null); if (window.innerWidth < 900) setSidebarOpen(false); return; }
      const target = event.target as HTMLElement | null;
      if (showSettings || target?.closest('[role="dialog"],input,textarea,select,[contenteditable="true"]')) return;
      if (event.key === ',' && !inspection) { event.preventDefault(); setShowSettings(true); }
      if (event.key === '?') { event.preventDefault(); setShowShortcuts(value => !value); }
      if (event.key === '/') { event.preventDefault(); setSidebarOpen(true); requestAnimationFrame(() => document.getElementById('session-search')?.focus()); }
      if ((event.key === 'j' || event.key === 'k') && !inspection && !showSettings) {
        const list = listStateRef.current?.items ?? [];
        const index = list.findIndex(item => item.id === locationRef.current.session);
        const next = list[index + (event.key === 'j' ? 1 : -1)];
        if (next) { event.preventDefault(); selectSession(next); }
      }
    }
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [inspection, showSettings, selectSession]);
  const activeSession = session?.session.id === location.session ? session : null;
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'dark' ? Moon : Sun;
  return <div className="app-shell flex h-dvh overflow-hidden bg-[var(--bg)]">
    {sidebarOpen && <><button className="sidebar-backdrop fixed inset-0 z-20 border-0 bg-[#10231855] min-[901px]:hidden" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} /><Sidebar data={sessions} selectedId={location.session} query={query} project={project} loading={listLoading} error={listError} onQuery={setQuery} onProject={setProject} onSelect={selectSession} onLoadMore={() => { if (sessions?.nextCursor != null) void fetchList(sessions.nextCursor); }} onSettings={() => setShowSettings(true)} onClose={() => setSidebarOpen(false)} /></>}
    <main className="main-panel relative flex min-w-0 flex-1 flex-col">
      <div className="topbar flex h-[54px] shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-[var(--canvas-pad)] max-[600px]:h-12 max-[600px]:px-3"><div className="breadcrumbs flex min-w-0 items-center gap-3 text-xs text-[var(--muted)] [&>span]:max-[600px]:hidden [&>strong]:truncate [&>strong]:font-medium [&>strong]:text-[var(--soft)] max-[600px]:gap-1"><button className="icon-button" onClick={() => setSidebarOpen(value => !value)} title={sidebarOpen ? '收起侧栏' : '展开侧栏'} aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}>{sidebarOpen ? <PanelLeftClose size={18} /> : <Menu size={18} />}</button><span>工作空间</span><ChevronRight size={13} /><strong>{activeSession?.session.project || '会话浏览'}</strong></div><div className="topbar-actions flex shrink-0 items-center gap-3 max-[600px]:gap-1"><span className="live-status flex items-center gap-1.5 whitespace-nowrap text-xs text-[var(--muted)]"><span className={`dot ${connected ? '' : 'muted-dot'}`} />{connected ? '实时连接' : '正在重连'}</span><button className="icon-button" title={`主题：${theme === 'system' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色'}，点击切换`} aria-label="切换主题" onClick={() => setTheme(value => value === 'system' ? 'dark' : value === 'dark' ? 'light' : 'system')}><ThemeIcon size={17} /></button><button className="keyboard-button size-7 rounded-md border border-[var(--border)] bg-transparent text-xs text-[var(--muted)] hover:bg-[var(--hover)] max-[600px]:hidden" onClick={() => setShowShortcuts(!showShortcuts)} title="快捷键">?</button></div></div>
      {sessionError && <div className="main-error flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center text-sm text-[var(--muted)] [&>h2]:text-lg [&>h2]:font-semibold [&>h2]:text-[var(--text)]" role="alert"><FileSearch size={26} /><h2>暂时无法读取会话</h2><p>{sessionError}</p><button className="secondary-button" onClick={() => setSessionVersion(value => value + 1)}>重新读取</button></div>}
      {!sessionError && !activeSession && (sessionLoading || listLoading) && <div className="welcome-state flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center text-sm leading-7 text-[var(--muted)] [&>h1]:text-2xl [&>h1]:font-semibold [&>h1]:text-[var(--text)] [&>h2]:text-lg [&>h2]:font-semibold [&>h2]:text-[var(--text)] [&>svg]:text-[var(--accent)]"><LoaderCircle size={28} className="spin" /><h2>正在读取本地会话</h2><p>先载入摘要，详细内容按需读取。</p></div>}
      {!sessionError && !activeSession && !sessionLoading && !listLoading && <div className="welcome-state flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center text-sm leading-7 text-[var(--muted)] [&>h1]:text-2xl [&>h1]:font-semibold [&>h1]:text-[var(--text)] [&>h2]:text-lg [&>h2]:font-semibold [&>h2]:text-[var(--text)] [&>svg]:text-[var(--accent)]"><Layers3 size={32} /><h1>会话观察台</h1><p>浏览本地 Codex 会话、工具调用与 Token 用量。<br />选择一个会话开始阅读，或设置日志目录。</p><button className="primary-button" onClick={() => setShowSettings(true)}><FolderOpen size={16} />选择日志目录</button></div>}
      {activeSession && !sessionError && <SessionWorkspace key={activeSession.session.id} session={activeSession} reloadVersion={sessionVersion} targetTurn={location.turn} navigationVersion={navigationVersion} onInspect={setInspection} onSelectSession={selectSession} onTargetTurn={navigateTurn} />}
      <footer className="statusbar flex h-7 shrink-0 items-center justify-between border-t border-[var(--border)] bg-[var(--panel)] px-[var(--canvas-pad)] text-xs text-[var(--muted)] [&>span]:flex [&>span]:items-center [&>span]:gap-1.5"><span><Check size={12} />本地日志 · 只读</span><span className="statusbar-right ml-auto">Session Lens<span className="version ml-1 font-mono text-[11px]">v0.1</span></span></footer>
    </main>
    {inspection && activeSession && <Suspense fallback={null}><DetailDrawer session={activeSession} selection={inspection} onClose={() => setInspection(null)} onNavigateTurn={navigateTurn} /></Suspense>}
    {showSettings && <Suspense fallback={null}><SettingsModal onClose={() => setShowSettings(false)} onSaved={() => { setSessions(null); setSession(null); setLocation({ session: null, turn: null }); const url = new URL(window.location.href); url.searchParams.delete('session'); url.searchParams.delete('turn'); window.history.replaceState({}, '', url); setListVersion(value => value + 1); }} /></Suspense>}
    {showShortcuts && <div className="shortcut-popover absolute right-5 top-14 z-50 w-64 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-lg [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>p]:mt-3 [&>p]:flex [&>p]:justify-between [&>p]:text-xs [&>p]:text-[var(--muted)]"><div><strong>键盘快捷键</strong><button className="icon-button" onClick={() => setShowShortcuts(false)} aria-label="关闭快捷键"><X size={14} /></button></div><p><span>搜索会话</span><kbd>/</kbd></p><p><span>上 / 下一个会话</span><span><kbd>k</kbd> <kbd>j</kbd></span></p><p><span>打开设置</span><kbd>,</kbd></p><p><span>关闭面板</span><kbd>Esc</kbd></p><p><span>显示快捷键</span><kbd>?</kbd></p></div>}
  </div>;
}

function SessionWorkspace({ session, reloadVersion, targetTurn, navigationVersion, onInspect, onSelectSession, onTargetTurn }: { session: SessionDetail; reloadVersion: number; targetTurn: string | null; navigationVersion: number; onInspect: (selection: Inspection) => void; onSelectSession: (session: SessionSummary) => void; onTargetTurn: (id: string) => void }) {
  const virtuoso = useRef<VirtuosoHandle>(null);
  const atBottom = useRef(true);
  const [newContent, setNewContent] = useState(false);
  const previousRevision = useRef(session.session.revision);
  const [showToolSearch, setShowToolSearch] = useState(false);
  const [view, setView] = useState<'conversation' | 'tokens' | 'collaboration'>('conversation');
  const [toolQuery, setToolQuery] = useState('');
  const [matches, setMatches] = useState<{ turnId: string; eventId: string; text: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const searchController = useRef<AbortController | null>(null);
  const reading = useReadingPosition(session.session.id, session.turns.map(turn => turn.id), targetTurn, navigationVersion, virtuoso);
  useEffect(() => {
    if (previousRevision.current !== session.session.revision) {
      if (!atBottom.current) setNewContent(true);
      previousRevision.current = session.session.revision;
    }
  }, [session.session.revision]);
  useEffect(() => { if (targetTurn) { atBottom.current = false; setView('conversation'); } }, [targetTurn, navigationVersion]);
  useEffect(() => () => searchController.current?.abort(), []);
  async function searchTools(event: React.FormEvent) {
    event.preventDefault(); if (!toolQuery.trim()) return;
    searchController.current?.abort(); const controller = new AbortController(); searchController.current = controller;
    setSearching(true); setSearchError('');
    try { const result = await api<{ matches: { turnId: string; eventId: string; text: string }[] }>(`${sessionPath(session.session.id)}/search?query=${encodeURIComponent(toolQuery.trim())}`, { signal: controller.signal }); if (!controller.signal.aborted) setMatches(result.matches); } catch (cause) { if (!isAbort(cause)) setSearchError(errorMessage(cause)); } finally { if (!controller.signal.aborted) setSearching(false); }
  }
  const value = session.session;
  const navigateToTurn = (turnId: string) => { setView('conversation'); onTargetTurn(turnId); };
  const inspectUsage = (metric: 'total' | 'requests' | 'cache' | 'latest') => {
    if (metric === 'requests') { setView('tokens'); return; }
    onInspect({ focus: metric });
  };
  return <div className="session-workspace flex min-h-0 flex-1 flex-col">
    <header className="session-header shrink-0 bg-[var(--panel)] px-[var(--canvas-pad)] pb-4 pt-6 max-[600px]:pb-3 max-[600px]:pt-4">
      <div className="session-title-row flex items-start justify-between gap-5 [&>h1]:min-w-0 [&>h1]:flex-1 [&>h1]:text-[22px] [&>h1]:font-semibold [&>h1]:leading-snug [&>h1]:tracking-[-.02em] [&>h1]:line-clamp-2 max-[600px]:[&>h1]:text-lg"><h1 title={sessionTooltip(value)}>{sessionDisplayName(value)}</h1><span className={`status-label max-[600px]:hidden ${value.status}`}><Circle size={6} fill="currentColor" />{statusLabels[value.status]}</span></div>
      <div className="session-meta-row mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5"><div className="session-location flex min-w-0 items-center gap-2 text-xs text-[var(--muted)] [&>span]:truncate [&>span:first-of-type]:max-w-[420px] max-[600px]:w-full max-[600px]:[&>span:first-of-type]:max-w-[60%]"><FolderOpen size={14} /><span title={value.cwd}>{value.cwd || '工作目录未记录'}</span>{value.branch && <><GitBranch size={13} /><span title={value.branch}>{value.branch}</span></>}<span className="session-model shrink-0">{value.model || '模型未记录'}</span></div>
        <span className={`status-label min-[601px]:hidden ${value.status}`}><Circle size={6} fill="currentColor" />{statusLabels[value.status]}</span><div className="related-sessions ml-auto flex min-w-0 items-center gap-2 max-[600px]:ml-0 [&>button]:inline-flex [&>button]:min-h-8 [&>button]:items-center [&>button]:gap-1.5 [&>button]:rounded-md [&>button]:px-2 [&>button]:text-xs [&>button]:text-[var(--soft)] [&>button]:hover:bg-[var(--accent-light)] [&>button]:hover:text-[var(--accent-strong)] max-[600px]:[&>button]:min-h-9">{session.parent && <button onClick={() => onSelectSession(session.parent!)} title={sessionTooltip(session.parent)}><ArrowLeft size={14} />父会话</button>}{session.children.length > 0 && <button onClick={() => setView('collaboration')}><GitBranch size={14} />{session.children.length.toLocaleString()} 个子会话</button>}{value.usage.completeness !== 'complete' && <span className="subtle-badge">{value.usage.completeness === 'partial' ? '部分用量记录' : '缺少用量记录'}</span>}</div>
      </div>
      <SessionStats usage={value.usage} onDetails={inspectUsage} />
    </header>
    <div className="timeline-toolbar flex min-h-[54px] shrink-0 items-center justify-between gap-3 border-y border-[var(--border)] bg-[var(--panel)] px-[var(--canvas-pad)] max-[600px]:min-h-[52px]"><div className="timeline-view-buttons flex items-center gap-2" aria-label="会话视图">{([['conversation', '对话'], ['tokens', 'Token 与压缩'], ['collaboration', '子代理协作']] as const).map(([id, label]) => <button key={id} type="button" className={`min-h-9 rounded-md px-3 py-2 text-[13px] transition-colors max-[600px]:min-h-11 max-[600px]:px-2 ${view === id ? 'bg-[var(--accent-light)] font-medium text-[var(--accent-strong)]' : 'text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]'}`} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}</div>{view === 'conversation' && <button className={showToolSearch ? 'active text-button tool-search-toggle shrink-0 text-[var(--accent-strong)] max-[600px]:size-11 max-[600px]:justify-center' : 'text-button tool-search-toggle shrink-0 max-[600px]:size-11 max-[600px]:justify-center'} aria-expanded={showToolSearch} aria-controls="tool-search-panel" onClick={() => setShowToolSearch(!showToolSearch)}><Search size={16} /><span className="max-[600px]:sr-only">搜索工具内容</span></button>}</div>
    {view === 'conversation' && showToolSearch && <div className="tool-search-panel max-h-[280px] shrink-0 overflow-y-auto border-b border-[var(--border)] bg-[var(--panel)] px-[var(--canvas-pad)] py-3 [&>form]:flex [&>form]:items-center [&>form]:gap-2 [&_input]:min-h-[var(--control-height)] [&_input]:min-w-0 [&_input]:flex-1 [&_input]:rounded-md [&_input]:border [&_input]:border-[var(--control)] [&_input]:bg-[var(--bg)] [&_input]:px-3 [&_input]:text-sm [&_button[type=submit]]:min-h-[var(--control-height)] [&_button[type=submit]]:rounded-md [&_button[type=submit]]:bg-[var(--primary)] [&_button[type=submit]]:px-3 [&_button[type=submit]]:text-xs [&_button[type=submit]]:text-[var(--on-primary)]" id="tool-search-panel"><form onSubmit={event => void searchTools(event)}><Search size={14} /><input autoFocus value={toolQuery} onChange={event => setToolQuery(event.target.value)} placeholder="搜索工具参数与输出" aria-label="搜索工具内容" /><button type="submit" disabled={searching || !toolQuery.trim()}>{searching ? '搜索中…' : '搜索'}</button><button type="button" className="icon-button" aria-label="关闭工具搜索" onClick={() => setShowToolSearch(false)}><X size={14} /></button></form>{searchError && <p className="inline-error">{searchError}</p>}{matches && <div className="tool-search-results pt-2 [&>button]:flex [&>button]:w-full [&>button]:items-center [&>button]:gap-3 [&>button]:border-t [&>button]:border-[var(--border)] [&>button]:py-3 [&>button]:text-left [&>button]:text-xs [&>button]:hover:text-[var(--accent)] [&_p]:truncate [&_p]:text-[var(--muted)] [&_span]:shrink-0 [&_svg]:ml-auto">{matches.length === 0 ? <p>没有匹配的工具内容</p> : matches.map((match, index) => <button key={`${match.eventId}-${index}`} onClick={() => navigateToTurn(match.turnId)}><span>第 {(session.turns.find(turn => turn.id === match.turnId)?.index ?? 0) + 1} 轮</span><p>{match.text}</p><ChevronRight size={14} /></button>)}</div>}</div>}
    <div className="workspace-content relative min-h-0 flex-1">
    {view !== 'conversation' && <Suspense fallback={<div className="turn-loading">正在打开会话视图…</div>}><SessionOverview session={session} view={view} onInspect={onInspect} onSelectSession={onSelectSession} onNavigateTurn={navigateToTurn} /></Suspense>}
    <div className="timeline-viewport absolute inset-0 min-h-0" aria-hidden={view !== 'conversation'} style={view === 'conversation' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}>
      {session.turns.length === 0 ? <div className="timeline-empty flex h-full min-h-40 flex-col items-center justify-center gap-3 text-sm text-[var(--muted)]"><Layers3 size={24} /><p>会话已载入，还没有可展示的轮次。</p></div> : <Virtuoso ref={virtuoso} className="turn-virtuoso h-full [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent]" data={session.turns} computeItemKey={(_, turn) => turn.id} scrollerRef={reading.scrollerRef} totalListHeightChanged={reading.onLayoutChanged} rangeChanged={reading.onLayoutChanged} increaseViewportBy={600} followOutput={reading.followOutput} atBottomThreshold={100} atBottomStateChange={value => { atBottom.current = value; if (value) setNewContent(false); }} itemContent={(_, turn) => <TurnCard turn={turn} sessionId={value.id} revision={`${value.revision}:${reloadVersion}`} targetTurn={targetTurn} onInspect={onInspect} onReady={reading.onTurnReady} />} />}
      {newContent && <button className="new-content-button absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-[var(--primary)] px-4 py-2.5 text-xs text-[var(--on-primary)] shadow-lg" onClick={() => { reading.cancelNavigation(); virtuoso.current?.scrollToIndex({ index: session.turns.length - 1, align: 'end', behavior: 'smooth' }); setNewContent(false); }}><ArrowDown size={14} />有新内容，跳到最新</button>}
    </div>
    </div>
  </div>;
}
