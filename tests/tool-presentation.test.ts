import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../shared/types';
import { readToolOutput, toolPresentation, webResultLinks } from '../client/tool-presentation';

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: 'call-1', name: 'functions.exec_command', category: 'other', arguments: '{}', output: '',
    outputLength: 0, outputTruncated: false, status: 'completed', ...overrides };
}

describe('tool presentation', () => {
  it.each(['exec_command', 'functions.exec_command', 'functions__exec_command', 'mcp__functions__exec_command', 'local_shell_call'])(
    'recognizes recorded command name %s and keeps the command and working directory', name => {
      const result = toolPresentation(tool({ name, arguments: JSON.stringify({ cmd: 'pnpm test\n--run', workdir: 'E:/workspace', shell: 'pwsh' }) }));
      expect(result).toMatchObject({ category: 'command', title: '运行命令', subtitle: 'pnpm test --run', command: 'pnpm test\n--run', cwd: 'E:/workspace', shell: 'pwsh' });
    });

  it('prefers recorded titles and descriptions without losing the distinguishing command', () => {
    const result = toolPresentation(tool({ arguments: JSON.stringify({ title: '检查工作区', description: '枚举源文件', command: ['rg', '--files', 'my folder'] }) }));
    expect(result.title).toBe('检查工作区');
    expect(result.subtitle).toBe('rg --files "my folder"');
    expect(toolPresentation(tool({ arguments: '{"description":"执行构建","cmd":"pnpm build"}' })).title).toBe('执行构建');
  });

  it('reads the recorded local shell exec action as display data', () => {
    const args = { action: { type: 'exec', command: ['pwsh', '-Command', 'Get-Content "a file.txt"'], working_directory: 'E:/workspace/demo' } };
    const result = toolPresentation(tool({ name: 'local_shell', arguments: JSON.stringify(args) }));
    expect(result).toMatchObject({ category: 'command', title: '运行命令',
      command: 'pwsh -Command "Get-Content \\"a file.txt\\""', cwd: 'E:/workspace/demo' });
    expect(result.subtitle).toBe(result.command);
    expect(args.action.command).toEqual(['pwsh', '-Command', 'Get-Content "a file.txt"']);
    expect(toolPresentation(tool({ name: 'local_shell_call', arguments: '{"action":{"type":"inspect","command":["do-not-treat-as-exec"],"working_directory":"/ignored"}}' })).command).toBeUndefined();
  });

  it.each(['functions.exec', 'functions__exec', 'exec'])('preserves %s as one script without inventing inner commands', name => {
    const script = '// @exec: {"max_output_tokens": 1000}\nconst results = await Promise.all([tools.exec_command({cmd: "pnpm test"}), tools.exec_command({cmd: "pnpm build"})]);';
    const result = toolPresentation(tool({ name, category: 'command', arguments: script }));
    expect(result).toMatchObject({ category: 'other', title: '执行脚本', patchFiles: [], queries: [] });
    expect(result.command).toBeUndefined();
    expect(result.subtitle).toContain('Promise.all');
    expect(result.target).toBeUndefined();
  });

  it('summarizes script arguments recorded as JSON without reclassifying their inner command', () => {
    expect(toolPresentation(tool({ name: 'functions.exec', arguments: JSON.stringify({ code: 'await tools.exec_command({cmd: "pnpm test"});' }) })))
      .toMatchObject({ category: 'other', title: '执行脚本', subtitle: 'await tools.exec_command({cmd: "pnpm test"});', command: undefined });
  });

  it('retains the recorded category for an unfamiliar tool and safely handles malformed input', () => {
    const result = toolPresentation(tool({ name: 'vendor.fetch_resource', category: 'mcp', arguments: 'not json' }));
    expect(result).toMatchObject({ category: 'mcp', title: '调用 fetch_resource', patchFiles: [], queries: [] });
    expect(result.subtitle).toBeUndefined();
  });

  it('summarizes explicit targets in MCP and agent calls', () => {
    expect(toolPresentation(tool({ name: 'mcp__filesystem__read_file', category: 'mcp', arguments: '{"path":"client/App.tsx"}' })))
      .toMatchObject({ title: '调用 read_file', subtitle: 'client/App.tsx', target: 'client/App.tsx' });
    expect(toolPresentation(tool({ name: 'collaboration.spawn_agent', arguments: '{"task_name":"review_tools","message":"Review the implementation"}' })))
      .toMatchObject({ category: 'agent', title: '启动子代理', subtitle: 'review_tools' });
    expect(toolPresentation(tool({ name: 'functions.write_stdin', arguments: '{"session_id":42}' })))
      .toMatchObject({ category: 'command', title: '继续读取进程', subtitle: '进程 42' });
  });

  it('distinguishes MCP calls by their recorded method and short resource target', () => {
    for (const table of ['tool_runs', 'tool_events']) {
      expect(toolPresentation(tool({ name: 'mcp__database__query_records', category: 'mcp', arguments: JSON.stringify({ table, filters: { active: true } }) })))
        .toMatchObject({ title: '调用 query_records', subtitle: table, target: table });
    }
    expect(toolPresentation(tool({ name: 'mcp__documents__GetPage', category: 'mcp', arguments: '{"page_id":"page-42"}' })))
      .toMatchObject({ title: '调用 GetPage', subtitle: 'page-42', target: 'page-42' });
  });

  it.each(['collection', 'resource', 'document_id'])('uses an explicitly recorded MCP %s target', field => {
    expect(toolPresentation(tool({ name: 'mcp__service__fetch', category: 'mcp', arguments: JSON.stringify({ [field]: 'resource-42' }) })))
      .toMatchObject({ title: '调用 fetch', subtitle: 'resource-42', target: 'resource-42' });
  });

  it.each(['web.run', 'web__run', 'functions.search_query'])('summarizes query arguments for %s without interpreting unknown search output', name => {
    const result = toolPresentation(tool({ name, arguments: '{"search_query":[{"q":"Codex tools"},{"q":"Codex UI"},{"q":"Codex tools"}]}' }));
    expect(result).toMatchObject({ category: 'web', title: '搜索资料', queries: ['Codex tools', 'Codex UI'], subtitle: 'Codex tools；Codex UI' });
    expect(readToolOutput('ordinary search response', true)).toEqual({ text: 'ordinary search response', envelope: false });
  });

  it('extracts a webpage target from a recorded open action', () => {
    expect(toolPresentation(tool({ name: 'web.run', arguments: '{"open":[{"ref_id":"https://example.com/docs"}]}' })))
      .toMatchObject({ title: '读取网页', subtitle: 'https://example.com/docs' });
  });

  it('does not infer failure or success from words in a completed output', () => {
    expect(toolPresentation(tool({ output: 'Error: the fixture includes this expected text', status: 'completed' })).diagnostic).toBeUndefined();
    expect(toolPresentation(tool({ output: 'All tests passed', status: 'failed' })).diagnostic).toBeUndefined();
    expect(toolPresentation(tool({ output: 'Some error was fixed earlier', status: 'failed' })).diagnostic).toBeUndefined();
  });

  it('extracts explicit diagnostics only for a recorded failure', () => {
    expect(toolPresentation(tool({ status: 'failed', output: 'before\nTypeError: invalid input\ntrace' })).diagnostic).toBe('TypeError: invalid input');
    expect(toolPresentation(tool({ status: 'failed', output: '{"output":"fatal: missing repository","exit_code":128}' })).diagnostic).toBe('fatal: missing repository');
    expect(toolPresentation(tool({ status: 'failed', output: '{"error":{"message":"Missing required token"}}' })).diagnostic).toBe('Missing required token');
    expect(toolPresentation(tool({ status: 'failed', output: 'npm ERR! missing script: test' })).diagnostic).toBe('npm ERR! missing script: test');
    expect(toolPresentation(tool({ status: 'running', output: 'Error: previous output' })).diagnostic).toBeUndefined();
  });

  it.each([
    'client/ToolCard.tsx(18,7): error TS2322: Type string is not assignable to type number.',
    'client/ToolCard.tsx:18:7: error TS2322: Type string is not assignable to type number.',
    'E:\\workspace\\native\\main.cpp:18:7: error: missing semicolon',
  ])('recognizes compiler diagnostics with a source location only for failed calls: %s', diagnostic => {
    expect(toolPresentation(tool({ status: 'failed', output: `build started\n${diagnostic}\nmore output` })).diagnostic).toBe(diagnostic);
    expect(toolPresentation(tool({ status: 'completed', output: diagnostic })).diagnostic).toBeUndefined();
  });

  it('parses requested Codex add/update/delete/move changes without claiming they were applied', () => {
    const patch = '*** Begin Patch\n*** Add File: new.ts\n+export {};\n*** Update File: old.ts\n*** Move to: moved.ts\n@@\n-before\n+after\n*** Delete File: removed.ts\n*** End Patch';
    for (const status of ['failed', 'running', 'completed'] as const) {
      const result = toolPresentation(tool({ name: 'functions.apply_patch', arguments: patch, status }));
      expect(result.title).toBe('请求文件变更');
      expect(result.subtitle).toBe('new.ts · 共 3 个文件');
      expect(result.patchFiles).toEqual([
        { path: 'new.ts', kind: 'add', lines: ['+export {};'] },
        { path: 'old.ts', kind: 'move', movedTo: 'moved.ts', lines: ['@@', '-before', '+after'] },
        { path: 'removed.ts', kind: 'delete', lines: [] },
      ]);
    }
  });

  it('parses unified diff additions, deletions, updates and renames', () => {
    const patch = 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\ndiff --git a/gone.txt b/gone.txt\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\ndiff --git a/source.txt b/target.txt\nsimilarity index 100%\nrename from source.txt\nrename to target.txt\ndiff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-before\n+after';
    const result = toolPresentation(tool({ name: 'apply_patch', category: 'patch', arguments: JSON.stringify({ patch }) }));
    expect(result.patchFiles.map(({ path, kind, movedTo }) => ({ path, kind, movedTo }))).toEqual([
      { path: 'new.txt', kind: 'add', movedTo: undefined },
      { path: 'gone.txt', kind: 'delete', movedTo: undefined },
      { path: 'source.txt', kind: 'move', movedTo: 'target.txt' },
      { path: 'app.ts', kind: 'update', movedTo: undefined },
    ]);
    expect(result.patchFiles[3]!.lines).toEqual(['@@ -1 +1 @@', '-before', '+after']);
  });

  it('supports standalone unified diffs and leaves unrecognized patch arguments intact at the caller', () => {
    const patch = '--- a/one.txt\t2026-11-01\n+++ b/one.txt\t2026-11-02\n@@ -1 +1 @@\n-old\n+new\n--- /dev/null\n+++ b/two.txt\n@@ -0,0 +1 @@\n+two';
    expect(toolPresentation(tool({ name: 'apply_patch', arguments: patch })).patchFiles.map(file => [file.path, file.kind]))
      .toEqual([['one.txt', 'update'], ['two.txt', 'add']]);
    expect(toolPresentation(tool({ name: 'apply_patch', arguments: 'unknown patch format' })).patchFiles).toEqual([]);
  });

  it('keeps hunk content that resembles a second file header within its original file', () => {
    const patch = '--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n--- old title\n+++ new title';
    expect(toolPresentation(tool({ name: 'apply_patch', arguments: patch })).patchFiles).toEqual([
      { path: 'example.txt', kind: 'update', lines: ['@@ -1 +1 @@', '--- old title', '+++ new title'] },
    ]);
  });
});

