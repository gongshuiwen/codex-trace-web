import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, ArrowUpRight, Circle, Copy, Check } from 'lucide-react';
import type { TimelineEvent, TurnDetail, TurnSummary } from '../shared/types';
import { api, errorMessage, isAbort, sessionPath } from './api';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';
import { CollaborationCard } from './CollaborationCard';
import { clock, statusLabels, tokens } from './format';
import { turnPresentation } from './presentation';
import { turnDetailCache } from './turn-detail-cache';
import { groupAdjacentContexts } from './event-presentation';
import { ContextEvents } from './TimelineEvents';

export interface Inspection { turnId?: string; toolId?: string; requestId?: string; focus?: 'total' | 'requests' | 'cache' | 'latest' }

function EventDisclosure({ event }: { event: TimelineEvent }) {
  const [open, setOpen] = useState(false);
  return <details className="context-event" onToggle={event => setOpen(event.currentTarget.open)}><summary><ChevronRight size={13} />{event.kind === 'context' ? '附带上下文' : event.kind === 'reasoning' ? '日志中的推理摘要' : '其他日志事件'}<small>{event.text.length.toLocaleString()} 字符</small></summary>{open && <pre>{event.text || '此事件没有可显示的文本'}</pre>}</details>;
}

export function TurnCard({ turn, sessionId, revision, onInspect, targetTurn, onReady }: { turn: TurnSummary; sessionId: string; revision: string; onInspect: (selection: Inspection) => void; targetTurn: string | null; onReady?: (turnId: string) => void }) {
  const [cached] = useState(() => turnDetailCache.get(sessionId, turn.id));
  const [detail, setDetail] = useState<TurnDetail | null>(cached?.data ?? null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [settledRequest, setSettledRequest] = useState(() => cached?.revision === revision ? `${sessionId}:${turn.id}:${revision}:0` : '');
  const requestKey = `${sessionId}:${turn.id}:${revision}:${retry}`;
  const ready = settledRequest === requestKey;
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    const previous = turnDetailCache.get(sessionId, turn.id);
    if (previous) setDetail(previous.data);
    if (previous?.revision === revision && retry === 0) { setSettledRequest(requestKey); return () => controller.abort(); }
    api<TurnDetail>(`${sessionPath(sessionId)}/turns/${encodeURIComponent(turn.id)}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { turnDetailCache.put(sessionId, turn.id, revision, result); setDetail(result); setError(''); setSettledRequest(requestKey); } }).catch(cause => { if (!controller.signal.aborted && !isAbort(cause)) { setError(errorMessage(cause)); setSettledRequest(requestKey); } });
    return () => controller.abort();
  }, [sessionId, turn.id, revision, retry]);
  useEffect(() => { if (ready) onReady?.(turn.id); }, [ready, onReady, turn.id]);

  async function copyLink() {
    const url = new URL(window.location.href); url.searchParams.set('session', sessionId); url.searchParams.set('turn', turn.id);
    try { await navigator.clipboard.writeText(url.toString()); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* Browser clipboard permissions may be unavailable. */ }
  }
  function renderEvent(event: TimelineEvent) {
    if (event.kind === 'collaboration' && event.collaboration) return <CollaborationCard key={event.id} event={event} />;
    if (event.kind === 'user') return <div key={event.id}><span className="event-phase mb-1 block text-xs text-[var(--muted)]">补充消息 · {clock(event.timestamp)}</span><div className="user-prompt my-3 mb-6 max-h-[480px] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-3.5 text-sm leading-[1.85] whitespace-pre-wrap [overflow-wrap:anywhere] [&>p]:m-0 min-[601px]:ml-[33px] max-[600px]:mb-5" style={{ marginLeft: 0 }}><p>{event.text || '空消息'}</p></div></div>;
    if (event.kind === 'tool' && event.tool) return <ToolCard key={event.id} tool={event.tool} sessionId={sessionId} onInspect={() => onInspect({ turnId: turn.id, toolId: event.tool!.id })} />;
    if (event.kind === 'context' || event.kind === 'reasoning' || event.kind === 'unknown') return <EventDisclosure key={event.id} event={event} />;
    if (event.kind === 'notice') return <div className="timeline-notice" key={event.id}><AlertTriangle size={14} /><span>{event.text}</span></div>;
    return <div className={`assistant-event mb-4 text-sm leading-[1.9] [overflow-wrap:anywhere] ${event.kind === 'commentary' ? 'commentary border-l-2 border-[var(--border)] pl-3 text-[var(--soft)]' : 'text-[var(--text)]'}`} key={event.id}>{event.kind === 'commentary' && <span className="event-phase mb-1 block text-xs text-[var(--muted)]">过程说明</span>}<Markdown text={event.text} /></div>;
  }
  const presentation = turnPresentation(turn.prompt, detail?.events);
  const prompt = presentation.prompt || '此轮没有用户文本';
  return <article className={`turn-card w-full px-[var(--canvas-pad)] pt-6 max-[600px]:pt-5 ${targetTurn === turn.id ? 'target-turn' : ''}`} data-turn-id={turn.id} data-turn-ready={ready ? 'true' : 'false'}>
    <div className="turn-heading flex items-center gap-2.5"><div className="turn-order grid size-6 shrink-0 place-items-center rounded-md border border-[var(--border)] bg-[var(--panel)] font-mono text-xs text-[var(--muted)]">{String(turn.index + 1).padStart(2, '0')}</div><div className="turn-heading-meta flex items-center gap-3 text-xs text-[var(--soft)] [&>time]:font-mono [&>time]:text-[var(--muted)]"><span>用户请求</span><time>{clock(turn.startedAt)}</time></div><button className="turn-link ml-auto grid size-9 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] max-[600px]:size-11" title="复制此轮链接" aria-label="复制此轮链接" onClick={() => void copyLink()}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></div>
    <div className="user-prompt my-3 mb-6 max-h-[480px] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-3.5 text-sm leading-[1.85] whitespace-pre-wrap [overflow-wrap:anywhere] [&>p]:m-0 min-[601px]:ml-[33px] max-[600px]:mb-5"><p>{promptExpanded || prompt.length <= 1200 ? prompt : `${prompt.slice(0, 1200)}…`}</p>{prompt.length > 1200 && <button className="text-button" onClick={() => setPromptExpanded(!promptExpanded)}>{promptExpanded ? '收起请求' : '展开完整请求'}<ChevronDown size={12} /></button>}</div>
    <div className="assistant-heading mb-4 flex items-center gap-2 [&>strong]:text-[13px] [&>strong]:font-semibold [&>.status-label]:ml-auto"><span className="agent-symbol grid size-6 shrink-0 place-items-center rounded-md border border-[var(--accent)] bg-[var(--accent-light)] font-mono text-[13px] font-semibold text-[var(--accent-strong)]">C</span><strong>Codex</strong><span className="model-label max-w-[40%] truncate text-xs text-[var(--muted)]">{turn.model || '模型未记录'}</span><span className={`status-label ${turn.status}`}><Circle size={6} fill="currentColor" />{statusLabels[turn.status]}</span></div>
    <div className="turn-content min-h-5 min-[601px]:pl-[33px]">{error && <div className="inline-error" role="alert">{error}<button className="text-button" onClick={() => setRetry(value => value + 1)}>重试</button></div>}{!detail && !error && <div className="turn-loading"><span className="pulse" />正在读取这一轮…</div>}{detail?.warnings.map((warning, index) => <div className="timeline-notice" key={index}><AlertTriangle size={13} />{warning}</div>)}{groupAdjacentContexts(presentation.timeline).map(entry => entry.kind === 'context-group'
      ? <ContextEvents key={`context-${entry.id}`} sessionId={sessionId} group={entry} />
      : renderEvent(entry))}</div>
    <div className="turn-footer mt-5 flex flex-wrap items-center gap-2 border-b border-[var(--border)] pb-6 text-xs text-[var(--muted)] min-[601px]:pl-[33px] [&>button]:ml-auto [&>button]:inline-flex [&>button]:min-h-9 [&>button]:items-center [&>button]:gap-1 [&>button]:text-[var(--soft)] [&>button]:hover:text-[var(--accent)] max-[600px]:[&>button]:min-h-11"><span>{turn.toolCount} 次工具调用</span><span className="separator text-[var(--border)]">·</span><span>{tokens(turn.usage.tokens?.totalTokens)} tokens</span><span className="separator text-[var(--border)]">·</span><span>{turn.usage.completeness === 'partial' ? '至少 ' : ''}{turn.usage.requestCount} 次模型调用</span><button onClick={() => onInspect({ turnId: turn.id })}>统计与明细<ArrowUpRight size={13} /></button></div>
  </article>;
}
