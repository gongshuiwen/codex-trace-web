import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { OutputPage, ToolCall, ToolSearchLocation } from '../shared/types';
import { api, errorMessage, isAbort, sessionPath } from './api';
import { completeOutputWindow, initialToolOutput, mergeOutputWindow, outputSearchPage, outputWindowEnd, pageOutputWindow, TOOL_OUTPUT_PAGE_SIZE, TOOL_OUTPUT_WINDOW_LIMIT, toolOutputSource, windowContainsSearch, type ToolOutputWindow } from './tool-output-window';
import { parseToolOutputPositions, serializeToolOutputPositions, TOOL_OUTPUT_POSITION_KEY, type ToolOutputPosition } from './tool-output-position';

type LoadRequest = { offset: number; limit: number; direction: 'before' | 'after' | 'replace' };
type Tab = 'result' | 'arguments' | 'raw';
interface Snapshot { window: ToolOutputWindow; loading: boolean; error: string }
interface Entry {
  source: string; toolKey: string; snapshot: Snapshot; listeners: Set<() => void>;
  scroll: Partial<Record<Tab, number>>; controller: AbortController | null; failed?: LoadRequest; resume?: LoadRequest; restoring?: LoadRequest;
}
type Resume = ToolOutputPosition;
const windows = new Map<string, Entry>();
const resumes = new Map<string, Resume>();
const CACHE_CHARACTERS = 2_097_152;
const CACHE_ENTRIES = 16;
let metadataHydrated = false;
let persistenceTimer: ReturnType<typeof setTimeout> | null = null;

function persistMetadata() {
  if (persistenceTimer) clearTimeout(persistenceTimer);
  persistenceTimer = null;
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.setItem(TOOL_OUTPUT_POSITION_KEY, serializeToolOutputPositions(Array.from(resumes.values()))); } catch { /* Storage may be unavailable or full; reading still works. */ }
}

function hydrateMetadata() {
  if (metadataHydrated || typeof window === 'undefined') return;
  metadataHydrated = true;
  try {
    for (const saved of parseToolOutputPositions(window.sessionStorage.getItem(TOOL_OUTPUT_POSITION_KEY))) {
      resumes.set(JSON.stringify([saved.sessionId, saved.toolId]), saved);
    }
  } catch { /* Ignore unavailable browser storage. */ }
  window.addEventListener('pagehide', persistMetadata);
}

function schedulePersistence() {
  if (typeof window === 'undefined' || persistenceTimer) return;
  persistenceTimer = setTimeout(persistMetadata, 180);
}

function remember(entry: Entry) {
  windows.delete(entry.source); windows.set(entry.source, entry);
  const inactive = Array.from(windows.values()).filter(value => !value.listeners.size);
  let count = inactive.length;
  let characters = inactive.reduce((total, value) => total + value.snapshot.window.text.length, 0);
  for (const [key, value] of windows) {
    if (count <= CACHE_ENTRIES && characters <= CACHE_CHARACTERS) break;
    if (value.listeners.size || key === entry.source) continue;
    windows.delete(key); count--; characters -= value.snapshot.window.text.length;
  }
  const previous = resumes.get(entry.toolKey);
  resumes.delete(entry.toolKey);
  const [sessionId, toolId] = JSON.parse(entry.toolKey) as [string, string];
  resumes.set(entry.toolKey, {
    sessionId, toolId,
    offset: entry.restoring?.offset ?? entry.resume?.offset ?? (entry.snapshot.loading && previous ? previous.offset : entry.snapshot.window.offset),
    length: entry.restoring?.limit ?? entry.resume?.limit ?? (entry.snapshot.loading && previous ? previous.length : entry.snapshot.window.text.length),
    scroll: { ...entry.scroll },
  });
  while (resumes.size > 500) resumes.delete(resumes.keys().next().value!);
  schedulePersistence();
}

function obtain(source: string, toolKey: string, tool: ToolCall): Entry {
  hydrateMetadata();
  const cached = windows.get(source);
  if (cached) { remember(cached); return cached; }
  const previous = resumes.get(toolKey);
  const initial = initialToolOutput(tool);
  const entry: Entry = { source, toolKey, snapshot: { window: initial, loading: false, error: '' }, listeners: new Set(), scroll: { ...previous?.scroll }, controller: null };
  if (!completeOutputWindow(initial) && previous && (previous.offset > 0 || previous.length > initial.text.length)) {
    entry.resume = { offset: Math.min(previous.offset, Math.max(0, tool.outputLength - 1)), limit: Math.max(TOOL_OUTPUT_PAGE_SIZE, Math.min(previous.length, TOOL_OUTPUT_WINDOW_LIMIT)), direction: 'replace' };
    entry.restoring = entry.resume;
  }
  remember(entry);
  return entry;
}

function publish(entry: Entry, snapshot: Snapshot) {
  entry.snapshot = snapshot; remember(entry);
  for (const listener of entry.listeners) listener();
}

