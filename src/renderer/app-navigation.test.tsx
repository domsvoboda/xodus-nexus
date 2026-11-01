// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { demoAccountLibrary, demoLaunchOptions, demoSnapshot } from '../shared/demo-data';
import { gamepadHarness } from './gamepad-test-harness';
import { createDemoSocial } from '../shared/demo-social';

let root: Root;
let harness: ReturnType<typeof gamepadHarness>;
const get = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw Error(`Missing control: ${selector}`);
  return element;
};
const click = async (selector: string) => { await act(async () => { get(selector).focus(); get(selector).click(); }); };
const press = async (button: number) => { await act(async () => { harness.press(button); }); await act(async () => { harness.step(); }); };
const typeSearch = async (query: string) => {
  await act(async () => {
    const input = get('.search-box input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Node 25+ has its own storage global. Keep these browser tests on jsdom's
  // per-window storage, without a Node backing file or extra launch flags.
  vi.stubGlobal('localStorage', (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window.localStorage);
  localStorage.clear(); window.location.hash = '';
  harness = gamepadHarness();
  const data = demoSnapshot();
  // No live account or API calls; exercise the actual App and page components.
  data.auth.stored = true;
  const unsubscribe = () => () => {};
  const demo = createDemoSocial();
  let profileListener: ((request: { id: string; xuid: string }) => void) | undefined;
  window.launcher = {
    getSnapshot: vi.fn(async () => data), onSnapshot: unsubscribe,
    onOpenFriends: unsubscribe, onLauncherPage: unsubscribe, onOperationLog: unsubscribe,
    onXboxDesktopProfile: (callback: typeof profileListener) => { profileListener = callback; return () => { profileListener = undefined; }; }, getXboxDesktopProfile: vi.fn(async () => undefined),
    isDemoTour: () => false,
    showTouchKeyboard: vi.fn(async () => false),
    getGameLaunchOptions: vi.fn(async () => demoLaunchOptions),
    getAccountLibrary: vi.fn(async () => demoAccountLibrary('all', new Map())),
    getGameDetails: vi.fn(async () => undefined),
    getGameActivity: vi.fn(async () => ({ status: 'unsupported' })),
    getGameAchievements: vi.fn(async () => ({ status: 'unsupported' })),
    searchCatalog: vi.fn(async (query: string) => ({ query, products: [], hasMore: false })),
    getFeaturedCatalog: vi.fn(async () => ({ query: '', products: [], hasMore: false })),
    ...demo.voice,
    getXboxChatReads: vi.fn(async () => undefined), onXboxChatReads: unsubscribe, viewedXboxChat: vi.fn(async () => {}),
    nativeSocial: { ...demo.social, openXboxPlayerProfile: vi.fn(async (xuid: string) => { profileListener?.({ id: 'demo-full-profile', xuid }); }) },
  } as unknown as Window['launcher'];
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(get('#root'));
  await act(async () => { root.render(<StrictMode><App /></StrictMode>); });
  await act(async () => { harness.step(); });
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

it.each([true, false])('returns from Load More to the previous game before entering the new rows (more pages: %s)', async hasMore => {
  const first = demoAccountLibrary('all', new Map());
  let finish!: (value: typeof first) => void;
  vi.mocked(window.launcher.getAccountLibrary).mockImplementation(async (_kind, cursor) => cursor
    ? new Promise(resolve => { finish = resolve; }) : { ...first, products: [], cursor: 'next-page' });
  await click('.sidebar nav button:nth-child(2)');
  const cards = [...document.querySelectorAll<HTMLElement>('[data-gamepad-grid] [data-gamepad-detail-target]')];
  const origin = cards.at(-1)!;
  cards.forEach((card, index) => { (card.closest<HTMLElement>('[data-gamepad-card]') ?? card).dataset.testRect = `200,${200 + index * 120},100,100`; });
  const more = get('[data-gamepad-library-footer] button');
  more.dataset.testRect = `200,${200 + cards.length * 120},100,40`;
  await press(3);
  await act(async () => { origin.focus(); harness.step(); });
  await press(13);
  expect(document.activeElement).toBe(more);
  await press(0);
  expect(more.getAttribute('aria-busy')).toBe('true');
  expect(document.activeElement).toBe(more);
  await act(async () => { finish({ ...first, cursor: hasMore ? 'last-page' : undefined }); });
  expect(document.activeElement).toBe(origin);
  const added = [...document.querySelectorAll<HTMLElement>('[data-gamepad-grid] [data-gamepad-detail-target]')].find(card => !cards.includes(card))!;
  added.closest<HTMLElement>('[data-gamepad-card]')!.dataset.testRect = `200,${200 + cards.length * 120},100,100`;
  await press(13);
  expect(document.activeElement).toBe(added);
});

it('navigates Search suggestions in both directions, selects a game, and offers full results without a match', async () => {
  await press(3); await typeSearch('Forza');
  const suggestion = get('#global-search-results button');
  await press(13); expect(document.activeElement).toBe(suggestion);
  await press(13); expect(document.activeElement).toBe(get('.search-all-results'));
  await press(13); expect(document.activeElement).toBe(get('.search-all-results'));
  await press(12); expect(document.activeElement).toBe(suggestion);
  await press(12); expect(document.activeElement).toBe(get('.search-box input'));
  await press(13); await press(0);
  expect(get('[data-gamepad-detail]').dataset.gamepadDetail).toBe(demoSnapshot().games.find(game => game.title.includes('Forza'))!.id);
  await press(3); await typeSearch('not installed here');
  expect(document.querySelectorAll('#global-search-results button')).toHaveLength(1);
  await press(13); expect(document.activeElement).toBe(get('.search-all-results'));
  // The full-results action uses the same submission path as Enter.
  await press(0);
  expect(document.querySelector('.store-page')).not.toBeNull();
  expect(document.querySelector('#global-search-results')).toBeNull();
});

it('dismisses Search with B, clears the query, and returns to the active Library game without changing pages', async () => {
  await click('.sidebar nav button:nth-child(2)');
  const card = get('.library-card');
  await press(3);
  await act(async () => { card.focus(); harness.step(); });
  await press(3); await typeSearch('Forza');
  await press(13); expect(document.activeElement?.closest('#global-search-results')).not.toBeNull();
  await press(1);
  expect((get('.search-box input') as HTMLInputElement).value).toBe('');
  expect(document.querySelector('#global-search-results')).toBeNull();
  expect(document.querySelector('.library-page')).not.toBeNull();
  expect(document.activeElement).toBe(card);
});

it.each(['.home-feature-card', '.poster-card'])('opens the clicked Home game and returns to its card with B (%s)', async selector => {
  const card = get(selector), key = card.dataset.gamepadKey!;
  const id = key.slice(key.indexOf(':') + 1);
  await click(selector);
  expect(get('[data-gamepad-detail]').dataset.gamepadDetail).toBe(id);
  expect(document.activeElement).toBe(get('[data-gamepad-play]'));
  expect(get('[data-gamepad-detail-back]').textContent).toContain('Back to Home');
  await press(1);
  expect(document.querySelector('.home-page')).not.toBeNull();
  expect((document.activeElement as HTMLElement).dataset.gamepadKey).toBe(key);
});

it('falls back to Back to Home when the selected game cannot be played', async () => {
  const game = demoSnapshot().games.find(game => game.installState === 'incomplete')!;
  await click(`[data-gamepad-key="home-poster:${game.id}"]`);
  expect(get('[data-gamepad-play]').matches(':disabled')).toBe(true);
  expect(document.activeElement).toBe(get('[data-gamepad-detail-back]'));
  expect(document.activeElement?.textContent).toContain('Back to Home');
  await click('[data-gamepad-detail-back]');
  expect(document.querySelector('.home-page')).not.toBeNull();
});

it('consumes a sidebar game request so later plain Library navigation opens the grid', async () => {
  await click('.recents button:nth-of-type(2)');
  expect(get('[data-gamepad-detail]').dataset.gamepadDetail).toBe(demoSnapshot().games[1].id);
  await click('.sidebar nav button:first-child');
  await click('.sidebar nav button:nth-child(2)');
  expect(document.querySelector('.library-page')).not.toBeNull();
  expect(document.querySelector('[data-gamepad-detail]')).toBeNull();
});

it('opens the clicked Home game even after a different sidebar game was selected', async () => {
  await click('.recents button:first-of-type');
  await click('.sidebar nav button:first-child');
  await click('.home-feature-card');
  expect(get('[data-gamepad-detail]').dataset.gamepadDetail).toBe(demoSnapshot().games[1].id);
});

it('preserves the working Library card → details → B focus restoration', async () => {
  await click('.sidebar nav button:nth-child(2)');
  const card = get('.library-card'), id = card.dataset.gamepadDetailTarget;
  await click('.library-card');
  expect(document.activeElement).toBe(get('[data-gamepad-play]'));
  expect(get('[data-gamepad-detail-back]').textContent).toContain('Back to library');
  await press(1);
  expect(document.querySelector('[data-gamepad-detail]')).toBeNull();
  expect((document.activeElement as HTMLElement).dataset.gamepadDetailTarget).toBe(id);
});

it('opens Social with View, makes the background inert, and closes it with B without changing pages', async () => {
  get('.poster-card').focus(); await press(2); await press(8);
  expect(get('#nexus-social-shelf').getAttribute('aria-modal')).toBe('true');
  expect(get('.page-scroll').inert).toBe(true); expect(get('.sidebar').inert).toBe(true);
  expect(document.activeElement?.closest('#nexus-social-shelf')).not.toBeNull();
  await press(5); expect(document.querySelector('.home-page')).not.toBeNull();
  await press(1);
  expect(get('#nexus-social-shelf').inert).toBe(true); expect(get('.page-scroll').inert).toBe(false);
  expect(document.activeElement).toBe(get('.poster-card'));
});

it('uses Y for Search and the keyboard, including when closing Social', async () => {
  get('.poster-card').focus(); await press(3);
  expect(document.activeElement).toBe(get('.search-box input'));
  expect(window.launcher.showTouchKeyboard).toHaveBeenCalledOnce();
  expect(get('#nexus-social-shelf').inert).toBe(true);
  await press(8); expect(get('#nexus-social-shelf').inert).toBe(false);
  await press(3); expect(get('#nexus-social-shelf').inert).toBe(true);
  expect(document.activeElement).toBe(get('.search-box input'));
  expect(window.launcher.showTouchKeyboard).toHaveBeenCalledTimes(2);
});

it('starts Home at Play and lets Down leave Search for the main page', async () => {
  expect(document.activeElement).toBe(get('[data-gamepad-home-primary]'));
  await press(3); expect(document.activeElement).toBe(get('.search-box input'));
  await press(13); expect(document.activeElement).toBe(get('[data-gamepad-home-primary]'));
  expect(window.launcher.showTouchKeyboard).toHaveBeenCalledOnce();
});

it('preserves sidebar focus when opening Home from there, with a visible focus marker', async () => {
  await click('.sidebar nav button:nth-child(2)');
  await click('.sidebar nav button:first-child'); await press(2);
  expect(document.activeElement).toBe(get('.sidebar nav button:first-child'));
  expect(document.activeElement?.hasAttribute('data-gamepad-focus')).toBe(true);
  await press(15); expect(document.activeElement).toBe(get('[data-gamepad-home-primary]'));
});

it('returns to Play when Home is opened from a page rather than the sidebar', async () => {
  await click('.sidebar nav button:nth-child(2)');
  await act(async () => { get('.library-card').focus(); }); await press(1);
  expect(document.activeElement).toBe(get('[data-gamepad-home-primary]'));
});

it('keeps sidebar ownership when returning to Library after a shoulder-page switch', async () => {
  document.querySelectorAll<HTMLElement>('.sidebar nav button').forEach((button, index) => { button.dataset.testRect = `0,${100 + index * 60},100,40`; });
  await click('.sidebar nav button:nth-child(2)');
  const card = document.querySelectorAll<HTMLElement>('.library-card')[1];
  const game = card.dataset.gamepadDetailTarget;
  await act(async () => { card.focus(); });
  await press(4); // Library → Home via LB
  await press(14); // Left into Home's sidebar item
  expect(document.activeElement).toBe(get('.sidebar nav button:first-child'));
  await press(13); // Down activates Library in the sidebar
  expect(document.activeElement).toBe(get('.sidebar nav button:nth-child(2)'));
  await press(12); await press(13); // Repeated sidebar page changes keep ownership
  expect(document.activeElement).toBe(get('.sidebar nav button:nth-child(2)'));
  await press(15); // Only Right restores the remembered game
  expect((document.activeElement as HTMLElement).dataset.gamepadDetailTarget).toBe(game);
});

it('navigates from the sidebar account card to notifications, opens it and returns to the bell with B', async () => {
  get('.account-summary').dataset.testRect = '0,10,180,58';
  get('.notification-bell').dataset.testRect = '196,23,32,32';
  get('.sidebar nav button:first-child').dataset.testRect = '0,100,240,40';
  await press(14); await press(12);
  expect(document.activeElement).toBe(get('.account-summary'));
  await press(15); expect(document.activeElement).toBe(get('.notification-bell'));
  expect(document.activeElement?.hasAttribute('data-gamepad-focus')).toBe(true);
  await press(14); expect(document.activeElement).toBe(get('.account-summary'));
  await press(15); await press(0);
  expect(document.querySelector('#notification-panel')).not.toBeNull();
  expect(document.activeElement?.closest('#notification-panel')).not.toBeNull();
  await press(1);
  expect(document.querySelector('#notification-panel')).toBeNull();
  expect(document.activeElement).toBe(get('.notification-bell'));
  expect(window.launcher.nativeSocial.openXboxPlayerProfile).not.toHaveBeenCalled();
  await press(15); expect(document.activeElement).toBe(get('[data-gamepad-home-primary]'));
});

it('bumper navigation changes Social tabs while leaving the launcher page alone', async () => {
  await press(8);
  expect(get('[data-gamepad-tab][aria-selected="true"]').getAttribute('aria-label')).toBe('People');
  await press(5);
  expect(get('[data-gamepad-tab][aria-selected="true"]').getAttribute('aria-label')).toBe('Chats');
  await press(5);
  expect(get('[data-gamepad-tab][aria-selected="true"]').getAttribute('aria-label')).toContain('Your Xbox profile');
  expect(document.querySelector('.social-player-card')).not.toBeNull();
  expect(document.querySelector('.social-player-card .social-back')).toBeNull();
  expect(document.querySelector('.social-player-card .social-close')).toBeNull();
  expect(document.querySelector('#nexus-social-shelf .social-profile-controls .social-close')).not.toBeNull();
  await press(5);
  expect(get('[data-gamepad-tab][aria-selected="true"]').getAttribute('aria-label')).toBe('Party');
  expect(get('.social-party').hidden).toBe(false);
  await press(4);
  expect(get('[data-gamepad-tab][aria-selected="true"]').getAttribute('aria-label')).toContain('Your Xbox profile');
  await press(4);
  expect(get('[data-gamepad-tab][aria-selected="true"]').getAttribute('aria-label')).toBe('Chats');
  expect(document.querySelector('.home-page')).not.toBeNull();
});

it('opens the expanded own profile from the account card and leaves Settings on its own button', async () => {
  await click('.account-summary');
  expect(window.launcher.nativeSocial.openXboxPlayerProfile).toHaveBeenCalledWith('me');
  expect(document.querySelector('.nexus-social-page .social-expanded-view .social-player-card')).not.toBeNull();
  expect(document.querySelector('.nexus-social-page [data-gamepad-tabs]')).toBeNull();
  expect(document.querySelector('.nexus-social-page .social-back')).toBeNull();
  expect(document.querySelector('.settings-page')).toBeNull();
  await click('.sidebar-bottom .nav-item');
  expect(document.querySelector('.nexus-social-page')).toBeNull();
});

it('opens the same large profile without Social tabs from the small profile shortcut', async () => {
  await press(8); await press(5); await press(5);
  await click('.social-player-card button[aria-label="Open full Xbox profile"]');
  expect(document.querySelector('.nexus-social-page .social-expanded-view .social-player-card')).not.toBeNull();
  expect(document.querySelector('.nexus-social-page .social-tabs')).toBeNull();
  expect(get('#nexus-social-shelf').inert).toBe(true);
});

it('focuses and scrolls the large read-only profile with the right stick, including from Search', async () => {
  await click('.account-summary');
  const profile = get('.social-profile-scrollable');
  profile.style.overflowY = 'auto';
  Object.defineProperty(profile, 'scrollHeight', { value: 1800 }); Object.defineProperty(profile, 'clientHeight', { value: 500 });
  await press(2);
  expect(document.activeElement).toBe(profile);
  await act(async () => { harness.step([], [0, 0, 0, 0.9]); });
  expect(profile.scrollTop).toBeGreaterThan(0);
  profile.scrollTop = 0; await act(async () => { get('.search-box input').focus(); });
  await act(async () => { harness.step([], [0, 0, 0, 0.9]); });
  expect(profile.scrollTop).toBeGreaterThan(0);
});

it('renders and operates the demo party invitation, connected controls and leave action', async () => {
  await press(8); await press(4);
  expect(get('.social-party').hidden).toBe(false);
  await click('.social-party-invitations button');
  expect(document.querySelectorAll('.social-party-member')).toHaveLength(3);
  expect(get('.social-party-invite select')).toBeDefined();
  const leave = [...document.querySelectorAll<HTMLButtonElement>('.social-party-controls button')].find(button => button.textContent?.includes('Leave party'))!;
  await act(async () => { leave.click(); });
  expect(document.querySelectorAll('.social-party-member')).toHaveLength(0);
});

it('follows Settings rows across columns instead of skipping the tray and launcher controls', async () => {
  await click('.sidebar-bottom .nav-item');
  // Match the staggered rows in Settings: language left/save right, then a
  // small checkbox left, launcher buttons right, and account actions below.
  document.querySelectorAll<HTMLElement>('.settings-page button,.settings-page input,.settings-page select,.settings-page summary').forEach((element, index) => {
    element.dataset.testRect = `400,${2000 + index * 100},100,40`;
  });
  const language = get('.settings-language select'), save = get('.settings-language button');
  const tray = get('.tray-toggle input');
  const [updates, steam] = [...document.querySelectorAll<HTMLElement>('.launcher-card .button-row button')];
  const signIn = get('.account-card .button-row button');
  language.dataset.testRect = '430,270,330,56'; save.dataset.testRect = '1720,269,164,56';
  tray.closest<HTMLElement>('.check-field')!.dataset.testRect = '427,400,1457,48';
  tray.dataset.testRect = '427,413,22,22'; updates.dataset.testRect = '1400,551,227,56';
  steam.dataset.testRect = '1639,551,244,56'; signIn.dataset.testRect = '427,987,186,56';
  language.focus(); await press(2);
  await press(15); expect(document.activeElement).toBe(save);
  await press(14); expect(document.activeElement).toBe(language);
  await press(15); await press(13); expect(document.activeElement).toBe(tray);
  await press(13); expect(document.activeElement).toBe(updates);
  await press(15); expect(document.activeElement).toBe(steam);
  await press(14); expect(document.activeElement).toBe(updates);
  await press(12); expect(document.activeElement).toBe(tray);
  await press(12); expect(document.activeElement).toBe(language);
});
