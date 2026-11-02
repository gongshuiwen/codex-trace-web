import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ArrowDown, ArrowLeft, ArrowUpRight, Check, ChevronRight, Circle, FileSearch, FolderOpen, GitBranch, Layers3, LoaderCircle, Menu, Moon, PanelLeftClose, Search, Sun, Monitor, X } from 'lucide-react';
import type { IndexProgress, LiveEvent, SessionDetail, SessionList, SessionSummary } from '../shared/types';
import { api, errorMessage, isAbort, sessionPath } from './api';
import { Sidebar } from './Sidebar';
import { SessionStats } from './Stats';
import { TurnCard, type Inspection } from './TurnCard';
import { statusLabels } from './format';

const DetailDrawer = lazy(() => import('./DetailDrawer').then(module => ({ default: module.DetailDrawer })));
const SettingsModal = lazy(() => import('./SettingsModal').then(module => ({ default: module.SettingsModal })));

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

export function App() {
  const [location, setLocation] = useState(readLocation);
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
    const handler = () => { setLocation(readLocation()); setInspection(null); };
    window.addEventListener('popstate', handler); return () => window.removeEventListener('popstate', handler);
  }, []);

  const fetchList = useCallback(async (cursor = 0) => {
    listRequest.current?.abort();
    const controller = new AbortController(); listRequest.current = controller;
    const generation = ++listGeneration.current;
    setListLoading(true); setListError('');
    const listKey = `${debouncedQuery}\u0000${project}`;
    const limit = cursor || listKey !== listKeyRef.current ? 50 : Math.max(50, listStateRef.current?.items.length ?? 0);
    const params = new URLSearchParams({ query: debouncedQuery, project, cursor: String(cursor), limit: String(limit) });
    try {
      const value = await api<SessionList>(`/api/sessions?${params}`, { signal: controller.signal });
      if (controller.signal.aborted || generation !== listGeneration.current) return;
      listKeyRef.current = listKey;
      setSessions(previous => cursor ? { ...value, items: [...(previous?.items ?? []), ...value.items.filter(item => !previous?.items.some(old => old.id === item.id))] } : value);
      if (!locationRef.current.session && value.items[0]) {
        writeLocation(value.items[0].id, undefined, true); setLocation({ session: value.items[0].id, turn: null });
      }
    } catch (cause) { if (!isAbort(cause) && generation === listGeneration.current) setListError(errorMessage(cause)); }
    finally { if (generation === listGeneration.current) setListLoading(false); }
  }, [debouncedQuery, project]);
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
    if (window.innerWidth < 900) setSidebarOpen(false);
  }, []);

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'Escape') { setShowSettings(false); setShowShortcuts(false); setInspection(null); if (window.innerWidth < 900) setSidebarOpen(false); return; }
      const target = event.target as HTMLElement | null;
      if (target?.closest('input,textarea,select,[contenteditable="true"]')) return;
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
  return <div className="app-shell">
    {sidebarOpen && <><button className="sidebar-backdrop" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} /><Sidebar data={sessions} selectedId={location.session} query={query} project={project} loading={listLoading} error={listError} onQuery={setQuery} onProject={setProject} onSelect={selectSession} onLoadMore={() => { if (sessions?.nextCursor != null) void fetchList(sessions.nextCursor); }} onSettings={() => setShowSettings(true)} onClose={() => setSidebarOpen(false)} /></>}
    <main className="main-panel">
      <div className="topbar"><div className="breadcrumbs"><button className="icon-button" onClick={() => setSidebarOpen(value => !value)} title={sidebarOpen ? '收起侧栏' : '展开侧栏'} aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}>{sidebarOpen ? <PanelLeftClose size={18} /> : <Menu size={18} />}</button><span>工作空间</span><ChevronRight size={13} /><strong>{activeSession?.session.project || '会话浏览'}</strong></div><div className="topbar-actions"><span className="live-status"><span className={`dot ${connected ? '' : 'muted-dot'}`} />{connected ? '实时连接' : '正在重连'}</span><button className="icon-button" title={`主题：${theme === 'system' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色'}，点击切换`} aria-label="切换主题" onClick={() => setTheme(value => value === 'system' ? 'dark' : value === 'dark' ? 'light' : 'system')}><ThemeIcon size={17} /></button><button className="keyboard-button" onClick={() => setShowShortcuts(!showShortcuts)} title="快捷键">?</button></div></div>
      {sessionError && <div className="main-error" role="alert"><FileSearch size={26} /><h2>暂时无法读取会话</h2><p>{sessionError}</p><button className="secondary-button" onClick={() => setSessionVersion(value => value + 1)}>重新读取</button></div>}
      {!sessionError && !activeSession && (sessionLoading || listLoading) && <div className="welcome-state"><LoaderCircle size={28} className="spin" /><h2>正在读取本地会话</h2><p>先载入摘要，详细内容按需读取。</p></div>}
      {!sessionError && !activeSession && !sessionLoading && !listLoading && <div className="welcome-state"><div className="welcome-icon"><Layers3 size={32} /></div><span className="eyebrow">YOUR LOCAL CONVERSATIONS</span><h1>每一次思考，都有迹可循。</h1><p>浏览 Codex 会话、工具调用与 token 用量。<br />从左侧选择一个会话，或设置日志目录。</p><button className="primary-button" onClick={() => setShowSettings(true)}><FolderOpen size={16} />选择日志目录</button></div>}
      {activeSession && !sessionError && <SessionWorkspace key={activeSession.session.id} session={activeSession} reloadVersion={sessionVersion} targetTurn={location.turn} onInspect={setInspection} onSelectSession={selectSession} onTargetTurn={turnId => { writeLocation(activeSession.session.id, turnId); setLocation({ session: activeSession.session.id, turn: turnId }); }} />}
      <footer className="statusbar"><span><Check size={12} />只读浏览器</span><span>Node.js · 本地日志</span><span className="statusbar-right">SESSION LENS<span className="version">v0.1</span></span></footer>
    </main>
    {inspection && activeSession && <Suspense fallback={null}><DetailDrawer session={activeSession} selection={inspection} onClose={() => setInspection(null)} /></Suspense>}
    {showSettings && <Suspense fallback={null}><SettingsModal onClose={() => setShowSettings(false)} onSaved={() => { setSessions(null); setSession(null); setLocation({ session: null, turn: null }); const url = new URL(window.location.href); url.searchParams.delete('session'); url.searchParams.delete('turn'); window.history.replaceState({}, '', url); setListVersion(value => value + 1); }} /></Suspense>}
    {showShortcuts && <div className="shortcut-popover"><div><strong>键盘快捷键</strong><button className="icon-button" onClick={() => setShowShortcuts(false)} aria-label="关闭快捷键"><X size={14} /></button></div><p><span>搜索会话</span><kbd>/</kbd></p><p><span>上 / 下一个会话</span><span><kbd>k</kbd> <kbd>j</kbd></span></p><p><span>打开设置</span><kbd>,</kbd></p><p><span>关闭面板</span><kbd>Esc</kbd></p><p><span>显示快捷键</span><kbd>?</kbd></p></div>}
  </div>;
}

