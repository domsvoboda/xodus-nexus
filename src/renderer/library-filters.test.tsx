// @vitest-environment jsdom
import {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {AccountGames} from './App';
import {demoAccountLibrary, demoSnapshot} from '../shared/demo-data';
import {loadLibraryFilters, saveLibraryFilters} from './library-preferences';

let root:Root;
let data:ReturnType<typeof demoSnapshot>;
const sd = '/run/media/deck/SD/Games';
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

it('shows games across installation folders without a folder filter',async()=>{
  localStorage.setItem('xodus-nexus.library-filters.v1',JSON.stringify({kind:'all',playState:'all',location:sd}));
  await mount();
  expect(document.querySelector('select[aria-label="Install location"]')).toBeNull();
  for(const game of data.games)expect(cards()).toContain(game.id);
  expect(cards()).toContain(demoAccountLibrary('all',new Map()).products[0].productId);
  await select(state(),'installable');
  for(const game of data.games)expect(cards()).not.toContain(game.id);
  expect(cards()).toContain(demoAccountLibrary('all',new Map()).products[0].productId);
  expect(document.activeElement).toBe(state());
});

it('keeps offline local games visible across recorded installation folders',async()=>{
  data.auth.stored=false;data.backend.available=false;data.backend.capabilities.library=false;
  await mount();
  for(const game of data.games)expect(cards()).toContain(game.id);
  expect(window.launcher.getAccountLibrary).not.toHaveBeenCalled();
});
