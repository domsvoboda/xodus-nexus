// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {CatalogGameDetails} from './CatalogGameDetails';
import {GameDetails} from './GameDetails';
import {demoSnapshot} from '../shared/demo-data';
import type {CatalogProduct,GameDetailsTarget} from '../shared/types';

const product:CatalogProduct={productId:'9AAAAAAAAAAA',title:'Neutral Store Game',description:'',categories:[],installability:'supported',supportNote:'Supported'};

function installLauncher(){
 const details:GameDetailsTarget[]=[],activities:GameDetailsTarget[]=[],achievements:GameDetailsTarget[]=[];
 window.launcher={
  getGameDetails:vi.fn(async(target:GameDetailsTarget)=>{details.push(structuredClone(target));}),
  getGameActivity:vi.fn(async(target:GameDetailsTarget)=>{activities.push(structuredClone(target));return {status:'unavailable'};}),
  getGameAchievements:vi.fn(async(target:GameDetailsTarget)=>{achievements.push(structuredClone(target));return {status:'unavailable',items:[]};}),
  getStoreAccess:vi.fn(async()=>undefined),
  gameRuntimeReadiness:vi.fn(async()=>true),
  launchGame:vi.fn(async()=>{}),
 } as unknown as Window['launcher'];
 return {details,activities,achievements};
}
async function mount(element:React.ReactElement){
 const node=document.createElement('div'),root=createRoot(node);
 await act(async()=>{root.render(element);});
 await act(async()=>{await Promise.resolve();});
 return {node,unmount:async()=>{await act(async()=>root.unmount());}};
}
function snapshot(market='CZ'){
 const data=demoSnapshot();data.games=[];data.downloads=[];data.settings.market=market;
 return data;
}
afterEach(()=>{vi.unstubAllGlobals();});

it('keeps an uninstalled owned/Game Pass Library product detail on the account market',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=snapshot(),calls=installLauncher();
 const view=await mount(<CatalogGameDetails product={product} data={data} back={()=>{}} toast={()=>{}}/>);
 try{
  expect(calls.details.at(-1)).toEqual({productId:product.productId});
  expect(calls.activities.at(-1)).toEqual({productId:product.productId});
  expect(calls.achievements.at(-1)).toEqual({productId:product.productId});
 }finally{await view.unmount();}
});

it('opts only an explicit public Store detail into public metadata while activity stays on the account identity',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=snapshot(),calls=installLauncher();
 const view=await mount(<CatalogGameDetails storeMode product={product} data={data} back={()=>{}} toast={()=>{}}/>);
 try{
  expect(calls.details.at(-1)).toEqual({productId:product.productId,scope:'public-store'});
  expect(calls.activities.at(-1)).toEqual({productId:product.productId});
  expect(calls.achievements.at(-1)).toEqual({productId:product.productId});
 }finally{await view.unmount();}
});

it('reflects public metadata for an installed product opened from the Store without changing Play or activity binding',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=snapshot();
 data.games=[{...demoSnapshot().games[0],storeId:product.productId,installState:'ready'}];
 const calls=installLauncher();
 const view=await mount(<CatalogGameDetails storeMode product={product} data={data} back={()=>{}} toast={()=>{}}/>);
 try{
  expect(calls.details.at(-1)).toEqual({productId:product.productId,scope:'public-store'});
  expect(calls.activities.at(-1)).toBe(data.games[0].id);
  expect(calls.achievements.at(-1)).toBe(data.games[0].id);
  const play=view.node.querySelector<HTMLButtonElement>('[data-gamepad-play]')!;
  expect(play.textContent).toContain('Play');
  await act(async()=>play.click());
  expect(window.launcher.launchGame).toHaveBeenCalledWith(data.games[0].id);
 }finally{await view.unmount();}
});

it('keeps an installed Library game opened from the Library on the account market',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=demoSnapshot();data.downloads=[];data.settings.market='CZ';const game=data.games[0],calls=installLauncher();
 const view=await mount(<GameDetails game={game} data={data} back={()=>{}} play={<button>Play</button>} />);
 try{
  expect(calls.details.at(-1)).toBe(game.id);
  expect(calls.activities.at(-1)).toBe(game.id);
  expect(calls.achievements.at(-1)).toBe(game.id);
 }finally{await view.unmount();}
});
