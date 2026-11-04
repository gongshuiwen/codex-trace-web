import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, BrainCircuit, FileJson2, Layers3, LoaderCircle, UsersRound, Wrench } from 'lucide-react';
import type { TimelineEvent, ToolCall, ToolSearchLocation, TurnDetail } from '../shared/types';
import type { CollaborationRecord } from './collaboration-data';
import { loadCollaborationDetail, type CollaborationDetail } from './collaboration-detail';
import { messageRoute, messageTypeLabel } from './collaboration-message';
import { api, errorMessage, isAbort, sessionPath } from './api';
import { clock } from './format';
import { contextPresentation } from './event-presentation';
import { turnDetailCache } from './turn-detail-cache';
import { toolPresentation } from './tool-presentation';
import { ToolContent } from './ToolContent';
import { ToolStatus } from './ToolStatus';
import { Markdown } from './Markdown';
import { DEFAULT_DETAIL_WIDTH, RecordDetails, type DetailWidth } from './RecordDetails';

export type RecordSelection =
  | { kind: 'tool'; sessionId: string; turnId: string; tool: ToolCall; revision: string; search?: ToolSearchLocation; navigationId?: number }
  | { kind: 'event'; sessionId: string; event: TimelineEvent }
  | { kind: 'message'; message: CollaborationRecord; labels: ReadonlyMap<string, string>; revision: string; content?: CollaborationDetail; onNavigate?: () => void };

export function recordSelectionKey(selection: RecordSelection): string {
  return selection.kind === 'tool' ? JSON.stringify([selection.sessionId, 'tool', selection.tool.id])
    : selection.kind === 'event' ? JSON.stringify([selection.sessionId, 'event', selection.event.id])
    : JSON.stringify([selection.message.sessionId, 'event', selection.message.id]);
}

const InspectorContext = createContext<{ selection: RecordSelection | null; inspect: (selection: RecordSelection) => void } | null>(null);

export function useRecordInspector() {
  const context = useContext(InspectorContext);
  if (!context) throw new Error('记录详情需要位于 RecordWorkspace 内。');
  return context;
}

/** Keep a single inspector beside the transcript without remounting the transcript. */
export function RecordWorkspace({ children, scope, revision, onNavigate, preserveLayout }: {
  children: ReactNode; scope: string; revision: string; onNavigate: (sessionId: string, turnId: string) => void;
  preserveLayout?: (change: () => void) => void;
}) {
  const [opened, setOpened] = useState<{ scope: string; selection: RecordSelection } | null>(null);
  const [width, setWidth] = useState(DEFAULT_DETAIL_WIDTH);
  const trigger = useRef<HTMLElement | null>(null);
  const selection = opened?.scope === scope ? opened.selection : null;
  if (opened && opened.scope !== scope) setOpened(null);
  const inspect = useCallback((next: RecordSelection) => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const change = () => setOpened({ scope, selection: next });
    if (preserveLayout && !(next.kind === 'tool' && next.navigationId !== undefined)) preserveLayout(change); else change();
  }, [scope, preserveLayout]);
  const context = useMemo(() => ({ selection, inspect }), [selection, inspect]);
  function changeWidth(next: number) {
    const change = () => setWidth(next);
    if (preserveLayout) preserveLayout(change); else change();
  }
  function close() {
    if (preserveLayout) preserveLayout(() => setOpened(null)); else setOpened(null);
    // The covered transcript becomes visible only after the panel has unmounted.
    requestAnimationFrame(() => { if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); });
  }
  return <InspectorContext.Provider value={context}>
    <div className="record-workspace h-full">
      <div className="record-main">{children}</div>
      {selection && <SelectedRecord selection={selection} revision={revision} width={width} onWidthChange={changeWidth} onClose={close} onNavigate={(sessionId, turnId) => {
        setOpened(null);
        if (selection.kind === 'message' && selection.onNavigate) selection.onNavigate(); else onNavigate(sessionId, turnId);
      }} />}
    </div>
  </InspectorContext.Provider>;
}

function SelectedRecord({ selection, revision, onClose, onNavigate, ...size }: {
  selection: RecordSelection; revision: string; onClose: () => void; onNavigate: (sessionId: string, turnId: string) => void;
} & DetailWidth) {
  const key = recordSelectionKey(selection);
  if (selection.kind === 'tool') return <ToolRecord key={key} selection={selection} revision={revision} onClose={onClose} {...size} />;
  if (selection.kind === 'message') return <MessageRecord key={key} selection={selection} onClose={onClose} onNavigate={onNavigate} {...size} />;
  const { event } = selection;
  const context = event.kind === 'context';
  const reasoning = event.kind === 'reasoning';
  const title = context ? contextPresentation(event).label : reasoning ? '推理摘要' : '其他日志';
  return <RecordDetails key={key} title={title} icon={context ? Layers3 : reasoning ? BrainCircuit : FileJson2} meta={<time dateTime={event.timestamp}>{clock(event.timestamp)}</time>} onClose={onClose} {...size}>
    {reasoning ? <Markdown text={event.text || '日志没有记录可显示的推理摘要'} />
      : <pre className="record-detail-text" tabIndex={0} aria-label={`${title}原文`}>{event.text || '此记录没有可显示的文本'}</pre>}
  </RecordDetails>;
}

