import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, ArrowDown, ArrowUpRight, Circle, Copy, Check, Minimize2 } from 'lucide-react';
import type { SessionDetail, TimelineEvent, TurnDetail, TurnSummary } from '../shared/types';
import { api, errorMessage, isAbort, sessionPath } from './api';
import { Markdown } from './Markdown';
import { CollaborationCard } from './CollaborationCard';
import { clock, statusLabels, tokens } from './format';
import { turnPresentation } from './presentation';
import { turnDetailCache } from './turn-detail-cache';
import { groupAdjacentTools } from './tool-groups';
import { ToolGroup } from './ToolGroup';
import { UserPrompt } from './UserPrompt';
import type { CompactionNavigationTarget, ToolNavigationTarget } from './tool-navigation';
import { eventViewState } from './event-view-state';
import { groupAdjacentContexts } from './event-presentation';
import { ContextEvents, EventRecord, FinalAnswer } from './TimelineEvents';
import { buildTimelineCollaboration } from './collaboration-participants';
import { groupReadingProcess, latestReadingCommentary, readingProcessHasTool, readingProcessStateKey, readingProcessSummary, readingProcessToolStates, type ReadingProcessGroup, type ReadingTimelineEntry } from './reading-mode';
import './reading-mode.css';

function ReadingProcess({ group, sessionId, turnId, target, preserveLayout, latestCommentary, showActivity, renderEntry, readingMode }: {
  group: ReadingProcessGroup; sessionId: string; turnId: string; target?: ToolNavigationTarget;
  preserveLayout?: (change: () => void) => void; latestCommentary?: TimelineEvent; showActivity: boolean;
  renderEntry: (entry: ReadingTimelineEntry) => ReactNode;
  readingMode: boolean;
}) {
  const stateKey = readingProcessStateKey(turnId, group.id);
  const [storedOpen, setStoredOpen] = useState(() => eventViewState.get(sessionId, stateKey) ?? false);
  const bodyId = useId();
  const toolStates = readingProcessToolStates(group);
  const revealed = useRef<number | null>(null);
  const revealTarget = readingMode && target?.reveal && readingProcessHasTool(group, target.toolId) && revealed.current !== target.version;
  const open = storedOpen || revealTarget;
  useEffect(() => {
    if (!revealTarget || !target) return;
    revealed.current = target.version;
    eventViewState.set(sessionId, stateKey, true);
    setStoredOpen(true);
  }, [revealTarget, target?.version, sessionId, stateKey]);
  function toggle() {
    const change = () => { eventViewState.set(sessionId, stateKey, !open); setStoredOpen(!open); };
    if (preserveLayout) preserveLayout(change); else change();
  }
  if (!readingMode) return <section className="reading-process-full" data-process-id={stateKey}>{group.entries.map(renderEntry)}</section>;
  return <section className="reading-process" data-reading-process-id={group.id} data-process-id={stateKey}>
    <button type="button" className="reading-process-toggle" aria-expanded={!!open} aria-controls={bodyId} onClick={toggle}>
      {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      <span className="reading-process-title">执行过程</span><span className="reading-process-summary">{readingProcessSummary(group)}</span>
      {(toolStates.failed > 0 || toolStates.running > 0 || toolStates.unknown > 0) && <span className="reading-process-states">{toolStates.failed > 0 && <span className="reading-process-failed">{toolStates.failed} 失败</span>}{toolStates.running > 0 && <span className="reading-process-running">{toolStates.running} 运行中</span>}{toolStates.unknown > 0 && <span className="reading-process-unknown">{toolStates.unknown} 结果未记录</span>}</span>}
    </button>
    <div id={bodyId} className="reading-process-body" hidden={!open}>{open && group.entries.map(renderEntry)}</div>
    {!open && (latestCommentary || showActivity) && <div className="reading-process-latest">{latestCommentary ? renderEntry(latestCommentary) : <p className="reading-process-activity" role="status"><span className="pulse" />正在执行，展开查看最新过程…</p>}</div>}
  </section>;
}

export function TurnCard({ turn, sessionId, session, revision, onUsage, targetTurn, onReady, toolTarget, compactionTarget, preserveLayout, onSearchReady, readingMode = false, onNavigateFinalAnswer }: {
  turn: TurnSummary; sessionId: string; revision: string; onUsage: (turnId: string) => void; targetTurn: string | null; onReady?: (turnId: string) => void;
  session?: SessionDetail;
  toolTarget?: ToolNavigationTarget | null; preserveLayout?: (change: () => void) => void; onSearchReady?: (version: number) => void;
  compactionTarget?: CompactionNavigationTarget | null;
  readingMode?: boolean; onNavigateFinalAnswer?: (eventId: string) => void;
}) {
  const [cached] = useState(() => turnDetailCache.get(sessionId, turn.id));
  const [detail, setDetail] = useState<TurnDetail | null>(cached?.data ?? null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  const [settledRequest, setSettledRequest] = useState(() => cached?.revision === revision ? `${sessionId}:${turn.id}:${revision}:0` : '');
  const requestKey = `${sessionId}:${turn.id}:${revision}:${retry}`;
  const ready = settledRequest === requestKey;
  const activeTarget = toolTarget?.turnId === turn.id ? toolTarget : undefined;
  const activeCompaction = compactionTarget?.turnId === turn.id ? compactionTarget : undefined;
  const [searchReadyVersion, setSearchReadyVersion] = useState<number | null>(null);
  const targetMissing = ready && activeTarget && detail && !detail.events.some(event => event.tool?.id === activeTarget.toolId);
  const compactionMissing = ready && activeCompaction && detail && !detail.events.some(event => event.id === activeCompaction.eventId);
  const layoutReady = ready && (!activeTarget?.reveal || searchReadyVersion === activeTarget.version || targetMissing);
  const toolReady = useCallback(() => {
    if (activeTarget) { setSearchReadyVersion(activeTarget.version); onSearchReady?.(activeTarget.version); }
  }, [activeTarget?.version, onSearchReady]);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    const previous = turnDetailCache.get(sessionId, turn.id);
    if (previous) setDetail(previous.data);
    if (previous?.revision === revision && retry === 0) { setSettledRequest(requestKey); return () => controller.abort(); }
    api<TurnDetail>(`${sessionPath(sessionId)}/turns/${encodeURIComponent(turn.id)}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { turnDetailCache.put(sessionId, turn.id, revision, result); setDetail(result); setError(''); setSettledRequest(requestKey); } }).catch(cause => { if (!controller.signal.aborted && !isAbort(cause)) { setError(errorMessage(cause)); setSettledRequest(requestKey); } });
    return () => controller.abort();
  }, [sessionId, turn.id, revision, retry]);
  useEffect(() => { if (layoutReady) onReady?.(turn.id); }, [layoutReady, onReady, turn.id]);
  useEffect(() => { if (targetMissing && activeTarget) onSearchReady?.(activeTarget.version); }, [targetMissing, activeTarget?.version, onSearchReady]);

  async function copyLink() {
    const url = new URL(window.location.href); url.searchParams.set('session', sessionId); url.searchParams.set('turn', turn.id);
    try { await navigator.clipboard.writeText(url.toString()); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* Browser clipboard permissions may be unavailable. */ }
  }
  const collaboration = useMemo(() => session && detail ? buildTimelineCollaboration(detail.events, session, turn.id) : undefined, [detail?.events, session, turn.id]);
  function renderEvent(event: TimelineEvent) {
    if (event.kind === 'collaboration' && event.collaboration) return <CollaborationCard key={event.id} event={event} sessionId={sessionId} turnId={turn.id} revision={revision} record={collaboration?.records.get(event.id)} labels={collaboration?.labels} />;
    if (event.kind === 'user') return <div key={event.id}><span className="event-phase mb-1 block text-xs text-[var(--muted)]">补充消息 · {clock(event.timestamp)}</span><UserPrompt text={event.text} sessionId={sessionId} stateKey={`prompt:${turn.id}:${event.id}`} preserveLayout={preserveLayout} /></div>;
    if (event.kind === 'reasoning' || event.kind === 'unknown') return <EventRecord key={event.id} sessionId={sessionId} event={event} />;
    if (event.kind === 'notice' && event.noticeType === 'compaction') return <div className="timeline-notice compaction-record" key={event.id} data-compaction-event-id={event.id}><Minimize2 size={14} /><span>{event.text}</span><time dateTime={event.timestamp}>{clock(event.timestamp)}</time></div>;
    if (event.kind === 'notice') return <div className="timeline-notice" key={event.id}><AlertTriangle size={14} /><span>{event.text}</span></div>;
    if (event.kind === 'assistant') return <FinalAnswer key={event.id} event={event} />;
    return <div className={`assistant-event mb-4 text-sm leading-[1.9] [overflow-wrap:anywhere] ${event.kind === 'commentary' ? 'commentary border-l-2 border-[var(--border)] pl-3 text-[var(--soft)]' : 'text-[var(--text)]'}`} key={event.id}><Markdown text={event.text} /></div>;
  }
  const presentation = turnPresentation(turn.prompt, detail?.events);
  const timeline = useMemo(() => groupAdjacentContexts(groupAdjacentTools(presentation.timeline)), [detail?.events, turn.prompt]);
  const readingTimeline = useMemo(() => groupReadingProcess(timeline), [timeline]);
  const latestCommentary = turn.status === 'running' ? latestReadingCommentary(readingTimeline) : undefined;
  const lastProcess = readingTimeline.findLast(entry => entry.kind === 'reading-process');
  const finalAnswer = detail?.events.findLast(event => event.kind === 'assistant');
  function renderEntry(entry: ReadingTimelineEntry) {
    return entry.kind === 'tool-group'
      ? <ToolGroup key={`group-${entry.id}`} group={entry} turnId={turn.id} sessionId={sessionId} revision={revision} target={activeTarget} preserveLayout={preserveLayout} onSearchReady={toolReady} />
      : entry.kind === 'context-group' ? <ContextEvents key={`context-${entry.id}`} sessionId={sessionId} group={entry} preserveLayout={preserveLayout} />
      : entry.kind === 'tool' && entry.tool ? renderEvent(entry) : <div key={entry.id} data-event-id={entry.id} className={activeCompaction?.eventId === entry.id ? 'timeline-compaction-target' : undefined}>{renderEvent(entry)}</div>;
  }
  const prompt = presentation.prompt || '此轮没有用户文本';
  const model = turn.model?.trim();
  const previousModel = session?.turns.findLast(candidate => candidate.index < turn.index)?.model?.trim();
  const showModel = !model || !previousModel || model !== previousModel;
  return <article className={`turn-card w-full px-[var(--canvas-pad)] pt-6 max-[600px]:pt-5 ${targetTurn === turn.id ? 'target-turn' : ''}`} data-turn-id={turn.id} data-turn-ready={layoutReady ? 'true' : 'false'}>
    <div className="turn-heading flex items-center gap-2.5"><div className="turn-order grid size-6 shrink-0 place-items-center rounded-md border border-[var(--border)] bg-[var(--panel)] font-mono text-xs text-[var(--muted)]">{String(turn.index + 1).padStart(2, '0')}</div><div className="turn-heading-meta flex items-center gap-3 text-xs text-[var(--soft)] [&>time]:font-mono [&>time]:text-[var(--muted)]"><span>用户请求</span><time>{clock(turn.startedAt)}</time></div><button className="turn-link ml-auto grid size-9 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] max-[600px]:size-11" title="复制此轮链接" aria-label="复制此轮链接" onClick={() => void copyLink()}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></div>
    <UserPrompt text={prompt} sessionId={sessionId} stateKey={`prompt:${turn.id}`} anchorId={`user-prompt:${turn.id}`} indented preserveLayout={preserveLayout} />
    <div className="assistant-heading mb-4 flex items-center gap-2 [&>strong]:text-[13px] [&>strong]:font-semibold [&>.status-label]:ml-auto"><span className="agent-symbol grid size-6 shrink-0 place-items-center rounded-md border border-[var(--accent)] bg-[var(--accent-light)] font-mono text-[13px] font-semibold text-[var(--accent-strong)]">C</span><strong title={model ? `模型：${model}` : '模型未记录'}>Codex</strong><span className={showModel ? 'model-label max-w-[40%] truncate text-xs text-[var(--muted)]' : 'sr-only'}><span className="sr-only">模型：</span>{model || '模型未记录'}</span><span className={`status-label ${turn.status}`}><Circle size={6} fill="currentColor" />{statusLabels[turn.status]}</span>{finalAnswer && onNavigateFinalAnswer && <button type="button" className="turn-final-jump" onClick={() => onNavigateFinalAnswer(finalAnswer.id)}><ArrowDown size={13} aria-hidden="true" />跳到最终答复</button>}</div>
    <div className="turn-content min-h-5 min-[601px]:pl-[33px]">{error && <div className="inline-error" role="alert">{error}<button className="text-button" onClick={() => setRetry(value => value + 1)}>重试</button></div>}{!detail && !error && <div className="turn-loading"><span className="pulse" />正在读取这一轮…</div>}{detail?.warnings.map((warning, index) => <div className="timeline-notice" key={index}><AlertTriangle size={13} />{warning}</div>)}{targetMissing && <div className="timeline-notice" role="status">目标调用已不在当前日志中，请重新搜索。</div>}{compactionMissing && <div className="timeline-notice" role="status">目标压缩记录已不在当前日志中，请刷新压缩列表。</div>}{readingTimeline.map(entry => entry.kind === 'reading-process'
      ? <ReadingProcess key={`process-${entry.id}`} group={entry} sessionId={sessionId} turnId={turn.id} target={activeTarget} preserveLayout={preserveLayout} latestCommentary={latestCommentary?.groupId === entry.id ? latestCommentary.event : undefined} showActivity={turn.status === 'running' && !latestCommentary && lastProcess?.id === entry.id} renderEntry={renderEntry} readingMode={readingMode} />
      : renderEntry(entry))}{readingMode && detail && turn.status === 'running' && !lastProcess && <p className="reading-process-activity turn-reading-activity" role="status"><span className="pulse" />正在等待新的执行记录…</p>}</div>
    <div className="turn-footer mt-5 flex flex-wrap items-center gap-2 border-b border-[var(--border)] pb-6 text-xs text-[var(--muted)] min-[601px]:pl-[33px] [&>button]:ml-auto [&>button]:inline-flex [&>button]:min-h-9 [&>button]:items-center [&>button]:gap-1 [&>button]:text-[var(--soft)] [&>button]:hover:text-[var(--accent)] max-[600px]:[&>button]:min-h-11"><span>{turn.toolCount} 次工具调用</span><span className="separator text-[var(--border)]">·</span><span>{tokens(turn.usage.tokens?.totalTokens)} tokens</span><span className="separator text-[var(--border)]">·</span><span>{turn.usage.completeness === 'partial' ? '至少 ' : ''}{turn.usage.requestCount} 次模型调用</span><button onClick={() => onUsage(turn.id)}>查看本轮用量<ArrowUpRight size={13} /></button></div>
  </article>;
}
