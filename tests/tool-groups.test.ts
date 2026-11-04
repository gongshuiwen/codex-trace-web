import { describe, expect, it } from 'vitest';
import type { TimelineEvent, ToolCall } from '../shared/types';
import { groupAdjacentTools } from '../client/tool-groups';

function event(id: string, kind: TimelineEvent['kind'] = 'tool', status: ToolCall['status'] = 'completed'): TimelineEvent {
  return { id: `event-${id}`, kind, timestamp: '', text: id, ...(kind === 'tool' ? { tool: { id, name: 'shell', category: 'command', arguments: '{}', output: '', outputLength: 0, outputTruncated: false, status } } : {}) };
}

describe('adjacent tool groups', () => {
  it('groups only adjacent calls and preserves every original event in order', () => {
    const events = [event('a'), event('b'), event('note', 'commentary'), event('c'), event('d'), event('answer', 'assistant'), event('e')];
    const grouped = groupAdjacentTools(events);
    expect(grouped.map(entry => entry.kind)).toEqual(['tool-group', 'commentary', 'tool-group', 'assistant', 'tool-group']);
    expect(grouped.flatMap(entry => entry.kind === 'tool-group' ? entry.events : [entry])).toEqual(events);
    expect(events).toHaveLength(7);
  });

  it('keeps the group identity stable when more calls arrive or statuses change', () => {
    const before = groupAdjacentTools([event('a', 'tool', 'running')])[0];
    const after = groupAdjacentTools([event('a'), event('b'), event('c')])[0];
    expect(before.id).toBe(after.id);
  });

  it('counts all recorded states without calling a returned result successful', () => {
    const group = groupAdjacentTools([event('a'), event('b', 'tool', 'running'), event('c', 'tool', 'failed'), event('d', 'tool', 'unknown')])[0];
    expect(group.kind === 'tool-group' && group.counts).toEqual({ completed: 1, running: 1, failed: 1, unknown: 1 });
  });

  it.each(['context', 'reasoning', 'collaboration', 'notice', 'unknown', 'user'] as const)('breaks at %s records', kind => {
    expect(groupAdjacentTools([event('a'), event('break', kind), event('b')]).map(entry => entry.kind)).toEqual(['tool-group', kind, 'tool-group']);
  });

  it('does not group malformed tool events without a call', () => {
    const malformed = { id: 'missing', kind: 'tool', text: '', timestamp: '' } as TimelineEvent;
    const events = [event('a'), malformed, event('b')];
    const grouped = groupAdjacentTools(events);
    expect(grouped.map(entry => entry.kind)).toEqual(['tool-group', 'tool', 'tool-group']);
    expect(grouped[1]).toBe(malformed);
    expect(grouped.flatMap(entry => entry.kind === 'tool-group' ? entry.events : [entry])).toEqual(events);
  });

  it('keeps an empty timeline empty', () => {
    expect(groupAdjacentTools([])).toEqual([]);
  });
});
