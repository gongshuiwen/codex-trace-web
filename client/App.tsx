import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ArrowDown, ArrowLeft, Check, ChevronDown, ChevronRight, ChevronUp, Circle, FileSearch, FolderOpen, GitBranch, Layers3, ListOrdered, LoaderCircle, Menu, Moon, MoreHorizontal, PanelLeftClose, Search, Sun, Monitor, X } from 'lucide-react';
import type { CompactionItem, IndexProgress, LiveEvent, SessionDetail, SessionList, SessionSummary, ToolFailureItem, ToolSearchMatch } from '../shared/types';
import { api, errorMessage, isAbort, sessionPath } from './api';
import { Sidebar } from './Sidebar';
import { SessionStats, type UsageMetric } from './Stats';
import { TurnCard } from './TurnCard';
import { RecordWorkspace } from './RecordInspector';
import { navigateSessionLocation, readSessionLocation, type SessionLocation, type SessionView } from './session-location';
import { sessionDisplayName, sessionTooltip, statusLabels } from './format';
import { useReadingPosition } from './useReadingPosition';
import { READING_BOTTOM_TOLERANCE } from './reading-position';
import { nextToolNavigationId, toolFailureTarget, toolSearchTarget, type CompactionNavigationTarget, type ToolNavigationTarget } from './tool-navigation';
import { ToolFailureNavigator } from './ToolFailureNavigator';
import { CompactionNavigator } from './CompactionNavigator';
import { toolGroupViewState, toolTabState } from './tool-view-state';
import { TurnDirectory } from './TurnDirectory';
import './session-header.css';
import './tool-search.css';

const SettingsModal = lazy(() => import('./SettingsModal').then(module => ({ default: module.SettingsModal })));
const SessionOverview = lazy(() => import('./SessionOverview'));

type Theme = 'system' | 'dark' | 'light';
type ConversationMode = 'reading' | 'full';

function initialConversationMode(): ConversationMode {
  try { return localStorage.getItem('session-lens-conversation-mode') === 'full' ? 'full' : 'reading'; } catch { return 'reading'; }
}

function initialTheme(): Theme {
  try { const value = localStorage.getItem('session-lens-theme'); return value === 'dark' || value === 'light' ? value : 'system'; } catch { return 'system'; }
}

function mergeSessionPages(previous: SessionList | null, page: SessionList): SessionList {
  if (!previous) return page;
  return { ...page,
    ancestors: [...new Map([...(previous.ancestors ?? []), ...(page.ancestors ?? [])].map(item => [item.id, item])).values()],
    items: [...new Map([...previous.items, ...page.items].map(item => [item.id, item])).values()],
  };
}

function toolSearchPreview(match: ToolSearchMatch) {
  const hit = match.excerptOffset === undefined ? match.text.indexOf(match.matchedText) : match.offset - match.excerptOffset;
  if (hit < 0 || match.text.slice(hit, hit + match.length) !== match.matchedText) return match.text;
  let start = Math.max(0, hit - 24);
  let end = Math.min(match.text.length, hit + match.length + 100);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(match.text[start]!)) start--;
  if (end < match.text.length && /[\uDC00-\uDFFF]/.test(match.text[end]!)) end++;
  const compact = (text: string) => text.replace(/\s+/g, ' ');
  return <>{start > 0 || (match.excerptOffset ?? match.offset - hit) > 0 ? '…' : ''}{compact(match.text.slice(start, hit))}<mark>{compact(match.matchedText)}</mark>{compact(match.text.slice(hit + match.length, end))}{end < match.text.length ? '…' : ''}</>;
}

