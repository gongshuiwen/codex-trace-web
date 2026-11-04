import type { SessionActivity, SessionDetail, SessionSummary, TurnSummary } from '../shared/types';
import { buildSessionTree, type SessionTree, type SessionTreeNode } from './session-tree';

export interface CollaborationEntry {
  detail: SessionDetail;
  activity: SessionActivity;
}

export type CollaborationRecord = SessionActivity['messages'][number] & {
  sessionId: string;
  senderId?: string;
  recipientId?: string;
};

const canonicalPath = (value: string | undefined): value is string => !!value && /^\/root(?:\/[A-Za-z0-9_-]+)*$/.test(value);

/** A nickname can be copied into agentName by the parser; that alone is not path evidence. */
function recordedPath(session: SessionSummary): string | undefined {
  return canonicalPath(session.agentName) && session.agentName !== session.agentNickname ? session.agentName : undefined;
}

function sessionScopes(tree: SessionTree): Map<string, string> {
  const result = new Map<string, string>();
  const pending = tree.roots.map(root => ({ node: root, scope: root.session.id }));
  while (pending.length) {
    const { node, scope } = pending.pop()!;
    result.set(node.session.id, scope);
    for (const child of node.children) pending.push({ node: child, scope });
  }
  return result;
}

/**
 * Resolve only exact, unique task paths within the same recorded session tree.
 * An unnamed root becomes /root only when its direct /root/child has a matching
 * NEW_TASK envelope from /root in the root's or that child's own log. Missing parents, nicknames,
 * display titles and path suffixes never establish an identity.
 *
 * Mirror removal is deliberately conservative: same tree, timestamp, route, type
 * and complete preview, across different logs only. Repeated records in one log
 * retain their multiplicity. Unknown timestamps and truncated previews stay separate.
 */
export function collectCollaborationMessages(entries: readonly CollaborationEntry[], sessions: readonly SessionSummary[]): CollaborationRecord[] {
  const tree = buildSessionTree([...sessions], entries.map(entry => entry.detail.session));
  const scopes = sessionScopes(tree);
  const paths = new Map<string, string>();
  for (const { session } of tree.byId.values()) {
    const path = recordedPath(session);
    if (path) paths.set(session.id, path);
  }
  for (const root of tree.roots) {
    const parent = root.session;
    if (parent.parentId || parent.agentName) continue;
    for (const child of root.children) {
      const path = paths.get(child.session.id);
      if (!path || !/^\/root\/[A-Za-z0-9_-]+$/.test(path)) continue;
      const evidence = entries.some(({ detail, activity }) => (detail.session.id === parent.id || detail.session.id === child.session.id)
        && activity.messages.some(message => message.messageType === 'NEW_TASK' && message.sender === '/root' && message.taskName === path));
      if (evidence) { paths.set(parent.id, '/root'); break; }
    }
  }
  const owners = new Map<string, Set<string>>();
  for (const [id, path] of paths) {
    const key = JSON.stringify([scopes.get(id), path]);
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key)!.add(id);
  }
  const resolve = (scope: string | undefined, path: string): string | undefined => {
    if (!canonicalPath(path)) return undefined;
    const matches = owners.get(JSON.stringify([scope, path]));
    return matches?.size === 1 ? matches.values().next().value : undefined;
  };
  const results: { record: CollaborationRecord; validSource: boolean; order: number }[] = [];
  const mirrorGroups = new Map<string, { slots: number[]; occurrences: Map<string, number> }>();
  const seenEvents = new Set<string>();
  for (const { detail, activity } of entries) {
    const sessionId = detail.session.id;
    const turns = new Set(detail.turns.map(turn => turn.id));
    const scope = scopes.get(sessionId);
    for (const message of activity.messages) {
      const eventKey = JSON.stringify([sessionId, message.id]);
      if (seenEvents.has(eventKey)) continue;
      seenEvents.add(eventKey);
      const record: CollaborationRecord = { ...message, sessionId,
        senderId: resolve(scope, message.sender), recipientId: resolve(scope, message.taskName) };
      const validSource = turns.has(message.turnId);
      const timestamp = Date.parse(message.timestamp);
      let slot: number | undefined;
      if (Number.isFinite(timestamp) && message.preview.length < 200 && !message.preview.endsWith('…')) {
        const key = JSON.stringify([scope, timestamp, message.messageType, message.sender, message.taskName, message.preview]);
        let group = mirrorGroups.get(key);
        if (!group) { group = { slots: [], occurrences: new Map() }; mirrorGroups.set(key, group); }
        const occurrence = group.occurrences.get(sessionId) ?? 0;
        group.occurrences.set(sessionId, occurrence + 1);
        slot = group.slots[occurrence];
        if (slot === undefined) group.slots.push(results.length);
      }
      if (slot === undefined) results.push({ record, validSource, order: results.length });
      else {
        const previous = results[slot];
        if ((!previous.validSource && validSource)
          || (previous.validSource === validSource && sessionId === record.recipientId && previous.record.sessionId !== record.recipientId)) {
          results[slot] = { record, validSource, order: previous.order };
        }
      }
    }
  }
  return results.sort((a, b) => {
    const first = Date.parse(a.record.timestamp);
    const second = Date.parse(b.record.timestamp);
    if (Number.isFinite(first) && Number.isFinite(second)) return first - second || a.order - b.order;
    if (Number.isFinite(first)) return -1;
    if (Number.isFinite(second)) return 1;
    return a.order - b.order;
  }).map(({ record }) => record);
}

