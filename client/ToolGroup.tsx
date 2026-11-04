import { useCallback, useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react';
import { CircleX, Wrench } from 'lucide-react';
import type { ToolGroupEntry } from './tool-groups';
import type { ToolNavigationTarget } from './tool-navigation';
import { ToolCard } from './ToolCard';
import { toolGroupViewState, toolTabState } from './tool-view-state';
import { summarizeToolGroup } from './tool-group-summary';
import { RecordRow } from './RecordRow';
import { useRecordInspector } from './RecordInspector';
import './tool-groups.css';

export function ToolGroup({ group, turnId, sessionId, revision, target, preserveLayout, onSearchReady }: {
  group: ToolGroupEntry; turnId: string; sessionId: string; revision: string; target?: ToolNavigationTarget;
  preserveLayout?: (change: () => void) => void; onSearchReady?: () => void;
}) {
  const { inspect } = useRecordInspector();
  const groupId = `${turnId}:${group.id}`;
  useSyncExternalStore(
    useCallback(listener => toolGroupViewState.subscribe(sessionId, listener), [sessionId]),
    useCallback(() => toolGroupViewState.getSnapshot(sessionId), [sessionId]),
    () => 0,
  );
  const hasTarget = target && group.events.some(event => event.tool.id === target.toolId);
  const revealed = useRef<number | null>(null);
  const revealTarget = hasTarget && target.reveal && revealed.current !== target.version;
  const open = !!(revealTarget || toolGroupViewState.get(sessionId, groupId));
  const bodyId = useId();
  useEffect(() => {
    if (revealTarget) {
      revealed.current = target.version;
      toolGroupViewState.set(sessionId, groupId, true);
    }
  }, [revealTarget, target?.version, sessionId, groupId]);
  function toggle() {
    const change = () => toolGroupViewState.set(sessionId, groupId, !open);
    if (preserveLayout) preserveLayout(change); else change();
  }
  const summary = useMemo(() => summarizeToolGroup(group.events.map(event => event.tool)), [group.events]);
  const preview = summary.singlePreview ?? summary.categoryText;
  const failure = summary.firstFailure;
  function revealFailure() {
    if (!failure) return;
    const tool = group.events.find(event => event.tool.id === failure.toolId)!.tool;
    toolTabState.set(sessionId, tool.id, 'result');
    inspect({ kind: 'tool', tool, turnId, sessionId, revision });
  }
  const statusTitle = [group.counts.failed && `${group.counts.failed} 失败`, group.counts.running && `${group.counts.running} 运行中`, group.counts.unknown && `${group.counts.unknown} 结果未记录`, group.counts.completed && `${group.counts.completed} 已返回`].filter(Boolean).join(' · ');
  return <section className="record-group tool-group" data-tool-group-id={groupId}>
    <div className="record-group-heading" data-event-id={`tool-group-heading:${groupId}`} title={statusTitle}>
      <RecordRow icon={Wrench} title={`${group.events.length} 次工具调用`} preview={preview} expanded={!!open} controls={bodyId} onClick={toggle}
        meta={<span className="tool-group-counts">
              {group.counts.running > 0 && <span className="tool-group-running">{group.counts.running} 运行中</span>}
              {group.counts.unknown > 0 && <span className="tool-group-unknown">{group.counts.unknown} 结果未记录</span>}
              {group.counts.completed > 0 && group.counts.completed < group.events.length && <span>{group.counts.completed} 已返回</span>}
        </span>} />
      {failure && <button type="button" className="tool-group-failure-action" aria-label={`查看本组首条失败调用：${failure.title}，共 ${group.counts.failed} 次失败`} title={failure.preview} onClick={revealFailure}><CircleX size={13} aria-hidden="true" /><span>{group.counts.failed} 失败</span></button>}
    </div>
    {!open && failure && <p className="tool-group-diagnostic" title={failure.preview}>{failure.preview}</p>}
    <div id={bodyId} className="record-group-entries" hidden={!open}>
      {open && group.events.map(event => <ToolCard key={event.tool.id} eventId={event.id} tool={event.tool} turnId={turnId} sessionId={sessionId} revision={revision}
        searchTarget={hasTarget && target.toolId === event.tool.id ? target : undefined} onSearchReady={onSearchReady}
        />)}
    </div>
  </section>;
}
