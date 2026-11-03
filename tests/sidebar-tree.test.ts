import { describe, expect, it } from 'vitest';
import type { SessionList, SessionSummary } from '../shared/types';
import { buildSessionTree, mergeSessions, sessionAncestors, sidebarSessionTree, visibleBranchSessions } from '../client/session-tree';

function session(id: string, parentId?: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id, title: id, cwd: '/project', project: 'project', model: 'model', source: 'cli',
    startedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', status: 'completed',
    turnCount: 1, toolCount: 0, parentId, filePath: `${id}.jsonl`, fileSize: 100, revision: '1', parseErrors: 0,
    usage: { tokens: null, requestCount: 0, completeness: 'unknown', latestInputTokens: null, contextWindow: null },
    ...overrides,
  };
}

function list(items: SessionSummary[], extra: Partial<SessionList> = {}): SessionList {
  return { items, total: items.length, nextCursor: null, projects: [], progress: { status: 'ready', discovered: items.length, indexed: items.length, errors: 0 }, ...extra };
}

function allIds(tree: ReturnType<typeof buildSessionTree>) {
  const result: string[] = [];
  const queue = [...tree.roots];
  while (queue.length) {
    const node = queue.shift()!;
    result.push(node.session.id);
    queue.push(...node.children);
  }
  return result;
}

describe('sidebar session tree', () => {
  it('nests descendants under their root even across dates and source pages', () => {
    const root = session('root', undefined, { startedAt: '2026-10-01T00:00:00Z' });
    const child = session('child', 'root', { startedAt: '2026-11-01T00:00:00Z' });
    const grandchild = session('grandchild', 'child', { startedAt: '2026-11-03T00:00:00Z' });
    const tree = buildSessionTree([grandchild], [root, child]);
    expect(tree.roots.map(node => node.session.id)).toEqual(['root']);
    expect(tree.roots[0].children[0].children[0].session.id).toBe('grandchild');
    expect(sessionAncestors(tree, 'grandchild')).toEqual(['child', 'root']);
    expect(sessionAncestors(tree, 'missing')).toEqual([]);
  });

  it('keeps missing parents and self-parent sessions visible as roots', () => {
    const tree = buildSessionTree([session('orphan', 'missing'), session('self', 'self'), session('nested', 'orphan')]);
    expect(new Set(tree.roots.map(node => node.session.id))).toEqual(new Set(['orphan', 'self']));
    expect(new Set(allIds(tree))).toEqual(new Set(['orphan', 'self', 'nested']));
    expect(tree.parents.has('self')).toBe(false);
  });

  it('breaks cycles deterministically without losing nodes or descendants', () => {
    const sessions = [session('c', 'a'), session('a', 'b'), session('b', 'c'), session('leaf', 'c')];
    const tree = buildSessionTree(sessions);
    const reverse = buildSessionTree([...sessions].reverse());
    expect(tree.roots.map(node => node.session.id)).toEqual(['a']);
    expect(reverse.roots.map(node => node.session.id)).toEqual(['a']);
    expect(allIds(tree).sort()).toEqual(['a', 'b', 'c', 'leaf']);
    expect(sessionAncestors(tree, 'leaf')).toEqual(['c', 'a']);
  });

  it('handles long cycles iteratively', () => {
    const items = Array.from({ length: 3000 }, (_, index) => session(`s${index}`, `s${(index + 1) % 3000}`));
    const tree = buildSessionTree(items);
    expect(tree.roots).toHaveLength(1);
    expect(allIds(tree)).toHaveLength(3000);
    expect(sessionAncestors(tree, 's1')).toHaveLength(2999);
  });

  it('deduplicates summaries with fresh metadata while retaining search turn matches', () => {
    const match = { turnId: 'match-turn', excerpt: 'a matching message' };
    const result = mergeSessions([session('s', undefined, { match })], [session('s', undefined, { revision: 'new', title: 'fresh' })]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ revision: 'new', title: 'fresh', match });
    const newerMatch = { turnId: 'new-turn', excerpt: 'new excerpt' };
    expect(mergeSessions(result, [session('s', undefined, { match: newerMatch })])[0].match).toEqual(newerMatch);
  });

  it('includes cached branches only when reachable from this list, regardless of cache order', () => {
    const branches = new Map([
      ['child', { items: [session('grandchild', 'child')] }],
      ['unrelated', { items: [session('hidden', 'unrelated')] }],
      ['root', { items: [session('child', 'root'), session('moved', 'elsewhere')] }],
    ]);
    expect(visibleBranchSessions([session('root')], branches).map(item => item.id).sort()).toEqual(['child', 'grandchild']);
  });

  it('includes a selected child outside the page and its ancestor path', () => {
    const data = list([session('other')], { ancestors: [session('root'), session('parent', 'root')], selected: session('selected', 'parent') });
    const tree = sidebarSessionTree(data, new Map(), false);
    expect(sessionAncestors(tree, 'selected')).toEqual(['parent', 'root']);
    expect(allIds(tree).sort()).toEqual(['other', 'parent', 'root', 'selected']);
  });

  it('shows only matching items and their ancestor context while filtering', () => {
    const matched = session('match', 'root', { match: { turnId: 'turn', excerpt: 'find me' } });
    const data = list([matched], { ancestors: [session('root')], selected: session('unrelated-selected') });
    const branches = new Map([['root', { items: [session('unrelated-child', 'root')] }]]);
    const tree = sidebarSessionTree(data, branches, true);
    expect(allIds(tree)).toEqual(['root', 'match']);
    expect(tree.byId.get('match')!.session.match?.turnId).toBe('turn');
    expect(allIds(sidebarSessionTree(data, branches, false)).sort()).toEqual(['match', 'root', 'unrelated-child', 'unrelated-selected']);
  });

  it('keeps authoritative primary summaries over stale child-page metadata', () => {
    const data = list([session('root'), session('child', 'root', { revision: 'new' })]);
    const branches = new Map([['root', { items: [session('child', 'root', { revision: 'stale' })] }]]);
    const tree = sidebarSessionTree(data, branches, false);
    expect(tree.byId.get('child')!.session.revision).toBe('new');
    expect(allIds(tree)).toEqual(['root', 'child']);
  });

  it('drops obsolete cached descendants when the authoritative parent has no children', () => {
    const branches = new Map([
      ['root', { items: [session('child', 'root')] }],
      ['child', { items: [session('grandchild', 'child')] }],
    ]);
    const data = list([session('root', undefined, { childCount: 0 })]);
    expect(allIds(sidebarSessionTree(data, branches, false))).toEqual(['root']);
    const nested = list([session('root', undefined, { childCount: 1 }), session('child', 'root', { childCount: 0 })]);
    expect(allIds(sidebarSessionTree(nested, branches, false))).toEqual(['root', 'child']);
  });
});