describe('tool output presentation', () => {
  it('unwraps a complete execution envelope while retaining the original structured result', () => {
    const value = { chunk_id: '123', output: 'hello\n', exit_code: 0, wall_time_seconds: 0.1 };
    expect(readToolOutput(JSON.stringify(value), true)).toEqual({ text: 'hello\n', json: value, exitCode: 0, envelope: true });
    expect(readToolOutput('{"output":"working","session_id":42}', true)).toMatchObject({ text: 'working', envelope: true });
  });

  it('does not unwrap an arbitrary business object with an output property', () => {
    const value = '{"output":"business result","name":"record"}';
    expect(readToolOutput(value, true)).toEqual({ text: value, json: JSON.parse(value), envelope: false });
  });

  it('provides complete JSON values and preserves plain text', () => {
    expect(readToolOutput('[{"key":1},null]', true)).toEqual({ text: '[{"key":1},null]', json: [{ key: 1 }, null], envelope: false });
    expect(readToolOutput('null', true)).toEqual({ text: 'null', json: null, envelope: false });
    expect(readToolOutput('not JSON', true)).toEqual({ text: 'not JSON', envelope: false });
  });

  it('never builds a JSON tree or unwraps content known to be truncated', () => {
    for (const value of ['{"key":', '{"output":"text","exit_code":0}', '[1,2]']) {
      expect(readToolOutput(value, false)).toEqual({ text: value, envelope: false });
    }
  });
});

