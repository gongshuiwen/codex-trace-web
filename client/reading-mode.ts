import type { TimelineEvent } from '../shared/types';
import type { ContextGroup } from './event-presentation';
import type { ToolTimelineEntry } from './tool-groups';

export type ReadingTimelineEntry = ToolTimelineEntry | ContextGroup;

export interface ReadingProcessGroup {
  kind: 'reading-process';
  id: string;
  entries: ReadingTimelineEntry[];
}

export type ReadingModeEntry = ReadingTimelineEntry | ReadingProcessGroup;

/** Keep each recorded boundary visible, wrapping only consecutive process entries. */
export function groupReadingProcess(entries: readonly ReadingTimelineEntry[]): ReadingModeEntry[] {
  const result: ReadingModeEntry[] = [];
  let pending: ReadingProcessGroup | undefined;
  for (const entry of entries) {
    if (entry.kind === 'user' || entry.kind === 'assistant' || entry.kind === 'notice') {
      pending = undefined;
      result.push(entry);
    } else {
      if (!pending) {
        pending = { kind: 'reading-process', id: entry.id, entries: [] };
        result.push(pending);
      }
      pending.entries.push(entry);
    }
  }
  return result;
}

export function readingProcessSummary(group: ReadingProcessGroup): string {
  let tools = 0; let commentary = 0; let reasoning = 0; let contexts = 0; let collaboration = 0; let other = 0;
  for (const entry of group.entries) {
    if (entry.kind === 'tool-group') tools += entry.events.length;
    else if (entry.kind === 'tool') tools++;
    else if (entry.kind === 'commentary') commentary++;
    else if (entry.kind === 'reasoning') reasoning++;
    else if (entry.kind === 'context-group') contexts += entry.events.length;
    else if (entry.kind === 'context') contexts++;
    else if (entry.kind === 'collaboration') collaboration++;
    else other++;
  }
  return [
    tools && `${tools} 次工具调用`, commentary && `${commentary} 条说明`, reasoning && `${reasoning} 条推理摘要`,
    contexts && `${contexts} 项上下文`, collaboration && `${collaboration} 条协作记录`, other && `${other} 条其他记录`,
  ].filter(Boolean).join(' · ');
}

export function readingProcessToolStates(group: ReadingProcessGroup): { failed: number; running: number; unknown: number } {
  const counts = { failed: 0, running: 0, unknown: 0 };
  for (const entry of group.entries) {
    if (entry.kind === 'tool-group') {
      counts.failed += entry.counts.failed; counts.running += entry.counts.running; counts.unknown += entry.counts.unknown;
    } else if (entry.kind === 'tool' && entry.tool && entry.tool.status !== 'completed') counts[entry.tool.status]++;
  }
  return counts;
}

export function readingProcessHasTool(group: ReadingProcessGroup, toolId: string): boolean {
  return group.entries.some(entry => entry.kind === 'tool-group'
    ? entry.events.some(event => event.tool.id === toolId)
    : entry.kind === 'tool' && entry.tool?.id === toolId);
}

/** Expose one live progress message without moving it across a user/final/notice boundary. */
export function latestReadingCommentary(entries: readonly ReadingModeEntry[]): { groupId: string; event: TimelineEvent } | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.kind !== 'reading-process') continue;
    for (let processIndex = entry.entries.length - 1; processIndex >= 0; processIndex--) {
      const event = entry.entries[processIndex]!;
      if (event.kind === 'commentary' && event.text.trim()) return { groupId: entry.id, event };
    }
  }
  return undefined;
}

export function readingProcessStateKey(turnId: string, groupId: string): string {
  return `reading-process:${JSON.stringify([turnId, groupId])}`;
}
