export interface ReadingPosition {
  turnId: string;
  offset: number;
  eventId?: string;
  toolId?: string;
  groupId?: string;
  processId?: string;
  /** Viewport top minus anchor top. A negative value keeps an anchor below the viewport top. */
  anchorOffset?: number;
  /** Parent group fallback when the visible tool disappears after collapsing. */
  groupAnchorOffset?: number;
  /** Parent execution process fallback when reading mode hides its events. */
  processAnchorOffset?: number;
}
export type ReadingTarget = Pick<ReadingPosition, 'turnId' | 'eventId' | 'toolId' | 'groupId'>;
export const READING_BOTTOM_TOLERANCE = 4;

export function isReadingAtBottom(scroller: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return Number.isFinite(scroller.scrollHeight) && Number.isFinite(scroller.scrollTop) && Number.isFinite(scroller.clientHeight)
    && scroller.clientHeight > 0 && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= READING_BOTTOM_TOLERANCE;
}
interface SavedPosition extends ReadingPosition { sessionId: string }
type BrowserStorage = Pick<Storage, 'getItem' | 'setItem'>;
const STORAGE_KEY = 'session-lens-reading-v1';
const MAX_SESSIONS = 40;

function savedPositions(storage: BrowserStorage): SavedPosition[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.filter((item): item is SavedPosition => !!item && typeof item.sessionId === 'string'
      && typeof item.turnId === 'string' && Number.isFinite(item.offset) && item.offset >= 0)
      .slice(-MAX_SESSIONS).map(item => ({ sessionId: item.sessionId, ...positionFields(item) })) : [];
  } catch { return []; }
}

function positionFields(position: ReadingPosition): ReadingPosition {
  return {
    turnId: position.turnId, offset: Math.max(0, position.offset),
    ...(typeof position.eventId === 'string' && position.eventId ? { eventId: position.eventId } : {}),
    ...(typeof position.toolId === 'string' && position.toolId ? { toolId: position.toolId } : {}),
    ...(typeof position.groupId === 'string' && position.groupId ? { groupId: position.groupId } : {}),
    ...(typeof position.processId === 'string' && position.processId ? { processId: position.processId } : {}),
    ...(typeof position.anchorOffset === 'number' && Number.isFinite(position.anchorOffset) ? { anchorOffset: position.anchorOffset } : {}),
    ...(typeof position.groupAnchorOffset === 'number' && Number.isFinite(position.groupAnchorOffset) ? { groupAnchorOffset: position.groupAnchorOffset } : {}),
    ...(typeof position.processAnchorOffset === 'number' && Number.isFinite(position.processAnchorOffset) ? { processAnchorOffset: position.processAnchorOffset } : {}),
  };
}

export function readReadingPosition(sessionId: string, storage?: BrowserStorage): ReadingPosition | null {
  try {
    const saved = savedPositions(storage ?? window.localStorage).find(item => item.sessionId === sessionId);
    return saved ? positionFields(saved) : null;
  } catch { return null; }
}

export function saveReadingPosition(sessionId: string, position: ReadingPosition, storage?: BrowserStorage): void {
  if (!position.turnId || !Number.isFinite(position.offset)) return;
  try {
    const target = storage ?? window.localStorage;
    const positions = savedPositions(target).filter(item => item.sessionId !== sessionId);
    positions.push({ sessionId, ...positionFields(position) });
    target.setItem(STORAGE_KEY, JSON.stringify(positions.slice(-MAX_SESSIONS)));
  } catch { /* Reading and navigation continue when browser storage is unavailable. */ }
}

export function chooseReadingPosition(turnIds: string[], explicitTurn: string | null, saved: ReadingPosition | null, target?: ReadingTarget | null): ReadingPosition | null {
  if (target) return turnIds.includes(target.turnId) ? positionFields({ ...target, offset: 0, anchorOffset: 0 }) : null;
  if (explicitTurn) return turnIds.includes(explicitTurn) ? { turnId: explicitTurn, offset: 0 } : null;
  return saved && turnIds.includes(saved.turnId) ? saved : null;
}

function anchorElements(article: HTMLElement): HTMLElement[] {
  return typeof article.querySelectorAll === 'function'
    ? [...article.querySelectorAll<HTMLElement>('[data-event-id], [data-tool-id], [data-tool-group-id], [data-process-id]')]
    : [];
}

