import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getEncoding } from 'js-tiktoken';
import { analyzeRequestContext } from '../server/context-analysis.js';
import type { ContextCategory, RequestContextAnalysis, RequestUsage } from '../shared/types.js';

const directories: string[] = [];
const usage = (input = 1000) => ({ inputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: input + 10 });
const request = (id = 'r1', input = 1000): RequestUsage => ({ id, turnId: 't1', timestamp: '2026-01-01T00:00:00Z', usage: usage(input), source: 'record' });
const row = (type: string, payload: Record<string, unknown>, ordinal?: number) => JSON.stringify({ type, payload, ...(ordinal != null ? { ordinal } : {}) });
const meta = (base = '') => row('session_meta', { id: 'root', base_instructions: { text: base } });
const message = (role: string, text: string, kinds?: string[]) => row('response_item', { type: 'message', role, content: [{ type: 'input_text', text }],
  ...(kinds ? { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } : {}) });
const generated = (text = 'current response output') => message('assistant', text);
const record = (id = 'r1', input = 1000) => row('token_usage_record', { response_id: id, turn_id: 't1', usage: { input_tokens: input, output_tokens: 10, total_tokens: input + 10 } });
const toolCall = (id: string, name = 'exec', args = 'execute this') => row('response_item', { type: 'custom_tool_call', call_id: id, name, input: args });
const toolOutput = (id: string, output: unknown) => row('response_item', { type: 'custom_tool_call_output', call_id: id, output });
const component = (analysis: RequestContextAnalysis, id: ContextCategory) => analysis.components.find(part => part.id === id)!;
let testEncoder: ReturnType<typeof getEncoding> | null = null;
const tokens = (text: string) => (testEncoder ??= getEncoding('o200k_base')).encode(text, [], []).length;

