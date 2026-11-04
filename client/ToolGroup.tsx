import { useCallback, useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronRight, CircleX, Layers3 } from 'lucide-react';
import type { ToolGroupEntry } from './tool-groups';
import type { ToolNavigationTarget } from './tool-navigation';
import { ToolCard } from './ToolCard';
import { toolGroupViewState, toolViewState } from './tool-view-state';
import { summarizeToolGroup } from './tool-group-summary';
import './tool-groups.css';

export function ToolGroup({ group, turnId, sessionId, revision, target, preserveLayout, onSearchReady }: {
  group: ToolGroupEntry; turnId: string; sessionId: string; revision: string; target?: ToolNavigationTarget;
  preserveLayout?: (change: () => void) => void; onSearchReady?: () => void;
}) {
  const groupId = `${turnId}:${group.id}`;
  useSyncExternalStore(
    useCallback(listener => toolGroupViewState.subscribe(sessionId, listener), [sessionId]),
    useCallback(() => toolGroupViewState.getSnapshot(sessionId), [sessionId]),
    () => 0,
  );
  const hasTarget = target && group.events.some(event => event.tool.id === target.toolId);
  const revealed = useRef<number | null>(null);
  const revealTarget = hasTarget && target.reveal && revealed.current !== target.version;
  const open = revealTarget || toolGroupViewState.get(sessionId, groupId)?.open || false;
  const bodyId = useId();
  useEffect(() => {
    if (revealTarget) {
      revealed.current = target.version;
      toolGroupViewState.set(sessionId, groupId, { open: true, tab: 'result' });
    }
  }, [revealTarget, target?.version, sessionId, groupId]);
  function toggle() {
    const change = () => toolGroupViewState.set(sessionId, groupId, { open: !open, tab: 'result' });
    if (preserveLayout) preserveLayout(change); else change();
  }
  const summary = useMemo(() => summarizeToolGroup(group.events.map(event => event.tool)), [group.events]);
  const preview = summary.singlePreview ?? summary.categoryText;
  const failure = summary.firstFailure;
  function revealFailure() {
    if (!failure) return;
    const change = () => {
      toolViewState.set(sessionId, failure.toolId, { open: true, tab: 'result' });
      toolGroupViewState.set(sessionId, groupId, { open: true, tab: 'result' });
    };
    if (preserveLayout) preserveLayout(change); else change();
    requestAnimationFrame(() => {
      const card = Array.from(document.querySelectorAll<HTMLElement>('[data-tool-id]')).find(item => item.dataset.toolId === failure.toolId);
      card?.querySelector<HTMLButtonElement>('.tool-call-row')?.focus({ preventScroll: true });
    });
  }
  const statusTitle = [group.counts.failed && `${group.counts.failed} 失败`, group.counts.running && `${group.counts.running} 运行中`, group.counts.unknown && `${group.counts.unknown} 结果未记录`, group.counts.completed && `${group.counts.completed} 已返回`].filter(Boolean).join(' · ');
  return <section className="tool-group" data-tool-group-id={groupId}>
    <div className="tool-group-heading">
      <button type="button" className="tool-group-toggle" data-event-id={`tool-group-heading:${groupId}`} onClick={toggle} aria-expanded={open} aria-controls={bodyId} title={statusTitle}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Layers3 size={14} />
        <span className="tool-group-label">
          <span className="tool-group-main">
            <span className="tool-group-title">{group.events.length} 次工具调用</span>
            <span className="tool-group-counts">
              {group.counts.running > 0 && <span className="tool-group-running">{group.counts.running} 运行中</span>}
              {group.counts.unknown > 0 && <span className="tool-group-unknown">{group.counts.unknown} 结果未记录</span>}
              {group.counts.completed > 0 && <span>{group.counts.completed} 已返回</span>}
            </span>
          </span>
          {preview && <span className="tool-group-preview" title={preview}>{preview}</span>}
        </span>
      </button>
      {failure && <button type="button" className="tool-group-failure-action" aria-label={`展开本组首条失败调用：${failure.title}，共 ${group.counts.failed} 次失败`} title={failure.preview} onClick={revealFailure}><CircleX size={13} aria-hidden="true" /><span>{group.counts.failed} 失败</span></button>}
    </div>
    {!open && failure && <p className="tool-group-diagnostic" title={failure.preview}><span>首条失败</span><span>{failure.preview}</span></p>}
    <div id={bodyId} className="tool-group-tools" hidden={!open}>
      {open && group.events.map(event => <ToolCard key={event.tool.id} eventId={event.id} tool={event.tool} sessionId={sessionId} revision={revision} preserveLayout={preserveLayout}
        searchTarget={hasTarget && target.toolId === event.tool.id ? target : undefined} onSearchReady={onSearchReady}
        />)}
    </div>
  </section>;
}
