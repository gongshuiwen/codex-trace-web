import { useState } from 'react';
import { ArrowRight, ArrowUpRight, ChevronRight, GitBranch, UsersRound } from 'lucide-react';
import type { SessionActivity, SessionDetail, SessionSummary } from '../shared/types';
import { clock, collaborationTypeLabels, dateGroup, exactTokens, statusLabels } from './format';
import './collaboration-view.css';

function SessionNode({ value, relation, current = false, onSelect }: {
  value: SessionSummary;
  relation: string;
  current?: boolean;
  onSelect: (session: SessionSummary) => void;
}) {
  const content = <>
    <span className="collab-session-heading">
      <span className="collab-relation">{relation}</span>
      <strong>{value.title || value.project || '未命名会话'}</strong>
      {!current && <ArrowUpRight size={13} aria-hidden="true" />}
    </span>
    <span className="collab-session-meta">
      <span className={`collab-status ${value.status}`}>{statusLabels[value.status]}</span>
      <span>{exactTokens(value.usage.tokens?.totalTokens)} tokens</span>
      <span>{value.usage.completeness === 'unknown' ? '调用数未知' : `${value.usage.completeness === 'partial' ? '≥ ' : ''}${value.usage.requestCount.toLocaleString('zh-CN')} 次调用`}</span>
      {value.usage.completeness === 'partial' && <span>部分记录</span>}
    </span>
    <code className="collab-session-id">{value.id}</code>
  </>;

  return current
    ? <div className="collab-session current" aria-current="page">{content}</div>
    : <button className="collab-session" type="button" onClick={() => onSelect(value)}>{content}</button>;
}

function MessageList({ messages, session, onNavigateTurn }: {
  messages: SessionActivity['messages'];
  session: SessionDetail;
  onNavigateTurn: (turnId: string) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(12);
  const start = Math.max(0, messages.length - visibleCount);
  const turnNumbers = new Map(session.turns.map(turn => [turn.id, turn.index + 1]));

  return <details className="collab-section collab-messages" open>
    <summary><ChevronRight size={14} aria-hidden="true" /><strong>协作消息</strong><span>{messages.length.toLocaleString('zh-CN')} 条</span></summary>
    <p className="collab-note">仅展示当前会话日志中的消息。发送者 → 接收任务；任务标识与会话的对应关系未记录。</p>
    {messages.length === 0 ? <p className="collab-empty">这份日志没有可识别的协作消息。</p> : <>
      <div className="collab-message-controls">
        <span>按日志顺序 · 显示 {start + 1}–{messages.length} / {messages.length} 条</span>
        {start > 0 && <button className="text-button" type="button" onClick={() => setVisibleCount(count => count + 12)}>显示更早消息</button>}
      </div>
      <ol className="collab-message-list" start={start + 1}>
        {messages.slice(start).map(message => <li key={message.id}>
          <button className="collab-message" type="button" onClick={() => onNavigateTurn(message.turnId)}>
            <span className="collab-message-heading">
              <span className={`collab-message-type ${message.messageType === 'FINAL_ANSWER' ? 'final' : ''}`}>{collaborationTypeLabels[message.messageType]}</span>
              <time dateTime={message.timestamp} title={message.timestamp}>{dateGroup(message.timestamp)} {clock(message.timestamp)}</time>
              <span className="collab-message-target">{turnNumbers.has(message.turnId) ? `第 ${turnNumbers.get(message.turnId)} 轮` : '来源轮次'}<ArrowUpRight size={12} aria-hidden="true" /></span>
            </span>
            <span className="collab-message-route"><code>{message.sender || '发送者未记录'}</code><ArrowRight size={12} aria-hidden="true" /><code>{message.taskName || '接收任务未记录'}</code></span>
            <span className="collab-message-preview">{message.preview || '消息没有正文预览。'}</span>
          </button>
        </li>)}
      </ol>
      <p className="collab-note">点击消息定位原轮次，再展开协作卡片阅读完整内容。</p>
    </>}
  </details>;
}

export function CollaborationView({ session, activity, onSelectSession, onNavigateTurn }: {
  session: SessionDetail;
  activity: SessionActivity;
  onSelectSession: (session: SessionSummary) => void;
  onNavigateTurn: (turnId: string) => void;
}) {
  return <section className="collaboration-view" aria-label="子代理协作视图">
    <div className="collab-view-heading"><UsersRound size={17} aria-hidden="true" /><h2>子代理协作</h2><span>{session.children.length} 个直接子会话</span></div>
    <details className="collab-section collab-relationships" open>
      <summary><ChevronRight size={14} aria-hidden="true" /><strong>会话关系</strong><span>父 → 当前 → 子</span></summary>
      <p className="collab-note">各会话用量独立展示，父子用量不相加。</p>
      <ol className="collab-session-tree">
        {session.parent ? <li><SessionNode value={session.parent} relation="父会话" onSelect={onSelectSession} /></li> : session.session.parentId && <li className="collab-missing-parent"><span>父会话尚未索引</span><code>{session.session.parentId}</code></li>}
        <li>
          <SessionNode value={session.session} relation="当前会话" current onSelect={onSelectSession} />
          {session.children.length > 0 ? <ul>{session.children.map(child => <li key={child.id}><SessionNode value={child} relation="子会话" onSelect={onSelectSession} /></li>)}</ul> : <p className="collab-empty"><GitBranch size={13} aria-hidden="true" />没有已索引的直接子会话。</p>}
        </li>
      </ol>
    </details>
    <MessageList key={session.session.id} messages={activity.messages} session={session} onNavigateTurn={onNavigateTurn} />
  </section>;
}
