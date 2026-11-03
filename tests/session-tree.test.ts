import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../server/store.js';
import { IndexService } from '../server/indexer.js';
import { createApp } from '../server/app.js';
import type { IndexedSession } from '../server/parser-types.js';
import type { SessionChildrenPage, SessionList } from '../shared/types.js';

const ready = { status: 'ready' as const, discovered: 0, indexed: 0, errors: 0 };
function data(id: string, parentId?: string, day = 1, cwd = '/test/project'): IndexedSession {
  const timestamp = `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`;
  return { session: {
    id, title: id, cwd, project: cwd.split('/').at(-1)!, source: 'synthetic', model: 'test',
    startedAt: timestamp, updatedAt: timestamp, status: 'completed', turnCount: 0, toolCount: 0,
    filePath: `/logs/${id}.jsonl`, fileSize: 100, revision: '1', parseErrors: 0,
    usage: { tokens: null, requestCount: 0, completeness: 'unknown', latestInputTokens: null, contextWindow: null },
    ...(parentId ? { parentId } : {}),
  }, turns: [], searchMessages: [] };
}
function put(store: SessionStore, id: string, parentId?: string, day = 1, cwd = '/test/project') {
  store.upsert(data(id, parentId, day, cwd), `/logs/${id}.jsonl`, 100, day);
}

describe('indexed session tree summaries', () => {
  it('adds global child counts and cross-page ancestor context without changing list pagination', () => {
    const store = new SessionStore(':memory:');
    try {
      put(store, 'root', undefined, 1, '/parent/project');
      put(store, 'child-a', 'root', 2);
      put(store, 'grandchild-match', 'child-a', 3);
      put(store, 'child-b', 'root', 4);
      put(store, 'unrelated', undefined, 5);
      const first = store.list({ limit: 1, selectedId: 'grandchild-match' }, ready);
      expect(first.items.map(item => item.id)).toEqual(['unrelated']);
      expect(first.total).toBe(5);
      expect(first.nextCursor).toBe(1);
      expect(first.selected).toMatchObject({ id: 'grandchild-match', childCount: 0 });
      expect(first.ancestors?.map(item => item.id)).toEqual(['child-a', 'root']);
      expect(first.ancestors?.find(item => item.id === 'root')?.childCount).toBe(2);
      const next = store.list({ limit: 1, cursor: 1 }, ready);
      expect(next.items[0]).toMatchObject({ id: 'child-b', childCount: 0 });
      expect(next.ancestors?.map(item => item.id)).toEqual(['root']);
      expect(store.get('root')?.session.childCount).toBe(2);
      expect(store.get('child-a')?.session.childCount).toBe(1);
    } finally { store.close(); }
  });

  it('limits filtered context to matching nodes and ancestors and does not add an unrelated selection', () => {
    const store = new SessionStore(':memory:');
    try {
      put(store, 'root', undefined, 1, '/parent/project');
      put(store, 'child-a', 'root', 2, '/child/project');
      put(store, 'grandchild-match', 'child-a', 3, '/child/project');
      put(store, 'unrelated', undefined, 4);
      const filtered = store.list({ query: 'grandchild-match', selectedId: 'unrelated' }, ready);
      expect(filtered.items.map(item => item.id)).toEqual(['grandchild-match']);
      expect(filtered.total).toBe(1);
      expect(filtered.selected).toBeUndefined();
      expect(filtered.ancestors?.map(item => item.id)).toEqual(['child-a', 'root']);
      const project = store.list({ project: '/child/project', selectedId: 'unrelated' }, ready);
      expect(project.items.map(item => item.id)).toEqual(['grandchild-match', 'child-a']);
      expect(project.selected).toBeUndefined();
      expect(project.ancestors?.map(item => item.id)).toEqual(['root']);
      expect(store.list({ selectedId: 'missing' }, ready).selected).toBeUndefined();
    } finally { store.close(); }
  });

  it('paginates only direct children and keeps counts fresh when children change', () => {
    const store = new SessionStore(':memory:');
    try {
      put(store, 'root');
      put(store, 'child-a', 'root', 2);
      put(store, 'child-b', 'root', 3);
      put(store, 'grandchild', 'child-a', 4);
      const first = store.children('root', { limit: 1 })!;
      expect(first.items.map(item => item.id)).toEqual(['child-b']);
      expect(first.total).toBe(2);
      expect(first.nextCursor).toBe(1);
      const last = store.children('root', { cursor: 1, limit: 1 })!;
      expect(last.items[0]).toMatchObject({ id: 'child-a', childCount: 1 });
      expect(last.nextCursor).toBeNull();
      expect(store.children('root', { cursor: 100 })!.items).toEqual([]);
      expect(store.children('missing')).toBeNull();
      store.removePath('/logs/child-b.jsonl');
      expect(store.children('root')!.total).toBe(1);
      expect(store.list({ query: 'root' }, ready).items[0].childCount).toBe(1);
    } finally { store.close(); }
  });

  it('terminates cyclic, self-parent and missing-parent ancestry without hiding result nodes', () => {
    const store = new SessionStore(':memory:');
    try {
      put(store, 'cycle-a', 'cycle-b');
      put(store, 'cycle-b', 'cycle-a');
      put(store, 'self', 'self');
      put(store, 'orphan', 'missing-parent');
      const cycle = store.list({ query: 'cycle-a' }, ready);
      expect(cycle.items.map(item => item.id)).toEqual(['cycle-a']);
      expect(cycle.ancestors?.map(item => item.id)).toEqual(['cycle-b']);
      expect(store.list({ query: 'orphan' }, ready).items.map(item => item.id)).toEqual(['orphan']);
      expect(store.list({ query: 'orphan' }, ready).ancestors).toEqual([]);
      expect(store.list({ query: 'self' }, ready).items[0].childCount).toBe(0);
      expect(store.children('self')?.items).toEqual([]);
      expect(store.list({}, ready).total).toBe(4);
    } finally { store.close(); }
  });
});

