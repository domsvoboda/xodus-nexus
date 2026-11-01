import { useEffect, useRef, type RefObject } from 'react';

/** Only the top visible dialog owns Tab/Escape. Busy operations cannot be dismissed. */
export function useDialogFocus(ref: RefObject<HTMLElement>, close: () => void, open = true, busy = false) {
  const state = useRef({ close, busy }); state.current = { close, busy };
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,summary,[tabindex]')]
      .filter(e => e.tabIndex >= 0 && !e.matches(':disabled,[aria-disabled="true"]') && !e.closest('[hidden],[inert]') && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
      .filter(e => {
        if (!(e instanceof HTMLInputElement) || e.type !== 'radio' || !e.name) return true;
        const group = [...dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(r => r.name === e.name && !r.disabled);
        return e === (group.find(r => r.checked) ?? group[0]);
      });
    const initial = controls().find(e => e.hasAttribute('data-gamepad-initial'))
      ?? controls().find(e => e.hasAttribute('data-gamepad-cancel')) ?? controls()[0];
    dialog.tabIndex = -1;
    (initial ?? dialog).focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      const top = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').at(-1);
      if (top !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!state.current.busy) state.current.close();
      }
      if (event.key !== 'Tab') return;
      const available = controls(), first = available[0], last = available.at(-1);
      if (!available.includes(document.activeElement as HTMLElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault(); ((event.shiftKey ? last : first) ?? dialog).focus();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      if (origin?.isConnected) origin.focus({ preventScroll: true });
    };
  }, [ref, open]);
}
