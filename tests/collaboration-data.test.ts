import { describe, expect, it } from 'vitest';
import type { SessionActivity, SessionSummary, TurnSummary } from '../shared/types';
import { buildSessionTree } from '../client/session-tree';
import { collectCollaborationMessages, collaborationRounds, fitCollaborationTree, layoutCollaborationTree, type CollaborationEntry } from '../client/collaboration-data';

const timestamp = '2026-11-03T00:00:00Z';
const usage = { tokens: null, requestCount: 0, completeness: 'unknown' as const, latestInputTokens: null, contextWindow: null };
function session(id: string, parentId?: string, agentName?: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id, title: id, parentId, agentName, cwd: '/project', project: 'project', model: 'test', source: 'synthetic',
    startedAt: timestamp, updatedAt: timestamp, status: 'completed', turnCount: 1, toolCount: 0, usage,
    filePath: `${id}.jsonl`, fileSize: 1, revision: '1', parseErrors: 0, ...overrides };
}
function turn(id = 't1'): TurnSummary {
  return { id, index: 0, prompt: '', preview: '', startedAt: timestamp, endedAt: timestamp,
    status: 'completed', model: 'test', toolCount: 0, usage, startOffset: 0, endOffset: 1 };
}
function message(id: string, overrides: Partial<SessionActivity['messages'][number]> = {}): SessionActivity['messages'][number] {
  return { id, turnId: 't1', timestamp, messageType: 'MESSAGE', sender: '/root/a', taskName: '/root/b', preview: 'review complete', ...overrides };
}
function entry(value: SessionSummary, messages: SessionActivity['messages'] = [], turns = [turn()]): CollaborationEntry {
  return { detail: { session: value, turns, children: [] }, activity: { requests: [], compactions: [], messages, warnings: [] } };
}

