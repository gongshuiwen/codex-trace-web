import { useState } from 'react';
import { ChevronRight, UsersRound } from 'lucide-react';
import type { TimelineEvent } from '../shared/types';
import { clock, collaborationTypeLabels } from './format';
import { Markdown } from './Markdown';
import './collaboration.css';

export function CollaborationCard({ event }: { event: TimelineEvent }) {
  const [open, setOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const message = event.collaboration;
  if (!message) return null;
  const sender = message.sender.split('/').filter(Boolean).at(-1) || message.sender;
  const label = collaborationTypeLabels[message.messageType];

  return <details className="collaboration-card" onToggle={event => {
    setOpen(event.currentTarget.open);
    if (!event.currentTarget.open) setRawOpen(false);
  }}>
    <summary>
      <ChevronRight size={14} className="collaboration-chevron" />
      <UsersRound size={16} className="collaboration-icon" />
      <span className="collaboration-sender"><strong>{sender}</strong><small>{message.sender}</small></span>
      <span className={`collaboration-badge ${message.messageType === 'FINAL_ANSWER' ? 'final' : ''}`}>{label}</span>
      <time dateTime={event.timestamp}>{clock(event.timestamp)}</time>
    </summary>
    {open && <div className="collaboration-body">
      <div className="collaboration-recipient"><span>接收任务</span><code>{message.taskName}</code></div>
      {message.payload.trim() ? <Markdown text={message.payload} /> : <p className="collaboration-empty">这条日志未记录正文。</p>}
      <details className="collaboration-raw" onToggle={event => setRawOpen(event.currentTarget.open)}>
        <summary>查看原始日志消息</summary>
        {rawOpen && <pre>{event.text}</pre>}
      </details>
    </div>}
  </details>;
}
