import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { indexSessionFile, loadSessionRequests, loadToolOutput, loadTurnDetail } from '../server/parser.js';

const directories: string[] = [];
const stamp = '2026-01-01T00:00:00.000Z';
const line = (type: string, payload: Record<string, unknown>, timestamp = stamp) => JSON.stringify({ timestamp, type, payload });
const meta = () => line('session_meta', { id: 'test-session', cwd: 'E:\\work\\demo', originator: 'Codex Desktop', timestamp: stamp });
const start = (id = 't1') => line('event_msg', { type: 'task_started', turn_id: id, started_at: 1767225600, model_context_window: 1000 });
const end = (id = 't1') => line('event_msg', { type: 'task_complete', turn_id: id, completed_at: 1767225610 });
const message = (role: string, text: string, phase?: string) => line('response_item', { type: 'message', role, content: [{ type: 'input_text', text }], ...(phase ? { phase } : {}) });

async function file(lines: string[], trailing = '\n'): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-lens-parser-'));
  directories.push(directory);
  const location = path.join(directory, 'rollout-test.jsonl');
  await writeFile(location, lines.join('\n') + trailing, 'utf8');
  return location;
}

afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('Codex rollout parser', () => {
  it.each([
    { name: 'own metadata before nested metadata', fields: { agent_path: '/root/own_worker', agent_nickname: 'Alias', source: { subagent: { thread_spawn: { agent_path: '/root/nested_worker' } } } }, task: true, expected: '/root/own_worker' },
    { name: 'nested metadata before task fallback', fields: { agent_path: ' ', source: { subagent: { thread_spawn: { agent_path: '/root/nested_worker', agent_nickname: 'Alias' } } } }, task: true, expected: '/root/nested_worker' },
    { name: 'own new-task envelope fallback', fields: {}, task: true, expected: '/root/task_worker' },
    { name: 'recorded nickname without a task path', fields: { agent_nickname: 'Alias' }, task: false, expected: 'Alias' },
    { name: 'missing name retains original title', fields: {}, task: false, expected: undefined },
    { name: 'ordinary parent thread is not named after an outbound task', fields: { parent_thread_id: undefined, agent_path: '/root' }, task: true, expected: undefined },
  ])('extracts child names: $name', async ({ fields, task, expected }) => {
    const location = await file([
      line('session_meta', { id: 'named-session', parent_thread_id: 'parent', title: 'Original title', ...fields }), start(),
      ...(task ? [line('response_item', { type: 'agent_message', content: 'Message Type: NEW_TASK\nTask name: /root/task_worker\nSender: /root\nPayload:' })] : []), end(),
    ]);
    const result = (await indexSessionFile(location)).session;
    expect(result.agentName).toBe(expected);
    expect(result.title).toBe('Original title');
  });

  it('does not take agent names from replayed parent metadata or inherited task envelopes', async () => {
    const location = await file([
      line('session_meta', { id: 'own-child', parent_thread_id: 'parent', subagent_history_start_ordinal: 3 }),
      line('session_meta', { id: 'replayed-parent', agent_path: '/root/wrong_parent', agent_nickname: 'Wrong alias' }),
      line('response_item', { type: 'agent_message', content: 'Message Type: NEW_TASK\nTask name: /root/wrong_inherited\nSender: /root\nPayload:' }),
      start(), line('response_item', { type: 'agent_message', content: 'Message Type: NEW_TASK\nTask name: /root/own_child\nSender: /root\nPayload:' }), end(),
    ]);
    const result = (await indexSessionFile(location)).session;
    expect(result.agentName).toBe('/root/own_child');
    expect(result.agentNickname).toBeUndefined();
  });

  it('returns deduplicated cross-turn requests in file order even with identical or backward timestamps', async () => {
    const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
    const location = await file([meta(), start(), message('user', 'first'),
      line('token_usage_record', { response_id: 'r1', turn_id: 't1', usage }),
      line('token_usage_record', { response_id: 'r2', turn_id: 't1', usage }), end(), start('t2'),
      line('token_usage_record', { response_id: 'r3', turn_id: 't2', usage }, '2025-12-31T23:59:59Z'),
      line('token_usage_record', { response_id: 'r1', turn_id: 't1', usage }), end('t2')]);
    expect((await loadSessionRequests(location)).map(request => [request.id, request.turnId])).toEqual([['r1', 't1'], ['r2', 't1'], ['r3', 't2']]);
  });
  it('indexes Desktop prompts separately from injected context and parses custom tool calls', async () => {
    const location = await file([meta(), start(), message('developer', 'Developer instructions'), message('user', '<environment_context>private context</environment_context>'),
      message('user', '请解释这段代码 🐶'), line('turn_context', { turn_id: 't1', model: 'test-model', cwd: 'E:\\work\\demo' }),
      message('assistant', '我正在检查', 'commentary'),
      line('response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'functions.exec', input: 'text(1)' }),
      line('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: 'successful output' }), message('assistant', '这是结果', 'final_answer'), end()]);
    const index = await indexSessionFile(location);
    expect(index.session.id).toBe('test-session');
    expect(index.session.project).toBe('demo');
    expect(index.session.model).toBe('test-model');
    expect(index.turns).toHaveLength(1);
    expect(index.turns[0]?.prompt).toBe('请解释这段代码 🐶');
    expect(index.turns[0]?.toolCount).toBe(1);
    expect(index.searchMessages.map(item => item.text)).not.toContain('private context');
    expect(JSON.stringify(index)).not.toContain('successful output');
    const detail = await loadTurnDetail(location, 't1');
    expect(detail.events.filter(event => event.kind === 'context')).toHaveLength(3);
    expect(detail.events.find(event => event.tool)?.tool).toMatchObject({ id: 'c1', name: 'functions.exec', arguments: 'text(1)', output: 'successful output', status: 'completed' });
    expect(detail.events.find(event => event.kind === 'commentary')?.text).toBe('我正在检查');
  });

  it('deduplicates CLI event messages and response_item copies', async () => {
    const location = await file([meta(), start(), line('event_msg', { type: 'user_message', message: 'hello' }), message('user', 'hello'),
      message('assistant', 'world', 'final_answer'), line('event_msg', { type: 'agent_message', message: 'world' }), end()]);
    const detail = await loadTurnDetail(location, 't1');
    expect(detail.events.filter(event => event.kind === 'user')).toHaveLength(1);
    expect(detail.events.filter(event => event.kind === 'assistant')).toHaveLength(1);
    expect((await indexSessionFile(location)).searchMessages).toHaveLength(2);
  });

  it('keeps long outputs out of the index and pages them on demand', async () => {
    const output = 'abc中'.repeat(6000);
    const location = await file([meta(), start(), message('user', 'run'),
      line('response_item', { type: 'function_call', call_id: 'large', name: 'exec_command', arguments: '{"cmd":"test"}' }),
      line('response_item', { type: 'function_call_output', call_id: 'large', output }), end()]);
    const index = await indexSessionFile(location);
    expect(JSON.stringify(index).length).toBeLessThan(8000);
    const detail = await loadTurnDetail(location, 't1');
    const tool = detail.events.find(event => event.tool)?.tool;
    expect(tool?.output.length).toBe(16_384);
    expect(tool?.outputTruncated).toBe(true);
    expect(tool?.outputLength).toBe(output.length);
    const page = await loadToolOutput(location, 'large', 16_384, 2000);
    expect(page.text).toBe(output.slice(16_384, 18_384));
    expect(page.nextOffset).toBe(18_384);
    expect(page.totalLength).toBe(output.length);
  });

  it('indexes append-only writes once, including a JSON record split across updates', async () => {
    const location = await file([meta(), start(), message('user', 'first')]);
    const first = await indexSessionFile(location);
    const partial = message('assistant', 'a multi-byte answer 汉字');
    await appendFile(location, partial.slice(0, 45));
    const mid = await indexSessionFile(location);
    expect(mid.session.parseErrors).toBe(0);
    expect((await loadTurnDetail(location, 't1')).warnings.some(warning => warning.includes('尚未写完'))).toBe(true);
    await appendFile(location, partial.slice(45) + '\n' + end() + '\n');
    const last = await indexSessionFile(location);
    expect(last.session.revision).not.toBe(first.session.revision);
    expect(last.turns).toHaveLength(1);
    expect(last.searchMessages.filter(item => item.text.includes('multi-byte'))).toHaveLength(1);
    expect(last.turns[0]?.status).toBe('completed');
  });

  it('rebuilds after truncation and skips damaged complete lines', async () => {
    const location = await file([meta(), start(), message('user', 'old prompt'), end()]);
    await indexSessionFile(location);
    await writeFile(location, [meta(), start('t2'), '{bad json}', message('user', 'new'), end('t2')].join('\n') + '\n');
    const index = await indexSessionFile(location);
    expect(index.turns).toHaveLength(1);
    expect(index.turns[0]?.id).toBe('t2');
    expect(index.session.parseErrors).toBe(1);
    expect(index.searchMessages.some(item => item.text === 'old prompt')).toBe(false);
  });

  it('distinguishes calls, turns and session token usage without double counting', async () => {
    const usage = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 };
    const location = await file([meta(), start(), message('user', 'token test'),
      line('token_usage_record', { response_id: 'response-1', turn_id: 't1', usage, thread_token_usage: usage }),
      line('event_msg', { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 1000 } }), end(),
      start('t2'), message('user', 'second'),
      line('token_usage_record', { response_id: 'response-2', turn_id: 't2', usage, thread_token_usage: { ...usage, input_tokens: 200, output_tokens: 40, cached_input_tokens: 120, reasoning_output_tokens: 10, total_tokens: 240 } }), end('t2')]);
    const index = await indexSessionFile(location);
    expect(index.session.usage.tokens?.totalTokens).toBe(240);
    expect(index.turns.map(turn => turn.usage.tokens?.totalTokens)).toEqual([120, 120]);
    expect(index.session.usage.requestCount).toBe(2);
    const detail = await loadTurnDetail(location, 't1');
    expect(detail.requests).toHaveLength(1);
    expect(detail.requests[0]?.usage.cachedInputTokens).toBe(60);
  });

  it('shows unknown events, missing usage and unmatched output without crashing', async () => {
    const location = await file([meta(), start(), message('user', 'future event'), line('future_event', { example: true }),
      line('response_item', { type: 'function_call_output', call_id: 'missing-call', output: 'Process exited with code 2' }), end()]);
    const detail = await loadTurnDetail(location, 't1');
    expect(detail.summary.usage.completeness).toBe('unknown');
    expect(detail.events.some(event => event.kind === 'unknown' && event.text.includes('future_event'))).toBe(true);
    expect(detail.events.find(event => event.tool)?.tool).toMatchObject({ id: 'missing-call', status: 'failed', exitCode: 2 });
  });

  it('accepts a final complete JSON line without newline', async () => {
    const location = await file([meta(), start(), message('user', 'hello'), end()], '');
    expect((await indexSessionFile(location)).turns[0]?.status).toBe('completed');
  });

  it('groups older CLI logs by user messages when lifecycle markers are absent', async () => {
    const location = await file([meta(), line('event_msg', { type: 'user_message', message: 'first question' }),
      line('event_msg', { type: 'agent_message', message: 'first answer' }),
      line('event_msg', { type: 'user_message', message: 'second question' }),
      line('event_msg', { type: 'agent_message', message: 'second answer' })]);
    const index = await indexSessionFile(location);
    expect(index.turns.map(turn => turn.prompt)).toEqual(['first question', 'second question']);
    const detail = await loadTurnDetail(location, index.turns[0]!.id);
    expect(detail.events.map(event => event.text)).toContain('first answer');
    expect(detail.events.map(event => event.text)).not.toContain('second question');
  });

  it('keeps child identity and excludes replayed parent history and usage before its ordinal boundary', async () => {
    const usage = { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, total_tokens: 110 };
    const records = [
      line('session_meta', { id: 'child-id', session_id: 'parent-id', parent_thread_id: 'parent-id', cwd: 'E:\\work\\child',
        subagent_history_start_ordinal: 7, source: { subagent: { thread_spawn: { parent_thread_id: 'parent-id' } } } }),
      line('session_meta', { id: 'parent-id', cwd: 'E:\\work\\parent' }),
      start('parent-turn'), message('user', 'inherited parent question'), message('assistant', 'inherited answer'),
      line('token_usage_record', { response_id: 'parent-response', turn_id: 'parent-turn', usage, thread_token_usage: usage }),
      end('parent-turn'),
      line('event_msg', { type: 'thread_settings_applied' }),
      start('child-turn'), message('user', 'own child task'),
      line('token_usage_record', { response_id: 'child-response', turn_id: 'child-turn', usage, thread_token_usage: usage }), end('child-turn'),
    ].map((record, ordinal) => JSON.stringify({ ...JSON.parse(record), ordinal }));
    const location = await file(records);
    const index = await indexSessionFile(location);
    expect(index.session.id).toBe('child-id');
    expect(index.session.parentId).toBe('parent-id');
    expect(index.session.cwd).toBe('E:\\work\\child');
    expect(index.turns.map(turn => turn.id)).toEqual(['child-turn']);
    expect(index.searchMessages.map(item => item.text)).toEqual(['own child task']);
    expect(index.session.usage.tokens?.totalTokens).toBe(110);
    const detail = await loadTurnDetail(location, 'child-turn');
    expect(detail.requests.map(request => request.id)).toEqual(['child-response']);
    expect(detail.requests[0]?.turnId).toBe('child-turn');
    await expect(loadTurnDetail(location, 'parent-turn')).rejects.toMatchObject({ message: '未找到此轮次。', statusCode: 404 });
  });

  it('keeps the first real prompt in summaries while preserving follow-up steering in the timeline', async () => {
    const location = await file([meta(), start(), message('user', 'original question'), message('assistant', 'working', 'commentary'),
      message('user', 'additional direction'), line('event_msg', { type: 'user_message', message: 'original question' }),
      line('event_msg', { type: 'user_message', message: 'later direction' }), end()]);
    const index = await indexSessionFile(location);
    expect(index.turns[0]?.prompt).toBe('original question');
    const detail = await loadTurnDetail(location, 't1');
    expect(detail.events.filter(event => event.kind === 'user').map(event => event.text)).toEqual(['original question', 'additional direction', 'later direction']);
  });
});
