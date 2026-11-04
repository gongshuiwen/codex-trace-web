import type { SessionActivity, SessionDetail, TimelineEvent } from '../shared/types';
import { collectCollaborationMessages, type CollaborationRecord } from './collaboration-data';
import { createParticipantLabels } from './collaboration-message';

/** Resolve timeline endpoints with the same exact-path and tree evidence as the collaboration view. */
export function buildTimelineCollaboration(events: readonly TimelineEvent[], session: SessionDetail, turnId: string): {
  labels: ReadonlyMap<string, string>;
  records: ReadonlyMap<string, CollaborationRecord>;
} {
  const participants = [session.session, ...session.children, ...(session.parent ? [session.parent] : [])];
  const activity: SessionActivity = {
    requests: [], compactions: [], warnings: [],
    messages: events.flatMap(event => {
      const message = event.kind === 'collaboration' ? event.collaboration : undefined;
      if (!message) return [];
      const preview = message.payload.length > 200 ? `${message.payload.slice(0, 199).replace(/[\uD800-\uDBFF]$/, '')}…` : message.payload;
      return [{ id: event.id, turnId, timestamp: event.timestamp, messageType: message.messageType,
        sender: message.sender, taskName: message.taskName, preview }];
    }),
  };
  const records = collectCollaborationMessages([{ detail: session, activity }], participants);
  return {
    labels: createParticipantLabels(participants),
    records: new Map(records.map(record => [record.id, record])),
  };
}
