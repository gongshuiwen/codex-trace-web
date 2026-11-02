import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.js';
import { IndexService } from '../server/indexer.js';

const resources: { root: string; index: IndexService; app: FastifyInstance }[] = [];

async function fixture() {
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
    { type: 'response_item', timestamp, payload: { type: 'function_call', name: 'exec_command', call_id: 'call-api', arguments: '{"cmd":"echo demo"}' } },
    { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'call-api', output: 'A'.repeat(40000) + '分页末尾词' } },
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

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    await resource.index.stop();
    const allowed = path.join(tmpdir(), 'session-lens-api-');
    if (!path.resolve(resource.root).startsWith(allowed)) throw new Error('Unexpected cleanup target');
    await rm(resource.root, { recursive: true, force: true });
  }
});

describe('local HTTP API', () => {
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
