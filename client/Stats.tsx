import { Activity, ArrowDownLeft, ArrowUpRight, Database, Layers } from 'lucide-react';
import type { UsageSummary } from '../shared/types';
import { exactTokens, tokens } from './format';

export type UsageMetric = 'total' | 'requests' | 'cache' | 'latest';

export function SessionStats({ usage, onDetails }: { usage: UsageSummary; onDetails: (metric: UsageMetric) => void }) {
  const cachePercent = usage.tokens?.inputTokens ? Math.round(usage.tokens.cachedInputTokens / usage.tokens.inputTokens * 100) : null;
  const metrics = [
    { id: 'total', label: '累计用量', icon: Layers, value: tokens(usage.tokens?.totalTokens), unit: 'tokens', title: '查看整个会话的累计用量' },
    { id: 'requests', label: '模型调用', icon: Activity, value: `${usage.completeness === 'partial' ? '≥ ' : ''}${usage.requestCount.toLocaleString()}`, unit: '次', title: '查看模型调用趋势' },
    { id: 'cache', label: '缓存命中', icon: Database, value: cachePercent == null ? '—' : `${cachePercent}%`, unit: '输入中', title: '查看缓存读取占输入的比例' },
    { id: 'latest', label: '最近输入', icon: ArrowDownLeft, value: tokens(usage.latestInputTokens), unit: 'tokens', title: '查看最近一次模型调用的输入' },
  ] as const;
  return <div className="session-stats grid grid-cols-2 gap-y-2 border-t border-[var(--border)] py-2 min-[561px]:grid-cols-4 min-[561px]:gap-y-0 min-[561px]:py-3" aria-label="会话用量摘要">
    {metrics.map((metric, index) => <button key={metric.id} className={`stat-cell ${metric.id === 'total' ? 'stat-total ' : ''}group flex min-w-0 flex-col items-start gap-1 bg-transparent px-4 py-0.5 text-left transition-colors hover:text-[var(--accent-strong)] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)] ${index === 0 ? 'pl-0' : 'border-l border-[var(--border)]'} ${index === 2 ? 'max-[560px]:border-l-0 max-[560px]:pl-0' : ''}`} onClick={() => onDetails(metric.id)} title={metric.title}>
      <span className="flex items-center gap-1.5 text-[12px] leading-4 text-[var(--muted)]"><metric.icon size={14} strokeWidth={1.5} />{metric.label}</span>
      <strong className="flex flex-wrap items-baseline gap-1.5 font-mono text-[22px] leading-7 font-normal tracking-[-0.025em] text-[var(--text)] tabular-nums group-hover:text-[var(--accent-strong)] max-[560px]:text-[18px] max-[560px]:leading-6">{metric.value}<small className="font-sans text-[11px] leading-4 font-normal tracking-normal text-[var(--muted)]">{metric.unit}</small></strong>
    </button>)}
  </div>;
}

export function UsageBlock({ usage, label }: { usage: UsageSummary; label: string }) {
  const value = usage.tokens;
  const cached = value?.inputTokens ? Math.min(100, value.cachedInputTokens / value.inputTokens * 100) : 0;
  const facts = [
    ['缓存写入', exactTokens(value?.cacheWriteInputTokens)],
    [<>推理输出 <span title="属于输出的一部分，不与输出重复相加">ⓘ</span></>, exactTokens(value?.reasoningOutputTokens)],
    ['模型调用', `${usage.completeness === 'partial' ? '至少 ' : ''}${usage.requestCount} 次`],
    ['最近一次输入', exactTokens(usage.latestInputTokens)],
    ['上下文窗口', exactTokens(usage.contextWindow)],
  ] as const;
  return <section className="usage-block border-b border-[var(--border)] px-6 py-5">
    <div className="detail-section-heading flex items-center justify-between gap-3 text-[12px] leading-5 font-medium text-[var(--soft)]"><span>{label}</span><span className="subtle-badge shrink-0 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-[11px] leading-4 font-normal whitespace-nowrap text-[var(--muted)]">{usage.completeness === 'complete' ? '记录完整' : usage.completeness === 'partial' ? '部分记录' : '缺少记录'}</span></div>
    <div className="usage-total mt-3 font-mono text-[24px] leading-8 tracking-[-0.025em] text-[var(--text)] tabular-nums">{exactTokens(value?.totalTokens)}<span className="ml-2 font-sans text-[12px] tracking-normal text-[var(--muted)]">tokens</span></div>
    <div className="usage-grid mt-4 grid grid-cols-2 gap-4">
      <div><span className="flex items-center gap-1 text-[12px] leading-5 text-[var(--muted)]"><ArrowDownLeft size={13} />输入</span><strong className="mt-1 block font-mono text-[14px] leading-5 font-normal text-[var(--soft)] tabular-nums">{exactTokens(value?.inputTokens)}</strong></div>
      <div><span className="flex items-center gap-1 text-[12px] leading-5 text-[var(--muted)]"><ArrowUpRight size={13} />输出</span><strong className="mt-1 block font-mono text-[14px] leading-5 font-normal text-[var(--soft)] tabular-nums">{exactTokens(value?.outputTokens)}</strong></div>
    </div>
    <div className="cache-track mt-4 h-[4px] overflow-hidden rounded-full bg-[var(--border)]"><span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${cached}%` }} /></div>
    <div className="cache-caption mt-2 flex justify-between gap-3 text-[12px] leading-5 text-[var(--muted)]"><span>缓存读取 {exactTokens(value?.cachedInputTokens)}</span><span className="tabular-nums">{value?.inputTokens ? `${cached.toFixed(1)}%` : '—'}</span></div>
    <dl className="usage-facts mt-4 space-y-2.5">{facts.map(([name, count], index) => <div key={index} className="flex items-baseline justify-between gap-3 text-[12px] leading-5"><dt className="text-[var(--muted)]">{name}</dt><dd className="m-0 text-right font-mono text-[var(--soft)] tabular-nums">{count}</dd></div>)}</dl>
    <p className="detail-note mt-4 mb-0 text-[12px] leading-5 text-[var(--muted)]">缓存 token 包含在输入中；推理 token 包含在输出中。累计用量反映多次调用，不等同于当前上下文长度。</p>
  </section>;
}
