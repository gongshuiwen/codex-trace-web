import { appendFile, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { indexSessionFile, loadCompactions, loadSessionActivity, loadTurnDetail } from '../server/parser.js';

const roots: string[] = [];
const stamp = '2026-11-03T10:00:00.000Z';
const row = (type: string, payload: Record<string, unknown>, timestamp: string | number = stamp) => ({ type, timestamp, payload });
const meta = (extra: Record<string, unknown> = {}) => row('session_meta', { id: 'metrics-session', timestamp: stamp, ...extra });
const start = (turn_id = 'first', timestamp = stamp) => row('event_msg', { type: 'task_started', turn_id }, timestamp);
const compact = (payload: Record<string, unknown> = {}, timestamp = stamp) => row('compacted', payload, timestamp);
const encode = (records: unknown[]) => records.map(item => JSON.stringify(item)).join('\n') + '\n';

async function fixture(records: unknown[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'session-lens-metrics-'));
  roots.push(root);
  const file = path.join(root, 'rollout.jsonl');
  await writeFile(file, encode(records));
  return file;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.join(tmpdir(), 'session-lens-metrics-'))) throw new Error('Unexpected cleanup target');
    await rm(root, { recursive: true, force: true });
  }
});

describe('recorded session duration', () => {
  it('uses the timestamp range through session_end and ignores file time and elapsed wall time', async () => {
    const file = await fixture([meta(), start(), row('event_msg', { type: 'task_complete', turn_id: 'first' }, '2026-11-03T10:00:05Z'),
      row('session_end', {}, '2026-11-03T10:00:09Z')]);
    expect((await indexSessionFile(file)).session.durationMs).toBe(9000);
    await utimes(file, new Date('2030-01-01'), new Date('2030-01-01'));
    expect((await indexSessionFile(file)).session.durationMs).toBe(9000);
    expect((await indexSessionFile(file)).session.durationMs).toBe(9000);
  });

  it('handles regressing clocks, missing timestamps and genuine zero spans', async () => {
    const reordered = await fixture([meta(), start(), compact({}, '2026-11-03T10:00:20Z'), row('session_end', {}, '2026-11-03T10:00:10Z')]);
    expect((await indexSessionFile(reordered)).session.durationMs).toBe(20000);
    const zero = await fixture([meta(), start()]);
    expect((await indexSessionFile(zero)).session.durationMs).toBe(0);
    const missing = await fixture([{ type: 'session_meta', payload: { id: 'missing' } },
      { type: 'event_msg', timestamp: 'invalid', payload: { type: 'task_started', turn_id: 'first' } }]);
    expect((await indexSessionFile(missing)).session.durationMs).toBeNull();
  });

  it('extends from complete new records only and counts each incremental compaction once', async () => {
    const file = await fixture([meta(), start()]);
    expect((await indexSessionFile(file)).session).toMatchObject({ durationMs: 0, compactionCount: 0 });
    const pending = JSON.stringify(compact({}, '2026-11-03T10:00:12Z'));
    await appendFile(file, pending.slice(0, 35));
    expect((await indexSessionFile(file)).session).toMatchObject({ durationMs: 0, compactionCount: 0 });
    await appendFile(file, pending.slice(35) + '\n');
    expect((await indexSessionFile(file)).session).toMatchObject({ durationMs: 12000, compactionCount: 1 });
    expect((await indexSessionFile(file)).session.compactionCount).toBe(1);
    expect((await loadCompactions(file)).items).toHaveLength(1);
  });
});

describe('indexed compaction navigation', () => {
  it('counts and pages actual compaction records across turns with exact timeline IDs', async () => {
    const file = await fixture([meta(), start(), compact({ message: 'private replacement body' }),
      row('event_msg', { type: 'warning', message: '上下文已压缩' }),
      compact({ turn_id: 'first' }), start('last'), compact({}, '2026-11-03T10:00:05Z')]);
    const indexed = await indexSessionFile(file);
    expect(indexed.session.compactionCount).toBe(3);
    expect(indexed.turns.map(turn => turn.compactionCount)).toEqual([2, 1]);
    const first = await loadCompactions(file, 0, 1);
    expect(first).toMatchObject({ total: 3, nextOffset: 1 });
    const rest = await loadCompactions(file, 1, 2);
    expect(rest).toMatchObject({ total: 3, nextOffset: null });
    expect([...first.items, ...rest.items].map(item => item.turnId)).toEqual(['first', 'first', 'last']);
    for (const item of [...first.items, ...rest.items]) {
      const detail = await loadTurnDetail(file, item.turnId);
      expect(detail.events.find(event => event.id === item.eventId)).toMatchObject({ kind: 'notice', noticeType: 'compaction', text: '上下文已压缩', timestamp: item.timestamp });
    }
    expect(JSON.stringify(rest)).not.toContain('private replacement body');
    expect(await loadCompactions(file, 3, 20)).toEqual({ items: [], total: 3, nextOffset: null });
  });

  it('retains a navigable notice even before the first identified turn without inventing activity attribution', async () => {
    const file = await fixture([meta(), compact({}), start('actual'), compact({})]);
    const indexed = await indexSessionFile(file);
    const page = await loadCompactions(file);
    expect(indexed.session.compactionCount).toBe(2);
    expect(page.items).toHaveLength(2);
    for (const item of page.items) {
      expect(indexed.turns.some(turn => turn.id === item.turnId)).toBe(true);
      expect((await loadTurnDetail(file, item.turnId)).events.some(event => event.id === item.eventId)).toBe(true);
    }
    expect((await loadSessionActivity(file)).compactions[0].turnId).toBeUndefined();
  });

  it('excludes inherited parent compactions and timestamps from child metrics', async () => {
    const file = await fixture([
      meta({ id: 'child', parent_thread_id: 'parent', subagent_history_start_ordinal: 4 }),
      row('session_meta', { id: 'parent', timestamp: '2020-01-01T00:00:00Z' }, '2020-01-01T00:00:00Z'),
      start('parent', '2020-01-01T00:00:00Z'), compact({}, '2030-01-01T00:00:00Z'),
      start('child', stamp), compact({}, '2026-11-03T10:00:03Z'),
    ].map((value, ordinal) => ({ ...value, ordinal })));
    expect((await indexSessionFile(file)).session).toMatchObject({ id: 'child', durationMs: 3000, compactionCount: 1 });
    expect((await loadCompactions(file)).items.map(item => item.turnId)).toEqual(['child']);
  });
});
