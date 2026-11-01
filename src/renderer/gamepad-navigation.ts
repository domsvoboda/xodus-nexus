import { isTextField, requestTextKeyboard } from './touch-keyboard';
import type { SteamKeyboardRequest } from '../shared/types';

export type Direction = 'up' | 'down' | 'left' | 'right';
export type PadAction = Direction | 'accept' | 'back' | 'options' | 'search' | 'social' | 'previous-page' | 'next-page';
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
    const buttons = [1, 0, 2, 3, 8, 4, 5].map(index => pressed(pad, index));
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
    if (edge !== -1) action = (['back', 'accept', 'options', 'search', 'social', 'previous-page', 'next-page'] as const)[edge];
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

/** Vertical grid movement follows the adjacent row even when its last columns
 * are empty. Strict beam navigation is still used outside card grids. */
export function gridNavigationTarget<T>(from: Rect, targets: readonly { value: T; rect: Rect }[], direction: Direction): T | undefined {
  if (direction !== 'up' && direction !== 'down') return navigationTarget(from, targets, direction);
  const rows = targets.filter(({ rect }) => direction === 'down' ? rect.top >= from.bottom - 1 : rect.bottom <= from.top + 1);
  const gap = (rect: Rect) => direction === 'down' ? rect.top - from.bottom : from.top - rect.bottom;
  rows.sort((a, b) => gap(a.rect) - gap(b.rect));
  const first = rows[0];
  if (!first) return;
  const x = (from.left + from.right) / 2;
  return rows.filter(({ rect }) => Math.min(rect.bottom, first.rect.bottom) > Math.max(rect.top, first.rect.top))
    .sort((a, b) => Math.abs((a.rect.left + a.rect.right) / 2 - x) - Math.abs((b.rect.left + b.rect.right) / 2 - x))[0]?.value;
}

type Options = { mode: (active: boolean) => void; back: () => void; page: (delta: number) => void; social?: () => void; search?: () => void; keyboard?: (field: SteamKeyboardRequest) => Promise<unknown> };
const controls = 'button,a[href],input:not([type="hidden"]),select,textarea,summary,[tabindex]';
const layers = '[role="dialog"][aria-modal="true"],[data-game-menu],[data-gamepad-layer]';
const regions = '[data-gamepad-grid],[data-gamepad-filters],[data-gamepad-library-header],[data-gamepad-library-footer],[data-gamepad-detail],.settings-page,.page-scroll,.topbar,.sidebar';
type FocusMemory = { element: HTMLElement; key?: string; page?: string; region?: HTMLElement; rect: Rect };

export function revealDelta(top: number, bottom: number, viewTop: number, viewBottom: number): number {
  if (bottom - top > viewBottom - viewTop || top < viewTop) return top - viewTop;
  return bottom > viewBottom ? bottom - viewBottom : 0;
}

/** Renderer-only navigation. Never intercepts pointer/keyboard defaults, changes
 * Steam mappings, or sends gamepad events to another window/process. */