describe('collaboration message identities', () => {
  it('resolves exact unique task paths and never display names, suffixes or nicknames', () => {
    const items = [session('root'), session('a', 'root', '/root/a'), session('b', 'root', '/root/b'),
      session('nickname', 'root', '/root/alias', { agentNickname: '/root/alias' }), session('title', 'root', undefined, { title: '/root/title' })];
    const records = collectCollaborationMessages([entry(items[1], [message('1'),
      message('2', { sender: 'a', taskName: '/root/alias' }), message('3', { sender: '/root/title', taskName: '/root/a/' })])], items);
    expect(records[0]).toMatchObject({ senderId: 'a', recipientId: 'b' });
    expect(records[1].senderId).toBeUndefined();
    expect(records[1].recipientId).toBeUndefined();
    expect(records[2].senderId).toBeUndefined();
    expect(records[2].recipientId).toBeUndefined();
  });

  it('leaves duplicate paths ambiguous but isolates identical paths in separate trees', () => {
    const items = [session('r1'), session('a1', 'r1', '/root/a'), session('a2', 'r1', '/root/a'),
      session('r2'), session('a3', 'r2', '/root/a'), session('b3', 'r2', '/root/b')];
    const records = collectCollaborationMessages([entry(items[1], [message('1')]), entry(items[4], [message('2')])], items);
    expect(records).toHaveLength(2);
    expect(records[0].senderId).toBeUndefined();
    expect(records[1]).toMatchObject({ senderId: 'a3', recipientId: 'b3' });
  });

  it('infers an unnamed root only from its direct named child and matching NEW_TASK envelope', () => {
    const root = session('root');
    const child = session('a', 'root', '/root/a');
    const assignment = message('new', { messageType: 'NEW_TASK', sender: '/root', taskName: '/root/a' });
    expect(collectCollaborationMessages([entry(child, [assignment])], [root, child])[0]).toMatchObject({ senderId: 'root', recipientId: 'a' });
    expect(collectCollaborationMessages([entry(child, [message('regular', { sender: '/root' })])], [root, child])[0].senderId).toBeUndefined();
    expect(collectCollaborationMessages([entry(child, [assignment])], [child])[0].senderId).toBeUndefined();
    const grandchild = session('a', 'parent', '/root/worker/a');
    expect(collectCollaborationMessages([entry(grandchild, [{ ...assignment, taskName: '/root/worker/a' }])], [session('parent'), grandchild])[0].senderId).toBeUndefined();
  });

  it('accepts root-log NEW_TASK evidence only with an exact direct-child path and parent link', () => {
    const root = session('root');
    const child = session('a', 'root', '/root/a');
    const assignment = message('new', { messageType: 'NEW_TASK', sender: '/root', taskName: '/root/a' });
    expect(collectCollaborationMessages([entry(root, [assignment])], [root, child])[0]).toMatchObject({ senderId: 'root', recipientId: 'a' });
    const nickname = session('a', 'root', '/root/a', { agentNickname: '/root/a' });
    expect(collectCollaborationMessages([entry(root, [assignment])], [root, nickname])[0].senderId).toBeUndefined();
    expect(collectCollaborationMessages([entry(root, [assignment])], [root, session('a', 'other', '/root/a')])[0].senderId).toBeUndefined();
    expect(collectCollaborationMessages([entry(root, [{ ...assignment, taskName: '/root/missing' }])], [root, child])[0].senderId).toBeUndefined();
  });

  it('preserves distinct messages in one log and merges mirrors into a valid recipient source', () => {
    const root = session('root', undefined, '/root');
    const child = session('a', 'root', '/root/a');
    const originals = [message('1', { sender: '/root', taskName: '/root/a' }), message('2', { sender: '/root', taskName: '/root/a' })];
    const records = collectCollaborationMessages([
      entry(root, originals, []), entry(child, [message('mirror1', originals[0]), message('mirror2', { ...originals[1], id: 'mirror2' })]),
    ], [root, child]);
    expect(records).toHaveLength(2);
    expect(records.every(record => record.sessionId === 'a' && record.turnId === 't1')).toBe(true);
  });

  it('does not collapse different times, unknown times, or truncated previews across logs', () => {
    const a = session('a', 'root', '/root/a');
    const b = session('b', 'root', '/root/b');
    const records = collectCollaborationMessages([
      entry(a, [message('early'), message('unknown', { timestamp: '' }), message('long', { preview: 'x'.repeat(199) + '…' })]),
      entry(b, [message('later', { timestamp: '2026-11-03T00:00:01Z' }), message('unknown', { timestamp: '' }), message('long', { preview: 'x'.repeat(199) + '…' })]),
    ], [session('root'), a, b]);
    expect(records).toHaveLength(6);
    expect(records[0].id).toBe('early');
    expect(records.at(-1)?.timestamp).toBe('');
  });

  it('does not re-add the same session-local event if an entry appears twice', () => {
    const a = session('a');
    const own = entry(a, [message('same', { timestamp: '' })]);
    expect(collectCollaborationMessages([own, own], [a])).toHaveLength(1);
  });
});

it('uses only each loaded session own rounds and keeps identical turn IDs in separate sessions', () => {
  const a = entry(session('a'));
  const b = entry(session('b', 'a'));
  a.detail.children = [b.detail.session, session('unloaded', 'a')];
  const rounds = collaborationRounds([a, b, a]);
  expect(rounds.map(value => [value.sessionId, value.turn.id])).toEqual([['a', 't1'], ['b', 't1']]);
});

