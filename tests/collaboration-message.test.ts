import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../shared/types';
import { createParticipantLabels, messageDirection, messageKey, messageRoute, messageTypeLabel, participantLabel } from '../client/collaboration-message';

function session(id: string, parentId?: string, agentName?: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id, parentId, agentName, title: '会话标题', cwd: '/project', project: 'project', model: 'test', source: 'synthetic',
    startedAt: '', updatedAt: '', status: 'completed', turnCount: 1, toolCount: 0,
    usage: { tokens: null, requestCount: 0, completeness: 'unknown', latestInputTokens: null, contextWindow: null },
    filePath: `${id}.jsonl`, fileSize: 0, revision: '1', parseErrors: 0, ...overrides };
}

describe('message presentation', () => {
  it('uses both source session and event ID without separator collisions', () => {
    expect(messageKey({ sessionId: 'a:b', id: 'c' })).not.toBe(messageKey({ sessionId: 'a', id: 'b:c' }));
    expect(messageKey({ sessionId: 'a', id: 'event-1' })).not.toBe(messageKey({ sessionId: 'b', id: 'event-1' }));
  });

  it('uses confirmed endpoints relative to the selected participant, including self messages', () => {
    expect(messageDirection({ senderId: 'root', recipientId: 'frontend' }, 'frontend')).toBe('received');
    expect(messageDirection({ senderId: 'frontend', recipientId: 'root' }, 'frontend')).toBe('sent');
    expect(messageDirection({ senderId: 'frontend', recipientId: 'frontend' }, 'frontend')).toBe('self');
    expect(messageDirection({ senderId: 'root', recipientId: 'backend' }, 'frontend')).toBe('unknown');
    expect(messageDirection({}, 'frontend')).toBe('unknown');
    expect(messageDirection({ senderId: 'frontend' })).toBe('unknown');
    expect(messageDirection({ recipientId: 'frontend' }, 'frontend')).toBe('received');
  });

  it('keeps the same message type labels for every direction and both views', () => {
    expect(['received', 'sent', 'self', 'unknown'].map(direction => messageTypeLabel('NEW_TASK', direction as 'received' | 'sent' | 'self' | 'unknown')))
      .toEqual(['任务分派', '任务分派', '任务分派', '任务分派']);
    expect(messageTypeLabel('FINAL_ANSWER', 'received')).toBe('结果汇报');
    expect(messageTypeLabel('FINAL_ANSWER', 'sent')).toBe('结果汇报');
    expect(messageTypeLabel('FINAL_ANSWER', 'self')).toBe('结果汇报');
    expect(messageTypeLabel('FINAL_ANSWER', 'unknown')).toBe('结果汇报');
    expect(messageTypeLabel('MESSAGE', 'received')).toBe('协作消息');
  });

  it('shows both endpoints using confirmed labels and keeps unlinked endpoints explicit', () => {
    const labels = createParticipantLabels([session('root'), session('frontend', 'root', '/root/frontend')]);
    expect(messageRoute({ senderId: 'frontend', recipientId: 'root', sender: '/root/frontend', taskName: '/root' }, labels)).toBe('frontend → 主代理');
    expect(messageRoute({ senderId: 'frontend', sender: '/root/frontend', taskName: '/root' }, labels)).toBe('frontend → root（未关联）');
    expect(messageRoute({ sender: '/root/frontend', taskName: '/root/frontend' }, labels)).toBe('frontend（未关联） → frontend（未关联）');
  });
});

describe('participant names', () => {
  it('uses a root label and existing short display names for unambiguous sessions', () => {
    const labels = createParticipantLabels([session('root'), session('frontend', 'root', '/root/frontend'), session('fallback', 'root')]);
    expect(labels.get('root')).toBe('主代理');
    expect(labels.get('frontend')).toBe('frontend');
    expect(labels.get('fallback')).toBe('会话标题');
  });

  it('uses the shortest distinguishing canonical path suffix for colliding short names', () => {
    const items = [session('ui', 'root', '/root/ui/frontend'), session('api', 'root', '/root/api/frontend'), session('deep', 'root', '/root/other/ui/frontend')];
    const labels = createParticipantLabels(items);
    expect(labels.get('api')).toBe('api/frontend');
    expect(labels.get('ui')).toBe('root/ui/frontend');
    expect(labels.get('deep')).toBe('other/ui/frontend');
    expect([...createParticipantLabels(items.slice().reverse())]).toEqual([...labels]);
  });

  it('falls back to short IDs for repeated paths, absent paths and multiple roots', () => {
    const items = [session('abcdefgh-1', 'root', '/root/worker'), session('abcdefgh-2', 'root', '/root/worker'),
      session('title-one', 'root'), session('title-two', 'root'), session('root-one'), session('root-two')];
    const labels = createParticipantLabels(items);
    expect(labels.get('abcdefgh-1')).toBe('worker · abcdefgh-1');
    expect(labels.get('abcdefgh-2')).toBe('worker · abcdefgh-2');
    expect(labels.get('title-one')).toBe('会话标题 · title-on');
    expect(labels.get('title-two')).toBe('会话标题 · title-tw');
    expect(labels.get('root-one')).toBe('主代理 · root-one');
    expect(labels.get('root-two')).toBe('主代理 · root-two');
    expect(new Set(labels.values()).size).toBe(items.length);
  });

  it('keeps labels unique if a path suffix is already another participant display name', () => {
    const labels = createParticipantLabels([session('ui', 'root', '/root/ui/worker'), session('api', 'root', '/root/api/worker'),
      session('literal', 'root', 'ui/worker')]);
    expect(labels.get('literal')).toBe('ui/worker');
    expect(labels.get('ui')).toBe('root/ui/worker');
    expect(labels.get('api')).toBe('api/worker');
  });

  it('does not use an unconfirmed root path or matching suffix to establish identity', () => {
    const labels = createParticipantLabels([session('root'), session('frontend', 'root', '/root/frontend')]);
    expect(participantLabel('root', '/root', labels)).toBe('主代理');
    expect(participantLabel(undefined, '/root', labels)).toBe('root（未关联）');
    expect(participantLabel(undefined, '/root/frontend', labels)).toBe('frontend（未关联）');
    expect(participantLabel('missing', '/root/frontend', labels)).toBe('frontend（未关联）');
    expect(participantLabel(undefined, '', labels)).toBe('未记录');
    expect(participantLabel(undefined, '  ', labels)).toBe('未记录');
    expect(participantLabel(undefined, '/noncanonical/path', labels)).toBe('/noncanonical/path（未关联）');
  });
});
