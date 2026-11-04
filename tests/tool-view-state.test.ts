import { describe, expect, it, vi } from 'vitest';
import { createToolGroupViewStateStore, createToolViewStateStore, type ToolViewState } from '../client/tool-view-state';

function fakeStorage() {
  const values = new Map<string, string>();
  let writes = 0;
  return {
    values,
    get writes() { return writes; },
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { writes++; values.set(key, value); },
  };
}

describe('manual tool view state', () => {
  it('keeps choices isolated by both session and stable tool identity', () => {
    const store = createToolViewStateStore();
    store.set('session-a', 'tool-1', { open: true, tab: 'arguments' });
    store.set('session-b', 'tool-1', { open: false, tab: 'raw' });
    store.set('session-a', 'tool-2', { open: true, tab: 'result' });
    expect(store.get('session-a', 'tool-1')).toEqual({ open: true, tab: 'arguments' });
    expect(store.get('session-b', 'tool-1')).toEqual({ open: false, tab: 'raw' });
    expect(store.get('session-a', 'tool-2')).toEqual({ open: true, tab: 'result' });
    expect(store.get('session-b', 'tool-2')).toBeUndefined();
  });

  it('replaces a manual choice without consuming another cache entry', () => {
    const store = createToolViewStateStore(2);
    store.set('session', 'tool-1', { open: true, tab: 'result' });
    store.set('session', 'tool-2', { open: false, tab: 'raw' });
    store.set('session', 'tool-1', { open: false, tab: 'arguments' });
    expect(store.get('session', 'tool-1')).toEqual({ open: false, tab: 'arguments' });
    expect(store.get('session', 'tool-2')).toEqual({ open: false, tab: 'raw' });
  });

  it('evicts the least recently used choice when the bound is reached', () => {
    const store = createToolViewStateStore(2);
    store.set('session', 'tool-1', { open: true, tab: 'result' });
    store.set('session', 'tool-2', { open: false, tab: 'raw' });
    store.get('session', 'tool-1');
    store.set('session', 'tool-3', { open: true, tab: 'arguments' });
    expect(store.get('session', 'tool-2')).toBeUndefined();
    expect(store.get('session', 'tool-1')).toEqual({ open: true, tab: 'result' });
    expect(store.get('session', 'tool-3')).toEqual({ open: true, tab: 'arguments' });
  });

  it('returns snapshots and does not retain caller-owned mutable state', () => {
    const store = createToolViewStateStore();
    const choice: ToolViewState = { open: false, tab: 'raw' };
    store.set('session', 'tool', choice);
    choice.open = true;
    const snapshot = store.get('session', 'tool')!;
    snapshot.tab = 'result';
    expect(store.get('session', 'tool')).toEqual({ open: false, tab: 'raw' });
  });

  it('restores open and tab choices from the same storage after rebuilding the store', () => {
    const storage = fakeStorage();
    const first = createToolViewStateStore(500, storage, 'tools');
    first.set('session-a', 'tool-1', { open: true, tab: 'arguments' });
    first.set('session-b', 'tool-1', { open: false, tab: 'raw' });
    const restored = createToolViewStateStore(500, storage, 'tools');
    expect(restored.get('session-a', 'tool-1')).toEqual({ open: true, tab: 'arguments' });
    expect(restored.get('session-b', 'tool-1')).toEqual({ open: false, tab: 'raw' });
    const snapshot = restored.get('session-a', 'tool-1')!;
    snapshot.open = false;
    expect(restored.get('session-a', 'tool-1')!.open).toBe(true);
  });

  it('keeps group state separate from tool state in shared browser storage', () => {
    const storage = fakeStorage();
    const tools = createToolViewStateStore(500, storage, 'tools');
    const groups = createToolViewStateStore(200, storage, 'groups');
    tools.set('session', 'same-id', { open: true, tab: 'raw' });
    groups.set('session', 'same-id', { open: false, tab: 'result' });
    expect(createToolViewStateStore(500, storage, 'tools').get('session', 'same-id')).toEqual({ open: true, tab: 'raw' });
    expect(createToolViewStateStore(200, storage, 'groups').get('session', 'same-id')).toEqual({ open: false, tab: 'result' });
  });

  it('persists the bounded LRU on set without writing on read', () => {
    const storage = fakeStorage();
    const store = createToolViewStateStore(2, storage, 'tools');
    store.set('session', 'tool-1', { open: true, tab: 'result' });
    store.set('session', 'tool-2', { open: false, tab: 'raw' });
    const writesBeforeRead = storage.writes;
    store.get('session', 'tool-1');
    store.get('session', 'missing');
    expect(storage.writes).toBe(writesBeforeRead);
    store.set('session', 'tool-3', { open: true, tab: 'arguments' });
    const restored = createToolViewStateStore(2, storage, 'tools');
    expect(restored.get('session', 'tool-1')).toEqual({ open: true, tab: 'result' });
    expect(restored.get('session', 'tool-2')).toBeUndefined();
    expect(restored.get('session', 'tool-3')).toEqual({ open: true, tab: 'arguments' });
    expect(JSON.parse(storage.values.get('tools')!).entries).toHaveLength(2);
  });

  it('enforces a lower bound when restoring previously saved entries', () => {
    const storage = fakeStorage();
    const first = createToolViewStateStore(4, storage, 'tools');
    for (const toolId of ['oldest', 'middle', 'newest']) first.set('session', toolId, { open: true, tab: 'result' });
    const restored = createToolViewStateStore(2, storage, 'tools');
    expect(restored.get('session', 'oldest')).toBeUndefined();
    expect(restored.get('session', 'middle')).toBeDefined();
    expect(restored.get('session', 'newest')).toBeDefined();
  });

  it.each([
    'not JSON',
    '[]',
    'null',
    '{"version":2,"entries":[]}',
    '{"version":1,"entries":{}}',
    '{"version":1,"entries":[[42,{"open":true,"tab":"result"}]]}',
    '{"version":1,"entries":[["not a composite key",{"open":true,"tab":"result"}]]}',
    '{"version":1,"entries":[["[1,2]",{"open":true,"tab":"result"}]]}',
    '{"version":1,"entries":[["[\\"session\\",\\"tool\\"]",{"open":"true","tab":"result"}]]}',
    '{"version":1,"entries":[["[\\"session\\",\\"tool\\"]",{"open":true,"tab":"unknown"}]]}',
    '{"version":1,"entries":[["[\\"session\\",\\"tool\\"]",{"open":true,"tab":"raw","output":"do not load log content"}]]}',
  ])('ignores damaged or unsupported stored state and continues in memory: %s', saved => {
    const storage = fakeStorage();
    storage.values.set('tools', saved);
    const store = createToolViewStateStore(2, storage, 'tools');
    expect(store.get('session', 'tool')).toBeUndefined();
    store.set('session', 'tool', { open: true, tab: 'arguments' });
    expect(store.get('session', 'tool')).toEqual({ open: true, tab: 'arguments' });
    expect(createToolViewStateStore(2, storage, 'tools').get('session', 'tool')).toEqual({ open: true, tab: 'arguments' });
  });

  it('keeps an in-memory store working when browser storage throws', () => {
    const storage = {
      getItem() { throw new Error('storage unavailable'); },
      setItem() { throw new Error('storage quota exceeded'); },
    };
    const store = createToolViewStateStore(2, storage, 'tools');
    expect(() => store.set('session', 'tool', { open: true, tab: 'raw' })).not.toThrow();
    expect(store.get('session', 'tool')).toEqual({ open: true, tab: 'raw' });
  });

  it('serializes only identity, open and tab rather than caller-owned log data', () => {
    const storage = fakeStorage();
    const store = createToolViewStateStore(2, storage, 'tools');
    store.set('session', 'tool', { open: true, tab: 'result', output: 'private tool output', arguments: 'private input' } as ToolViewState);
    const saved = storage.values.get('tools')!;
    expect(saved).not.toContain('private');
    expect(JSON.parse(saved)).toEqual({ version: 1, entries: [[JSON.stringify(['session', 'tool']), { open: true, tab: 'result' }]] });
  });
});