async function fixture(rows: string[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-context-test-'));
  directories.push(directory);
  const file = path.join(directory, 'session.jsonl');
  await writeFile(file, rows.join('\n') + '\n');
  return file;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('per-request visible context analysis', () => {
  it('freezes before the current generated output, including a tool call before usage is logged', async () => {
    const file = await fixture([meta(), message('user', 'first question', ['user.text']), generated('current output '.repeat(3000)), toolCall('c1'), record(), toolOutput('c1', 'later output')]);
    const result = await analyzeRequestContext(file, request());
    expect(result.boundary).toBe('inferred');
    expect(component(result, 'userMessages').tokens).toBe(tokens('first question'));
    expect(component(result, 'toolOutputs')).toMatchObject({ tokens: 0, items: 0, status: 'estimated' });
    expect(component(result, 'other').tokens).toBeNull();
    expect(result.estimatedTotalTokens).toBe(tokens('first question'));
  });

  it('includes previous model output and tool results for the next request without leaking raw text', async () => {
    const file = await fixture([meta(), message('user', 'prompt'), generated('prior assistant'), toolCall('c1'), record('r1'),
      toolOutput('c1', 'previousSecret'), generated('second current output'), toolCall('c2'), record('r2'), toolOutput('c2', 'currentSecret')]);
    const first = await analyzeRequestContext(file, request('r1'));
    const second = await analyzeRequestContext(file, request('r2'));
    expect(component(first, 'toolOutputs').tokens).toBe(0);
    expect(component(second, 'toolOutputs')).toMatchObject({ tokens: tokens('previousSecret'), items: 1 });
    expect(component(second, 'other').items).toBe(2);
    expect(JSON.stringify(second)).not.toContain('previousSecret');
    expect(JSON.stringify(second)).not.toContain('currentSecret');
    const original = JSON.stringify(second);
    await appendFile(file, generated('late append excluded') + '\n');
    expect(JSON.stringify(await analyzeRequestContext(file, request('r2')))).toBe(original);
  });

  it('classifies each mixed content block using metadata and deduplicates the metadata base instructions', async () => {
    const mixed = row('response_item', { type: 'message', role: 'developer', content: [
      { type: 'input_text', text: 'general runtime directions' }, { type: 'input_text', text: 'skill catalog' },
      { type: 'input_text', text: 'project rules' }, { type: 'input_text', text: 'namespace descriptors' },
    ], internal_chat_message_metadata_passthrough: { content_item_kinds: ['generic.developer_instructions', 'host_skills.instructions', 'agents_md.instructions', 'tools.deferred_namespaces'] } });
    const file = await fixture([meta('base instructions'), message('developer', 'base instructions', ['model.base_instructions']), mixed,
      message('user', 'question', ['user.text']), row('world_state', { full: true, state: { top_level_tools: { imaginary: 'f'.repeat(40) } } }), generated(), record()]);
    const result = await analyzeRequestContext(file, request());
    expect(component(result, 'other')).toMatchObject({ tokens: tokens('base instructions') + tokens('general runtime directions'), items: 2 });
    expect(component(result, 'skills')).toMatchObject({ tokens: tokens('skill catalog'), items: 1 });
    expect(component(result, 'projectInstructions')).toMatchObject({ tokens: tokens('project rules'), items: 1 });
    expect(component(result, 'toolDefinitions')).toMatchObject({ tokens: tokens('namespace descriptors'), items: 1, status: 'partial' });
  });

  it('splits explicit legacy tags instead of classifying whole mixed messages as instructions', async () => {
    const file = await fixture([meta(), message('user', '# AGENTS.md instructions\n<INSTRUCTIONS>project only</INSTRUCTIONS>\n<environment_context>environment only</environment_context>'),
      message('developer', '<skills_instructions>skill only</skills_instructions>\nother runtime directions'), generated(), record()]);
    const result = await analyzeRequestContext(file, request());
    expect(component(result, 'projectInstructions').tokens).toBe(tokens('# AGENTS.md instructions\n') + tokens('<INSTRUCTIONS>project only</INSTRUCTIONS>'));
    expect(component(result, 'skills').tokens).toBe(tokens('<skills_instructions>skill only</skills_instructions>'));
    expect(component(result, 'other').tokens).toBe(tokens('\n<environment_context>environment only</environment_context>') + tokens('\nother runtime directions'));
  });

  it('counts explicit schema as a definition and keeps unknown developer text in other', async () => {
    const schema = { type: 'function', name: 'read_file', parameters: { type: 'object' } };
    const file = await fixture([meta(), row('response_item', { type: 'additional_tools', tools: [schema] }),
      message('developer', 'unrecognized runtime text mentioning skills and tools'), generated(), record()]);
    const result = await analyzeRequestContext(file, request());
    expect(component(result, 'toolDefinitions')).toMatchObject({ tokens: tokens(JSON.stringify(schema)), items: 1 });
    expect(component(result, 'other').items).toBe(1);
    expect(component(result, 'skills').tokens).toBeNull();
    expect(component(result, 'projectInstructions').tokens).toBeNull();
  });

  it('does not mistake mixed shell output mentioning SKILL.md for loaded skill instructions', async () => {
    const file = await fixture([meta(), message('user', 'read a skill'), toolCall('c1', 'functions.exec', 'Get-Content SKILL.md'), record('r1'),
      toolOutput('c1', 'SKILL.md instructions plus command output'), generated(), record('r2')]);
    const result = await analyzeRequestContext(file, request('r2'));
    expect(component(result, 'skills').tokens).toBeNull();
    expect(component(result, 'toolOutputs').items).toBe(1);
  });

  it('moves a confirmed dedicated SKILL.md reader result into skills exactly once', async () => {
    const file = await fixture([meta(), message('user', 'read a skill'), row('response_item', { type: 'function_call', name: 'read_file', call_id: 'c1', arguments: JSON.stringify({ path: '/skills/example/SKILL.md' }) }),
      record('r1'), toolOutput('c1', 'confirmed skill body'), generated(), record('r2')]);
    const result = await analyzeRequestContext(file, request('r2'));
    expect(component(result, 'skills')).toMatchObject({ tokens: tokens('confirmed skill body'), items: 1 });
    expect(component(result, 'toolOutputs').tokens).toBe(0);
  });

  it('clears pre-compaction history and leaves unobserved tool outputs unavailable', async () => {
    const file = await fixture([meta('old base'), message('user', 'old question'), generated(), record('r1'), toolOutput('old', 'old output'),
      row('compacted', { message: 'compact summary' }), message('user', 'new question'), generated(), record('r2')]);
    const result = await analyzeRequestContext(file, request('r2'));
    expect(result.scope).toBe('since-compaction');
    expect(component(result, 'userMessages').tokens).toBe(tokens('new question'));
    expect(component(result, 'other')).toMatchObject({ tokens: tokens('compact summary'), status: 'partial' });
    expect(component(result, 'toolOutputs')).toMatchObject({ tokens: null, status: 'unavailable' });
  });

  it('does not clear history or directly count retained verified answers', async () => {
    const file = await fixture([meta(), message('user', 'visible question'), row('retained_context', { type: 'verified_answer', questions: [{ question: 'hidden question', answer: 'answer' }] }), generated(), record()]);
    const result = await analyzeRequestContext(file, request());
    expect(component(result, 'userMessages').tokens).toBe(tokens('visible question'));
    expect(result.scope).toBe('visible-history');
    expect(result.warnings.some(warning => warning.includes('retained_context'))).toBe(true);
  });

  it('skips a child inherited prefix and warns about the unavailable inherited context', async () => {
    const rows = [row('session_meta', { id: 'child', session_id: 'parent', subagent_history_start_ordinal: 4 }),
      row('session_meta', { id: 'parent' }), message('user', 'inherited user'), generated('inherited assistant'),
      row('event_msg', { type: 'task_started', turn_id: 'child-turn' }), message('user', 'child user'), generated(), record()]
      .map((raw, ordinal) => JSON.stringify({ ...JSON.parse(raw), ordinal }));
    const file = await fixture(rows);
    const result = await analyzeRequestContext(file, request());
    expect(component(result, 'userMessages')).toMatchObject({ tokens: tokens('child user'), status: 'partial' });
    expect(component(result, 'toolOutputs').tokens).toBeNull();
    expect(result.warnings.some(warning => warning.includes('继承'))).toBe(true);
  });

  it('never tokenizes image payloads or encrypted reasoning blobs as plain text', async () => {
    const base64 = 'abCDE0123'.repeat(10000);
    const file = await fixture([meta(), row('response_item', { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'look at this image' }, { type: 'input_image', image_url: `data:image/png;base64,${base64}` },
    ] }), row('response_item', { type: 'reasoning', encrypted_content: base64, summary: [] }), record('r1'), generated(), record('r2')]);
    const result = await analyzeRequestContext(file, request('r2'));
    expect(component(result, 'userMessages').tokens).toBe(tokens('look at this image'));
    expect(component(result, 'other').tokens).toBeNull();
    expect(result.estimatedTotalTokens).toBeLessThan(100);
    expect(result.warnings.some(warning => warning.includes('多模态') || warning.includes('非文本'))).toBe(true);
  });

  it('uses bounded samples for long text without normalizing an excess estimate', async () => {
    const file = await fixture([meta(), message('user', 'long narrative '.repeat(6000)), generated(), record('r1', 1)]);
    const result = await analyzeRequestContext(file, request('r1', 1));
    expect(component(result, 'userMessages').method).toBe('sampled');
    expect(result.estimatedTotalTokens).toBeGreaterThan(1000);
    expect(result.unattributedTokens).toBe(1 - result.estimatedTotalTokens!);
    expect(result.excessTokens).toBe(result.estimatedTotalTokens! - 1);
  });

  it('deduplicates classic event messages and response_item copies', async () => {
    const file = await fixture([meta(), row('event_msg', { type: 'user_message', message: 'one prompt' }), message('user', 'one prompt'),
      generated('first response'), row('event_msg', { type: 'agent_message', message: 'first response' }), record('r1'), generated(), record('r2')]);
    const result = await analyzeRequestContext(file, request('r2'));
    expect(component(result, 'userMessages').tokens).toBe(tokens('one prompt'));
    expect(component(result, 'other').tokens).toBe(tokens('first response'));
  });

  it('makes missing direct boundaries and aggregate snapshot deltas explicitly unavailable', async () => {
    const file = await fixture([meta(), message('user', 'question'), record()]);
    const result = await analyzeRequestContext(file, request());
    expect(result.boundary).toBe('unavailable');
    expect(result.components.every(part => part.tokens === null)).toBe(true);
    const fallback = await analyzeRequestContext(file, { ...request('snapshot-0'), source: 'snapshot-delta' });
    expect(fallback.scope).toBe('unavailable');
    expect(fallback.estimatedTotalTokens).toBeNull();
    expect(fallback.components.every(part => part.status === 'unavailable')).toBe(true);
  });
});
