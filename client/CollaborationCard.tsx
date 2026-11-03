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

  return <details className="collaboration-card group/collaboration my-3 min-w-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--text)]" onToggle={event => {
    setOpen(event.currentTarget.open);
    if (!event.currentTarget.open) setRawOpen(false);
  }}>
    <summary className="grid min-h-[68px] min-w-0 cursor-pointer list-none grid-cols-[14px_16px_minmax(0,1fr)_auto] grid-rows-[auto_auto] items-center gap-x-2 gap-y-0.5 px-3 py-2.5 hover:bg-[var(--hover)] focus-visible:rounded-md focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-[var(--accent)] sm:flex sm:gap-2.5">
      <ChevronRight size={14} className="collaboration-chevron row-span-2 text-[var(--muted)] group-open/collaboration:rotate-90" />
      <UsersRound size={16} className="collaboration-icon row-span-2 text-[var(--muted)]" />
      <span className="collaboration-sender col-start-3 row-span-2 flex min-w-0 flex-1 flex-col gap-0.5"><strong className="truncate text-[14px] leading-5 font-semibold">{sender}</strong><small className="truncate font-mono text-[12px] leading-[18px] text-[var(--muted)]" title={message.sender}>{message.sender}</small></span>
      <span className={`collaboration-badge col-start-4 row-start-1 self-end rounded border px-1.5 py-0.5 text-[12px] leading-4 whitespace-nowrap sm:self-auto ${message.messageType === 'FINAL_ANSWER' ? 'final border-transparent bg-[var(--accent-light)] text-[var(--accent-strong)]' : 'border-[var(--border)] text-[var(--soft)]'}`}>{label}</span>
      <time className="col-start-4 row-start-2 self-start text-right text-[12px] leading-4 whitespace-nowrap text-[var(--muted)] tabular-nums sm:self-auto" dateTime={event.timestamp}>{clock(event.timestamp)}</time>
    </summary>
    {open && <div className="collaboration-body border-t border-[var(--border)] p-3 text-[14px] leading-[1.8] [overflow-wrap:anywhere] sm:p-4">
      <div className="collaboration-recipient mb-3 flex items-baseline gap-2 text-[12px] text-[var(--muted)]"><span>接收任务</span><code className="font-mono text-[12px] [overflow-wrap:anywhere]">{message.taskName}</code></div>
      {message.payload.trim() ? <Markdown text={message.payload} /> : <p className="collaboration-empty m-0 text-[14px] text-[var(--muted)]">这条日志未记录正文。</p>}
      <details className="collaboration-raw mt-4 text-[12px] text-[var(--muted)]" onToggle={event => setRawOpen(event.currentTarget.open)}>
        <summary className="min-h-11 cursor-pointer py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">查看原始日志消息</summary>
        {rawOpen && <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-[var(--border)] bg-[var(--code)] p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-[var(--soft)] [overflow-wrap:anywhere]">{event.text}</pre>}
      </details>
    </div>}
  </details>;
}
