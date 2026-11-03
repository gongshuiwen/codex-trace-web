import { describe, expect, it } from 'vitest';
import type { RequestUsage } from '../shared/types';
import { compactionX, nearestRequestIndex, requestPointLabel, timelinePage, tokenPlot, TOKEN_PLOT } from '../client/token-timeline';

const request = (id: string, input: number, output = 20, cache = 0, source: RequestUsage['source'] = 'record'): RequestUsage => ({
  id, turnId: 't1', timestamp: '2026-01-01T00:00:00Z', source,
  usage: { inputTokens: input, outputTokens: output, cachedInputTokens: cache, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: input + output },
});

describe('token timeline geometry', () => {
  it('shows cache as an input subset on the same axis, without stacking it', () => {
    const plot = tokenPlot([request('r1', 100, 20, 80)]);
    expect(plot.maximum).toBe(100);
    expect(plot.points[0]!.y('inputTokens')).toBe(TOKEN_PLOT.top);
    expect(plot.points[0]!.y('cachedInputTokens')).toBeGreaterThan(plot.points[0]!.y('inputTokens'));
    expect(plot.points[0]!.y('outputTokens')).toBeGreaterThan(plot.points[0]!.y('cachedInputTokens'));
  });

  it('uses supplied log order even when timestamps are identical or out of order', () => {
    const values = [request('later', 100), { ...request('earlier', 80), timestamp: '2025-01-01T00:00:00Z' }];
    expect(tokenPlot(values).points.map(point => point.request.id)).toEqual(['later', 'earlier']);
  });

  it('keeps snapshot deltas visible but breaks all real-call curves across them', () => {
    const plot = tokenPlot([request('r1', 100), request('delta', 2000, 200, 50, 'snapshot-delta'), request('r2', 120)]);
    expect(plot.points).toHaveLength(3);
    expect(plot.line('inputTokens').match(/M/g)).toHaveLength(2);
    expect(plot.line('inputTokens')).not.toContain('L');
    expect(requestPointLabel(plot.points[1]!.request, 1)).toContain('累计快照差值');
  });

  it('positions compression events by an exact request boundary, independent of timestamps', () => {
    const range = { start: 100, end: 200 };
    expect(compactionX(100, range)).toBe(TOKEN_PLOT.left);
    expect(compactionX(101, range)).toBe(TOKEN_PLOT.left + TOKEN_PLOT.step);
    expect(compactionX(200, range)).toBe(TOKEN_PLOT.left + 100 * TOKEN_PLOT.step);
    expect(compactionX(99, range)).toBeNull();
    expect(compactionX(201, range)).toBeNull();
  });

  it('exposes every point of a long session through bounded pages without silent omissions', () => {
    const values = Array.from({ length: 1005 }, (_, index) => request(`r${index}`, index));
    const ids = Array.from({ length: timelinePage(values.length, 0).pages }, (_, page) => tokenPlot(values, page).points.map(point => point.request.id)).flat();
    expect(ids).toEqual(values.map(item => item.id));
    expect(new Set(ids).size).toBe(1005);
    expect(timelinePage(values.length, 999)).toMatchObject({ page: 10, start: 1000, end: 1005 });
  });

  it('keeps empty and zero-valued sessions finite', () => {
    const empty = tokenPlot([]);
    expect(empty.points).toEqual([]);
    expect(empty.line('inputTokens')).toBe('');
    expect(Number.isFinite(tokenPlot([request('zero', 0, 0)]).points[0]!.y('inputTokens'))).toBe(true);
  });

  it('fits the entire log and every compression boundary inside a phone overview', () => {
    const values = Array.from({ length: 1005 }, (_, index) => request(`r${index}`, index));
    const plot = tokenPlot(values, 0, { mode: 'overview', width: 350 });
    expect(plot.width).toBe(350);
    expect(plot.points.map(point => point.request.id)).toEqual(values.map(item => item.id));
    for (const boundary of [0, 1, 99, 100, 500, 1004, 1005]) {
      const x = compactionX(boundary, plot)!;
      expect(x).toBeGreaterThanOrEqual(TOKEN_PLOT.left);
      expect(x).toBeLessThanOrEqual(plot.width - 20);
    }
    expect(plot.points.at(-1)!.x).toBeLessThan(plot.width - 20);
    expect(plot.labels.size).toBeLessThanOrEqual(4);
    expect(plot.labels.has(0)).toBe(true);
    expect(plot.labels.has(1004)).toBe(true);
  });

  it('recomputes coordinates when the same overview narrows for an open inspector', () => {
    const values = [request('r1', 100), request('r2', 120), request('r3', 140)];
    const wide = tokenPlot(values, 0, { mode: 'overview', width: 1000 });
    const narrow = tokenPlot(values, 0, { mode: 'overview', width: 600 });
    expect(compactionX(3, wide)).toBe(980);
    expect(compactionX(3, narrow)).toBe(580);
    expect(narrow.points[2]!.x).toBeLessThan(wide.points[2]!.x);
    expect(narrow.points.map(point => point.request.id)).toEqual(wide.points.map(point => point.request.id));
  });

  it('uses the selected output metric for its scale instead of flattening it under inputs', () => {
    const values = [request('r1', 100000, 20, 90000), request('r2', 120000, 40, 100000)];
    const all = tokenPlot(values, 0, { mode: 'overview', width: 350, metric: 'all' });
    const output = tokenPlot(values, 0, { mode: 'overview', width: 350, metric: 'outputTokens' });
    expect(output.maximum).toBeGreaterThan(40);
    expect(output.maximum).toBeLessThan(100);
    expect(all.points[1]!.y('outputTokens')).toBeGreaterThan(TOKEN_PLOT.bottom - 1);
    expect(output.points[1]!.y('outputTokens')).toBeLessThan(TOKEN_PLOT.bottom - 70);
  });

  it('selects exact nearest records and clamps edge clicks without dropping long-session calls', () => {
    const values = Array.from({ length: 1005 }, (_, index) => request(`r${index}`, index));
    const plot = tokenPlot(values, 0, { mode: 'overview', width: 350 });
    for (const index of [0, 99, 500, 1004]) expect(nearestRequestIndex(plot.points[index]!.x, plot)).toBe(index);
    expect(nearestRequestIndex(-100, plot)).toBe(0);
    expect(nearestRequestIndex(10000, plot)).toBe(1004);
    expect(nearestRequestIndex(100, tokenPlot([], 0, { mode: 'overview', width: 350 }))).toBeNull();
  });
});
