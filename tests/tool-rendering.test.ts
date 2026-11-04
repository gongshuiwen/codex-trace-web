import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TimelineEvent, ToolCall } from '../shared/types';
import { ToolCard } from '../client/ToolCard';
import { ToolGroup } from '../client/ToolGroup';
import { ToolContent } from '../client/ToolContent';
import { ToolResult } from '../client/ToolResult';
import { toolPresentation } from '../client/tool-presentation';
import { toolGroupViewState, toolViewState } from '../client/tool-view-state';
import { groupAdjacentTools, type ToolGroupEntry } from '../client/tool-groups';
import type { ToolNavigationTarget } from '../client/tool-navigation';

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: 'example', name: 'functions.exec_command', category: 'command', arguments: '{"cmd":"pnpm typecheck"}', output: '', outputLength: 0, outputTruncated: false, status: 'completed', ...overrides };
}

function result(value: ToolCall, complete = true) {
  return renderToStaticMarkup(createElement(ToolResult, { tool: value, presentation: toolPresentation(value), output: value.output, complete }));
}

describe('tool result rendering', () => {
  it('distinguishes a returned result from an explicitly successful command', () => {
    const render = (value: ToolCall) => renderToStaticMarkup(createElement(ToolCard, { tool: value, sessionId: 'rendering', revision: 'revision' }));
    expect(render(tool())).toContain('已返回');
    expect(render(tool({ exitCode: 0 }))).toContain('完成');
    expect(render(tool({ status: 'unknown' }))).toContain('结果未记录');
  });

  it('keeps failed rows collapsed until their inline details are expanded', () => {
    const value = tool({ status: 'failed', exitCode: 2, output: 'client/ToolCard.tsx(18,7): error TS2322: Type mismatch.' });
    const html = renderToStaticMarkup(createElement(ToolCard, { tool: value, sessionId: 'rendering', revision: 'revision' }));
    expect(html).toContain('失败');
    expect(html).toContain('退出码 2');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="tabpanel"');
    expect(html).not.toContain('error TS2322');
    expect(result(value)).toContain('检测到的诊断');
    expect(result(value)).toContain('error TS2322');
  });

  it('treats diff body lines resembling file headers as additions and removals', () => {
    const html = result(tool({ name: 'apply_patch', category: 'patch', arguments: '*** Begin Patch\n*** Update File: notes.md\n@@\n--- old title\n+++ new title\n*** End Patch' }));
    expect(html).toContain('class="tool-diff-remove">--- old title');
    expect(html).toContain('class="tool-diff-add">+++ new title');
  });

  it('does not claim that a failed patch was applied', () => {
    const html = result(tool({ name: 'apply_patch', category: 'patch', status: 'failed', arguments: '*** Begin Patch\n*** Add File: notes.md\n+hello\n*** End Patch', output: 'Error: cannot write file' }));
    expect(html).toContain('请求的补丁内容');
    expect(html).not.toContain('已应用');
  });

  it('preserves missing and empty returns as different states', () => {
    expect(result(tool({ status: 'unknown' }))).toContain('未记录对应返回');
    expect(result(tool())).toContain('返回内容为空');
  });

  it('unwraps command output while leaving ordinary structured data visible', () => {
    const command = result(tool({ output: '{"exit_code":0,"output":"command output"}' }));
    expect(command).toContain('<code>command output</code>');
    const structured = result(tool({ category: 'mcp', name: 'mcp__demo__query', output: '{"count":0,"ready":false,"result":null}' }));
    expect(structured).toContain('结构化返回');
    expect(structured).toContain('false');
    expect(structured).toContain('null');
  });

  it('renders safe search links and falls back to structured text for unsafe addresses', () => {
    const search = (url: string) => result(tool({ category: 'web', name: 'web.run', output: JSON.stringify({ results: [{ title: 'Documentation', url }] }) }));
    expect(search('https://example.com/docs')).toContain('href="https://example.com/docs"');
    expect(search('javascript:alert(1)')).not.toContain('href=');
    expect(search('javascript:alert(1)')).toContain('结构化返回');
  });

  it('keeps incomplete JSON as escaped text rather than a tree', () => {
    const html = result(tool({ category: 'mcp', output: '{"message":"<script>"}', outputTruncated: true }), false);
    expect(html).not.toContain('aria-label="结构化返回"');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('unified compact tool groups', () => {
  function group(values: ToolCall[]): ToolGroupEntry {
    const events: TimelineEvent[] = values.map(value => ({ id: `event-${value.id}`, kind: 'tool', timestamp: '', text: value.name, tool: value }));
    return groupAdjacentTools(events)[0] as ToolGroupEntry;
  }
  function render(value: ToolGroupEntry, sessionId: string, target?: ToolNavigationTarget) {
    return renderToStaticMarkup(createElement(ToolGroup, { group: value, turnId: 'turn', sessionId, revision: 'revision', target }));
  }

  it.each([1, 2])('uses the same collapsed group container for %s calls', count => {
    const value = group(Array.from({ length: count }, (_,index) => tool({ id: `shared-${index}` })));
    const html = render(value, `unified-default-${count}`);
    expect(html).toContain('class="tool-group"');
    expect(html).toContain('data-tool-group-id="turn:shared-0"');
    expect(html).toContain(`${count} 次工具调用`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('class="tool-call-row"');
    expect(html).not.toContain('role="tabpanel"');
    expect(html.match(/aria-expanded=/g)).toHaveLength(1);
  });

  it('starts failed groups collapsed while retaining their failure summary', () => {
    const html = render(group([tool({ status: 'failed', exitCode: 2, output: 'RAW_FAILURE_BODY' })]), 'unified-failed-default');
    expect(html).toContain('1 失败');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('RAW_FAILURE_BODY');
    expect(html).not.toContain('role="tabpanel"');
  });

  it('keeps group categories, recorded states and an independent first-failure detail action in the collapsed header', () => {
    const html = render(group([
      tool({ id: 'command', status: 'completed' }),
      tool({ id: 'script', name: 'functions.exec', status: 'unknown' }),
      tool({ id: 'failure', status: 'failed', output: 'TypeError: recorded failure' }),
      tool({ id: 'mcp', name: 'mcp__service__fetch', category: 'mcp', status: 'running' }),
    ]), 'group-category-failure-summary');
    expect(html).toContain('命令 2 · 脚本 1 · MCP 1');
    expect(html).toContain('1 运行中');
    expect(html).toContain('1 结果未记录');
    expect(html).toContain('1 已返回');
    expect(html).toContain('TypeError: recorded failure');
    expect(html).toContain('展开本组首条失败调用');
    expect(html).toMatch(/<\/button><button[^>]*class="tool-group-failure-action"/);
    expect(html).not.toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('成功');
    expect(html).not.toContain('class="tool-call-row"');
  });

  it.each([1, 3])('bulk expansion applies to %s previously unmounted calls without rendering their raw content', count => {
    const sessionId = `unified-bulk-${count}`;
    const values = Array.from({length: count}, (_,index) => tool({id: `bulk-${index}`, arguments: '{"cmd":"synthetic-check","extra":"RAW_ARGUMENT_BODY"}', output: 'RAW_OUTPUT_BODY'}));
    toolGroupViewState.setAll(sessionId, true);
    const html = render(group(values), sessionId);
    expect(html).toContain('aria-expanded="true"');
    expect(html.match(/class="tool-call-row"/g)).toHaveLength(count);
    expect(html.match(/aria-expanded=/g)).toHaveLength(count + 1);
    expect(html).not.toContain('RAW_ARGUMENT_BODY');
    expect(html).not.toContain('RAW_OUTPUT_BODY');
    expect(html).not.toContain('role="tabpanel"');
  });

  it('uses a manual group choice until a later bulk command replaces it', () => {
    const sessionId = 'unified-manual-over-bulk', value = group([tool()]);
    toolGroupViewState.setAll(sessionId, true);
    toolGroupViewState.set(sessionId, `turn:${value.id}`, {open: false, tab: 'result'});
    expect(render(value, sessionId)).toContain('aria-expanded="false"');
    toolGroupViewState.set(sessionId, `turn:${value.id}`, {open: true, tab: 'result'});
    expect(render(value, sessionId)).toContain('aria-expanded="true"');
    toolGroupViewState.setAll(sessionId, false);
    expect(render(value, sessionId)).toContain('aria-expanded="false"');
  });

  it.each(['search', 'failure'] as const)('reveals the %s target and its inline details over a saved collapse', kind => {
    const sessionId = `unified-target-${kind}`, value = group([tool({status: 'failed'})]);
    toolGroupViewState.setAll(sessionId, false);
    const html = render(value, sessionId, {
      turnId: 'turn', eventId: 'event-example', toolId: 'example', kind, version: 9001, reveal: true,
      ...(kind === 'search' ? {location: {field: 'arguments' as const, offset: 8, length: 4, query: 'pnpm', matchedText: 'pnpm'}} : {}),
    });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(`tool-${kind}-target`);
    expect(html).toContain('data-tool-id="example"');
    expect(html).toContain('role="tabpanel"');
    if (kind === 'search') expect(html).toContain('>pnpm</mark>');
  });

  it('renders an individual row as a collapsed inline disclosure', () => {
    const html = renderToStaticMarkup(createElement(ToolCard, {tool: tool({arguments: '{"title":"检查紧凑调用","cmd":"pnpm typecheck"}', status: 'failed'}), eventId: 'row-event', sessionId: 'row', revision: 'revision'}));
    expect(html).toContain('检查紧凑调用');
    expect(html).toContain('pnpm typecheck');
    expect(html).toContain('失败');
    expect(html).not.toContain('aria-haspopup="dialog"');
    expect(html).toContain('data-event-id="row-event"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="tabpanel"');
  });
});

describe('inline tool detail content', () => {
  it('keeps the saved detail tab when group expansion changes', () => {
    const sessionId = 'detail-tab-independent', value = tool();
    toolViewState.set(sessionId, value.id, {open: true, tab: 'arguments'});
    toolGroupViewState.setAll(sessionId, true); toolGroupViewState.setAll(sessionId, false);
    const html = renderToStaticMarkup(createElement(ToolContent, {tool: value, sessionId, revision: 'revision'}));
    expect(html).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>调用参数<\/button>/);
    expect(html).toContain('pnpm typecheck');
  });

  it('selects the matching detail tab and marks the exact argument location for search', () => {
    const html = renderToStaticMarkup(createElement(ToolContent, {
      tool: tool(), sessionId: 'detail-search', revision: 'revision', navigationId: 9002,
      search: {field: 'arguments', offset: 8, length: 4, query: 'pnpm', matchedText: 'pnpm'},
    }));
    expect(html).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>调用参数<\/button>/);
    expect(html).toContain('>pnpm</mark>');
  });
});