describe('collaboration tree layout', () => {
  it('fits a wide sibling group without clipping the root, shrinking nodes or losing relationships', () => {
    const tree = buildSessionTree([session('root'), ...Array.from({ length: 13 }, (_, index) => session(`child-${index}`, 'root'))]);
    const layout = layoutCollaborationTree(tree, new Set(['root']));
    const fitted = fitCollaborationTree(layout, 640);
    expect(fitted.outline).toBe(true);
    expect(fitted.width).toBeLessThanOrEqual(640);
    expect(fitted.nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(fitted.nodes.map(node => node.session.id)).toEqual(layout.nodes.map(node => node.session.id));
    expect(fitted.edges).toEqual(layout.edges);
    for (let index = 0; index < fitted.nodes.length; index++) {
      const node = fitted.nodes[index];
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x + 180).toBeLessThanOrEqual(fitted.width);
      if (index) expect(node.y).toBeGreaterThanOrEqual(fitted.nodes[index - 1].y + 82);
    }
    expect(layout.nodes[0].x).toBeGreaterThan(640);
    expect(fitCollaborationTree(layout, layout.width)).toEqual({ ...layout, outline: false });
  });

  it('keeps deep expanded branches within the available width', () => {
    const items = Array.from({ length: 25 }, (_, index) => session(`branch-${index}`, index ? `branch-${index - 1}` : undefined));
    items.push(session('sibling', 'branch-0'));
    const layout = layoutCollaborationTree(buildSessionTree(items), new Set(items.map(item => item.id)));
    const fitted = fitCollaborationTree(layout, 300);
    expect(fitted.outline).toBe(true);
    expect(fitted.nodes).toHaveLength(items.length);
    expect(Math.max(...fitted.nodes.map(node => node.x + 180))).toBeLessThanOrEqual(300);
    expect(fitted.edges).toEqual(layout.edges);
  });

  it('places leaves in stable columns, centers parents, and uses fixed node and gap sizes', () => {
    const tree = buildSessionTree([session('root'), session('a', 'root'), session('b', 'root'), session('aa', 'a'), session('ab', 'a')]);
    const layout = layoutCollaborationTree(tree, new Set(['root', 'a']));
    const byId = new Map(layout.nodes.map(node => [node.session.id, node]));
    expect(byId.get('aa')).toMatchObject({ x: 0, y: 304, depth: 2 });
    expect(byId.get('ab')).toMatchObject({ x: 204, y: 304, depth: 2 });
    expect(byId.get('a')).toMatchObject({ x: 102, y: 152, depth: 1 });
    expect(byId.get('b')).toMatchObject({ x: 408, y: 152, depth: 1 });
    expect(byId.get('root')).toMatchObject({ x: 255, y: 0, depth: 0 });
    expect(layout).toMatchObject({ width: 588, height: 386 });
    expect(layout.edges).toHaveLength(4);
  });

  it('treats collapsed parents as leaves and keeps all roots without overlapping', () => {
    const tree = buildSessionTree([session('r1'), session('child', 'r1'), session('grandchild', 'child'), session('r2')]);
    const layout = layoutCollaborationTree(tree, new Set(['r1']));
    expect(layout.nodes.map(node => node.session.id)).toEqual(['r1', 'child', 'r2']);
    expect(layout.nodes.map(node => node.x)).toEqual([0, 0, 204]);
    expect(layout.edges).toEqual([{ parentId: 'r1', childId: 'child' }]);
    expect(layout.width).toBe(384);
    expect(layoutCollaborationTree(buildSessionTree([]), new Set())).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it('handles self-parent, missing parents, cycles and deep branches without recursion', () => {
    const items = [session('a', 'b'), session('b', 'a'), session('orphan', 'missing'), session('self', 'self')];
    const expanded = new Set(items.map(item => item.id));
    const first = layoutCollaborationTree(buildSessionTree(items), expanded);
    const reversed = layoutCollaborationTree(buildSessionTree(items.slice().reverse()), expanded);
    expect(first.nodes.map(node => [node.session.id, node.x, node.y])).toEqual(reversed.nodes.map(node => [node.session.id, node.x, node.y]));
    expect(new Set(first.nodes.map(node => node.session.id)).size).toBe(4);
    expect(first.edges).toHaveLength(1);
    const deep = Array.from({ length: 3000 }, (_, index) => session(`s${index}`, index ? `s${index - 1}` : undefined));
    expect(layoutCollaborationTree(buildSessionTree(deep), new Set(deep.map(item => item.id))).nodes).toHaveLength(3000);
  });
});
