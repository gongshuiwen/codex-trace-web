import { describe, expect, it } from 'vitest';
import type { RequestUsage } from '../shared/types';
import { compactionX, requestPointLabel, timelinePage, tokenPlot, TOKEN_PLOT } from '../client/token-timeline';

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
});
