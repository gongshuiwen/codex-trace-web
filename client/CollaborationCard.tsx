import { useEffect, useId, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight, LoaderCircle, UsersRound } from 'lucide-react';
import type { TimelineEvent } from '../shared/types';
import type { CollaborationRecord } from './collaboration-data';
import { messageRoute, messageTypeLabel } from './collaboration-message';
import { loadCollaborationDetail } from './collaboration-detail';
import { errorMessage, isAbort } from './api';
import { clock, dateGroup } from './format';
import { Markdown } from './Markdown';
import { eventViewState } from './event-view-state';
import './collaboration.css';

interface MessageContent { payload: string; raw: string }
const emptyLabels: ReadonlyMap<string, string> = new Map();

export function CollaborationMessageCard({ message, labels, content, revision = '', showDate = false, preserveLayout, onNavigate }: {
  message: CollaborationRecord; labels: ReadonlyMap<string, string>; content?: MessageContent; revision?: string; showDate?: boolean;
  preserveLayout?: (change: () => void) => void; onNavigate?: () => void;
}) {
  const stateKey = `collaboration:${message.id}`;
  const [open, setOpen] = useState(() => eventViewState.get(message.sessionId, stateKey) ?? false);
  const [rawOpen, setRawOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; data?: MessageContent; error?: string } | null>(null);
  const bodyId = useId();
  const loadKey = JSON.stringify([message.sessionId, message.turnId, message.id, revision, message.messageType, message.sender, message.taskName, retry]);
  const current = loaded?.key === loadKey ? loaded : null;
  const body = content ?? current?.data;
  const loading = open && !body && !current?.error;
  const route = messageRoute(message, labels);
  const result = message.messageType === 'FINAL_ANSWER';
  const preview = message.preview.replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();
  const hasTime = !!message.timestamp && Number.isFinite(Date.parse(message.timestamp));

  useEffect(() => {
    if (!open || content) return;
    const controller = new AbortController();
    loadCollaborationDetail(message, revision, controller.signal).then(data => {
      if (!controller.signal.aborted) setLoaded({ key: loadKey, data });
    }).catch(error => {
      if (!controller.signal.aborted && !isAbort(error)) setLoaded({ key: loadKey, error: errorMessage(error) });
    });
    return () => controller.abort();
  }, [open, content, loadKey, message.sessionId, message.turnId, message.id, message.messageType, message.sender, message.taskName, revision]);

  function toggle() {
    const change = () => {
      const next = !open;
      eventViewState.set(message.sessionId, stateKey, next); setOpen(next);
      if (!next) setRawOpen(false);
    };
    if (preserveLayout) preserveLayout(change); else change();
  }
  function toggleRaw() {
    const change = () => setRawOpen(value => !value);
    if (preserveLayout) preserveLayout(change); else change();
  }

  return <article className={`collaboration-card ${result ? 'collaboration-result' : ''}`} data-collaboration-id={message.id} data-source-session-id={message.sessionId}>
    <button type="button" className="collaboration-toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
      <span className="collaboration-heading">
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <UsersRound size={16} aria-hidden="true" />
        <strong className="collaboration-route" title={`${message.sender} → ${message.taskName}`}>{route}</strong>
        <span className="collaboration-badge">{messageTypeLabel(message.messageType, 'unknown')}</span>
      </span>
      {!open && <span className="collaboration-preview">{preview || '这条消息未记录正文。'}</span>}
      <span className="collaboration-toggle-footer"><span>{open ? '收起全文' : '展开全文'}</span><time dateTime={hasTime ? message.timestamp : undefined} title={message.timestamp || undefined}>{hasTime ? `${showDate ? `${dateGroup(message.timestamp)} ` : ''}${clock(message.timestamp)}` : '时间未记录'}</time></span>
    </button>
    <div id={bodyId} className="collaboration-body" hidden={!open} aria-busy={loading || undefined}>
      {open && <>
        {loading && <p className="collaboration-loading" role="status"><LoaderCircle size={14} className="spin" />正在读取完整消息…</p>}
        {current?.error && <p className="inline-error" role="alert">{current.error}<button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
        {body && (body.payload.trim() ? <Markdown text={body.payload} /> : <p className="collaboration-empty">这条日志未记录正文。</p>)}
        <dl className="collaboration-paths"><dt>发送方</dt><dd>{message.sender || '未记录'}</dd><dt>接收方</dt><dd>{message.taskName || '未记录'}</dd></dl>
        {body && <div className="collaboration-raw">
          <button type="button" className="collaboration-raw-toggle" aria-expanded={rawOpen} aria-controls={`${bodyId}-raw`} onClick={toggleRaw}>{rawOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}查看原始日志消息</button>
          <div id={`${bodyId}-raw`} hidden={!rawOpen}>{rawOpen && <pre tabIndex={0} aria-label="原始协作日志">{body.raw}</pre>}</div>
        </div>}
      </>}
    </div>
    {onNavigate && <div className="collaboration-actions"><button type="button" className="text-button" onClick={onNavigate}>查看来源轮次<ArrowUpRight size={12} aria-hidden="true" /></button></div>}
  </article>;
}

export function CollaborationCard({ event, sessionId, record, labels = emptyLabels, preserveLayout }: {
  event: TimelineEvent; sessionId: string; record?: CollaborationRecord; labels?: ReadonlyMap<string, string>;
  preserveLayout?: (change: () => void) => void;
}) {
  const message = event.collaboration;
  if (!message) return null;
  const source = record ?? { ...message, id: event.id, sessionId, turnId: '', timestamp: event.timestamp, preview: message.payload.slice(0, 400) };
  return <CollaborationMessageCard message={source} labels={labels} content={{ payload: message.payload, raw: event.text }} preserveLayout={preserveLayout} />;
}