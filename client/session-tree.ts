import type { SessionList, SessionSummary } from '../shared/types';

export interface SessionTreeNode {
  session: SessionSummary;
  children: SessionTreeNode[];
}

export interface SessionTree {
  roots: SessionTreeNode[];
  byId: Map<string, SessionTreeNode>;
  parents: Map<string, string>;
}

/** Later sources are fresher; search matches survive a lightweight ancestor summary. */
export function mergeSessions(...sources: readonly SessionSummary[][]): SessionSummary[] {
  const sessions = new Map<string, SessionSummary>();
  for (const source of sources) for (const session of source) {
    const previous = sessions.get(session.id);
    sessions.set(session.id, previous?.match && !session.match ? { ...session, match: previous.match } : session);
  }
  return [...sessions.values()];
}

export function buildSessionTree(...sources: readonly SessionSummary[][]): SessionTree {
  const byId = new Map<string, SessionTreeNode>();
  for (const session of mergeSessions(...sources)) byId.set(session.id, { session, children: [] });
  const parents = new Map<string, string>();
  for (const { session } of byId.values()) {
    if (session.parentId && session.parentId !== session.id && byId.has(session.parentId)) parents.set(session.id, session.parentId);
  }

  // A broken/missing parent is a visible root. Break each cycle once, deterministically.
  const checked = new Set<string>();
  for (const id of byId.keys()) {
    const trail: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = id;
    while (current && !checked.has(current) && !positions.has(current)) {
      positions.set(current, trail.length);
      trail.push(current);
      current = parents.get(current);
    }
    if (current && positions.has(current)) {
      const cycle = trail.slice(positions.get(current));
      parents.delete(cycle.sort()[0]!);
    }
    for (const visited of trail) checked.add(visited);
  }

  const roots: SessionTreeNode[] = [];
  for (const [id, node] of byId) {
    const parent = parents.get(id);
    if (parent) byId.get(parent)!.children.push(node);
    else roots.push(node);
  }
  const newestFirst = (a: SessionTreeNode, b: SessionTreeNode) =>
    b.session.startedAt.localeCompare(a.session.startedAt) || b.session.updatedAt.localeCompare(a.session.updatedAt) || a.session.id.localeCompare(b.session.id);
  roots.sort(newestFirst);
  for (const node of byId.values()) node.children.sort(newestFirst);
  return { roots, byId, parents };
}

export function sessionAncestors(tree: SessionTree, id: string): string[] {
  const result: string[] = [];
  let parent = tree.parents.get(id);
  while (parent) {
    result.push(parent);
    parent = tree.parents.get(parent);
  }
  return result;
}

/** Keep cached descendants only while their parent still belongs to this result. */
export function visibleBranchSessions(base: SessionSummary[], branches: ReadonlyMap<string, { items: SessionSummary[] }>): SessionSummary[] {
  const known = new Map(base.map(session => [session.id, session]));
  const pending = new Map(branches);
  const result: SessionSummary[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [parentId, branch] of pending) {
      if (!known.has(parentId)) continue;
      pending.delete(parentId);
      if (known.get(parentId)?.childCount === 0) continue;
      for (const session of branch.items) {
        if (session.parentId !== parentId) continue;
        result.push(session);
        if (!known.has(session.id)) known.set(session.id, session);
      }
      changed = true;
    }
  }
  return result;
}

export function sidebarSessionTree(data: SessionList | null, branches: ReadonlyMap<string, { items: SessionSummary[] }>, filtering: boolean): SessionTree {
  const base = mergeSessions(data?.ancestors ?? [], data?.items ?? [], !filtering && data?.selected ? [data.selected] : []);
  return buildSessionTree(filtering ? [] : visibleBranchSessions(base, branches), base);
}
