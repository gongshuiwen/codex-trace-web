import { useState } from 'react';
import { ArrowRight, ArrowUpRight, ChevronRight, GitBranch, UsersRound } from 'lucide-react';
import type { SessionActivity, SessionDetail, SessionSummary } from '../shared/types';
import { clock, collaborationTypeLabels, dateGroup, exactTokens, sessionDisplayName, sessionTooltip, statusLabels } from './format';
import './collaboration-view.css';

const sectionFrame = 'group/section mb-4 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 pb-4 max-[560px]:px-3';
const sectionHeading = 'flex min-h-11 cursor-pointer list-none items-center gap-2 py-3.5 text-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]';
const noteText = 'mb-3 text-[12px] leading-[1.8] text-[var(--muted)] [overflow-wrap:anywhere]';
const textAction = 'inline-flex min-h-11 items-center gap-1.5 rounded-md border-0 bg-transparent py-2 text-[12px] text-[var(--accent-strong)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]';

function SessionNode({ value, relation, current = false, onSelect }: {
  value: SessionSummary;
  relation: string;
  current?: boolean;
  onSelect: (session: SessionSummary) => void;
}) {
  const content = <>
    <span className="collab-session-heading flex min-w-0 items-center gap-2 max-[560px]:flex-wrap max-[560px]:gap-x-2 max-[560px]:gap-y-1">
      <span className="collab-relation text-[12px] whitespace-nowrap text-[var(--muted)]">{relation}</span>
      <strong className="min-w-0 truncate text-[14px] leading-snug font-semibold text-[var(--text)] max-[560px]:flex-1 max-[560px]:whitespace-normal max-[560px]:[overflow-wrap:anywhere]">{sessionDisplayName(value)}</strong>
      {!current && <ArrowUpRight size={13} className="ml-auto shrink-0" aria-hidden="true" />}
    </span>
    <span className="collab-session-meta flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-[var(--muted)] tabular-nums max-[560px]:gap-x-3">
      <span className={`collab-status ${value.status} ${value.status === 'running' || value.status === 'completed' ? 'text-[var(--accent-strong)]' : value.status === 'interrupted' ? 'text-[var(--warning)]' : 'text-[var(--muted)]'}`}>{statusLabels[value.status]}</span>
      <span>{exactTokens(value.usage.tokens?.totalTokens)} tokens</span>
      <span>{value.usage.completeness === 'unknown' ? '调用数未知' : `${value.usage.completeness === 'partial' ? '≥ ' : ''}${value.usage.requestCount.toLocaleString('zh-CN')} 次调用`}</span>
      {value.usage.completeness === 'partial' && <span>部分记录</span>}
    </span>
    <code className="collab-session-id font-mono text-[12px] leading-relaxed text-[var(--muted)] [overflow-wrap:anywhere]">{value.id}</code>
  </>;

  return current
    ? <div className="collab-session current flex w-full min-w-0 flex-col gap-1.5 rounded-md border border-[var(--border)] bg-[var(--accent-light)] p-3 text-left text-[var(--soft)]" aria-current="page" title={sessionTooltip(value)}>{content}</div>
    : <button className="collab-session flex w-full min-w-0 flex-col gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg)] p-3 text-left text-[var(--soft)] hover:border-[var(--control)] hover:bg-[var(--hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" type="button" title={sessionTooltip(value)} onClick={() => onSelect(value)}>{content}</button>;
}

