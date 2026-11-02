import { Activity, ArrowDownLeft, ArrowUpRight, Layers, Database } from 'lucide-react';
import type { UsageSummary } from '../shared/types';
import { exactTokens, tokens } from './format';

export function SessionStats({ usage, onDetails }: { usage: UsageSummary; onDetails: () => void }) {
  const cachePercent = usage.tokens?.inputTokens ? Math.round(usage.tokens.cachedInputTokens / usage.tokens.inputTokens * 100) : null;
  return <div className="session-stats">
    <button className="stat-cell" onClick={onDetails}><span><Layers size={14} />累计用量</span><strong>{tokens(usage.tokens?.totalTokens)}<small>tokens</small></strong></button>
    <button className="stat-cell" onClick={onDetails}><span><Activity size={14} />模型调用</span><strong>{usage.completeness === 'partial' ? '≥ ' : ''}{usage.requestCount.toLocaleString()}<small>次</small></strong></button>
    <button className="stat-cell" onClick={onDetails}><span><Database size={14} />缓存命中</span><strong>{cachePercent == null ? '—' : `${cachePercent}%`}<small>输入中</small></strong></button>
    <button className="stat-cell" onClick={onDetails}><span><ArrowDownLeft size={14} />最近一次输入</span><strong>{tokens(usage.latestInputTokens)}<small>tokens</small></strong></button>
  </div>;
}

export function UsageBlock({ usage, label }: { usage: UsageSummary; label: string }) {
  const value = usage.tokens;
  const cached = value?.inputTokens ? Math.min(100, value.cachedInputTokens / value.inputTokens * 100) : 0;
  return <section className="usage-block"><div className="detail-section-heading"><span>{label}</span><span className="subtle-badge">{usage.completeness === 'complete' ? '记录完整' : usage.completeness === 'partial' ? '部分记录' : '缺少记录'}</span></div>
    <div className="usage-total">{exactTokens(value?.totalTokens)}<span>tokens</span></div>
    <div className="usage-grid"><div><span><ArrowDownLeft size={13} />输入</span><strong>{exactTokens(value?.inputTokens)}</strong></div><div><span><ArrowUpRight size={13} />输出</span><strong>{exactTokens(value?.outputTokens)}</strong></div></div>
    <div className="cache-track"><span style={{ width: `${cached}%` }} /></div><div className="cache-caption"><span>缓存读取 {exactTokens(value?.cachedInputTokens)}</span><span>{value?.inputTokens ? `${cached.toFixed(1)}%` : '—'}</span></div>
    <dl className="usage-facts"><div><dt>缓存写入</dt><dd>{exactTokens(value?.cacheWriteInputTokens)}</dd></div><div><dt>推理输出 <span title="属于输出的一部分，不与输出重复相加">ⓘ</span></dt><dd>{exactTokens(value?.reasoningOutputTokens)}</dd></div><div><dt>模型调用</dt><dd>{usage.completeness === 'partial' ? '至少 ' : ''}{usage.requestCount} 次</dd></div><div><dt>最近一次输入</dt><dd>{exactTokens(usage.latestInputTokens)}</dd></div><div><dt>上下文窗口</dt><dd>{exactTokens(usage.contextWindow)}</dd></div></dl>
    <p className="detail-note">缓存 token 包含在输入中；推理 token 包含在输出中。累计用量反映多次调用，不等同于当前上下文长度。</p>
  </section>;
}