describe('web result links', () => {
  const results = [
    { title: 'Official docs', url: 'https://example.com/docs?query=tools#results', snippet: 'Documented API' },
    { title: 'Local reference', url: 'http://localhost:3000/reference', description: 'Reference text' },
  ];

  it.each([
    results,
    { results },
    { search_results: results },
  ])('recognizes complete supported result lists without network requests', value => {
    expect(webResultLinks(value)).toEqual([
      { title: 'Official docs', url: 'https://example.com/docs?query=tools#results', snippet: 'Documented API' },
      { title: 'Local reference', url: 'http://localhost:3000/reference', snippet: 'Reference text' },
    ]);
  });

  it('trims recorded text and uses a description only when no readable snippet exists', () => {
    expect(webResultLinks([{ title: '  Docs  ', url: ' https://example.com/docs ', snippet: '', description: '  Details  ' }]))
      .toEqual([{ title: 'Docs', url: 'https://example.com/docs', snippet: 'Details' }]);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '/relative/path',
    '//example.com/path',
    'https:example.com/path',
    'ftp://example.com/path',
    'http://',
    'https://example.com/a b',
    'https://example.com/a\nb',
  ])('rejects unsupported or invalid URL %s and retains the whole list for its JSON fallback', url => {
    expect(webResultLinks([results[0], { title: 'Unsafe or unknown link', url }])).toEqual([]);
  });

  it.each([
    [results[0], { title: ' ', url: 'https://example.com' }],
    [results[0], { title: 'Missing URL' }],
    [results[0], { title: 'Invalid URL type', url: 123 }],
    [results[0], 'unstructured result'],
    [results[0], null],
    [results[0], []],
    { results: 'unknown structure' },
    { content: results },
    null,
    [],
  ])('does not partially drop unknown result shapes', value => {
    expect(webResultLinks(value)).toEqual([]);
  });
});
