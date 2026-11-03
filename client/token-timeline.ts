import type { RequestUsage } from '../shared/types';

export const TOKEN_TIMELINE_PAGE_SIZE = 100;
export const TOKEN_PLOT = { left: 52, top: 34, bottom: 170, step: 24, height: 210 };
export type TokenSeries = 'inputTokens' | 'outputTokens' | 'cachedInputTokens';

export function timelinePage(total: number, page: number) {
  const pages = Math.max(1, Math.ceil(total / TOKEN_TIMELINE_PAGE_SIZE));
  const current = Math.min(pages - 1, Math.max(0, Math.trunc(page)));
  const start = current * TOKEN_TIMELINE_PAGE_SIZE;
  return { page: current, pages, start, end: Math.min(total, start + TOKEN_TIMELINE_PAGE_SIZE) };
}

export function tokenPlot(requests: RequestUsage[], page = 0) {
  const range = timelinePage(requests.length, page);
  const entries = requests.slice(range.start, range.end);
  const maximum = Math.max(1, ...entries.flatMap(request => [request.usage.inputTokens, request.usage.outputTokens, request.usage.cachedInputTokens]));
  const width = Math.max(520, TOKEN_PLOT.left + entries.length * TOKEN_PLOT.step + 24);
  const points = entries.map((request, offset) => ({
    request, index: range.start + offset,
    x: TOKEN_PLOT.left + (offset + 0.5) * TOKEN_PLOT.step,
    y: (series: TokenSeries) => TOKEN_PLOT.bottom - request.usage[series] / maximum * (TOKEN_PLOT.bottom - TOKEN_PLOT.top),
  }));
  // Snapshot deltas may combine missing calls. They stay visible as diamonds,
  // but must not masquerade as single-call points on any of the three lines.
  function line(series: TokenSeries) {
    let connected = false;
    return points.map(point => {
      if (point.request.source !== 'record') { connected = false; return ''; }
      const command = connected ? 'L' : 'M'; connected = true;
      return `${command}${point.x.toFixed(1)},${point.y(series).toFixed(1)}`;
    }).filter(Boolean).join(' ');
  }
  return { ...range, points, maximum, width, line };
}

export function compactionX(beforeRequestIndex: number, range: { start: number; end: number }): number | null {
  if (!Number.isInteger(beforeRequestIndex) || beforeRequestIndex < range.start || beforeRequestIndex > range.end) return null;
  return TOKEN_PLOT.left + (beforeRequestIndex - range.start) * TOKEN_PLOT.step;
}

export function requestPointLabel(request: RequestUsage, index: number): string {
  const source = request.source === 'record' ? '模型调用' : '累计快照差值，可能包含多个缺失调用';
  return `第 ${index + 1} 条 · ${source} · 输入 ${request.usage.inputTokens.toLocaleString('zh-CN')} · 输出 ${request.usage.outputTokens.toLocaleString('zh-CN')} · 缓存读取 ${request.usage.cachedInputTokens.toLocaleString('zh-CN')}（输入子集）`;
}
