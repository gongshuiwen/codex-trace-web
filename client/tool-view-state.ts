export type ToolViewState = { open: boolean; tab: 'result' | 'arguments' | 'raw' };
type StateStorage = Pick<Storage, 'getItem' | 'setItem'>;

const TOOL_STATE_KEY = 'session-lens-tool-view-v1';
const GROUP_STATE_KEY = 'session-lens-tool-group-view-v1';

function validKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parts: unknown = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 2 && parts.every(part => typeof part === 'string');
  } catch { return false; }
}

function validState(value: unknown): value is ToolViewState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.open === 'boolean' && ['result', 'arguments', 'raw'].includes(state.tab as string)
    && Object.keys(state).every(key => key === 'open' || key === 'tab');
}

function storedEntries(storage: StateStorage | undefined, storageKey: string): [string, ToolViewState][] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const saved = value as Record<string, unknown>;
    if (saved.version !== 1 || !Array.isArray(saved.entries)) return [];
    if (!saved.entries.every(item => Array.isArray(item) && item.length === 2 && validKey(item[0]) && validState(item[1]))) return [];
    return saved.entries as [string, ToolViewState][];
  } catch { return []; }
}

function safeSessionStorage(): StateStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}

/** Retain bounded manual choices across remounts and optional refreshes, without storing log content. */
export function createToolViewStateStore(limit = 500, storage?: StateStorage, storageKey = TOOL_STATE_KEY) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Tool view state limit must be a positive integer');
  const entries = new Map<string, ToolViewState>();
  const key = (sessionId: string, toolId: string) => JSON.stringify([sessionId, toolId]);
  for (const [id, state] of storedEntries(storage, storageKey)) {
    entries.delete(id);
    entries.set(id, { open: state.open, tab: state.tab });
  }
  function trim() {
    while (entries.size > limit) entries.delete(entries.keys().next().value!);
  }
  trim();
  function save() {
    try { storage?.setItem(storageKey, JSON.stringify({ version: 1, entries: [...entries] })); }
    catch { /* Disabled or full browser storage must not interrupt timeline reading. */ }
  }
  return {
    get(sessionId: string, toolId: string): ToolViewState | undefined {
      const id = key(sessionId, toolId);
      const state = entries.get(id);
      if (!state) return undefined;
      entries.delete(id);
      entries.set(id, state);
      return { ...state };
    },
    set(sessionId: string, toolId: string, state: ToolViewState): void {
      const id = key(sessionId, toolId);
      entries.delete(id);
      entries.set(id, { open: state.open, tab: state.tab });
      trim();
      save();
    },
  };
}

interface StoredGroupState { entries: [string, ToolViewState][]; sessions: [string, boolean][] }

function storedGroupState(storage: StateStorage | undefined, storageKey: string): StoredGroupState {
  const empty = { entries: [], sessions: [] };
  if (!storage) return empty;
  try {
    const value: unknown = JSON.parse(storage.getItem(storageKey) || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
    const saved = value as Record<string, unknown>;
    if ((saved.version !== 1 && saved.version !== 2) || !Array.isArray(saved.entries)
      || !saved.entries.every(item => Array.isArray(item) && item.length === 2 && validKey(item[0]) && validState(item[1]))) return empty;
    if (saved.version === 1) return { entries: saved.entries as [string, ToolViewState][], sessions: [] };
    if (!Array.isArray(saved.sessions)
      || !saved.sessions.every(item => Array.isArray(item) && item.length === 2 && typeof item[0] === 'string' && typeof item[1] === 'boolean')) return empty;
    return { entries: saved.entries as [string, ToolViewState][], sessions: saved.sessions as [string, boolean][] };
  } catch { return empty; }
}

/** Session defaults reach unmounted groups; later manual choices override only their own group. */
export function createToolGroupViewStateStore(limit = 200, storage?: StateStorage, storageKey = GROUP_STATE_KEY, sessionLimit = 40) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(sessionLimit) || sessionLimit < 1) throw new RangeError('Group state limits must be positive integers');
  const saved = storedGroupState(storage, storageKey);
  const entries = new Map(saved.entries.map(([id, state]) => [id, { open: state.open, tab: state.tab }]));
  const sessions = new Map(saved.sessions);
  const listeners = new Map<string, Set<() => void>>();
  const revisions = new Map<string, number>();
  let revision = 0;
  const key = (sessionId: string, groupId: string) => JSON.stringify([sessionId, groupId]);
  const owner = (id: string): string => (JSON.parse(id) as [string, string])[0];

  function trim(affected?: Set<string>) {
    while (entries.size > limit) {
      const oldest = entries.keys().next().value!;
      affected?.add(owner(oldest)); entries.delete(oldest);
    }
    while (sessions.size > sessionLimit) {
      const oldest = sessions.keys().next().value!;
      affected?.add(oldest); sessions.delete(oldest);
    }
  }
  trim();
  function save() {
    try { storage?.setItem(storageKey, JSON.stringify({ version: 2, entries: [...entries], sessions: [...sessions] })); }
    catch { /* The in-memory bulk choice still works when browser storage is unavailable. */ }
  }
  function trimRevisions() {
    // Active subscribers keep their snapshot stable; idle-session versions need no persistence.
    for (const id of revisions.keys()) {
      if (revisions.size <= limit + sessionLimit + listeners.size) break;
      if (!listeners.has(id)) revisions.delete(id);
    }
  }
  function notify(affected: Set<string>) {
    for (const sessionId of affected) {
      revisions.delete(sessionId); revisions.set(sessionId, ++revision);
      for (const listener of [...(listeners.get(sessionId) ?? [])]) listener();
    }
    trimRevisions();
  }
  function touchSession(sessionId: string) {
    const value = sessions.get(sessionId);
    if (value !== undefined) { sessions.delete(sessionId); sessions.set(sessionId, value); }
  }
  return {
    get(sessionId: string, groupId: string): ToolViewState | undefined {
      const id = key(sessionId, groupId);
      const state = entries.get(id);
      touchSession(sessionId);
      if (state) {
        entries.delete(id); entries.set(id, state);
        return { ...state };
      }
      const open = sessions.get(sessionId);
      return open === undefined ? undefined : { open, tab: 'result' };
    },
    set(sessionId: string, groupId: string, state: ToolViewState): void {
      const id = key(sessionId, groupId);
      entries.delete(id); entries.set(id, { open: state.open, tab: state.tab });
      touchSession(sessionId);
      const affected = new Set([sessionId]); trim(affected); save(); notify(affected);
    },
    setAll(sessionId: string, open: boolean): void {
      for (const id of entries.keys()) if (owner(id) === sessionId) entries.delete(id);
      sessions.delete(sessionId); sessions.set(sessionId, open);
      const affected = new Set([sessionId]); trim(affected); save(); notify(affected);
    },
    subscribe(sessionId: string, listener: () => void): () => void {
      const callbacks = listeners.get(sessionId) ?? new Set<() => void>();
      callbacks.add(listener); listeners.set(sessionId, callbacks);
      return () => {
        callbacks.delete(listener);
        if (!callbacks.size) listeners.delete(sessionId);
        trimRevisions();
      };
    },
    getSnapshot(sessionId: string): number { return revisions.get(sessionId) ?? 0; },
  };
}

export const toolViewState = createToolViewStateStore(500, safeSessionStorage(), TOOL_STATE_KEY);
export const toolGroupViewState = createToolGroupViewStateStore(200, safeSessionStorage(), GROUP_STATE_KEY);
