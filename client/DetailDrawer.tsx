import { useEffect, useId, useRef, useState } from 'react';
import { X, ArrowUpRight, ChevronDown, ChevronUp, Code2, Hash, Layers3 } from 'lucide-react';
import type { RequestUsage, SessionActivity, SessionDetail, TurnDetail } from '../shared/types';
import { api, errorMessage, isAbort, sessionPath } from './api';
import { UsageBlock } from './Stats';
import { clock, exactTokens } from './format';
import type { Inspection } from './TurnCard';
import { RequestContext } from './RequestContext';
import { RequestComparison } from './RequestComparison';
import { useOverlayFocus } from './useOverlayFocus';
import { latestRecordedRequest } from './latest-request';
import { ToolContent } from './ToolContent';
import { toolPresentation } from './tool-presentation';

function RequestCard({ request, index, sessionId, revision, onNavigateTurn, selected }: { request: RequestUsage; index: number; sessionId: string; revision: string; onNavigateTurn: (turnId: string) => void; selected: boolean }) {
  const [open, setOpen] = useState(selected);
  useEffect(() => {
    if (selected) setOpen(true);
  }, [selected]);
  return <details data-request-id={request.id} className={`request-card mt-[10px] rounded-[6px] border bg-(--panel) px-[12px] ${selected ? 'selected-request border-(--accent)' : 'border-(--border)'}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={`flex min-h-[40px] cursor-pointer list-none items-center justify-between gap-[12px] py-[10px] text-[12px] text-(--soft) outline-offset-4 [&::-webkit-details-marker]:hidden max-[560px]:min-h-[44px] ${selected ? 'bg-(--accent-light)' : 'hover:bg-(--hover)'}`}>
      <span className="flex min-w-0 items-center gap-[4px]"><Hash size={12} aria-hidden="true" />{index + 1}<time className="ml-[6px] font-sans text-[12px] text-(--muted)">{clock(request.timestamp)}</time></span>
      <strong className="flex shrink-0 items-center gap-[4px] font-mono text-[12px] font-normal text-(--soft) tabular-nums">{exactTokens(request.usage.totalTokens)}<ArrowUpRight size={12} aria-hidden="true" /></strong>
    </summary>
    {open && <>
      <dl className="usage-facts mt-[4px] mb-[14px] space-y-[10px] text-[12px] leading-[1.6]">
        {[
          ['输入', exactTokens(request.usage.inputTokens)],
          ['缓存读取', exactTokens(request.usage.cachedInputTokens)],
          ['缓存写入', exactTokens(request.usage.cacheWriteInputTokens)],
          ['输出', exactTokens(request.usage.outputTokens)],
          ['推理输出（已含在输出中）', exactTokens(request.usage.reasoningOutputTokens)],
          ['记录来源', request.source === 'record' ? '原始调用记录' : '累计快照差值'],
        ].map(([label, value]) => <div key={label} className="flex items-baseline justify-between gap-[12px]">
          <dt className="min-w-0 text-(--muted)">{label}</dt>
          <dd className="m-0 shrink-0 font-mono text-(--soft) tabular-nums">{value}</dd>
        </div>)}
      </dl>
      <RequestComparison sessionId={sessionId} request={request} revision={revision} onNavigateTurn={onNavigateTurn} />
      <RequestContext sessionId={sessionId} request={request} revision={revision} onNavigateTurn={onNavigateTurn} />
    </>}
  </details>;
}

export function DetailDrawer({ session, selection, onClose, onNavigateTurn }: { session: SessionDetail; selection: Inspection; onClose: () => void; onNavigateTurn: (turnId: string) => void }) {
  const [turn, setTurn] = useState<TurnDetail | null>(null);
  const [error, setError] = useState('');
  const [latest, setLatest] = useState<{ key: string; request: RequestUsage | null; failed?: boolean } | null>(null);
  const [modal, setModal] = useState(() => window.matchMedia('(max-width: 1200px)').matches);
  const [showToolStatistics, setShowToolStatistics] = useState(false);
  const titleId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionUsageRef = useRef<HTMLDivElement>(null);
  const turnUsageRef = useRef<HTMLDivElement>(null);
  const requestListRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const loadedSelection = useRef('');
  const latestMode = selection.focus === 'latest';
  const toolMode = Boolean(selection.toolId);
  const searchNavigation = selection.searchNavigation;
  const searchStale = Boolean(searchNavigation && searchNavigation.revision !== session.session.revision);
  const drawerModal = toolMode || modal;
  const latestKey = `${session.session.id}\u0000${session.session.revision}\u0000${session.session.usage.latestInputTokens ?? 'unknown'}`;
  const latestLoading = latestMode && latest?.key !== latestKey;
  const latestRequest = latestMode && latest?.key === latestKey ? latest.request : null;
  const targetTurnId = latestMode ? latestRequest?.turnId : selection.turnId;
  useOverlayFocus({ container: drawerRef, initialFocus: closeRef, modal: drawerModal, onClose });
  useEffect(() => { setShowToolStatistics(false); }, [selection.toolId, selection.navigationId]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1200px)');
    const update = () => setModal(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!latestMode) return;
    if (session.session.usage.latestInputTokens == null) {
      setLatest({ key: latestKey, request: null });
      return;
    }
    const controller = new AbortController();
    api<SessionActivity>(`${sessionPath(session.session.id)}/activity`, { signal: controller.signal }).then(activity => {
      if (controller.signal.aborted) return;
      const candidate = latestRecordedRequest(activity.requests, session.session.usage.latestInputTokens);
      const request = candidate && session.turns.some(item => item.id === candidate.turnId) ? candidate : null;
      setLatest({ key: latestKey, request });
    }).catch(cause => {
      if (!controller.signal.aborted && !isAbort(cause)) setLatest({ key: latestKey, request: null, failed: true });
    });
    return () => controller.abort();
  }, [latestMode, latestKey, session.session.id]);
  useEffect(() => {
    const key = `${session.session.id}\u0000${targetTurnId ?? ''}`;
    if (loadedSelection.current !== key) setTurn(null);
    loadedSelection.current = key;
    setError('');
    if (!targetTurnId) return;
    const controller = new AbortController();
    api<TurnDetail>(`${sessionPath(session.session.id)}/turns/${encodeURIComponent(targetTurnId)}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setTurn(result); }).catch(cause => { if (!isAbort(cause)) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [session.session.id, session.session.revision, targetTurnId]);
  const activeTurn = turn?.summary.id === targetTurnId ? turn : null;
  const exactLatestRequest = latestRequest && activeTurn?.requests.find(request => request.id === latestRequest.id && request.source === 'record' && request.usage.inputTokens === session.session.usage.latestInputTokens);
  const latestFallback = latestMode && !latestLoading && (!latestRequest || Boolean(activeTurn && !exactLatestRequest) || Boolean(error));
  const displayedTurn = latestMode && !exactLatestRequest ? null : activeTurn;
  const selectedRequestId = latestMode ? exactLatestRequest?.id : selection.requestId;
  useEffect(() => {
    if (latestLoading || targetTurnId && !activeTurn && !latestFallback) return;
    const frame = requestAnimationFrame(() => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      let anchor: HTMLElement | null = displayedTurn ? turnUsageRef.current : sessionUsageRef.current;
      let target: HTMLElement | null = null;
      if (selection.toolId) anchor = scroll.querySelector<HTMLElement>('.tool-detail') ?? anchor;
      if (selectedRequestId) {
        const card = Array.from(scroll.querySelectorAll<HTMLElement>('[data-request-id]')).find(item => item.dataset.requestId === selectedRequestId);
        target = card?.querySelector<HTMLElement>('summary') ?? null;
        anchor = card ?? anchor;
      } else if (selection.focus === 'requests') {
        anchor = requestListRef.current ?? anchor;
        target = anchor?.querySelector<HTMLElement>('.request-list-heading') ?? null;
      } else if (selection.focus === 'cache') {
        target = anchor?.querySelector<HTMLElement>('.cache-caption') ?? null;
      } else if (selection.focus === 'total') {
        target = anchor?.querySelector<HTMLElement>('.usage-total') ?? null;
      } else if (latestFallback) {
        target = Array.from(anchor?.querySelectorAll<HTMLElement>('.usage-facts > div') ?? []).find(row => row.querySelector('dt')?.textContent === '最近一次输入') ?? null;
      }
      if (!anchor) return;
      const offset = selectedRequestId ? (requestListRef.current?.querySelector<HTMLElement>('.request-list-heading')?.offsetHeight ?? 0) + 12 : 0;
      const top = scroll.scrollTop + anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - offset;
      scroll.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
      if (target) {
        if (target.tabIndex < 0) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [selection, activeTurn?.summary.id, displayedTurn?.summary.id, selectedRequestId, latestLoading, latestFallback, targetTurnId]);
  const tool = displayedTurn?.events.find(event => event.tool?.id === selection.toolId)?.tool;
  const presentation = tool ? toolPresentation(tool) : null;
  function toggleToolStatistics(show: boolean) { setShowToolStatistics(show); requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' })); }
  function searchKeyboard(event: React.KeyboardEvent<HTMLElement>) {
    if (!searchNavigation || searchStale || event.defaultPrevented || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    const enter = event.key === 'Enter' && !event.altKey && !target.closest('button,a,input,textarea,select,summary,[role="button"],[contenteditable="true"]');
    const direction = event.altKey && event.key === 'ArrowUp' || enter && event.shiftKey ? -1
      : event.altKey && event.key === 'ArrowDown' || enter && !event.altKey ? 1 : 0;
    if (!direction) return;
    event.preventDefault(); event.stopPropagation();
    const index = searchNavigation.index + direction;
    if (index >= 0 && index < searchNavigation.total) searchNavigation.onNavigate(index);
  }
  return <>
    <button className={`drawer-backdrop border-0 ${drawerModal ? 'fixed inset-0 z-[30] block bg-[#102318]/25' : 'hidden'}`} aria-label="关闭详情" tabIndex={-1} aria-hidden="true" onClick={onClose} />
    <aside ref={drawerRef} className={`detail-drawer z-[31] flex min-w-0 flex-col border-l border-(--border) bg-(--panel) text-(--text) ${toolMode && !showToolStatistics ? 'tool-reader-content-mode' : ''} ${toolMode ? 'tool-reader-drawer fixed inset-y-0 right-0 w-[800px] max-w-[calc(100vw-24px)] shadow-[-12px_0_40px_#14251a17] max-[600px]:w-full max-[600px]:max-w-none max-[600px]:border-l-0' : modal ? 'fixed inset-y-0 right-0 w-[360px] max-w-[calc(100vw-24px)] shadow-[-12px_0_40px_#14251a17] max-[560px]:w-full max-[560px]:max-w-none max-[560px]:border-l-0' : 'relative w-[354px] shrink-0'}`} role={drawerModal ? 'dialog' : undefined} aria-modal={drawerModal || undefined} aria-labelledby={titleId} tabIndex={-1} onKeyDown={searchKeyboard}>
      <div className="drawer-heading flex h-[76px] min-h-[76px] shrink-0 items-center justify-between gap-[16px] border-b border-(--border) px-[24px] max-[560px]:h-[68px] max-[560px]:min-h-[68px] max-[560px]:px-[20px]">
        <h2 id={titleId} className="m-0 min-w-0 text-[18px] leading-[1.4] font-semibold">{selection.toolId ? showToolStatistics ? '调用所属轮次统计' : '调用详情' : latestMode ? exactLatestRequest ? '最近一次调用' : '最近输入摘要' : selection.turnId ? '轮次统计' : '会话统计'}</h2>
        <button ref={closeRef} className="icon-button inline-flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-[6px] border-0 bg-transparent text-(--muted) hover:bg-(--hover) hover:text-(--text) max-[560px]:h-[44px] max-[560px]:w-[44px]" onClick={onClose} title="关闭详情 (Esc)" aria-label="关闭详情"><X size={18} /></button>
      </div>
      {toolMode && searchNavigation && <div className="tool-search-drawer-navigation">
        <span role="status" aria-atomic="true">{searchStale ? '会话已更新，请关闭详情后重新搜索。' : `搜索结果 ${searchNavigation.index + 1} / ${searchNavigation.total}${searchNavigation.truncated ? '+' : ''}`}</span>
        <div className="tool-search-navigation" role="group" aria-label="工具搜索结果导航">
          <button type="button" disabled={searchStale || searchNavigation.index === 0} onClick={() => searchNavigation.onNavigate(searchNavigation.index - 1)} title="上一条 (Alt+↑)" aria-label="上一条工具搜索结果"><ChevronUp size={15} />上一条</button>
          <button type="button" disabled={searchStale || searchNavigation.index + 1 >= searchNavigation.total} onClick={() => searchNavigation.onNavigate(searchNavigation.index + 1)} title="下一条 (Alt+↓)" aria-label="下一条工具搜索结果">下一条<ChevronDown size={15} /></button>
        </div>
      </div>}
      <div ref={scrollRef} className="drawer-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]">
        {error && <div className="inline-error m-[20px] rounded-[6px] border border-(--danger)/25 bg-(--bg) p-[12px] text-[12px] leading-[1.8] text-(--danger) [overflow-wrap:anywhere]" role="alert">{error}</div>}
        {(latestLoading || targetTurnId && !activeTurn && !error) && <div className="turn-loading flex items-center gap-[8px] px-[24px] py-[16px] text-[12px] leading-[1.8] text-(--muted)" role="status">{latestMode ? '正在定位最近输入记录…' : '正在读取明细…'}</div>}
        {toolMode && !showToolStatistics && tool && presentation && <section className="tool-detail">
          <div className="tool-reader-heading">
            <div className="tool-reader-title"><Code2 size={16} /><span>{presentation.title}</span><span className={`tool-call-state ${tool.status}`}>{tool.status === 'failed' ? `失败${tool.exitCode != null ? ` · 退出码 ${tool.exitCode}` : ''}` : tool.status === 'running' ? '运行中' : tool.status === 'unknown' ? '结果未记录' : tool.exitCode === 0 ? '完成' : '已返回'}</span></div>
            {presentation.subtitle && <p className="tool-reader-subtitle">{presentation.subtitle}</p>}
            <p className="tool-reader-subtitle">调用 ID <code>{tool.id}</code></p>
            <div className="tool-reader-context"><span>第 {(displayedTurn?.summary.index ?? 0) + 1} 轮 · 此工具没有独立 token 用量</span><button type="button" onClick={() => toggleToolStatistics(true)}>查看所属轮次统计</button></div>
          </div>
          <ToolContent key={`${tool.id}:${selection.navigationId ?? ''}`} tool={tool} sessionId={session.session.id} revision={session.session.revision} search={selection.search} navigationId={selection.navigationId} mode="detail" />
        </section>}
        {toolMode && !showToolStatistics && activeTurn && !tool && <p className="tool-reader-empty">日志已变化，未找到这次工具调用。请关闭详情后重新定位。</p>}
        {toolMode && showToolStatistics && <button type="button" className="tool-reader-back" onClick={() => toggleToolStatistics(false)}>返回工具详情</button>}
        {(!toolMode || showToolStatistics) && <>
        {displayedTurn && <>
          <div ref={turnUsageRef} className="min-w-0"><UsageBlock usage={displayedTurn.summary.usage} label={`第 ${displayedTurn.summary.index + 1} 轮用量`} /></div>
          <section ref={requestListRef} className="request-list border-b border-(--border) px-[24px] pt-[16px] pb-[24px] max-[560px]:px-[20px]">
            <div className="detail-section-heading request-list-heading sticky top-0 z-[1] flex items-center justify-between gap-[8px] bg-(--panel) pt-[8px] pb-[12px] text-[14px] font-medium text-(--soft)" tabIndex={-1}>
              <span>逐次模型调用</span><span className="subtle-badge shrink-0 rounded-[4px] border border-(--border) bg-(--bg) px-[6px] py-[3px] text-[12px] font-normal whitespace-nowrap text-(--muted)">{displayedTurn.requests.length} 条记录</span>
            </div>
            {displayedTurn.requests.length === 0 && <p className="detail-note mt-[12px] mb-0 text-[12px] leading-[1.8] text-(--muted)">此轮日志没有逐次用量记录。</p>}
            {displayedTurn.requests.map((request, index) => <RequestCard key={request.id} request={request} index={index} sessionId={session.session.id} revision={session.session.revision} selected={selectedRequestId === request.id} onNavigateTurn={turnId => { onClose(); onNavigateTurn(turnId); }} />)}
          </section>
        </>}
        <div ref={sessionUsageRef} className="min-w-0" data-selected-metric={!displayedTurn ? selection.focus : undefined}>
          {latestFallback && <p className="timeline-notice mx-[24px] my-[16px] rounded-[4px] border-l-2 border-(--warning) bg-(--bg) p-[12px] text-[12px] leading-[1.8] text-(--warning) [overflow-wrap:anywhere] max-[560px]:mx-[20px]" role="status">{latest?.failed ? '暂时无法读取调用记录。' : '日志没有提供可可靠关联的末次原始调用记录。'}当前展示会话摘要中的最近输入，不能定位对应单次调用。</p>}
          <UsageBlock usage={session.session.usage} label="整个会话用量" />
        </div>
        <section className="session-properties p-[24px] max-[560px]:p-[20px]">
          <div className="detail-section-heading flex items-center gap-[8px] text-[14px] font-medium text-(--soft)"><Layers3 size={14} /><span>会话信息</span></div>
          <dl className="properties mt-[20px] mb-0 text-[12px] leading-[1.8]">
            {[
              ['会话 ID', session.session.id],
              ['来源', session.session.source || '未记录'],
              ['日志文件', session.session.filePath],
              ['解析异常', `${session.session.parseErrors} 行`],
            ].map(([label, value]) => <div key={label} className="mt-[14px]">
              <dt className="text-(--muted)">{label}</dt><dd className="mt-[4px] ml-0 font-mono text-(--soft) [overflow-wrap:anywhere]">{value}</dd>
            </div>)}
          </dl>
        </section>
        </>}
      </div>
    </aside>
  </>;
}