export function App() {
  const [location, setLocation] = useState(readSessionLocation);
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
    const handler = () => { setLocation(readSessionLocation()); setNavigationVersion(value => value + 1); };
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
        const next: SessionLocation = { session: value.items[0].id, turn: null, view: 'conversation', request: null, usageTurn: null, focus: null };
        navigateSessionLocation(next, true); setLocation(next);
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
      window.dispatchEvent(new CustomEvent('session-lens:change', { detail: data }));
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

  const navigate = useCallback((next: SessionLocation, replace = false, resetReading = false) => {
    navigateSessionLocation(next, replace, resetReading); setLocation(next);
    setNavigationVersion(version => version + 1);
  }, []);
  const selectSession = useCallback((value: SessionSummary) => {
    const next: SessionLocation = { session: value.id, turn: value.match?.turnId ?? null, view: 'conversation', request: null, usageTurn: null, focus: null };
    navigate(next);
    if (window.innerWidth <= 900) setSidebarOpen(false);
  }, [navigate]);
  const navigateTurn = useCallback((turnId: string) => {
    const sessionId = locationRef.current.session;
    if (!sessionId) return;
    navigate({ ...locationRef.current, turn: turnId, view: 'conversation' }, false, true);
  }, [navigate]);

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'Escape') { setShowSettings(false); setShowShortcuts(false); if (window.innerWidth <= 900) setSidebarOpen(false); return; }
      const target = event.target as HTMLElement | null;
      if (showSettings || target?.closest('[role="dialog"],input,textarea,select,[contenteditable="true"]')) return;
      if (event.key === ',') { event.preventDefault(); setShowSettings(true); }
      if (event.key === '?') { event.preventDefault(); setShowShortcuts(value => !value); }
      if (event.key === '/') { event.preventDefault(); setSidebarOpen(true); requestAnimationFrame(() => document.getElementById('session-search')?.focus()); }
      if ((event.key === 'j' || event.key === 'k') && !showSettings) {
        const list = listStateRef.current?.items ?? [];
        const index = list.findIndex(item => item.id === locationRef.current.session);
        const next = list[index + (event.key === 'j' ? 1 : -1)];
        if (next) { event.preventDefault(); selectSession(next); }
      }
    }
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [showSettings, selectSession]);
  const activeSession = session?.session.id === location.session ? session : null;
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'dark' ? Moon : Sun;
  return <div className="app-shell flex h-dvh overflow-hidden bg-[var(--bg)]">
    {sidebarOpen && <><button className="sidebar-backdrop fixed inset-0 z-20 border-0 bg-[#10231855] min-[901px]:hidden" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} /><Sidebar data={sessions} selectedId={location.session} query={query} project={project} loading={listLoading} error={listError} onQuery={setQuery} onProject={setProject} onSelect={selectSession} onLoadMore={() => { if (sessions?.nextCursor != null) void fetchList(sessions.nextCursor); }} onSettings={() => setShowSettings(true)} onClose={() => setSidebarOpen(false)} /></>}
    <main className="main-panel relative flex min-w-0 flex-1 flex-col">
      <div className="topbar flex h-[54px] shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-[var(--canvas-pad)] max-[600px]:h-12 max-[600px]:px-3"><div className="breadcrumbs flex min-w-0 items-center gap-3 text-xs text-[var(--muted)] [&>span]:max-[600px]:hidden [&>strong]:truncate [&>strong]:font-medium [&>strong]:text-[var(--soft)] max-[600px]:gap-1"><button className="icon-button" onClick={() => setSidebarOpen(value => !value)} title={sidebarOpen ? '收起侧栏' : '展开侧栏'} aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}>{sidebarOpen ? <PanelLeftClose size={18} /> : <Menu size={18} />}</button><span>工作空间</span><ChevronRight size={13} /><strong>{activeSession?.session.project || '会话浏览'}</strong></div><div className="topbar-actions flex shrink-0 items-center gap-3 max-[600px]:gap-1"><span className="live-status flex items-center gap-1.5 whitespace-nowrap text-xs text-[var(--muted)]"><span className={`dot ${connected ? '' : 'muted-dot'}`} />{connected ? '实时连接' : '正在重连'}</span><button className="icon-button" title={`主题：${theme === 'system' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色'}，点击切换`} aria-label="切换主题" onClick={() => setTheme(value => value === 'system' ? 'dark' : value === 'dark' ? 'light' : 'system')}><ThemeIcon size={17} /></button><button className="keyboard-button size-7 rounded-md border border-[var(--border)] bg-transparent text-xs text-[var(--muted)] hover:bg-[var(--hover)] max-[600px]:hidden" onClick={() => setShowShortcuts(!showShortcuts)} title="快捷键">?</button></div></div>
      {sessionError && !activeSession && <div className="main-error flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center text-sm text-[var(--muted)] [&>h2]:text-lg [&>h2]:font-semibold [&>h2]:text-[var(--text)]" role="alert"><FileSearch size={26} /><h2>暂时无法读取会话</h2><p>{sessionError}</p><button className="secondary-button" onClick={() => setSessionVersion(value => value + 1)}>重新读取</button></div>}
      {sessionError && activeSession && <div className="session-refresh-error" role="alert"><span>刷新失败，仍显示已加载内容。{sessionError}</span><button type="button" className="text-button" onClick={() => setSessionVersion(value => value + 1)}>重试刷新</button></div>}
      {!sessionError && !activeSession && (sessionLoading || listLoading) && <div className="welcome-state flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center text-sm leading-7 text-[var(--muted)] [&>h1]:text-2xl [&>h1]:font-semibold [&>h1]:text-[var(--text)] [&>h2]:text-lg [&>h2]:font-semibold [&>h2]:text-[var(--text)] [&>svg]:text-[var(--accent)]"><LoaderCircle size={28} className="spin" /><h2>正在读取本地会话</h2><p>先载入摘要，详细内容按需读取。</p></div>}
      {!sessionError && !activeSession && !sessionLoading && !listLoading && <div className="welcome-state flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center text-sm leading-7 text-[var(--muted)] [&>h1]:text-2xl [&>h1]:font-semibold [&>h1]:text-[var(--text)] [&>h2]:text-lg [&>h2]:font-semibold [&>h2]:text-[var(--text)] [&>svg]:text-[var(--accent)]"><Layers3 size={32} /><h1>会话观察台</h1><p>浏览本地 Codex 会话、工具调用与 Token 用量。<br />选择一个会话开始阅读，或设置日志目录。</p><button className="primary-button" onClick={() => setShowSettings(true)}><FolderOpen size={16} />选择日志目录</button></div>}
      {activeSession && <SessionWorkspace key={activeSession.session.id} session={activeSession} reloadVersion={sessionVersion} location={location} onNavigate={navigate} navigationVersion={navigationVersion} onSelectSession={selectSession} onTargetTurn={navigateTurn} />}
      <footer className="statusbar flex h-7 shrink-0 items-center justify-between border-t border-[var(--border)] bg-[var(--panel)] px-[var(--canvas-pad)] text-xs text-[var(--muted)] [&>span]:flex [&>span]:items-center [&>span]:gap-1.5"><span><Check size={12} />本地日志 · 只读</span><span className="statusbar-right ml-auto">Session Lens<span className="version ml-1 font-mono text-[11px]">v0.1</span></span></footer>
    </main>
    {showSettings && <Suspense fallback={null}><SettingsModal onClose={() => setShowSettings(false)} onSaved={() => { setSessions(null); setSession(null); navigate({ session: null, turn: null, view: 'conversation', request: null, usageTurn: null, focus: null }, true); setListVersion(value => value + 1); }} /></Suspense>}
    {showShortcuts && <div className="shortcut-popover absolute right-5 top-14 z-50 w-64 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-lg [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>p]:mt-3 [&>p]:flex [&>p]:justify-between [&>p]:text-xs [&>p]:text-[var(--muted)]"><div><strong>键盘快捷键</strong><button className="icon-button" onClick={() => setShowShortcuts(false)} aria-label="关闭快捷键"><X size={14} /></button></div><p><span>搜索会话</span><kbd>/</kbd></p><p><span>上 / 下一个会话</span><span><kbd>k</kbd> <kbd>j</kbd></span></p><p><span>打开设置</span><kbd>,</kbd></p><p><span>关闭面板</span><kbd>Esc</kbd></p><p><span>显示快捷键</span><kbd>?</kbd></p></div>}
  </div>;
}