export function installGamepadNavigation(win: Window, options: Options): () => void {
  const doc = win.document;
  const inputs = new Map<string, PadInput>();
  const openers = new WeakMap<Element, FocusMemory>(); // Focus to restore when a layer closes.
  const parents = new WeakMap<Element, HTMLElement | Document>();
  const pageReturns = new Map<string, FocusMemory>();
  let lastFocus: FocusMemory | undefined;
  let active = false, stopped = false, frame = 0, previousTime = 0;
  let scope: HTMLElement | Document = doc;
  let picker: HTMLElement | undefined;
  let heldFocus: HTMLElement | undefined;
  let escapeFromPad = false;
  let pendingDetail: { id: string; origin: HTMLElement; deadline: number } | undefined;
  let detailReturn: { id: string; origin: HTMLElement } | undefined;
  const visible = (element: HTMLElement) => {
    if (!element.isConnected || element.closest('[hidden],[inert],[aria-hidden="true"]') || !element.getClientRects().length) return false;
    const style = win.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none';
  };
  const enabled = (element: HTMLElement) => visible(element) && !element.matches(':disabled,[aria-disabled="true"]');
  // Busy pagination remains focusable, but can never be activated again.
  const focusable = (element: HTMLElement) => enabled(element) || visible(element) && !element.matches(':disabled') && element.getAttribute('aria-busy') === 'true';
  const candidates = (root: HTMLElement | Document) => [...root.querySelectorAll<HTMLElement>(controls)]
    .filter(element => focusable(element) && element.tabIndex >= 0 && !element.hasAttribute('data-gamepad-skip'));
  const currentScope = () => [...doc.querySelectorAll<HTMLElement>(layers)]
    .filter(visible).at(-1) ?? doc;
  const focused = () => {
    const element = doc.activeElement instanceof HTMLElement ? doc.activeElement : undefined;
    return active && (!element || element === doc.body) && heldFocus?.matches(':disabled') && scope.contains(heldFocus) && visible(heldFocus)
      ? heldFocus : element;
  };
  const page = () => doc.querySelector<HTMLElement>('.page-scroll')?.dataset.gamepadPage;
  let previousPage = page();
  const key = (element: HTMLElement) => element.dataset.gamepadKey ?? (element.dataset.gamepadDetailTarget ? `game:${element.dataset.gamepadDetailTarget}` : element.id || undefined);
  const focusBox = (element: HTMLElement) => element.closest<HTMLElement>('[data-gamepad-card],.check-field') ?? element;
  const remember = (element: HTMLElement): FocusMemory => ({ element, key: key(element), page: page(), region: element.closest<HTMLElement>(regions) ?? undefined, rect: focusBox(element).getBoundingClientRect() });
  const resolve = (memory: FocusMemory | undefined, root: HTMLElement | Document): HTMLElement | undefined => {
    if (!memory || memory.page !== page()) return;
    if (root.contains(memory.element) && focusable(memory.element)) return memory.element;
    return memory.key ? candidates(root).find(element => key(element) === memory.key) : undefined;
  };
  // Remembered content focus for the current page, if it is still available.
  const pageReturn = (root: HTMLElement | Document) => {
    const current = page();
    return resolve(current ? pageReturns.get(current) : undefined, root);
  };
  const nearest = (memory: FocusMemory, root: HTMLElement | Document) => candidates(root).sort((a, b) => {
    const distance = (element: HTMLElement) => { const rect = focusBox(element).getBoundingClientRect(); return Math.hypot(rect.left + rect.right - memory.rect.left - memory.rect.right, rect.top + rect.bottom - memory.rect.top - memory.rect.bottom); };
    return distance(a) - distance(b);
  })[0];
  const scrollParent = (element: HTMLElement) => {
    let parent = element.parentElement;
    while (parent && (scope === doc || scope.contains(parent))) {
      if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(win.getComputedStyle(parent).overflowY)) return parent;
      if (parent === scope) break;
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
    const target = element ? focusBox(element) : undefined;
    doc.querySelectorAll('[data-gamepad-focus]').forEach(element => { if (element !== target) element.removeAttribute('data-gamepad-focus'); });
    if (target && !target.hasAttribute('data-gamepad-focus')) target.setAttribute('data-gamepad-focus', '');
  };
  const focus = (element: HTMLElement | undefined, select = false) => {
    if (!element || !focusable(element)) return;
    heldFocus = element;
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
  const recover = () => {
    const memory = lastFocus;
    const replacement = resolve(memory, scope);
    if (replacement) return replacement;
    if (memory && memory.page === page()) {
      if (memory.region && scope.contains(memory.region) && visible(memory.region)) {
        const local = nearest(memory, memory.region);
        if (local) return local;
      }
      const content = scope === doc ? doc.querySelector<HTMLElement>('.page-scroll') : scope;
      if (content) return nearest(memory, content) ?? initial(scope);
    }
    return initial(scope);
  };
  const recordFocus = () => {
    const element = focused();
    if (!element || currentScope() !== scope || !scope.contains(element) || !focusable(element) || !element.matches(controls)) return;
    lastFocus = remember(element);
    if (scope === doc && element.closest('.page-scroll') && lastFocus.page) pageReturns.set(lastFocus.page, lastFocus);
  };
  /** A dialog, menu or shelf opened or closed, so focus moves into the new top layer. */
  const onScopeChange = (nextScope: HTMLElement | Document) => {
    const previousScope = scope;
    scope = nextScope;
    // A detail drawer is its own modal scope, so no inline-detail focus
    // request may survive it and swallow a quick reopen after B.
    if (pendingDetail && nextScope instanceof HTMLElement && nextScope.getAttribute('data-gamepad-detail') === pendingDetail.id) pendingDetail = undefined;
    const openerFocus = previousScope instanceof HTMLElement ? openers.get(previousScope) : undefined;
    const restoreTarget = resolve(openerFocus, nextScope);
    const current = focused();
    // Refresh the opener every time a persistent shelf opens, but preserve
    // the parent's opener when returning from a nested dialog.
    const returningToParent = previousScope instanceof HTMLElement && parents.get(previousScope) === nextScope;
    if (nextScope instanceof HTMLElement && !returningToParent) {
      const opener = current && !nextScope.contains(current) && current.matches(controls) ? remember(current) : openerFocus ?? lastFocus;
      if (opener) openers.set(nextScope, opener);
      parents.set(nextScope, previousScope);
    }
    // A committed navigation request already focused its destination as the
    // layer closed, so leave that focus alone.
    const navigatedOnClose = returningToParent && current && nextScope.contains(current) && !previousScope.contains(current) && focusable(current) && current.matches(controls);
    if (navigatedOnClose) return;
    if (restoreTarget && nextScope.contains(restoreTarget) && enabled(restoreTarget)) focus(restoreTarget);
    else if (!current || !nextScope.contains(current) || !focusable(current)) {
      if (returningToParent && openerFocus) lastFocus = openerFocus;
      focus(returningToParent ? recover() : initial(nextScope));
    }
  };
  /** The page under the root scope changed (sidebar, bumpers, B, or an app request). */
  const onPageChange = () => {
    previousPage = page();
    pendingDetail = undefined; detailReturn = undefined;
    if (scope !== doc) return;
    // Detail pages set their own initial Play/Back focus in a layout effect.
    const element = focused();
    const homePrimary = doc.querySelector<HTMLElement>('[data-gamepad-home-primary]');
    if (previousPage === 'home' && homePrimary) {
      // Preserve sidebar ownership and explicit Home-card returns. Ordinary
      // Home entry starts at Play, never at a persistent Search input.
      const explicitHomeReturn = element?.closest('.home-page') && lastFocus?.page === 'home' && lastFocus.element === element;
      if (!element?.closest('.sidebar') && !explicitHomeReturn) focus(homePrimary);
    } else if (!element?.closest('[data-gamepad-detail]') && !element?.matches('.sidebar .nav-item.active,.notification-bell')) {
      // Sidebar navigation already placed focus on the destination item.
      // Remembered content is restored only when Right enters the page.
      focus(pageReturn(doc) ?? initial(doc));
    }
  };
  /** An activated card asked for its inline detail; focus it once React renders it. */
  const onPendingDetail = (pending: NonNullable<typeof pendingDetail>) => {
    const detail = [...doc.querySelectorAll<HTMLElement>('[data-gamepad-detail]')]
      .find(element => element.getAttribute('data-gamepad-detail') === pending.id && visible(element));
    if (detail) {
      const play = detail.querySelector<HTMLElement>('[data-gamepad-play]');
      const entry = play && enabled(play) ? play : candidates(detail)[0];
      pendingDetail = undefined;
      if (entry) { detailReturn = pending; focus(entry); }
    } else if (!pending.origin.isConnected || Date.now() >= pending.deadline) pendingDetail = undefined;
  };
  const ensureFocus = () => {
    const nextScope = currentScope();
    if (nextScope !== scope) onScopeChange(nextScope);
    if (page() !== previousPage) onPageChange();
    if (pendingDetail && scope === doc) onPendingDetail(pendingDetail);
    const element = focused();
    if (!element || !scope.contains(element) || !visible(element) || !element.matches(controls)) focus(recover());
    else {
      heldFocus = element;
      if (doc.activeElement !== element && enabled(element)) focus(element);
    }
    recordFocus();
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
    const target = resolve(openers.get(picker), doc);
    picker.remove(); picker = undefined;
    if (restore) focus(target);
  };
  const pointer = () => { heldFocus = undefined; pendingDetail = undefined; setMode(false); inputs.forEach(input => input.reset()); };
  const pointerMove = (event: PointerEvent) => { if (event.movementX || event.movementY) pointer(); };
  const keyboard = (event: KeyboardEvent) => {
    if (!escapeFromPad) {
      if (picker && event.key === 'Escape') { closePicker(true); event.preventDefault(); event.stopImmediatePropagation(); }
      if (picker && event.key === 'Tab') {
        const buttons = candidates(picker);
        const first = buttons[0], last = buttons.at(-1);
        if (!picker.contains(doc.activeElement) || event.shiftKey && doc.activeElement === first || !event.shiftKey && doc.activeElement === last) {
          event.preventDefault(); (event.shiftKey ? last : first)?.focus();
        }
      }
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
    picker = backdrop; openers.set(backdrop, remember(select)); openers.set(dialog, remember(select)); parents.set(dialog, scope);
    scope = dialog; focus(initial(dialog));
  }

  const activate = () => {
    const element = focused();
    if (!element || !scope.contains(element) || !enabled(element) || pendingDetail) return;
    if (isTextField(element) && options.keyboard) void requestTextKeyboard(win, element, options.keyboard).catch(() => {});
    else if (element instanceof HTMLSelectElement) selectPicker(element);
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
    // React commits the new page asynchronously. Recover by page/key after
    // that commit, without auto-activating a navigation item during recovery.
    win.requestAnimationFrame(() => { if (!stopped && active) ensureFocus(); });
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
    const search = focused()?.closest<HTMLElement>('.search-box');
    if (search) {
      escapeFromPad = true;
      try { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
      finally { escapeFromPad = false; }
      const content = doc.querySelector<HTMLElement>('.page-scroll');
      if (content) focus(pageReturn(content) ?? content.querySelector<HTMLElement>('[data-gamepad-home-primary]') ?? initial(content));
      return;
    }
    const detailBack = [...doc.querySelectorAll<HTMLElement>('[data-gamepad-detail-back]')].find(enabled);
    if (detailBack) { pendingDetail = undefined; detailReturn = undefined; detailBack.click(); return; }
    if (detailReturn && focused()?.closest('[data-gamepad-detail]')?.getAttribute('data-gamepad-detail') === detailReturn.id && enabled(detailReturn.origin)) {
      focus(detailReturn.origin); detailReturn = undefined; return;
    }
    options.back();
    pageFocus();
  };
  /** A move that bypasses the ordinary directional beam. `select` permits auto-select on focus. */
  type Exit = { target?: HTMLElement; select?: boolean };
  /** Search suggestions take priority over the page behind the topbar. */
  const fromTopbar = (element: HTMLElement, direction: Direction): Exit | undefined => {
    if (scope !== doc || !element.closest('.topbar') || direction !== 'down' && direction !== 'up') return;
    const suggestions = doc.querySelector<HTMLElement>('#global-search-results');
    if (suggestions) {
      const targets = candidates(suggestions);
      const index = targets.indexOf(element);
      if (index !== -1) return { target: direction === 'up' ? targets[index - 1] ?? doc.querySelector<HTMLElement>('.search-box input') ?? undefined : targets[index + 1] ?? element };
      if (direction === 'down' && element.closest('.search-box') && targets.length) return { target: targets[0] };
    }
    if (direction !== 'down') return;
    const content = doc.querySelector<HTMLElement>('.page-scroll');
    return { target: content ? content.querySelector<HTMLElement>('[data-gamepad-home-primary]') ?? pageReturn(content) ?? initial(content) : undefined };
  };
  // The sidebar and page are separate navigation regions. Their controls
  // need not line up vertically, so enter the page explicitly instead of
  // applying the strict within-region directional beam across that gap.
  const fromSidebar = (element: HTMLElement, direction: Direction): Exit | undefined => {
    if (scope !== doc || direction !== 'right' || !element.closest('.sidebar')) return;
    // Visit adjacent header actions (account → notification bell) before
    // crossing from the sidebar into the page content.
    const row = element.closest<HTMLElement>('[data-gamepad-action-row]');
    const adjacent = row && navigationTarget(focusBox(element).getBoundingClientRect(), candidates(row).filter(target => target !== element)
      .map(target => ({ value: target, rect: focusBox(target).getBoundingClientRect() })), direction, true);
    if (adjacent) return { target: adjacent };
    const content = doc.querySelector<HTMLElement>('.page-scroll');
    if (!content) return {};
    const targets = candidates(content);
    const grid = targets.filter(target => target.closest('[data-gamepad-grid]'));
    const entry = pageReturn(content) ?? targets.find(target => target.hasAttribute('data-gamepad-play'))
      ?? grid.find(target => target.closest('[data-gamepad-card]')?.classList.contains('selected'))
      ?? grid[0] ?? targets.find(target => target.closest('[data-gamepad-filters]')) ?? initial(content);
    return { target: entry, select: true };
  };
  /** The ordinary directional search from `element`, within its region. */
  const beamFrom = (element: HTMLElement, direction: Direction) => {
    const actionRow = direction === 'left' || direction === 'right' ? element.closest<HTMLElement>('[data-gamepad-action-row]') : undefined;
    const region = scope === doc ? actionRow ?? element.closest<HTMLElement>(regions) ?? scope : scope;
    const choose = (root: HTMLElement | Document) => {
      const settings = root instanceof HTMLElement && root.matches('.settings-page');
      const targets = candidates(root).filter(target => target !== element)
        .map(target => ({ value: target, rect: focusBox(target).getBoundingClientRect() }));
      // Settings mixes full-width rows with left/right aligned controls.
      // Follow the adjacent row vertically instead of skipping cards to
      // stay in a column; permit offset centres within a horizontal row.
      return root instanceof HTMLElement && (root.hasAttribute('data-gamepad-grid') || settings && (direction === 'up' || direction === 'down'))
        ? gridNavigationTarget(focusBox(element).getBoundingClientRect(), targets, direction)
        : navigationTarget(focusBox(element).getBoundingClientRect(), targets, direction, root === actionRow || settings);
    };
    // Entering another region may land off the beam, so fall back to the nearest control.
    const crossRegion = (root: HTMLElement) => choose(root) ?? nearest(remember(element), root);
    return { region, choose, crossRegion };
  };
  type Beam = ReturnType<typeof beamFrom>;
  /** Store results grid ↔ Load More, and vertical exits from the grid. */
  const crossStoreRegions = (element: HTMLElement, direction: Direction, { region, choose, crossRegion }: Beam) => {
    const store = element.closest<HTMLElement>('.store-page');
    if (!store || !(region instanceof HTMLElement)) return;
    if (region.hasAttribute('data-gamepad-grid')) {
      const footer = store.querySelector<HTMLElement>('[data-gamepad-library-footer]');
      if (footer && direction === 'down') return crossRegion(footer);
      if (direction === 'up' || direction === 'down') return choose(store);
    } else if (region.hasAttribute('data-gamepad-library-footer') && direction === 'up') {
      const grid = store.querySelector<HTMLElement>('[data-gamepad-grid]');
      if (grid) return crossRegion(grid);
    }
  };
  // Cross library rows explicitly, without diagonal drift into an
  // unrelated card or control. Sidebar exit is handled separately.
  const crossLibraryRows = (element: HTMLElement, direction: Direction, { region, crossRegion }: Beam) => {
    const library = element.closest<HTMLElement>('.library-page');
    if (!library || !(region instanceof HTMLElement)) return;
    let next: string | undefined;
    if (region.hasAttribute('data-gamepad-grid') && direction === 'up') next = '[data-gamepad-filters]';
    else if (region.hasAttribute('data-gamepad-grid') && direction === 'down') next = '[data-gamepad-library-footer]';
    else if (region.hasAttribute('data-gamepad-filters') && direction === 'up') next = '[data-gamepad-library-header]';
    else if (region.hasAttribute('data-gamepad-library-header') && direction === 'down') next = '[data-gamepad-filters]';
    else if ((region.hasAttribute('data-gamepad-filters') && direction === 'down') || (region.hasAttribute('data-gamepad-library-footer') && direction === 'up')) next = '[data-gamepad-grid]';
    const root = next ? library.querySelector<HTMLElement>(next) : undefined;
    const target = root ? crossRegion(root) : undefined;
    // Nothing below the grid's last row: scroll so further cards come into view.
    if (!target && direction === 'down' && region.hasAttribute('data-gamepad-grid')) {
      const parent = scrollParent(focusBox(element));
      if (parent) parent.scrollTop += Math.min(260, parent.clientHeight * 0.5);
    }
    return target;
  };
  /** Down from the bottom of the sidebar or page reaches the Social button; Up leaves it. */
  const toSocialToggle = (element: HTMLElement, direction: Direction) => {
    const social = doc.querySelector<HTMLElement>('[data-gamepad-social-toggle]');
    if (scope !== doc || !social || !enabled(social)) return;
    if (direction === 'down' && element.closest('.sidebar,.page-scroll')) return social;
    if (element === social && direction === 'up') return candidates(doc.querySelector<HTMLElement>('.sidebar') ?? doc).at(-1);
  };
  /** Left from the page hands focus to the active sidebar item, remembering where it left. */
  const toSidebar = (element: HTMLElement, direction: Direction) => {
    if (scope !== doc || direction !== 'left' || !element.closest('.content-shell')) return;
    const sidebar = doc.querySelector<HTMLElement>('.sidebar');
    if (!sidebar) return;
    const target = candidates(sidebar).find(item => item.matches('.nav-item.active'))
      ?? candidates(sidebar).find(item => item.matches('.nav-item'));
    if (!target) return;
    const current = page();
    if (current) pageReturns.set(current, remember(element));
    // This is a focus handoff, not a page change. In particular,
    // leaving a game detail must not reselect/reset its Library page.
    focus(target);
  };
  /** Explicit exits first, then the beam, then region fallbacks in priority order. */
  const move = (element: HTMLElement, direction: Direction) => {
    const exit = fromTopbar(element, direction) ?? fromSidebar(element, direction);
    if (exit) { focus(exit.target, exit.select); return; }
    const beam = beamFrom(element, direction);
    const target = beam.choose(beam.region)
      ?? crossStoreRegions(element, direction, beam)
      ?? crossLibraryRows(element, direction, beam)
      ?? toSocialToggle(element, direction);
    if (target) focus(target, true);
    else toSidebar(element, direction);
  };
  const action = (value: PadAction) => {
    ensureFocus();
    if (directions.includes(value as Direction)) {
      const element = focused();
      if (element) move(element, value as Direction);
    } else if (value === 'accept') activate();
    else if (value === 'back') back();
    else if (value === 'search') {
      if (scope === doc || scope instanceof HTMLElement && scope.hasAttribute('data-gamepad-social-shelf')) options.search?.();
    }
    else if (value === 'social') {
      if (scope === doc) options.social?.();
      else if (scope instanceof HTMLElement && scope.hasAttribute('data-gamepad-social-shelf')) scope.querySelector<HTMLElement>('[data-gamepad-social-close]')?.click();
    }
    else if (value === 'options') {
      const origin = detailReturn && focused()?.closest('[data-gamepad-detail]')?.getAttribute('data-gamepad-detail') === detailReturn.id ? detailReturn.origin : focused();
      const trigger = origin?.closest('.library-card-wrap')?.querySelector<HTMLElement>('[data-game-menu-trigger]');
      if (trigger && scope.contains(trigger) && enabled(trigger)) trigger.click();
    } else if (scope instanceof HTMLElement && scope.hasAttribute('data-gamepad-gallery')) {
      // Shoulder buttons change only the active gallery, never the page behind it.
      const target = scope.querySelector<HTMLElement>(value === 'previous-page' ? '[data-gamepad-gallery-previous]' : '[data-gamepad-gallery-next]');
      if (target && enabled(target)) target.click();
    } else if (scope instanceof HTMLElement && scope.querySelector('[data-gamepad-tabs]')) {
      const tabs = candidates(scope).filter(element => element.hasAttribute('data-gamepad-tab'));
      const current = tabs.findIndex(element => element.getAttribute('aria-selected') === 'true');
      if (tabs.length && current !== -1) {
        const target = tabs[(current + (value === 'previous-page' ? -1 : 1) + tabs.length) % tabs.length];
        focus(target); target.click();
      }
    } else if (scope === doc) {
      options.page(value === 'previous-page' ? -1 : 1);
      pageFocus();
    }
  };
  const scroll = (value: number, elapsed: number) => {
    const canScroll = (element: HTMLElement) => element.scrollHeight > element.clientHeight && /auto|scroll/.test(win.getComputedStyle(element).overflowY);
    let element = focused();
    if (element && !scope.contains(element)) element = undefined;
    // Walk up from focus, never past the active scope.
    while (element && !canScroll(element)) element = element === scope ? undefined : element.parentElement ?? undefined;
    element ??= [...scope.querySelectorAll<HTMLElement>('[data-gamepad-scroll],pre,.page-scroll,.game-dialog')].find(canScroll);
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
  doc.addEventListener('focusin', recordFocus);
  frame = win.requestAnimationFrame(tick);
  return () => {
    stopped = true; win.cancelAnimationFrame(frame); closePicker(false); setMode(false); inputs.clear();
    win.removeEventListener('pointerdown', pointer, true);
    win.removeEventListener('pointermove', pointerMove, true);
    win.removeEventListener('keydown', keyboard, true);
    win.removeEventListener('blur', blur); doc.removeEventListener('visibilitychange', blur);
    doc.removeEventListener('focusin', recordFocus);
  };
}
import { ui } from './i18n';
