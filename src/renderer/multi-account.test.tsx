// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { SettingsPage, Sidebar } from './App';
import { useNotifications } from './Notifications';
import { demoSnapshot } from '../shared/demo-data';
import { messageNoticeKey } from './notification-state';

it('shows player credentials independently after Store sign-out and explains full sign-out retention', () => {
  const data = demoSnapshot();
  Object.assign(data.backend.capabilities, { playerAccount: true, savedAccounts: true });
  data.settings.multiAccountEnabled = true;
  data.auth = { ...data.auth, stored: false, savedAccountsEnabled: true, username: undefined, player: 'player@example.test', gamertag: 'PersonalPlayer', saved: ['store@example.test'] };
  const html = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
  expect(html).toContain('PersonalPlayer · player@example.test');
  expect(html).toContain('Sign out player account');
  expect(html).toContain('Sign out all accounts');
  expect(html).toContain('Saved Store accounts remain available until forgotten.');
  expect(html).toContain('store@example.test');
  expect(renderToStaticMarkup(<Sidebar data={data} page="settings" go={()=>{}} />)).toContain('Store signed out');
});

it('keeps notification reads and broker acknowledgements scoped to the effective Xbox player', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window.localStorage);
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
    data.auth = { ...data.auth, stored: false, username: undefined, player: 'player-two' };
    await act(async () => root.render(<Fixture />));
    expect(notices.readKeys).toEqual([]);
    await act(async () => notices.viewed('43', ['three']));
    expect(window.launcher.viewedXboxChat).toHaveBeenLastCalledWith('player-two', '/synthetic/cli', '43', ['three']);
    expect(localStorage.getItem('nexus.notifications.v1.shared-store')).toBeNull();
    expect(localStorage.getItem('nexus.notifications.v1.player-one')).not.toContain('three');
  } finally { await act(async () => root.unmount()); element.remove(); localStorage.clear(); vi.unstubAllGlobals(); }
});

it('keeps multiple-account controls hidden by default while exposing an active player honestly', () => {
 const data=demoSnapshot();Object.assign(data.backend.capabilities,{savedAccounts:true,playerAccount:true});
 data.auth={...data.auth,saved:['other-store@example.test'],player:undefined};
 let html=renderToStaticMarkup(<SettingsPage data={data} toast={()=>{}}/>);
 expect(html).toContain('Manage multiple accounts');expect(html).not.toContain('saved-accounts');expect(html).not.toContain('Sign in player account');expect(html.toLowerCase()).toContain('microsoft account');
 data.auth.player='personal-player@example.test';
 html=renderToStaticMarkup(<SettingsPage data={data} toast={()=>{}}/>);
 expect(html).toContain('Xbox player: personal-player@example.test');expect(html).toContain('Sign out all accounts');expect(html).toContain('Manage multiple accounts');expect(html).not.toContain('Change player account');
});

it('explicitly expands, persists and hides management without signing out or changing accounts', async () => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=demoSnapshot();Object.assign(data.backend.capabilities,{savedAccounts:true,playerAccount:true});
 data.auth={...data.auth,player:'personal-player@example.test',saved:['stored-account@example.test'],savedAccountsEnabled:true};
 const credentials={login:vi.fn(),logout:vi.fn(),useAccount:vi.fn(),forgetAccount:vi.fn()};
 window.launcher={...credentials,onOperationLog:()=>()=>{},updateSettings:vi.fn(async patch=>({...data.settings,...patch}))} as unknown as Window['launcher'];
 const element=document.createElement('div');document.body.append(element);const root=createRoot(element);
 const click=async(text:string)=>act(async()=>[...element.querySelectorAll('button')].find(button=>button.textContent===text)!.click());
 try {
  await act(async()=>root.render(<SettingsPage data={data} toast={()=>{}}/>));
  expect(element.querySelector('.saved-accounts')).toBeNull();
  await click('Manage multiple accounts');expect(window.launcher.updateSettings).toHaveBeenLastCalledWith({multiAccountEnabled:true});expect(element.querySelector('.saved-accounts')).not.toBeNull();expect(element.textContent).toContain('Change player account');
  await click('Hide account management');expect(window.launcher.updateSettings).toHaveBeenLastCalledWith({multiAccountEnabled:false});expect(element.querySelector('.saved-accounts')).toBeNull();expect(element.textContent).toContain('Xbox player: personal-player@example.test');
  for(const method of Object.values(credentials))expect(method).not.toHaveBeenCalled();
 } finally {await act(async()=>root.unmount());element.remove();vi.unstubAllGlobals();}
});

it('does not offer opt-in on a backend without verified retention support and pauses the action during sign-in', () => {
 const data=demoSnapshot();Object.assign(data.backend.capabilities,{playerAccount:true,savedAccounts:false});
 data.auth={...data.auth,player:'personal@example.test'};
 let html=renderToStaticMarkup(<SettingsPage data={data} toast={()=>{}}/>);
 expect(html).not.toContain('Manage multiple accounts');expect(html).toContain('Xbox player: personal@example.test');
 data.backend.capabilities.savedAccounts=true;data.auth.running=true;
 html=renderToStaticMarkup(<SettingsPage data={data} toast={()=>{}}/>);
 expect(html).toMatch(/aria-expanded="false" disabled="">Manage multiple accounts/);
});

it('requires explicit verified retention recovery when a saved display preference outlives the backend vault', () => {
 const data=demoSnapshot();data.settings.multiAccountEnabled=true;data.auth.savedAccountsEnabled=false;
 Object.assign(data.backend.capabilities,{savedAccounts:true,playerAccount:true});data.auth.saved=['stale@example.test'];
 const html=renderToStaticMarkup(<SettingsPage data={data} toast={()=>{}}/>);
 expect(html).toContain('Manage multiple accounts');expect(html).not.toContain('Hide account management');expect(html).not.toContain('saved-accounts');expect(html).not.toContain('Sign in player account');
});