/** A bounded shared text window lets inline cards and the reader use the same pages. */
export function useToolOutput({ tool, sessionId, revision, search }: { tool: ToolCall; sessionId: string; revision: string; search?: ToolSearchLocation }) {
  const source = toolOutputSource(sessionId, revision, tool);
  const toolKey = JSON.stringify([sessionId, tool.id]);
  const entry = useMemo(() => obtain(source, toolKey, tool), [source]);
  const subscribe = useCallback((listener: () => void) => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener); if (!entry.listeners.size) entry.controller?.abort(); remember(entry); }; }, [entry]);
  const getSnapshot = useCallback(() => entry.snapshot, [entry]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const currentEntry = useRef(entry); currentEntry.current = entry;
  const attemptedSearch = useRef('');

  const load = useCallback(async (request: LoadRequest) => {
    if (entry.snapshot.loading && request.direction !== 'replace') return;
    entry.controller?.abort();
    if (request.direction !== 'replace') entry.restoring = undefined;
    const controller = new AbortController(); entry.controller = controller;
    publish(entry, { ...entry.snapshot, loading: true, error: '' });
    try {
      const requestPage = (offset: number, limit: number) => api<OutputPage>(`${sessionPath(sessionId)}/tools/${encodeURIComponent(tool.id)}/output?offset=${offset}&limit=${limit}`, { signal: controller.signal });
      const page = await requestPage(request.offset, Math.min(65_536, request.limit));
      if (controller.signal.aborted || entry.controller !== controller || currentEntry.current !== entry) return;
      let window = request.direction === 'replace' ? pageOutputWindow(page) : mergeOutputWindow(entry.snapshot.window, page, request.direction);
      if (request.direction === 'replace' && request.limit > page.text.length) {
        const end = Math.min(page.totalLength, page.offset + Math.min(request.limit, TOOL_OUTPUT_WINDOW_LIMIT));
        const remaining: Promise<OutputPage>[] = [];
        for (let offset = outputWindowEnd(window); offset < end; offset += 65_536) remaining.push(requestPage(offset, Math.min(65_536, end - offset)));
        for (const next of await Promise.all(remaining)) window = mergeOutputWindow(window, next, 'after');
        if (controller.signal.aborted || entry.controller !== controller || currentEntry.current !== entry) return;
      }
      entry.failed = undefined;
      entry.restoring = undefined;
      publish(entry, { window, loading: false, error: '' });
    } catch (cause) {
      if (!controller.signal.aborted && entry.controller === controller && currentEntry.current === entry && !isAbort(cause)) {
        entry.failed = request;
        publish(entry, { ...entry.snapshot, loading: false, error: errorMessage(cause) });
      }
    } finally {
      if (entry.controller === controller) {
        entry.controller = null;
        if (entry.snapshot.loading) publish(entry, { ...entry.snapshot, loading: false });
      }
    }
  }, [entry, sessionId, tool.id]);

  const searchKey = search ? JSON.stringify([search.field, search.offset, search.length, search.query, search.matchedText]) : '';
  const searchAttemptKey = `${source}\u0000${searchKey}`;
  useEffect(() => {
    if (search?.field === 'output' && !windowContainsSearch(entry.snapshot.window, search)) {
      attemptedSearch.current = searchAttemptKey;
      entry.resume = undefined;
      entry.restoring = undefined;
      void load({ ...outputSearchPage(search, tool.outputLength), direction: 'replace' });
    } else if (entry.resume) {
      const request = entry.resume; entry.resume = undefined;
      void load(request);
    }
  }, [entry, searchKey, load, tool.outputLength]);

  const window = snapshot.window;
  return {
    ...snapshot,
    loading: snapshot.loading || Boolean(entry.resume),
    restoring: Boolean(entry.resume || entry.restoring),
    source,
    locating: Boolean(search?.field === 'output' && !windowContainsSearch(window, search) && (snapshot.loading || attemptedSearch.current !== searchAttemptKey)),
    complete: completeOutputWindow(window),
    canLoadBefore: window.offset > 0,
    canLoadAfter: outputWindowEnd(window) < window.totalLength,
    loadBefore: () => window.offset > 0 ? load({ offset: Math.max(0, window.offset - TOOL_OUTPUT_PAGE_SIZE), limit: Math.min(TOOL_OUTPUT_PAGE_SIZE, window.offset), direction: 'before' }) : Promise.resolve(),
    loadAfter: () => outputWindowEnd(window) < window.totalLength ? load({ offset: outputWindowEnd(window), limit: TOOL_OUTPUT_PAGE_SIZE, direction: 'after' }) : Promise.resolve(),
    retry: () => entry.failed ? load(entry.failed) : Promise.resolve(),
    getScroll: (tab: Tab) => entry.scroll[tab] ?? 0,
    saveScroll: (tab: Tab, top: number) => { entry.scroll[tab] = Math.max(0, top); remember(entry); },
  };
}
