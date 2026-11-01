// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGamepadNavigation } from './gamepad-navigation';
import { gamepadHarness } from './gamepad-test-harness';

const get = (id: string) => document.getElementById(id)!;
let stop: (() => void) | undefined;
let harness: ReturnType<typeof gamepadHarness>;
let callbacks: { back: ReturnType<typeof vi.fn>; page: ReturnType<typeof vi.fn>; social: ReturnType<typeof vi.fn>; keyboard: ReturnType<typeof vi.fn> };
beforeEach(() => {
  document.body.innerHTML = `<aside class="sidebar">
    <button id="library" class="nav-item active" data-gamepad-auto-select data-test-rect="0,100,100,40">Library</button>
    <button id="store" class="nav-item" data-gamepad-auto-select data-test-rect="0,160,100,40">Store</button>
  </aside><section class="content-shell"><div class="page-scroll" data-gamepad-page="library">
    <main class="library-page"><div data-gamepad-grid id="grid">
      <button id="one" data-gamepad-detail-target="one" data-test-rect="200,200,100,100">One</button>
      <button id="two" data-gamepad-detail-target="two" data-test-rect="320,200,100,100">Two</button>
      <button id="three" data-gamepad-detail-target="three" data-test-rect="440,200,100,100">Three</button>
      <button id="four" data-gamepad-detail-target="four" data-test-rect="200,320,100,100">Four</button>
    </div><div data-gamepad-library-footer id="footer"><button id="more" data-test-rect="320,460,100,40">More</button></div></main>
  </div><aside id="shelf" hidden data-gamepad-layer data-gamepad-social-shelf>
    <button id="close" data-gamepad-cancel data-gamepad-social-close>Close</button><button id="friend">Friend</button>
  </aside></section><button id="social" data-gamepad-social-toggle data-gamepad-key="social-toggle" data-test-rect="600,600,100,40">Social</button>`;
  harness = gamepadHarness();
  callbacks = { back: vi.fn(), page: vi.fn(), social: vi.fn(() => { get('shelf').hidden = false; }), keyboard: vi.fn(async () => true) };
  stop = installGamepadNavigation(window, { mode: vi.fn(), ...callbacks });
  harness.step(); // arm only after a neutral frame
});
afterEach(() => { stop?.(); vi.restoreAllMocks(); document.body.innerHTML = ''; });
const wake = (id: string) => { get(id).focus(); harness.press(2); };

