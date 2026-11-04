import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { eventViewState } from './event-view-state';
import './user-prompt.css';

interface UserPromptProps {
  text: string;
  sessionId: string;
  stateKey: string;
  anchorId?: string;
  indented?: boolean;
  preserveLayout?: (change: () => void) => void;
}

function PromptBody({ text, sessionId, stateKey, anchorId, indented = false, preserveLayout }: UserPromptProps) {
  const [expanded, setExpanded] = useState(() => eventViewState.get(sessionId, stateKey) ?? false);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const bodyId = useId();

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    let disposed = false;
    function measure() {
      if (disposed || !element || element.getBoundingClientRect().width === 0) return;
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
      // scrollHeight retains the full text height while line-clamp limits its visible box.
      // Compare with six laid-out lines in both states so expansion never hides its own control.
      const next = element.scrollHeight > Math.ceil(lineHeight * 6);
      setOverflowing(previous => previous === next ? previous : next);
    }
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    document.fonts?.addEventListener('loadingdone', measure);
    void document.fonts?.ready.then(measure);
    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      document.fonts?.removeEventListener('loadingdone', measure);
    };
  }, [text, expanded]);

  function toggle() {
    const change = () => {
      const next = !expanded;
      eventViewState.set(sessionId, stateKey, next);
      setExpanded(next);
    };
    if (preserveLayout) preserveLayout(change); else change();
  }

  return <div className={`user-prompt${indented ? ' user-prompt-indented' : ''}`} data-expanded={expanded} data-event-id={anchorId}>
    <p id={bodyId} ref={textRef} className="user-prompt-text">{text || '空消息'}</p>
    {overflowing && <button type="button" className="user-prompt-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={toggle}>{expanded ? '收起请求' : '展开完整请求'}<ChevronDown size={12} aria-hidden="true" /></button>}
  </div>;
}

/** Isolate saved choices when a virtual row is reused for a different request. */
export function UserPrompt(props: UserPromptProps) {
  return <PromptBody key={JSON.stringify([props.sessionId, props.stateKey])} {...props} />;
}
