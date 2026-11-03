import { describe, expect, it } from 'vitest';
import type { TurnDetail } from '../shared/types';
import { createTurnDetailCache } from '../client/turn-detail-cache';

function detail(text = 'loaded content'): TurnDetail {
  return { summary: { prompt: '', preview: '' }, events: [{ id: 'answer', kind: 'assistant', text }], requests: [], warnings: [] } as unknown as TurnDetail;
}

describe('loaded turn detail cache', () => {
  it('preserves loaded data across row remounts and exposes stale revisions for background refresh', () => {
    const cache = createTurnDetailCache();
    const first = detail();
    cache.put('session', 'turn', 'revision-1', first);
    expect(cache.get('session', 'turn')).toMatchObject({ revision: 'revision-1', data: first });
    const next = detail('updated content');
    cache.put('session', 'turn', 'revision-2', next);
    expect(cache.get('session', 'turn')?.data).toBe(next);
    expect(cache.get('other-session', 'turn')).toBeUndefined();
  });

  it('evicts the least recently used turn and replaces an identity without leaking old revisions', () => {
    const cache = createTurnDetailCache(2);
    cache.put('s', 't1', 'r1', detail()); cache.put('s', 't2', 'r1', detail());
    cache.get('s', 't1'); cache.put('s', 't3', 'r1', detail());
    expect(cache.get('s', 't2')).toBeUndefined();
    cache.put('s', 't1', 'r2', detail());
    expect(cache.get('s', 't3')).toBeDefined();
    expect(cache.get('s', 't1')?.revision).toBe('r2');
  });

  it('respects the text budget while retaining one oversized turn to avoid placeholder thrashing', () => {
    const cache = createTurnDetailCache(24, 100);
    cache.put('s', 't1', 'r1', detail('a'.repeat(60)));
    cache.put('s', 't2', 'r1', detail('b'.repeat(60)));
    expect(cache.get('s', 't1')).toBeUndefined();
    const oversized = detail('c'.repeat(1000));
    cache.put('s', 'large', 'r1', oversized);
    expect(cache.get('s', 't2')).toBeUndefined();
    expect(cache.get('s', 'large')?.data).toBe(oversized);
  });
});
