import type { RequestUsage } from '../shared/types';

export const TOKEN_TIMELINE_PAGE_SIZE = 100;
export const TOKEN_PLOT = { left: 56, top: 36, bottom: 190, step: 24, height: 234 };
export type TokenSeries = 'inputTokens' | 'outputTokens' | 'cachedInputTokens';
export type TokenMetric = 'all' | TokenSeries;
export interface TokenPlotOptions {
  mode: 'overview' | 'detail';
  width: number;
  metric?: TokenMetric;
}

export function timelinePage(total: number, page: number) {
  const pages = Math.max(1, Math.ceil(total / TOKEN_TIMELINE_PAGE_SIZE));
  const current = Math.min(pages - 1, Math.max(0, Math.trunc(page)));
  const start = current * TOKEN_TIMELINE_PAGE_SIZE;
  return { page: current, pages, start, end: Math.min(total, start + TOKEN_TIMELINE_PAGE_SIZE) };
}

export function tokenPlot(requests: RequestUsage[], page = 0, options?: TokenPlotOptions) {
  const range = options?.mode === 'overview'
    ? { page: 0, pages: 1, start: 0, end: requests.length }
    : timelinePage(requests.length, page);
  const entries = requests.slice(range.start, range.end);
  const series: TokenSeries[] = options?.metric && options.metric !== 'all'
    ? [options.metric] : ['inputTokens', 'outputTokens', 'cachedInputTokens'];
  let maximum = 1;
  for (const request of entries) for (const field of series) maximum = Math.max(maximum, request.usage[field]);
  // Use an evenly spaced scale with room above the largest recorded value.
  // Keep the original helper's scale for consumers that do not request a viewport.
  if (options) {
    const rawStep = maximum * 1.05 / 3;
    const unit = 10 ** Math.floor(Math.log10(rawStep));
    const step = [1, 2, 2.5, 5, 10].find(value => value * unit >= rawStep)! * unit;
    maximum = Math.max(3, step * 3);
  }
  const availableWidth = Math.max(240, options?.width ?? 520);
  const width = options?.mode === 'overview' ? availableWidth
    : Math.max(availableWidth, TOKEN_PLOT.left + entries.length * TOKEN_PLOT.step + 24);
  const step = options?.mode === 'overview'
    ? (width - TOKEN_PLOT.left - 20) / Math.max(1, entries.length)
    : TOKEN_PLOT.step;
  const points = entries.map((request, offset) => ({
    request, index: range.start + offset,
    x: TOKEN_PLOT.left + (offset + 0.5) * step,
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
  const labelCount = Math.max(2, Math.min(7, Math.floor((width - TOKEN_PLOT.left - 20) / 76) + 1));
  const actualLabelCount = Math.min(labelCount, points.length);
  const labels = new Set(Array.from({ length: actualLabelCount }, (_, index) =>
    range.start + Math.round(index * (points.length - 1) / Math.max(1, actualLabelCount - 1))));
  return { ...range, points, maximum, width, step, labels, line };
}

export function compactionX(beforeRequestIndex: number, range: { start: number; end: number; step?: number }): number | null {
  if (!Number.isInteger(beforeRequestIndex) || beforeRequestIndex < range.start || beforeRequestIndex > range.end) return null;
  return TOKEN_PLOT.left + (beforeRequestIndex - range.start) * (range.step ?? TOKEN_PLOT.step);
}

export function nearestRequestIndex(x: number, range: { start: number; end: number; step: number }): number | null {
  if (range.end <= range.start) return null;
  return Math.min(range.end - 1, Math.max(range.start, range.start + Math.floor((x - TOKEN_PLOT.left) / range.step)));
}

export function requestPointLabel(request: RequestUsage, index: number): string {
  const source = request.source === 'record' ? '模型调用' : '累计快照差值，可能包含多个缺失调用';
  return `第 ${index + 1} 条 · ${source} · 输入 ${request.usage.inputTokens.toLocaleString('zh-CN')} · 输出 ${request.usage.outputTokens.toLocaleString('zh-CN')} · 缓存读取 ${request.usage.cachedInputTokens.toLocaleString('zh-CN')}（输入子集）`;
}
