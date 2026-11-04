import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { readSidebarWidth, saveSidebarWidth, sidebarWidth, sidebarWidthLimit, SIDEBAR_MIN_WIDTH, SIDEBAR_MOBILE_BREAKPOINT } from './sidebar-width';

interface ResizeDrag {
  handle: HTMLDivElement;
  pointerId: number;
  startX: number;
  startWidth: number;
  width: number;
}

// Keep drag updates in the frame so the session tree does not render on every move.
export function SidebarFrame({ children }: { children: ReactNode }) {
  const [preferredWidth, setPreferredWidth] = useState(readSidebarWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const sidebar = useRef<HTMLElement>(null);
  const drag = useRef<ResizeDrag | null>(null);
  const desktop = viewportWidth > SIDEBAR_MOBILE_BREAKPOINT;
  const width = sidebarWidth(dragWidth ?? preferredWidth, viewportWidth);

  const commitWidth = useCallback((value: number | null) => {
    setPreferredWidth(value);
    saveSidebarWidth(value);
  }, []);

  const finishResize = useCallback((commit: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    setDragWidth(null);
    if (commit && active.width !== active.startWidth) commitWidth(active.width);
    if (active.handle.hasPointerCapture(active.pointerId)) active.handle.releasePointerCapture(active.pointerId);
  }, [commitWidth]);

  useEffect(() => {
    const onResize = () => {
      finishResize(false);
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [finishResize]);

  const resizing = dragWidth !== null;
  useEffect(() => {
    if (!resizing) return;
    document.body.classList.add('sidebar-resizing');
    const onBlur = () => finishResize(false);
    window.addEventListener('blur', onBlur);
    return () => {
      document.body.classList.remove('sidebar-resizing');
      window.removeEventListener('blur', onBlur);
    };
  }, [resizing, finishResize]);

  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (!desktop || event.button !== 0 || !event.isPrimary || !sidebar.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    const startWidth = Math.round(sidebar.current.getBoundingClientRect().width);
    drag.current = { handle: event.currentTarget, pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragWidth(startWidth);
  }

  function moveResize(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.width = sidebarWidth(active.startWidth + event.clientX - active.startX, window.innerWidth);
    setDragWidth(active.width);
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!desktop || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' && drag.current) {
      event.preventDefault();
      event.stopPropagation();
      finishResize(false);
      return;
    }
    const step = event.shiftKey ? 48 : 16;
    let next: number | null;
    if (event.key === 'ArrowLeft') next = sidebarWidth(width - step, viewportWidth);
    else if (event.key === 'ArrowRight') next = sidebarWidth(width + step, viewportWidth);
    else if (event.key === 'Home') next = SIDEBAR_MIN_WIDTH;
    else if (event.key === 'End') next = sidebarWidthLimit(viewportWidth);
    else if (event.key === 'Enter') next = null;
    else return;
    event.preventDefault();
    finishResize(false);
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && next === width) return;
    commitWidth(next);
  }

  return <aside ref={sidebar} className={`sidebar${resizing ? ' is-resizing' : ''}`} aria-label="会话导航" style={{ '--sidebar-width': `${width}px` } as CSSProperties}>
    {children}
    <div className="sidebar-resize-handle" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-valuemin={SIDEBAR_MIN_WIDTH} aria-valuemax={sidebarWidthLimit(viewportWidth)} aria-valuenow={width} aria-valuetext={`${width} 像素`} tabIndex={desktop ? 0 : -1} title="拖动调整宽度；双击或按 Enter 恢复默认"
      onPointerDown={startResize} onPointerMove={moveResize}
      onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) finishResize(true); }}
      onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) finishResize(false); }}
      onLostPointerCapture={() => finishResize(false)} onKeyDown={resizeWithKeyboard}
      onDoubleClick={() => { finishResize(false); commitWidth(null); }} />
  </aside>;
}
