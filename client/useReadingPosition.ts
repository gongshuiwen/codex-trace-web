import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import { chooseReadingPosition, indexOffset, locateReadingPosition, readReadingPosition, saveReadingPosition, visibleReadingPosition } from './reading-position';

export function useReadingPosition(sessionId: string, turnIds: string[], targetTurn: string | null, navigationVersion: number, virtuoso: React.RefObject<VirtuosoHandle | null>) {
  const turns = useRef(turnIds); turns.current = turnIds;
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const navigation = useRef<ReturnType<typeof locateReadingPosition> | null>(null);
  const suppressSave = useRef(false);
  const scrollerRef = useCallback((element: HTMLElement | null | Window) => setScroller(element instanceof HTMLElement ? element : null), []);
  const save = useCallback(() => {
    if (!scroller || navigation.current || suppressSave.current) return;
    const position = visibleReadingPosition(scroller);
    if (position) saveReadingPosition(sessionId, position);
  }, [scroller, sessionId]);

  useLayoutEffect(() => {
    if (!scroller) return;
    suppressSave.current = false;
    const position = chooseReadingPosition(turns.current, targetTurn, readReadingPosition(sessionId));
    if (position) {
      const index = turns.current.indexOf(position.turnId);
      let cancelled = false;
      navigation.current = locateReadingPosition(scroller, position, offset => virtuoso.current?.getState(snapshot => {
        const top = indexOffset(snapshot.ranges, index);
        if (!cancelled && top != null) virtuoso.current?.scrollTo({ top: top + offset, behavior: 'auto' });
      }), () => { cancelled = true; navigation.current = null; });
    }
    return () => {
      // StrictMode and session switches clean up before the list is stable.
      // Cancelling clears navigation.current, so remember the pending state
      // before cancellation and also guard the scroll-listener cleanup's save.
      suppressSave.current = !!navigation.current;
      navigation.current?.cancel(); save();
    };
  }, [sessionId, scroller, targetTurn, navigationVersion, virtuoso, save]);

  useEffect(() => {
    if (!scroller) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => { clearTimeout(timer); timer = setTimeout(save, 200); };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', save);
    return () => { clearTimeout(timer); scroller.removeEventListener('scroll', onScroll); window.removeEventListener('pagehide', save); save(); };
  }, [scroller, save]);

  return {
    scrollerRef,
    onTurnReady: useCallback((id: string) => navigation.current?.turnReady(id), []),
    onLayoutChanged: useCallback(() => navigation.current?.layoutChanged(), []),
    cancelNavigation: useCallback(() => navigation.current?.cancel(), []),
    followOutput: useCallback((atBottom: boolean) => !navigation.current && atBottom ? 'smooth' as const : false as const, []),
  };
}
