import { useId, useState } from 'react';
import { BrainCircuit, ChevronDown, ChevronRight, FileJson2, Layers3, MessageSquareText } from 'lucide-react';
import type { TimelineEvent } from '../shared/types';
import { contextPresentation, type ContextGroup } from './event-presentation';
import { clock } from './format';
import { Markdown } from './Markdown';
import { eventViewState } from './event-view-state';
import './timeline-events.css';

type LayoutChange = { preserveLayout?: (change: () => void) => void };

function useDisclosure(sessionId: string, eventId: string, preserveLayout: LayoutChange['preserveLayout']) {
  const [open, setOpen] = useState(() => eventViewState.get(sessionId, eventId) ?? false);
  const bodyId = useId();
  function toggle() {
    const change = () => {
      const next = !open;
      eventViewState.set(sessionId, eventId, next); setOpen(next);
    };
    if (preserveLayout) preserveLayout(change); else change();
  }
  return { open, bodyId, toggle };
}

function ContextSource({ event, sessionId, preserveLayout }: { event: TimelineEvent; sessionId: string } & LayoutChange) {
  const { open, bodyId, toggle } = useDisclosure(sessionId, `context-source:${event.id}`, preserveLayout);
  const { label, preview } = contextPresentation(event);
  const showLabel = label !== '附带上下文';
  return <div className="context-source" data-context-event-id={event.id}>
    <button type="button" className={`context-source-toggle${showLabel ? '' : ' context-source-toggle-unlabeled'}`} aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
      {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
      {showLabel && <span className="context-source-label">{label}</span>}
      <span className="event-character-count">{event.text.length.toLocaleString()} 字符</span>
      <span className="context-source-preview">{preview || '此上下文没有可显示的文本'}</span>
    </button>
    <div id={bodyId} hidden={!open}>
      {open && <pre className="event-raw" tabIndex={0} aria-label={`${label}原文`}>{event.text || '此上下文没有可显示的文本'}</pre>}
    </div>
  </div>;
}

export function ContextEvents({ group, sessionId, preserveLayout }: { group: ContextGroup; sessionId: string } & LayoutChange) {
  const { open, bodyId, toggle } = useDisclosure(sessionId, `context-group:${group.id}`, preserveLayout);
  const labels = [...new Set(group.events.map(event => contextPresentation(event).label))].filter(label => label !== '附带上下文');
  return <section className="context-group" data-event-id={group.id} aria-label="附带上下文">
    <button type="button" className="event-disclosure-toggle context-group-toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
      {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      <Layers3 size={15} aria-hidden="true" />
      <span className="event-disclosure-title">附带上下文</span>
      {labels.length > 0 && <span className="context-group-sources">{labels.join(' · ')}</span>}
      <span className="context-group-count">{group.events.length} 项</span>
    </button>
    <div id={bodyId} className="context-group-body" hidden={!open}>
      {open && group.events.map(event => <ContextSource key={event.id} event={event} sessionId={sessionId} preserveLayout={preserveLayout} />)}
    </div>
  </section>;
}

export function EventDisclosure({ event, sessionId, preserveLayout }: { event: TimelineEvent; sessionId: string } & LayoutChange) {
  const { open, bodyId, toggle } = useDisclosure(sessionId, `disclosure:${event.id}`, preserveLayout);
  const reasoning = event.kind === 'reasoning';
  const Icon = reasoning ? BrainCircuit : FileJson2;
  const label = reasoning ? '推理摘要' : '其他日志';
  const firstLine = event.text.trim().split(/\r?\n/, 1)[0] || '';
  const preview = (reasoning ? firstLine.replace(/^#{1,6}\s+/, '') : firstLine).slice(0, 100);
  return <section className={`event-disclosure ${reasoning ? 'reasoning-event' : 'log-event'}`} aria-label={label}>
    <button type="button" className="event-disclosure-toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
      {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      <Icon size={15} aria-hidden="true" />
      <span className="event-disclosure-title">{label}</span>
      <time className="event-time" dateTime={event.timestamp}>{clock(event.timestamp)}</time>
    </button>
    {!open && preview && <p className="event-disclosure-preview">{preview}</p>}
    <div id={bodyId} className="event-disclosure-body" hidden={!open}>
      {open && (reasoning
        ? <Markdown text={event.text || '日志没有记录可显示的推理摘要'} />
        : <pre className="event-raw" tabIndex={0} aria-label="其他日志原文">{event.text || '此日志没有可显示的文本'}</pre>)}
    </div>
  </section>;
}

export function FinalAnswer({ event }: { event: TimelineEvent }) {
  return <section className="assistant-event final-answer" aria-label="最终答复">
    <div className="event-content-heading">
      <MessageSquareText size={16} aria-hidden="true" /><h3>最终答复</h3>
      <time className="event-time" dateTime={event.timestamp}>{clock(event.timestamp)}</time>
    </div>
    <Markdown text={event.text} />
  </section>;
}
