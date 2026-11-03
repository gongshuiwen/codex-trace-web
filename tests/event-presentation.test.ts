import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../shared/types';
import { contextPresentation, groupAdjacentContexts } from '../client/event-presentation';

function event(id: string, kind: TimelineEvent['kind'] = 'context', text = id): TimelineEvent {
  return { id, kind, text, timestamp: '2026-11-03T00:00:00Z' };
}

describe('context event grouping', () => {
  it('wraps single records and adjacent runs while preserving every original event', () => {
    const events = Object.freeze([event('a'), event('b'), event('request', 'user'), event('c'), event('answer', 'assistant')]);
    const snapshot = JSON.stringify(events);
    const grouped = groupAdjacentContexts(events);
    expect(grouped.map(entry => entry.kind)).toEqual(['context-group', 'user', 'context-group', 'assistant']);
    expect(grouped.flatMap(entry => entry.kind === 'context-group' ? entry.events : [entry])).toEqual(events);
    expect(grouped[0]).toMatchObject({ id: 'a', events: [events[0], events[1]] });
    expect(grouped[2]).toMatchObject({ id: 'c', events: [events[3]] });
    expect(JSON.stringify(events)).toBe(snapshot);
    expect(grouped[0].kind === 'context-group' && grouped[0].events[0]).toBe(events[0]);
  });

  it.each(['user', 'assistant', 'commentary', 'reasoning', 'tool', 'collaboration', 'notice', 'unknown'] as const)('never crosses %s events', kind => {
    expect(groupAdjacentContexts([event('a'), event('boundary', kind), event('b')]).map(entry => entry.kind)).toEqual(['context-group', kind, 'context-group']);
  });

  it('keeps identities stable when context is appended and supports empty input', () => {
    expect(groupAdjacentContexts([event('first')])[0].id).toBe(groupAdjacentContexts([event('first'), event('next')])[0].id);
    expect(groupAdjacentContexts([])).toEqual([]);
  });


});

describe('context event presentation', () => {
  it.each([
    ['# AGENTS.md instructions\n<INSTRUCTIONS>Use pwsh 7+</INSTRUCTIONS>', '项目指令', 'Use pwsh 7+'],
    ['<INSTRUCTIONS>Project rules</INSTRUCTIONS>', '项目指令', 'Project rules'],
    ['<user_instructions>Project rules</user_instructions>', '项目指令', 'Project rules'],
    ['<skills_instructions>Available skills</skills_instructions>', 'Skills', 'Available skills'],
    ['## Skills\nAvailable skills', 'Skills', 'Available skills'],
    ['<environment_context>cwd: E:/workspace\n shell: pwsh</environment_context>', '环境信息', 'cwd: E:/workspace shell: pwsh'],
    ['<system_instructions>Runtime rules</system_instructions>', '系统 / 开发者指令', 'Runtime rules'],
    ['<developer_instructions>Runtime rules</developer_instructions>', '系统 / 开发者指令', 'Runtime rules'],
    ['<developer>Runtime rules</developer>', '系统 / 开发者指令', 'Runtime rules'],
    ['<system>Runtime rules</system>', '系统 / 开发者指令', 'Runtime rules'],
    ['<permissions instructions>Filesystem rules</permissions instructions>', '系统 / 开发者指令', 'Filesystem rules'],
    ['# Developer instructions\nRuntime rules', '系统 / 开发者指令', 'Runtime rules'],
    ['# System instructions\nRuntime rules', '系统 / 开发者指令', 'Runtime rules'],
  ])('classifies explicit marker %s', (text, label, preview) => {
    const source = Object.freeze(event('context', 'context', text));
    expect(contextPresentation(source)).toEqual({ label, preview });
    expect(source.text).toBe(text);
  });

  it.each([
    'This body mentions skills, tools and AGENTS.md.',
    'Developer instructions',
    'Read SKILL.md before continuing.',
    'A quoted example: <skills_instructions>skill catalog</skills_instructions>',
    '# Skills report\nThe catalog has changed.',
    '# AGENTS.md instructions review\nCheck these changes.',
    '{"cwd":"E:/workspace","model":"codex"}',
    '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>',
  ])('keeps ambiguous source text as attached context: %s', text => {
    expect(contextPresentation(event('context', 'context', text)).label).toBe('附带上下文');
  });

  it('normalizes whitespace, limits previews and preserves Unicode characters', () => {
    const source = event('context', 'context', ` <skills_instructions>\n ${'😀'.repeat(120)} \n </skills_instructions> `);
    const { preview } = contextPresentation(source);
    expect(Array.from(preview)).toHaveLength(100);
    expect(preview).toBe(`${'😀'.repeat(99)}…`);
    expect(source.text).toContain('<skills_instructions>');
    expect(contextPresentation(event('empty', 'context', '  ')).preview).toBe('');
    expect(contextPresentation(event('short', 'context', ' first\n\tsecond ')).preview).toBe('first second');
  });
});
