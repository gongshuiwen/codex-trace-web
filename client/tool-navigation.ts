import type { CompactionItem, ToolFailureItem, ToolSearchLocation, ToolSearchMatch } from '../shared/types';

export interface ToolNavigationTarget {
  turnId: string;
  toolId: string;
  eventId: string;
  location?: ToolSearchLocation;
  kind?: 'search' | 'failure';
  version: number;
  reveal: boolean;
}

export interface CompactionNavigationTarget extends CompactionItem {
  version: number;
}

let navigationSequence = 0;
export function nextToolNavigationId() { return ++navigationSequence; }

export function toolSearchTarget(match: ToolSearchMatch, query: string, version: number): ToolNavigationTarget {
  return { turnId: match.turnId, toolId: match.toolId, eventId: match.eventId,
    location: { field: match.field, offset: match.offset, length: match.length, query, matchedText: match.matchedText }, kind: 'search', version, reveal: true };
}

export function toolFailureTarget(item: ToolFailureItem, version: number): ToolNavigationTarget {
  return { ...item, kind: 'failure', version, reveal: true };
}
