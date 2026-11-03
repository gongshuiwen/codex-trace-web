import { useEffect, useState } from 'react';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import type { RequestContextComparison, RequestUsage } from '../shared/types';
import { api, errorMessage, isAbort, sessionPath } from './api';
import { clock, exactTokens } from './format';
import { signedTokenDelta } from './context-presentation';
import { SourceEntries } from './ContextSources';

function ComparisonBody({ sessionId, request, revision, onNavigateTurn }: { sessionId: string; request: RequestUsage; revision: string; onNavigateTurn: (turnId: string) => void }) {
  const [data, setData] = useState<RequestContextComparison | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ turnId: request.turnId });
    setError('');
    api<RequestContextComparison>(`${sessionPath(sessionId)}/requests/${encodeURIComponent(request.id)}/comparison?${query}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setData(result); }).catch(cause => { if (!isAbort(cause)) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [sessionId, request.id, request.turnId, revision, retry]);
  if (error && !data) return <div className="context-analysis-error" role="alert"><span>{error}</span><button onClick={() => setRetry(value => value + 1)}>重试</button></div>;
  if (!data) return <div className="context-loading" role="status"><LoaderCircle size={13} className="spin" />正在对比上次调用…</div>;
  const previous = data.previous;
  const exact = previous?.source === 'record' && data.current.source === 'record';
  return <div className="request-comparison-body">
    {error && <p className="inline-error" role="alert">{error}（保留上次结果）<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {!previous ? <p className="detail-note">这是本会话首条可识别的调用记录，没有上次调用可供比较。</p> : <>
      <p className="detail-note">上次 {clock(previous.timestamp)} → 本次 {clock(data.current.timestamp)}{previous.turnId !== data.current.turnId ? ' · 跨用户轮次' : ''}</p>
      <p className="detail-note">模型：{previous.model || '未记录'} → {data.current.model || '未记录'}</p>
      {!exact && <p className="context-component-note">包含累计快照差值，不能将用量变化当作两次独立模型调用的差值。</p>}
      <table className="context-comparison-table"><caption>日志用量</caption><thead><tr><th>项目</th><th>上次</th><th>本次</th><th>变化</th></tr></thead><tbody>{([
        ['输入', 'inputTokens'], ['缓存读取', 'cachedInputTokens'], ['输出', 'outputTokens'],
      ] as const).map(([label, field]) => <tr key={field}><th>{label}</th><td>{exactTokens(previous.usage[field])}</td><td>{exactTokens(data.current.usage[field])}</td><td>{signedTokenDelta(exact ? data.current.usage[field] - previous.usage[field] : null)}</td></tr>)}</tbody></table>
      <table className="context-comparison-table"><caption>分类文本估算</caption><thead><tr><th>分类</th><th>上次</th><th>本次</th><th>变化</th></tr></thead><tbody>{data.components.map(component => <tr key={component.id}><th>{component.label}</th><td>{component.previousTokens == null ? '未知' : `≈ ${exactTokens(component.previousTokens)}`}</td><td>{component.currentTokens == null ? '未知' : `≈ ${exactTokens(component.currentTokens)}`}</td><td>{signedTokenDelta(data.comparable ? component.deltaTokens : null, true)}</td></tr>)}</tbody></table>
      {!data.comparable && <p className="context-component-note">边界或历史范围不足以可靠比较，分类差值与来源变化暂不展示。</p>}
      {data.comparable && <div className="context-source-changes">{([
        ['新增来源', data.changes.added, data.changes.addedSources],
        ['移除来源', data.changes.removed, data.changes.removedSources],
        ['替换来源', data.changes.changed, data.changes.changedSources],
      ] as const).map(([label, count, sources]) => <details key={label}><summary>{label}<span>{count} 项</span></summary>{count > sources.length && <p className="detail-note">这里只列出前 {sources.length} 项。</p>}{label === '替换来源' && count > 0 && <p className="detail-note">替换来源列出本次版本。</p>}<SourceEntries sources={sources} onNavigateTurn={onNavigateTurn} /></details>)}</div>}
    </>}
    {data.warnings.map((warning, index) => <p className="context-component-note" key={index}>{warning}</p>)}
  </div>;
}

export function RequestComparison({ sessionId, request, revision, onNavigateTurn }: { sessionId: string; request: RequestUsage; revision: string; onNavigateTurn: (turnId: string) => void }) {
  const [open, setOpen] = useState(false);
  return <details className="request-comparison" onToggle={event => setOpen(event.currentTarget.open)}><summary><ChevronRight size={12} />与上次调用对比</summary>{open && <ComparisonBody key={`${sessionId}:${request.turnId}:${request.id}`} sessionId={sessionId} request={request} revision={revision} onNavigateTurn={onNavigateTurn} />}</details>;
}
