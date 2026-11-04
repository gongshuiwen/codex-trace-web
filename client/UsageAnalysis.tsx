import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { SessionActivity, SessionDetail } from '../shared/types';
import type { SessionLocation } from './session-location';
import { TokenTimeline } from './TokenTimeline';
import { UsageBlock } from './Stats';
import { RequestDetails } from './RequestDetails';
import { clock, exactTokens } from './format';
import { latestRecordedRequest } from './latest-request';
import './usage-analysis.css';

export function UsageAnalysis({ session, activity, location, onNavigate, onNavigateTurn, active }: {
  session: SessionDetail; activity: SessionActivity; location: SessionLocation;
  onNavigate: (next: SessionLocation, replace?: boolean) => void; onNavigateTurn: (turnId: string) => void; active: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const navigationKey = window.history.state?.sessionLensEntry;
  const candidate = latestRecordedRequest(activity.requests, session.session.usage.latestInputTokens);
  const latest = candidate && session.turns.some(turn => turn.id === candidate.turnId) ? candidate : null;
  const requestIndexes = new Map(activity.requests.map((request, index) => [request.id, index]));
  const requests = location.usageTurn ? activity.requests.filter(request => request.turnId === location.usageTurn) : activity.requests;
  const requested = location.request ? activity.requests.find(request => request.id === location.request) : null;
  const selected = location.request ? requested : location.focus === 'latest' ? latest : requests[0];
  const scopedIndex = selected ? requests.findIndex(request => request.id === selected.id) : -1;
  const turn = session.turns.find(turn => turn.id === (location.usageTurn ?? selected?.turnId));
  const latestMissing = !location.request && location.focus === 'latest' && !latest;
  const missing = Boolean(location.request && !requested);
  function selectRequest(requestId: string) {
    const request = activity.requests.find(request => request.id === requestId);
    onNavigate({ ...location, view: 'usage', request: requestId, usageTurn: location.usageTurn === request?.turnId ? location.usageTurn : null, focus: null });
  }
  useEffect(() => {
    if (active && selected && !location.request && !latestMissing) onNavigate({ ...location, request: selected.id }, true);
  }, [active, selected?.id, location.request, location.focus, location.usageTurn, latestMissing]);
  useEffect(() => {
    if (!active || !location.focus) return;
    const selector = location.focus === 'cache' ? '.cache-caption' : location.focus === 'total' ? '.usage-overview' : location.focus === 'requests' ? '.usage-trend' : '.usage-calls';
    const target = root.current?.querySelector<HTMLElement>(selector);
    target?.scrollIntoView({ block: 'start' });
    if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }, [active, location.focus, navigationKey]);
  return <div className="usage-analysis" ref={root}>
    <section className="usage-overview" aria-label="会话用量概览"><UsageBlock usage={session.session.usage} label="会话用量" /></section>
    <section className="usage-trend" aria-label="调用趋势与压缩"><h2>调用趋势与压缩</h2><TokenTimeline activity={activity} selectedId={selected?.id ?? null} onSelectRequest={selectRequest} onNavigateTurn={onNavigateTurn} /></section>
    <section className="usage-calls" aria-label="调用明细">
      <div className="usage-calls-heading"><h2>{location.usageTurn && turn ? `第 ${turn.index + 1} 轮调用明细` : '调用明细'}</h2>
        {location.usageTurn && <button type="button" onClick={() => onNavigate({ ...location, usageTurn: null })}>查看全部调用</button>}
      </div>
      {latestMissing && <p className="usage-notice" role="status">日志没有可可靠关联的最近一次调用。最近输入 {exactTokens(session.session.usage.latestInputTokens)} tokens，窗口 {exactTokens(session.session.usage.contextWindow)} tokens；这不是实时上下文占用。</p>}
      {missing && <p className="usage-notice" role="status">当前日志中未找到所选调用，请从调用记录中重新选择。</p>}
      {requests.length > 0 ? <div className="usage-call-controls">
        <div className="usage-request-picker" role="group" aria-label="调用记录导航">
          <button type="button" className="usage-call-step" aria-label="上一次调用" title="上一次调用" disabled={scopedIndex <= 0} onClick={() => selectRequest(requests[scopedIndex - 1].id)}><ChevronLeft size={16} aria-hidden="true" /></button>
          <select aria-label="选择调用" value={selected?.id ?? ''} onChange={event => selectRequest(event.target.value)}><option value="" disabled>选择一条调用记录</option>{requests.map(request => <option key={request.id} value={request.id}>第 {requestIndexes.get(request.id)! + 1} 条 · {clock(request.timestamp)}{request.source === 'snapshot-delta' ? ' · 累计快照差值' : ''}</option>)}</select>
          <button type="button" className="usage-call-step" aria-label="下一次调用" title="下一次调用" disabled={scopedIndex < 0 || scopedIndex + 1 >= requests.length} onClick={() => selectRequest(requests[scopedIndex + 1].id)}><ChevronRight size={16} aria-hidden="true" /></button>
        </div>
        {selected && <div className="usage-request-meta"><span>{selected.model || '模型未记录'}</span><button type="button" onClick={() => onNavigateTurn(selected.turnId)}>查看第 {(session.turns.find(turn => turn.id === selected.turnId)?.index ?? 0) + 1} 轮对话</button></div>}
      </div> : <p className="detail-note">{location.usageTurn ? '本轮没有逐次用量记录。' : '日志没有逐次用量记录。'}</p>}
      {selected && <RequestDetails key={selected.id} request={selected} sessionId={session.session.id} revision={session.session.revision} onNavigateTurn={onNavigateTurn} />}
    </section>
    <details className="usage-method"><summary>统计口径与会话信息</summary><p>缓存读取包含在输入中；推理输出包含在输出中，均不重复相加。会话用量不包含子会话。累计快照差值可能包含多个缺失调用。</p><p>最近输入与窗口比例对应最近一次记录，并非实时上下文占用。缺失记录显示未知，0 表示明确记录为零。</p><dl><dt>会话 ID</dt><dd>{session.session.id}</dd><dt>来源</dt><dd>{session.session.source || '未记录'}</dd><dt>日志文件</dt><dd>{session.session.filePath}</dd><dt>解析异常</dt><dd>{session.session.parseErrors} 行</dd></dl></details>
  </div>;
}
