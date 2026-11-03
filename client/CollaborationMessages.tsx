import { useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, ChevronDown, Repeat2 } from 'lucide-react';
import type { CollaborationRecord } from './collaboration-data';
import { messageDirection, messageKey, messageTypeLabel, participantLabel } from './collaboration-message';
import { clock, dateGroup } from './format';

type Navigate = (sessionId: string, turnId: string) => void;
type Filter = 'all' | 'received' | 'sent';

function MessageCard({ message, selectedId, labels, onNavigate }: {
  message: CollaborationRecord; selectedId?: string; labels: ReadonlyMap<string, string>; onNavigate: Navigate;
}) {
  const direction = messageDirection(message, selectedId);
  const sender = participantLabel(message.senderId, message.sender, labels);
  const recipient = participantLabel(message.recipientId, message.taskName, labels);
  const route = direction === 'received' ? `来自 ${sender}` : direction === 'sent' ? `发给 ${recipient}` : direction === 'self' ? '发给自己' : `${sender} → ${recipient}`;
  const DirectionIcon = direction === 'received' ? ArrowDownLeft : direction === 'sent' ? ArrowUpRight : direction === 'self' ? Repeat2 : ArrowRight;
  return <article className={`collab-message ${direction}`}>
    <details className="collab-message-disclosure">
      <summary>
        <span className="collab-message-heading"><strong title={route}><DirectionIcon size={14} aria-hidden="true" />{route}</strong><time dateTime={message.timestamp || undefined} title={message.timestamp || undefined}>{message.timestamp ? `${dateGroup(message.timestamp)} ${clock(message.timestamp)}` : '时间未记录'}</time></span>
        <span className="collab-message-preview">{message.preview || '这条消息未记录正文。'}</span>
        <span className="collab-message-meta"><span>{messageTypeLabel(message.messageType, direction)}</span><span className="collab-preview-toggle"><span className="when-closed">展开预览</span><span className="when-open">收起预览</span><ChevronDown size={12} aria-hidden="true" /></span></span>
      </summary>
      <dl className="collab-message-paths"><dt>发送者</dt><dd>{message.sender || '未记录'}{!message.senderId && '（未关联）'}</dd><dt>接收任务</dt><dd>{message.taskName || '未记录'}{!message.recipientId && '（未关联）'}</dd></dl>
      {(message.preview.length >= 200 || message.preview.endsWith('…')) && <p className="collab-preview-note">此处仅为日志预览，完整内容请查看原文。</p>}
    </details>
    <button type="button" className="text-button collab-view-source" onClick={() => onNavigate(message.sessionId, message.turnId)}>查看原文<ArrowUpRight size={12} aria-hidden="true" /></button>
  </article>;
}

export function CollaborationMessages({ messages, selectedId, labels, focused = [], onClearFocus, onNavigate, emptyText }: {
  messages: CollaborationRecord[]; selectedId?: string; labels: ReadonlyMap<string, string>; focused?: CollaborationRecord[];
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
    {selectedId && <>
      <h4 className="collab-message-title"><span>{focusing ? '时间轴选中的消息' : `${labels.get(selectedId) || '所选代理'} 的消息`}</span><small>{focusing ? focused.length : messages.length} 条已载入</small></h4>
      {focusing ? <div className="collab-message-focus-bar" role="status"><span>已定位 {focused.length} 条消息</span><button type="button" className="text-button" onClick={() => { setFilter('all'); setVisibleCount(8); onClearFocus?.(); }}>返回全部消息</button></div> : <div className="collab-message-filters" aria-label="消息方向">{([['all', '全部', messages.length], ['received', '收到', received.length], ['sent', '发出', sent.length]] as const).map(([id, label, count]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => { setFilter(id); setVisibleCount(8); }}>{label}<span>{count}</span></button>)}</div>}
    </>}
    {start > 0 && <button className="text-button collab-earlier-messages" type="button" onClick={() => setVisibleCount(count => count + 12)}>显示更早消息（还有 {start} 条）</button>}
    {filtered.length === 0 && <p className="collab-empty">{filter === 'all' ? emptyText || '没有可展示的消息。' : `已载入记录中没有${filter === 'received' ? '收到' : '发出'}的消息。`}</p>}
    <ol className="collab-messages">{filtered.slice(start).map(message => <li key={messageKey(message)} className={focusing ? 'highlighted' : undefined} data-message-key={messageKey(message)}><MessageCard message={message} selectedId={selectedId} labels={labels} onNavigate={onNavigate} /></li>)}</ol>
  </section>;
}
