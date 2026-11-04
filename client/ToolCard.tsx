import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react';
import { Braces, Check, ChevronDown, CircleHelp, CircleX, FileDiff, GitBranch, Globe, LoaderCircle, Terminal, Wrench } from 'lucide-react';
import type { ToolCall } from '../shared/types';
import { toolPresentation } from './tool-presentation';
import type { ToolNavigationTarget } from './tool-navigation';
import { ToolContent } from './ToolContent';
import { toolViewState } from './tool-view-state';
import './tool-card.css';
import './tool-groups.css';

const icons = { command: Terminal, mcp: Wrench, patch: FileDiff, web: Globe, agent: GitBranch, other: Braces };

function ToolState({ tool }: { tool: ToolCall }) {
  if (tool.status === 'running') return <span className="tool-call-state running"><LoaderCircle size={13} className="spin" />运行中</span>;
  if (tool.status === 'failed') return <span className="tool-call-state failed" title={tool.exitCode != null ? `失败 · 退出码 ${tool.exitCode}` : undefined}><CircleX size={13} />失败</span>;
  if (tool.status === 'unknown') return <span className="tool-call-state unknown"><CircleHelp size={13} />结果未记录</span>;
  return <span className="tool-call-state completed" title={tool.exitCode === 0 ? '完成 · 退出码 0' : undefined}><Check size={13} />{tool.exitCode === 0 ? '完成' : '已返回'}</span>;
}

export function ToolCard({ tool, eventId, sessionId, revision, preserveLayout, searchTarget, onSearchReady }: {
  tool: ToolCall; eventId?: string; sessionId: string; revision: string; preserveLayout?: (change: () => void) => void;
  searchTarget?: ToolNavigationTarget; onSearchReady?: () => void;
}) {
  const presentation = useMemo(() => toolPresentation(tool), [tool.name, tool.category, tool.arguments, tool.output, tool.outputTruncated, tool.status, tool.exitCode]);
  const Icon = icons[presentation.category];
  const bodyId = useId();
  const revealed = useRef<number | null>(null);
  useSyncExternalStore(toolViewState.subscribe, toolViewState.getSnapshot, () => 0);
  const reveal = searchTarget?.reveal && revealed.current !== searchTarget.version;
  const open = reveal || toolViewState.get(sessionId, tool.id)?.open || false;
  useEffect(() => {
    if (!reveal || !searchTarget) return;
    revealed.current = searchTarget.version;
    toolViewState.set(sessionId, tool.id, { open: true, tab: searchTarget.location?.field === 'arguments' ? 'arguments' : searchTarget.location ? 'raw' : 'result' });
    if (!searchTarget.location) onSearchReady?.();
  }, [reveal, searchTarget?.version, sessionId, tool.id, onSearchReady]);
  function toggle() {
    const change = () => toolViewState.set(sessionId, tool.id, { open: !open, tab: toolViewState.get(sessionId, tool.id)?.tab ?? 'result' });
    if (preserveLayout) preserveLayout(change); else change();
  }
  const targetClass = searchTarget?.kind === 'failure' ? tool.status === 'failed' ? 'tool-failure-target' : '' : searchTarget ? 'tool-search-target' : '';
  return <div className={`tool-card tool-summary-card tool-row ${targetClass}`} data-tool-id={tool.id} data-event-id={eventId}>
    <button type="button" className="tool-call-row" onClick={toggle} aria-expanded={open} aria-controls={bodyId} aria-label={`${open ? '收起' : '展开'} ${presentation.title} 调用详情`}>
      <Icon size={15} className="tool-call-icon" />
      <span className="tool-call-label" title={`${presentation.title} · ${presentation.subtitle || tool.name}`}>
        <span className="tool-call-title">{presentation.title}</span>
        <span className="tool-call-subtitle">{presentation.subtitle || tool.name}</span>
      </span>
      <ToolState tool={tool} /><ChevronDown size={13} className="tool-row-detail-icon" aria-hidden="true" />
    </button>
    <div id={bodyId} hidden={!open}>{open && <>
      <ToolContent key={`${tool.id}:${searchTarget?.version ?? ''}`} tool={tool} sessionId={sessionId} revision={revision} search={searchTarget?.location} navigationId={searchTarget?.version} onReady={onSearchReady} preserveLayout={preserveLayout} />
      <details className="tool-call-info"><summary>调用信息</summary><dl><div><dt>工具</dt><dd>{tool.name}</dd></div><div><dt>调用 ID</dt><dd>{tool.id}</dd></div></dl></details>
    </>}</div>
  </div>;
}
