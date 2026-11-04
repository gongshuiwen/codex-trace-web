import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { indexSessionFile, loadToolFailures, loadTurnDetail } from '../server/parser.js';

const roots: string[] = [];
const timestamp = '2026-11-03T10:00:00.000Z';
const record = (type: string, payload: Record<string, unknown>) => ({ type, timestamp, payload });
const metadata = (id = 'failure-session') => record('session_meta', { id, cwd: 'E:/demo', timestamp });
const start = (turn_id = 'turn-1') => record('event_msg', { type: 'task_started', turn_id });
const end = (turn_id = 'turn-1') => record('event_msg', { type: 'task_complete', turn_id });
const call = (call_id: string, extra: Record<string, unknown> = {}) => record('response_item', { type: 'function_call', call_id, name: 'functions.exec_command', arguments: '{"cmd":"test"}', ...extra });
const output = (call_id: string, value: unknown, extra: Record<string, unknown> = {}) => record('response_item', { type: 'function_call_output', call_id, output: value, ...extra });
const encode = (records: unknown[]) => records.map(item => JSON.stringify(item)).join('\n') + '\n';

async function fixture(records: unknown[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'session-lens-failures-'));
  roots.push(root);
  const file = path.join(root, 'rollout.jsonl');
  await writeFile(file, encode(records));
  return file;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.join(tmpdir(), 'session-lens-failures-'))) throw new Error('Unexpected cleanup target');
    await rm(root, { recursive: true, force: true });
  }
});

