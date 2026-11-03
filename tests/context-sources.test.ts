import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRequestContext, compareRequestContext, loadContextSources } from '../server/context-analysis.js';
import type { RequestUsage } from '../shared/types.js';

const roots: string[] = [];
const row = (type: string, payload: object) => JSON.stringify({ type, timestamp: '2026-01-01T00:00:00Z', payload });
const message = (role: string, text: string, kind?: string) => row('response_item', { type: 'message', role,
  content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  ...(kind ? { internal_chat_message_metadata_passthrough: { content_item_kinds: [kind] } } : {}),
});
const generated = () => message('assistant', 'current output excluded');
const record = (id: string, turn = 't1') => row('token_usage_record', { response_id: id, turn_id: turn, usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 } });
const request = (id: string, turnId = 't1'): RequestUsage => ({ id, turnId, timestamp: '2026-01-01T00:00:00Z', source: 'record',
  usage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 } });
async function fixture(lines: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'session-lens-sources-'));
  roots.push(root);
  const file = path.join(root, 'rollout.jsonl');
  await writeFile(file, [row('session_meta', { id: 'source-test' }), ...lines].join('\n') + '\n');
  return file;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.join(tmpdir(), 'session-lens-sources-'))) throw new Error('Unexpected cleanup target');
    await rm(root, { recursive: true, force: true });
  }
});

describe('candidate context provenance', () => {
  it('paginates the same contributions as category estimates and only returns bounded excerpts', async () => {
    const file = await fixture([row('event_msg', { type: 'task_started', turn_id: 't1' }),
      ...Array.from({ length: 55 }, (_, i) => message('user', `source-${i} ${'long text '.repeat(100)}`)), generated(), record('r1')]);
    const numeric = await analyzeRequestContext(file, request('r1'));
    const first = await loadContextSources(file, request('r1'), 'userMessages', 0, 1000);
    const second = await loadContextSources(file, request('r1'), 'userMessages', first.nextOffset!, 50);
    expect(first.sources).toHaveLength(50);
    expect(first.total).toBe(55);
    expect(first.nextOffset).toBe(50);
    expect(second.sources).toHaveLength(5);
    expect(second.nextOffset).toBeNull();
    const all = [...first.sources, ...second.sources];
    expect(new Set(all.map(source => source.id)).size).toBe(55);
    expect(all.reduce((sum, source) => sum + source.estimatedTokens, 0)).toBe(numeric.components.find(item => item.id === 'userMessages')?.tokens);
    expect(all.every(source => source.excerpt.length <= 300 && source.turnId === 't1' && source.eventId?.startsWith('event-'))).toBe(true);
    expect(JSON.stringify(await analyzeRequestContext(file, request('r1')))).not.toContain('long text');
  });

  it('keeps slot replacement, previous tool output and input boundaries consistent with numeric analysis', async () => {
    const file = await fixture([
      row('event_msg', { type: 'task_started', turn_id: 't1' }),
      message('developer', 'old project instruction', 'agents_md.instructions'), message('user', 'question'),
      row('response_item', { type: 'function_call', name: 'read_file', call_id: 'call1', arguments: '{"path":"demo.txt"}' }), record('r1'),
      row('response_item', { type: 'function_call_output', call_id: 'call1', output: 'previous output source' }),
      message('developer', 'replacement project instruction', 'agents_md.instructions'),
      generated(), record('r2'), row('response_item', { type: 'function_call_output', call_id: 'later', output: 'excluded current output source' }),
    ]);
    const sources = await loadContextSources(file, request('r2'), 'projectInstructions');
    expect(sources.sources).toHaveLength(1);
    expect(sources.sources[0].excerpt).toBe('replacement project instruction');
    const tools = await loadContextSources(file, request('r2'), 'toolOutputs');
    expect(tools.sources).toHaveLength(1);
    expect(tools.sources[0]).toMatchObject({ excerpt: 'previous output source', role: 'tool', turnId: 't1' });
    expect(tools.sources[0].eventId).toMatch(/^tool-/);
    const comparison = await compareRequestContext(file, request('r2'), request('r1'));
    expect(comparison.comparable).toBe(true);
    expect(comparison.changes.changed).toBe(1);
    expect(comparison.changes.changedSources[0].excerpt).toBe('replacement project instruction');
    expect(comparison.changes.addedSources.some(source => source.excerpt === 'previous output source')).toBe(true);
    expect(comparison.components.find(item => item.id === 'toolOutputs')?.deltaTokens).toBeGreaterThan(0);
    expect(comparison.components.find(item => item.id === 'skills')?.deltaTokens).toBeNull();
    expect(JSON.stringify(comparison)).not.toContain('excluded current output source');
  });

  it('does not force source comparisons across compaction or unknown snapshot boundaries', async () => {
    const file = await fixture([message('user', 'before'), generated(), record('r1'),
      row('compacted', { message: 'compact summary' }), message('user', 'after'), generated(), record('r2')]);
    const compressed = await compareRequestContext(file, request('r2'), request('r1'));
    expect(compressed.comparable).toBe(false);
    expect(compressed.components.every(component => component.deltaTokens === null)).toBe(true);
    expect(compressed.changes).toMatchObject({ added: 0, removed: 0, changed: 0 });
    expect(compressed.warnings.some(warning => warning.includes('压缩'))).toBe(true);
    const fallback = { ...request('snapshot-1'), source: 'snapshot-delta' as const };
    const missing = await loadContextSources(file, fallback, 'other');
    expect(missing.sources).toEqual([]);
    expect(missing.boundary).toBe('unavailable');
    const unavailable = await compareRequestContext(file, fallback, request('r2'));
    expect(unavailable.comparable).toBe(false);
    expect(unavailable.components.every(component => component.deltaTokens === null)).toBe(true);
    const first = await compareRequestContext(file, request('r1'), null);
    expect(first.previous).toBeNull();
    expect(first.comparable).toBe(false);
  });

  it('detects a replaced source even when its token count is unchanged and allows the same post-compaction range', async () => {
    const file = await fixture([
      row('compacted', { message: 'visible compact summary' }),
      message('developer', 'hello', 'agents_md.instructions'), message('user', 'continue'), generated(), record('r1'),
      message('developer', 'world', 'agents_md.instructions'), generated(), record('r2'),
    ]);
    const comparison = await compareRequestContext(file, request('r2'), request('r1'));
    expect(comparison.comparable).toBe(true);
    expect(comparison.components.find(component => component.id === 'projectInstructions')?.deltaTokens).toBe(0);
    expect(comparison.changes.changed).toBe(1);
    expect(comparison.changes.changedSources[0]).toMatchObject({ excerpt: 'world', partial: true });
  });
});
