import type { ReadingPosition } from './reading-position';

export type SessionView = 'conversation' | 'usage' | 'collaboration';
export type UsageFocus = 'total' | 'cache' | 'latest' | 'requests' | 'calls';
export interface SessionLocation {
  session: string | null;
  turn: string | null;
  view: SessionView;
  request: string | null;
  usageTurn: string | null;
  focus: UsageFocus | null;
}

export const SAVE_READING_EVENT = 'session-lens:save-reading';

export function parseSessionLocation(url: URL, legacyView?: string): SessionLocation {
  const params = url.searchParams;
  const view = params.get('view') ?? legacyView;
  const focus = params.get('focus');
  return {
    session: params.get('session'), turn: params.get('turn'),
    view: view === 'usage' || view === 'tokens' ? 'usage' : view === 'collaboration' ? view : 'conversation',
    request: params.get('request'), usageTurn: params.get('usageTurn'),
    focus: focus === 'total' || focus === 'cache' || focus === 'latest' || focus === 'requests' || focus === 'calls' ? focus : null,
  };
}

export function sessionLocationUrl(url: URL, location: SessionLocation): URL {
  const next = new URL(url);
  for (const [key, value] of Object.entries(location)) {
    if (value && !(key === 'view' && value === 'conversation')) next.searchParams.set(key, value);
    else next.searchParams.delete(key);
  }
  return next;
}

export function readSessionLocation(): SessionLocation {
  if (!window.history.state?.sessionLensEntry) window.history.replaceState({ ...window.history.state, sessionLensEntry: crypto.randomUUID() }, '', window.location.href);
  return parseSessionLocation(new URL(window.location.href), window.history.state?.sessionView);
}

export function navigateSessionLocation(next: SessionLocation, replace = false, resetReading = false): void {
  window.dispatchEvent(new Event(SAVE_READING_EVENT));
  const current = parseSessionLocation(new URL(window.location.href));
  const reading = !resetReading && current.session === next.session && current.turn === next.turn ? window.history.state?.readingPosition : undefined;
  window.history[replace ? 'replaceState' : 'pushState']({ sessionLensEntry: crypto.randomUUID(), readingPosition: reading }, '', sessionLocationUrl(new URL(window.location.href), next));
}

export function historyReadingPosition(sessionId: string): ReadingPosition | null {
  const saved = window.history.state?.readingPosition;
  return saved?.sessionId === sessionId && typeof saved.position?.turnId === 'string' && Number.isFinite(saved.position?.offset) ? saved.position : null;
}
