export type ToolTab = 'result' | 'arguments' | 'raw';
type StateStorage = Pick<Storage, 'getItem' | 'setItem'>;

// Keep storage keys stable so existing reading preferences can be migrated.
const TOOL_STATE_KEY = 'session-lens-tool-view-v1';
const GROUP_STATE_KEY = 'session-lens-tool-group-view-v1';

function validKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parts: unknown = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 2 && parts.every(part => typeof part === 'string');
  } catch { return false; }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function storedState(storage: StateStorage | undefined, storageKey: string) {
  try { return object(JSON.parse(storage?.getItem(storageKey) || 'null')); } catch { return {}; }
}

function storedEntries<T>(value: unknown, parse: (value: unknown) => T | undefined): [string, T][] | null {
  if (!Array.isArray(value)) return null;
  const entries: [string, T][] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || !validKey(item[0])) return null;
    const state = parse(item[1]);
    if (state === undefined) return null;
    entries.push([item[0], state]);
  }
  return entries;
}

function safeSessionStorage(): StateStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}

/** Persist only the selected tab; individual records no longer expand in the timeline. */
export function createToolTabStore(limit = 500, storage?: StateStorage, storageKey = TOOL_STATE_KEY) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Tool tab limit must be a positive integer');
  const saved = storedState(storage, storageKey);
  const values = saved.version === 1 || saved.version === 2 ? saved.entries : [];
  const entries = new Map(storedEntries(values, value => {
    const tab = saved.version === 1 ? object(value).tab : value;
    return tab === 'result' || tab === 'arguments' || tab === 'raw' ? tab : undefined;
  }) ?? []);
  const key = (sessionId: string, toolId: string) => JSON.stringify([sessionId, toolId]);
  function trim() { while (entries.size > limit) entries.delete(entries.keys().next().value!); }
  trim();
  return {
    get(sessionId: string, toolId: string): ToolTab | undefined {
      const id = key(sessionId, toolId), tab = entries.get(id);
      if (tab !== undefined) { entries.delete(id); entries.set(id, tab); }
      return tab;
    },
    set(sessionId: string, toolId: string, tab: ToolTab): void {
      const id = key(sessionId, toolId);
      entries.delete(id); entries.set(id, tab); trim();
      try { storage?.setItem(storageKey, JSON.stringify({ version: 2, entries: [...entries] })); }
      catch { /* Disabled or full browser storage must not interrupt reading. */ }
    },
  };
}

function storedGroupState(storage: StateStorage | undefined, storageKey: string): { entries: [string, boolean][]; sessions: [string, boolean][] } {
  const saved = storedState(storage, storageKey);
  const empty = { entries: [], sessions: [] };
  if (saved.version !== 1 && saved.version !== 2 && saved.version !== 3) return empty;
  const entries = storedEntries(saved.entries, value => {
    const open = saved.version === 3 ? value : object(value).open;
    return typeof open === 'boolean' ? open : undefined;
  });
  const sessions = saved.version === 1 ? [] : saved.sessions;
  if (!entries || !Array.isArray(sessions) || !sessions.every(item => Array.isArray(item) && item.length === 2 && typeof item[0] === 'string' && typeof item[1] === 'boolean')) return empty;
  return { entries, sessions: sessions as [string, boolean][] };
}

/** Session defaults reach unmounted groups; later manual choices override only their own group. */
export function createToolGroupViewStateStore(limit = 200, storage?: StateStorage, storageKey = GROUP_STATE_KEY, sessionLimit = 40) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(sessionLimit) || sessionLimit < 1) throw new RangeError('Group state limits must be positive integers');
  const saved = storedGroupState(storage, storageKey);
  const entries = new Map(saved.entries);
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
    try { storage?.setItem(storageKey, JSON.stringify({ version: 3, entries: [...entries], sessions: [...sessions] })); }
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
    get(sessionId: string, groupId: string): boolean | undefined {
      const id = key(sessionId, groupId);
      const state = entries.get(id);
      touchSession(sessionId);
      if (state !== undefined) {
        entries.delete(id); entries.set(id, state);
        return state;
      }
      const open = sessions.get(sessionId);
      return open;
    },
    set(sessionId: string, groupId: string, open: boolean): void {
      const id = key(sessionId, groupId);
      entries.delete(id); entries.set(id, open);
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

export const toolTabState = createToolTabStore(500, safeSessionStorage(), TOOL_STATE_KEY);
export const toolGroupViewState = createToolGroupViewStateStore(200, safeSessionStorage(), GROUP_STATE_KEY);
