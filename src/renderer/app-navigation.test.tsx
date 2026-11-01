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
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
