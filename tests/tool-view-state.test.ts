import { describe, expect, it, vi } from 'vitest';
import { createToolGroupViewStateStore, createToolTabStore } from '../client/tool-view-state';

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
const key = (session: string, record: string) => JSON.stringify([session, record]);

describe('tool tab preferences', () => {
  it('isolates tabs by session and tool, including identities containing separators', () => {
    const store = createToolTabStore();
    store.set('first', 'same', 'arguments'); store.set('second', 'same', 'raw');
    store.set('a:b', 'c', 'result'); store.set('a', 'b:c', 'raw');
    expect(store.get('first', 'same')).toBe('arguments');
    expect(store.get('second', 'same')).toBe('raw');
    expect(store.get('a:b', 'c')).toBe('result');
    expect(store.get('a', 'b:c')).toBe('raw');
    expect(store.get('missing', 'same')).toBeUndefined();
  });

  it('bounds persisted tabs by recent use without writing on reads', () => {
    const storage = fakeStorage(), store = createToolTabStore(2, storage, 'tabs');
    store.set('session', 'one', 'raw'); store.set('session', 'two', 'result');
    const writes = storage.writes;
    store.get('session', 'one');
    expect(storage.writes).toBe(writes);
    store.set('session', 'three', 'arguments');
    const restored = createToolTabStore(2, storage, 'tabs');
    expect(restored.get('session', 'two')).toBeUndefined();
    expect(restored.get('session', 'one')).toBe('raw');
    expect(restored.get('session', 'three')).toBe('arguments');
    expect(createToolTabStore(1, storage, 'tabs').get('session', 'one')).toBeUndefined();
  });

  it('retains legacy tab choices while dropping obsolete expansion state and log data', () => {
    const storage = fakeStorage();
    storage.values.set('tabs', JSON.stringify({ version: 1, entries: [
      [key('session', 'tool'), { open: true, tab: 'arguments', output: 'private content' }],
    ] }));
    const store = createToolTabStore(2, storage, 'tabs');
    expect(store.get('session', 'tool')).toBe('arguments');
    store.set('session', 'other', 'raw');
    expect(JSON.parse(storage.values.get('tabs')!)).toEqual({ version: 2, entries: [
      [key('session', 'tool'), 'arguments'], [key('session', 'other'), 'raw'],
    ] });
    expect(storage.values.get('tabs')).not.toContain('open');
    expect(storage.values.get('tabs')).not.toContain('private content');
  });

  it.each([
    'not JSON',
    JSON.stringify({ version: 3, entries: [] }),
    JSON.stringify({ version: 2, entries: [['not a composite key', 'raw']] }),
    JSON.stringify({ version: 2, entries: [[key('session', 'tool'), 'unknown']] }),
  ])('ignores damaged or unsupported tab storage: %s', saved => {
    const storage = fakeStorage(); storage.values.set('tabs', saved);
    const store = createToolTabStore(2, storage, 'tabs');
    expect(store.get('session', 'tool')).toBeUndefined();
    store.set('session', 'tool', 'raw');
    expect(createToolTabStore(2, storage, 'tabs').get('session', 'tool')).toBe('raw');
  });

  it('keeps tabs usable when browser storage is unavailable', () => {
    const store = createToolTabStore(2, {
      getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); },
    });
    expect(() => store.set('session', 'tool', 'arguments')).not.toThrow();
    expect(store.get('session', 'tool')).toBe('arguments');
  });
});

