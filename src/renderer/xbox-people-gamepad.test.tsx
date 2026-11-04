// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {XboxFriend,XboxSocialApi} from '../shared/types';
import {XboxPeopleBrowser} from './XboxPeopleBrowser';
import {gamepadHarness} from './gamepad-test-harness';
import {installGamepadNavigation} from './gamepad-navigation';

let root:Root,stop:()=>void,harness:ReturnType<typeof gamepadHarness>;
const friend:XboxFriend={xuid:'123',gamertag:'Synthetic Friend',online:false,presence:'Offline',favorite:false,inParty:false};
const query=(selector:string)=>document.querySelector<HTMLElement>(selector)!;
const page=vi.fn(),back=vi.fn(),closeShelf=vi.fn(),profile=vi.fn(),change=vi.fn();
const press=async(button:number)=>{await act(async()=>{harness.press(button);});};
beforeEach(async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  document.body.innerHTML='<aside data-gamepad-layer data-gamepad-social-shelf id="shelf"><button id="close" data-gamepad-cancel>Close social</button><nav data-gamepad-tabs><button data-gamepad-tab aria-selected="true">People</button><button data-gamepad-tab>Chats</button></nav><div id="root"></div></aside>';
  query('#close').onclick=closeShelf;
  harness=gamepadHarness();
  const api={getXboxFriends:vi.fn(async()=>[friend]),getXboxRelationship:vi.fn(async()=>({isFriend:true,favorite:false,blocked:false,requestState:'none'})),
    getXboxGameInviteAvailability:vi.fn(async()=>({canInvite:false,reason:'Synthetic fixture'})),changeXboxRelationship:change} as unknown as XboxSocialApi;
  root=createRoot(query('#root'));
  await act(async()=>{root.render(<XboxPeopleBrowser api={api} account="synthetic" friends={[friend]} friendsChanged={()=>{}} openProfile={profile}/>);});
  stop=installGamepadNavigation(window,{mode:()=>{},page,back});
  harness.step();
});
afterEach(async()=>{
  stop();await act(async()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllMocks();document.body.innerHTML='';
});

it('opens the focused person menu with X without opening a profile or changing a relationship',async()=>{
  query('.social-person').focus();await press(2);
  expect(query('[data-gamepad-menu]')).toBeTruthy();
  expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
  expect(profile).not.toHaveBeenCalled();expect(change).not.toHaveBeenCalled();
});

it('contains menu navigation and bumpers, then B returns to its trigger while keeping Social open',async()=>{
  query('.social-person').focus();await press(2);
  await press(5);await press(4);await press(13);
  expect(document.activeElement?.closest('[data-gamepad-menu]')).toBeTruthy();
  expect(document.querySelector('[data-gamepad-tab][aria-selected="true"]')?.textContent).toBe('People');
  expect(page).not.toHaveBeenCalled();
  await press(1);
  expect(document.querySelector('[data-gamepad-menu]')).toBeNull();
  expect(document.activeElement).toBe(query('[data-gamepad-menu-trigger]'));
  expect(closeShelf).not.toHaveBeenCalled();expect(back).not.toHaveBeenCalled();
  await press(1);expect(closeShelf).toHaveBeenCalledOnce();
});

it('keeps pointer-opened menus cancellable from the controller',async()=>{
  await act(async()=>query('[data-gamepad-menu-trigger]').click());
  await press(1);
  expect(document.querySelector('[data-gamepad-menu]')).toBeNull();
  expect(document.activeElement).toBe(query('[data-gamepad-menu-trigger]'));
  expect(closeShelf).not.toHaveBeenCalled();
});

it('keeps Escape and ordinary keyboard menu navigation working',async()=>{
  await act(async()=>query('[data-gamepad-menu-trigger]').click());
  const menu=query('[data-gamepad-menu]');
  await act(async()=>menu.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})));
  expect(document.activeElement).toBe([...menu.querySelectorAll('button:not(:disabled)')].at(-1));
  await act(async()=>menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  expect(document.querySelector('[data-gamepad-menu]')).toBeNull();
  expect(document.activeElement).toBe(query('[data-gamepad-menu-trigger]'));
});
