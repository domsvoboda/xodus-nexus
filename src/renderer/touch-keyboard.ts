import type { SteamKeyboardRequest } from '../shared/types';

const textTypes = new Set(['text', 'search', 'email', 'password', 'number', 'tel', 'url']);
type TextField = HTMLInputElement | HTMLTextAreaElement;

export function isTextField(element: Element | null): element is TextField {
  if (!element || !element.isConnected) return false;
  const field = element as TextField;
  return !field.disabled && !field.readOnly && !field.closest('[hidden],[inert],[aria-hidden="true"]')
    && (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT' && textTypes.has(field.type));
}

/** Steam keyboard modes: 0 single line, 1 multiple lines, 2 email, 3 numeric. */
function keyboardMode(field: TextField): SteamKeyboardRequest['mode'] {
  if (field.tagName === 'TEXTAREA') return 1;
  if (field.type === 'email') return 2;
  return ['number', 'tel'].includes(field.type) ? 3 : 0;
}

export function requestTextKeyboard(win: Window, field: TextField, show: (field: SteamKeyboardRequest) => Promise<unknown>): Promise<unknown> {
  if (!isTextField(field) || win.document.activeElement !== field) return Promise.resolve(false);
  field.scrollIntoView({ block: 'center', inline: 'nearest' });
  const rect = field.getBoundingClientRect();
  if (!rect.width || !rect.height) return Promise.resolve(false);
  return show({ x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height, mode: keyboardMode(field) });
}

/** Native touch release is reliable even when Chromium's compatibility click
 * lacks pointerType. Wait until the gesture's default focus action has run. */
export function installTouchKeyboard(win: Window, show: (field: SteamKeyboardRequest) => Promise<unknown>): () => void {
  let pending: number | undefined;
  const cancel = () => { if (pending !== undefined) win.cancelAnimationFrame(pending); pending = undefined; };
  const pointer = (event: PointerEvent) => {
    if (!event.isTrusted || !['touch', 'pen'].includes(event.pointerType)) return;
    const element = event.target as Element | null;
    if (!isTextField(element)) return;
    cancel();
    pending = win.requestAnimationFrame(() => {
      pending = undefined;
      void requestTextKeyboard(win, element, show).catch(() => {});
    });
  };
  win.addEventListener('pointerup', pointer, true);
  // Coalesce pointerup and its compatibility click into one request.
  win.addEventListener('click', pointer, true);
  win.addEventListener('pointercancel', cancel, true);
  return () => {
    cancel(); win.removeEventListener('pointerup', pointer, true); win.removeEventListener('click', pointer, true); win.removeEventListener('pointercancel', cancel, true);
  };
}
