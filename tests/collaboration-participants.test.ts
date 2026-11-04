import { describe, expect, it } from 'vitest';
import type { CollaborationMessage, SessionDetail, SessionSummary, TimelineEvent, TurnSummary } from '../shared/types';
import { buildTimelineCollaboration } from '../client/collaboration-participants';
import { messageRoute } from '../client/collaboration-message';

const timestamp = '2026-11-03T00:00:00Z';
const usage = { tokens: null, requestCount: 0, completeness: 'unknown' as const, latestInputTokens: null, contextWindow: null };
function session(id: string, parentId?: string, agentName?: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id, parentId, agentName, title: id, cwd: '/project', project: 'project', model: 'test', source: 'synthetic',
    startedAt: timestamp, updatedAt: timestamp, status: 'completed', turnCount: 1, toolCount: 0, usage,
    filePath: `${id}.jsonl`, fileSize: 1, revision: '1', parseErrors: 0, ...overrides };
}
function detail(value: SessionSummary, children: SessionSummary[] = [], parent?: SessionSummary): SessionDetail {
  const turn: TurnSummary = { id: 'turn', index: 0, prompt: '', preview: '', startedAt: timestamp, status: 'completed',
    model: 'test', toolCount: 0, usage, startOffset: 0, endOffset: 1 };
  return { session: value, children, parent, turns: [turn] };
}
function event(id: string, sender: string, taskName: string, messageType: CollaborationMessage['messageType'] = 'MESSAGE', payload = 'Review complete'): TimelineEvent {
  return { id, kind: 'collaboration', timestamp, text: 'Raw envelope', collaboration: { sender, taskName, messageType, payload } };
}

describe('timeline collaboration participants', () => {
  it('uses matching task assignment evidence to resolve root and child while preserving source identity', () => {
    const root = session('root');
    const child = session('reviewer', 'root', '/root/reviewer');
    const assignment = event('assignment', '/root', '/root/reviewer', 'NEW_TASK');
    const result = event('result', '/root/reviewer', '/root', 'FINAL_ANSWER');
    const timeline = Object.freeze([assignment, result]);
    const before = JSON.stringify(timeline);
    const context = buildTimelineCollaboration(timeline, detail(root, [child]), 'turn');
    expect(context.records.get('assignment')).toMatchObject({ id: 'assignment', sessionId: 'root', turnId: 'turn', senderId: 'root', recipientId: 'reviewer' });
    expect(messageRoute(context.records.get('result')!, context.labels)).toBe('reviewer → 主代理');
    expect(JSON.stringify(timeline)).toBe(before);
  });

  it('uses parent metadata in a child timeline only with explicit root assignment evidence', () => {
    const root = session('root');
    const child = session('reviewer', 'root', '/root/reviewer');
    const current = detail(child, [], root);
    const assignment = event('new', '/root', '/root/reviewer', 'NEW_TASK');
    const context = buildTimelineCollaboration([assignment], current, 'turn');
    expect(messageRoute(context.records.get('new')!, context.labels)).toBe('主代理 → reviewer');
    const unproven = buildTimelineCollaboration([event('ordinary', '/root/reviewer', '/root')], current, 'turn');
    expect(unproven.records.get('ordinary')?.recipientId).toBeUndefined();
    expect(messageRoute(unproven.records.get('ordinary')!, unproven.labels)).toBe('reviewer → root（未关联）');
  });

  it('does not identify a missing parent, a nickname path or a duplicate path', () => {
    const child = session('reviewer', 'missing', '/root/reviewer');
    const missing = buildTimelineCollaboration([event('new', '/root', '/root/reviewer', 'NEW_TASK')], detail(child), 'turn');
    expect(missing.records.get('new')?.senderId).toBeUndefined();
    const root = session('root', undefined, '/root');
    const nickname = session('nickname', 'root', '/root/reviewer', { agentNickname: '/root/reviewer' });
    const alias = buildTimelineCollaboration([event('alias', '/root/reviewer', '/root')], detail(root, [nickname]), 'turn');
    expect(alias.records.get('alias')?.senderId).toBeUndefined();
    const duplicate = buildTimelineCollaboration([event('duplicate', '/root/reviewer', '/root')], detail(root, [
      session('one', 'root', '/root/reviewer'), session('two', 'root', '/root/reviewer'),
    ]), 'turn');
    expect(duplicate.records.get('duplicate')?.senderId).toBeUndefined();
  });

  it('uses the same disambiguated display names and preserves all same-session records', () => {
    const root = session('root', undefined, '/root');
    const first = session('first', 'root', '/root/ui/reviewer');
    const second = session('second', 'root', '/root/api/reviewer');
    const context = buildTimelineCollaboration([event('one', '/root/ui/reviewer', '/root'), event('two', '/root/ui/reviewer', '/root')], detail(root, [first, second]), 'turn');
    expect(context.records.size).toBe(2);
    expect(messageRoute(context.records.get('one')!, context.labels)).toBe('ui/reviewer → 主代理');
    expect(context.labels.get('second')).toBe('api/reviewer');
  });

  it('ignores ordinary events and builds bounded previews without changing full payloads', () => {
    const payload = '😀'.repeat(150);
    const result = event('result', '/root/reviewer', '/root', 'FINAL_ANSWER', payload);
    const context = buildTimelineCollaboration([{ id: 'text', kind: 'assistant', timestamp, text: 'Not an envelope' }, result], detail(session('root', undefined, '/root')), 'turn');
    expect(context.records.size).toBe(1);
    expect(context.records.get('result')?.preview.length).toBeLessThanOrEqual(200);
    expect(context.records.get('result')?.preview).not.toMatch(/[\uD800-\uDBFF]…$/);
    expect(result.collaboration?.payload).toBe(payload);
  });
});
