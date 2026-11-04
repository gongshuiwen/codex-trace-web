import { useEffect, useRef, useState } from 'react';
import { CollaborationMessageCard } from './CollaborationCard';
import type { CollaborationRecord } from './collaboration-data';
import { messageDirection, messageKey } from './collaboration-message';


type Navigate = (sessionId: string, turnId: string) => void;
type Filter = 'all' | 'received' | 'sent';

export function CollaborationMessages({ messages, selectedId, labels, revisions, focused = [], onClearFocus, onNavigate, emptyText }: {
  messages: CollaborationRecord[]; selectedId?: string; labels: ReadonlyMap<string, string>; revisions: ReadonlyMap<string, string>; focused?: CollaborationRecord[];
  onClearFocus?: () => void; onNavigate: Navigate; emptyText?: string;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [visibleCount, setVisibleCount] = useState(8);
  const sectionRef = useRef<HTMLElement>(null);
  const focusing = focused.length > 0;
  const received = messages.filter(message => messageDirection(message, selectedId) === 'received');
  const sent = messages.filter(message => messageDirection(message, selectedId) === 'sent');
  const filtered = focusing ? focused : filter === 'received' ? received : filter === 'sent' ? sent : messages;
  // Timeline selections always remain visible, including messages outside the latest page.
  const start = focusing ? 0 : Math.max(0, filtered.length - visibleCount);
  useEffect(() => {
    if (focused.length) sectionRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  return <section className="collab-message-feed" ref={sectionRef} aria-label={selectedId ? '代理协作消息' : '未关联消息列表'}>
    {selectedId && (messages.length > 0 || focusing) && <>
      <h4 className="collab-message-title">消息</h4>
      {focusing ? <div className="collab-message-focus-bar" role="status"><span>已定位 {focused.length} 条消息</span><button type="button" className="text-button" onClick={() => { setFilter('all'); setVisibleCount(8); onClearFocus?.(); }}>返回全部消息</button></div> : <div className="collab-message-filters" aria-label="消息方向">{([['all', '全部', messages.length], ['received', '收到', received.length], ['sent', '发出', sent.length]] as const).map(([id, label, count]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => { setFilter(id); setVisibleCount(8); }}>{label}<span>{count}</span></button>)}</div>}
    </>}
    {start > 0 && <button className="text-button collab-earlier-messages" type="button" onClick={() => setVisibleCount(count => count + 12)}>显示更早消息（还有 {start} 条）</button>}
    {filtered.length === 0 && <p className="collab-empty">{!messages.length || filter === 'all' ? emptyText || '没有可展示的消息。' : `已载入记录中没有${filter === 'received' ? '收到' : '发出'}的消息。`}</p>}
    {filtered.length > 0 && <ol className="collab-messages">{filtered.slice(start).map(message => <li key={messageKey(message)} className={focusing ? 'highlighted' : undefined} data-message-key={messageKey(message)}><CollaborationMessageCard message={message} labels={labels} revision={revisions.get(message.sessionId)} showDate onNavigate={() => onNavigate(message.sessionId, message.turnId)} /></li>)}</ol>}
  </section>;
}
