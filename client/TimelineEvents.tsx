import { useId, useState } from 'react';
import { BrainCircuit, FileJson2, Layers3, MessageSquareText } from 'lucide-react';
import type { TimelineEvent } from '../shared/types';
import { contextPresentation, type ContextGroup } from './event-presentation';
import { clock } from './format';
import { Markdown } from './Markdown';
import { eventViewState } from './event-view-state';
import { RecordRow } from './RecordRow';
import { recordSelectionKey, useRecordInspector, type RecordSelection } from './RecordInspector';
import './timeline-events.css';

export function EventRecord({ event, sessionId }: { event: TimelineEvent; sessionId: string }) {
  const { selection, inspect } = useRecordInspector();
  const context = event.kind === 'context';
  const reasoning = event.kind === 'reasoning';
  const presentation = context ? contextPresentation(event) : {
    label: reasoning ? '推理摘要' : '其他日志',
    preview: event.text.trim().split(/\r?\n/, 1)[0].replace(/^#{1,6}\s+/, '').slice(0, 160),
  };
  const record: RecordSelection = { kind: 'event', event, sessionId };
  return <div className={context ? 'context-source' : 'record-entry'} data-context-event-id={context ? event.id : undefined}>
    <RecordRow icon={context ? Layers3 : reasoning ? BrainCircuit : FileJson2} title={presentation.label}
      preview={presentation.preview || '此记录没有可显示的文本'} label={`查看${presentation.label}详情`}
      meta={context ? `${event.text.length.toLocaleString()} 字符` : <time dateTime={event.timestamp}>{clock(event.timestamp)}</time>}
      selected={!!selection && recordSelectionKey(selection) === recordSelectionKey(record)} onClick={() => inspect(record)} />
  </div>;
}

export function ContextEvents({ group, sessionId, preserveLayout }: {
  group: ContextGroup; sessionId: string; preserveLayout?: (change: () => void) => void;
}) {
  const stateKey = `context-group:${group.id}`;
  const [open, setOpen] = useState(() => eventViewState.get(sessionId, stateKey) ?? false);
  const bodyId = useId();
  const labels = [...new Set(group.events.map(event => contextPresentation(event).label))].filter(label => label !== '附带上下文');
  function toggle() {
    const change = () => { eventViewState.set(sessionId, stateKey, !open); setOpen(!open); };
    if (preserveLayout) preserveLayout(change); else change();
  }
  return <section className="record-group context-group" data-event-id={group.id} aria-label="附带上下文">
    <RecordRow icon={Layers3} title="附带上下文" preview={labels.join(' · ')} meta={`${group.events.length} 项`} expanded={open} controls={bodyId} onClick={toggle} />
    <div id={bodyId} className="record-group-entries" hidden={!open}>
      {open && group.events.map(event => <EventRecord key={event.id} event={event} sessionId={sessionId} />)}
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
