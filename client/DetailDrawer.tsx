import { useEffect, useRef, useState } from 'react';
import { X, ArrowUpRight, Code2, Hash, Layers3 } from 'lucide-react';
import type { RequestUsage, SessionDetail, TurnDetail } from '../shared/types';
import { api, errorMessage, isAbort, sessionPath } from './api';
import { UsageBlock } from './Stats';
import { clock, exactTokens, prettyArguments } from './format';
import type { Inspection } from './TurnCard';
import { RequestContext } from './RequestContext';
import { RequestComparison } from './RequestComparison';

function RequestCard({ request, index, sessionId, revision, onNavigateTurn, selectedRequest }: { request: RequestUsage; index: number; sessionId: string; revision: string; onNavigateTurn: (turnId: string) => void; selectedRequest?: Inspection }) {
  const [open, setOpen] = useState(!!selectedRequest);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!selectedRequest) return;
    setOpen(true);
    const frame = requestAnimationFrame(() => detailsRef.current?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [selectedRequest]);
  return <details ref={detailsRef} data-request-id={request.id} className={`request-card ${selectedRequest ? 'selected-request' : ''}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><span><Hash size={12} />{index + 1}<time>{clock(request.timestamp)}</time></span><strong>{exactTokens(request.usage.totalTokens)}<ArrowUpRight size={12} /></strong></summary>{open && <><dl className="usage-facts"><div><dt>输入</dt><dd>{exactTokens(request.usage.inputTokens)}</dd></div><div><dt>缓存读取</dt><dd>{exactTokens(request.usage.cachedInputTokens)}</dd></div><div><dt>缓存写入</dt><dd>{exactTokens(request.usage.cacheWriteInputTokens)}</dd></div><div><dt>输出</dt><dd>{exactTokens(request.usage.outputTokens)}</dd></div><div><dt>推理输出（已含在输出中）</dt><dd>{exactTokens(request.usage.reasoningOutputTokens)}</dd></div><div><dt>记录来源</dt><dd>{request.source === 'record' ? '原始调用记录' : '累计快照差值'}</dd></div></dl><RequestComparison sessionId={sessionId} request={request} revision={revision} onNavigateTurn={onNavigateTurn} /><RequestContext sessionId={sessionId} request={request} revision={revision} onNavigateTurn={onNavigateTurn} /></>}</details>;
}

export function DetailDrawer({ session, selection, onClose, onNavigateTurn }: { session: SessionDetail; selection: Inspection; onClose: () => void; onNavigateTurn: (turnId: string) => void }) {
  const [turn, setTurn] = useState<TurnDetail | null>(null);
  const [error, setError] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const loadedSelection = useRef('');
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const key = `${session.session.id}\u0000${selection.turnId ?? ''}`;
    if (loadedSelection.current !== key) setTurn(null);
    loadedSelection.current = key;
    setError('');
    if (!selection.turnId) return;
    const controller = new AbortController();
    api<TurnDetail>(`${sessionPath(session.session.id)}/turns/${encodeURIComponent(selection.turnId)}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setTurn(result); }).catch(cause => { if (!isAbort(cause)) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [session.session.id, session.session.revision, selection.turnId]);
  const tool = turn?.events.find(event => event.tool?.id === selection.toolId)?.tool;
  return <><button className="drawer-backdrop" aria-label="关闭详情" onClick={onClose} /><aside className="detail-drawer" aria-label="统计与调用详情"><div className="drawer-heading"><div><span className="eyebrow">INSPECTOR</span><h2>{selection.toolId ? '调用详情' : selection.turnId ? '轮次统计' : '会话统计'}</h2></div><button ref={closeRef} className="icon-button" onClick={onClose} title="关闭详情 (Esc)" aria-label="关闭详情"><X size={18} /></button></div><div className="drawer-scroll">
    {error && <div className="inline-error" role="alert">{error}</div>}
    {selection.turnId && !turn && !error && <div className="turn-loading">正在读取明细…</div>}
    {tool && <section className="tool-detail"><div className="detail-section-heading"><Code2 size={15} /><span>{tool.name}</span></div><div className="detail-note">调用 ID <code>{tool.id}</code></div><pre className="inspector-code">{prettyArguments(tool.arguments)}</pre><p className="detail-note">输出共 {tool.outputLength.toLocaleString()} 字符。展开时间线中的工具卡片可分段读取输出。</p><div className="detail-note">此调用本身没有独立 token 账单，下方展示其所在轮次的模型用量。</div></section>}
    {turn && <><UsageBlock usage={turn.summary.usage} label={`第 ${turn.summary.index + 1} 轮用量`} /><section className="request-list"><div className="detail-section-heading"><span>逐次模型调用</span><span className="subtle-badge">{turn.requests.length} 条记录</span></div>{turn.requests.length === 0 && <p className="detail-note">此轮日志没有逐次用量记录。</p>}{turn.requests.map((request, index) => <RequestCard key={request.id} request={request} index={index} sessionId={session.session.id} revision={session.session.revision} selectedRequest={selection.requestId === request.id ? selection : undefined} onNavigateTurn={turnId => { onClose(); onNavigateTurn(turnId); }} />)}</section></>}
    <UsageBlock usage={session.session.usage} label="整个会话用量" />
    <section className="session-properties"><div className="detail-section-heading"><Layers3 size={14} /><span>会话信息</span></div><dl className="properties"><dt>会话 ID</dt><dd>{session.session.id}</dd><dt>来源</dt><dd>{session.session.source || '未记录'}</dd><dt>日志文件</dt><dd>{session.session.filePath}</dd><dt>解析异常</dt><dd>{session.session.parseErrors} 行</dd></dl></section>
  </div></aside></>;
}
