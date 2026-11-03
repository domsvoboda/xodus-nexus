// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { SettingsPage } from './App';
import { useNotifications } from './Notifications';
import { demoSnapshot } from '../shared/demo-data';
import { messageNoticeKey } from './notification-state';

it('shows player credentials independently after Store sign-out and explains full sign-out retention', () => {
  const data = demoSnapshot();
  Object.assign(data.backend.capabilities, { playerAccount: true, savedAccounts: true });
  data.auth = { ...data.auth, stored: false, username: undefined, player: 'player@example.test', gamertag: 'PersonalPlayer', saved: ['store@example.test'] };
  const html = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
  expect(html).toContain('PersonalPlayer · player@example.test');
  expect(html).toContain('Sign out player account');
  expect(html).toContain('Sign out all accounts');
  expect(html).toContain('Saved Store accounts remain available until forgotten.');
  expect(html).toContain('store@example.test');
});

it('keeps notification reads and broker acknowledgements scoped to the effective Xbox player', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const data = demoSnapshot();
  data.auth = { ...data.auth, stored: true, username: 'shared-store', player: 'player-one' };
  data.backend.capabilities.nativeSocial = true;
  data.backend.binaryPath = '/synthetic/cli';
  window.launcher = { getXboxChatReads: vi.fn(async () => undefined), onXboxChatReads: () => () => {}, viewedXboxChat: vi.fn(async () => {}) } as unknown as Window['launcher'];
  localStorage.clear();
  const key = messageNoticeKey('42', 'one');
  localStorage.setItem('nexus.notifications.v1.player-one', JSON.stringify([key]));
  let notices!: ReturnType<typeof useNotifications>;
  function Fixture() { notices = useNotifications(data); return null; }
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<Fixture />));
    expect(notices.readKeys).toEqual([key]);
    await act(async () => notices.viewed('42', ['two']));
    expect(window.launcher.viewedXboxChat).toHaveBeenLastCalledWith('player-one', '/synthetic/cli', '42', ['two']);
    data.auth = { ...data.auth, player: 'player-two' };
    await act(async () => root.render(<Fixture />));
    expect(notices.readKeys).toEqual([]);
    await act(async () => notices.viewed('43', ['three']));
    expect(window.launcher.viewedXboxChat).toHaveBeenLastCalledWith('player-two', '/synthetic/cli', '43', ['three']);
    expect(localStorage.getItem('nexus.notifications.v1.shared-store')).toBeNull();
    expect(localStorage.getItem('nexus.notifications.v1.player-one')).not.toContain('three');
  } finally { await act(async () => root.unmount()); element.remove(); localStorage.clear(); vi.unstubAllGlobals(); }
});
