// @vitest-environment jsdom
import {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {AccountGames} from './App';
import {demoAccountLibrary, demoSnapshot} from '../shared/demo-data';
import {installGamepadNavigation} from './gamepad-navigation';
import {gamepadHarness} from './gamepad-test-harness';
import {loadLibraryFilters, saveLibraryFilters} from './library-preferences';

let root:Root;
let data:ReturnType<typeof demoSnapshot>;
const sd = '/run/media/deck/SD/Games';
const location = () => document.querySelector<HTMLSelectElement>('select[aria-label="Install location"]')!;
const state = () => document.querySelector<HTMLSelectElement>('select[aria-label="Play state"]')!;
const cards = () => [...document.querySelectorAll<HTMLElement>('[data-gamepad-detail-target]')].map(card => card.dataset.gamepadDetailTarget);
function Host() {
  const [filters, setFilters] = useState(loadLibraryFilters);
  return <AccountGames data={data} toast={()=>{}} filters={filters} onFiltersChange={next=>{setFilters(next);saveLibraryFilters(next);}}/>;
}
async function select(control:HTMLSelectElement, value:string) {
  await act(async()=>{control.focus();control.value=value;control.dispatchEvent(new Event('change',{bubbles:true}));});
}
async function mount() {await act(async()=>{root.render(<Host/>);});}
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('localStorage',(globalThis as unknown as {jsdom:{window:Window}}).jsdom.window.localStorage);
  localStorage.clear();
  data=demoSnapshot();data.games=data.games.slice(0,3);
  data.games[0].path=sd+'/Gears';data.games[1].path='/home/deck/Games/Forza';data.games[2].path=sd+'-other/Minecraft';
  window.launcher={getAccountLibrary:vi.fn(async()=>demoAccountLibrary('all',new Map()))} as unknown as Window['launcher'];
  document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);
});
afterEach(async()=>{await act(async()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML='';});

it('filters exact folders, excludes uninstalled account games and retains native select focus',async()=>{
  await mount();expect(cards()).toContain(data.games[1].id);
  expect(cards()).toContain(demoAccountLibrary('all',new Map()).products[0].productId);
  await select(location(),sd);
  expect(cards()).toEqual([data.games[0].id]);
  expect(state().value).toBe('installed');expect(document.activeElement).toBe(location());
  expect(loadLibraryFilters().location).toBe(sd);
  expect(window.launcher.getAccountLibrary).toHaveBeenCalledTimes(1);
  expect([...location().options].map(option=>option.text)).toContain(sd);
  expect([...location().options].map(option=>option.text)).not.toContain('Internal drive');
  await select(state(),'installable');
  expect(location().value).toBe('');expect(loadLibraryFilters().location).toBeUndefined();
  expect(cards()).not.toContain(data.games[0].id);
  expect(cards()).toContain(demoAccountLibrary('all',new Map()).products[0].productId);
});

it('restores a saved folder after recreating the library and keeps a now-empty folder selectable',async()=>{
  await mount();await select(location(),sd);
  await act(async()=>root.render(<div/>));await mount();
  expect(location().value).toBe(sd);expect(cards()).toEqual([data.games[0].id]);
  data={...data,games:data.games.slice(1)};await mount();
  expect(location().value).toBe(sd);expect(cards()).toEqual([]);
  expect(document.body.textContent).toContain('No games match these filters');
  expect([...location().options].map(option=>option.value)).toContain(sd);
  await select(location(),'');expect(cards()).toContain(data.games[1].id);
});

it('filters local games without sign-in or backend access, with no account requests',async()=>{
  data.auth.stored=false;data.backend.available=false;data.backend.capabilities.library=false;
  await mount();await select(location(),sd);
  expect(cards()).toEqual([data.games[0].id]);expect(window.launcher.getAccountLibrary).not.toHaveBeenCalled();
  expect(location().disabled).toBe(false);
});

it('selects a folder through the controller picker and returns focus after selecting or cancelling',async()=>{
  await mount();const pad=gamepadHarness();
  const stop=installGamepadNavigation(window,{mode:()=>{},back:()=>{},page:()=>{},social:()=>{},search:()=>{}});
  const press=async(button:number)=>{await act(async()=>pad.press(button));};
  try {
    pad.step();location().focus();await press(2);await press(0);
    const picker=document.querySelector<HTMLElement>('.gamepad-select-dialog')!;
    expect(picker).not.toBeNull();
    [...picker.querySelectorAll<HTMLElement>('button')].forEach((button,index)=>{button.dataset.testRect=`100,${100+index*50},250,44`;});
    await press(13);await press(13);await press(0);
    expect(location().value).toBe(sd);expect(cards()).toEqual([data.games[0].id]);
    expect(document.activeElement).toBe(location());expect(document.querySelector('.gamepad-select-dialog')).toBeNull();
    await press(0);expect(document.querySelector('.gamepad-select-dialog')).not.toBeNull();
    await press(1);expect(document.querySelector('.gamepad-select-dialog')).toBeNull();
    expect(location().value).toBe(sd);expect(document.activeElement).toBe(location());
  } finally {stop();}
});
