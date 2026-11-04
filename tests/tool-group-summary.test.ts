import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../shared/types';
import { summarizeToolGroup } from '../client/tool-group-summary';

function tool(id: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return { id, name: 'functions.exec_command', category: 'other', arguments: '{}', output: '',
    outputLength: 0, outputTruncated: false, status: 'completed', ...overrides };
}

describe('tool group category summary', () => {
  it('counts recorded calls by parsed category, retaining first-appearance order', () => {
    const tools = [
      tool('command-1'),
      tool('patch', { name: 'functions.apply_patch', arguments: '*** Begin Patch\n*** Add File: one.ts\n+one\n*** Add File: two.ts\n+two\n*** End Patch' }),
      tool('command-2', { name: 'functions.write_stdin', arguments: '{"session_id":42}' }),
      tool('web', { name: 'web.run', arguments: '{"search_query":[{"q":"source"}]}' }),
      tool('mcp', { name: 'mcp__filesystem__read_file', arguments: '{"path":"client/App.tsx"}' }),
      tool('agent', { name: 'collaboration.spawn_agent', arguments: '{"task_name":"review"}' }),
      tool('other', { name: 'vendor.unknown' }),
    ];
    const result = summarizeToolGroup(tools);
    expect(result.categories).toEqual([
      { category: 'command', label: '命令', count: 2 },
      { category: 'patch', label: '补丁', count: 1 },
      { category: 'web', label: '网页', count: 1 },
      { category: 'mcp', label: 'MCP', count: 1 },
      { category: 'agent', label: '协作', count: 1 },
      { category: 'other', label: '其他', count: 1 },
    ]);
    expect(result.categories.reduce((sum, item) => sum + item.count, 0)).toBe(tools.length);
    expect(result.categoryText).toBe('命令 2 · 补丁 1 · 网页 1 · MCP 1 · 协作 1 · 其他 1');
  });

  it.each(['functions.exec', 'functions__exec', 'exec'])('counts %s as one script without inventing nested file or command operations', name => {
    const code = 'await tools.exec_command({cmd: "Get-Content file.txt"}); await tools.apply_patch("*** Update File: file.txt");';
    const result = summarizeToolGroup([tool('script', { name, category: 'command', arguments: JSON.stringify({ title: '检查文件', code }) })]);
    expect(result.categories).toEqual([{ category: 'script', label: '脚本', count: 1 }]);
    expect(result.categoryText).toBe('脚本 1');
    expect(result.categoryText).not.toMatch(/读取|修改|命令|补丁/);
  });

  it('keeps a single call action and recorded target distinguishable', () => {
    const result = summarizeToolGroup([tool('one', { name: 'mcp__filesystem__read_file', arguments: '{"path":"client/App.tsx"}' })]);
    expect(result.singlePreview).toBe('调用 read_file · client/App.tsx');
    expect(result.categories).toEqual([{ category: 'mcp', label: 'MCP', count: 1 }]);
    expect(result.firstFailure).toBeUndefined();
  });

  it('supports an empty input without creating a call or failure', () => {
    expect(summarizeToolGroup([])).toEqual({ categories: [], categoryText: '', singlePreview: undefined, firstFailure: undefined });
  });
});

describe('first recorded failure in a tool group', () => {
  it('selects the first failed call, even when a later failed call has a more readable diagnostic', () => {
    const result = summarizeToolGroup([
      tool('returned', { output: 'Error: expected fixture text' }),
      tool('unknown', { status: 'unknown', output: 'Error: untrusted text' }),
      tool('first-failure', { status: 'failed', output: 'All checks passed' }),
      tool('later-failure', { status: 'failed', output: 'TypeError: later diagnostic' }),
    ]);
    expect(result.firstFailure).toEqual({ toolId: 'first-failure', title: '运行命令', preview: '运行命令 · 日志记录了失败标记，未提供诊断' });
    expect(result.firstFailure?.preview).not.toMatch(/checks passed|later diagnostic|expected fixture/);
  });

  it('reuses compiler diagnostics from a genuinely failed recorded call', () => {
    const diagnostic = 'client/App.tsx(12,4): error TS2322: invalid type';
    const result = summarizeToolGroup([tool('build', { status: 'failed', exitCode: 2, output: `starting\n${diagnostic}\ntrace` })]);
    expect(result.firstFailure).toEqual({ toolId: 'build', title: '运行命令', preview: `运行命令 · ${diagnostic}` });
  });

  it('falls back to the recorded exit code without treating ordinary output as an error', () => {
    const result = summarizeToolGroup([tool('exit', { status: 'failed', exitCode: 2, output: '{"exit_code":128,"output":"All checks passed"}' })]);
    expect(result.firstFailure?.preview).toBe('运行命令 · 退出码 2（日志记录失败）');
    expect(result.firstFailure?.preview).not.toContain('checks passed');
  });

  it('keeps nested execution metadata out of the collapsed diagnostic preview', () => {
    const output = JSON.stringify({ i: 0, status: 'fulfilled', value: { chunk_id: 'fixture', output: 'client/App.tsx(12,4): error TS2322: invalid type' } });
    const result = summarizeToolGroup([tool('nested', { name: 'functions.exec', status: 'failed', exitCode: 2, output })]);
    expect(result.firstFailure?.preview).toBe('执行脚本 · 退出码 2（日志记录失败）');
    expect(result.firstFailure?.preview).not.toContain('chunk_id');
  });

  it('uses an exit code from a complete execution envelope when there is no separate code', () => {
    const result = summarizeToolGroup([tool('envelope', { status: 'failed', output: '{"exit_code":7,"output":"no readable diagnostic"}' })]);
    expect(result.firstFailure?.preview).toBe('运行命令 · 退出码 7（日志记录失败）');
  });

  it('does not decode an exit code from an explicitly truncated result', () => {
    const result = summarizeToolGroup([tool('partial', { status: 'failed', outputTruncated: true, output: '{"exit_code":7,"output":"partial"}' })]);
    expect(result.firstFailure?.preview).toBe('运行命令 · 日志记录了失败标记，未提供诊断');
  });

  it('preserves an explicit zero code alongside a recorded failure marker', () => {
    expect(summarizeToolGroup([tool('zero', { status: 'failed', exitCode: 0 })]).firstFailure?.preview)
      .toBe('运行命令 · 退出码 0（日志记录失败）');
  });

  it.each(['completed', 'running', 'unknown'] as const)('does not invent failure for %s based on an error-looking string or inconsistent exit code', status => {
    expect(summarizeToolGroup([tool('non-failure', { status, output: 'fatal: fixture text', exitCode: 2 })]).firstFailure).toBeUndefined();
  });
});
