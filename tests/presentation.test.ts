import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../shared/types';
import { turnPresentation } from '../client/presentation';

function event(id: string, kind: TimelineEvent['kind'], text: string): TimelineEvent {
  return { id, kind, text, timestamp: '2026-11-02T01:30:00Z' };
}

describe('turn presentation', () => {
  it('uses the full first user message and preserves later user messages in stream order', () => {
    const fullPrompt = '完整用户请求'.repeat(500) + '请求末尾不得丢失';
    const entries = [
      event('context', 'context', '环境信息'),
      event('first-user', 'user', fullPrompt),
      event('commentary', 'commentary', '正在处理'),
      event('supplement', 'user', '请再检查缓存'),
      event('assistant', 'assistant', '已检查'),
      event('another-supplement', 'user', '保留这一条补充'),
    ];
    const result = turnPresentation(fullPrompt.slice(0, 1000), entries);
    expect(result.prompt).toBe(fullPrompt);
    expect(result.timeline).toEqual([entries[0], ...entries.slice(2)]);
    expect(result.timeline.filter(item => item.kind === 'user').map(item => item.text)).toEqual(['请再检查缓存', '保留这一条补充']);
    expect(entries).toHaveLength(6);
  });

  it('uses the summary while details are unavailable or contain no user event', () => {
    expect(turnPresentation('载入中的摘要')).toEqual({ prompt: '载入中的摘要', timeline: [] });
    const entries = [event('context', 'context', '上下文'), event('answer', 'assistant', '回答')];
    expect(turnPresentation('用户摘要', entries)).toEqual({ prompt: '用户摘要', timeline: entries });
  });

  it('preserves repeated user messages and removes only the first occurrence', () => {
    const entries = [event('one', 'user', '继续'), event('two', 'user', '继续'), event('three', 'user', '继续')];
    const result = turnPresentation('继续', entries);
    expect(result.timeline.map(item => item.id)).toEqual(['two', 'three']);
  });
});
