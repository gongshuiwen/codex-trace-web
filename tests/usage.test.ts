import { describe, expect, it } from 'vitest';
import { UsageLedger, normalizeUsage } from '../server/usage.js';

const raw = (input: number, output = 10, cached = 0) => ({ input_tokens: input, output_tokens: output, total_tokens: input + output,
  cached_input_tokens: cached, reasoning_output_tokens: Math.min(5, output) });
const record = (ledger: UsageLedger, id: string, turn: string, sequence: number, input: number, cumulative: number, output = 10) => {
  ledger.ingest('token_usage_record', { response_id: id, turn_id: turn, usage: raw(input, output), thread_token_usage: raw(cumulative, output === 0 ? 0 : cumulative / input * output) }, turn, `2026-01-01T00:00:${String(sequence).padStart(2, '0')}Z`, sequence, 'test-model');
};
const snapshot = (ledger: UsageLedger, turn: string, sequence: number, cumulative: ReturnType<typeof raw>, latest = cumulative) => {
  ledger.ingest('event_msg', { type: 'token_count', info: { total_token_usage: cumulative, last_token_usage: latest, model_context_window: 1000 } }, turn,
    `2026-01-01T00:00:${String(sequence).padStart(2, '0')}Z`, sequence, 'test-model');
};

describe('usage normalization', () => {
  it('keeps cache and reasoning as subsets instead of adding them to totals', () => {
    expect(normalizeUsage(raw(100, 20, 80))).toEqual({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 80,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 5, totalTokens: 120 });
    expect(normalizeUsage({ input_tokens: 2, cached_input_tokens: 99, output_tokens: 1, reasoning_output_tokens: 99 })?.cachedInputTokens).toBe(2);
    expect(normalizeUsage(null)).toBeNull();
  });
});

describe('UsageLedger', () => {
  it('uses direct response usage once when token_count records the same cumulative totals', () => {
    const ledger = new UsageLedger();
    ledger.setContextWindow('t1', 1000);
    record(ledger, 'r1', 't1', 1, 100, 100);
    snapshot(ledger, 't1', 2, raw(100), raw(100));
    record(ledger, 'r1', 't1', 3, 100, 100);
    expect(ledger.summary().tokens?.totalTokens).toBe(110);
    expect(ledger.summary().requestCount).toBe(1);
    expect(ledger.summary().completeness).toBe('complete');
    expect(ledger.summary().latestInputTokens).toBe(100);
    expect(ledger.requestsForTurn('t1')[0]?.contextWindow).toBe(1000);
  });

  it('also deduplicates a snapshot written before its corresponding direct record', () => {
    const ledger = new UsageLedger();
    snapshot(ledger, 't1', 1, raw(100));
    record(ledger, 'r1', 't1', 2, 100, 100);
    expect(ledger.summary().tokens?.totalTokens).toBe(110);
    expect(ledger.summary().requestCount).toBe(1);
  });

  it('separates session totals, each turn, and the most recent request input', () => {
    const ledger = new UsageLedger();
    ledger.ingest('token_usage_record', { response_id: 'r1', turn_id: 't1', usage: raw(100), thread_token_usage: raw(100) }, 't1', '2026-01-01T00:00:01Z', 1);
    snapshot(ledger, 't1', 2, raw(100));
    ledger.ingest('token_usage_record', { response_id: 'r2', turn_id: 't2', usage: raw(150, 20), thread_token_usage: raw(250, 30) }, 't2', '2026-01-01T00:00:03Z', 3);
    snapshot(ledger, 't2', 4, raw(250, 30), raw(150, 20));
    expect(ledger.summary().tokens?.totalTokens).toBe(280);
    expect(ledger.summary('t1').tokens?.totalTokens).toBe(110);
    expect(ledger.summary('t2').tokens?.totalTokens).toBe(170);
    expect(ledger.summary().latestInputTokens).toBe(150);
  });

  it('falls back to cumulative deltas and does not add repeated snapshots', () => {
    const ledger = new UsageLedger();
    snapshot(ledger, 't1', 1, raw(100));
    snapshot(ledger, 't1', 2, raw(100));
    snapshot(ledger, 't2', 3, raw(250, 30), raw(150, 20));
    expect(ledger.summary().tokens?.totalTokens).toBe(280);
    expect(ledger.summary('t2').tokens?.totalTokens).toBe(170);
    expect(ledger.summary().completeness).toBe('partial');
    expect(ledger.summary().latestInputTokens).toBe(150);
  });

  it('fills only usage not covered by direct records in mixed logs', () => {
    const ledger = new UsageLedger();
    ledger.ingest('token_usage_record', { response_id: 'r1', turn_id: 't1', usage: raw(100), thread_token_usage: raw(100) }, 't1', '2026-01-01T00:00:01Z', 1);
    snapshot(ledger, 't1', 2, raw(100));
    snapshot(ledger, 't1', 3, raw(250, 30), raw(150, 20));
    expect(ledger.summary().tokens?.totalTokens).toBe(280);
    expect(ledger.summary().requestCount).toBe(2);
  });

  it('handles counter reset without negative usage or losing the earlier epoch', () => {
    const ledger = new UsageLedger();
    snapshot(ledger, 't1', 1, raw(100));
    snapshot(ledger, 't2', 2, raw(40));
    expect(ledger.summary().tokens?.totalTokens).toBe(160);
    expect(ledger.summary('t2').tokens?.inputTokens).toBe(40);
    expect(ledger.summary().completeness).toBe('partial');
  });

  it('fills a gap inside the direct-record cumulative history exactly once', () => {
    const ledger = new UsageLedger();
    ledger.ingest('token_usage_record', { response_id: 'r1', turn_id: 't1', usage: raw(100, 10), thread_token_usage: raw(100, 10) }, 't1', '2026-01-01T00:00:01Z', 1);
    snapshot(ledger, 't1', 2, raw(100, 10));
    ledger.ingest('token_usage_record', { response_id: 'r2', turn_id: 't2', usage: raw(40, 5), thread_token_usage: raw(200, 25) }, 't2', '2026-01-01T00:00:03Z', 3);
    snapshot(ledger, 't2', 4, raw(200, 25), raw(40, 5));
    expect(ledger.summary().tokens?.totalTokens).toBe(225);
    expect(ledger.summary('t2').tokens?.totalTokens).toBe(115);
    expect(ledger.requestsForTurn('t2').map(request => [request.source, request.usage.totalTokens])).toEqual([['record', 45], ['snapshot-delta', 70]]);
  });

  it('backfills model context windows from later token_count events', () => {
    const ledger = new UsageLedger();
    record(ledger, 'r1', 't1', 1, 100, 100);
    snapshot(ledger, 't1', 2, raw(100));
    expect(ledger.requestsForTurn('t1')[0]?.contextWindow).toBe(1000);
  });

  it('reports missing usage as unknown', () => {
    const ledger = new UsageLedger();
    expect(ledger.summary()).toEqual({ tokens: null, requestCount: 0, completeness: 'unknown', latestInputTokens: null, contextWindow: null });
  });
});
