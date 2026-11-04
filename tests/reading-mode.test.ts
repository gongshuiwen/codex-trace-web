import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TimelineEvent, ToolCall, TurnSummary } from '../shared/types';
import { groupAdjacentContexts } from '../client/event-presentation';
import { eventViewState } from '../client/event-view-state';
import { groupReadingProcess, latestReadingCommentary, readingProcessHasTool, readingProcessStateKey, readingProcessSummary, readingProcessToolStates, type ReadingProcessGroup } from '../client/reading-mode';
import { groupAdjacentTools } from '../client/tool-groups';
import { toolGroupViewState } from '../client/tool-view-state';
import { TurnCard } from '../client/TurnCard';
import { turnDetailCache } from '../client/turn-detail-cache';

function event(id: string, kind: TimelineEvent['kind'], text = id): TimelineEvent {
  return { id, kind, text, timestamp: '2026-11-04T00:00:00Z' };
}
function tool(id: string, status: ToolCall['status'] = 'completed'): TimelineEvent {
  return { ...event(`event-${id}`, 'tool'), tool: { id, name: 'functions.exec_command', category: 'command', arguments: JSON.stringify({ cmd: id }), output: '', outputLength: 0, outputTruncated: false, status } };
}
function reading(events: TimelineEvent[]) { return groupReadingProcess(groupAdjacentContexts(groupAdjacentTools(events))); }
function process(events: TimelineEvent[]): ReadingProcessGroup { return reading(events)[0] as ReadingProcessGroup; }

describe('reading process boundaries', () => {
  it('preserves order and keeps every user, final answer and notice outside process groups', () => {
    const events = [event('context', 'context'), event('progress', 'commentary'), tool('first'), event('follow-up', 'user'),
      event('thinking', 'reasoning'), event('compaction', 'notice'), tool('second'), event('answer', 'assistant'), event('warning', 'notice'), event('other', 'unknown')];
    const result = reading(events);
    expect(result.map(entry => [entry.kind, entry.id])).toEqual([
      ['reading-process', 'context'], ['user', 'follow-up'], ['reading-process', 'thinking'], ['notice', 'compaction'],
      ['reading-process', 'second'], ['assistant', 'answer'], ['notice', 'warning'], ['reading-process', 'other'],
    ]);
    const expanded = result.flatMap(entry => entry.kind === 'reading-process' ? entry.entries : [entry])
      .flatMap(entry => entry.kind === 'tool-group' || entry.kind === 'context-group' ? entry.events : [entry]);
    expect(expanded).toEqual(events);
  });

  it('counts grouped records and retains failed and running tool states in the collapsed summary', () => {
    const group = process([tool('failed', 'failed'), tool('running', 'running'), tool('unknown', 'unknown'), event('note', 'commentary'), event('thought', 'reasoning'), event('context-a', 'context'), event('context-b', 'context'), event('agent', 'collaboration')]);
    expect(readingProcessSummary(group)).toBe('3 次工具调用 · 1 条说明 · 1 条推理摘要 · 2 项上下文 · 1 条协作记录');
    expect(readingProcessToolStates(group)).toEqual({ failed: 1, running: 1, unknown: 1 });
    expect(readingProcessHasTool(group, 'failed')).toBe(true);
    expect(readingProcessHasTool(group, 'missing')).toBe(false);
  });

  it('keeps stable group identities as live records append without moving the latest commentary', () => {
    const before = reading([event('first', 'commentary'), event('boundary', 'notice'), event('last', 'commentary')]);
    const after = reading([event('first', 'commentary'), event('boundary', 'notice'), event('last', 'commentary'), tool('new'), event('empty', 'commentary', '  ')]);
    expect(before.map(entry => entry.id)).toEqual(after.map(entry => entry.id));
    expect(latestReadingCommentary(after)).toEqual({ groupId: 'last', event: event('last', 'commentary') });
    expect(latestReadingCommentary(reading([tool('only-tool')]))).toBeUndefined();
  });
});

