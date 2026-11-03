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

export interface Inspection { turnId?: string; toolId?: string; requestId?: string }

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
    if (event.kind === 'user') return <div key={event.id}><span className="event-phase">补充消息 · {clock(event.timestamp)}</span><div className="user-prompt" style={{ marginLeft: 0 }}><p>{event.text || '空消息'}</p></div></div>;
    if (event.kind === 'tool' && event.tool) return <ToolCard key={event.id} tool={event.tool} sessionId={sessionId} onInspect={() => onInspect({ turnId: turn.id, toolId: event.tool!.id })} />;
    if (event.kind === 'context' || event.kind === 'reasoning' || event.kind === 'unknown') return <EventDisclosure key={event.id} event={event} />;
    if (event.kind === 'notice') return <div className="timeline-notice" key={event.id}><AlertTriangle size={14} /><span>{event.text}</span></div>;
    return <div className={`assistant-event ${event.kind === 'commentary' ? 'commentary' : ''}`} key={event.id}>{event.kind === 'commentary' && <span className="event-phase">过程说明</span>}<Markdown text={event.text} /></div>;
  }
  const presentation = turnPresentation(turn.prompt, detail?.events);
  const prompt = presentation.prompt || '此轮没有用户文本';
  return <article className={`turn-card ${targetTurn === turn.id ? 'target-turn' : ''}`} data-turn-id={turn.id} data-turn-ready={ready ? 'true' : 'false'}>
    <div className="turn-heading"><div className="turn-order">{String(turn.index + 1).padStart(2, '0')}</div><div className="turn-heading-meta"><span>用户请求</span><time>{clock(turn.startedAt)}</time></div><button className="turn-link" title="复制此轮链接" aria-label="复制此轮链接" onClick={() => void copyLink()}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></div>
    <div className="user-prompt"><p>{promptExpanded || prompt.length <= 1200 ? prompt : `${prompt.slice(0, 1200)}…`}</p>{prompt.length > 1200 && <button className="text-button" onClick={() => setPromptExpanded(!promptExpanded)}>{promptExpanded ? '收起请求' : '展开完整请求'}<ChevronDown size={12} /></button>}</div>
    <div className="assistant-heading"><span className="agent-symbol">C</span><strong>Codex</strong><span className="model-label">{turn.model || '模型未记录'}</span><span className={`status-label ${turn.status}`}><Circle size={6} fill="currentColor" />{statusLabels[turn.status]}</span></div>
    <div className="turn-content">{error && <div className="inline-error" role="alert">{error}<button className="text-button" onClick={() => setRetry(value => value + 1)}>重试</button></div>}{!detail && !error && <div className="turn-loading"><span className="pulse" />正在读取这一轮…</div>}{detail?.warnings.map((warning, index) => <div className="timeline-notice" key={index}><AlertTriangle size={13} />{warning}</div>)}{presentation.timeline.map(renderEvent)}</div>
    <div className="turn-footer"><span>{turn.toolCount} 次工具调用</span><span className="separator">·</span><span>{tokens(turn.usage.tokens?.totalTokens)} tokens</span><span className="separator">·</span><span>{turn.usage.completeness === 'partial' ? '至少 ' : ''}{turn.usage.requestCount} 次模型调用</span><button onClick={() => onInspect({ turnId: turn.id })}>统计与明细<ArrowUpRight size={13} /></button></div>
  </article>;
}
