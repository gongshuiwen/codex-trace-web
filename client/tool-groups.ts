import type { TimelineEvent, ToolCall } from '../shared/types';

export interface ToolGroupEntry {
  kind: 'tool-group';
  id: string;
  events: (TimelineEvent & { tool: ToolCall })[];
  counts: Record<ToolCall['status'], number>;
}
export type ToolTimelineEntry = TimelineEvent | ToolGroupEntry;

/** Keep the original order and break a group at every non-tool event. */
export function groupAdjacentTools(events: TimelineEvent[]): ToolTimelineEntry[] {
  const entries: ToolTimelineEntry[] = [];
  let pending: (TimelineEvent & { tool: ToolCall })[] = [];
  function flush() {
    if (pending.length > 0) {
      const counts = { running: 0, completed: 0, failed: 0, unknown: 0 };
      for (const event of pending) counts[event.tool.status]++;
      entries.push({ kind: 'tool-group', id: pending[0].tool.id, events: pending, counts });
    }
    pending = [];
  }
  for (const event of events) {
    if (event.kind === 'tool' && event.tool) pending.push(event as TimelineEvent & { tool: ToolCall });
    else { flush(); entries.push(event); }
  }
  flush();
  return entries;
}
