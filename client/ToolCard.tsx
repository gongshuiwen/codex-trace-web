import { useEffect, useMemo } from 'react';
import { Braces, Check, CircleHelp, CircleX, FileDiff, GitBranch, Globe, LoaderCircle, Maximize2, Terminal, Wrench } from 'lucide-react';
import type { ToolCall } from '../shared/types';
import { toolPresentation } from './tool-presentation';
import type { ToolNavigationTarget } from './tool-navigation';
import './tool-card.css';
import './tool-groups.css';

const icons = { command: Terminal, mcp: Wrench, patch: FileDiff, web: Globe, agent: GitBranch, other: Braces };

function ToolState({ tool }: { tool: ToolCall }) {
  if (tool.status === 'running') return <span className="tool-call-state running"><LoaderCircle size={13} className="spin" />运行中</span>;
  if (tool.status === 'failed') return <span className="tool-call-state failed" title={tool.exitCode != null ? `失败 · 退出码 ${tool.exitCode}` : undefined}><CircleX size={13} />失败</span>;
  if (tool.status === 'unknown') return <span className="tool-call-state unknown"><CircleHelp size={13} />结果未记录</span>;
  return <span className="tool-call-state completed" title={tool.exitCode === 0 ? '完成 · 退出码 0' : undefined}><Check size={13} />{tool.exitCode === 0 ? '完成' : '已返回'}</span>;
}

/** One compact row for every call; full content lives in the detail panel. */
export function ToolCard({ tool, eventId, onInspect, searchTarget, onSearchReady }: {
  tool: ToolCall; eventId?: string; onInspect: () => void;
  searchTarget?: ToolNavigationTarget; onSearchReady?: () => void;
}) {
  const presentation = useMemo(() => toolPresentation(tool), [tool.name, tool.category, tool.arguments, tool.output, tool.outputTruncated, tool.status, tool.exitCode]);
  const Icon = icons[presentation.category];
  useEffect(() => {
    if (searchTarget?.reveal) onSearchReady?.();
  }, [searchTarget?.version, searchTarget?.reveal, onSearchReady]);
  const targetClass = searchTarget?.kind === 'failure' ? tool.status === 'failed' ? 'tool-failure-target' : '' : searchTarget ? 'tool-search-target' : '';
  return <div className={`tool-card tool-summary-card tool-row ${targetClass}`} data-tool-id={tool.id} data-event-id={eventId}>
    <button type="button" className="tool-call-row" onClick={onInspect} aria-haspopup="dialog" aria-label={`查看 ${presentation.title} 调用详情`}>
      <Icon size={15} className="tool-call-icon" />
      <span className="tool-call-label" title={`${presentation.title} · ${presentation.subtitle || tool.name}`}>
        <span className="tool-call-title">{presentation.title}</span>
        <span className="tool-call-subtitle">{presentation.subtitle || tool.name}</span>
      </span>
      <ToolState tool={tool} /><Maximize2 size={13} className="tool-row-detail-icon" aria-hidden="true" />
    </button>
  </div>;
}