describe('focus recovery', () => {
  it('preserves an explicitly focused sidebar action on the first controller input after mouse navigation', () => {
    document.querySelector<HTMLElement>('.page-scroll')!.dataset.gamepadPage = 'settings';
    const action = document.createElement('button'); action.textContent = 'Notifications'; action.className = 'notification-bell';
    document.querySelector('.sidebar')!.append(action);
    const click = vi.fn(); action.onclick = click; action.focus(); harness.press(0);
    expect(document.activeElement).toBe(action); expect(click).toHaveBeenCalledOnce();
  });
  it('opens the keyboard only when A activates an editable field, not when navigation focuses it', () => {
    get('grid').insertAdjacentHTML('afterbegin', '<input id="search" type="search" data-test-rect="200,140,300,40">');
    wake('search'); expect(callbacks.keyboard).not.toHaveBeenCalled();
    harness.press(0);
    expect(callbacks.keyboard).toHaveBeenCalledOnce();
    expect(callbacks.keyboard).toHaveBeenCalledWith({ x: 200, y: 140, width: 300, height: 40, mode: 0 });
    expect(document.activeElement).toBe(get('search'));
    (get('search') as HTMLInputElement).readOnly = true; harness.press(0);
    expect(callbacks.keyboard).toHaveBeenCalledTimes(1);
  });
  it('moves a single card highlight from a remembered installed game onto an account card and the footer', () => {
    get('one').outerHTML = '<article data-gamepad-card class="catalog-card selected"><button id="one" data-gamepad-auto-select="focus" data-gamepad-detail-target="one" data-test-rect="200,200,100,100">Installed</button></article>';
    get('four').outerHTML = '<article data-gamepad-card class="catalog-card" data-test-rect="200,320,100,100"><button id="four" data-gamepad-detail-target="four" data-test-rect="200,320,100,100">Account card</button></article>';
    // Card geometry comes from its wrapper, just as in the real library.
    get('one').parentElement!.dataset.testRect = '200,200,100,100';
    wake('one');
    expect(document.querySelectorAll('[data-gamepad-focus]')).toHaveLength(1);
    expect(get('one').parentElement!.hasAttribute('data-gamepad-focus')).toBe(true);
    harness.press(13);
    expect(document.activeElement).toBe(get('four'));
    expect(document.querySelectorAll('[data-gamepad-focus]')).toHaveLength(1);
    expect(get('one').parentElement!.hasAttribute('data-gamepad-focus')).toBe(false);
    expect(get('four').parentElement!.hasAttribute('data-gamepad-focus')).toBe(true);
    harness.press(13);
    expect(document.activeElement).toBe(get('more'));
    expect(document.querySelectorAll('[data-gamepad-card][data-gamepad-focus]')).toHaveLength(0);
  });
  it('holds busy pagination focus, blocks duplicate activation, and recovers into the grid when it ends', () => {
    const load = vi.fn(); get('more').onclick = load;
    wake('more');
    get('more').setAttribute('aria-disabled', 'true'); get('more').setAttribute('aria-busy', 'true');
    harness.step(); harness.press(0);
    expect(document.activeElement).toBe(get('more')); expect(load).not.toHaveBeenCalled();
    get('more').remove(); harness.step();
    expect(document.activeElement?.closest('#grid')).toBe(get('grid'));
    const store = vi.fn(); get('store').onclick = store;
    harness.press(13);
    expect(store).not.toHaveBeenCalled(); expect(callbacks.page).not.toHaveBeenCalled();
  });
  it('retains the pending disabled anchor and lets the user navigate away', () => {
    wake('more'); (get('more') as HTMLButtonElement).disabled = true; harness.step();
    expect(get('more').hasAttribute('data-gamepad-focus')).toBe(true);
    harness.press(12);
    expect(document.activeElement?.closest('#grid')).toBe(get('grid'));
  });
  it('restores the last game by key after switching pages and replacing its DOM node', () => {
    wake('two');
    const content = document.querySelector<HTMLElement>('.page-scroll')!;
    const library = content.innerHTML;
    content.dataset.gamepadPage = 'home'; content.innerHTML = '<button id="home">Home card</button>'; harness.step();
    get('home').focus();
    content.dataset.gamepadPage = 'library'; content.innerHTML = library; harness.step();
    expect(document.activeElement).toBe(get('two'));
  });
  it('never clicks an auto-select control during recovery', () => {
    const select = vi.fn(); get('library').onclick = select; wake('one');
    document.querySelector('.page-scroll')!.innerHTML = ''; harness.step();
    expect(document.activeElement).toBe(get('library')); expect(select).not.toHaveBeenCalled();
  });
});

describe('rows and region crossings', () => {
  it('moves down from an overhanging column into the shorter next row', () => {
    wake('three'); harness.press(13); expect(document.activeElement).toBe(get('four'));
    harness.press(12); expect(document.activeElement).toBe(get('one'));
  });
  it.each(['one', 'two', 'three'])('reaches Load More from bottom-row card %s', id => {
    get('four').remove(); wake(id); harness.press(13); expect(document.activeElement).toBe(get('more'));
    harness.press(12); expect(document.activeElement?.closest('#grid')).toBe(get('grid'));
  });
  it('crosses between the Store grid and its pagination in both directions', () => {
    const main = document.querySelector('main')!; main.className = 'store-page';
    get('four').remove(); wake('three'); harness.press(13);
    expect(document.activeElement).toBe(get('more'));
    harness.press(12); expect(document.activeElement?.closest('#grid')).toBe(get('grid'));
  });
  it('provides a directional route to Social from the sidebar and back', () => {
    wake('store'); harness.press(13); expect(document.activeElement).toBe(get('social'));
    harness.press(12); expect(document.activeElement).toBe(get('store'));
  });
});

