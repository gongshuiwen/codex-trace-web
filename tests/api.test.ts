import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.js';
import { IndexService } from '../server/indexer.js';
import type { CompactionPage, ToolFailurePage, ToolSearchMatch } from '../shared/types.js';

const resources: { root: string; index: IndexService; app: FastifyInstance }[] = [];

async function fixture(calls: { id: string; name?: string; arguments: string; output?: string }[] = [
  { id: 'call-api', arguments: '{"cmd":"echo demo"}', output: 'A'.repeat(40000) + '分页末尾词' },
]) {
  const root = await mkdtemp(path.join(tmpdir(), 'session-lens-api-'));
  const sessionsDir = path.join(root, 'sessions');
  const dataDir = path.join(root, 'data');
  await mkdir(sessionsDir);
  const file = path.join(sessionsDir, 'rollout-api.jsonl');
  const timestamp = '2026-10-30T06:27:00.000Z';
  const usage = { input_tokens: 23794, cached_input_tokens: 13184, output_tokens: 157, total_tokens: 23951 };
  const lines = [
    { type: 'session_meta', timestamp, payload: { id: 'api-session', timestamp, cwd: 'E:/demo', originator: 'codex_cli_rs' } },
    { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'turn-api' } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '测试中文搜索' }] } },
    ...calls.flatMap(call => [
      { type: 'response_item', timestamp, payload: { type: 'function_call', name: call.name ?? 'exec_command', call_id: call.id, arguments: call.arguments } },
      ...(call.output === undefined ? [] : [{ type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: call.id, output: call.output } }]),
    ]),
    { type: 'token_usage_record', timestamp, payload: { thread_id: 'api-session', turn_id: 'turn-api', response_id: 'resp-api', usage, thread_token_usage: usage } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '已完成测试。' }] } },
    { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: 'turn-api' } },
  ];
  await writeFile(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  const index = new IndexService({ sessionsDir, dataDir });
  await index.start();
  const app = await createApp({ index, settings: { sessionsDir, dataDir, defaultSessionsDir: sessionsDir } });
  resources.push({ root, index, app });
  await expect.poll(async () => (await index.list()).items.length).toBe(1);
  return { app, index, file, root };
}

function expectSourceLocation(match: ToolSearchMatch, source: string): void {
  expect(match.length).toBeGreaterThan(0);
  expect(source.slice(match.offset, match.offset + match.length)).toBe(match.matchedText);
  expect(Number.isInteger(match.excerptOffset)).toBe(true);
  expect(match.excerptOffset).toBeGreaterThanOrEqual(0);
  expect(match.excerptOffset).toBeLessThanOrEqual(match.offset);
  const start = match.excerptOffset!;
  expect(match.text).toBe(source.slice(start, start + match.text.length));
  const localOffset = match.offset - start;
  expect(match.text.slice(localOffset, localOffset + match.length)).toBe(match.matchedText);
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    await resource.index.stop();
    const allowed = path.join(tmpdir(), 'session-lens-api-');
    if (!path.resolve(resource.root).startsWith(allowed)) throw new Error('Unexpected cleanup target');
    await rm(resource.root, { recursive: true, force: true });
  }
});