function closestId(element: HTMLElement, selector: string, key: 'eventId' | 'toolGroupId' | 'processId'): string | undefined {
  return element.dataset[key] || (typeof element.closest === 'function' ? element.closest<HTMLElement>(selector)?.dataset[key] : undefined);
}

function findTurn(scroller: HTMLElement, turnId: string): HTMLElement | undefined {
  return [...scroller.querySelectorAll<HTMLElement>('[data-turn-id]')].find(element => element.dataset.turnId === turnId);
}

function visibleElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.height > 0 && Number.isFinite(rect.top);
}

function anchorDistance(scroller: HTMLElement, article: HTMLElement, position: ReadingPosition): number {
  const elements = anchorElements(article).filter(visibleElement);
  const tool = position.toolId ? elements.find(element => element.dataset.toolId === position.toolId) : undefined;
  const event = position.eventId ? elements.find(element => element.dataset.eventId === position.eventId) : undefined;
  // Older single-call cards had no group anchor. Their first-call identity is
  // also the new group's stable identity, so migrate only this exact fallback.
  const groupId = position.groupId ?? (position.toolId ? `${position.turnId}:${position.toolId}` : undefined);
  const group = groupId ? elements.find(element => element.dataset.toolGroupId === groupId) : undefined;
  const process = position.processId ? elements.find(element => element.dataset.processId === position.processId) : undefined;
  const anchor = tool ?? event ?? group ?? process;
  const rect = (anchor ?? article).getBoundingClientRect();
  // An offset inside a now-collapsed tool does not describe a location inside its
  // group or process header. A parent below the viewport must remain below it,
  // though: the reader may still be reading the prompt immediately before it.
  const groupFallback = anchor === group && !tool && !event && (position.toolId || position.eventId);
  const processFallback = anchor === process && !tool && !event && !group && (position.toolId || position.eventId || position.groupId);
  const parentOffset = processFallback ? position.processAnchorOffset : position.groupAnchorOffset;
  const fallbackOffset = typeof parentOffset === 'number' && Number.isFinite(parentOffset) && parentOffset < 0 ? parentOffset : 0;
  const requested = anchor ? groupFallback || processFallback ? fallbackOffset : position.anchorOffset ?? 0 : position.offset;
  const finiteOffset = Number.isFinite(requested) ? requested : 0;
  const offset = anchor && finiteOffset < rect.height ? finiteOffset : Math.min(finiteOffset, Math.max(0, rect.height - 40));
  return rect.top - scroller.getBoundingClientRect().top + offset;
}

export function visibleReadingPosition(scroller: HTMLElement): ReadingPosition | null {
  const viewport = scroller.getBoundingClientRect();
  const article = [...scroller.querySelectorAll<HTMLElement>('[data-turn-id]')]
    .find(element => { const rect = element.getBoundingClientRect(); return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom; });
  if (!article?.dataset.turnId) return null;
  const position: ReadingPosition = { turnId: article.dataset.turnId, offset: Math.max(0, viewport.top - article.getBoundingClientRect().top) };
  const elements = anchorElements(article);
  const visible = elements.filter(element => {
    const rect = element.getBoundingClientRect();
    return visibleElement(element) && rect.bottom > viewport.top + 1 && rect.top < viewport.bottom;
  });
  const specific = visible.filter(element => element.dataset.toolId || element.dataset.eventId);
  const candidates = specific.length ? specific : visible;
  const crossing = candidates.filter(element => element.getBoundingClientRect().top <= viewport.top + 1);
  const anchor = (crossing.length ? crossing : candidates).sort((a, b) => {
    const first = a.getBoundingClientRect(), second = b.getBoundingClientRect();
    const distance = crossing.length ? first.height - second.height : first.top - second.top;
    return distance || Number(!!b.dataset.toolId) - Number(!!a.dataset.toolId);
  })[0];
  if (!anchor) return position;
  const groupId = closestId(anchor, '[data-tool-group-id]', 'toolGroupId');
  const group = groupId ? elements.find(element => element.dataset.toolGroupId === groupId) : undefined;
  const processId = closestId(anchor, '[data-process-id]', 'processId');
  const process = processId ? elements.find(element => element.dataset.processId === processId) : undefined;
  return {
    ...position,
    ...(anchor.dataset.toolId ? { toolId: anchor.dataset.toolId } : {}),
    ...(closestId(anchor, '[data-event-id]', 'eventId') ? { eventId: closestId(anchor, '[data-event-id]', 'eventId') } : {}),
    ...(groupId ? { groupId } : {}),
    ...(processId ? { processId } : {}),
    anchorOffset: viewport.top - anchor.getBoundingClientRect().top,
    ...(group ? { groupAnchorOffset: viewport.top - group.getBoundingClientRect().top } : {}),
    ...(process ? { processAnchorOffset: viewport.top - process.getBoundingClientRect().top } : {}),
  };
}

