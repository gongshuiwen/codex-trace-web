import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronRight, Info, LoaderCircle, RefreshCw } from 'lucide-react';
import type { ContextComponent, RequestContextAnalysis, RequestUsage } from '../shared/types';
import { api, errorMessage, isAbort, sessionPath } from './api';
import { exactTokens } from './format';
import { contextRow, signedContextTokens } from './context-presentation';
import './context-analysis.css';

const cache = new Map<string, RequestContextAnalysis>();
const CACHE_LIMIT = 48;

function cacheAnalysis(key: string, result: RequestContextAnalysis) {
  cache.delete(key);
  cache.set(key, result);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

function ComponentRow({ component, inputTokens }: { component: ContextComponent; inputTokens: number }) {
  const row = contextRow(component, inputTokens);
  return <div className={`context-component context-component-${component.id}`}>
    <div className="context-component-heading"><strong>{component.label}</strong><span className={`context-estimate-state ${component.status}`}>{row.state}</span><span className="context-component-value">{row.value}</span></div>
    {row.percent != null && <div className="context-ratio"><div className="context-meter-scroll"><div className="context-meter-track" aria-label={`${component.label}估算为记录输入的${row.percentLabel}${row.percent > 100 ? '，横条视觉上限为100%' : ''}`}><span style={{ width: `${Math.min(100, Math.max(0, row.percent))}%` }} /></div></div><span className={row.percent > 100 ? 'context-excess' : ''}>{row.percentLabel}</span></div>}
    <p className="context-component-note">{component.note}{component.method === 'sampled' && <span className="context-sampled-tag">抽样外推</span>}</p>
  </div>;
}

export function RequestContext({ sessionId, request, revision }: { sessionId: string; request: RequestUsage; revision: string }) {
  const key = `${sessionId}\u0000${request.id}\u0000${request.turnId}\u0000${revision}`;
  const [state, setState] = useState<{ key: string; data?: RequestContextAnalysis; error?: string }>(() => ({ key, data: cache.get(key) }));
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const existing = cache.get(key);
    if (existing) { setState({ key, data: existing }); return; }
    const controller = new AbortController();
    setState({ key });
    api<RequestContextAnalysis>(`${sessionPath(sessionId)}/requests/${encodeURIComponent(request.id)}/context?turnId=${encodeURIComponent(request.turnId)}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { cacheAnalysis(key, result); setState({ key, data: result }); }
    }).catch(cause => { if (!controller.signal.aborted && !isAbort(cause)) setState({ key, error: errorMessage(cause) }); });
    return () => controller.abort();
  }, [key, sessionId, request.id, request.turnId, retry]);
  const data = state.key === key ? state.data : undefined;
  const error = state.key === key ? state.error : undefined;
  const unavailable = data?.boundary === 'unavailable';
  return <section className="context-analysis" aria-label="本次模型调用的上下文分析">
    <div className="context-analysis-heading"><span>上下文构成</span><span className="context-estimate-label">文本估算</span></div>
    <div className="context-input-baseline"><span>{request.source === 'snapshot-delta' ? '累计差值中的输入（非单次）' : '本次输入 · 日志记录'}</span><strong>{exactTokens(request.usage.inputTokens)}<small>tokens</small></strong></div>
    {!data && !error && <div className="context-loading" role="status"><LoaderCircle className="spin" size={13} />正在分析可见日志…</div>}
    {error && <div className="context-analysis-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={12} />重新分析</button></div>}
    {data && <>
      {unavailable && <div className="context-unavailable"><Info size={14} /><div><strong>无法定位这次调用的上下文边界</strong><p>日志不足以确定哪些文本属于这次模型输入，因此各类均无法统计。上方输入总量仍以用量记录为准。</p></div></div>}
      {!unavailable && <p className="context-intro">下列是日志可见历史候选文本的估算，无法确认它们全部被送入本次输入。各行独立对比记录输入量，未知项不表示 0；横条不构成完整输入分区。</p>}
      <div className="context-components">{data.components.map(component => <ComponentRow key={component.id} component={unavailable ? { ...component, tokens: null, status: 'unavailable', method: 'none', note: component.note || '无法定位调用边界，不能确定此类内容是否属于本次输入。' } : component} inputTokens={request.usage.inputTokens} />)}</div>
      {!unavailable && <>
        <dl className="context-reconciliation"><div><dt>可见文本估算合计</dt><dd>{data.estimatedTotalTokens == null ? '未知' : `≈ ${exactTokens(data.estimatedTotalTokens)}`}</dd></div><div className={data.unattributedTokens != null && data.unattributedTokens < 0 ? 'context-excess' : ''}><dt>未归属对账差额</dt><dd>{signedContextTokens(data.unattributedTokens)}</dd></div></dl>
        {data.excessTokens > 0 && <div className="context-overflow-warning"><AlertTriangle size={14} /><span>估算合计超出日志输入 <strong>{exactTokens(data.excessTokens)}</strong> tokens。估算未归一化，不能视为精确组成。</span></div>}
        <p className="context-reconciliation-note">差额 = 日志输入 − 可估项合计。它可能包含未知内容及估算误差，无法确定为某一类上下文，也不计入额外用量。</p>
      </>}
      {data.warnings.length > 0 && <div className="context-warnings">{data.warnings.map((warning, index) => <p key={index}><AlertTriangle size={12} /><span>{warning}</span></p>)}</div>}
      <details className="context-method"><summary><ChevronRight size={12} />方法与限制</summary><div><p>使用 <code>{data.tokenizer}</code> 对日志中可见文本做近似分词。实际模型的分词与完整输入可能不同；较长文本可能采用抽样外推。</p><p>{data.boundary === 'inferred' ? '调用边界由日志顺序推断。' : '此调用的日志边界无法确定。'}{data.scope === 'since-compaction' ? '本次只分析最近一次压缩后的可见文本。' : data.scope === 'visible-history' ? '本次分析边界之前的可见历史文本。' : '本次无法确定可分析的历史范围。'} 历史是否仍保留在实际模型输入中无法确认。</p><p>消息封装、图片编码、隐藏指令及未记录的工具定义无法从日志完整还原。分类估算不进入真实 usage 汇总；缓存读取仍包含在输入中。</p></div></details>
    </>}
  </section>;
}