describe('local HTTP API', () => {
  it('pages compaction navigation and exposes recorded duration without returning compacted bodies', async () => {
    const { app, file, index } = await fixture([]);
    const additions = [
      { type: 'compacted', timestamp: '2026-10-30T06:27:10Z', payload: { turn_id: 'turn-api', message: 'PRIVATE_COMPACTED_BODY' } },
      { type: 'compacted', timestamp: '2026-10-30T06:27:20Z', payload: { turn_id: 'turn-api' } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n';
    await appendFile(file, additions);
    await expect.poll(async () => (await index.get('api-session'))?.session.compactionCount).toBe(2);
    const before = await readFile(file, 'utf8');
    const detail = (await app.inject('/api/sessions/api-session')).json();
    expect(detail.session).toMatchObject({ compactionCount: 2, durationMs: 20000 });
    const response = await app.inject('/api/sessions/api-session/compactions?offset=1&limit=1');
    expect(response.statusCode).toBe(200);
    const page = response.json<CompactionPage>();
    expect(page).toMatchObject({ total: 2, nextOffset: null });
    expect(page.items[0]).toMatchObject({ turnId: 'turn-api', timestamp: '2026-10-30T06:27:20Z' });
    expect(JSON.stringify(page)).not.toContain('PRIVATE_COMPACTED_BODY');
    const turn = (await app.inject('/api/sessions/api-session/turns/turn-api')).json();
    expect(turn.events.some((event: { id: string }) => event.id === page.items[0].eventId)).toBe(true);
    expect((await app.inject('/api/sessions/api-session/compactions?offset=-1')).statusCode).toBe(400);
    expect((await app.inject('/api/sessions/api-session/compactions?limit=101')).statusCode).toBe(400);
    expect((await app.inject('/api/sessions/no-such-session/compactions')).statusCode).toBe(404);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('lists, searches, lazily loads turns and pages tool output without changing source logs', async () => {
    const { app, file } = await fixture();
    const before = await readFile(file, 'utf8');
    const list = await app.inject('/api/sessions?query=' + encodeURIComponent('中文'));
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0].id).toBe('api-session');
    expect(list.json().items[0].match.turnId).toBe('turn-api');
    const session = await app.inject('/api/sessions/api-session');
    expect(session.statusCode).toBe(200);
    expect(session.json().turns).toHaveLength(1);
    expect(session.json().session.usage.tokens.inputTokens).toBe(23794);
    expect(session.json().session.toolFailureCount).toBe(0);
    const turn = await app.inject('/api/sessions/api-session/turns/turn-api');
    expect(turn.statusCode).toBe(200);
    expect(turn.json().requests[0].usage.cachedInputTokens).toBe(13184);
    expect(turn.json().events.some((event: { tool?: { name: string } }) => event.tool?.name === 'exec_command')).toBe(true);
    const output = await app.inject('/api/sessions/api-session/tools/call-api/output?offset=39990&limit=100');
    expect(output.statusCode).toBe(200);
    expect(output.json().text).toContain('分页末尾词');
    const search = await app.inject('/api/sessions/api-session/search?query=' + encodeURIComponent('分页末尾词'));
    expect(search.statusCode).toBe(200);
    expect(search.json().matches[0].turnId).toBe('turn-api');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('validates origins, pagination, directory changes and unknown sessions', async () => {
    const { app, root } = await fixture();
    expect((await app.inject({ url: '/api/settings', headers: { origin: 'https://example.com' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/settings', headers: { host: 'hostile.example' } })).statusCode).toBe(403);
    expect((await app.inject('/api/sessions?limit=1000')).statusCode).toBe(400);
    expect((await app.inject('/api/sessions/no-such-session/turns/a')).statusCode).toBe(404);
    const settings = (await app.inject('/api/settings')).json();
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { sessionsDir: path.join(root, 'absent') } })).statusCode).toBe(400);
    expect((await app.inject('/api/settings')).json()).toEqual(settings);
  });

  it.each([
    { resource: 'missing turn', endpoint: '/turns/no-such-turn', message: '未找到此轮次。' },
    { resource: 'missing tool output', endpoint: '/tools/no-such-call/output', message: '未找到工具输出。' },
    { resource: 'tool with no output record', endpoint: '/tools/pending-call/output', message: '未找到工具输出。' },
  ])('returns a 404 JSON error for a $resource', async ({ endpoint, message }) => {
    const { app } = await fixture([{ id: 'pending-call', arguments: '{}' }]);
    const response = await app.inject(`/api/sessions/api-session${endpoint}`);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message });
  });

  it('serves recorded empty tool output and exhausted output pages successfully', async () => {
    const { app } = await fixture([
      { id: 'empty-call', arguments: '{}', output: '' },
      { id: 'complete-call', arguments: '{}', output: 'done' },
    ]);
    const empty = await app.inject('/api/sessions/api-session/tools/empty-call/output');
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ text: '', offset: 0, nextOffset: null, totalLength: 0 });

    const exhausted = await app.inject('/api/sessions/api-session/tools/complete-call/output?offset=4');
    expect(exhausted.statusCode).toBe(200);
    expect(exhausted.json()).toEqual({ text: '', offset: 4, nextOffset: null, totalLength: 4 });
  });

  it('keeps unexpected resource lookup failures as masked 500 errors', async () => {
    const { app, index } = await fixture();
    vi.spyOn(index, 'getPath').mockRejectedValueOnce(new Error('PRIVATE_INDEX_FAILURE'));

    const response = await app.inject('/api/sessions/api-session/turns/turn-api');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ message: '读取日志时发生错误，请稍后重试。' });
  });

  it('locates every argument and output occurrence in tool, field and source order with compatible excerpts', async () => {
    const argumentsText = JSON.stringify({ cmd: 'echo Shared[.*] value SHARED[.*]' });
    const firstOutput = 'result: SHARED[.*]\nthen shared[.*]';
    const secondOutput = 'shared[.*] again; SHARED[.*] final';
    const { app } = await fixture([
      { id: 'first-tool', name: 'functions.exec_command', arguments: argumentsText, output: firstOutput },
      { id: 'second-tool', name: 'mcp__database__query_records', arguments: '{"table":"runs"}', output: secondOutput },
    ]);
    const search = await app.inject('/api/sessions/api-session/search?query=' + encodeURIComponent('shared[.*]'));
    expect(search.statusCode).toBe(200);
    const result = search.json<{ matches: ToolSearchMatch[]; truncated: boolean }>();
    expect(result.truncated).toBe(false);
    expect(result.matches.map(match => [match.toolId, match.field, match.toolName])).toEqual([
      ['first-tool', 'arguments', 'functions.exec_command'],
      ['first-tool', 'arguments', 'functions.exec_command'],
      ['first-tool', 'output', 'functions.exec_command'],
      ['first-tool', 'output', 'functions.exec_command'],
      ['second-tool', 'output', 'mcp__database__query_records'],
      ['second-tool', 'output', 'mcp__database__query_records'],
    ]);
    const expected = [
      { source: argumentsText, offset: argumentsText.indexOf('Shared[.*]') },
      { source: argumentsText, offset: argumentsText.indexOf('SHARED[.*]') },
      { source: firstOutput, offset: firstOutput.indexOf('SHARED[.*]') },
      { source: firstOutput, offset: firstOutput.indexOf('shared[.*]') },
      { source: secondOutput, offset: secondOutput.indexOf('shared[.*]') },
      { source: secondOutput, offset: secondOutput.indexOf('SHARED[.*]') },
    ];
    for (const [index, { source, offset }] of expected.entries()) {
      const match = result.matches[index]!;
      expect(match.turnId).toBe('turn-api');
      expect(match.eventId).toMatch(/^tool-/);
      expect(match.offset).toBe(offset);
      expect(match.length).toBe('shared[.*]'.length);
      expect(source.slice(match.offset, match.offset + match.length).toLowerCase()).toBe('shared[.*]');
      expect(match.excerptOffset).toBe(0);
      expectSourceLocation(match, source);
    }
  });

  it('reports original UTF-16 offsets for shallow, deep and page-spanning occurrences in one output', async () => {
    const marker = 'Deep[.*]Needle';
    const offsets = [12, 16380, 81916, 147450];
    let output = 'İ🙂';
    for (const offset of offsets) output += 'x'.repeat(offset - output.length) + marker;
    output += 'Z'.repeat(500);
    const { app } = await fixture([{ id: 'deep-output', arguments: '{"cmd":"read large result"}', output }]);
    const search = await app.inject('/api/sessions/api-session/search?query=' + encodeURIComponent(marker.toLowerCase()));
    expect(search.statusCode).toBe(200);
    const matches = search.json<{ matches: ToolSearchMatch[] }>().matches;
    expect(matches).toHaveLength(offsets.length);
    expect(matches.map(match => match.offset)).toEqual(offsets);
    for (const [index, match] of matches.entries()) {
      expect(match).toMatchObject({ toolId: 'deep-output', field: 'output', offset: offsets[index], length: marker.length,
        matchedText: marker, excerptOffset: Math.max(0, offsets[index] - 70) });
      expectSourceLocation(match, output);
      const page = await app.inject(`/api/sessions/api-session/tools/deep-output/output?offset=${match.offset}&limit=${match.length}`);
      expect(page.json().text).toBe(marker);
    }
  });

  it('includes overlapping source occurrences with and without lowercase expansion', async () => {
    const { app } = await fixture([
      { id: 'ascii-overlap', arguments: '{}', output: 'aaaa' },
      { id: 'folded-overlap', arguments: '{}', output: 'İİİ' },
    ]);
    const ascii = (await app.inject('/api/sessions/api-session/search?query=aa')).json<{ matches: ToolSearchMatch[]; truncated: boolean }>();
    expect(ascii.truncated).toBe(false);
    expect(ascii.matches.map(match => [match.offset, match.length, match.matchedText])).toEqual([[0, 2, 'aa'], [1, 2, 'aa'], [2, 2, 'aa']]);
    for (const match of ascii.matches) expectSourceLocation(match, 'aaaa');
    const folded = (await app.inject('/api/sessions/api-session/search?query=' + encodeURIComponent('İİ'))).json<{ matches: ToolSearchMatch[]; truncated: boolean }>();
    expect(folded.truncated).toBe(false);
    expect(folded.matches.map(match => [match.offset, match.length, match.matchedText])).toEqual([[0, 2, 'İİ'], [1, 2, 'İİ']]);
    for (const match of folded.matches) expectSourceLocation(match, 'İİİ');
  });

  it('reports the corrected excerpt origin when context boundaries fall inside surrogate pairs', async () => {
    const marker = 'BoundaryNeedle';
    const prefix = 'A'.repeat(20) + '🙂' + 'x'.repeat(69);
    const output = prefix + marker + 'z'.repeat(159) + '🙂tail';
    const { app } = await fixture([{ id: 'surrogate-context', arguments: '{}', output }]);
    const search = await app.inject('/api/sessions/api-session/search?query=' + marker.toLowerCase());
    const [match] = search.json<{ matches: ToolSearchMatch[] }>().matches;
    expect(match).toMatchObject({ offset: prefix.length, length: marker.length, excerptOffset: 20 });
    expect(match!.text).toBe('🙂' + 'x'.repeat(69) + marker + 'z'.repeat(159) + '🙂');
    expect(match!.text).toBe(output.slice(match!.excerptOffset, match!.excerptOffset! + match!.text.length));
    const localOffset = match!.offset - match!.excerptOffset!;
    expect(localOffset).toBe(71);
    expect(match!.text.slice(localOffset, localOffset + match!.length)).toBe(marker);
  });

  it('identifies the exact excerpt span when the same original glyph has different contextual lowercase forms', async () => {
    const output = 'Σ '.repeat(60) + 'ΟΣ' + ' Σ'.repeat(100);
    const offset = output.indexOf('ΟΣ') + 1;
    const { app } = await fixture([{ id: 'contextual-excerpt', arguments: '{}', output }]);
    const search = await app.inject('/api/sessions/api-session/search?query=' + encodeURIComponent('ς'));
    const [match] = search.json<{ matches: ToolSearchMatch[] }>().matches;
    expect(match).toMatchObject({ offset, length: 1, matchedText: 'Σ', excerptOffset: offset - 70 });
    const localOffset = match!.offset - match!.excerptOffset!;
    expect(match!.text.indexOf(match!.matchedText)).toBeLessThan(localOffset);
    expect(match!.text.slice(localOffset, localOffset + match!.length)).toBe(match!.matchedText);
    expect(match!.text.slice(localOffset - 1, localOffset + 1)).toBe('ΟΣ');
  });

  it('maps case expansions and emoji prefixes back to the original fields without treating the query as regex', async () => {
    const argumentsText = JSON.stringify({ query: 'İ🙂prefix TARGET[.*] tail' });
    const output = 'İ🙂前置 TARGET[.*] 后缀';
    const { app } = await fixture([{ id: 'unicode', arguments: argumentsText, output }]);
    const search = await app.inject('/api/sessions/api-session/search?query=' + encodeURIComponent('target[.*]'));
    const matches = search.json<{ matches: ToolSearchMatch[] }>().matches;
    expect(matches).toHaveLength(2);
    for (const [index, source] of [argumentsText, output].entries()) {
      expect(matches[index]).toMatchObject({ offset: source.indexOf('TARGET[.*]'), length: 'TARGET[.*]'.length });
      expect(source.slice(matches[index]!.offset, matches[index]!.offset + matches[index]!.length)).toBe('TARGET[.*]');
    }
    const expanded = await app.inject('/api/sessions/api-session/search?query=' + encodeURIComponent('i\u0307'));
    expect(expanded.json().matches.map((match: ToolSearchMatch) => [match.offset, match.length]))
      .toEqual([[argumentsText.indexOf('İ'), 1], [0, 1]]);
  });

  it('matches a lowercase expansion with its original source span and searches literal metacharacters', async () => {
    const { app } = await fixture([
      { id: 'expanded', arguments: '{}', output: 'prefix i\u0307 suffix' },
      { id: 'literal', arguments: '{}', output: 'prefix a+b?(test) suffix' },
    ]);
    const expanded = await app.inject('/api/sessions/api-session/search?query=' + encodeURIComponent('İ'));
    expect(expanded.json().matches[0]).toMatchObject({ toolId: 'expanded', field: 'output', offset: 7, length: 2 });
    const literal = await app.inject('/api/sessions/api-session/search?query=' + encodeURIComponent('a+b?(test)'));
    expect(literal.json().matches[0]).toMatchObject({ toolId: 'literal', field: 'output', offset: 7, length: 10 });
  });

  it('returns each original glyph for repeated lowercase expansion fragments, emoji and contextual final sigma', async () => {
    const turkish = 'İ🙂İ/İ';
    const greek = 'Σ ΟΣ🙂ΟΣ ΟΣ';
    const { app } = await fixture([
      { id: 'turkish-glyph', arguments: '{}', output: turkish },
      { id: 'greek-glyph', arguments: '{}', output: greek },
    ]);
    for (const query of ['i', '\u0307', 'İ']) {
      const expanded = (await app.inject('/api/sessions/api-session/search?query=' + encodeURIComponent(query))).json<{ matches: ToolSearchMatch[] }>();
      expect(expanded.matches.map(match => [match.offset, match.length, match.matchedText])).toEqual([[0, 1, 'İ'], [3, 1, 'İ'], [5, 1, 'İ']]);
      for (const match of expanded.matches) {
        expect(match).toMatchObject({ toolId: 'turkish-glyph', field: 'output' });
        expectSourceLocation(match, turkish);
      }
    }
    const contextual = (await app.inject('/api/sessions/api-session/search?query=' + encodeURIComponent('ς'))).json<{ matches: ToolSearchMatch[] }>();
    expect(contextual.matches.map(match => [match.offset, match.length, match.matchedText])).toEqual([[3, 1, 'Σ'], [7, 1, 'Σ'], [10, 1, 'Σ']]);
    for (const match of contextual.matches) {
      expect(match).toMatchObject({ toolId: 'greek-glyph', field: 'output' });
      expectSourceLocation(match, greek);
    }
    const emoji = (await app.inject('/api/sessions/api-session/search?query=' + encodeURIComponent('🙂'))).json<{ matches: ToolSearchMatch[] }>();
    expect(emoji.matches.map(match => [match.toolId, match.offset, match.length, match.matchedText])).toEqual([
      ['turkish-glyph', 1, 2, '🙂'], ['greek-glyph', 4, 2, '🙂'],
    ]);
    expectSourceLocation(emoji.matches[0]!, turkish);
    expectSourceLocation(emoji.matches[1]!, greek);
  });

  it('returns no matches for absent text or a tool with no output and keeps query validation', async () => {
    const { app } = await fixture([{ id: 'no-output', arguments: '{"cmd":"record only"}' }]);
    const search = await app.inject('/api/sessions/api-session/search?query=never-present');
    expect(search.statusCode).toBe(200);
    expect(search.json()).toEqual({ matches: [], truncated: false });
    expect((await app.inject('/api/sessions/api-session/search?query=')).statusCode).toBe(400);
    expect((await app.inject('/api/sessions/api-session/search')).statusCode).toBe(400);
    expect((await app.inject('/api/sessions/missing/search?query=anything')).statusCode).toBe(404);
  });

  it('caps search results while preserving tool order', async () => {
    const { app } = await fixture(Array.from({ length: 101 }, (_, index) => ({ id: `tool-${index}`, arguments: '{}', output: 'limit-marker' })));
    const search = await app.inject('/api/sessions/api-session/search?query=limit-marker');
    const result = search.json<{ matches: ToolSearchMatch[]; truncated: boolean }>();
    expect(result.truncated).toBe(true);
    expect(result.matches).toHaveLength(100);
    expect(result.matches[0]!.toolId).toBe('tool-0');
    expect(result.matches[99]!.toolId).toBe('tool-99');
  });

  it.each([100, 101])('reports truncation accurately for %i occurrences inside one output', async count => {
    const marker = 'limit-marker';
    const output = Array.from({ length: count }, () => marker).join('|');
    const { app } = await fixture([{ id: 'many-occurrences', arguments: '{}', output }]);
    const search = await app.inject('/api/sessions/api-session/search?query=' + marker);
    const result = search.json<{ matches: ToolSearchMatch[]; truncated: boolean }>();
    expect(result.truncated).toBe(count > 100);
    expect(result.matches).toHaveLength(100);
    expect(result.matches.map(match => match.offset)).toEqual(Array.from({ length: 100 }, (_, index) => index * (marker.length + 1)));
    for (const match of result.matches) {
      expect(match).toMatchObject({ toolId: 'many-occurrences', field: 'output', length: marker.length, matchedText: marker });
      expectSourceLocation(match, output);
    }
  });

  it('serves final failure summaries and paginated failure locations without rescanning successful turns in the client', async () => {
    const { app, file } = await fixture([
      { id: 'first-failure', arguments: '{}', output: '{"isError":true}' },
      { id: 'success', arguments: '{}', output: '{"exit_code":0}' },
      { id: 'second-failure', name: 'mcp__database__query_records', arguments: '{}', output: '{"is_error":true}' },
      { id: 'first-failure', arguments: '{}', output: '{"isError":true}' },
      { id: 'recovered', arguments: '{}', output: '{"exit_code":2}' },
      { id: 'recovered', arguments: '{}', output: '{"exit_code":0}' },
      { id: 'last-failure', arguments: '{}', output: 'Process exited with code 1' },
      { id: 'no-result', arguments: '{}' },
    ]);
    const before = await readFile(file, 'utf8');
    const summary = (await app.inject('/api/sessions/api-session')).json();
    expect(summary.session).toMatchObject({ toolCount: 6, toolFailureCount: 3 });
    expect(summary.turns[0].toolFailureCount).toBe(3);
    const first = await app.inject('/api/sessions/api-session/tools/failures?offset=0&limit=2');
    expect(first.statusCode).toBe(200);
    const firstPage = first.json<ToolFailurePage>();
    expect(firstPage).toMatchObject({ total: 3, nextOffset: 2 });
    expect(firstPage.items.map(item => [item.toolId, item.toolName])).toEqual([
      ['first-failure', 'exec_command'], ['second-failure', 'mcp__database__query_records'],
    ]);
    const lastPage = (await app.inject('/api/sessions/api-session/tools/failures?offset=2&limit=2')).json<ToolFailurePage>();
    expect(lastPage).toMatchObject({ total: 3, nextOffset: null });
    expect(lastPage.items.map(item => item.toolId)).toEqual(['last-failure']);
    for (const item of [...firstPage.items, ...lastPage.items]) {
      const detail = (await app.inject(`/api/sessions/api-session/turns/${item.turnId}`)).json();
      expect(detail.events.find((event: { id: string }) => event.id === item.eventId).tool).toMatchObject({ id: item.toolId, status: 'failed' });
    }
    expect((await app.inject('/api/sessions/api-session/tools/failures?offset=3')).json()).toEqual({ items: [], total: 3, nextOffset: null });
    expect((await app.inject('/api/sessions/api-session/tools/failures?limit=101')).statusCode).toBe(400);
    expect((await app.inject('/api/sessions/api-session/tools/failures?limit=0')).statusCode).toBe(400);
    expect((await app.inject('/api/sessions/api-session/tools/failures?offset=-1')).statusCode).toBe(400);
    expect((await app.inject('/api/sessions/missing/tools/failures')).statusCode).toBe(404);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('streams SSE state and closes connections during shutdown', async () => {
    const { app } = await fixture();
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`${url}/api/events?sessionId=api-session`);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"type":"ready"');
    await reader.cancel();
  });
});
