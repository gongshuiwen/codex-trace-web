type StateStorage = Pick<Storage, 'getItem' | 'setItem'>;
const STORAGE_KEY = 'session-lens-event-view-v1';

function validKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parts: unknown = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 2 && parts.every(part => typeof part === 'string');
  } catch { return false; }
}

function storedEntries(storage: StateStorage | undefined, storageKey: string): [string, boolean][] {
  if (!storage) return [];
  try {
    const value: unknown = JSON.parse(storage.getItem(storageKey) || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const saved = value as Record<string, unknown>;
    if (saved.version !== 1 || !Array.isArray(saved.entries)) return [];
    if (!saved.entries.every(item => Array.isArray(item) && item.length === 2 && validKey(item[0]) && typeof item[1] === 'boolean')) return [];
    return saved.entries as [string, boolean][];
  } catch { return []; }
}

function safeSessionStorage(): StateStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}

/** Remember bounded disclosure choices across virtualization and reloads, without saving event text. */
export function createEventViewStateStore(limit = 500, storage?: StateStorage, storageKey = STORAGE_KEY) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Event view state limit must be a positive integer');
  const entries = new Map<string, boolean>();
  const key = (sessionId: string, eventId: string) => JSON.stringify([sessionId, eventId]);
  for (const [id, open] of storedEntries(storage, storageKey)) {
    entries.delete(id); entries.set(id, open);
  }
  function trim() {
    while (entries.size > limit) entries.delete(entries.keys().next().value!);
  }
  trim();
  return {
    get(sessionId: string, eventId: string): boolean | undefined {
      const id = key(sessionId, eventId);
      const open = entries.get(id);
      if (open === undefined) return undefined;
      entries.delete(id); entries.set(id, open);
      return open;
    },
    set(sessionId: string, eventId: string, open: boolean): void {
      const id = key(sessionId, eventId);
      entries.delete(id); entries.set(id, open); trim();
      try { storage?.setItem(storageKey, JSON.stringify({ version: 1, entries: [...entries] })); }
      catch { /* Full or unavailable storage must not interrupt reading. */ }
    },
  };
}

export const eventViewState = createEventViewStateStore(500, safeSessionStorage());
