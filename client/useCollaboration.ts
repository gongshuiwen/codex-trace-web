import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveEvent, SessionActivity, SessionDetail, SessionSummary } from '../shared/types';
import type { CollaborationEntry } from './collaboration-data';
import { api, errorMessage, isAbort, sessionPath } from './api';

interface Cache {
  ownerId: string;
  entries: Map<string, CollaborationEntry>;
  loading: Set<string>;
  errors: Map<string, string>;
}

function initialCache(detail: SessionDetail, activity: SessionActivity): Cache {
  return { ownerId: detail.session.id, entries: new Map([[detail.session.id, { detail, activity }]]), loading: new Set(), errors: new Map() };
}

/** Load only the branches the user visits; the existing SSE connection supplies invalidations. */
export function useCollaboration(session: SessionDetail, activity: SessionActivity) {
  const ownerId = session.session.id;
  const owner = useRef(ownerId);
  owner.current = ownerId;
  const [cache, setCache] = useState(() => initialCache(session, activity));
  const current = useRef(cache);
  const pending = useRef(new Map<string, AbortController>());
  const refreshAgain = useRef(new Set<string>());
  const fetchedSeedRevision = useRef<string | null>(null);
  const commit = useCallback((next: Cache) => { current.current = next; setCache(next); }, []);

  const fetchEntry = useCallback(async (id: string, force = false): Promise<void> => {
    const before = current.current;
    if (before.ownerId !== ownerId) return;
    if (pending.current.has(id)) {
      if (force) refreshAgain.current.add(id);
      return;
    }
    if (!force && before.entries.has(id) && !before.errors.has(id)) return;
    const controller = new AbortController();
    pending.current.set(id, controller);
    const loading = new Set(before.loading).add(id);
    const errors = new Map(before.errors); errors.delete(id);
    commit({ ...before, loading, errors });
    try {
      const [detail, nextActivity] = await Promise.all([
        api<SessionDetail>(sessionPath(id), { signal: controller.signal }),
        api<SessionActivity>(`${sessionPath(id)}/activity`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted || owner.current !== ownerId || pending.current.get(id) !== controller) return;
      const latest = current.current;
      const previous = latest.entries.get(id)?.detail.session;
      const requestedRevision = before.entries.get(id)?.detail.session.revision;
      if (previous && (previous.updatedAt > detail.session.updatedAt
        || previous.revision !== requestedRevision && detail.session.revision === requestedRevision)) return;
      const entries = new Map(latest.entries);
      entries.set(id, { detail, activity: nextActivity });
      if (id === ownerId) fetchedSeedRevision.current = detail.session.revision;
      commit({ ...latest, entries });
    } catch (failure) {
      if (!controller.signal.aborted && !isAbort(failure) && owner.current === ownerId && pending.current.get(id) === controller) {
        controller.abort();
        const latest = current.current;
        commit({ ...latest, errors: new Map(latest.errors).set(id, errorMessage(failure)) });
      }
    } finally {
      if (pending.current.get(id) === controller) {
        pending.current.delete(id);
        if (owner.current === ownerId) {
          const latest = current.current;
          const nextLoading = new Set(latest.loading); nextLoading.delete(id);
          commit({ ...latest, loading: nextLoading });
          if (refreshAgain.current.delete(id)) void fetchEntry(id, true);
        }
      }
    }
  }, [ownerId, commit]);

  const load = useCallback((id: string) => { void fetchEntry(id); }, [fetchEntry]);
  const refresh = useCallback(() => {
    for (const id of current.current.entries.keys()) void fetchEntry(id, true);
  }, [fetchEntry]);

  useEffect(() => {
    if (current.current.ownerId !== ownerId) {
      fetchedSeedRevision.current = null;
      commit(initialCache(session, activity));
    }
    return () => {
      for (const controller of pending.current.values()) controller.abort();
      pending.current.clear();
      refreshAgain.current.clear();
    };
  }, [ownerId, commit]);

  useEffect(() => {
    const latest = current.current;
    if (latest.ownerId !== ownerId) return;
    const previous = latest.entries.get(ownerId);
    // A late parent render must not replace a newer fetch, including its newly indexed children.
    if (previous && previous.detail.session.updatedAt > session.session.updatedAt) return;
    const detail = fetchedSeedRevision.current === session.session.revision && previous ? previous.detail : session;
    const entries = new Map(latest.entries).set(ownerId, { detail, activity });
    commit({ ...latest, entries });
  }, [session, activity, ownerId, commit]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalidated = new Set<string>();
    function onChange(event: Event) {
      const change = (event as CustomEvent<LiveEvent>).detail;
      if (!change || current.current.ownerId !== ownerId) return;
      if (change.type === 'sessions-changed' || change.type === 'ready') {
        for (const id of current.current.entries.keys()) invalidated.add(id);
        for (const id of pending.current.keys()) invalidated.add(id);
      } else if (change.type === 'session-changed' && change.sessionId && (current.current.entries.has(change.sessionId) || pending.current.has(change.sessionId))) {
        invalidated.add(change.sessionId);
      }
      if (!invalidated.size || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        for (const id of invalidated) void fetchEntry(id, true);
        invalidated.clear();
      }, 900);
    }
    window.addEventListener('session-lens:change', onChange);
    return () => { clearTimeout(timer); window.removeEventListener('session-lens:change', onChange); };
  }, [ownerId, fetchEntry]);

  const { entries, sessions } = useMemo(() => {
    const loaded = cache.ownerId === ownerId ? cache.entries : new Map([[ownerId, { detail: session, activity }]]);
    const summaries = new Map<string, SessionSummary>();
    for (const { detail } of loaded.values()) {
      if (detail.parent) summaries.set(detail.parent.id, detail.parent);
      for (const child of detail.children) summaries.set(child.id, child);
    }
    // Each session's own fetched summary is more authoritative than a related-session snapshot.
    for (const { detail } of loaded.values()) summaries.set(detail.session.id, detail.session);
    const neighbors = new Map<string, string[]>();
    for (const summary of summaries.values()) {
      if (!summary.parentId || !summaries.has(summary.parentId)) continue;
      const parent = loaded.get(summary.parentId);
      // A complete fetched child list overrides stale references in a child's old log snapshot.
      if (parent && !parent.detail.children.some(child => child.id === summary.id)) continue;
      neighbors.set(summary.id, [...(neighbors.get(summary.id) ?? []), summary.parentId]);
      neighbors.set(summary.parentId, [...(neighbors.get(summary.parentId) ?? []), summary.id]);
    }
    const visible = new Set([ownerId]);
    const queue = [ownerId];
    for (let index = 0; index < queue.length; index++) {
      for (const id of neighbors.get(queue[index]!) ?? []) {
        if (!visible.has(id)) { visible.add(id); queue.push(id); }
      }
    }
    return {
      entries: [...loaded.values()].filter(entry => visible.has(entry.detail.session.id)),
      sessions: [...summaries.values()].filter(summary => visible.has(summary.id)),
    };
  }, [cache.ownerId, cache.entries, ownerId, session, activity]);

  return { entries, sessions, loading: cache.loading as ReadonlySet<string>, errors: cache.errors as ReadonlyMap<string, string>, load, refresh };
}
