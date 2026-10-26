export type Direction = 'up' | 'down' | 'left' | 'right';
export type PadAction = Direction | 'accept' | 'back' | 'options' | 'previous-page' | 'next-page';
type Rect = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;
type Pad = Pick<Gamepad, 'buttons' | 'axes'>;
const directions: Direction[] = ['up', 'down', 'left', 'right'];
const pressed = (pad: Pad, index: number) => pad.buttons[index]?.pressed === true || pad.buttons[index]?.value > 0.5;
const axis = (pad: Pad, index: number) => Number.isFinite(pad.axes[index]) ? Math.max(-1, Math.min(1, pad.axes[index])) : 0;

export function padDirection(pad: Pad): Direction | undefined {
  if (pressed(pad, 12)) return 'up';
  if (pressed(pad, 13)) return 'down';
  if (pressed(pad, 14)) return 'left';
  if (pressed(pad, 15)) return 'right';
  const x = axis(pad, 0), y = axis(pad, 1);
  if (Math.max(Math.abs(x), Math.abs(y)) < 0.55) return;
  return Math.abs(y) >= Math.abs(x) ? y < 0 ? 'up' : 'down' : x < 0 ? 'left' : 'right';
}

/** Only directions repeat. Connections, focus changes and pointer handoffs must
 * pass through neutral before an action, never replay a held confirmation. */
export class PadInput {
  private armed = false;
  private previous: boolean[] = [];
  private direction?: Direction;
  private repeatAt = 0;
  reset() { this.armed = false; this.previous = []; this.direction = undefined; this.repeatAt = 0; }
  poll(pad: Pad, now: number): { action?: PadAction; scroll: number } {
    const buttons = [1, 0, 2, 4, 5].map(index => pressed(pad, index));
    const direction = padDirection(pad);
    const scroll = Math.abs(axis(pad, 3)) >= 0.3 ? axis(pad, 3) : 0;
    if (pressed(pad, 16)) { this.reset(); return { scroll: 0 }; } // Steam/Guide chords belong to Steam.
    if (!this.armed) {
      this.armed = !direction && !scroll && !buttons.some(Boolean);
      this.previous = buttons;
      return { scroll: 0 };
    }
    const edge = buttons.findIndex((value, index) => value && !this.previous[index]);
    this.previous = buttons;
    let action: PadAction | undefined;
    if (edge !== -1) action = (['back', 'accept', 'options', 'previous-page', 'next-page'] as const)[edge];
    if (direction !== this.direction) {
      this.direction = direction;
      this.repeatAt = now + 380;
      action ??= direction;
    } else if (direction && now >= this.repeatAt) {
      this.repeatAt = now + 120;
      action ??= direction;
    }
    return { action, scroll };
  }
}

export function navigationTarget<T>(from: Rect, targets: readonly { value: T; rect: Rect }[], direction: Direction, allowCornerOverlap = false): T | undefined {
  const horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'up' || direction === 'left' ? -1 : 1;
  const center = (rect: Rect) => horizontal ? (rect.left + rect.right) / 2 : (rect.top + rect.bottom) / 2;
  const cross = (rect: Rect) => horizontal ? (rect.top + rect.bottom) / 2 : (rect.left + rect.right) / 2;
  let best: T | undefined, score = Infinity;
  for (const { value, rect } of targets) {
    const forward = (center(rect) - center(from)) * sign;
    if (forward < 1) continue;
    // Stay in the directional beam. A nearby diagonal must never win over
    // the visible control in the same row/column, or cause a jump at an edge.
    const overlap = horizontal ? Math.min(rect.bottom, from.bottom) - Math.max(rect.top, from.top)
      : Math.min(rect.right, from.right) - Math.max(rect.left, from.left);
    const crossDistance = Math.abs(cross(rect) - cross(from));
    const crossSize = (r: Rect) => horizontal ? r.bottom - r.top : r.right - r.left;
    if (overlap <= 1 || (!allowCornerOverlap && crossDistance > Math.max(crossSize(from), crossSize(rect)) / 2)) continue;
    const distance = forward + crossDistance * 0.35;
    if (distance < score) { best = value; score = distance; }
  }
  return best;
}

type Options = { mode: (active: boolean) => void; back: () => void; page: (delta: number) => void };
const controls = 'button,a[href],input:not([type="hidden"]),select,textarea,summary,[tabindex]';

export function revealDelta(top: number, bottom: number, viewTop: number, viewBottom: number): number {
  if (bottom - top > viewBottom - viewTop || top < viewTop) return top - viewTop;
  return bottom > viewBottom ? bottom - viewBottom : 0;
}

