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

  it('keeps a record window unknown when it was only recorded by a later token_count', () => {
    const ledger = new UsageLedger();
    record(ledger, 'r1', 't1', 1, 100, 100);
    snapshot(ledger, 't1', 2, raw(100));
    expect(ledger.requestsForTurn('t1')[0]?.contextWindow).toBeUndefined();
    expect(ledger.summary()).toMatchObject({latestInputTokens:100,contextWindow:1000});
  });

  it('reports missing usage as unknown', () => {
    const ledger = new UsageLedger();
    expect(ledger.summary()).toEqual({ tokens: null, requestCount: 0, completeness: 'unknown', latestInputTokens: null, contextWindow: null });
  });
});

describe('latest input and context window pairing', () => {
  const time = (sequence: number) => `2026-01-01T00:00:${String(sequence).padStart(2,'0')}Z`;
  function direct(ledger: UsageLedger, id: string, turnId: string, sequence: number, usage: Record<string, unknown>, model = 'model-a', timestamp = time(sequence)) {
    ledger.ingest('token_usage_record',{response_id:id,turn_id:turnId,usage},turnId,timestamp,sequence,model);
  }
  function count(ledger: UsageLedger, turnId: string, sequence: number, cumulative: Record<string, unknown>, latest?: Record<string, unknown>, window?: number, model = 'model-a') {
    ledger.ingest('event_msg',{type:'token_count',info:{total_token_usage:cumulative,last_token_usage:latest,model_context_window:window}},turnId,time(sequence),sequence,model);
  }

  it('pairs a newer direct record with its own 256K window instead of an older 128K snapshot', () => {
    const ledger = new UsageLedger();
    count(ledger,'old-turn',1,raw(100),raw(100),128000,'model-a');
    ledger.setContextWindow('new-turn',256000);
    direct(ledger,'new-call','new-turn',2,raw(150),'model-b');
    expect(ledger.summary()).toMatchObject({latestInputTokens:150,contextWindow:256000});
    expect(ledger.summary('old-turn')).toMatchObject({latestInputTokens:100,contextWindow:128000});
  });

  it('pairs the selected latest snapshot input with its window rather than a direct record window', () => {
    const ledger = new UsageLedger();
    ledger.setContextWindow('old-turn',128000);
    direct(ledger,'old-call','old-turn',1,raw(100));
    count(ledger,'new-turn',2,raw(250,30),raw(150,20),256000,'model-b');
    expect(ledger.summary()).toMatchObject({latestInputTokens:150,contextWindow:256000});
  });

  it('does not borrow an old source window when the selected record or snapshot has none', () => {
    const recordLedger = new UsageLedger();
    count(recordLedger,'old-turn',1,raw(100),raw(100),128000);
    direct(recordLedger,'new-call','new-turn',2,raw(150),'model-b');
    expect(recordLedger.summary()).toMatchObject({latestInputTokens:150,contextWindow:null});

    const snapshotLedger = new UsageLedger();
    snapshotLedger.setContextWindow('old-turn',128000);
    direct(snapshotLedger,'old-call','old-turn',1,raw(100));
    count(snapshotLedger,'new-turn',2,raw(250,30),raw(150,20),undefined,'model-b');
    expect(snapshotLedger.summary()).toMatchObject({latestInputTokens:150,contextWindow:null});
  });

  it('freezes windows at record time across model changes within the same turn', () => {
    const ledger = new UsageLedger();
    ledger.setContextWindow('turn',128000);
    direct(ledger,'a','turn',1,raw(100),'model-a');
    ledger.setContextWindow('turn',256000);
    direct(ledger,'b','turn',2,raw(150),'model-b');
    ledger.setContextWindow('turn',512000);
    expect(ledger.requestsForTurn('turn').map(request=>request.contextWindow)).toEqual([128000,256000]);
    expect(ledger.summary()).toMatchObject({latestInputTokens:150,contextWindow:256000,completeness:'complete'});
    expect(ledger.summary().tokens?.totalTokens).toBe(270);
  });

  it('does not assign a previous model window to a new model without a new window record', () => {
    const ledger = new UsageLedger();
    ledger.setContextWindow('turn',128000);
    direct(ledger,'a','turn',1,raw(100),'model-a');
    direct(ledger,'b','turn',2,raw(150),'model-b');
    expect(ledger.requestsForTurn('turn').map(request=>request.contextWindow)).toEqual([128000,undefined]);
    expect(ledger.summary()).toMatchObject({latestInputTokens:150,contextWindow:null});
    ledger.setContextWindow('turn',256000);
    expect(ledger.requestsForTurn('turn')[1]?.contextWindow).toBeUndefined();
    expect(ledger.summary().contextWindow).toBeNull();
  });

  it('selects the last recorded source by file order even when its timestamp goes backward', () => {
    const ledger = new UsageLedger();
    count(ledger,'old-turn',5,raw(100),raw(100),128000);
    ledger.setContextWindow('new-turn',256000);
    direct(ledger,'new-call','new-turn',6,raw(150),'model-b',time(1));
    expect(ledger.summary()).toMatchObject({latestInputTokens:150,contextWindow:256000});
  });

  it.each([
    {label:'explicit snake-case zero',usage:{input_tokens:0,output_tokens:10,total_tokens:10},expected:0},
    {label:'explicit camel-case zero',usage:{inputTokens:0,outputTokens:10,totalTokens:10},expected:0},
    {label:'missing input with output',usage:{output_tokens:10,total_tokens:10},expected:null},
    {label:'missing input with only a total',usage:{total_tokens:10},expected:null},
    {label:'invalid non-finite input',usage:{input_tokens:Infinity,output_tokens:10,total_tokens:10},expected:null},
  ])('distinguishes $label for direct records and snapshots', ({usage,expected}) => {
    const recordLedger = new UsageLedger();
    recordLedger.setContextWindow('turn',128000);
    direct(recordLedger,'call','turn',1,usage);
    expect(recordLedger.summary()).toMatchObject({latestInputTokens:expected,contextWindow:128000});
    expect(recordLedger.summary().tokens?.totalTokens).toBe(10);

    const snapshotLedger = new UsageLedger();
    count(snapshotLedger,'turn',1,raw(100),usage,128000);
    expect(snapshotLedger.summary()).toMatchObject({latestInputTokens:expected,contextWindow:128000});
    expect(snapshotLedger.summary().tokens?.totalTokens).toBe(110);
  });

  it('keeps latest input unknown when a newer snapshot lacks last-call input instead of using its cumulative delta', () => {
    const ledger = new UsageLedger();
    ledger.setContextWindow('turn',128000);
    direct(ledger,'call','turn',1,raw(100));
    count(ledger,'turn',2,raw(200,20),undefined,256000);
    expect(ledger.summary()).toMatchObject({latestInputTokens:null,contextWindow:256000,completeness:'partial',requestCount:2});
    expect(ledger.summary().tokens?.totalTokens).toBe(220);
  });

  it('does not expose a current window without any selected usage source or accept an infinite window', () => {
    const ledger = new UsageLedger();
    ledger.setContextWindow('turn',128000);
    expect(ledger.summary()).toMatchObject({latestInputTokens:null,contextWindow:null});
    ledger.setContextWindow('other',Infinity);
    direct(ledger,'call','other',1,raw(100));
    expect(ledger.summary()).toMatchObject({latestInputTokens:100,contextWindow:null});
  });
});
