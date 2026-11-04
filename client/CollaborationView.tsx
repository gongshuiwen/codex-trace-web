import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight, GitBranch, LoaderCircle, RefreshCw, UsersRound } from 'lucide-react';
import type { SessionActivity, SessionDetail, SessionSummary } from '../shared/types';
import { clock, exactTokens, sessionDisplayName, sessionTooltip, statusLabels } from './format';
import { buildSessionTree, sessionAncestors } from './session-tree';
import { collectCollaborationMessages, collaborationRounds, layoutCollaborationTree, type CollaborationEntry, type CollaborationRecord } from './collaboration-data';
import { useCollaboration } from './useCollaboration';
import { createParticipantLabels, messageKey } from './collaboration-message';
import { CollaborationMessages } from './CollaborationMessages';
import './collaboration-view.css';

type Layout = ReturnType<typeof layoutCollaborationTree>;

function AgentNode({ value, current, selected, onSelect }: {
  value: SessionSummary; current: boolean; selected: boolean; onSelect: () => void;
}) {
  return <button type="button" className="collab-node" aria-pressed={selected} aria-current={current ? 'page' : undefined} title={sessionTooltip(value)} onClick={onSelect}>
    <strong>{sessionDisplayName(value)}</strong>
    <span className="collab-node-identity">{current ? '当前会话' : value.agentNickname || (value.parentId ? '子代理' : '主代理')}</span>
    <span className={`collab-round-status ${value.status}`}>{value.turnCount ? `本轮${statusLabels[value.status]}` : '暂无轮次'}</span>
  </button>;
}

