import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { latestInputWindowPercent, sessionDuration } from '../client/session-metrics';
import { SessionStats } from '../client/Stats';

describe('latest input window ratio', () => {
  it('uses the latest input rather than cumulative or cached token totals', () => {
    expect(latestInputWindowPercent({ latestInputTokens: 32_000, contextWindow: 128_000 })).toBe(25);
  });
  it('preserves an explicit zero and reports missing values as unknown', () => {
    expect(latestInputWindowPercent({ latestInputTokens: 0, contextWindow: 128_000 })).toBe(0);
    expect(latestInputWindowPercent({ latestInputTokens: null, contextWindow: 128_000 })).toBeNull();
    expect(latestInputWindowPercent({ latestInputTokens: 32_000, contextWindow: null })).toBeNull();
  });
  it.each([0, -1, NaN, Infinity])('rejects invalid window %s', contextWindow => {
    expect(latestInputWindowPercent({ latestInputTokens: 32_000, contextWindow })).toBeNull();
  });
  it.each([-1, NaN, Infinity])('rejects invalid input %s', latestInputTokens => {
    expect(latestInputWindowPercent({ latestInputTokens, contextWindow: 128_000 })).toBeNull();
  });
  it('keeps a recorded ratio above 100% rather than hiding it by clamping', () => {
    expect(latestInputWindowPercent({ latestInputTokens: 160_000, contextWindow: 128_000 })).toBe(125);
  });
});

describe('recorded session duration', () => {
  it.each([
    [0, '0秒'], [999, '<1秒'], [59_999, '59秒'], [60_000, '1分0秒'],
    [3_599_999, '59分59秒'], [3_600_000, '1时0分'], [86_399_999, '23时59分'],
    [86_400_000, '1天0时'], [183_600_000, '2天3时'],
  ])('formats the recorded span %s as %s', (value, expected) => {
    expect(sessionDuration(value)).toBe(expected);
  });
  it.each([null, undefined, -1, NaN, Infinity])('keeps missing or invalid duration %s unknown', value => {
    expect(sessionDuration(value)).toBe('—');
  });
});

describe('session record metric availability', () => {
  const usage = { tokens: null, requestCount: 0, completeness: 'unknown' as const, latestInputTokens: null, contextWindow: null };
  function render(compactionCount?: number, durationMs?: number | null) {
    return renderToStaticMarkup(createElement(SessionStats, { usage, toolCount: 0, toolFailureCount: 0, compactionCount, durationMs, onDetails() {} }));
  }
  it('distinguishes a zero count from missing records and disables unavailable navigation', () => {
    expect(render(0, 0)).toMatch(/data-metric="compactions" disabled=""/);
    expect(render()).toMatch(/data-metric="compactions" disabled=""/);
    expect(render(0, 0)).toContain('0秒');
    expect(render()).toContain('日志缺少有效时间');
  });
  it('enables navigation for recorded compactions and explains the duration scope', () => {
    const html = render(2, 3_600_000);
    expect(html).toMatch(/data-metric="compactions" title=/);
    expect(html).not.toMatch(/data-metric="compactions" disabled/);
    expect(html).toContain('1时0分');
    expect(html).toContain('包含等待和暂停');
    expect(html.match(/data-metric=/g)).toHaveLength(8);
  });
});