describe('exclusive overlay input', () => {
  it('opens Social with View, contains directions and shoulders, and restores the opener with B', () => {
    wake('two'); harness.press(8);
    expect(callbacks.social).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(get('close'));
    harness.press(14); harness.press(12); harness.press(4); harness.press(5);
    expect(document.activeElement?.closest('#shelf')).toBe(get('shelf')); expect(callbacks.page).not.toHaveBeenCalled();
    get('close').onclick = () => { get('shelf').hidden = true; };
    harness.press(1); expect(document.activeElement).toBe(get('two')); expect(callbacks.back).not.toHaveBeenCalled();
  });
  it('refreshes the opener on every opening of a persistent shelf', () => {
    get('close').onclick = () => { get('shelf').hidden = true; };
    wake('one'); harness.press(8); harness.press(1);
    get('three').focus(); harness.press(8); harness.press(1);
    expect(document.activeElement).toBe(get('three'));
  });
  it('cycles only the active layer tabs with bumpers, wrapping in both directions', () => {
    get('shelf').insertAdjacentHTML('beforeend', `<nav data-gamepad-tabs>
      <button id="party" data-gamepad-tab aria-selected="false">Party</button>
      <button id="people" data-gamepad-tab aria-selected="true">People</button>
      <button id="chats" data-gamepad-tab aria-selected="false">Chats</button>
    </nav>`);
    for (const tab of document.querySelectorAll<HTMLElement>('[data-gamepad-tab]')) tab.onclick = () => {
      document.querySelectorAll('[data-gamepad-tab]').forEach(element => element.setAttribute('aria-selected', String(element === tab)));
    };
    wake('one'); harness.press(8); harness.press(5);
    expect(document.activeElement).toBe(get('chats'));
    harness.press(5); expect(document.activeElement).toBe(get('party'));
    harness.press(4); expect(document.activeElement).toBe(get('chats'));
    expect(callbacks.page).not.toHaveBeenCalled();
  });
  it('restores an opener replaced with the same stable game key', () => {
    wake('one'); harness.press(8);
    get('one').outerHTML = '<button id="replacement" data-gamepad-detail-target="one">Replacement</button>';
    get('close').onclick = () => { get('shelf').hidden = true; };
    harness.press(1); expect(document.activeElement).toBe(get('replacement'));
  });
  it('preserves both return points through a nested dialog', () => {
    wake('one'); harness.press(8); get('friend').focus();
    const dialog = document.createElement('section'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = '<button id="nested-close" data-gamepad-cancel>Close nested</button>'; get('shelf').append(dialog);
    get('nested-close').onclick = () => dialog.remove(); harness.step(); harness.press(1);
    expect(document.activeElement).toBe(get('friend'));
    get('close').onclick = () => { get('shelf').hidden = true; }; harness.press(1);
    expect(document.activeElement).toBe(get('one'));
  });
  it('recognises non-modal notification layers and never activates a background detail Back', () => {
    get('grid').insertAdjacentHTML('beforeend', '<button data-gamepad-detail-back id="detail-back">Back</button>');
    const back = vi.fn(); get('detail-back').onclick = back;
    wake('one'); get('shelf').removeAttribute('data-gamepad-social-shelf'); get('shelf').hidden = false; harness.step();
    harness.press(1); expect(back).not.toHaveBeenCalled(); expect(callbacks.back).not.toHaveBeenCalled();
  });
  it('does not scroll an ancestor page behind a non-scrolling modal', () => {
    const content = document.querySelector<HTMLElement>('.page-scroll')!;
    content.style.overflowY = 'auto'; Object.defineProperty(content, 'scrollHeight', { value: 2000 }); Object.defineProperty(content, 'clientHeight', { value: 500 });
    get('grid').insertAdjacentHTML('beforeend', '<section role="dialog" aria-modal="true"><button id="modal-close" data-gamepad-cancel>Close</button></section>');
    wake('modal-close'); const before = content.scrollTop;
    harness.step([], [0, 0, 0, 0.9]); expect(content.scrollTop).toBe(before);
  });
  it('releases listeners and animation frames on uninstall', () => {
    wake('one'); stop?.(); stop = undefined; harness.step([8]);
    expect(callbacks.social).not.toHaveBeenCalled(); expect(harness.pending()).toBe(0);
  });
});