/** Restore a captured layout anchor once. Future layout callbacks may retry after a row becomes ready. */
export function restoreReadingPosition(scroller: HTMLElement, position: ReadingPosition): boolean {
  const article = findTurn(scroller, position.turnId);
  if (!article || article.dataset.turnReady !== 'true') return false;
  const distance = anchorDistance(scroller, article, position);
  if (Math.abs(distance) > 1) scroller.scrollBy({ top: distance, behavior: 'auto' });
  return true;
}

/** Estimate a row's top from Virtuoso's public measured size ranges. */
export function indexOffset(ranges: { startIndex: number; endIndex: number; size: number }[], index: number): number | null {
  const target = Math.max(0, Math.trunc(index));
  const measured = ranges.filter(range => range.size > 0 && Number.isFinite(range.size)).sort((a, b) => a.startIndex - b.startIndex);
  if (!measured.length) return target === 0 ? 0 : null;
  let cursor = 0, top = 0, lastSize = measured[0]!.size;
  for (const range of measured) {
    const gapEnd = Math.min(target, range.startIndex);
    if (gapEnd > cursor) { top += (gapEnd - cursor) * lastSize; cursor = gapEnd; }
    if (cursor >= target) return top;
    const end = Math.min(target, range.endIndex + 1);
    if (end > cursor) { top += (end - cursor) * range.size; cursor = end; }
    lastSize = range.size;
  }
  return top + (target - cursor) * lastSize;
}

interface LocateOptions {
  /** Layout restoration already has an anchor: avoid a coarse jump before recalibrating it. */
  initialScroll?: boolean;
  /** A saved offset may exceed a newly collapsed turn; mount its start before resolving anchors. */
  mountOffset?: number;
}

/** One navigation only: wait for detail, settle briefly, then yield to the reader. */
export function locateReadingPosition(scroller: HTMLElement, position: ReadingPosition, scrollToTurn: (offset: number) => void, onStop: () => void, options: LocateOptions = {}) {
  let stopped = false;
  let frame: number | undefined;
  let settledTimer: ReturnType<typeof setTimeout> | undefined;
  const maximumTimer = setTimeout(stop, 10_000);
  // Virtuoso can finish an initial measurement without another height/range
  // callback. Retry briefly even when the target is not mounted yet.
  const retryTimer = setInterval(() => schedule(), 100);
  const navigationKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
  const onKey = (event: Event) => { if (navigationKeys.has((event as KeyboardEvent).key)) stop(); };

  function stop() {
    if (stopped) return;
    stopped = true;
    if (frame != null) cancelAnimationFrame(frame);
    clearTimeout(maximumTimer); clearTimeout(settledTimer); clearInterval(retryTimer);
    for (const name of ['wheel', 'touchstart', 'pointerdown']) window.removeEventListener(name, stop, true);
    window.removeEventListener('keydown', onKey, true);
    onStop();
  }
  function calibrate() {
    frame = undefined;
    if (stopped) return;
    const article = findTurn(scroller, position.turnId);
    if (!article) { resetStableWindow(); scrollToTurn(options.mountOffset ?? position.offset); return; }
    if (article.dataset.turnReady !== 'true') { resetStableWindow(); return; }
    const distance = anchorDistance(scroller, article, position);
    if (Math.abs(distance) > 1) { resetStableWindow(); scroller.scrollBy({ top: distance, behavior: 'auto' }); }
    else if (!settledTimer) settledTimer = setTimeout(stop, 1600);
  }
  function resetStableWindow() { clearTimeout(settledTimer); settledTimer = undefined; }
  function schedule() { if (!stopped && frame == null) frame = requestAnimationFrame(calibrate); }
  for (const name of ['wheel', 'touchstart', 'pointerdown']) window.addEventListener(name, stop, { capture: true, passive: true });
  window.addEventListener('keydown', onKey, true);
  if (options.initialScroll !== false) scrollToTurn(options.mountOffset ?? position.offset);
  schedule();
  return { cancel: stop, layoutChanged: schedule, turnReady: (id: string) => { if (id === position.turnId) schedule(); } };
}
