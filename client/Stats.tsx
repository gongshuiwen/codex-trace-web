import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import type { UsageSummary } from '../shared/types';
import { exactTokens, tokens } from './format';
import { latestInputWindowPercent, sessionDuration } from './session-metrics';
import './session-stats.css';

export type UsageMetric = 'total' | 'requests' | 'failures' | 'compactions' | 'cache' | 'latest';

export function SessionStats({ usage, toolCount, toolFailureCount, durationMs, compactionCount, onDetails }: { usage: UsageSummary; toolCount: number; toolFailureCount?: number; durationMs?: number | null; compactionCount?: number; onDetails: (metric: UsageMetric) => void }) {
  const cachePercent = usage.tokens?.inputTokens ? Math.round(usage.tokens.cachedInputTokens / usage.tokens.inputTokens * 100) : null;
  const inputPercent = latestInputWindowPercent(usage);
  const ratio = inputPercent == null ? '窗口比例 —' : `占窗口 ${inputPercent.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`;
  const compactRatio = inputPercent == null ? '窗口 —' : `${inputPercent.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}% 窗口`;
  const metrics = [
    { id: 'total', label: '累计用量', value: tokens(usage.tokens?.totalTokens), unit: 'tokens', title: '查看整个会话的累计用量' },
    { id: 'latest', label: '最近调用输入', value: tokens(usage.latestInputTokens), unit: 'tokens', title: inputPercent == null ? '查看最近一次调用的输入；缺少对应输入或窗口记录，无法计算窗口比例' : `查看最近一次调用的输入：${exactTokens(usage.latestInputTokens)} / ${exactTokens(usage.contextWindow)} tokens，${ratio}；此比例对应最近一次记录，并非实时上下文占用` },
    { id: 'failures', label: '工具失败', value: toolFailureCount == null ? '—' : toolFailureCount.toLocaleString(), unit: '次', title: toolFailureCount == null ? '正在读取工具失败统计' : toolFailureCount === 0 ? '当前会话没有已记录的失败调用' : '定位当前会话的失败工具调用' },
    { id: 'compactions', label: '上下文压缩', value: compactionCount == null ? '—' : compactionCount.toLocaleString(), unit: '次', title: compactionCount == null ? '正在读取上下文压缩统计' : compactionCount === 0 ? '当前会话没有已记录的上下文压缩' : '定位当前会话的上下文压缩记录' },
    { id: 'requests', label: '模型调用', value: `${usage.completeness === 'partial' ? '≥ ' : ''}${usage.requestCount.toLocaleString()}`, unit: '次', title: '查看模型调用趋势' },
    { id: 'tools', label: '工具调用', value: toolCount.toLocaleString(), unit: '次', title: '当前会话记录的工具调用次数，不包含子会话' },
    { id: 'cache', label: '缓存命中', value: cachePercent == null ? '—' : `${cachePercent}%`, unit: '输入中', title: '查看缓存读取占输入的比例' },
    { id: 'duration', label: '会话耗时', value: sessionDuration(durationMs), unit: '', title: durationMs == null ? '日志缺少有效时间，无法计算会话耗时' : '首条至末条有效日志记录的时间跨度，包含等待和暂停；随新记录更新' },
  ] as const;
  const renderMetric = (metric: typeof metrics[number]) => {
    const content = <>
      <span className="stat-label">{metric.label}</span>
      <strong className={`stat-value${metric.id === 'failures' && toolFailureCount != null && toolFailureCount > 0 ? ' has-failures' : ''}`}>{metric.value}{metric.unit && <small className="stat-unit">{metric.unit === 'tokens' ? 'tok' : metric.unit}</small>}{metric.id === 'latest' && <span className="stat-ratio" data-input-window-ratio>{compactRatio}</span>}</strong>
    </>;
    return metric.id === 'tools' || metric.id === 'duration'
      ? <div key={metric.id} className="stat-cell" data-metric={metric.id} title={metric.title}>{content}</div>
      : <button type="button" key={metric.id} className="stat-cell" data-metric={metric.id} disabled={metric.id === 'failures' && !(toolFailureCount != null && toolFailureCount > 0) || metric.id === 'compactions' && !(compactionCount != null && compactionCount > 0)} onClick={() => onDetails(metric.id)} title={metric.title}>{content}</button>;
  };
  return <div className="session-stats" aria-label="会话用量摘要">
    {metrics.map(renderMetric)}
  </div>;
}

export function UsageBlock({ usage, label }: { usage: UsageSummary; label: string }) {
  const value = usage.tokens;
  const cached = value?.inputTokens ? Math.min(100, value.cachedInputTokens / value.inputTokens * 100) : 0;
  const facts = [
    ['缓存写入', exactTokens(value?.cacheWriteInputTokens)],
    [<>推理输出 <span title="属于输出的一部分，不与输出重复相加">ⓘ</span></>, exactTokens(value?.reasoningOutputTokens)],
    ['模型调用', `${usage.completeness === 'partial' ? '至少 ' : ''}${usage.requestCount} 次`],
  ] as const;
  return <section className="usage-block border-b border-[var(--border)] px-6 py-5">
    <div className="detail-section-heading flex items-center justify-between gap-3 text-[12px] leading-5 font-medium text-[var(--soft)]"><span>{label}</span>{usage.completeness !== 'complete' && <span className="subtle-badge shrink-0 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-[11px] leading-4 font-normal whitespace-nowrap text-[var(--warning)]">{usage.completeness === 'partial' ? '部分记录' : '缺少记录'}</span>}</div>
    <div className="usage-total mt-3 font-mono text-[24px] leading-8 tracking-[-0.025em] text-[var(--text)] tabular-nums">{exactTokens(value?.totalTokens)}<span className="ml-2 font-sans text-[12px] tracking-normal text-[var(--muted)]">tokens</span></div>
    <div className="usage-grid mt-4 grid grid-cols-2 gap-4">
      <div><span className="flex items-center gap-1 text-[12px] leading-5 text-[var(--muted)]"><ArrowDownLeft size={13} />输入</span><strong className="mt-1 block font-mono text-[14px] leading-5 font-normal text-[var(--soft)] tabular-nums">{exactTokens(value?.inputTokens)}</strong></div>
      <div><span className="flex items-center gap-1 text-[12px] leading-5 text-[var(--muted)]"><ArrowUpRight size={13} />输出</span><strong className="mt-1 block font-mono text-[14px] leading-5 font-normal text-[var(--soft)] tabular-nums">{exactTokens(value?.outputTokens)}</strong></div>
    </div>
    <div className="cache-track mt-4 h-[4px] overflow-hidden rounded-full bg-[var(--border)]"><span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${cached}%` }} /></div>
    <div className="cache-caption mt-2 flex justify-between gap-3 text-[12px] leading-5 text-[var(--muted)]"><span>缓存读取 {exactTokens(value?.cachedInputTokens)}</span><span className="tabular-nums">{value?.inputTokens ? `${cached.toFixed(1)}%` : '—'}</span></div>
    <dl className="usage-facts mt-4 space-y-2.5">{facts.map(([name, count], index) => <div key={index} className="flex items-baseline justify-between gap-3 text-[12px] leading-5"><dt className="text-[var(--muted)]">{name}</dt><dd className="m-0 text-right font-mono text-[var(--soft)] tabular-nums">{count}</dd></div>)}</dl>
  </section>;
}
