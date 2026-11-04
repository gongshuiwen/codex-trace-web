import { mkdtemp, mkdir, rm, writeFile, appendFile, realpath, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { IndexService } from '../server/indexer.js';
import { INDEX_SCHEMA_VERSION, SessionStore } from '../server/store.js';
import type { IndexedSession } from '../server/parser-types.js';
import type { UsageSummary } from '../shared/types.js';

const unknownUsage: UsageSummary = {
  tokens: null, requestCount: 0, completeness: 'unknown', latestInputTokens: null, contextWindow: null,
};

function data(id: string, message: string, parentId?: string): IndexedSession {
  return {
    session: {
      id, title: `Session ${id}`, cwd: '/projects/测试', project: '测试', model: 'test-model', source: 'test',
      startedAt: '2026-11-02T01:00:00Z', updatedAt: '2026-11-02T01:00:01Z', status: 'completed',
      turnCount: 1, toolCount: 0, filePath: `/logs/${id}.jsonl`, fileSize: 100, revision: '1', usage: unknownUsage,
      parseErrors: 0, ...(parentId ? { parentId } : {}),
    },
    turns: [{ id: 'turn-1', index: 0, prompt: message, preview: '', model: 'test-model',
      startedAt: '2026-11-02T01:00:00Z', status: 'completed', toolCount: 0, usage: unknownUsage,
      startOffset: 0, endOffset: 100 }],
    searchMessages: [{ turnId: 'turn-1', text: message }],
  };
}

const ready = { status: 'ready' as const, discovered: 0, indexed: 0, errors: 0 };

async function eventually<T>(action: () => Promise<T>, check: (value: T) => boolean, timeout = 12000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await action();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Expected index condition was not reached');
}

function log(id: string, prompt: string): string {
  const timestamp = '2026-11-02T01:00:00Z';
  return [
    { type: 'session_meta', timestamp, payload: { id, cwd: '/projects/test', timestamp, originator: 'codex_cli_rs' } },
    { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '完成。' }] } },
    { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
}

