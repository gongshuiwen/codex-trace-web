import type { TurnDetail } from '../shared/types';

interface CachedTurn { revision: string; data: TurnDetail; characters: number }

/** Keep loaded row heights stable when Virtuoso unmounts and remounts a turn. */
export function createTurnDetailCache(maxEntries = 24, maxCharacters = 8_000_000) {
  const entries = new Map<string, CachedTurn>();
  let characters = 0;
  const key = (sessionId: string, turnId: string) => `${sessionId}\0${turnId}`;
  function remove(id: string) {
    const previous = entries.get(id);
    if (previous) { characters -= previous.characters; entries.delete(id); }
  }
  return {
    get(sessionId: string, turnId: string): CachedTurn | undefined {
      const id = key(sessionId, turnId), value = entries.get(id);
      if (value) { entries.delete(id); entries.set(id, value); }
      return value;
    },
    put(sessionId: string, turnId: string, revision: string, data: TurnDetail): void {
      const id = key(sessionId, turnId);
      remove(id);
      const length = data.summary.prompt.length + data.summary.preview.length
        + data.events.reduce((sum, event) => sum + event.text.length + (event.tool?.arguments.length ?? 0) + (event.tool?.output.length ?? 0), 0)
        + data.requests.length * 256;
      entries.set(id, { revision, data, characters: length }); characters += length;
      // A single oversized turn is retained by itself so it cannot oscillate
      // between a measured long row and a fresh loading placeholder.
      while ((entries.size > maxEntries || characters > maxCharacters) && entries.size > 1) remove(entries.keys().next().value!);
    },
  };
}

export const turnDetailCache = createTurnDetailCache();