describe('reading mode turn rendering', () => {
  const usage = { tokens: null, requestCount: 0, completeness: 'unknown' as const, latestInputTokens: null, contextWindow: null };
  function render(sessionId: string, events: TimelineEvent[], options: { readingMode?: boolean; status?: TurnSummary['status']; target?: { toolId: string; kind: 'search' | 'failure' } } = {}) {
    const turn: TurnSummary = { id: 'turn', index: 0, prompt: 'USER_REQUEST', preview: '', startedAt: '2026-11-04T00:00:00Z', status: options.status ?? 'completed', model: 'test', toolCount: events.filter(entry => entry.kind === 'tool').length, usage, startOffset: 0, endOffset: 1 };
    turnDetailCache.put(sessionId, turn.id, 'revision', { summary: turn, events: [event('request', 'user', 'USER_REQUEST'), ...events], requests: [], warnings: [] });
    return renderToStaticMarkup(createElement(TurnCard, { turn, sessionId, revision: 'revision', onInspect() {}, targetTurn: null, readingMode: options.readingMode, onNavigateFinalAnswer() {},
      toolTarget: options.target && { turnId: turn.id, eventId: `event-${options.target.toolId}`, toolId: options.target.toolId, kind: options.target.kind, version: 1, reveal: true },
    }));
  }

  it('keeps the full timeline as the default and gives both modes the same block process anchor', () => {
    const events = [event('process', 'commentary', 'PROCESS_BODY'), event('answer', 'assistant', 'FINAL_BODY')];
    const full = render('reading-full-default', events);
    const compact = render('reading-compact', events, { readingMode: true });
    expect(full).toContain('PROCESS_BODY');
    expect(full).toContain('class="reading-process-full"');
    expect(compact).not.toContain('PROCESS_BODY');
    expect(full.match(/data-process-id="[^"]+"/)?.[0]).toBe(compact.match(/data-process-id="[^"]+"/)?.[0]);
    expect(compact).toContain('USER_REQUEST');
    expect(compact).toContain('FINAL_BODY');
    expect(compact).toContain('data-event-id="answer"');
    expect(compact).toContain('跳到最终答复');
  });

  it('keeps supplemental users, notices and compaction anchors visible while process content is collapsed', () => {
    const html = render('reading-boundary-render', [event('process-a', 'commentary', 'HIDDEN_A'), event('follow-up', 'user', 'FOLLOW_UP'),
      event('compaction', 'notice', 'COMPACTION_NOTICE'), event('process-b', 'commentary', 'HIDDEN_B'), event('answer', 'assistant', 'ANSWER')].map(entry => entry.id === 'compaction' ? { ...entry, noticeType: 'compaction' } : entry), { readingMode: true });
    expect(html).toContain('FOLLOW_UP');
    expect(html).toContain('COMPACTION_NOTICE');
    expect(html).toContain('data-compaction-event-id="compaction"');
    expect(html).not.toContain('HIDDEN_A');
    expect(html).not.toContain('HIDDEN_B');
  });

  it('shows only the latest live commentary once and removes its separate preview when expanded', () => {
    const events = [event('old', 'commentary', 'OLD_PROGRESS'), event('last', 'commentary', 'LATEST_PROGRESS')];
    const closed = render('reading-live-closed', events, { readingMode: true, status: 'running' });
    expect(closed).not.toContain('OLD_PROGRESS');
    expect(closed.match(/LATEST_PROGRESS/g)).toHaveLength(1);
    eventViewState.set('reading-live-open', readingProcessStateKey('turn', 'old'), true);
    const opened = render('reading-live-open', events, { readingMode: true, status: 'running' });
    expect(opened).toContain('OLD_PROGRESS');
    expect(opened.match(/LATEST_PROGRESS/g)).toHaveLength(1);
  });

  it('shows one live fallback when no commentary exists', () => {
    const html = render('reading-live-no-commentary', [tool('first'), event('boundary', 'notice'), tool('second')], { readingMode: true, status: 'running' });
    expect(html.match(/正在执行，展开查看最新过程/g)).toHaveLength(1);
    expect(render('reading-live-empty', [], { readingMode: true, status: 'running' })).toContain('正在等待新的执行记录');
  });

  it('keeps every abnormal tool state visible outside the collapsed process body', () => {
    const html = render('reading-visible-tool-states', [tool('failed', 'failed'), tool('running', 'running'), tool('unknown', 'unknown')], { readingMode: true });
    expect(html).toContain('reading-process-failed">1 失败');
    expect(html).toContain('reading-process-running">1 运行中');
    expect(html).toContain('reading-process-unknown">1 结果未记录');
    expect(html).not.toContain('class="tool-call-row"');
  });

  it.each(['search', 'failure'] as const)('reveals the containing process and tool group for a %s target', kind => {
    const html = render(`reading-reveal-${kind}`, [tool('target', 'failed'), event('answer', 'assistant')], { readingMode: true, target: { kind, toolId: 'target' } });
    expect(html).toContain('data-tool-id="target"');
    expect(html).toMatch(/class="reading-process-toggle" aria-expanded="true"/);
    expect(html).toContain('class="tool-call-row"');
  });

  it('remembers process choices independently by session and turn and leaves tool preferences intact', () => {
    const events = [event('progress', 'commentary', 'REMEMBERED_PROCESS'), tool('remembered')];
    eventViewState.set('reading-state', readingProcessStateKey('turn', 'progress'), true);
    toolGroupViewState.set('reading-state', 'turn:remembered', { open: true, tab: 'result' });
    const html = render('reading-state', events, { readingMode: true });
    expect(html).toContain('REMEMBERED_PROCESS');
    expect(html).toContain('data-tool-id="remembered"');
    expect(render('reading-other-session', events, { readingMode: true })).not.toContain('REMEMBERED_PROCESS');
    expect(eventViewState.get('reading-state', readingProcessStateKey('different-turn', 'progress'))).toBeUndefined();
    expect(toolGroupViewState.get('reading-state', 'turn:remembered')?.open).toBe(true);
  });
});