describe('persistent searchable summaries', () => {
  test('searches recorded agent task paths and nicknames while preserving conversation titles', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-lens-names-'));
    const store = new SessionStore(path.join(root, 'test.sqlite'));
    try {
      const agent = data('named-agent', 'ordinary request text', 'parent');
      agent.session.agentName = '/root/review_worker';
      agent.session.agentNickname = 'TestAlias';
      store.upsert(agent, '/logs/named-agent.jsonl', 100, 1);
      for (const query of ['review_worker', '/root/review_worker', 'TestAlias']) {
        const result = store.list({ query }, ready);
        expect(result.items.map(item => item.id)).toEqual(['named-agent']);
        expect(result.items[0]?.title).toBe('Session named-agent');
      }
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test('Chinese substring search returns a turn match, and wildcard characters remain literal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-lens-store-'));
    const store = new SessionStore(path.join(root, 'test.sqlite'));
    try {
      store.upsert(data('a', '这次检查缓存命中率，目标为 80%_done。'), '/logs/a.jsonl', 100, 1);
      store.upsert(data('b', '其他对话不匹配。'), '/logs/b.jsonl', 100, 1);
      const result = store.list({ query: '缓存命中' }, ready);
      expect(result.items.map(session => session.id)).toEqual(['a']);
      expect(result.items[0].match?.turnId).toBe('turn-1');
      expect(result.items[0].match?.excerpt).toContain('缓存命中');
      expect(store.list({ query: '%_' }, ready).total).toBe(1);
      expect(store.list({ query: '不存在' }, ready).total).toBe(0);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test('upsert removes stale search entries, survives reopening, and bounds cyclic lineage', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-lens-store-'));
    const database = path.join(root, 'test.sqlite');
    let store = new SessionStore(database);
    try {
      store.upsert(data('a', 'before', 'b'), '/logs/a.jsonl', 100, 1);
      store.upsert(data('b', 'child', 'a'), '/logs/b.jsonl', 100, 1);
      store.upsert(data('a', 'after', 'b'), '/logs/a.jsonl', 200, 2);
      expect(store.list({ query: 'before' }, ready).total).toBe(0);
      expect(store.fingerprint('/logs/a.jsonl')).toEqual({ size: 200, mtimeMs: 2 });
      expect(store.get('a')?.parent?.id).toBe('b');
      expect(store.get('a')?.children[0].id).toBe('b');
      store.close();
      store = new SessionStore(database);
      expect(store.list({ query: 'after' }, ready).total).toBe(1);
      store.removePath('/logs/a.jsonl');
      expect(store.list({ query: 'after' }, ready).total).toBe(0);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  test('rejects a replayed parent ID in a child rollout filename instead of overwriting the parent path', () => {
    const parentId = '00000000-1111-4222-8333-444444444444';
    const childId = '01a18b7d-1111-7222-a333-444444444444';
    const parentPath = `/logs/rollout-2026-11-02T01-00-00-${parentId}.jsonl`;
    const childPath = `/logs/rollout-2026-11-02T01-01-00-${childId}.jsonl`;
    const store = new SessionStore(':memory:');
    try {
      store.upsert(data(parentId, '父会话'), parentPath, 100, 1);
      expect(() => store.upsert(data(parentId, '错误地重放父ID'), childPath, 200, 2)).toThrow('日志会话标识');
      expect(store.getPath(parentId)).toBe(parentPath);
      store.upsert(data(childId, '子会话', parentId), childPath, 200, 2);
      expect(store.getPath(childId)).toBe(childPath);
      expect(store.get(parentId)?.children[0].id).toBe(childId);
    } finally { store.close(); }
  });
});

describe('background index service', () => {
  test('rebuilds failure counts from unchanged logs instead of trusting a pre-statistics cache', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-lens-failure-cache-'));
    const logs = path.join(root, 'sessions');
    const cache = path.join(root, 'cache');
    await mkdir(logs);
    await mkdir(cache);
    const file = path.join(logs, 'rollout-failure.jsonl');
    const records = log('failure-cache', 'check failure counts').trim().split('\n').map(line => JSON.parse(line));
    records.splice(3, 0,
      { type: 'response_item', timestamp: '2026-11-03T01:00:00Z', payload: { type: 'function_call', call_id: 'failed', name: 'exec_command', arguments: '{}' } },
      { type: 'response_item', timestamp: '2026-11-03T01:00:01Z', payload: { type: 'function_call_output', call_id: 'failed', output: '{"exit_code":2}' } });
    records.push({ type: 'compacted', timestamp: '2026-11-03T01:00:02Z', payload: { turn_id: 'turn-1' } });
    await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const canonical = await realpath(logs);
    const hash = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex').slice(0, 20);
    const obsolete = path.join(cache, `index-v${INDEX_SCHEMA_VERSION - 1}-${hash}.sqlite`);
    const old = new SessionStore(obsolete);
    const metadata = await stat(file);
    const oldSummary = data('failure-cache', 'check failure counts');
    oldSummary.session.toolCount = 1;
    oldSummary.turns[0].toolCount = 1;
    old.upsert(oldSummary, file, metadata.size, metadata.mtimeMs);
    old.close();
    const obsoleteDatabase = new DatabaseSync(obsolete);
    obsoleteDatabase.exec(`UPDATE schema_version SET version = ${INDEX_SCHEMA_VERSION - 1}`);
    obsoleteDatabase.close();
    const index = new IndexService({ sessionsDir: logs, dataDir: cache });
    try {
      await index.start();
      await eventually(() => index.list(), result => result.progress.status === 'ready' && result.total === 1);
      expect((await index.get('failure-cache'))?.session).toMatchObject({ toolCount: 1, toolFailureCount: 1, compactionCount: 1 });
      expect((await index.get('failure-cache'))?.session.durationMs).toBeGreaterThan(0);
      expect((await readdir(cache)).some(name => name === `index-v${INDEX_SCHEMA_VERSION}-${hash}.sqlite`)).toBe(true);
      expect(index.progress.errors).toBe(0);
    } finally {
      await index.stop();
      if (!path.resolve(root).startsWith(path.join(tmpdir(), 'session-lens-failure-cache-'))) throw new Error('Unexpected cleanup target');
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);

  test('persists final failure counts and emits session changes as appended output fails and recovers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-lens-failure-live-'));
    const logs = path.join(root, 'sessions');
    await mkdir(logs);
    const file = path.join(logs, 'rollout-live.jsonl');
    const records = log('failure-live', 'observe tool status').trim().split('\n').map(line => JSON.parse(line));
    records.splice(3, 0,
      { type: 'response_item', timestamp: '2026-11-03T01:00:00Z', payload: { type: 'function_call', call_id: 'live', name: 'exec_command', arguments: '{}' } },
      { type: 'response_item', timestamp: '2026-11-03T01:00:01Z', payload: { type: 'function_call_output', call_id: 'live', output: '{"exit_code":0}' } });
    await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const index = new IndexService({ sessionsDir: logs, dataDir: path.join(root, 'cache') });
    let changes = 0;
    index.on('change', event => { if (event.type === 'session-changed' && event.sessionId === 'failure-live') changes++; });
    try {
      await index.start();
      await eventually(() => index.get('failure-live'), result => result?.session.toolFailureCount === 0);
      const initialChanges = changes;
      const update = (output: string) => JSON.stringify({ type: 'response_item', timestamp: '2026-11-03T01:00:02Z', payload: { type: 'function_call_output', call_id: 'live', output } }) + '\n';
      await appendFile(file, update('{"exit_code":2}'));
      await eventually(() => index.get('failure-live'), result => result?.session.toolFailureCount === 1);
      expect(changes).toBeGreaterThan(initialChanges);
      expect((await index.get('failure-live'))?.session.toolCount).toBe(1);
      const beforeCompaction = changes;
      await appendFile(file, JSON.stringify({ type: 'compacted', timestamp: '2026-11-03T01:00:05Z', payload: { turn_id: 'turn-1' } }) + '\n');
      await eventually(() => index.get('failure-live'), result => result?.session.compactionCount === 1);
      expect((await index.get('failure-live'))?.session.durationMs).toBe(86405000);
      expect(changes).toBeGreaterThan(beforeCompaction);
      await index.stop();
      await index.start();
      await eventually(() => index.list(), result => result.progress.status === 'ready');
      expect((await index.get('failure-live'))?.session.toolFailureCount).toBe(1);
      expect((await index.get('failure-live'))?.session).toMatchObject({ compactionCount: 1, durationMs: 86405000 });
      await appendFile(file, update('{"exit_code":0}'));
      await eventually(() => index.get('failure-live'), result => result?.session.toolFailureCount === 0);
      expect((await index.get('failure-live'))?.session.toolCount).toBe(1);
    } finally {
      await index.stop();
      if (!path.resolve(root).startsWith(path.join(tmpdir(), 'session-lens-failure-live-'))) throw new Error('Unexpected cleanup target');
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test('rebuilds past the old cache namespace and keeps parent/child identity separate after replay', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-lens-lineage-'));
    const logs = path.join(root, 'sessions');
    const cache = path.join(root, 'cache');
    await mkdir(logs);
    await mkdir(cache);
    const parentId = '00000000-1111-4222-8333-444444444444';
    const childId = '01a18b7d-1111-7222-a333-444444444444';
    const parentPath = path.join(logs, `rollout-2026-11-02T01-00-00-${parentId}.jsonl`);
    const childPath = path.join(logs, `rollout-2026-11-02T01-01-00-${childId}.jsonl`);
    const timestamp = '2026-11-02T01:00:00.000Z';
    const message = (text: string) => ({ type: 'response_item', timestamp, payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text }],
    } });
    const start = (id: string) => ({ type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: id } });
    const end = (id: string) => ({ type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: id } });
    const parentMeta = { type: 'session_meta', timestamp, payload: { id: parentId, cwd: '/parent', timestamp } };
    const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
    const child = [
      { type: 'session_meta', timestamp, payload: { id: childId, session_id: parentId, parent_thread_id: parentId,
        cwd: '/child', timestamp, subagent_history_start_ordinal: 7 } },
      parentMeta, start('parent-turn'), message('父会话独有问题'),
      { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '重放的父回答' }] } },
      { type: 'token_usage_record', timestamp, payload: { response_id: 'parent-response', turn_id: 'parent-turn', usage, thread_token_usage: usage } },
      end('parent-turn'),
      { type: 'event_msg', timestamp, payload: { type: 'thread_settings_applied' } },
      start('child-turn'), message('子代理自身任务'),
      { type: 'token_usage_record', timestamp, payload: { response_id: 'child-response', turn_id: 'child-turn', usage, thread_token_usage: usage } },
      end('child-turn'),
    ].map((record, ordinal) => JSON.stringify({ ...record, ordinal })).join('\n') + '\n';
    await writeFile(parentPath, [parentMeta, start('parent-turn'), message('父会话独有问题'), end('parent-turn')].map(record => JSON.stringify(record)).join('\n') + '\n');
    await writeFile(childPath, child);
    const canonical = await realpath(logs);
    const hash = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex').slice(0, 20);
    // A cache from the old parser must not be opened or trusted, even when its
    // unchanged file fingerprints would previously have hidden the ID bug.
    await writeFile(path.join(cache, `index-v1-${hash}.sqlite`), 'obsolete contaminated cache');
    const index = new IndexService({ sessionsDir: logs, dataDir: cache });
    try {
      await index.start();
      await eventually(() => index.list(), result => result.progress.status === 'ready' && result.total === 2);
      expect(index.progress.errors).toBe(0);
      expect(await index.getPath(parentId)).toBe(parentPath);
      expect(await index.getPath(childId)).toBe(childPath);
      expect((await index.get(parentId))?.children.map(session => session.id)).toEqual([childId]);
      const childDetail = await index.get(childId);
      expect(childDetail?.parent?.id).toBe(parentId);
      expect(childDetail?.turns.map(turn => turn.id)).toEqual(['child-turn']);
      expect(childDetail?.session.usage.tokens?.totalTokens).toBe(110);
      expect((await index.list({ query: '父会话独有问题' })).items.map(item => item.id)).toEqual([parentId]);
      expect((await readdir(cache)).some(name => name === `index-v${INDEX_SCHEMA_VERSION}-${hash}.sqlite`)).toBe(true);
    } finally {
      await index.stop();
      if (!path.resolve(root).startsWith(path.join(tmpdir(), 'session-lens-lineage-'))) throw new Error('Unexpected cleanup target');
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);

  test('serves data from a TS worker, follows changes, and isolates switched directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-lens-worker-'));
    const logs = path.join(root, 'logs');
    const other = path.join(root, 'other');
    await mkdir(logs);
    await mkdir(other);
    const file = path.join(logs, 'rollout-a.jsonl');
    await writeFile(file, log('session-a', '原始测试问题'));
    await writeFile(path.join(other, 'rollout-b.jsonl'), log('session-b', '隔离目录问题'));
    const index = new IndexService({ sessionsDir: logs, dataDir: path.join(root, 'cache') });
    try {
      await index.start();
      await eventually(() => index.list({ query: '原始测试' }), result => result.items.length === 1);
      expect((await index.get('session-a'))?.turns.length).toBe(1);
      expect(await index.getPath('session-a')).toBe(file);
      await appendFile(file, JSON.stringify({ type: 'response_item', timestamp: '2026-11-02T01:00:02Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '增量新增正文' }] } }) + '\n');
      await eventually(() => index.list({ query: '增量新增' }), result => result.total === 1);
      await writeFile(file, log('session-replaced', '替换文件正文'));
      await eventually(() => index.list({ query: '替换文件' }), result => result.total === 1);
      expect(await index.get('session-a')).toBeNull();
      await index.setDirectory(other);
      await eventually(() => index.list({}), result => result.items.some(item => item.id === 'session-b'));
      expect(await index.get('session-replaced')).toBeNull();
      await rm(path.join(other, 'rollout-b.jsonl'));
      await eventually(() => index.list({}), result => result.total === 0);
    } finally { await index.stop(); await rm(root, { recursive: true, force: true }); }
  }, 30000);

  test('reports an unavailable root while keeping the service responsive', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-lens-missing-'));
    const index = new IndexService({ sessionsDir: path.join(root, 'missing'), dataDir: path.join(root, 'cache') });
    try {
      await index.start();
      const result = await eventually(() => index.list({}), value => value.progress.status === 'error');
      expect(result.total).toBe(0);
      expect(result.progress.message).toContain('无法读取日志目录');
    } finally { await index.stop(); await rm(root, { recursive: true, force: true }); }
  }, 20000);
});
