import { useRef, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeft, X, type LucideIcon } from 'lucide-react';
import { useOverlayFocus } from './useOverlayFocus';
import './record-details.css';

export const DEFAULT_DETAIL_WIDTH = 44;
const MIN_WIDTH = 35;
const MAX_WIDTH = 60;

/** A nonmodal inspector bounded by its workspace, including on narrow screens. */
export interface DetailWidth { width: number; onWidthChange: (width: number) => void }

export function RecordDetails({ title, icon: Icon, meta, children, onClose, fill = false, width, onWidthChange }: {
  title: string; icon: LucideIcon; meta?: ReactNode; children: ReactNode; onClose: () => void; fill?: boolean;
} & DetailWidth) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const dragging = useRef(false);
  useOverlayFocus({ container: panel, initialFocus: close, modal: false, onClose });
  const clamp = (value: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));
  return <aside id="record-details" ref={panel} className="record-details" aria-labelledby="record-details-title" tabIndex={-1}
    style={{ '--record-details-width': `${width}%` } as CSSProperties}>
    <div className="record-details-resize" role="separator" tabIndex={0} aria-label="调整详情宽度" aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={width} aria-valuetext={`${width}%`}
      onDoubleClick={() => onWidthChange(DEFAULT_DETAIL_WIDTH)}
      onKeyDown={event => {
        const next = event.key === 'ArrowLeft' ? width + 2 : event.key === 'ArrowRight' ? width - 2
          : event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? MAX_WIDTH : null;
        if (next !== null) { event.preventDefault(); onWidthChange(clamp(next)); }
      }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (!dragging.current) return;
        const bounds = panel.current?.parentElement?.getBoundingClientRect();
        if (bounds?.width) onWidthChange(Math.round(clamp((bounds.right - event.clientX) / bounds.width * 100)));
      }}
      onLostPointerCapture={() => { dragging.current = false; }}
      onPointerUp={event => { dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }} />
    <header className="record-details-heading">
      <button type="button" className="icon-button record-details-back" aria-label="返回对话" onClick={onClose}><ArrowLeft size={17} /></button>
      <Icon size={16} aria-hidden="true" />
      <h2 id="record-details-title" title={title}>{title}</h2>
      {meta && <span className="record-details-meta">{meta}</span>}
      <button type="button" ref={close} className="icon-button" aria-label="关闭详情" title="关闭详情 (Esc)" onClick={onClose}><X size={17} /></button>
    </header>
    <div className="record-details-content" data-fill={fill || undefined}>{children}</div>
  </aside>;
}