function SessionWorkspace({ session, reloadVersion, targetTurn, onInspect, onSelectSession, onTargetTurn }: { session: SessionDetail; reloadVersion: number; targetTurn: string | null; onInspect: (selection: Inspection) => void; onSelectSession: (session: SessionSummary) => void; onTargetTurn: (id: string) => void }) {
  const virtuoso = useRef<VirtuosoHandle>(null);
  const atBottom = useRef(true);
  const [newContent, setNewContent] = useState(false);
  const previousRevision = useRef(session.session.revision);
  const [showToolSearch, setShowToolSearch] = useState(false);
  const [toolQuery, setToolQuery] = useState('');
  const [matches, setMatches] = useState<{ turnId: string; eventId: string; text: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const searchController = useRef<AbortController | null>(null);
  const turnsRef = useRef(session.turns); turnsRef.current = session.turns;
  useEffect(() => {
    if (previousRevision.current !== session.session.revision) {
      if (!atBottom.current) setNewContent(true);
      previousRevision.current = session.session.revision;
    }
  }, [session.session.revision]);
  useEffect(() => {
    if (!targetTurn) return;
    const index = turnsRef.current.findIndex(turn => turn.id === targetTurn);
    if (index >= 0) { atBottom.current = false; const timer = setTimeout(() => virtuoso.current?.scrollToIndex({ index, align: 'start' }), 70); return () => clearTimeout(timer); }
  }, [targetTurn]);
  useEffect(() => () => searchController.current?.abort(), []);
  async function searchTools(event: React.FormEvent) {
    event.preventDefault(); if (!toolQuery.trim()) return;
    searchController.current?.abort(); const controller = new AbortController(); searchController.current = controller;
    setSearching(true); setSearchError('');
    try { const result = await api<{ matches: { turnId: string; eventId: string; text: string }[] }>(`${sessionPath(session.session.id)}/search?query=${encodeURIComponent(toolQuery.trim())}`, { signal: controller.signal }); if (!controller.signal.aborted) setMatches(result.matches); } catch (cause) { if (!isAbort(cause)) setSearchError(errorMessage(cause)); } finally { if (!controller.signal.aborted) setSearching(false); }
  }
  const value = session.session;
  return <div className="session-workspace">
    <header className="session-header"><div className="session-eyebrow"><span className="eyebrow">CONVERSATION</span><span className={`status-label ${value.status}`}><Circle size={6} fill="currentColor" />{statusLabels[value.status]}</span></div><h1>{value.title || '未命名会话'}</h1><div className="session-location"><FolderOpen size={14} /><span title={value.cwd}>{value.cwd || '工作目录未记录'}</span>{value.branch && <><i /><GitBranch size={13} /><span>{value.branch}</span></>}<i /><span>{value.model || '模型未记录'}</span></div>
      <SessionStats usage={value.usage} onDetails={() => onInspect({})} />
      {(session.parent || session.children.length > 0) && <div className="related-sessions">{session.parent && <button onClick={() => onSelectSession(session.parent!)}><ArrowLeft size={12} />父会话 · {session.parent.title || session.parent.project}</button>}{session.children.map(child => <button key={child.id} onClick={() => onSelectSession(child)}><GitBranch size={12} />{child.title || child.project}<ArrowUpRight size={12} /></button>)}</div>}
    </header>
    <div className="timeline-toolbar"><div><span className="timeline-marker" /><strong>会话时间线</strong><span>{session.turns.length} 轮</span></div><button className={showToolSearch ? 'active text-button' : 'text-button'} onClick={() => setShowToolSearch(!showToolSearch)}><Search size={14} />搜索工具内容</button></div>
    {showToolSearch && <div className="tool-search-panel"><form onSubmit={event => void searchTools(event)}><Search size={14} /><input value={toolQuery} onChange={event => setToolQuery(event.target.value)} placeholder="按需搜索本会话的工具参数与输出" aria-label="搜索工具内容" /><button type="submit" disabled={searching || !toolQuery.trim()}>{searching ? '搜索中…' : '搜索'}</button><button type="button" className="icon-button" aria-label="关闭工具搜索" onClick={() => setShowToolSearch(false)}><X size={14} /></button></form>{searchError && <p className="inline-error">{searchError}</p>}{matches && <div className="tool-search-results">{matches.length === 0 ? <p>没有匹配的工具内容</p> : matches.map((match, index) => <button key={`${match.eventId}-${index}`} onClick={() => onTargetTurn(match.turnId)}><span>第 {(session.turns.find(turn => turn.id === match.turnId)?.index ?? 0) + 1} 轮</span><p>{match.text}</p><ArrowUpRight size={12} /></button>)}</div>}</div>}
    <div className="timeline-viewport">
      {session.turns.length === 0 ? <div className="timeline-empty"><Layers3 size={24} /><p>会话已载入，还没有可展示的轮次。</p></div> : <Virtuoso ref={virtuoso} className="turn-virtuoso" data={session.turns} computeItemKey={(_, turn) => turn.id} increaseViewportBy={600} followOutput={bottom => bottom ? 'smooth' : false} atBottomThreshold={100} atBottomStateChange={value => { atBottom.current = value; if (value) setNewContent(false); }} itemContent={(_, turn) => <TurnCard turn={turn} sessionId={value.id} revision={`${value.revision}:${reloadVersion}`} targetTurn={targetTurn} onInspect={onInspect} />} />}
      {newContent && <button className="new-content-button" onClick={() => { virtuoso.current?.scrollToIndex({ index: session.turns.length - 1, align: 'end', behavior: 'smooth' }); setNewContent(false); }}><ArrowDown size={14} />有新内容，跳到最新</button>}
    </div>
  </div>;
}
