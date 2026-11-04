import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, ChevronDown, ChevronUp, X } from 'lucide-react';
import type { TurnSummary } from '../shared/types';
import { clock, dateGroup, statusLabels } from './format';
import { useOverlayFocus } from './useOverlayFocus';
import './turn-directory.css';

export interface TurnDirectoryProps {
  turns: TurnSummary[];
  activeTurnId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function TurnDirectory({ turns, activeTurnId, onSelect, onClose }: TurnDirectoryProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLElement>(null);
  const initialFocus = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const foundIndex = turns.findIndex(turn => turn.id === activeTurnId);
  const activeIndex = foundIndex < 0 ? 0 : foundIndex;
  const selectedId = turns[activeIndex]?.id;
  useOverlayFocus({ container: panel, initialFocus, modal: true, onClose });

  useEffect(() => {
    const row = initialFocus.current;
    const viewport = list.current;
    if (!row || !viewport || !viewport.contains(row)) return;
    const bounds = viewport.getBoundingClientRect();
    const current = row.getBoundingClientRect();
    if (current.top < bounds.top || current.bottom > bounds.bottom) {
      viewport.scrollTop += current.top - bounds.top - (viewport.clientHeight - current.height) / 2;
    }
  }, [selectedId]);

  function selectTurn(id: string | undefined) {
    if (!id) return;
    onSelect(id);
    onClose();
  }

  return createPortal(<div className="turn-directory-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} id="turn-directory-dialog" className="turn-directory" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
      <div className="turn-directory-heading">
        <div>
          <h2 id={titleId}>轮次目录</h2>
          <p id={descriptionId}>{turns.length ? `共 ${turns.length.toLocaleString()} 轮 · 当前第 ${(turns[activeIndex]!.index + 1).toLocaleString()} 轮` : '当前会话还没有可展示的轮次'}</p>
        </div>
        <button ref={turns.length ? undefined : initialFocus} type="button" className="icon-button" aria-label="关闭轮次目录" onClick={onClose}><X size={18} aria-hidden="true" /></button>
      </div>
      {turns.length ? <ol ref={list} className="turn-directory-list" aria-label="会话轮次">
        {turns.map(turn => {
          const title = turn.prompt.split(/\r\n?|\n/).find(line => line.trim())?.trim() || '此轮没有用户文本';
          const selected = turn.id === selectedId;
          return <li key={turn.id}>
            <button ref={selected ? initialFocus : undefined} type="button" className="turn-directory-row" aria-current={selected ? 'true' : undefined} onClick={() => selectTurn(turn.id)}>
              <span className="turn-directory-number" aria-label={`第 ${turn.index + 1} 轮`}>{String(turn.index + 1).padStart(2, '0')}</span>
              <span className="turn-directory-content">
                <span className="turn-directory-prompt" title={title}>{title}</span>
                <span className="turn-directory-meta">
                  <time dateTime={turn.startedAt}>{dateGroup(turn.startedAt)} · {clock(turn.startedAt)}</time>
                  <span className={`turn-directory-status ${turn.status}`}><span aria-hidden="true" />{statusLabels[turn.status]}</span>
                </span>
              </span>
            </button>
          </li>;
        })}
      </ol> : <div className="turn-directory-empty">新的用户请求会出现在这里。</div>}
      <div className="turn-directory-actions" aria-label="轮次导航">
        <button type="button" disabled={!turns.length || activeIndex === 0} onClick={() => selectTurn(turns[activeIndex - 1]?.id)}><ChevronUp size={15} aria-hidden="true" />上一轮</button>
        <button type="button" disabled={!turns.length || activeIndex >= turns.length - 1} onClick={() => selectTurn(turns[activeIndex + 1]?.id)}>下一轮<ChevronDown size={15} aria-hidden="true" /></button>
        <button type="button" disabled={!turns.length || activeIndex >= turns.length - 1} onClick={() => selectTurn(turns.at(-1)?.id)}><ArrowDownToLine size={15} aria-hidden="true" />最新</button>
      </div>
    </section>
  </div>, document.body);
}