describe('tool group expansion preferences', () => {
  it('applies bulk defaults to unseen groups and replaces later manual overrides', () => {
    const store = createToolGroupViewStateStore();
    store.set('session', 'manual', true); store.setAll('session', false);
    expect(store.get('session', 'manual')).toBe(false);
    expect(store.get('session', 'unmounted')).toBe(false);
    store.set('session', 'manual', true);
    expect(store.get('session', 'manual')).toBe(true);
    expect(store.get('session', 'unmounted')).toBe(false);
    store.setAll('session', true);
    expect(store.get('session', 'manual')).toBe(true);
    expect(store.get('session', 'unmounted')).toBe(true);
  });

  it('isolates sessions and persists group choices separately from tool tabs', () => {
    const storage = fakeStorage(), groups = createToolGroupViewStateStore(2, storage, 'groups');
    const tabs = createToolTabStore(2, storage, 'tabs');
    tabs.set('first', 'same', 'raw');
    groups.setAll('first', true); groups.set('first', 'same', false); groups.setAll('second', false);
    const restored = createToolGroupViewStateStore(2, storage, 'groups');
    expect(restored.get('first', 'same')).toBe(false);
    expect(restored.get('first', 'unseen')).toBe(true);
    expect(restored.get('second', 'same')).toBe(false);
    expect(restored.get('missing', 'same')).toBeUndefined();
    expect(tabs.get('first', 'same')).toBe('raw');
  });

  it.each([1, 2])('migrates version %s group choices without retaining obsolete tabs', version => {
    const storage = fakeStorage();
    storage.values.set('groups', JSON.stringify({ version, entries: [
      [key('session', 'manual'), { open: false, tab: 'raw', output: 'private content' }],
    ], ...(version === 2 ? { sessions: [['session', true]] } : {}) }));
    const store = createToolGroupViewStateStore(2, storage, 'groups');
    expect(store.get('session', 'manual')).toBe(false);
    expect(store.get('session', 'unseen')).toBe(version === 2 ? true : undefined);
    store.set('session', 'other', true);
    expect(JSON.parse(storage.values.get('groups')!)).toEqual({ version: 3, entries: [
      [key('session', 'manual'), false], [key('session', 'other'), true],
    ], sessions: version === 2 ? [['session', true]] : [] });
    expect(storage.values.get('groups')).not.toContain('tab');
    expect(storage.values.get('groups')).not.toContain('private content');
  });

  it('notifies affected sessions, keeps read snapshots stable and unsubscribes correctly', () => {
    const store = createToolGroupViewStateStore(), first = vi.fn(), second = vi.fn();
    const unsubscribe = store.subscribe('first', first); store.subscribe('second', second);
    store.setAll('first', false);
    const snapshot = store.getSnapshot('first');
    store.get('first', 'unseen');
    expect(store.getSnapshot('first')).toBe(snapshot);
    expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
    store.set('first', 'manual', true);
    expect(store.getSnapshot('first')).toBeGreaterThan(snapshot);
    expect(first).toHaveBeenCalledTimes(2);
    unsubscribe(); store.setAll('first', true);
    expect(first).toHaveBeenCalledTimes(2);
  });

  it('bounds defaults and manual overrides independently and restores to smaller limits', () => {
    const storage = fakeStorage(), store = createToolGroupViewStateStore(2, storage, 'groups', 2);
    store.setAll('oldest', true); store.setAll('recent', true); store.get('oldest', 'unseen'); store.setAll('newest', false);
    expect(store.get('recent', 'unseen')).toBeUndefined();
    store.set('oldest', 'one', false); store.set('oldest', 'two', false); store.get('oldest', 'one'); store.set('oldest', 'three', false);
    expect(store.get('oldest', 'two')).toBe(true);
    expect(store.get('oldest', 'one')).toBe(false);
    const restored = createToolGroupViewStateStore(1, storage, 'groups', 1);
    expect(restored.get('newest', 'unseen')).toBeUndefined();
    expect(restored.get('oldest', 'three')).toBe(false);
  });

  it('notifies a subscribed session when bounded eviction changes its default', () => {
    const store = createToolGroupViewStateStore(1, undefined, 'groups', 1), listener = vi.fn();
    store.setAll('old', true); store.subscribe('old', listener);
    const snapshot = store.getSnapshot('old');
    store.setAll('new', true);
    expect(store.get('old', 'unseen')).toBeUndefined();
    expect(store.getSnapshot('old')).toBeGreaterThan(snapshot);
    expect(listener).toHaveBeenCalledOnce();
  });

  it.each([
    'not JSON',
    JSON.stringify({ version: 4, entries: [], sessions: [] }),
    JSON.stringify({ version: 3, entries: [[key('session', 'group'), 'true']], sessions: [] }),
    JSON.stringify({ version: 3, entries: [], sessions: [['session', 'true']] }),
  ])('ignores damaged group preferences: %s', saved => {
    const storage = fakeStorage(); storage.values.set('groups', saved);
    const store = createToolGroupViewStateStore(2, storage, 'groups');
    expect(store.get('session', 'group')).toBeUndefined();
    store.setAll('session', false);
    expect(store.get('session', 'group')).toBe(false);
  });

  it('keeps bulk actions and manual choices usable without browser storage', () => {
    const store = createToolGroupViewStateStore(2, {
      getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); },
    });
    expect(() => store.setAll('session', true)).not.toThrow();
    store.set('session', 'manual', false);
    expect(store.get('session', 'manual')).toBe(false);
    expect(store.get('session', 'unseen')).toBe(true);
  });
});