function ToolRecord({ selection, revision, onClose, ...size }: { selection: Extract<RecordSelection, { kind: 'tool' }>; revision: string; onClose: () => void } & DetailWidth) {
  const [loaded, setLoaded] = useState<{ revision: string; tool?: ToolCall; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const tool = selection.revision === revision ? selection.tool : loaded?.tool ?? selection.tool;
  const presentation = toolPresentation(tool);
  useEffect(() => {
    if (selection.revision === revision && retry === 0) return;
    const controller = new AbortController();
    const cached = turnDetailCache.get(selection.sessionId, selection.turnId);
    const request = cached?.revision === revision ? Promise.resolve(cached.data)
      : api<TurnDetail>(`${sessionPath(selection.sessionId)}/turns/${encodeURIComponent(selection.turnId)}`, { signal: controller.signal });
    request.then(turn => {
      if (!controller.signal.aborted) {
        const latest = turn.events.find(event => event.tool?.id === selection.tool.id)?.tool;
        setLoaded({ revision, tool: latest, error: latest ? undefined : '日志已变化，未找到这次工具调用。请重新定位。' });
      }
    }).catch(cause => { if (!controller.signal.aborted && !isAbort(cause)) setLoaded({ revision, error: errorMessage(cause) }); });
    return () => controller.abort();
  }, [selection.sessionId, selection.turnId, selection.tool.id, selection.revision, revision, retry]);
  return <RecordDetails title={presentation.title} icon={Wrench} meta={<ToolStatus tool={tool} />} fill onClose={onClose} {...size}>
    {loaded?.revision === revision && loaded.error && <p className="inline-error record-detail-note" role="alert">{loaded.error}<button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    <div className="record-tool-heading">
      {presentation.subtitle && <p className="record-tool-subtitle">{presentation.subtitle}</p>}
      <details className="record-detail-info"><summary>调用信息</summary><dl><dt>工具</dt><dd>{tool.name}</dd><dt>调用 ID</dt><dd>{tool.id}</dd></dl></details>
    </div>
    <ToolContent key={`${tool.id}:${selection.navigationId ?? ''}`} tool={tool} sessionId={selection.sessionId} revision={revision} search={selection.search} navigationId={selection.navigationId} />
  </RecordDetails>;
}

function MessageRecord({ selection, onClose, onNavigate, ...size }: {
  selection: Extract<RecordSelection, { kind: 'message' }>; onClose: () => void; onNavigate: (sessionId: string, turnId: string) => void;
} & DetailWidth) {
  const { message, content, labels, revision } = selection;
  const [loaded, setLoaded] = useState<{ key: string; data?: CollaborationDetail; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const loadKey = JSON.stringify([message.sessionId, message.turnId, message.id, message.messageType, message.sender, message.taskName, revision, retry]);
  const current = loaded?.key === loadKey ? loaded : null;
  const body = content ?? current?.data;
  useEffect(() => {
    if (content) return;
    const controller = new AbortController();
    loadCollaborationDetail(message, revision, controller.signal).then(data => {
      if (!controller.signal.aborted) setLoaded({ key: loadKey, data });
    }).catch(cause => { if (!controller.signal.aborted && !isAbort(cause)) setLoaded({ key: loadKey, error: errorMessage(cause) }); });
    return () => controller.abort();
  }, [content, loadKey, message.sessionId, message.turnId, message.id, message.messageType, message.sender, message.taskName, revision]);
  return <RecordDetails title={messageRoute(message, labels)} icon={UsersRound} meta={messageTypeLabel(message.messageType, 'unknown')} onClose={onClose} {...size}>
    <div className="record-detail-message" aria-busy={!body && !current?.error || undefined}>
      {!body && !current?.error && <p className="turn-loading" role="status"><LoaderCircle size={14} className="spin" />正在读取完整消息…</p>}
      {current?.error && <p className="inline-error" role="alert">{current.error}<button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
      {body && <Markdown text={body.payload || '这条日志未记录正文。'} />}
      <dl className="record-detail-paths"><dt>发送方</dt><dd>{message.sender || '未记录'}</dd><dt>接收方</dt><dd>{message.taskName || '未记录'}</dd><dt>时间</dt><dd>{message.timestamp ? clock(message.timestamp) : '未记录'}</dd></dl>
      {body && <details className="record-detail-info"><summary>查看原始日志消息</summary><pre className="record-detail-text" tabIndex={0}>{body.raw}</pre></details>}
      {message.turnId && <button type="button" className="text-button" onClick={() => onNavigate(message.sessionId, message.turnId)}>查看来源轮次<ArrowUpRight size={12} aria-hidden="true" /></button>}
    </div>
  </RecordDetails>;
}
