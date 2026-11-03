import type { SessionSummary } from '../shared/types';
import type { CollaborationRecord } from './collaboration-data';
import { sessionDisplayName } from './format';

export type MessageDirection = 'received' | 'sent' | 'self' | 'unknown';

export function messageKey(message: Pick<CollaborationRecord, 'sessionId' | 'id'>): string {
  return JSON.stringify([message.sessionId, message.id]);
}

export function messageDirection(message: Pick<CollaborationRecord, 'senderId' | 'recipientId'>, selectedId?: string): MessageDirection {
  if (!selectedId) return 'unknown';
  const sender = message.senderId === selectedId;
  const recipient = message.recipientId === selectedId;
  return sender && recipient ? 'self' : recipient ? 'received' : sender ? 'sent' : 'unknown';
}

export function messageTypeLabel(messageType: CollaborationRecord['messageType'], direction: MessageDirection): string {
  if (messageType === 'MESSAGE') return '协作消息';
  if (messageType === 'NEW_TASK') return direction === 'received' ? '收到任务' : direction === 'sent' ? '派发任务' : '任务分派';
  return direction === 'received' ? '收到结果' : direction === 'sent' ? '提交结果' : '结果汇报';
}

function taskPath(value: string | undefined): string | undefined {
  return value && /^\/root(?:\/[A-Za-z0-9_-]+)*$/.test(value) ? value : undefined;
}

/** Names label already identified sessions; they never establish a message identity. */
export function createParticipantLabels(sessions: readonly SessionSummary[]): ReadonlyMap<string, string> {
  const participants = [...new Map(sessions.map(session => [session.id, session])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const groups = new Map<string, SessionSummary[]>();
  for (const session of participants) {
    const name = session.parentId ? sessionDisplayName(session) : '主代理';
    groups.set(name, [...(groups.get(name) ?? []), session]);
  }
  const labels = new Map<string, string>();
  const used = new Set<string>();
  for (const [name, group] of groups) if (group.length === 1) {
    labels.set(group[0].id, name); used.add(name);
  }
  for (const [name, group] of groups) if (group.length > 1) for (const session of group) {
    const path = taskPath(session.agentName);
    const segments = path?.split('/').filter(Boolean) ?? [];
    let label: string | undefined;
    for (let length = 1; length <= segments.length; length++) {
      const suffix = segments.slice(-length).join('/');
      if (!used.has(suffix) && group.every(other => other.id === session.id || !taskPath(other.agentName)?.endsWith(`/${suffix}`))) {
        label = suffix; break;
      }
    }
    if (!label) {
      let length = Math.min(8, session.id.length);
      while (length < session.id.length && participants.some(other => other.id !== session.id && other.id.slice(0, length) === session.id.slice(0, length))) length++;
      label = `${name} · ${session.id.slice(0, length)}`;
      while (used.has(label)) label += ` · ${session.id}`;
    }
    labels.set(session.id, label); used.add(label);
  }
  return labels;
}

export function participantLabel(id: string | undefined, path: string, labels: ReadonlyMap<string, string>): string {
  const confirmed = id ? labels.get(id) : undefined;
  if (confirmed) return confirmed;
  const original = path.trim();
  if (!original) return '未记录';
  const name = taskPath(original) ? original.split('/').at(-1)! : original;
  return `${name}（未关联）`;
}