function SessionWorkspace({ session, reloadVersion, location, onNavigate, navigationVersion, onSelectSession, onTargetTurn }: { session: SessionDetail; reloadVersion: number; location: SessionLocation; onNavigate: (next: SessionLocation, replace?: boolean) => void; navigationVersion: number; onSelectSession: (session: SessionSummary) => void; onTargetTurn: (id: string) => void }) {
  const { view, turn: targetTurn } = location;
  const virtuoso = useRef<VirtuosoHandle>(null);
  const atBottom = useRef(true);
  const [newContent, setNewContent] = useState(false);
  const previousRevision = useRef(session.session.revision);
  const [showToolSearch, setShowToolSearch] = useState(false);
  const [conversationMode, setConversationMode] = useState(initialConversationMode);
  const [showTurnDirectory, setShowTurnDirectory] = useState(false);
  const [answerTarget, setAnswerTarget] = useState<{ turnId: string; eventId: string; version: number } | null>(null);
  const [overviewOpened, setOverviewOpened] = useState(view !== 'conversation');
  const setView = (next: SessionView) => {
    if (next === view) return;
    setToolTarget(null); setCompactionTarget(null); setAnswerTarget(null);
    onNavigate({ ...location, view: next });
  };
  const [toolQuery, setToolQuery] = useState('');
  const [matches, setMatches] = useState<ToolSearchMatch[] | null>(null);
  const [matchQuery, setMatchQuery] = useState('');
  const [matchRevision, setMatchRevision] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [toolTarget, setToolTarget] = useState<ToolNavigationTarget | null>(null);
  const [compactionTarget, setCompactionTarget] = useState<CompactionNavigationTarget | null>(null);
  const [recordNavigator, setRecordNavigator] = useState<'failures' | 'compactions' | null>(null);
  const [recordRequestId, setRecordRequestId] = useState(0);
  const searchNavigationRequested = useRef(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchRequestQuery, setSearchRequestQuery] = useState('');
  const searchController = useRef<AbortController | null>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const searchResults = useRef<HTMLDivElement>(null);
  const searchComposing = useRef(false);
  const reading = useReadingPosition(session.session.id, session.turns.map(turn => turn.id), targetTurn, navigationVersion, virtuoso,
    answerTarget ?? compactionTarget ?? (toolTarget ? { turnId: toolTarget.turnId, toolId: toolTarget.toolId, eventId: toolTarget.eventId } : null), view === 'conversation');
  const preserveToolLayout = useCallback((change: () => void) => {
    setToolTarget(previous => previous?.reveal ? { ...previous, reveal: false } : previous);
    reading.preserveLayout(change);
  }, [reading.preserveLayout]);
  const searchReady = useCallback((version: number) => { setToolTarget(previous => previous?.version === version && previous.reveal ? { ...previous, reveal: false } : previous); }, []);
  useEffect(() => {
    if (!searchNavigationRequested.current) { setToolTarget(null); setCompactionTarget(null); setAnswerTarget(null); }
    searchNavigationRequested.current = false;
  }, [targetTurn, navigationVersion]);
  useEffect(() => {
    if (previousRevision.current !== session.session.revision) {
      if (!atBottom.current) setNewContent(true);
      previousRevision.current = session.session.revision;
    }
  }, [session.session.revision]);
  useEffect(() => { if (targetTurn) atBottom.current = false; }, [targetTurn]);
  useEffect(() => { if (view !== 'conversation') setOverviewOpened(true); }, [view]);
  useEffect(() => () => searchController.current?.abort(), []);
  useEffect(() => {
    try { localStorage.setItem('session-lens-conversation-mode', conversationMode); } catch { /* Display preferences must not interrupt reading. */ }
  }, [conversationMode]);
  useEffect(() => {
    searchResults.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeMatchIndex, matches, showToolSearch, view]);
  async function searchTools() {
    if (!toolQuery.trim() || searchComposing.current) return;
    const query = toolQuery.trim();
    const revision = session.session.revision;
    searchController.current?.abort(); const controller = new AbortController(); searchController.current = controller;
    setSearching(true); setSearchError(''); setSearchRequestQuery(query);
    try {
      const result = await api<{ matches: ToolSearchMatch[]; truncated: boolean }>(`${sessionPath(session.session.id)}/search?query=${encodeURIComponent(query)}`, { signal: controller.signal });
      if (!controller.signal.aborted && searchController.current === controller) reading.preserveLayout(() => {
        setMatches(result.matches); setMatchQuery(query); setMatchRevision(revision); setActiveMatchIndex(-1); setSearchTruncated(result.truncated);
      });
    } catch (cause) {
      if (!controller.signal.aborted && searchController.current === controller && !isAbort(cause)) setSearchError(errorMessage(cause));
    } finally {
      if (searchController.current === controller) { searchController.current = null; setSearching(false); }
    }
  }
  function closeToolSearch() {
    searchController.current?.abort(); searchController.current = null;
    searchComposing.current = false;
    setSearching(false);
    reading.preserveLayout(() => setShowToolSearch(false));
    requestAnimationFrame(() => searchToggle.current?.focus({ preventScroll: true }));
  }
  const searchQueryChanged = matches !== null && toolQuery.trim() !== matchQuery;
  const searchLogChanged = matches !== null && matchRevision !== session.session.revision;
  const canNavigateSearch = Boolean(matches?.length) && !searching && !searchQueryChanged && !searchLogChanged && !searchError;
  const searchStatus = searching
    ? `正在搜索“${searchRequestQuery}”…${matches !== null ? ' 当前仍显示上次结果。' : ''}`
    : searchError ? `搜索“${searchRequestQuery}”失败。${matches !== null ? `当前仍显示“${matchQuery}”的结果。` : '请重试。'}`
    : searchQueryChanged ? `关键词已修改，按 Enter 搜索。当前显示“${matchQuery}”的结果。`
    : searchLogChanged ? '会话内容已更新，请重新搜索。'
    : matches === null ? '搜索当前会话的工具参数与完整输出，按 Enter 开始。'
    : matches.length === 0 ? `没有找到“${matchQuery}”，试试其他关键词。`
    : `${searchTruncated ? '已显示前' : '找到'} ${matches.length} 处匹配`;
  function searchKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || searchComposing.current) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeToolSearch(); return; }
    if (event.ctrlKey || event.metaKey) return;
    const input = event.target instanceof HTMLInputElement;
    const direction = event.altKey && event.key === 'ArrowUp' || input && event.shiftKey && event.key === 'Enter' ? -1
      : event.altKey && event.key === 'ArrowDown' || input && !event.altKey && event.key === 'Enter' ? 1 : 0;
    if (direction && canNavigateSearch) { event.preventDefault(); event.stopPropagation(); navigateToMatch(activeMatchIndex < 0 ? direction < 0 ? matches!.length - 1 : 0 : activeMatchIndex + direction); }
  }
  const value = session.session;
  const navigateToTurn = (turnId: string) => {
    reading.cancelNavigation(); setToolTarget(null); setCompactionTarget(null); setAnswerTarget(null);
    onTargetTurn(turnId);
  };
  function navigateToAnswer(turnId: string, eventId: string) {
    reading.cancelNavigation(); searchNavigationRequested.current = true;
    setToolTarget(null); setCompactionTarget(null);
    setAnswerTarget({ turnId, eventId, version: nextToolNavigationId() });
    onTargetTurn(turnId);
  }
  function changeConversationMode(mode: ConversationMode) {
    if (mode !== conversationMode) reading.preserveLayout(() => setConversationMode(mode));
  }
  function navigateToMatch(index: number) {
    const match = matches?.[index];
    if (!match || !canNavigateSearch) return;
    setActiveMatchIndex(index);
    reading.cancelNavigation(); searchNavigationRequested.current = true;
    setCompactionTarget(null); setAnswerTarget(null);
    const target = toolSearchTarget(match, matchQuery, nextToolNavigationId());
    setToolTarget(target);
    onTargetTurn(match.turnId);
  }
  function navigateToFailure(failure: ToolFailureItem) {
    reading.cancelNavigation(); searchNavigationRequested.current = true;
    setCompactionTarget(null); setAnswerTarget(null);
    toolTabState.set(session.session.id, failure.toolId, 'result');
    setToolTarget(toolFailureTarget(failure, nextToolNavigationId()));
    onTargetTurn(failure.turnId);
  }
  function navigateToCompaction(record: CompactionItem) {
    reading.cancelNavigation(); searchNavigationRequested.current = true;
    setToolTarget(null); setAnswerTarget(null); setCompactionTarget({ ...record, version: nextToolNavigationId() });
    onTargetTurn(record.turnId);
  }
  function setAllToolsOpen(open: boolean) {
    reading.cancelNavigation();
    preserveToolLayout(() => { if (open) setConversationMode('full'); toolGroupViewState.setAll(session.session.id, open); });
  }
  const bulkToolActions = <>
    <button type="button" className="tool-bulk-button" aria-label="展开全部工具组" title="展开当前会话的全部工具组" disabled={value.toolCount === 0} onClick={() => setAllToolsOpen(true)}><ChevronDown size={15} /><span className="tool-bulk-label">全部展开</span></button>
    <button type="button" className="tool-bulk-button" aria-label="收起全部工具组" title="收起当前会话的全部工具组" disabled={value.toolCount === 0} onClick={() => setAllToolsOpen(false)}><ChevronUp size={15} /><span className="tool-bulk-label">全部收起</span></button>
  </>;
  const modeControl = <select className="conversation-mode-select" aria-label="对话显示模式" value={conversationMode} onChange={event => {
    changeConversationMode(event.currentTarget.value as ConversationMode);
    const menu = event.currentTarget.closest('details');
    if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); }
  }}><option value="reading">阅读模式</option><option value="full">完整记录</option></select>;
  const inspectUsage = (metric: UsageMetric) => {
    reading.cancelNavigation();
    if (metric === 'failures' || metric === 'compactions') {
      if (view !== 'conversation') setView('conversation');
      reading.preserveLayout(() => { setRecordNavigator(metric); setRecordRequestId(value => value + 1); });
      return;
    }
    if (metric === 'requests') { onNavigate({ ...location, view: 'usage', focus: 'requests' }); return; }
    onNavigate({ ...location, view: 'usage', focus: metric, ...(metric === 'latest' ? { request: null, usageTurn: null } : {}) });
  };
  return <div className="session-workspace flex min-h-0 flex-1 flex-col" data-conversation-mode={conversationMode}>
    <header className="session-header shrink-0 bg-[var(--panel)] px-[var(--canvas-pad)] pb-3 pt-4 max-[600px]:pb-2 max-[600px]:pt-3">
      <div className="session-title-row flex items-start justify-between gap-5 [&>h1]:min-w-0 [&>h1]:flex-1 [&>h1]:text-[22px] [&>h1]:font-semibold [&>h1]:leading-snug [&>h1]:tracking-[-.02em] [&>h1]:line-clamp-2 max-[600px]:[&>h1]:text-lg"><h1 title={sessionTooltip(value)}>{sessionDisplayName(value)}</h1><span className={`status-label max-[600px]:hidden ${value.status}`}><Circle size={6} fill="currentColor" />{statusLabels[value.status]}</span></div>
      <div className="session-meta-row mt-1 flex min-h-7 min-w-0 items-center gap-x-3 gap-y-1 text-xs text-[var(--muted)] max-[600px]:flex-wrap"><div className="session-location"><FolderOpen size={14} /><span className="session-cwd" title={value.cwd}>{value.cwd || '工作目录未记录'}</span>{value.branch && <><GitBranch size={13} /><span className="session-branch" title={value.branch}>{value.branch}</span></>}<span className="session-model" title={value.model || '模型未记录'}>{value.model || '模型未记录'}</span></div>
        <span className={`status-label min-[601px]:hidden ${value.status}`}><Circle size={6} fill="currentColor" />{statusLabels[value.status]}</span><div className="related-sessions ml-auto flex min-w-0 shrink-0 items-center gap-2 max-[600px]:ml-0 max-[600px]:flex-wrap [&>button]:inline-flex [&>button]:min-h-7 [&>button]:items-center [&>button]:gap-1.5 [&>button]:rounded-md [&>button]:px-2 [&>button]:text-xs [&>button]:text-[var(--soft)] [&>button]:hover:bg-[var(--accent-light)] [&>button]:hover:text-[var(--accent-strong)] max-[600px]:[&>button]:min-h-9">{session.parent && <button onClick={() => onSelectSession(session.parent!)} title={sessionTooltip(session.parent)}><ArrowLeft size={14} />父会话</button>}{session.children.length > 0 && <button onClick={() => setView('collaboration')}><GitBranch size={14} />{session.children.length.toLocaleString()} 个子会话</button>}{value.usage.completeness !== 'complete' && <span className="subtle-badge">{value.usage.completeness === 'partial' ? '部分用量记录' : '缺少用量记录'}</span>}</div>
      </div>
      <SessionStats usage={value.usage} toolCount={value.toolCount} toolFailureCount={value.toolFailureCount} durationMs={value.durationMs} compactionCount={value.compactionCount} onDetails={inspectUsage} />
    </header>
    <div className="timeline-toolbar flex min-h-11 shrink-0 items-center justify-between gap-3 border-y border-[var(--border)] bg-[var(--panel)] px-[var(--canvas-pad)]">
      <div className="timeline-view-buttons flex items-center gap-2" aria-label="会话视图">{([['conversation', '对话'], ['usage', '用量分析'], ['collaboration', '子代理协作']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={view === id} onClick={() => { reading.cancelNavigation(); setView(id); }}>{label}</button>)}</div>
      {view === 'conversation' && <div className="timeline-tool-actions">
        <div className="conversation-mode-desktop">{modeControl}</div>
        <button type="button" className="turn-directory-trigger icon-button" title="轮次目录" aria-label="轮次目录" aria-haspopup="dialog" aria-expanded={showTurnDirectory} aria-controls="turn-directory-dialog" onClick={() => setShowTurnDirectory(true)}><ListOrdered size={17} /></button>
        <details className="timeline-tools-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); }
        }}>
          <summary aria-label="对话选项" title="对话选项"><MoreHorizontal size={18} aria-hidden="true" /></summary>
          <div className="timeline-tools-menu-items" onClick={event => {
            if (!(event.target as HTMLElement).closest('button:not(:disabled)')) return;
            const menu = event.currentTarget.closest('details');
            if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); }
          }}><div className="conversation-mode-mobile">{modeControl}</div>{bulkToolActions}<button type="button" className="compact-tool-search" onClick={() => reading.preserveLayout(() => setShowToolSearch(true))}><Search size={15} />搜索工具内容</button></div>
        </details>
        <button ref={searchToggle} className={showToolSearch ? 'active text-button tool-search-toggle shrink-0 text-[var(--accent-strong)] max-[600px]:size-11 max-[600px]:justify-center' : 'text-button tool-search-toggle shrink-0 max-[600px]:size-11 max-[600px]:justify-center'} aria-label="搜索工具内容" aria-expanded={showToolSearch} aria-controls="tool-search-panel" onClick={() => showToolSearch ? closeToolSearch() : reading.preserveLayout(() => setShowToolSearch(true))}><Search size={16} /><span className="max-[600px]:sr-only">搜索工具内容</span></button>
      </div>}
    </div>
    {view === 'conversation' && showToolSearch && <div className="tool-search-panel" id="tool-search-panel" onKeyDown={searchKeyboard}>
      <form onSubmit={event => { event.preventDefault(); void searchTools(); }}>
        <Search size={14} aria-hidden="true" />
        <input autoFocus value={toolQuery} onChange={event => setToolQuery(event.target.value)} onCompositionStart={() => { searchComposing.current = true; }} onCompositionEnd={() => { searchComposing.current = false; }} onBlur={() => { searchComposing.current = false; }} maxLength={500} placeholder="搜索工具参数与输出" aria-label="搜索工具内容" aria-describedby="tool-search-status" />
        <button type="submit" disabled={searching || !toolQuery.trim()}>{searching ? '搜索中…' : searchError && toolQuery.trim() === searchRequestQuery ? '重试' : '搜索'}</button>
        <button type="button" className="icon-button" aria-label="关闭工具搜索" title="关闭工具搜索 (Esc)" onClick={closeToolSearch}><X size={14} /></button>
      </form>
      <div className="tool-search-feedback">
        <p className="tool-search-summary" id="tool-search-status" role="status" aria-atomic="true">{searching && <LoaderCircle size={13} className="spin" aria-hidden="true" />}{searchStatus}</p>
        {Boolean(matches?.length) && <div className="tool-search-navigation" role="group" aria-label="工具搜索结果导航">
          <span className="tool-search-position" aria-live="polite" aria-atomic="true">{activeMatchIndex < 0 ? '—' : activeMatchIndex + 1} / {matches!.length}{searchTruncated ? '+' : ''}</span>
          <button type="button" disabled={!canNavigateSearch || activeMatchIndex === 0} aria-label="上一条工具搜索结果" title="上一条 (Alt+↑)" onClick={() => navigateToMatch(activeMatchIndex < 0 ? matches!.length - 1 : activeMatchIndex - 1)}><ChevronUp size={15} /></button>
          <button type="button" disabled={!canNavigateSearch || activeMatchIndex + 1 >= matches!.length} aria-label="下一条工具搜索结果" title="下一条 (Alt+↓)" onClick={() => navigateToMatch(activeMatchIndex + 1)}><ChevronDown size={15} /></button>
        </div>}
      </div>
      {searchError && <p className="inline-error" role="alert">{searchError}</p>}
      {matches !== null && <div className="tool-search-results-list" ref={searchResults} aria-label={`“${matchQuery}”的工具搜索结果`} aria-busy={searching || undefined}>
        {matches.map((match, index) => <button type="button" key={`${match.eventId}-${match.field}-${match.offset}`} disabled={!canNavigateSearch} aria-current={activeMatchIndex === index ? 'true' : undefined} onClick={() => navigateToMatch(index)} title={`第 ${(match.offset + 1).toLocaleString()} 字符`}>
          <span className="tool-search-result-content"><strong>{match.toolName}</strong><span>{toolSearchPreview(match)}</span></span>
          <span className="tool-search-result-meta">第 {(session.turns.find(turn => turn.id === match.turnId)?.index ?? 0) + 1} 轮 · {match.field === 'arguments' ? '参数' : '返回'} · 第 {(match.offset + 1).toLocaleString()} 字符</span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>)}
      </div>}
    </div>}
    {recordNavigator && <div hidden={view !== 'conversation'} className="shrink-0">
      {recordNavigator === 'failures'
        ? <ToolFailureNavigator sessionId={value.id} revision={value.revision} requestId={recordRequestId} active={view === 'conversation'} turnIds={session.turns.map(turn => turn.id)} captureNavigationIntent={reading.captureNavigationIntent} onSelect={navigateToFailure} onClose={() => reading.preserveLayout(() => setRecordNavigator(null))} />
        : <CompactionNavigator sessionId={value.id} revision={value.revision} requestId={recordRequestId} active={view === 'conversation'} turnIds={session.turns.map(turn => turn.id)} captureNavigationIntent={reading.captureNavigationIntent} onSelect={navigateToCompaction} onClose={() => reading.preserveLayout(() => setRecordNavigator(null))} />}
    </div>}
    <div className="workspace-content relative min-h-0 flex-1" onKeyDown={event => {
      if (view === 'conversation' && event.altKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing && canNavigateSearch && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault(); navigateToMatch(activeMatchIndex + (event.key === 'ArrowUp' ? -1 : 1));
      }
    }}>
    <RecordWorkspace scope={`${value.id}:${view}`} revision={`${value.revision}:${reloadVersion}`} preserveLayout={reading.preserveLayout} onNavigate={(_, turnId) => navigateToTurn(turnId)}>
    {(overviewOpened || view !== 'conversation') && <Suspense fallback={view !== 'conversation' ? <div className="turn-loading">正在打开会话视图…</div> : null}><SessionOverview session={session} location={location} onNavigate={onNavigate} onSelectSession={onSelectSession} onNavigateTurn={navigateToTurn} /></Suspense>}
    <div className="timeline-viewport absolute inset-0 min-h-0" aria-hidden={view !== 'conversation'} style={view === 'conversation' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}>
      {session.turns.length === 0 ? <div className="timeline-empty flex h-full min-h-40 flex-col items-center justify-center gap-3 text-sm text-[var(--muted)]"><Layers3 size={24} /><p>会话已载入，还没有可展示的轮次。</p></div> : <Virtuoso ref={virtuoso} className="turn-virtuoso h-full [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent]" data={session.turns} computeItemKey={(_, turn) => turn.id} scrollerRef={reading.scrollerRef} totalListHeightChanged={reading.onLayoutChanged} rangeChanged={reading.onLayoutChanged} increaseViewportBy={600} followOutput={reading.followOutput} atBottomThreshold={READING_BOTTOM_TOLERANCE} atBottomStateChange={value => { atBottom.current = value; if (value) setNewContent(false); }} itemContent={(_, turn) => <TurnCard turn={turn} sessionId={value.id} session={session} revision={`${value.revision}:${reloadVersion}`} targetTurn={targetTurn} toolTarget={toolTarget} compactionTarget={compactionTarget} readingMode={conversationMode === 'reading'} onNavigateFinalAnswer={eventId => navigateToAnswer(turn.id, eventId)} preserveLayout={preserveToolLayout} onSearchReady={searchReady} onUsage={turnId => onNavigate({ ...location, view: 'usage', usageTurn: turnId, request: null, focus: 'calls' })} onReady={reading.onTurnReady} />} />}
      {newContent && <button className="new-content-button absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-[var(--primary)] px-4 py-2.5 text-xs text-[var(--on-primary)] shadow-lg" onClick={() => { reading.cancelNavigation(); virtuoso.current?.scrollToIndex({ index: session.turns.length - 1, align: 'end', behavior: 'smooth' }); setNewContent(false); }}><ArrowDown size={14} />有新内容，跳到最新</button>}
    </div>
    </RecordWorkspace>
    </div>
    {showTurnDirectory && <TurnDirectory turns={session.turns} activeTurnId={reading.currentTurnId ?? session.turns[0]?.id ?? null} onSelect={navigateToTurn} onClose={() => setShowTurnDirectory(false)} />}
  </div>;
}
