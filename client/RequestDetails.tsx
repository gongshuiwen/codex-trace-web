import { useState } from 'react';
import type { RequestUsage } from '../shared/types';
import { exactTokens } from './format';
import { RequestContext } from './RequestContext';
import { RequestComparison } from './RequestComparison';
import { latestInputWindowPercent } from './session-metrics';

export function RequestDetails({ request, sessionId, revision, onNavigateTurn }: { request: RequestUsage; sessionId: string; revision: string; onNavigateTurn: (turnId: string) => void }) {
  const [contextOpen, setContextOpen] = useState(false);
  const cached = request.usage.inputTokens ? request.usage.cachedInputTokens / request.usage.inputTokens * 100 : null;
  const windowPercent = request.source === 'record' ? latestInputWindowPercent({ latestInputTokens: request.usage.inputTokens, contextWindow: request.contextWindow ?? null }) : null;
  return <div className="request-details" data-request-id={request.id}>
    <dl className="request-usage-values">{[
      ['总用量', exactTokens(request.usage.totalTokens)],
      ['输入', exactTokens(request.usage.inputTokens)],
      ['输出', exactTokens(request.usage.outputTokens)],
      ['输入占窗口', windowPercent == null ? '—' : `${windowPercent.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`],
      ['上下文窗口', exactTokens(request.contextWindow)],
      ['缓存读取', exactTokens(request.usage.cachedInputTokens)],
      ['缓存比例', cached == null ? '—' : `${cached.toFixed(1)}%`],
      ['缓存写入', exactTokens(request.usage.cacheWriteInputTokens)],
      ['推理输出（已含在输出中）', exactTokens(request.usage.reasoningOutputTokens)],
      ['记录来源', request.source === 'record' ? '原始调用记录' : '累计快照差值'],
    ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <RequestComparison sessionId={sessionId} request={request} revision={revision} onNavigateTurn={onNavigateTurn} />
    <details className="request-context-details" onToggle={event => setContextOpen(event.currentTarget.open)}><summary>上下文构成与来源</summary>{contextOpen && <RequestContext request={request} sessionId={sessionId} revision={revision} onNavigateTurn={onNavigateTurn} />}</details>
  </div>;
}
