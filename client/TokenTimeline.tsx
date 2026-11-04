import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, Minimize2 } from 'lucide-react';
import type { SessionActivity } from '../shared/types';
import { clock, tokens } from './format';
import { compactionX, nearestRequestIndex, requestPointLabel, tokenPlot, TOKEN_PLOT, TOKEN_TIMELINE_PAGE_SIZE } from './token-timeline';
import type { TokenMetric, TokenSeries } from './token-timeline';
import './TokenTimeline.css';

const metrics = [
  ['all', '全部用量'], ['inputTokens', '输入'], ['outputTokens', '输出'], ['cachedInputTokens', '缓存读取'],
] as const;
const series = [
  ['inputTokens', '输入', 'token-series-input'],
  ['outputTokens', '输出', 'token-series-output'],
  ['cachedInputTokens', '缓存读取（输入子集）', 'token-series-cache'],
] as const;
const tokenIconButton = 'token-icon-button';

export function TokenTimeline({ activity, selectedId, onSelectRequest, onNavigateTurn }: {
  activity: SessionActivity;
  selectedId: string | null; onSelectRequest: (requestId: string) => void;
  onNavigateTurn: (turnId: string) => void;
}) {
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<'overview' | 'detail'>('overview');
  const [metric, setMetric] = useState<TokenMetric>('all');
  const [width, setWidth] = useState(480);
  const chartRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<{ id: string; index: number } | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  useEffect(() => () => { if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current); }, []);
  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [activity.requests.length === 0]);
  const plot = useMemo(() => tokenPlot(activity.requests, page, { mode, width, metric }), [activity.requests, page, mode, width, metric]);
  const selectedIndex = activity.requests.findIndex(request => request.id === selectedId);
  const selected = selectedIndex >= 0 ? { index: selectedIndex, request: activity.requests[selectedIndex] } : null;
  const compactions = activity.compactions.flatMap((marker, index) => {
    const x = compactionX(marker.beforeRequestIndex, plot);
    return x == null ? [] : [{ marker, index, x }];
  });
  const visibleSeries = series.filter(([field]) => metric === 'all' || metric === field);
  const primarySeries: TokenSeries = metric === 'all' ? 'inputTokens' : metric;
  const hasSnapshots = activity.requests.some(request => request.source === 'snapshot-delta');
  useEffect(() => {
    const index = activity.requests.findIndex(request => request.id === selectedId);
    if (mode === 'detail' && index >= 0) setPage(Math.floor(index / TOKEN_TIMELINE_PAGE_SIZE));
  }, [selectedId, mode, activity.requests]);
  function revealPoint(index: number) {
    const chart = chartRef.current;
    const point = chart?.querySelector<SVGGElement>(`[data-request-index="${index}"]`);
    if (!chart || !point) return;
    const pointRect = point.getBoundingClientRect();
    const chartRect = chart.getBoundingClientRect();
    const edge = 12;
    // Scroll the horizontal plot only: scrollIntoView also moves the surrounding
    // overview (and can hide its title) when keyboard navigation crosses a page.
    if (pointRect.left < chartRect.left + edge) chart.scrollBy({ left: pointRect.left - chartRect.left - edge });
    else if (pointRect.right > chartRect.right - edge) chart.scrollBy({ left: pointRect.right - chartRect.right + edge });
  }
  const selectIndex = (index: number) => {
    const request = activity.requests[index];
    if (request) {
      // Keyboard intent is synchronous, while the roving DOM focus is deferred.
      // Enter (or another arrow) before the next frame must use this new record.
      cursorRef.current = { id: request.id, index };
      if (request.id !== selectedId) onSelectRequest(request.id);
      if (mode === 'detail') {
        setPage(Math.floor(index / TOKEN_TIMELINE_PAGE_SIZE));
        requestAnimationFrame(() => revealPoint(index));
      }
    }
  };
  function revealDetails(index: number) {
    selectIndex(index);
    const details = document.querySelector<HTMLElement>('.usage-calls');
    if (details) { details.tabIndex = -1; details.focus({ preventScroll: true }); details.scrollIntoView({ block: 'start' }); }
  }
  function movePoint(event: KeyboardEvent<SVGGElement>, index: number) {
    const cursor = cursorRef.current;
    const current = cursor && activity.requests[cursor.index]?.id === cursor.id ? cursor.index : index;
    const next = event.key === 'ArrowRight' ? current + 1 : event.key === 'ArrowLeft' ? current - 1
      : event.key === 'Home' ? 0 : event.key === 'End' ? activity.requests.length - 1 : null;
    if (next === null) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        // Enter can arrive before the deferred arrow-key focus update.
        const point = event.currentTarget.ownerSVGElement?.querySelector<SVGGElement>(`[data-request-index="${current}"]`);
        // A dense overview or a page change may not have mounted the point yet.
        // Restoring the chart avoids reselecting the old call through onFocus.
        (point ?? chartRef.current)?.focus({ preventScroll: true });
        revealDetails(current);
      }
      return;
    }
    event.preventDefault();
    const target = Math.min(activity.requests.length - 1, Math.max(0, next));
    const svg = event.currentTarget.ownerSVGElement;
    selectIndex(target);
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      if (cursorRef.current?.index !== target) return;
      const point = svg?.querySelector<SVGGElement>(`[data-request-index="${target}"]`);
      point?.focus({ preventScroll: true });
    });
  }
  // Every record remains in the paths. Dense overviews use a single movable
  // cursor rather than thousands of overlapping hit targets; detail exposes each call.
  const markedPoints = mode === 'overview' && plot.points.length > 200
    ? plot.points.filter(point => point.index === selected?.index || point.request.source !== 'record')
    : plot.points;
  return <section className="token-timeline" aria-label="调用趋势与压缩时间轴">
    <div className="token-timeline-controls">
      {activity.requests.length > 0 && <div className="token-timeline-modes" aria-label="趋势图范围">{([['overview', '全局概览'], ['detail', '逐次记录']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={mode === id} onClick={() => { if (selected) { selectIndex(selected.index); if (id === 'detail') setPage(Math.floor(selected.index / TOKEN_TIMELINE_PAGE_SIZE)); } setMode(id); }}>{label}</button>)}</div>}
      <div className="token-timeline-summary">
        <p className="token-record-count"><span>{activity.requests.length.toLocaleString()} 条记录</span><span>{activity.compactions.length.toLocaleString()} 次压缩</span></p>
        {activity.requests.length > 0 && <select className="token-metric-control" aria-label="图表用量指标" value={metric} onChange={event => setMetric(event.target.value as TokenMetric)}>{metrics.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>}
      </div>
    </div>
    {activity.requests.length === 0 ? <div className="token-timeline-empty"><div className="token-empty-axis" aria-hidden="true" /><p>没有可绘制的模型调用用量记录。</p></div> : <>
      <div className="token-timeline-legend">{metric === 'all' && visibleSeries.map(([field, label, className]) => <span key={field}><i className={className} />{label}</span>)}{activity.compactions.length > 0 && <span className="token-compaction-legend"><Minimize2 size={13} />压缩断点</span>}{hasSnapshots && <span className="token-snapshot-legend">◇ 累计差值</span>}</div>
      <div ref={chartRef} tabIndex={-1} className={`token-timeline-scroll token-timeline-${mode}`} aria-label={mode === 'overview' ? '全部调用趋势' : '逐次调用趋势，可横向滚动'} onFocus={event => {
        if (event.target !== event.currentTarget || !cursorRef.current) return;
        // A page change may mount the selected point after the focus update.
        event.currentTarget.querySelector<SVGGElement>(`[data-request-index="${cursorRef.current.index}"]`)?.focus({ preventScroll: true });
      }}>
        <svg className="token-timeline-plot" width={plot.width} height={TOKEN_PLOT.height} viewBox={`0 0 ${plot.width} ${TOKEN_PLOT.height}`} role="group" aria-label="按日志记录顺序排列的 Token 趋势。左右方向键选择调用，回车查看明细。" onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          const index = nearestRequestIndex((event.clientX - rect.left) * plot.width / rect.width, plot);
          if (index !== null) selectIndex(index);
        }}>
          {[3, 2, 1, 0].map(part => {
            const y = TOKEN_PLOT.bottom - part / 3 * (TOKEN_PLOT.bottom - TOKEN_PLOT.top);
            return <g key={part} className="token-timeline-axis"><line x1={TOKEN_PLOT.left} x2={plot.width - 20} y1={y} y2={y} /><text x={TOKEN_PLOT.left - 9} y={y + 4} textAnchor="end">{tokens(Math.round(plot.maximum * part / 3))}</text></g>;
          })}
          {visibleSeries.map(([field, , className]) => <path key={field} className={`token-series-line ${className}`} d={plot.line(field)} />)}
          {markedPoints.map(point => {
            const y = point.y(primarySeries);
            const snapshot = point.request.source !== 'record';
            const isSelected = point.index === selected?.index;
            return <g key={point.request.id} data-request-index={point.index} className={`token-timeline-point${snapshot ? ' token-timeline-snapshot' : ''}${isSelected ? ' selected' : ''}`} role="button" tabIndex={isSelected || !selected && point.index === 0 ? 0 : -1} aria-label={requestPointLabel(point.request, point.index)} aria-pressed={isSelected} onFocus={() => selectIndex(point.index)} onClick={event => { event.stopPropagation(); revealDetails(point.index); }} onKeyDown={event => movePoint(event, point.index)}>
              <title>{`${requestPointLabel(point.request, point.index)}\n${clock(point.request.timestamp)} · ${point.request.model || '模型未记录'}\n查看调用明细`}</title><rect className="token-point-hit" x={point.x - Math.min(12, plot.step / 2)} y={TOKEN_PLOT.top - 4} width={Math.min(24, plot.step)} height={TOKEN_PLOT.bottom - TOKEN_PLOT.top + 9} />
              {isSelected && <line className="token-point-cursor" x1={point.x} x2={point.x} y1={TOKEN_PLOT.top} y2={TOKEN_PLOT.bottom} />}
              <circle className="token-point-focus" cx={point.x} cy={y} r={7} />
              {snapshot ? <path className="token-point-mark" d={`M${point.x},${y - 5} l5,5 l-5,5 l-5,-5 Z`} /> : visibleSeries.map(([field, , className]) => <circle key={field} className={`token-point-mark ${className}`} cx={point.x} cy={point.y(field)} r={isSelected ? 3.5 : 2} />)}
            </g>;
          })}
          {plot.points.filter(point => plot.labels.has(point.index)).map(point => <text key={point.index} className="token-point-number" x={point.x} y={TOKEN_PLOT.bottom + 21} textAnchor="middle">{point.index + 1}</text>)}
          {compactions.map(({ marker, index, x }) => <g className="token-compaction" key={marker.id}>
            <rect className="token-compaction-band" x={x - 3} y={28} width={6} height={TOKEN_PLOT.bottom - 28} />
            <line x1={x} x2={x} y1={28} y2={TOKEN_PLOT.bottom} />
            <g className={marker.turnId ? 'token-compaction-action' : ''} role={marker.turnId ? 'button' : 'img'} tabIndex={marker.turnId ? 0 : undefined}
              aria-label={`第 ${index + 1} 次上下文压缩 · ${clock(marker.timestamp)}${marker.turnId ? '，跳到所在轮次' : '，未记录轮次'}`}
              onClick={event => { event.stopPropagation(); if (marker.turnId) onNavigateTurn(marker.turnId); }} onKeyDown={event => { if (marker.turnId && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onNavigateTurn(marker.turnId); } }}>
              <title>{`上下文压缩 ${clock(marker.timestamp)}\n记录边界：第 ${marker.beforeRequestIndex} 条用量记录之后${marker.turnId ? '\n跳到所在轮次' : '\n未记录所属轮次'}`}</title>
              <rect className="token-compaction-hit" x={x - 18} y={0} width={36} height={30} /><rect className="token-compaction-label" x={x - 9} y={7} width={18} height={18} rx={2} /><path d={`M${x - 3},12 l3,3 l3,-3 M${x - 3},20 l3,-3 l3,3`} />
            </g>
          </g>)}
          <text className="token-timeline-axis-title" x={TOKEN_PLOT.left} y={TOKEN_PLOT.height - 3}>用量记录序号</text>
        </svg>
      </div>
      <div className="token-timeline-pagination"><span>{mode === 'overview' ? `全部 ${activity.requests.length.toLocaleString()} 条 · 按日志顺序` : `第 ${plot.start + 1}–${plot.end} 条 / 共 ${activity.requests.length.toLocaleString()} 条${plot.width > width ? ' · 可横向滚动' : ''}`}</span>{mode === 'detail' && <div><button type="button" className={tokenIconButton} aria-label="上一页用量记录" disabled={plot.page === 0} onClick={() => selectIndex((plot.page - 1) * TOKEN_TIMELINE_PAGE_SIZE)}><ChevronLeft size={16} /></button><span>{plot.page + 1} / {plot.pages}</span><button type="button" className={tokenIconButton} aria-label="下一页用量记录" disabled={plot.page + 1 >= plot.pages} onClick={() => selectIndex((plot.page + 1) * TOKEN_TIMELINE_PAGE_SIZE)}><ChevronRight size={16} /></button></div>}</div>
    </>}
    {activity.compactions.length > 0 && <details className="token-compaction-events"><summary>压缩事件 <span>{activity.compactions.length.toLocaleString()} 次</span></summary><div className="token-compaction-links" aria-label="压缩事件">{activity.compactions.map(marker => <button type="button" key={marker.id} disabled={!marker.turnId} onClick={() => { if (marker.turnId) onNavigateTurn(marker.turnId); }} title={marker.turnId ? '跳到压缩所在轮次' : '日志未记录所属轮次'}><Minimize2 size={13} /><time>{clock(marker.timestamp)}</time><span>第 {marker.beforeRequestIndex} 条之后</span><ChevronRight size={14} /></button>)}</div></details>}
    <details className="token-timeline-note">
      <summary><ChevronRight size={13} aria-hidden="true" />统计口径</summary>
      <div>
        <p>缓存读取包含在输入中，用量不叠加。</p>
        {hasSnapshots && <p>菱形为累计快照差值，可能包含多个缺失调用，不连入单次调用曲线。</p>}
        <p>压缩标记来自日志事件，曲线下降本身不代表发生压缩。</p>
      </div>
    </details>
  </section>;
}
