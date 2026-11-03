import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.js';
import { IndexService } from '../server/indexer.js';
import type { ContextCategory, ContextSourcePage, RequestContextAnalysis, RequestContextComparison, TurnDetail } from '../shared/types.js';

const resources: { root: string; app: FastifyInstance; index: IndexService }[] = [];
const secretPrompt = 'USER_PRIVATE_SENTINEL_7b0cf';
const secretInstruction = 'AGENTS_PRIVATE_SENTINEL_e61a2';
const previousToolResult = 'PREVIOUS_TOOL_PRIVATE_SENTINEL_16f4c';
const currentResponse = 'CURRENT_RESPONSE_PRIVATE_SENTINEL_9e7d1';
const currentToolResult = 'CURRENT_TOOL_PRIVATE_SENTINEL_b8c03';
const finalAnswer = 'FINAL_ANSWER_PRIVATE_SENTINEL_13ab2';
const toolSchemaSecret = 'SCHEMA_PRIVATE_SENTINEL_c8dab';
const sessionId = 'context-api-session';
const turnId = 'context-api-turn';

function record(type: string, payload: object, second = 0) {
  return { type, timestamp: `2026-11-02T01:00:${String(second).padStart(2, '0')}.000Z`, payload };
}

function message(role: string, text: string, second: number, phase?: string) {
  return record('response_item', {
    type: 'message', role, ...(phase ? { phase } : {}),
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  }, second);
}

function usage(responseId: string, input: number, second: number) {
  const usage = { input_tokens: input, cached_input_tokens: 0, output_tokens: 20, total_tokens: input + 20 };
  return record('token_usage_record', { response_id: responseId, thread_id: sessionId, turn_id: turnId, usage }, second);
}

function twoRequests(currentMultiplier = 1) {
  return [
    record('session_meta', { id: sessionId, cwd: '/context-api-test', timestamp: '2026-11-02T01:00:00Z' }),
    record('event_msg', { type: 'task_started', turn_id: turnId }),
    message('user', `# AGENTS.md instructions\n<INSTRUCTIONS>${secretInstruction}</INSTRUCTIONS>`, 0),
    record('response_item', { type: 'additional_tools', tools: [{ name: 'read_local', description: toolSchemaSecret, parameters: { type: 'object' } }] }),
    message('user', `${secretPrompt} 请检查本地上下文。`, 1),
    message('assistant', '首次调用生成的说明', 2, 'commentary'),
    record('response_item', { type: 'function_call', call_id: 'context-call-one', name: 'read_local', arguments: '{"path":"demo"}' }, 2),
    usage('context-response-one', 1000, 3),
    record('response_item', { type: 'function_call_output', call_id: 'context-call-one', output: previousToolResult.repeat(20) }, 4),
    message('assistant', currentResponse.repeat(currentMultiplier), 5, 'commentary'),
    record('response_item', { type: 'function_call', call_id: 'context-call-two', name: 'read_local', arguments: JSON.stringify({ current: currentResponse.repeat(currentMultiplier) }) }, 5),
    usage('context-response-two', 2500, 6),
    record('response_item', { type: 'function_call_output', call_id: 'context-call-two', output: currentToolResult.repeat(currentMultiplier * 10) }, 7),
    message('assistant', finalAnswer.repeat(currentMultiplier), 8, 'final_answer'),
    record('event_msg', { type: 'task_complete', turn_id: turnId }, 9),
  ];
}