function MessageList({ messages, session, onNavigateTurn }: {
  messages: SessionActivity['messages'];
  session: SessionDetail;
  onNavigateTurn: (turnId: string) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(12);
  const start = Math.max(0, messages.length - visibleCount);
  const turnNumbers = new Map(session.turns.map(turn => [turn.id, turn.index + 1]));

  return <details className={`collab-section collab-messages ${sectionFrame}`} open>
    <summary className={sectionHeading}><ChevronRight size={14} className="group-open/section:rotate-90" aria-hidden="true" /><strong className="font-semibold text-[var(--text)]">协作消息</strong><span className="ml-auto text-[12px] text-[var(--muted)]">{messages.length.toLocaleString('zh-CN')} 条</span></summary>
    <p className={`collab-note ${noteText}`}>仅展示当前会话日志中的消息。发送者 → 接收任务；任务标识与会话的对应关系未记录。</p>
    {messages.length === 0 ? <p className="collab-empty mt-3 text-[14px] leading-relaxed text-[var(--muted)]">这份日志没有可识别的协作消息。</p> : <>
      <div className="collab-message-controls mb-2 flex flex-wrap items-center justify-between gap-2.5 text-[12px] text-[var(--muted)]">
        <span>按日志顺序 · 显示 {start + 1}–{messages.length} / {messages.length} 条</span>
        {start > 0 && <button className={`text-button ${textAction}`} type="button" onClick={() => setVisibleCount(count => count + 12)}>显示更早消息</button>}
      </div>
      <ol className="collab-message-list m-0 list-none space-y-2 p-0" start={start + 1}>
        {messages.slice(start).map(message => <li key={message.id}>
          <button className="collab-message flex w-full min-w-0 flex-col gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-3 text-left text-[var(--soft)] hover:border-[var(--control)] hover:bg-[var(--hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" type="button" onClick={() => onNavigateTurn(message.turnId)}>
            <span className="collab-message-heading flex flex-wrap items-center gap-2 text-[12px] text-[var(--muted)]">
              <span className={`collab-message-type flex-none rounded border px-1.5 py-0.5 whitespace-nowrap ${message.messageType === 'FINAL_ANSWER' ? 'final border-transparent bg-[var(--accent-light)] text-[var(--accent-strong)]' : 'border-[var(--border)]'}`}>{collaborationTypeLabels[message.messageType]}</span>
              <time className="tabular-nums" dateTime={message.timestamp} title={message.timestamp}>{dateGroup(message.timestamp)} {clock(message.timestamp)}</time>
              <span className="collab-message-target ml-auto flex items-center gap-1 whitespace-nowrap">{turnNumbers.has(message.turnId) ? `第 ${turnNumbers.get(message.turnId)} 轮` : '来源轮次'}<ArrowUpRight size={12} aria-hidden="true" /></span>
            </span>
            <span className="collab-message-route flex min-w-0 flex-wrap items-center gap-2 text-[var(--soft)]"><code className="min-w-0 font-mono text-[12px] leading-relaxed [overflow-wrap:anywhere]">{message.sender || '发送者未记录'}</code><ArrowRight size={12} aria-hidden="true" /><code className="min-w-0 font-mono text-[12px] leading-relaxed [overflow-wrap:anywhere]">{message.taskName || '接收任务未记录'}</code></span>
            <span className="collab-message-preview text-[14px] leading-[1.75] whitespace-pre-wrap [overflow-wrap:anywhere]">{message.preview || '消息没有正文预览。'}</span>
          </button>
        </li>)}
      </ol>
      <p className={`collab-note mt-3 ${noteText}`}>点击消息定位原轮次，再展开协作卡片阅读完整内容。</p>
    </>}
  </details>;
}

export function CollaborationView({ session, activity, onSelectSession, onNavigateTurn }: {
  session: SessionDetail;
  activity: SessionActivity;
  onSelectSession: (session: SessionSummary) => void;
  onNavigateTurn: (turnId: string) => void;
}) {
  const [visibleChildren, setVisibleChildren] = useState(4);
  return <section className="collaboration-view min-w-0 text-[var(--soft)]" aria-label="子代理协作视图">
    <div className="collab-view-heading mb-5 flex flex-wrap items-center gap-2 text-[var(--accent-strong)]"><UsersRound size={17} aria-hidden="true" /><h2 className="m-0 text-[16px] font-semibold text-[var(--text)]">子代理协作</h2><span className="ml-auto text-[12px] text-[var(--muted)]">{session.children.length} 个直接子会话</span></div>
    <details className={`collab-section collab-relationships ${sectionFrame}`} open>
      <summary className={sectionHeading}><ChevronRight size={14} className="group-open/section:rotate-90" aria-hidden="true" /><strong className="font-semibold text-[var(--text)]">会话关系</strong><span className="ml-auto text-[12px] text-[var(--muted)]">父 → 当前 → 子</span></summary>
      <p className={`collab-note ${noteText}`}>各会话用量独立展示，父子用量不相加。</p>
      <ol className="collab-session-tree m-0 list-none space-y-2 p-0">
        {session.parent ? <li><SessionNode value={session.parent} relation="父会话" onSelect={onSelectSession} /></li> : session.session.parentId && <li className="collab-missing-parent flex flex-wrap gap-x-3 gap-y-1.5 py-1 text-[12px] text-[var(--muted)] [overflow-wrap:anywhere]"><span>父会话尚未索引</span><code className="font-mono text-[12px]">{session.session.parentId}</code></li>}
        <li>
          <SessionNode value={session.session} relation="当前会话" current onSelect={onSelectSession} />
          {session.children.length > 0 ? <><ul className="mt-2.5 ml-3 list-none border-l border-[var(--border)] p-0 pl-4 max-[560px]:ml-1.5 max-[560px]:pl-3">{session.children.slice(0, visibleChildren).map(child => <li className="relative my-2" key={child.id}><SessionNode value={child} relation="子会话" onSelect={onSelectSession} /></li>)}</ul>{visibleChildren < session.children.length && <button className={`text-button collab-children-more mt-1 ml-7 ${textAction}`} type="button" onClick={() => setVisibleChildren(count => count + 12)}>显示更多子会话（{visibleChildren} / {session.children.length}）</button>}{visibleChildren > 4 && <button className={`text-button collab-children-more mt-1 ml-7 ${textAction}`} type="button" onClick={() => setVisibleChildren(4)}>收起子会话</button>}</> : <p className="collab-empty mt-3 flex items-center gap-2 text-[14px] leading-relaxed text-[var(--muted)]"><GitBranch size={13} aria-hidden="true" />没有已索引的直接子会话。</p>}
        </li>
      </ol>
    </details>
    <MessageList key={session.session.id} messages={activity.messages} session={session} onNavigateTurn={onNavigateTurn} />
  </section>;
}