it('serves children and selected ancestor context from cached SQLite without rereading logs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'session-lens-tree-api-'));
  const sessionsDir = path.join(root, 'sessions');
  const dataDir = path.join(root, 'data');
  await mkdir(sessionsDir);
  const records = [data('parent'), data('child', 'parent', 2), data('grandchild', 'child', 3), data('newest', undefined, 4)];
  for (const item of records) {
    await writeFile(path.join(sessionsDir, `rollout-${item.session.id}.jsonl`), JSON.stringify({ type: 'session_meta', timestamp: item.session.updatedAt,
      payload: { id: item.session.id, cwd: item.session.cwd, timestamp: item.session.updatedAt, title: item.session.title, parent_thread_id: item.session.parentId } }) + '\n');
  }
  const index = new IndexService({ sessionsDir, dataDir });
  const app = await createApp({ index, settings: { sessionsDir, dataDir, defaultSessionsDir: sessionsDir } });
  try {
    await index.start();
    await expect.poll(async () => (await index.list()).total).toBe(4);
    const list = (await app.inject('/api/sessions?limit=1&selectedId=grandchild')).json<SessionList>();
    expect(list.selected?.id).toBe('grandchild');
    expect(list.ancestors?.map(item => item.id)).toEqual(['child', 'parent']);
    const childrenResponse = await app.inject('/api/sessions/parent/children?limit=1');
    expect(childrenResponse.statusCode).toBe(200);
    const children = childrenResponse.json<SessionChildrenPage>();
    expect(children.items[0]).toMatchObject({ id: 'child', childCount: 1 });
    expect(children.total).toBe(1);
    expect((await app.inject('/api/sessions/parent/children?limit=101')).statusCode).toBe(400);
    expect((await app.inject('/api/sessions/parent/children?cursor=-1')).statusCode).toBe(400);
    expect((await app.inject('/api/sessions/missing/children')).statusCode).toBe(404);
    const filtered = (await app.inject('/api/sessions?query=grandchild&selectedId=newest')).json<SessionList>();
    expect(filtered.selected).toBeUndefined();
    expect(filtered.items.map(item => item.id)).toEqual(['grandchild']);
    expect(filtered.ancestors?.map(item => item.id)).toEqual(['child', 'parent']);
  } finally {
    await app.close();
    await index.stop();
    if (!path.resolve(root).startsWith(path.join(tmpdir(), 'session-lens-tree-api-'))) throw new Error('Unexpected cleanup target');
    await rm(root, { recursive: true, force: true });
  }
});
