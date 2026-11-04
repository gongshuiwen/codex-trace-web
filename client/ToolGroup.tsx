import { useCallback, useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronRight, CircleX, Layers3 } from 'lucide-react';
import type { ToolGroupEntry } from './tool-groups';
import type { ToolNavigationTarget } from './tool-navigation';
import type { Inspection } from './TurnCard';
import { ToolCard } from './ToolCard';
import { toolGroupViewState } from './tool-view-state';
import { summarizeToolGroup } from './tool-group-summary';
import './tool-groups.css';

export function ToolGroup({ group, turnId, sessionId, target, onInspect, preserveLayout, onSearchReady }: {
  group: ToolGroupEntry; turnId: string; sessionId: string; target?: ToolNavigationTarget;
  onInspect: (selection: Inspection) => void; preserveLayout?: (change: () => void) => void; onSearchReady?: () => void;
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
      {failure && <button type="button" className="tool-group-failure-action" aria-haspopup="dialog" aria-label={`查看本组首条失败调用：${failure.title}，共 ${group.counts.failed} 次失败`} title={failure.preview} onClick={() => onInspect({ turnId, toolId: failure.toolId })}><CircleX size={13} aria-hidden="true" /><span>{group.counts.failed} 失败</span></button>}
    </div>
    {!open && failure && <p className="tool-group-diagnostic" title={failure.preview}><span>首条失败</span><span>{failure.preview}</span></p>}
    <div id={bodyId} className="tool-group-tools" hidden={!open}>
      {open && group.events.map(event => <ToolCard key={event.tool.id} eventId={event.id} tool={event.tool}
        searchTarget={hasTarget && target.toolId === event.tool.id ? target : undefined} onSearchReady={onSearchReady}
        onInspect={() => onInspect({ turnId, toolId: event.tool.id, ...(hasTarget && target.toolId === event.tool.id ? { search: target.location, navigationId: target.version } : {}) })} />)}
    </div>
  </section>;
}