/** Each segment is a recorded round of that session, never an inferred lifetime. */
export function collaborationRounds(entries: readonly CollaborationEntry[]): { sessionId: string; turn: TurnSummary }[] {
  const rounds = new Map<string, { sessionId: string; turn: TurnSummary }>();
  for (const { detail } of entries) for (const turn of detail.turns) {
    const sessionId = detail.session.id;
    rounds.set(JSON.stringify([sessionId, turn.id]), { sessionId, turn });
  }
  return [...rounds.values()];
}

export const COLLABORATION_NODE_WIDTH = 180;
export const COLLABORATION_NODE_HEIGHT = 82;
const horizontalStep = COLLABORATION_NODE_WIDTH + 24;
const verticalStep = COLLABORATION_NODE_HEIGHT + 70;

export interface CollaborationTreeLayout {
  /** Coordinates are the node's top-left corner. */
  nodes: { session: SessionSummary; x: number; y: number; depth: number }[];
  edges: { parentId: string; childId: string }[];
  width: number;
  height: number;
}

export function layoutCollaborationTree(tree: SessionTree, expanded: ReadonlySet<string>): CollaborationTreeLayout {
  // Reuse the tree builder's deterministic cycle handling even for a caller-built tree.
  const safe = buildSessionTree([...tree.byId.values()].map(node => node.session));
  const nodes: CollaborationTreeLayout['nodes'] = [];
  const edges: CollaborationTreeLayout['edges'] = [];
  const positions = new Map<string, CollaborationTreeLayout['nodes'][number]>();
  const pending: { node: SessionTreeNode; depth: number; placed: boolean }[] = safe.roots.slice().reverse().map(node => ({ node, depth: 0, placed: false }));
  let leaf = 0;
  let width = 0;
  let height = 0;
  while (pending.length) {
    const { node, depth, placed } = pending.pop()!;
    const children = expanded.has(node.session.id) ? node.children : [];
    if (!placed) {
      const position = { session: node.session, x: 0, y: depth * verticalStep, depth };
      nodes.push(position);
      positions.set(node.session.id, position);
      pending.push({ node, depth, placed: true });
      for (const child of children.slice().reverse()) pending.push({ node: child, depth: depth + 1, placed: false });
      for (const child of children) edges.push({ parentId: node.session.id, childId: child.session.id });
    } else {
      const position = positions.get(node.session.id)!;
      position.x = children.length
        ? (positions.get(children[0].session.id)!.x + positions.get(children.at(-1)!.session.id)!.x) / 2
        : leaf++ * horizontalStep;
      width = Math.max(width, position.x + COLLABORATION_NODE_WIDTH);
      height = Math.max(height, position.y + COLLABORATION_NODE_HEIGHT);
    }
  }
  return { nodes, edges, width, height };
}

/** Keep wide trees readable by stacking nodes in preorder, with depth as indentation. */
export function fitCollaborationTree(layout: CollaborationTreeLayout, availableWidth: number): CollaborationTreeLayout & { outline: boolean } {
  if (!availableWidth || layout.width <= availableWidth) return { ...layout, outline: false };
  const depth = Math.max(0, ...layout.nodes.map(node => node.depth));
  const indent = depth ? Math.min(horizontalStep, Math.max(0, availableWidth - COLLABORATION_NODE_WIDTH - 32) / depth) : 0;
  const nodes = layout.nodes.map((node, index) => ({ ...node, x: node.depth * indent, y: index * (COLLABORATION_NODE_HEIGHT + 46) }));
  return { nodes, edges: layout.edges, width: depth * indent + COLLABORATION_NODE_WIDTH + 32,
    height: nodes.length ? nodes.at(-1)!.y + COLLABORATION_NODE_HEIGHT : 0, outline: true };
}
