import { createElement } from 'react';
import { renderRecords } from './render-records';
import { describe, expect, it } from 'vitest';
import { ContextEvents } from '../client/TimelineEvents';
import { createEventViewStateStore, eventViewState } from '../client/event-view-state';

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };
}

describe('event disclosure choices', () => {
  it('isolates manual open and closed choices by session and event identity', () => {
    const store = createEventViewStateStore();
    store.set('first-session', 'reading-process:same-event', true);
    store.set('second-session', 'reading-process:same-event', false);
    store.set('first-session', 'context-group:same-event', false);
    expect(store.get('first-session', 'reading-process:same-event')).toBe(true);
    expect(store.get('second-session', 'reading-process:same-event')).toBe(false);
    expect(store.get('first-session', 'context-group:same-event')).toBe(false);
    expect(store.get('first-session', 'missing')).toBeUndefined();
  });

  it('persists only bounded identity and boolean choices and restores after remounts', () => {
    const storage = fakeStorage();
    const first = createEventViewStateStore(2, storage);
    first.set('session', 'old', true);
    first.set('session', 'keep-open', true);
    first.get('session', 'old');
    first.set('session', 'keep-closed', false);
    const saved = JSON.parse(storage.values.get('session-lens-event-view-v1')!);
    expect(saved).toEqual({ version: 1, entries: [
      [JSON.stringify(['session', 'old']), true],
      [JSON.stringify(['session', 'keep-closed']), false],
    ] });
    const restored = createEventViewStateStore(2, storage);
    expect(restored.get('session', 'keep-open')).toBeUndefined();
    expect(restored.get('session', 'old')).toBe(true);
    expect(restored.get('session', 'keep-closed')).toBe(false);
  });

  it('enforces the configured bound on restoration', () => {
    const storage = fakeStorage();
    const first = createEventViewStateStore(3, storage);
    first.set('session', 'oldest', true);
    first.set('session', 'middle', false);
    first.set('session', 'newest', true);
    const restored = createEventViewStateStore(2, storage);
    expect(restored.get('session', 'oldest')).toBeUndefined();
    expect(restored.get('session', 'middle')).toBe(false);
    expect(restored.get('session', 'newest')).toBe(true);
  });

  it.each([
    'not JSON',
    'null',
    '{"version":2,"entries":[]}',
    '{"version":1,"entries":[["not a composite key",true]]}',
    '{"version":1,"entries":[["[1,2]",true]]}',
    JSON.stringify({ version: 1, entries: [[JSON.stringify(['session', 'event']), { open: true, text: 'do not load event text' }]] }),
  ])('ignores corrupt or unsupported storage: %s', saved => {
    const storage = fakeStorage();
    storage.values.set('events', saved);
    const store = createEventViewStateStore(2, storage, 'events');
    expect(store.get('session', 'event')).toBeUndefined();
    store.set('session', 'event', false);
    expect(createEventViewStateStore(2, storage, 'events').get('session', 'event')).toBe(false);
  });

  it('continues in memory when browser storage is unavailable or full', () => {
    const store = createEventViewStateStore(2, {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('quota exceeded'); },
    });
    expect(() => store.set('session', 'event', true)).not.toThrow();
    expect(store.get('session', 'event')).toBe(true);
  });

  it('restores context group choices while keeping individual records as detail actions', () => {
    const event = { id: 'source', kind: 'context' as const, text: 'Context preview\nSECRET_CONTEXT_BODY', timestamp: '2026-11-03T00:00:00Z' };
    const props = { sessionId: 'context-rendering', group: { kind: 'context-group' as const, id: event.id, events: [event] } };
    eventViewState.set(props.sessionId, `context-group:${event.id}`, false);
    expect(renderRecords(createElement(ContextEvents, props))).not.toContain('data-context-event-id=');
    eventViewState.set(props.sessionId, `context-group:${event.id}`, true);
    const expanded = renderRecords(createElement(ContextEvents, props));
    expect(expanded.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(expanded).toContain('data-context-event-id="source"');
    expect(expanded).not.toContain('<pre');
    expect(expanded).not.toContain('record-details-content');
  });
});
