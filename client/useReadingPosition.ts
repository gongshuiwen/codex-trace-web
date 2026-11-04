import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import { chooseReadingPosition, indexOffset, isReadingAtBottom, locateReadingPosition, readReadingPosition, restoreReadingPosition, saveReadingPosition, visibleReadingPosition, type ReadingPosition, type ReadingTarget } from './reading-position';

export function useReadingPosition(sessionId: string, turnIds: string[], targetTurn: string | null, navigationVersion: number, virtuoso: React.RefObject<VirtuosoHandle | null>, target?: ReadingTarget | null) {
  const turns = useRef(turnIds); turns.current = turnIds;
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);
  const navigation = useRef<ReturnType<typeof locateReadingPosition> | null>(null);
  const suppressSave = useRef(false);
  const anchor = useRef<ReadingPosition | null>(null);
  const pendingLayout = useRef<ReadingPosition | null>(null);
  const layoutFrame = useRef<number | null>(null);
  const manualUntil = useRef(0);
  const navigationIntent = useRef(0);
  const followingBottom = useRef(false);
  const scrollerRef = useCallback((element: HTMLElement | null | Window) => setScroller(element instanceof HTMLElement ? element : null), []);
  const capture = useCallback(() => {
    if (!scroller) return null;
    const position = visibleReadingPosition(scroller);
    if (position) { anchor.current = position; setCurrentTurnId(previous => previous === position.turnId ? previous : position.turnId); }
    followingBottom.current = isReadingAtBottom(scroller);
    return position;
  }, [scroller]);
  const cancelLayout = useCallback(() => {
    if (layoutFrame.current != null) cancelAnimationFrame(layoutFrame.current);
    layoutFrame.current = null;
    pendingLayout.current = null;
  }, []);
  const save = useCallback(() => {
    if (!scroller || navigation.current || pendingLayout.current || suppressSave.current) return;
    const position = capture() ?? anchor.current;
    if (position) saveReadingPosition(sessionId, position);
  }, [scroller, sessionId, capture]);
  const restoreLayout = useCallback(() => {
    if (!scroller || navigation.current || Date.now() < manualUntil.current || layoutFrame.current != null) return;
    if (!pendingLayout.current && followingBottom.current) { capture(); return; }
    if (!pendingLayout.current && !anchor.current) { capture(); return; }
    layoutFrame.current = requestAnimationFrame(() => {
      layoutFrame.current = null;
      if (navigation.current || Date.now() < manualUntil.current) return;
      const position = pendingLayout.current ?? anchor.current;
      if (position && pendingLayout.current) {
        const index = turns.current.indexOf(position.turnId);
        if (index < 0) { pendingLayout.current = null; capture(); return; }
        // Bulk height changes can evict the current virtual row. Mount its start,
        // then resolve the saved event/tool anchor rather than its now-stale offset.
        navigation.current = locateReadingPosition(scroller, position,
          () => virtuoso.current?.scrollToIndex({ index, align: 'start', behavior: 'auto' }),
          () => {
            navigation.current = null; pendingLayout.current = null;
            if (!suppressSave.current) {
              const current = capture();
              if (current) saveReadingPosition(sessionId, current);
            }
          }, { initialScroll: false, mountOffset: 0 });
        return;
      }
      if (position && restoreReadingPosition(scroller, position)) {
        pendingLayout.current = null;
        const current = capture();
        if (current) saveReadingPosition(sessionId, current);
      }
    });
  }, [scroller, sessionId, capture, virtuoso]);
  const cancelNavigation = useCallback(() => {
    navigationIntent.current++;
    manualUntil.current = Date.now() + 250;
    navigation.current?.cancel();
    cancelLayout();
    capture();
  }, [cancelLayout, capture]);
  const preserveLayout = useCallback((change: () => void) => {
    navigation.current?.cancel();
    cancelLayout();
    const position = capture();
    pendingLayout.current = position;
    manualUntil.current = 0;
    if (position) saveReadingPosition(sessionId, position);
    try { change(); } finally { restoreLayout(); }
  }, [cancelLayout, capture, restoreLayout, sessionId]);

  useLayoutEffect(() => {
    if (!scroller) return;
    suppressSave.current = false;
    const position = chooseReadingPosition(turns.current, targetTurn, readReadingPosition(sessionId), target);
    if (position) {
      const index = turns.current.indexOf(position.turnId);
      let cancelled = false;
      navigation.current = locateReadingPosition(scroller, position, offset => virtuoso.current?.getState(snapshot => {
        const top = indexOffset(snapshot.ranges, index);
        if (!cancelled && top != null) virtuoso.current?.scrollTo({ top: top + offset, behavior: 'auto' });
      }), () => {
        cancelled = true; navigation.current = null;
        if (!suppressSave.current) {
          const current = capture();
          if (current) saveReadingPosition(sessionId, current);
        }
      });
    } else capture();
    return () => {
      // StrictMode and session switches clean up before the list is stable.
      // Cancelling clears navigation.current, so remember the pending state
      // before cancellation and also guard the scroll-listener cleanup's save.
      suppressSave.current = !!navigation.current;
      navigation.current?.cancel(); cancelLayout(); save();
    };
  // Target fields, rather than the object identity or session revision, describe an explicit navigation.
  }, [sessionId, scroller, targetTurn, target?.turnId, target?.toolId, target?.eventId, target?.groupId, navigationVersion, virtuoso, save, capture, cancelLayout]);

  useEffect(() => {
    if (!scroller) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (!navigation.current && !pendingLayout.current && layoutFrame.current == null) capture();
      if (Date.now() < manualUntil.current) manualUntil.current = Date.now() + 250;
      clearTimeout(timer); timer = setTimeout(save, 200);
    };
    const onKey = (event: KeyboardEvent) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancelNavigation(); };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', save);
    for (const name of ['wheel', 'touchstart', 'pointerdown']) window.addEventListener(name, cancelNavigation, { capture: true, passive: true });
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(timer); scroller.removeEventListener('scroll', onScroll); window.removeEventListener('pagehide', save);
      for (const name of ['wheel', 'touchstart', 'pointerdown']) window.removeEventListener(name, cancelNavigation, true);
      window.removeEventListener('keydown', onKey, true); save();
    };
  }, [scroller, save, capture, cancelNavigation]);

  return {
    currentTurnId,
    scrollerRef,
    onTurnReady: useCallback((id: string) => { if (navigation.current) navigation.current.turnReady(id); else restoreLayout(); }, [restoreLayout]),
    onLayoutChanged: useCallback(() => { if (navigation.current) navigation.current.layoutChanged(); else restoreLayout(); }, [restoreLayout]),
    cancelNavigation,
    captureNavigationIntent: useCallback(() => {
      const version = navigationIntent.current;
      return () => version === navigationIntent.current;
    }, []),
    preserveLayout,
    followOutput: useCallback((atBottom: boolean) => {
      followingBottom.current = !navigation.current && !pendingLayout.current && atBottom && !!scroller && isReadingAtBottom(scroller);
      return followingBottom.current ? 'smooth' as const : false as const;
    }, [scroller]),
  };
}
