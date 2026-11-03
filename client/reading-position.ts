export interface ReadingPosition { turnId: string; offset: number }
interface SavedPosition extends ReadingPosition { sessionId: string }
type BrowserStorage = Pick<Storage, 'getItem' | 'setItem'>;
const STORAGE_KEY = 'session-lens-reading-v1';
const MAX_SESSIONS = 40;

function savedPositions(storage: BrowserStorage): SavedPosition[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.filter((item): item is SavedPosition => !!item && typeof item.sessionId === 'string'
      && typeof item.turnId === 'string' && Number.isFinite(item.offset) && item.offset >= 0).slice(-MAX_SESSIONS) : [];
  } catch { return []; }
}

export function readReadingPosition(sessionId: string, storage?: BrowserStorage): ReadingPosition | null {
  try {
    const saved = savedPositions(storage ?? window.localStorage).find(item => item.sessionId === sessionId);
    return saved ? { turnId: saved.turnId, offset: saved.offset } : null;
  } catch { return null; }
}

export function saveReadingPosition(sessionId: string, position: ReadingPosition, storage?: BrowserStorage): void {
  if (!position.turnId || !Number.isFinite(position.offset)) return;
  try {
    const target = storage ?? window.localStorage;
    const positions = savedPositions(target).filter(item => item.sessionId !== sessionId);
    positions.push({ sessionId, turnId: position.turnId, offset: Math.max(0, position.offset) });
    target.setItem(STORAGE_KEY, JSON.stringify(positions.slice(-MAX_SESSIONS)));
  } catch { /* Reading and navigation continue when browser storage is unavailable. */ }
}

export function chooseReadingPosition(turnIds: string[], explicitTurn: string | null, saved: ReadingPosition | null): ReadingPosition | null {
  if (explicitTurn) return turnIds.includes(explicitTurn) ? { turnId: explicitTurn, offset: 0 } : null;
  return saved && turnIds.includes(saved.turnId) ? saved : null;
}

export function visibleReadingPosition(scroller: HTMLElement): ReadingPosition | null {
  const viewport = scroller.getBoundingClientRect();
  const article = [...scroller.querySelectorAll<HTMLElement>('[data-turn-id]')]
    .find(element => { const rect = element.getBoundingClientRect(); return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom; });
  return article?.dataset.turnId ? { turnId: article.dataset.turnId, offset: Math.max(0, viewport.top - article.getBoundingClientRect().top) } : null;
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

/** One navigation only: wait for detail, settle briefly, then yield to the reader. */
export function locateReadingPosition(scroller: HTMLElement, position: ReadingPosition, scrollToTurn: (offset: number) => void, onStop: () => void) {
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
    const article = [...scroller.querySelectorAll<HTMLElement>('[data-turn-id]')].find(element => element.dataset.turnId === position.turnId);
    if (!article) { resetStableWindow(); scrollToTurn(position.offset); return; }
    if (article.dataset.turnReady !== 'true') { resetStableWindow(); return; }
    const rect = article.getBoundingClientRect();
    const offset = Math.min(position.offset, Math.max(0, rect.height - 40));
    const distance = rect.top - scroller.getBoundingClientRect().top + offset;
    if (Math.abs(distance) > 1) { resetStableWindow(); scroller.scrollBy({ top: distance, behavior: 'auto' }); }
    else if (!settledTimer) settledTimer = setTimeout(stop, 1600);
  }
  function resetStableWindow() { clearTimeout(settledTimer); settledTimer = undefined; }
  function schedule() { if (!stopped && frame == null) frame = requestAnimationFrame(calibrate); }
  for (const name of ['wheel', 'touchstart', 'pointerdown']) window.addEventListener(name, stop, { capture: true, passive: true });
  window.addEventListener('keydown', onKey, true);
  scrollToTurn(position.offset); schedule();
  return { cancel: stop, layoutChanged: schedule, turnReady: (id: string) => { if (id === position.turnId) schedule(); } };
}
