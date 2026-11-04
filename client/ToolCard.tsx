import { useEffect, useRef } from 'react';
import { Braces, FileDiff, GitBranch, Globe, Terminal, Wrench } from 'lucide-react';
import type { ToolCall } from '../shared/types';
import { toolPresentation } from './tool-presentation';
import type { ToolNavigationTarget } from './tool-navigation';
import { RecordRow } from './RecordRow';
import { recordSelectionKey, useRecordInspector, type RecordSelection } from './RecordInspector';
import { ToolStatus } from './ToolStatus';
import './tool-card.css';

const icons = { command: Terminal, mcp: Wrench, patch: FileDiff, web: Globe, agent: GitBranch, other: Braces };

export function ToolCard({ tool, eventId, turnId, sessionId, revision, searchTarget, onSearchReady }: {
  tool: ToolCall; eventId?: string; turnId: string; sessionId: string; revision: string;
  searchTarget?: ToolNavigationTarget; onSearchReady?: () => void;
}) {
  const { selection, inspect } = useRecordInspector();
  const revealed = useRef<number | null>(null);
  const presentation = toolPresentation(tool);
  const record: RecordSelection = { kind: 'tool', tool, turnId, sessionId, revision, search: searchTarget?.location, navigationId: searchTarget?.version };
  useEffect(() => {
    if (!searchTarget?.reveal || revealed.current === searchTarget.version) return;
    revealed.current = searchTarget.version;
    inspect({ kind: 'tool', tool, turnId, sessionId, revision, search: searchTarget.location, navigationId: searchTarget.version });
    onSearchReady?.();
  }, [searchTarget?.version, searchTarget?.reveal, inspect, tool, turnId, sessionId, revision, onSearchReady]);
  const targetClass = searchTarget?.kind === 'failure' ? tool.status === 'failed' ? 'tool-failure-target' : '' : searchTarget ? 'tool-search-target' : '';
  return <div className={`tool-card ${targetClass}`.trim()} data-tool-id={tool.id} data-event-id={eventId}>
    <RecordRow icon={icons[presentation.category]} title={presentation.title} preview={presentation.subtitle || tool.name}
      label={`查看 ${presentation.title} 调用详情`} meta={<ToolStatus tool={tool} />}
      selected={!!selection && recordSelectionKey(selection) === recordSelectionKey(record)} onClick={() => inspect(record)} />
  </div>;
}