/** Renderer-only navigation. Never intercepts pointer/keyboard defaults, changes
 * Steam mappings, or sends gamepad events to another window/process. */
export function installGamepadNavigation(win: Window, options: Options): () => void {
  const doc = win.document;
  const inputs = new Map<string, PadInput>();
  const returns = new WeakMap<Element, HTMLElement>();
  const sidebarReturns = new WeakMap<Element, HTMLElement>();
  let active = false, stopped = false, frame = 0, previousTime = 0;
  let scope: HTMLElement | Document = doc;
  let picker: HTMLElement | undefined;
  let escapeFromPad = false;
  let pendingDetail: { id: string; origin: HTMLElement; deadline: number } | undefined;
  let detailReturn: { id: string; origin: HTMLElement } | undefined;
  const visible = (element: HTMLElement) => {
    if (!element.isConnected || element.closest('[hidden],[inert],[aria-hidden="true"]') || !element.getClientRects().length) return false;
    const style = win.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none';
  };
  const enabled = (element: HTMLElement) => visible(element) && !element.matches(':disabled,[aria-disabled="true"]');
  const candidates = (root: HTMLElement | Document) => [...root.querySelectorAll<HTMLElement>(controls)]
    .filter(element => enabled(element) && element.tabIndex >= 0 && !element.hasAttribute('data-gamepad-skip'));
  const currentScope = () => [...doc.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"],[data-game-menu]')]
    .filter(visible).at(-1) ?? doc;
  const focused = () => doc.activeElement instanceof HTMLElement ? doc.activeElement : undefined;
  const focusBox = (element: HTMLElement) => element.closest<HTMLElement>('[data-gamepad-card]') ?? element;
  const scrollParent = (element: HTMLElement) => {
    let parent = element.parentElement;
    while (parent) {
      if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(win.getComputedStyle(parent).overflowY)) return parent;
      parent = parent.parentElement;
    }
  };
  const reveal = (element: HTMLElement) => {
    const box = focusBox(element), parent = scrollParent(box);
    if (!parent) return;
    const rect = box.getBoundingClientRect(), viewport = parent.getBoundingClientRect();
    const hints = doc.querySelector('.gamepad-hints')?.getBoundingClientRect();
    const bottomInset = parent.matches('.page-scroll') && hints ? Math.max(10, viewport.bottom - hints.top + 8) : 10;
    parent.scrollTop += revealDelta(rect.top, rect.bottom, viewport.top + parent.clientTop + 10, viewport.top + parent.clientTop + parent.clientHeight - bottomInset);
  };
  const mark = () => {
    const element = active ? focused() : undefined;
    const target = element && !element.hasAttribute('data-gamepad-auto-select') ? focusBox(element) : undefined;
    doc.querySelectorAll('[data-gamepad-focus]').forEach(element => { if (element !== target) element.removeAttribute('data-gamepad-focus'); });
    if (target && !target.hasAttribute('data-gamepad-focus')) target.setAttribute('data-gamepad-focus', '');
  };
  const focus = (element: HTMLElement | undefined, select = false) => {
    if (!element || !enabled(element)) return;
    element.focus({ preventScroll: true });
    reveal(element);
    // Only explicitly reviewed, selection-only controls may act on focus.
    // Action buttons, recents, settings and downloads always require A.
    // Library cards select on focus; opening their game page requires A.
    if (select && active && scope === doc && element.hasAttribute('data-gamepad-auto-select') && element.getAttribute('data-gamepad-auto-select') !== 'focus' && currentScope() === doc) element.click();
    win.requestAnimationFrame(() => { if (!stopped && active && focused() === element && enabled(element)) reveal(element); });
    mark();
  };
  const initial = (root: HTMLElement | Document) => candidates(root).find(element => element.hasAttribute('data-gamepad-initial'))
    ?? candidates(root).find(element => element.hasAttribute('data-gamepad-cancel'))
    ?? candidates(root).find(element => element.matches('.sidebar .active')) ?? candidates(root)[0];
  const ensureFocus = () => {
    const next = currentScope();
    if (next !== scope) {
      const previous = scope;
      scope = next;
      // A detail drawer is its own modal scope, so no inline-detail focus
      // request may survive it and swallow a quick reopen after B.
      if (pendingDetail && next instanceof HTMLElement && next.getAttribute('data-gamepad-detail') === pendingDetail.id) pendingDetail = undefined;
      const target = previous instanceof HTMLElement ? returns.get(previous) : undefined;
      const origin = focused();
      if (next instanceof HTMLElement && !returns.has(next)) {
        const restore = origin && origin !== doc.body && origin !== doc.documentElement ? origin : target;
        if (restore) returns.set(next, restore);
      }
      if (target && next.contains(target) && enabled(target)) focus(target);
      else if (!focused() || !next.contains(focused()!)) focus(initial(next));
    }
    if (pendingDetail && scope === doc) {
      const pending = pendingDetail;
      const detail = [...doc.querySelectorAll<HTMLElement>('[data-gamepad-detail]')]
        .find(element => element.getAttribute('data-gamepad-detail') === pending.id && visible(element));
      if (detail) {
        const play = detail.querySelector<HTMLElement>('[data-gamepad-play]');
        const target = play && enabled(play) ? play : candidates(detail)[0];
        pendingDetail = undefined;
        if (target) { detailReturn = pending; focus(target); }
      } else if (!pending.origin.isConnected || Date.now() >= pending.deadline) pendingDetail = undefined;
    }
    const element = focused();
    if (!element || !scope.contains(element) || !enabled(element) || !element.matches(controls)) focus(initial(scope));
    mark();
  };
  const setMode = (value: boolean) => {
    if (active === value) return;
    active = value;
    doc.documentElement.toggleAttribute('data-gamepad-navigation', value);
    options.mode(value);
    if (value) ensureFocus(); else mark();
  };
  const closePicker = (restore: boolean) => {
    if (!picker) return;
    const target = returns.get(picker);
    picker.remove(); picker = undefined;
    if (restore) focus(target);
  };
  const pointer = () => { pendingDetail = undefined; setMode(false); inputs.forEach(input => input.reset()); };
  const pointerMove = (event: PointerEvent) => { if (event.movementX || event.movementY) pointer(); };
  const keyboard = (event: KeyboardEvent) => {
    if (!escapeFromPad) {
      if (picker && event.key === 'Escape') { closePicker(true); event.stopImmediatePropagation(); }
      pointer();
    }
  };
  const blur = () => { pointer(); closePicker(false); };

  function selectPicker(select: HTMLSelectElement) {
    closePicker(false);
    const backdrop = doc.createElement('div');
    backdrop.className = 'gamepad-select-backdrop';
    const dialog = doc.createElement('section');
    dialog.className = 'gamepad-select-dialog';
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    const title = doc.createElement('h2');
    title.textContent = select.getAttribute('aria-label') ?? select.labels?.[0]?.childNodes[0]?.textContent ?? ui('gamepad.choose_option');
    dialog.setAttribute('aria-label', title.textContent);
    dialog.append(title);
    const choose = (value: string) => {
      if (select.isConnected && !select.disabled) {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      closePicker(true);
    };
    for (const option of select.options) {
      if (option.hidden) continue;
      const button = doc.createElement('button');
      button.type = 'button'; button.textContent = option.label;
      button.disabled = option.disabled || Boolean(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled);
      button.setAttribute('aria-pressed', String(option.selected));
      if (option.selected) button.setAttribute('data-gamepad-initial', '');
      button.addEventListener('click', () => choose(option.value));
      dialog.append(button);
    }
    const cancel = doc.createElement('button');
    cancel.type = 'button'; cancel.textContent = ui('ui.cancel_19766ed'); cancel.setAttribute('data-gamepad-cancel', '');
    cancel.addEventListener('click', () => closePicker(true));
    dialog.append(cancel); backdrop.append(dialog); doc.body.append(backdrop);
    backdrop.addEventListener('pointerdown', event => { if (event.target === backdrop) closePicker(false); });
    picker = backdrop; returns.set(backdrop, select); returns.set(dialog, select);
    scope = dialog; focus(initial(dialog));
  }

  const activate = () => {
    const element = focused();
    if (!element || !scope.contains(element) || !enabled(element) || pendingDetail) return;
    if (element instanceof HTMLSelectElement) selectPicker(element);
    else if (element.hasAttribute('data-gamepad-card-activate')) {
      // A on a Store card delegates only to its real, enabled action. Selection
      // on focus and ordinary pointer/keyboard clicks never start an install.
      const target = element.closest('[data-gamepad-card]')?.querySelector<HTMLElement>('[data-gamepad-card-action]');
      if (target && scope.contains(target) && enabled(target)) target.click();
    }
    else {
      const id = element.getAttribute('data-gamepad-detail-target');
      if (id) pendingDetail = { id, origin: element, deadline: Date.now() + 1500 };
      element.click();
    }
  };
  const pageFocus = () => {
    focused()?.blur();
    // React commits the new page asynchronously. Restore its active nav item
    // without selecting the old page again during fallback/return focus.
    win.requestAnimationFrame(() => { if (!stopped && active && currentScope() === doc) focus(initial(doc)); });
  };
  const back = () => {
    if (picker) { closePicker(true); return; }
    if (scope instanceof HTMLElement) {
      if (scope.hasAttribute('data-game-menu')) {
        escapeFromPad = true;
        try { win.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
        finally { escapeFromPad = false; }
      } else {
        const cancel = scope.querySelector<HTMLElement>('[data-gamepad-cancel]');
        if (cancel && enabled(cancel)) cancel.click();
      }
      return; // Never act behind a modal or confirm a destructive action.
    }
    const detailBack = [...doc.querySelectorAll<HTMLElement>('[data-gamepad-detail-back]')].find(enabled);
    if (detailBack) { pendingDetail = undefined; detailReturn = undefined; detailBack.click(); return; }
    if (detailReturn && focused()?.closest('[data-gamepad-detail]')?.getAttribute('data-gamepad-detail') === detailReturn.id && enabled(detailReturn.origin)) {
      focus(detailReturn.origin); detailReturn = undefined; return;
    }
    options.back();
    pageFocus();
  };
  const action = (value: PadAction) => {
    ensureFocus();
    if (directions.includes(value as Direction)) {
      const element = focused();
      if (element) {
        const direction = value as Direction;
        // The sidebar and page are separate navigation regions. Their controls
        // need not line up vertically, so enter the page explicitly instead of
        // applying the strict within-region directional beam across that gap.
        if (scope === doc && direction === 'right' && element.closest('.sidebar')) {
          const content = doc.querySelector<HTMLElement>('.page-scroll');
          if (content) {
            const targets = candidates(content);
            const grid = targets.filter(target => target.closest('[data-gamepad-grid]'));
            const shell = content.closest('.content-shell');
            const previous = shell ? sidebarReturns.get(shell) : undefined;
            const entry = previous && shell?.contains(previous) && enabled(previous) ? previous : targets.find(target => target.hasAttribute('data-gamepad-play'))
              ?? grid.find(target => target.closest('[data-gamepad-card]')?.classList.contains('selected'))
              ?? grid[0] ?? targets.find(target => target.closest('[data-gamepad-filters]')) ?? initial(content);
            focus(entry, true);
          }
          return;
        }
        const actionRow = direction === 'left' || direction === 'right' ? element.closest<HTMLElement>('[data-gamepad-action-row]') : undefined;
        const region = scope === doc ? actionRow ?? element.closest<HTMLElement>('[data-gamepad-grid],[data-gamepad-filters],[data-gamepad-library-header],[data-gamepad-library-footer],[data-gamepad-detail],.page-scroll,.topbar') ?? scope : scope;
        const choose = (root: HTMLElement | Document) => navigationTarget(focusBox(element).getBoundingClientRect(), candidates(root).filter(target => target !== element)
          .map(target => ({ value: target, rect: focusBox(target).getBoundingClientRect() })), direction, root === actionRow);
        let target = choose(region);
        const library = element.closest<HTMLElement>('.library-page');
        if (!target && !library && element.closest('.store-page') && region instanceof HTMLElement && region.hasAttribute('data-gamepad-grid') && (direction === 'up' || direction === 'down')) target = choose(scope);
        if (!target && library && region instanceof HTMLElement) {
          // Cross library rows explicitly, without diagonal drift into an
          // unrelated card or control. Sidebar exit is handled separately.
          let next: string | undefined;
          if (region.hasAttribute('data-gamepad-grid') && direction === 'up') next = '[data-gamepad-filters]';
          else if (region.hasAttribute('data-gamepad-grid') && direction === 'down') next = '[data-gamepad-library-footer]';
          else if (region.hasAttribute('data-gamepad-filters') && direction === 'up') next = '[data-gamepad-library-header]';
          else if (region.hasAttribute('data-gamepad-library-header') && direction === 'down') next = '[data-gamepad-filters]';
          else if ((region.hasAttribute('data-gamepad-filters') && direction === 'down') || (region.hasAttribute('data-gamepad-library-footer') && direction === 'up')) next = '[data-gamepad-grid]';
          const root = next ? library.querySelector<HTMLElement>(next) : undefined;
          if (root) {
            target = choose(root);
            // Header actions are right-aligned, while filters span the page.
            // A vertical region crossing may need a different column, but it
            // must not weaken the strict directional beam within a card grid.
            if (!target && (region.hasAttribute('data-gamepad-library-header') || root.hasAttribute('data-gamepad-library-header'))) {
              const rect = element.getBoundingClientRect(), x = (rect.left + rect.right) / 2;
              target = candidates(root).sort((a, b) => {
                const distance = (e: HTMLElement) => { const r = e.getBoundingClientRect(); return Math.abs((r.left + r.right) / 2 - x); };
                return distance(a) - distance(b);
              })[0];
            }
          }
          if (!target && direction === 'down' && region.hasAttribute('data-gamepad-grid')) {
            const parent = scrollParent(focusBox(element));
            if (parent) parent.scrollTop += Math.min(260, parent.clientHeight * 0.5);
          }
        }
        if (!target && scope === doc && direction === 'left') {
          const shell = element.closest('.content-shell');
          const sidebar = doc.querySelector<HTMLElement>('.sidebar');
          if (shell && sidebar) {
            target = candidates(sidebar).find(item => item.matches('.nav-item.active'))
              ?? candidates(sidebar).find(item => item.matches('.nav-item'));
            if (target) {
              sidebarReturns.set(shell, element);
              // This is a focus handoff, not a page change. In particular,
              // leaving a game detail must not reselect/reset its Library page.
              focus(target);
              return;
            }
          }
        }
        focus(target, true);
      }
    } else if (value === 'accept') activate();
    else if (value === 'back') back();
    else if (value === 'options') {
      const origin = detailReturn && focused()?.closest('[data-gamepad-detail]')?.getAttribute('data-gamepad-detail') === detailReturn.id ? detailReturn.origin : focused();
      const trigger = origin?.closest('.library-card-wrap')?.querySelector<HTMLElement>('[data-game-menu-trigger]');
      if (trigger && enabled(trigger)) trigger.click();
    } else if (scope instanceof HTMLElement && scope.hasAttribute('data-gamepad-gallery')) {
      // Shoulder buttons change only the active gallery, never the page behind it.
      const target = scope.querySelector<HTMLElement>(value === 'previous-page' ? '[data-gamepad-gallery-previous]' : '[data-gamepad-gallery-next]');
      if (target && enabled(target)) target.click();
    } else if (scope === doc) {
      options.page(value === 'previous-page' ? -1 : 1);
      pageFocus();
    }
  };
  const scroll = (value: number, elapsed: number) => {
    const canScroll = (element: HTMLElement) => element.scrollHeight > element.clientHeight && /auto|scroll/.test(win.getComputedStyle(element).overflowY);
    let element = focused();
    while (element && !canScroll(element)) element = element.parentElement ?? undefined;
    element ??= [...scope.querySelectorAll<HTMLElement>('pre,.page-scroll,.game-dialog')].find(canScroll);
    if (element) element.scrollTop += value * elapsed * 0.75;
  };
  const tick = (now: number) => {
    if (stopped) return;
    const elapsed = Math.min(40, Math.max(0, now - previousTime)); previousTime = now;
    try {
      if (doc.hidden || !doc.hasFocus()) {
        if (active) blur();
        inputs.forEach(input => input.reset());
      } else {
        const pads = [...(win.navigator.getGamepads?.() ?? [])].filter((pad): pad is Gamepad => Boolean(pad?.connected && pad.mapping === 'standard'));
        const present = new Set<string>();
        let handled = false;
        for (const pad of pads) {
          const key = `${pad.index}:${pad.id}`; present.add(key);
          if (!inputs.has(key)) inputs.set(key, new PadInput());
          const next = inputs.get(key)!.poll(pad, now);
          if (!handled && (next.action || next.scroll)) {
            handled = true; setMode(true);
            if (next.action) action(next.action);
            if (next.scroll) scroll(next.scroll, elapsed);
          }
        }
        for (const key of inputs.keys()) if (!present.has(key)) inputs.delete(key);
        if (!pads.length) { setMode(false); closePicker(false); }
        if (active) ensureFocus();
      }
    } catch { blur(); inputs.clear(); } // Unsupported browser/device must not break mouse UI.
    frame = win.requestAnimationFrame(tick);
  };
  win.addEventListener('pointerdown', pointer, true);
  win.addEventListener('pointermove', pointerMove, true);
  win.addEventListener('keydown', keyboard, true);
  win.addEventListener('blur', blur);
  doc.addEventListener('visibilitychange', blur);
  frame = win.requestAnimationFrame(tick);
  return () => {
    stopped = true; win.cancelAnimationFrame(frame); closePicker(false); setMode(false); inputs.clear();
    win.removeEventListener('pointerdown', pointer, true);
    win.removeEventListener('pointermove', pointerMove, true);
    win.removeEventListener('keydown', keyboard, true);
    win.removeEventListener('blur', blur); doc.removeEventListener('visibilitychange', blur);
  };
}
import { ui } from './i18n';
