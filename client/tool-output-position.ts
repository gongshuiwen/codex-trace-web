import { TOOL_OUTPUT_WINDOW_LIMIT } from './tool-output-window';

export const TOOL_OUTPUT_POSITION_KEY = 'session-lens-tool-output-position-v1';
export const MAX_TOOL_OUTPUT_POSITIONS = 500;
type Tab = 'result' | 'arguments' | 'raw';
export interface ToolOutputPosition {
  sessionId: string; toolId: string; offset: number; length: number; scroll: Partial<Record<Tab, number>>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function position(value: unknown): ToolOutputPosition | null {
  const entry = object(value);
  if (!entry || typeof entry.sessionId !== 'string' || typeof entry.toolId !== 'string'
    || !entry.sessionId.length || !entry.toolId.length || entry.sessionId.length > 256 || entry.toolId.length > 256
    || /[\u0000-\u001f\u007f]/.test(entry.sessionId + entry.toolId)
    || !Number.isSafeInteger(entry.offset) || (entry.offset as number) < 0
    || !Number.isSafeInteger(entry.length) || (entry.length as number) < 0 || (entry.length as number) > TOOL_OUTPUT_WINDOW_LIMIT
    || !Number.isSafeInteger((entry.offset as number) + (entry.length as number))) return null;
  const scroll = object(entry.scroll);
  if (!scroll || Object.keys(scroll).some(key => !['result', 'arguments', 'raw'].includes(key))) return null;
  const clean: Partial<Record<Tab, number>> = {};
  for (const tab of ['result', 'arguments', 'raw'] as const) {
    const top = scroll[tab];
    if (top === undefined) continue;
    if (typeof top !== 'number' || !Number.isFinite(top) || top < 0 || top > 1_000_000_000) return null;
    clean[tab] = top;
  }
  return { sessionId: entry.sessionId, toolId: entry.toolId, offset: entry.offset as number, length: entry.length as number, scroll: clean };
}

function normalized(values: unknown[]): ToolOutputPosition[] {
  const entries = new Map<string, ToolOutputPosition>();
  for (const value of values) {
    const valid = position(value);
    if (!valid) continue;
    const key = JSON.stringify([valid.sessionId, valid.toolId]);
    entries.delete(key); entries.set(key, valid);
    while (entries.size > MAX_TOOL_OUTPUT_POSITIONS) entries.delete(entries.keys().next().value!);
  }
  return Array.from(entries.values());
}

/** Restore only bounded location metadata; log text is never serialized. */
export function parseToolOutputPositions(raw: string | null): ToolOutputPosition[] {
  if (!raw || raw.length > 1_048_576) return [];
  try {
    const value = object(JSON.parse(raw));
    return value?.version === 1 && Array.isArray(value.entries) ? normalized(value.entries) : [];
  } catch { return []; }
}

export function serializeToolOutputPositions(entries: readonly ToolOutputPosition[]): string {
  return JSON.stringify({ version: 1, entries: normalized([...entries]) });
}