describe('session-wide tool group view state', () => {
  it('applies bulk choices to old overrides and groups that have not mounted', () => {
    const store = createToolGroupViewStateStore();
    store.set('session', 'one', { open: true, tab: 'result' });
    store.set('session', 'two', { open: false, tab: 'result' });
    store.setAll('session', false);
    for (const id of ['one', 'two', 'not-mounted-yet']) expect(store.get('session', id)?.open).toBe(false);
    store.setAll('session', true);
    for (const id of ['one', 'two', 'not-mounted-yet']) expect(store.get('session', id)?.open).toBe(true);
  });

  it('allows a later manual choice and replaces it on the next bulk action', () => {
    const store = createToolGroupViewStateStore();
    store.setAll('session', true);
    store.set('session', 'manual', { open: false, tab: 'result' });
    expect(store.get('session', 'manual')?.open).toBe(false);
    expect(store.get('session', 'other')?.open).toBe(true);
    store.setAll('session', true);
    expect(store.get('session', 'manual')?.open).toBe(true);
  });

  it('isolates sessions and leaves individual tool tabs unchanged', () => {
    const storage = fakeStorage();
    const groups = createToolGroupViewStateStore(200, storage, 'groups');
    const tools = createToolViewStateStore(500, storage, 'tools');
    tools.set('session-a', 'same-id', { open: true, tab: 'raw' });
    groups.set('session-b', 'same-id', { open: true, tab: 'result' });
    groups.setAll('session-a', false);
    expect(groups.get('session-b', 'same-id')?.open).toBe(true);
    expect(groups.get('unrelated', 'same-id')).toBeUndefined();
    expect(tools.get('session-a', 'same-id')).toEqual({ open: true, tab: 'raw' });
  });

  it('restores bulk defaults and subsequent manual overrides from storage', () => {
    const storage = fakeStorage();
    const first = createToolGroupViewStateStore(200, storage, 'groups');
    first.setAll('session-a', true);
    first.setAll('session-b', false);
    first.set('session-a', 'manual', { open: false, tab: 'result' });
    const restored = createToolGroupViewStateStore(200, storage, 'groups');
    expect(restored.get('session-a', 'unseen')?.open).toBe(true);
    expect(restored.get('session-a', 'manual')?.open).toBe(false);
    expect(restored.get('session-b', 'unseen')?.open).toBe(false);
    const snapshot = restored.get('session-a', 'manual')!;
    snapshot.open = true;
    expect(restored.get('session-a', 'manual')?.open).toBe(false);
  });

  it('migrates earlier per-group state without inventing a bulk default', () => {
    const storage = fakeStorage();
    createToolViewStateStore(200, storage, 'groups').set('session', 'legacy', { open: true, tab: 'result' });
    const restored = createToolGroupViewStateStore(200, storage, 'groups');
    expect(restored.get('session', 'legacy')?.open).toBe(true);
    expect(restored.get('session', 'unseen')).toBeUndefined();
    restored.setAll('session', false);
    expect(JSON.parse(storage.values.get('groups')!).version).toBe(2);
    expect(createToolGroupViewStateStore(200, storage, 'groups').get('session', 'legacy')?.open).toBe(false);
  });

  it('notifies only affected session subscribers with stable numeric snapshots', () => {
    const store = createToolGroupViewStateStore();
    const first = vi.fn(), second = vi.fn();
    const unsubscribe = store.subscribe('session-a', first);
    store.subscribe('session-b', second);
    expect(store.getSnapshot('session-a')).toBe(0);
    store.setAll('session-a', false);
    const snapshot = store.getSnapshot('session-a');
    expect(snapshot).toBeGreaterThan(0);
    store.get('session-a', 'unseen');
    expect(store.getSnapshot('session-a')).toBe(snapshot);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    store.set('session-a', 'manual', { open: true, tab: 'result' });
    expect(store.getSnapshot('session-a')).toBeGreaterThan(snapshot);
    expect(first).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.setAll('session-a', true);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).not.toHaveBeenCalled();
  });

  it('bounds saved defaults and manual choices with independent LRU limits', () => {
    const storage = fakeStorage();
    const store = createToolGroupViewStateStore(2, storage, 'groups', 2);
    store.setAll('oldest', true);
    store.setAll('recent', true);
    store.get('oldest', 'unseen');
    store.setAll('newest', false);
    expect(store.get('recent', 'unseen')).toBeUndefined();
    expect(store.get('oldest', 'unseen')?.open).toBe(true);
    store.set('oldest', 'one', { open: false, tab: 'result' });
    store.set('oldest', 'two', { open: false, tab: 'result' });
    store.get('oldest', 'one');
    store.set('oldest', 'three', { open: false, tab: 'result' });
    expect(store.get('oldest', 'two')?.open).toBe(true);
    expect(store.get('oldest', 'one')?.open).toBe(false);
    const saved = JSON.parse(storage.values.get('groups')!);
    expect(saved.entries).toHaveLength(2);
    expect(saved.sessions).toHaveLength(2);
    const restored = createToolGroupViewStateStore(1, storage, 'groups', 1);
    expect(restored.get('newest', 'unseen')).toBeUndefined();
    expect(restored.get('oldest', 'three')?.open).toBe(false);
  });

  it('notifies another subscribed session when bounded eviction changes its choice', () => {
    const store = createToolGroupViewStateStore(1, undefined, 'groups', 1);
    const old = vi.fn();
    store.setAll('old', true);
    store.subscribe('old', old);
    const snapshot = store.getSnapshot('old');
    store.setAll('new', true);
    expect(store.get('old', 'unseen')).toBeUndefined();
    expect(store.getSnapshot('old')).toBeGreaterThan(snapshot);
    expect(old).toHaveBeenCalledTimes(1);
  });

  it.each([
    'not JSON',
    '{"version":3,"entries":[],"sessions":[]}',
    '{"version":2,"entries":[],"sessions":[["session","true"]]}',
    '{"version":2,"entries":[["not a composite key",{"open":true,"tab":"result"}]],"sessions":[]}',
    '{"version":2,"entries":[],"sessions":{}}',
  ])('ignores damaged bulk state and continues with new actions: %s', saved => {
    const storage = fakeStorage(); storage.values.set('groups', saved);
    const store = createToolGroupViewStateStore(200, storage, 'groups');
    expect(store.get('session', 'group')).toBeUndefined();
    store.setAll('session', true);
    expect(store.get('session', 'group')?.open).toBe(true);
  });

  it('keeps working when browser storage throws and never serializes log content', () => {
    const store = createToolGroupViewStateStore(2, {
      getItem() { throw new Error('storage unavailable'); },
      setItem() { throw new Error('storage quota exceeded'); },
    });
    expect(() => store.setAll('session', true)).not.toThrow();
    expect(store.get('session', 'unseen')?.open).toBe(true);
    const storage = fakeStorage();
    const persisted = createToolGroupViewStateStore(2, storage, 'groups');
    persisted.set('session', 'group', { open: true, tab: 'result', output: 'private content' } as ToolViewState);
    expect(storage.values.get('groups')).not.toContain('private content');
    expect(JSON.parse(storage.values.get('groups')!)).toEqual({ version: 2, entries: [[JSON.stringify(['session', 'group']), { open: true, tab: 'result' }]], sessions: [] });
  });
});
