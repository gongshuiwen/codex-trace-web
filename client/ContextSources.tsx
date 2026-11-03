import { useEffect, useState } from 'react';
import { ArrowUpRight, LoaderCircle } from 'lucide-react';
import type { ContextCategory, ContextSource, ContextSourcePage, RequestUsage } from '../shared/types';
import { api, errorMessage, isAbort, sessionPath } from './api';
import { exactTokens } from './format';

export function SourceEntries({ sources, onNavigateTurn }: { sources: ContextSource[]; onNavigateTurn: (turnId: string) => void }) {
  return <ul className="context-source-list">{sources.map(source => <li key={source.id}>
    <div className="context-source-heading"><strong>{source.label}</strong><span>≈ {exactTokens(source.estimatedTokens)}</span></div>
    <p className="context-component-note">{source.partial ? '部分估算 · ' : ''}{source.method === 'sampled' ? '抽样外推 · ' : ''}{source.note}</p>
    {source.excerpt && <pre>{source.excerpt}</pre>}
    {source.turnId && <button className="text-button" type="button" onClick={() => onNavigateTurn(source.turnId!)}>定位来源轮次<ArrowUpRight size={12} /></button>}
  </li>)}</ul>;
}

export function ContextSources({ sessionId, request, category, onNavigateTurn }: { sessionId: string; request: RequestUsage; category: ContextCategory; onNavigateTurn: (turnId: string) => void }) {
  const [data, setData] = useState<ContextSourcePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    const query = new URLSearchParams({ turnId: request.turnId, category, offset: String(offset), limit: '20' });
    api<ContextSourcePage>(`${sessionPath(sessionId)}/requests/${encodeURIComponent(request.id)}/context/sources?${query}`, { signal: controller.signal }).then(page => {
      if (!controller.signal.aborted) setData(previous => ({ ...page, sources: offset && previous ? [...previous.sources, ...page.sources] : page.sources }));
    }).catch(cause => { if (!isAbort(cause)) setError(errorMessage(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId, request.id, request.turnId, category, offset, retry]);
  return <div className="context-sources" aria-label="上下文来源明细">
    <p className="context-component-note">显示日志中的候选来源及截取的文本预览；token 数是估算，不代表这些内容全部进入了实际请求。</p>
    {data && <>
      <SourceEntries sources={data.sources} onNavigateTurn={onNavigateTurn} />
      {data.sources.length === 0 && <p className="detail-note">没有可还原的来源记录，未知不表示零。</p>}
      {data.warnings.map((warning, index) => <p className="context-component-note" key={index}>{warning}</p>)}
      <div className="context-source-pagination"><span>已显示 {data.sources.length} / {data.total} 项</span><button className="text-button" disabled={loading} onClick={() => { setOffset(0); setRetry(value => value + 1); }}>刷新来源</button>{data.nextOffset != null && <button className="text-button" disabled={loading} onClick={() => setOffset(data.nextOffset!)}>继续加载</button>}</div>
    </>}
    {loading && <div className="context-loading" role="status"><LoaderCircle className="spin" size={13} />正在读取来源…</div>}
    {error && <div className="context-analysis-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
  </div>;
}
