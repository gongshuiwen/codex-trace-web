import { describe, expect, it } from 'vitest';
import type { RequestUsage } from '../shared/types';
import { latestRecordedRequest } from '../client/latest-request';

function request(id: string, turnId: string, inputTokens: number, source: RequestUsage['source'] = 'record'): RequestUsage {
  return {
    id, turnId, source, timestamp: '2026-01-01T00:00:00Z',
    usage: { inputTokens, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: inputTokens },
  };
}

describe('latestRecordedRequest', () => {
  it('selects the matching last original record in log order, including a zero input', () => {
    const last = request('last', 't1', 0);
    expect(latestRecordedRequest([request('earlier', 't2', 40), last], 0)).toBe(last);
  });

  it('does not mistake a trailing snapshot delta for the latest single call', () => {
    expect(latestRecordedRequest([request('r2', 't2', 40), request('gap', 't2', 60, 'snapshot-delta')], 40)).toBeNull();
    expect(latestRecordedRequest([request('gap', 't2', 40, 'snapshot-delta')], 40)).toBeNull();
  });

  it('does not search backwards for a same-value historical record', () => {
    expect(latestRecordedRequest([request('old', 't1', 40), request('last', 't2', 60)], 40)).toBeNull();
  });

  it('uses log order rather than turn order or timestamps', () => {
    const latest = { ...request('r3', 't1', 70), timestamp: '2025-12-31T23:59:59Z' };
    expect(latestRecordedRequest([request('r1', 't1', 20), request('r2', 't2', 40), latest], 70)).toBe(latest);
  });

  it('keeps missing usage and unlocatable records unavailable', () => {
    expect(latestRecordedRequest([], 40)).toBeNull();
    expect(latestRecordedRequest([request('r1', 't1', 40)], null)).toBeNull();
    expect(latestRecordedRequest([request('r1', '', 40)], 40)).toBeNull();
  });
});