function RelationshipGraph({ layout, currentId, selectedId, ancestors, expanded, messages, loading, onSelect, onToggle }: {
  layout: Layout; currentId: string; selectedId: string; ancestors: string[]; expanded: ReadonlySet<string>;
  messages: CollaborationRecord[]; loading: ReadonlySet<string>; onSelect: (id: string) => void; onToggle: (id: string) => void;
}) {
  const arrowId = useId();
  const nodes = new Map(layout.nodes.map(node => [node.session.id, node]));
  const highlighted = new Set([selectedId, ...ancestors]);
  const routes = new Map<string, { source: string; target: string; count: number }>();
  for (const { senderId, recipientId } of messages) {
    if (!senderId || !recipientId || senderId === recipientId || !nodes.has(senderId) || !nodes.has(recipientId)
      || senderId !== selectedId && recipientId !== selectedId) continue;
    const key = JSON.stringify([senderId, recipientId]);
    const route = routes.get(key);
    if (route) route.count++;
    else routes.set(key, { source: senderId, target: recipientId, count: 1 });
  }
  return <div className="collab-graph-scroll" aria-label="代理关系图">
    <div className="collab-graph" style={{ width: layout.width, height: layout.height + 60 }}>
      <svg width={layout.width} height={layout.height + 60} aria-hidden="true">
        <defs><marker id={arrowId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7 Z" className="collab-arrow" /></marker></defs>
        {layout.edges.map(({ parentId, childId }) => {
          const parent = nodes.get(parentId)!, child = nodes.get(childId)!;
          const sx = parent.x + 90, sy = parent.y + 82, tx = child.x + 90, ty = child.y;
          return <path key={childId} className={`collab-parent-edge ${highlighted.has(parentId) && highlighted.has(childId) ? 'selected' : ''}`} d={`M${sx} ${sy} V${sy + 42} H${tx} V${ty}`} />;
        })}
        {[...routes].map(([key, route]) => {
          const source = nodes.get(route.source)!, target = nodes.get(route.target)!;
          const sameRow = source.y === target.y, down = source.y < target.y;
          const sx = source.x + 90, sy = source.y + (sameRow || down ? 82 : 0);
          const tx = target.x + 90, ty = target.y + (sameRow || !down ? 82 : 0);
          const middle = sameRow ? sy + 48 : (sy + ty) / 2, bend = sx === tx ? (down ? 64 : -64) : 0;
          return <g key={key}><path className="collab-message-edge" markerEnd={`url(#${arrowId})`} d={`M${sx} ${sy} C${sx + bend} ${middle} ${tx + bend} ${middle} ${tx} ${ty}`} /><text className="collab-edge-count" x={(sx + tx) / 2 + bend * .75} y={sameRow ? middle - 8 : middle - 5} textAnchor="middle">{route.count} 条</text></g>;
        })}
      </svg>
      {layout.nodes.map(({ session: value, x, y }) => <div className="collab-graph-node" key={value.id} style={{ left: x, top: y }}>
        <AgentNode value={value} current={value.id === currentId} selected={value.id === selectedId} onSelect={() => onSelect(value.id)} />
        {(value.childCount ?? layout.edges.filter(edge => edge.parentId === value.id).length) > 0 && <button type="button" className="collab-expand" aria-label={`${expanded.has(value.id) ? '收起' : '展开'}${sessionDisplayName(value)}的子代理`} aria-expanded={expanded.has(value.id)} onClick={() => onToggle(value.id)}>
          {loading.has(value.id) ? <LoaderCircle size={12} className="spin" /> : expanded.has(value.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{value.childCount ?? '下级'}
        </button>}
      </div>)}
    </div>
  </div>;
}

function CompactTree({ layout, currentId, selectedId, expanded, onSelect, onToggle }: {
  layout: Layout; currentId: string; selectedId: string; expanded: ReadonlySet<string>; onSelect: (id: string) => void; onToggle: (id: string) => void;
}) {
  return <ol className="collab-compact-tree" aria-label="代理关系树">{layout.nodes.map(({ session: value, depth }) => <li key={value.id} style={{ paddingLeft: Math.min(depth, 5) * 14 }}>
    {(value.childCount ?? layout.edges.filter(edge => edge.parentId === value.id).length) > 0
      ? <button type="button" className="collab-tree-toggle" aria-label={`${expanded.has(value.id) ? '收起' : '展开'}${sessionDisplayName(value)}的子代理`} aria-expanded={expanded.has(value.id)} onClick={() => onToggle(value.id)}>{expanded.has(value.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
      : <span className="collab-tree-spacer" />}
    <AgentNode value={value} current={value.id === currentId} selected={value.id === selectedId} onSelect={() => onSelect(value.id)} />
  </li>)}</ol>;
}

function CollaborationTimeline({ layout, entries, messages, selectedId, expanded, onToggle, onSelect, onMessage, onNavigate }: {
  layout: Layout; entries: CollaborationEntry[]; messages: CollaborationRecord[]; selectedId: string;
  expanded: ReadonlySet<string>; onToggle: (id: string) => void;
  onSelect: (id: string) => void; onMessage: (messages: CollaborationRecord[]) => void; onNavigate: (sessionId: string, turnId: string) => void;
}) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  useEffect(() => {
    const track = timelineRef.current?.querySelector('.collab-lane-track');
    if (!track) return;
    const observer = new ResizeObserver(([entry]) => setTrackWidth(entry.contentRect.width));
    observer.observe(track);
    return () => observer.disconnect();
  }, []);
  const visible = new Set(layout.nodes.map(node => node.session.id));
  const rounds = collaborationRounds(entries).filter(item => visible.has(item.sessionId));
  const times = [...rounds.flatMap(({ turn }) => [Date.parse(turn.startedAt), Date.parse(turn.endedAt ?? '')]), ...messages.filter(message => visible.has(message.sessionId)).map(message => Date.parse(message.timestamp))].filter(Number.isFinite);
  const start = times.length ? Math.min(...times) : 0, end = times.length ? Math.max(...times) : 0, range = Math.max(1, end - start);
  const position = (value: string) => (Date.parse(value) - start) / range * 100;
  const unknown = messages.filter(message => !Number.isFinite(Date.parse(message.timestamp))).length;
  function messageGroups(sessionId: string) {
    const groups: CollaborationRecord[][] = [];
    for (const message of messages.filter(item => item.sessionId === sessionId && Number.isFinite(Date.parse(item.timestamp)))) {
      const group = groups.at(-1);
      if (group && (position(message.timestamp) - position(group[0].timestamp)) * trackWidth / 100 < 44) group.push(message);
      else groups.push([message]);
    }
    return groups;
  }
  return <div className="collab-timeline" ref={timelineRef}>
    {times.length > 0 ? <div className="collab-time-axis">{(end > start ? [0, 1, 2, 3] : [0]).map(tick => <time key={tick}>{new Date(start + (end - start) * tick / 3).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', ...(range < 120000 ? { second: '2-digit' } : {}), hour12: false })}</time>)}</div> : <p className="collab-empty">尚无带时间戳的活动记录。</p>}
    {layout.nodes.map(({ session: value, depth }) => <div className={`collab-lane ${selectedId === value.id ? 'selected' : ''}`} key={value.id}>
      <div className="collab-lane-heading" style={{ paddingLeft: Math.min(depth, 4) * 8 }}>{(value.childCount ?? 0) > 0 && <button type="button" className="collab-tree-toggle" aria-label={`${expanded.has(value.id) ? '收起' : '展开'}${sessionDisplayName(value)}的子代理`} aria-expanded={expanded.has(value.id)} onClick={() => onToggle(value.id)}>{expanded.has(value.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>}<button type="button" className="collab-lane-label" aria-pressed={selectedId === value.id} title={sessionTooltip(value)} onClick={() => onSelect(value.id)}>{depth > 0 && <GitBranch size={12} />}<span>{sessionDisplayName(value)}</span></button></div>
      <div className="collab-lane-track">
        {rounds.filter(item => item.sessionId === value.id && Number.isFinite(Date.parse(item.turn.startedAt))).map(({ turn }) => {
          const from = position(turn.startedAt), to = turn.endedAt ? position(turn.endedAt) : from;
          const bounded = Number.isFinite(to) && to > from;
          return <button type="button" key={turn.id} className={`collab-round ${bounded ? '' : 'point'}`} style={{ left: `${from}%`, width: bounded ? `${to - from}%` : undefined }} aria-label={`${sessionDisplayName(value)} 第 ${turn.index + 1} 轮，${clock(turn.startedAt)}${bounded ? `–${clock(turn.endedAt!)}` : '，结束时间未记录'}`} onClick={() => onNavigate(value.id, turn.id)} />;
        })}
        {messageGroups(value.id).map(group => <button key={`${group[0].sessionId}:${group[0].id}`} type="button" className={`collab-message-point ${group.length > 1 ? 'grouped' : ''}`} style={{ left: `${position(group[0].timestamp)}%` }} title={group.map(message => `${clock(message.timestamp)} · ${message.sender} → ${message.taskName}`).join('\n')} aria-label={`${clock(group[0].timestamp)} ${group.length} 条协作消息`} onClick={() => onMessage(group)}>{group.length > 1 && <span>{group.length}</span>}</button>)}
      </div>
    </div>)}
    <p className="collab-note">片段仅表示已记录的轮次，空白不代表等待。{unknown > 0 && `另有 ${unknown} 条消息未记录时间。`}</p>
  </div>;
}

export function CollaborationView({ session, activity, onSelectSession, onNavigateTurn }: {
  session: SessionDetail; activity: SessionActivity; onSelectSession: (session: SessionSummary) => void; onNavigateTurn: (turnId: string) => void;
}) {
  const { entries, sessions, loading, errors, load, refresh } = useCollaboration(session, activity);
  const [saved] = useState(() => window.history.state?.collaboration as { selectedId?: string; expanded?: string[]; mode?: string; showMessages?: boolean } | undefined);
  const [selectedId, setSelectedId] = useState(saved?.selectedId ?? session.session.id);
  const [expanded, setExpanded] = useState(() => new Set(saved?.expanded ?? [session.session.id, ...(session.parent ? [session.parent.id] : [])]));
  const [mode, setMode] = useState<'graph' | 'timeline'>(saved?.mode === 'timeline' ? 'timeline' : 'graph');
  const [showMessages, setShowMessages] = useState(saved?.showMessages ?? true);
  const [focusedKeys, setFocusedKeys] = useState<string[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const tree = useMemo(() => buildSessionTree(sessions), [sessions]);
  const layout = useMemo(() => layoutCollaborationTree(tree, expanded), [tree, expanded]);
  const messages = useMemo(() => collectCollaborationMessages(entries, sessions), [entries, sessions]);
  const focusedMessages = useMemo(() => {
    const keys = new Set(focusedKeys);
    return messages.filter(message => keys.has(messageKey(message)));
  }, [messages, focusedKeys]);
  const labels = useMemo(() => createParticipantLabels(sessions), [sessions]);
  const revisions = useMemo(() => new Map(entries.map(entry => [entry.detail.session.id, entry.detail.session.revision])), [entries]);
  const selected = tree.byId.get(selectedId)?.session ?? session.session;
  const selectedEntry = entries.find(entry => entry.detail.session.id === selected.id);
  const related = messages.filter(message => message.senderId === selected.id || message.recipientId === selected.id);
  const unlinked = messages.filter(message => !message.senderId || !message.recipientId);
  const selectedParent = tree.parents.get(selected.id);
  const rootMissing = layout.nodes.find(node => node.session.parentId && !tree.byId.has(node.session.parentId));

  useEffect(() => {
    for (const id of expanded) load(id);
    load(selectedId);
  }, [expanded, selectedId, load]);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('session') === session.session.id) {
      window.history.replaceState({ ...window.history.state, collaboration: { selectedId, expanded: [...expanded], mode, showMessages } }, '', window.location.href);
    }
  }, [session.session.id, selectedId, expanded, mode, showMessages]);

  function select(id: string) {
    setSelectedId(id); setFocusedKeys([]); load(id);
    if (window.matchMedia('(max-width:600px)').matches) requestAnimationFrame(() => inspectorRef.current?.scrollIntoView({ block: 'start' }));
  }
  function toggle(id: string) {
    setExpanded(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
    if (!expanded.has(id)) load(id);
  }
  function navigate(sessionId: string, turnId: string) {
    if (sessionId === session.session.id) onNavigateTurn(turnId);
    else { const target = tree.byId.get(sessionId)?.session; if (target) onSelectSession({ ...target, match: { turnId, excerpt: '' } }); }
  }
  function focusMessages(records: CollaborationRecord[]) {
    const message = records[0];
    const id = records.every(record => record.senderId === selected.id || record.recipientId === selected.id)
      ? selected.id : message.sessionId;
    setExpanded(previous => new Set([...previous, ...sessionAncestors(tree, id)]));
    setSelectedId(id); setFocusedKeys(records.map(messageKey)); load(id);
  }

  return <section className="collaboration-view" aria-label="子代理协作视图">
    <div className="collab-view-heading"><UsersRound size={17} aria-hidden="true" /><h2>子代理协作</h2><span>{sessions.length} 个已载入会话</span><button type="button" className="icon-button" aria-label="刷新协作记录" onClick={refresh}><RefreshCw size={14} /></button></div>
    <div className="collab-workspace">
      <div className="collab-toolbar"><div className="collab-view-switch" aria-label="协作布局">{([['graph', '关系总览'], ['timeline', '树形时序']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={mode === id} onClick={() => setMode(id)}>{label}</button>)}</div>{mode === 'graph' && <label className="collab-message-toggle"><input type="checkbox" checked={showMessages} onChange={event => setShowMessages(event.target.checked)} />消息连线</label>}</div>
      <div className="collab-body">
        <div className="collab-canvas" ref={canvasRef}>
          <div className="collab-legend"><span><i />{mode === 'graph' ? '父子关系' : '已记录轮次'}</span><span><i className={mode === 'graph' ? 'message' : 'point'} />{mode === 'graph' ? '选中代理的消息 →' : '协作消息'}</span></div>
          {rootMissing && <p className="collab-note">父会话尚未索引：<code>{rootMissing.session.parentId}</code></p>}
          {mode === 'graph' ? <>
            <RelationshipGraph layout={layout} currentId={session.session.id} selectedId={selected.id} ancestors={sessionAncestors(tree, selected.id)} expanded={expanded} messages={showMessages ? messages : []} loading={loading} onSelect={select} onToggle={toggle} />
            <CompactTree layout={layout} currentId={session.session.id} selectedId={selected.id} expanded={expanded} onSelect={select} onToggle={toggle} />
          </> : <CollaborationTimeline layout={layout} entries={entries} messages={messages} selectedId={selected.id} expanded={expanded} onToggle={toggle} onSelect={select} onMessage={focusMessages} onNavigate={navigate} />}
          {layout.nodes.filter(node => node.session.id !== selected.id && errors.has(node.session.id)).map(node => <p className="inline-error" role="alert" key={node.session.id}>{sessionDisplayName(node.session)}：{errors.get(node.session.id)}<button type="button" onClick={() => load(node.session.id)}>重试</button></p>)}
          <p className="collab-note">{mode === 'graph' ? '选择节点查看任务与消息，展开下级按需载入。' : '选择代理载入其轮次，点击片段定位原始记录。'}</p>
        </div>
        <aside className="collab-inspector" aria-label="代理详情" ref={inspectorRef}>
          <button type="button" className="text-button collab-back-to-tree" onClick={() => canvasRef.current?.scrollIntoView({ block: 'start' })}>返回关系<ChevronRight size={12} /></button>
          <span className="collab-detail-label">选中代理</span><h3>{sessionDisplayName(selected)}</h3>
          <code className="collab-detail-path">{selected.agentName || selected.id}</code>
          <div className="collab-agent-summary"><span>{exactTokens(selected.usage.tokens?.totalTokens)} tokens</span><span>{selected.turnCount ? `本轮${statusLabels[selected.status]}` : '暂无轮次'}</span></div>
          <details className="collab-task-description" key={`task-${selected.id}`}><summary><span>{selectedEntry?.detail.turns[0]?.prompt || selected.title || '任务说明未记录。'}</span><ChevronDown size={12} aria-hidden="true" /></summary></details>
          <details className="collab-agent-info" key={`info-${selected.id}`}><summary>更多信息<ChevronDown size={12} aria-hidden="true" /></summary><dl className="collab-detail-meta"><dt>派生自</dt><dd>{selectedParent ? sessionDisplayName(tree.byId.get(selectedParent)!.session) : selected.parentId ? '尚未索引' : '—'}</dd><dt>模型调用</dt><dd>{selected.usage.completeness === 'unknown' ? '未记录' : `${selected.usage.completeness === 'partial' ? '≥ ' : ''}${selected.usage.requestCount.toLocaleString('zh-CN')} 次`}</dd><dt>模型</dt><dd>{selected.model || '未记录'}</dd></dl></details>
          {selected.usage.completeness !== 'complete' && <p className="collab-note">{selected.usage.completeness === 'partial' ? '用量记录不完整。' : '用量尚未记录。'}</p>}
          {selected.id !== session.session.id && <button className="text-button collab-open-session" type="button" onClick={() => onSelectSession(selected)}>打开会话<ArrowUpRight size={13} /></button>}
          {loading.has(selected.id) && <p className="turn-loading" role="status"><LoaderCircle size={14} className="spin" />正在读取此代理…</p>}
          {errors.has(selected.id) && <p className="inline-error" role="alert">{errors.get(selected.id)}<button type="button" onClick={() => load(selected.id)}>重试</button></p>}
          <CollaborationMessages key={`messages-${selected.id}`} messages={related} selectedId={selected.id} labels={labels} revisions={revisions} focused={focusedMessages} onClearFocus={() => setFocusedKeys([])} onNavigate={navigate} emptyText={selectedEntry ? '已读取日志中没有可关联到此代理的消息。' : '正在读取此代理的协作记录。'} />
        </aside>
      </div>
      <div className="collab-footer"><span>仅关联明确的任务路径 · 各会话用量独立</span><span>轮次完成不代表代理结束</span></div>
    </div>
    <details className="collab-unlinked"><summary>未关联消息 <span>{unlinked.length} 条</span></summary><p className="collab-note">至少一端尚未匹配到已载入会话。展开全文可阅读完整消息和原始任务路径，“查看来源轮次”可定位原始记录。</p><CollaborationMessages messages={unlinked} labels={labels} revisions={revisions} onNavigate={navigate} /></details>
  </section>;
}
