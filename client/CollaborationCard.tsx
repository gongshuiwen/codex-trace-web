import { UsersRound } from 'lucide-react';
import type { TimelineEvent } from '../shared/types';
import type { CollaborationRecord } from './collaboration-data';
import type { CollaborationDetail } from './collaboration-detail';
import { messageRoute, messageTypeLabel } from './collaboration-message';
import { clock, dateGroup } from './format';
import { RecordRow } from './RecordRow';
import { recordSelectionKey, useRecordInspector, type RecordSelection } from './RecordInspector';

const emptyLabels: ReadonlyMap<string, string> = new Map();

export function CollaborationMessageCard({ message, labels, content, revision = '', showDate = false, onNavigate }: {
  message: CollaborationRecord; labels: ReadonlyMap<string, string>; content?: CollaborationDetail; revision?: string;
  showDate?: boolean; onNavigate?: () => void;
}) {
  const { selection, inspect } = useRecordInspector();
  const record: RecordSelection = { kind: 'message', message, labels, content, revision, onNavigate };
  const preview = message.preview.replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();
  const hasTime = !!message.timestamp && Number.isFinite(Date.parse(message.timestamp));
  return <article className="record-entry" data-collaboration-id={message.id} data-source-session-id={message.sessionId}>
    <RecordRow icon={UsersRound} title={messageRoute(message, labels)} preview={preview || '这条消息未记录正文。'}
      label={`查看子代理消息：${messageRoute(message, labels)}`}
      meta={<><span className="record-badge">{messageTypeLabel(message.messageType, 'unknown')}</span><time dateTime={hasTime ? message.timestamp : undefined}>{hasTime ? `${showDate ? `${dateGroup(message.timestamp)} ` : ''}${clock(message.timestamp)}` : '时间未记录'}</time></>}
      selected={!!selection && recordSelectionKey(selection) === recordSelectionKey(record)} onClick={() => inspect(record)} />
  </article>;
}

export function CollaborationCard({ event, sessionId, turnId, revision, record, labels = emptyLabels }: {
  event: TimelineEvent; sessionId: string; turnId: string; revision: string; record?: CollaborationRecord; labels?: ReadonlyMap<string, string>;
}) {
  const message = event.collaboration;
  if (!message) return null;
  const source = record ?? { ...message, id: event.id, sessionId, turnId, timestamp: event.timestamp, preview: message.payload.slice(0, 400) };
  return <CollaborationMessageCard message={source} labels={labels} revision={revision} content={{ payload: message.payload, raw: event.text }} />;
}
