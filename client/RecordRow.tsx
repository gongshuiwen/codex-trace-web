import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, PanelRightOpen, type LucideIcon } from 'lucide-react';
import './record-row.css';

/** Groups disclose their entries; individual records open the shared detail panel. */
export function RecordRow({ icon: Icon, title, preview, meta, onClick, selected = false, expanded, controls = 'record-details', label }: {
  icon: LucideIcon; title: string; preview?: string; meta?: ReactNode; onClick: () => void;
  selected?: boolean; expanded?: boolean; controls?: string; label?: string;
}) {
  const ActionIcon = expanded === undefined ? PanelRightOpen : expanded ? ChevronDown : ChevronRight;
  return <button type="button" className="record-row" onClick={onClick}
    aria-label={label} aria-controls={expanded !== undefined || selected ? controls : undefined} aria-expanded={expanded}
    aria-current={selected ? 'true' : undefined} data-selected={selected || undefined}>
    <Icon size={16} className="record-row-icon" aria-hidden="true" />
    <span className="record-row-content"><span className="record-row-title" title={title}>{title}</span>
      {preview && <span className="record-row-preview">{preview}</span>}
    </span>
    {meta && <span className="record-row-meta">{meta}</span>}
    <ActionIcon size={14} className="record-row-action" aria-hidden="true" />
  </button>;
}
