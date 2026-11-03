import { useEffect, useRef, type RefObject } from 'react';

const overlayOrder: symbol[] = [];
const focusableSelector = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex="-1"])';
type FocusableElement = HTMLElement | SVGElement;

function isFocusableElement(value: EventTarget | null): value is FocusableElement {
  return value instanceof HTMLElement || value instanceof SVGElement;
}

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<FocusableElement>(focusableSelector)).filter(element =>
    element.tabIndex >= 0 && !element.closest('[hidden],[inert],[aria-hidden="true"]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
  );
}

/** Keep the most recently opened overlay in charge of the keyboard and return to its trigger. */
export function useOverlayFocus({ container, initialFocus, modal, onClose }: {
  container: RefObject<HTMLElement | null>;
  initialFocus?: RefObject<HTMLElement | null>;
  modal: boolean;
  onClose: () => void;
}) {
  const overlayId = useRef(Symbol('overlay'));
  const current = useRef({ modal, onClose });
  current.current = { modal, onClose };
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let trigger: FocusableElement | null = isFocusableElement(document.activeElement) ? document.activeElement : null;
    const id = overlayId.current;
    overlayOrder.push(id);
    const isTopmost = () => overlayOrder.at(-1) === id;
    const focusFirst = () => (focusableElements(element)[0] ?? element).focus({ preventScroll: true });
    (initialFocus?.current ?? focusableElements(element)[0] ?? element).focus({ preventScroll: true });

    function onKeyDown(event: KeyboardEvent) {
      if (!isTopmost() || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        current.current.onClose();
        return;
      }
      if (event.key !== 'Tab' || !current.current.modal) return;
      const items = focusableElements(element!);
      const first = items[0], last = items.at(-1);
      const active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        element!.focus({ preventScroll: true });
      } else if (!element!.contains(active) || active === element || event.shiftKey && active === first || !event.shiftKey && active === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      }
    }
    function onFocusIn(event: FocusEvent) {
      if (isTopmost() && !current.current.modal && isFocusableElement(event.target) && !element!.contains(event.target)) trigger = event.target;
      if (isTopmost() && current.current.modal && event.target instanceof Node && !element!.contains(event.target)) focusFirst();
    }
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      const wasTopmost = isTopmost();
      const index = overlayOrder.indexOf(id);
      if (index !== -1) overlayOrder.splice(index, 1);
      if (wasTopmost && trigger?.isConnected && trigger.getClientRects().length > 0 && getComputedStyle(trigger).visibility !== 'hidden' && !trigger.closest('[hidden],[inert],[aria-hidden="true"]')) trigger.focus({ preventScroll: true });
    };
  }, [container, initialFocus]);
  useEffect(() => {
    const element = container.current;
    if (modal && overlayOrder.at(-1) === overlayId.current && element && !element.contains(document.activeElement)) {
      (initialFocus?.current ?? focusableElements(element)[0] ?? element).focus({ preventScroll: true });
    }
  }, [modal, container, initialFocus]);
}
