import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextEvents, EventDisclosure } from '../client/TimelineEvents';
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
    store.set('first-session', 'disclosure:same-event', true);
    store.set('second-session', 'disclosure:same-event', false);
    store.set('first-session', 'context-group:same-event', false);
    expect(store.get('first-session', 'disclosure:same-event')).toBe(true);
    expect(store.get('second-session', 'disclosure:same-event')).toBe(false);
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

  it('restores nested context source choices independently from their group', () => {
    const event = { id: 'nested-source', kind: 'context' as const, text: 'Original context body', timestamp: '2026-11-03T00:00:00Z' };
    const props = { sessionId: 'nested-rendering', group: { kind: 'context-group' as const, id: event.id, events: [event] } };
    eventViewState.set(props.sessionId, `context-group:${event.id}`, true);
    eventViewState.set(props.sessionId, `context-source:${event.id}`, true);
    const expanded = renderToStaticMarkup(createElement(ContextEvents, props));
    expect(expanded.match(/aria-expanded="true"/g)).toHaveLength(2);
    expect(expanded).toContain('Original context body');
    eventViewState.set(props.sessionId, `context-group:${event.id}`, false);
    expect(renderToStaticMarkup(createElement(ContextEvents, props))).not.toContain('<pre');
    eventViewState.set(props.sessionId, `context-group:${event.id}`, true);
    expect(renderToStaticMarkup(createElement(ContextEvents, props)).match(/aria-expanded="true"/g)).toHaveLength(2);
  });

  it('restores a reasoning disclosure after remount without affecting another session', () => {
    const event = { id: 'reasoning-record', kind: 'reasoning' as const, text: 'Stored reasoning body', timestamp: '2026-11-03T00:00:00Z' };
    eventViewState.set('reasoning-rendering', `disclosure:${event.id}`, true);
    const expanded = renderToStaticMarkup(createElement(EventDisclosure, { sessionId: 'reasoning-rendering', event }));
    const untouched = renderToStaticMarkup(createElement(EventDisclosure, { sessionId: 'different-session', event }));
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('event-disclosure-body');
    expect(untouched).toContain('aria-expanded="false"');
  });
});
