import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Minimize2 } from 'lucide-react';
import type { SessionActivity } from '../shared/types';
import type { Inspection } from './TurnCard';
import { clock, tokens } from './format';
import { compactionX, requestPointLabel, tokenPlot, TOKEN_PLOT } from './token-timeline';
import './TokenTimeline.css';

export function TokenTimeline({ activity, onInspect, onNavigateTurn }: {
  activity: SessionActivity;
  onInspect: (selection: Inspection) => void;
  onNavigateTurn: (turnId: string) => void;
}) {
  const [page, setPage] = useState(0);
  const plot = useMemo(() => tokenPlot(activity.requests, page), [activity.requests, page]);
  const compactions = activity.compactions.flatMap((marker, index) => {
    const x = compactionX(marker.beforeRequestIndex, plot);
    return x == null ? [] : [{ marker, index, x }];
  });
  const hasSnapshots = activity.requests.some(request => request.source === 'snapshot-delta');
  const inspect = (request: SessionActivity['requests'][number]) => onInspect({ turnId: request.turnId, requestId: request.id });
  return <section className="token-timeline" aria-label="Token 与压缩时间轴">
    <div className="token-timeline-heading"><div><h2>Token 与压缩</h2><p>{activity.requests.length.toLocaleString()} 条用量记录 · {activity.compactions.length.toLocaleString()} 次压缩</p></div><span className="subtle-badge">按日志顺序</span></div>
    <div className="token-timeline-legend"><span><i className="token-series-input" />输入</span><span><i className="token-series-output" />输出</span><span><i className="token-series-cache" />缓存读取（输入子集）</span><span><Minimize2 size={11} />压缩</span>{hasSnapshots && <span className="token-snapshot-legend">◇ 累计差值</span>}</div>
    {activity.requests.length === 0 ? <p className="token-timeline-empty">没有可绘制的模型调用用量记录。</p> : <>
      <div className="token-timeline-scroll" tabIndex={0} aria-label="调用趋势图，可横向滚动">
        <svg className="token-timeline-plot" width={plot.width} height={TOKEN_PLOT.height} viewBox={`0 0 ${plot.width} ${TOKEN_PLOT.height}`} role="group" aria-label="按记录序号排列的输入、输出、缓存读取趋势。点击调用点查看统计。">
          {[plot.maximum, plot.maximum / 2, 0].map((value, index) => {
            const y = TOKEN_PLOT.top + index * (TOKEN_PLOT.bottom - TOKEN_PLOT.top) / 2;
            return <g key={index} className="token-timeline-axis"><line x1={TOKEN_PLOT.left} x2={plot.width - 16} y1={y} y2={y} /><text x={TOKEN_PLOT.left - 9} y={y + 3} textAnchor="end">{tokens(Math.round(value))}</text></g>;
          })}
          <path className="token-series-line token-series-input" d={plot.line('inputTokens')} />
          <path className="token-series-line token-series-output" d={plot.line('outputTokens')} />
          <path className="token-series-line token-series-cache" d={plot.line('cachedInputTokens')} />
          {plot.points.map(point => {
            const y = point.y('inputTokens');
            const snapshot = point.request.source !== 'record';
            const title = `${requestPointLabel(point.request, point.index)}\n${clock(point.request.timestamp)} · ${point.request.model || '模型未记录'}\n查看调用统计`;
            return <g key={point.request.id} className={`token-timeline-point${snapshot ? ' token-timeline-snapshot' : ''}`} role="button" tabIndex={0} aria-label={requestPointLabel(point.request, point.index)} onClick={() => inspect(point.request)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect(point.request); } }}>
              <title>{title}</title><rect className="token-point-hit" x={point.x - 10} y={TOKEN_PLOT.top - 4} width={20} height={TOKEN_PLOT.bottom - TOKEN_PLOT.top + 9} />
              <circle className="token-point-focus" cx={point.x} cy={y} r={8} />
              {snapshot ? <path className="token-point-mark" d={`M${point.x},${y - 5} l5,5 l-5,5 l-5,-5 Z`} /> : <><circle className="token-point-mark" cx={point.x} cy={y} r={3} /><circle className="token-output-mark" cx={point.x} cy={point.y('outputTokens')} r={2} /><circle className="token-cache-mark" cx={point.x} cy={point.y('cachedInputTokens')} r={2} /></>}
              {(point.index === plot.start || point.index === plot.end - 1 || (point.index + 1) % 5 === 0) && <text className="token-point-number" x={point.x} y={TOKEN_PLOT.bottom + 21} textAnchor="middle">{point.index + 1}</text>}
            </g>;
          })}
          {compactions.map(({ marker, index, x }) => <g className="token-compaction" key={marker.id}>
            <line x1={x} x2={x} y1={25} y2={TOKEN_PLOT.bottom} />
            <g className={marker.turnId ? 'token-compaction-action' : ''} role={marker.turnId ? 'button' : 'img'} tabIndex={marker.turnId ? 0 : undefined}
              aria-label={`第 ${index + 1} 次上下文压缩 · ${clock(marker.timestamp)}${marker.turnId ? '，跳到所在轮次' : '，未记录轮次'}`}
              onClick={() => { if (marker.turnId) onNavigateTurn(marker.turnId); }} onKeyDown={event => { if (marker.turnId && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onNavigateTurn(marker.turnId); } }}>
              <title>{`上下文压缩 ${clock(marker.timestamp)}\n记录边界：第 ${marker.beforeRequestIndex} 条用量记录之后${marker.turnId ? '\n跳到所在轮次' : '\n未记录所属轮次'}`}</title>
              <rect x={x - 8} y={7} width={16} height={16} rx={4} /><path d={`M${x - 3},11 l3,3 l3,-3 M${x - 3},19 l3,-3 l3,3`} />
            </g>
          </g>)}
          <text className="token-timeline-axis-title" x={TOKEN_PLOT.left} y={TOKEN_PLOT.height - 3}>用量记录序号</text>
        </svg>
      </div>
      <div className="token-timeline-pagination"><span>第 {plot.start + 1}–{plot.end} 条 / 共 {activity.requests.length.toLocaleString()} 条{plot.width > 520 ? ' · 可横向滚动' : ''}</span><div><button type="button" className="icon-button" aria-label="上一页用量记录" disabled={plot.page === 0} onClick={() => setPage(plot.page - 1)}><ChevronLeft size={15} /></button><span>{plot.page + 1} / {plot.pages}</span><button type="button" className="icon-button" aria-label="下一页用量记录" disabled={plot.page + 1 >= plot.pages} onClick={() => setPage(plot.page + 1)}><ChevronRight size={15} /></button></div></div>
    </>}
    {activity.compactions.length > 0 && <div className="token-compaction-links" aria-label="压缩事件">{(activity.requests.length ? compactions.map(item => item.marker) : activity.compactions).map(marker => <button type="button" key={marker.id} disabled={!marker.turnId} onClick={() => { if (marker.turnId) onNavigateTurn(marker.turnId); }} title={marker.turnId ? '跳到压缩所在轮次' : '日志未记录所属轮次'}><Minimize2 size={11} />{clock(marker.timestamp)} · 压缩</button>)}</div>}
    <p className="token-timeline-note">三条曲线共用同一纵轴，不叠加；缓存读取已包含在输入中。{hasSnapshots && '菱形表示累计快照差值，可能合并多个缺失调用，未连入单次调用曲线。'}压缩线表示日志记录的压缩事件，曲线下降本身不代表发生压缩。</p>
  </section>;
}
