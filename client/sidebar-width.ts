export const SIDEBAR_WIDTH_KEY = 'session-lens-sidebar-width';
export const SIDEBAR_MIN_WIDTH = 260;
export const SIDEBAR_MAX_WIDTH = 640;
export const SIDEBAR_MOBILE_BREAKPOINT = 900;

type WidthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function sidebarWidthLimit(viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - 480));
}

export function sidebarWidth(preferredWidth: number | null, viewportWidth: number): number {
  const fallback = 280;
  const width = preferredWidth != null && Number.isFinite(preferredWidth) ? preferredWidth : fallback;
  return Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(sidebarWidthLimit(viewportWidth), width)));
}

export function readSidebarWidth(storage?: WidthStorage): number | null {
  try {
    const raw = (storage ?? window.localStorage).getItem(SIDEBAR_WIDTH_KEY);
    if (!raw?.trim()) return null;
    const width = Number(raw);
    return Number.isFinite(width) && width >= SIDEBAR_MIN_WIDTH && width <= SIDEBAR_MAX_WIDTH ? Math.round(width) : null;
  } catch {
    return null;
  }
}

export function saveSidebarWidth(width: number | null, storage?: WidthStorage): void {
  try {
    const target = storage ?? window.localStorage;
    if (width === null) target.removeItem(SIDEBAR_WIDTH_KEY);
    else if (Number.isFinite(width)) target.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth(width, Number.MAX_SAFE_INTEGER)));
  } catch { /* Resizing still works when browser storage is unavailable. */ }
}