async function fixture(lines: unknown[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'session-lens-context-api-'));
  const sessionsDir = path.join(root, 'sessions');
  const dataDir = path.join(root, 'data');
  await mkdir(sessionsDir);
  await writeFile(path.join(sessionsDir, 'rollout-context.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  const index = new IndexService({ sessionsDir, dataDir });
  await index.start();
  const app = await createApp({ index, settings: { sessionsDir, defaultSessionsDir: sessionsDir, dataDir } });
  resources.push({ root, app, index });
  await expect.poll(async () => (await index.list()).total, { timeout: 10000 }).toBe(1);
  return { app, index };
}

async function analysis(app: FastifyInstance, requestId: string, selectedTurn = turnId) {
  const response = await app.inject(`/api/sessions/${sessionId}/requests/${encodeURIComponent(requestId)}/context?turnId=${encodeURIComponent(selectedTurn)}`);
  expect(response.statusCode).toBe(200);
  return response.json<RequestContextAnalysis>();
}

function component(result: RequestContextAnalysis, category: ContextCategory) {
  const found = result.components.find(item => item.id === category);
  expect(found, `Missing ${category} category`).toBeDefined();
  return found!;
}

afterEach(async () => {
  for (const { root, app, index } of resources.splice(0)) {
    await app.close();
    await index.stop();
    if (!path.resolve(root).startsWith(path.join(tmpdir(), 'session-lens-context-api-'))) throw new Error('Unexpected cleanup target');
    await rm(root, { recursive: true, force: true });
  }
});

describe('per-request context analysis API', () => {
  it('returns bounded provenance and compares with the prior same-session request, including cross-turn calls', async () => {
    const rows = twoRequests();
    rows.push(record('event_msg', { type: 'task_started', turn_id: 'other-turn' }, 10));
    rows.push(message('user', '下一轮自己的问题', 11));
    rows.push(message('assistant', '下一轮回复', 12, 'final_answer'));
    rows.push(record('token_usage_record', { response_id: 'other-request', turn_id: 'other-turn', usage: { input_tokens: 3000, output_tokens: 10, total_tokens: 3010 } }, 13));
    rows.push(record('event_msg', { type: 'task_complete', turn_id: 'other-turn' }, 14));
    const { app } = await fixture(rows);
    const base = `/api/sessions/${sessionId}/requests/context-response-two/context/sources?turnId=${turnId}&category=toolOutputs`;
    const response = await app.inject(base);
    expect(response.statusCode).toBe(200);
    const sources = response.json<ContextSourcePage>();
    expect(sources.sources).toHaveLength(1);
    expect(sources.sources[0].excerpt).toContain(previousToolResult);
    expect(sources.sources[0].excerpt.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(sources)).not.toContain(currentToolResult);
    expect((await app.inject(base + '&limit=51')).statusCode).toBe(400);
    expect((await app.inject(base + '&offset=-1')).statusCode).toBe(400);
    expect((await app.inject(base.replace('category=toolOutputs', 'category=invalid'))).statusCode).toBe(400);
    expect((await app.inject(base.replace('context-response-two', 'missing'))).statusCode).toBe(404);
    const first = (await app.inject(`/api/sessions/${sessionId}/requests/context-response-one/comparison?turnId=${turnId}`)).json<RequestContextComparison>();
    expect(first.previous).toBeNull();
    const sameTurn = (await app.inject(`/api/sessions/${sessionId}/requests/context-response-two/comparison?turnId=${turnId}`)).json<RequestContextComparison>();
    expect(sameTurn.previous?.id).toBe('context-response-one');
    expect(sameTurn.comparable).toBe(true);
    const crossTurnResponse = await app.inject(`/api/sessions/${sessionId}/requests/other-request/comparison?turnId=other-turn`);
    expect(crossTurnResponse.statusCode).toBe(200);
    const crossTurn = crossTurnResponse.json<RequestContextComparison>();
    expect(crossTurn.previous?.id).toBe('context-response-two');
    expect(crossTurn.previous?.turnId).toBe(turnId);
    expect(crossTurn.current.turnId).toBe('other-turn');
    expect(crossTurn.comparable).toBe(true);
    expect((await app.inject(`/api/sessions/${sessionId}/requests/context-response-one/comparison?turnId=other-turn`)).statusCode).toBe(404);
    expect(JSON.stringify(await analysis(app, 'context-response-two'))).not.toContain(previousToolResult);
  }, 20000);

  it('uses each request input boundary and only attributes previous tool output to the next request', async () => {
    const { app } = await fixture(twoRequests());
    const first = await analysis(app, 'context-response-one');
    const second = await analysis(app, 'context-response-two');
    expect(first.requestId).toBe('context-response-one');
    expect(first.inputTokens).toBe(1000);
    expect(second.inputTokens).toBe(2500);
    expect(first.boundary).toBe('inferred');
    expect(second.boundary).toBe('inferred');
    expect(component(first, 'toolOutputs').items).toBe(0);
    expect(component(first, 'toolOutputs').tokens).toBe(0);
    expect(component(second, 'toolOutputs').items).toBe(1);
    expect(component(second, 'toolOutputs').tokens).toBeGreaterThan(0);
    expect(component(first, 'projectInstructions').tokens).toBeGreaterThan(0);
    expect(component(first, 'userMessages').tokens).toBeGreaterThan(0);
    expect(component(first, 'toolDefinitions').items).toBeGreaterThan(0);
    expect(first.tokenizer).toBe('o200k_base');
    expect(first.components).toHaveLength(6);
  }, 15000);

  it('excludes the selected request response and later tool/final output, and never returns original content', async () => {
    const baseline = await fixture(twoRequests(1));
    const expanded = await fixture(twoRequests(300));
    const before = await analysis(baseline.app, 'context-response-two');
    const after = await analysis(expanded.app, 'context-response-two');
    expect(after.components.map(item => ({ id: item.id, tokens: item.tokens, items: item.items })))
      .toEqual(before.components.map(item => ({ id: item.id, tokens: item.tokens, items: item.items })));
    expect(after.estimatedTotalTokens).toBe(before.estimatedTotalTokens);
    const payload = JSON.stringify(after);
    for (const secret of [secretPrompt, secretInstruction, previousToolResult, currentResponse, currentToolResult, finalAnswer, toolSchemaSecret]) {
      expect(payload).not.toContain(secret);
    }
    expect(payload).not.toContain('/context-api-test');
    expect(after.warnings).toEqual(expect.any(Array));
    for (const item of after.components) {
      if (item.tokens !== null) expect(item.tokens).toBeGreaterThanOrEqual(0);
      expect(['estimated', 'partial', 'unavailable']).toContain(item.status);
    }
  }, 20000);

  it('rejects unknown requests and requests attributed to a different turn', async () => {
    const lines = twoRequests();
    lines.push(record('event_msg', { type: 'task_started', turn_id: 'other-turn' }, 10));
    lines.push(message('user', '另一个回合', 11));
    lines.push(record('event_msg', { type: 'task_complete', turn_id: 'other-turn' }, 12));
    const { app } = await fixture(lines);
    const url = `/api/sessions/${sessionId}/requests/`;
    expect((await app.inject(`${url}missing/context?turnId=${turnId}`)).statusCode).toBe(404);
    expect((await app.inject(`${url}context-response-one/context?turnId=missing-turn`)).statusCode).toBe(404);
    expect((await app.inject(`${url}context-response-one/context?turnId=other-turn`)).statusCode).toBe(404);
  });

  it('keeps fallback snapshot deltas explicitly unavailable instead of inventing a request boundary', async () => {
    const usage = { input_tokens: 300, cached_input_tokens: 50, output_tokens: 20, total_tokens: 320 };
    const { app } = await fixture([
      record('session_meta', { id: sessionId, cwd: '/context-api-test' }),
      record('event_msg', { type: 'task_started', turn_id: turnId }),
      message('user', secretPrompt, 1),
      message('assistant', currentResponse, 2, 'final_answer'),
      record('event_msg', { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 10000 } }, 3),
      record('event_msg', { type: 'task_complete', turn_id: turnId }, 4),
    ]);
    const detail = (await app.inject(`/api/sessions/${sessionId}/turns/${turnId}`)).json<TurnDetail>();
    expect(detail.requests[0]?.source).toBe('snapshot-delta');
    const result = await analysis(app, detail.requests[0]!.id);
    expect(result.boundary).toBe('unavailable');
    expect(result.scope).toBe('unavailable');
    expect(result.estimatedTotalTokens).toBeNull();
    expect(result.components.every(item => item.tokens === null && item.status === 'unavailable')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secretPrompt);
  });

  it('keeps health requests responsive while a cold tokenizer analyzes several long contexts', async () => {
    const records = twoRequests();
    records.splice(2, 0, message('developer', `<skills_instructions>${'LONG_PRIVATE_CONTEXT '.repeat(30000)}</skills_instructions>`, 0));
    const { app } = await fixture(records);
    await app.ready();
    const url = `/api/sessions/${sessionId}/requests/context-response-two/context?turnId=${turnId}`;
    const pending = [app.inject(url), app.inject(url), app.inject(url)];
    await new Promise(resolve => setTimeout(resolve, 30));
    const started = performance.now();
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    expect(performance.now() - started).toBeLessThan(1000);
    const analyses = await Promise.all(pending);
    for (const response of analyses) {
      expect(response.statusCode).toBe(200);
      const result = response.json<RequestContextAnalysis>();
      expect(result.components.some(item => item.method === 'sampled')).toBe(true);
      expect(JSON.stringify(result)).not.toContain('LONG_PRIVATE_CONTEXT');
    }
  }, 30000);
});