describe('final recorded tool failure statistics', () => {
  it('uses explicit error markers and nonzero exit codes without guessing from error words', async () => {
    const file = await fixture([
      metadata(), start(),
      call('snake-marker'), output('snake-marker', 'rejected', { is_error: true }),
      call('camel-marker'), output('camel-marker', 'rejected', { isError: true }),
      call('structured-marker'), output('structured-marker', { is_error: true, message: 'rejected' }),
      call('json-marker'), output('json-marker', '{"isError":true}'),
      call('nonzero'), output('nonzero', '{"exit_code":2,"output":"nothing diagnostic"}'),
      call('top-exit'), output('top-exit', 'rejected', { exit_code: 3 }),
      call('zero'), output('zero', '{"exit_code":0,"output":"Error appears in an expected fixture"}'),
      call('word-only'), output('word-only', 'Error: this word alone does not establish recorded failure'),
      call('pending'), call('already-completed', { status: 'completed' }), end(),
    ]);
    const indexed = await indexSessionFile(file);
    expect(indexed.session).toMatchObject({ toolCount: 10, toolFailureCount: 6 });
    expect(indexed.turns[0]).toMatchObject({ toolCount: 10, toolFailureCount: 6 });
    const detail = await loadTurnDetail(file, 'turn-1');
    expect(detail.events.filter(event => event.tool?.status === 'failed').map(event => event.tool!.id))
      .toEqual(['snake-marker', 'camel-marker', 'structured-marker', 'json-marker', 'nonzero', 'top-exit']);
    expect(detail.events.find(event => event.tool?.id === 'pending')!.tool!.status).toBe('unknown');
  });

  it('deduplicates calls and outputs and lets each final output replace the previous status', async () => {
    const file = await fixture([
      metadata(), start(),
      call('recovered'), call('recovered'), output('recovered', '{"exit_code":5}'),
      output('recovered', 'final result'), call('recovered'),
      call('failed-last'), output('failed-last', '{"exit_code":0}'),
      output('failed-last', '{"exit_code":2}'), output('failed-last', '{"exit_code":2}'),
      call('failed-last', { status: 'completed' }), end(),
    ]);
    const indexed = await indexSessionFile(file);
    expect(indexed.session).toMatchObject({ toolCount: 2, toolFailureCount: 1 });
    const detail = await loadTurnDetail(file, 'turn-1');
    expect(detail.events.filter(event => event.tool)).toHaveLength(2);
    expect(detail.events.find(event => event.tool?.id === 'recovered')!.tool).toMatchObject({ status: 'completed', output: 'final result' });
    expect(detail.events.find(event => event.tool?.id === 'recovered')!.tool!.exitCode).toBeUndefined();
    expect((await loadToolFailures(file)).items.map(item => item.toolId)).toEqual(['failed-last']);
  });

  it('counts output-only identities once so failure counts remain consistent with visible tools', async () => {
    const file = await fixture([
      metadata(), start(), output('orphan-failed', 'Process exited with code 2'),
      output('orphan-failed', 'Process exited with code 2'),
      output('orphan-success', 'result without a call'),
      output('late-call', '{"isError":true}'), call('late-call'), end(),
    ]);
    const indexed = await indexSessionFile(file);
    expect(indexed.session).toMatchObject({ toolCount: 3, toolFailureCount: 2 });
    const detail = await loadTurnDetail(file, 'turn-1');
    expect(detail.events.filter(event => event.tool)).toHaveLength(indexed.session.toolCount);
    const failures = await loadToolFailures(file);
    expect(failures.total).toBe(2);
    expect(failures.items.map(item => [item.toolId, item.toolName])).toEqual([['orphan-failed', '未知工具'], ['late-call', '未知工具']]);
  });

  it('updates incremental counts once complete output records arrive and reverses a recovered failure', async () => {
    const file = await fixture([metadata(), start(), call('live')]);
    expect((await indexSessionFile(file)).session).toMatchObject({ toolCount: 1, toolFailureCount: 0 });
    const failure = JSON.stringify(output('live', 'rejected', { isError: true }));
    await appendFile(file, failure.slice(0, 40));
    expect((await indexSessionFile(file)).session.toolFailureCount).toBe(0);
    await appendFile(file, failure.slice(40) + '\n');
    expect((await indexSessionFile(file)).session).toMatchObject({ toolCount: 1, toolFailureCount: 1 });
    expect((await loadToolFailures(file)).items.map(item => item.toolId)).toEqual(['live']);
    await appendFile(file, encode([output('live', '{"exit_code":0}'), end()]));
    expect((await indexSessionFile(file)).session).toMatchObject({ toolCount: 1, toolFailureCount: 0 });
    expect(await loadToolFailures(file)).toEqual({ items: [], total: 0, nextOffset: null });
  });

  it('paginates final failures in original call order across turns and preserves timeline IDs', async () => {
    const file = await fixture([
      metadata(), start(), call('first'), call('second'),
      output('second', '{"exit_code":2}'), output('first', '{"isError":true}'), end(),
      start('successful-turn'), call('success'), output('success', '{"exit_code":0}'), end('successful-turn'),
      start('last-turn'), call('third'), output('third', '{"isError":true}'), end('last-turn'),
    ]);
    expect((await indexSessionFile(file)).turns.map(turn => turn.toolFailureCount)).toEqual([2, 0, 1]);
    const first = await loadToolFailures(file, 0, 1);
    expect(first).toMatchObject({ total: 3, nextOffset: 1 });
    expect(first.items.map(item => item.toolId)).toEqual(['first']);
    const rest = await loadToolFailures(file, 1, 2);
    expect(rest).toMatchObject({ total: 3, nextOffset: null });
    expect(rest.items.map(item => [item.turnId, item.toolId])).toEqual([['turn-1', 'second'], ['last-turn', 'third']]);
    for (const item of [...first.items, ...rest.items]) {
      const detail = await loadTurnDetail(file, item.turnId);
      expect(detail.events.find(event => event.id === item.eventId)?.tool).toMatchObject({ id: item.toolId, status: 'failed' });
    }
    expect(await loadToolFailures(file, 3, 20)).toEqual({ items: [], total: 3, nextOffset: null });
  });

  it('keeps parent failures out of a child summary when its log replays inherited history', async () => {
    const parentRecords = [metadata('parent'), start('parent-turn'), call('parent-tool'), output('parent-tool', '{"isError":true}'), end('parent-turn')];
    const parent = await fixture(parentRecords);
    const child = await fixture([
      record('session_meta', { id: 'child', parent_thread_id: 'parent', subagent_history_start_ordinal: 6 }),
      ...parentRecords, start('child-turn'), call('child-tool'), output('child-tool', '{"exit_code":0}'), end('child-turn'),
    ].map((item, ordinal) => ({ ...item, ordinal })));
    expect((await indexSessionFile(parent)).session).toMatchObject({ id: 'parent', toolCount: 1, toolFailureCount: 1 });
    expect((await indexSessionFile(child)).session).toMatchObject({ id: 'child', parentId: 'parent', toolCount: 1, toolFailureCount: 0 });
    expect(await loadToolFailures(child)).toEqual({ items: [], total: 0, nextOffset: null });
  });
});
