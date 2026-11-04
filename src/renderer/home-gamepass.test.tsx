// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {AppSnapshot,CatalogProduct,RecentGamePassShelf} from '../shared/types';
import {demoLaunchOptions,demoSnapshot} from '../shared/demo-data';
import {HomeGamePassSection} from './HomeGamePass';
import {HomePage} from './App';

const product:CatalogProduct={productId:'9AAAAAA00001',title:'Fresh Game Pass Game',description:'Description',publisher:'Studio',
  installability:'supported',supportNote:'Windows.Desktop MSIXVC',categories:[],posterUrl:'https://store-images.s-microsoft.com/box'};
const shelf:RecentGamePassShelf={market:'US',fetchedAt:'2026-11-04T10:00:00.000Z',source:'Microsoft Game Pass catalog',
  products:[product,{...product,productId:'9BBBBBB00002',title:'Second Game Pass Game',publisher:'Other Studio'}]};

it('renders loading, empty, error and public Game Pass cards without an install action',()=>{
 const loading=renderToStaticMarkup(<HomeGamePassSection loading retry={()=>{}} open={()=>{}}/>);
 expect(loading).toContain('Recently added in Game Pass');
 expect(loading).toContain('Loading live Store collection');
 const empty=renderToStaticMarkup(<HomeGamePassSection loading={false} retry={()=>{}} open={()=>{}}/>);
 expect(empty).toContain('No new PC Game Pass games are available right now.');
 const failed=renderToStaticMarkup(<HomeGamePassSection loading={false} error="The PC Game Pass catalog could not be loaded. Check your connection and try again." retry={()=>{}} open={()=>{}}/>);
 expect(failed).toContain('role="alert"');expect(failed).toContain('Try again');
 const cards=renderToStaticMarkup(<HomeGamePassSection shelf={shelf} loading={false} retry={()=>{}} open={()=>{}}/>);
 expect(cards).toContain('home-gamepass-card');expect(cards).toContain(product.title);expect(cards).toContain('Game Pass');
 expect(cards.match(/home-gamepass-card/g)).toHaveLength(2);
 expect(cards).not.toContain('Install</button>');
});

let root:Root|undefined;
let node:HTMLDivElement|undefined;

beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 node=document.createElement('div');document.body.appendChild(node);
});
afterEach(async()=>{
 if(root)await act(async()=>root!.unmount());
 root=undefined;node?.remove();node=undefined;vi.restoreAllMocks();document.body.innerHTML='';
});

function install(data:AppSnapshot){
 const getStoreAccess=vi.fn(async()=>undefined);
 const getRecentGamePassShelf=vi.fn(async()=>shelf);
 window.launcher={
  getRecentGamePassShelf,
  getStoreAccess,
  getGameLaunchOptions:vi.fn(async()=>demoLaunchOptions),
  getGameDetails:vi.fn(async()=>undefined),
  getGameActivity:vi.fn(async()=>({status:'unavailable'})),
  getGameAchievements:vi.fn(async()=>({status:'unavailable'})),
  getGameRuntimeReadiness:vi.fn(async()=>false),
 } as unknown as Window['launcher'];
 return {getStoreAccess,getRecentGamePassShelf};
}
const flush=async()=>{await act(async()=>{await Promise.resolve();await Promise.resolve();});};

it('loads the public shelf once, opens public details through the normal Store access check and restores focus',async()=>{
 const data=demoSnapshot();data.downloads=[];data.games=[data.games[0],{...data.games[1],installState:'incomplete'},{...data.games[2],installState:'imported'}];
 const api=install(data);root=createRoot(node!);
 await act(async()=>root!.render(<HomePage data={data} go={()=>{}} action={()=>{}} toast={()=>{}}/>));
 await flush();
 expect(document.body.textContent).toContain('Recently installed');
 expect(document.body.textContent).toContain('Recently added in Game Pass');
 expect(document.querySelectorAll('.home-gamepass-card')).toHaveLength(2);
 expect(document.querySelector('.poster-row')?.textContent).not.toContain('Sea of Thieves');
 expect(api.getRecentGamePassShelf).toHaveBeenCalledTimes(1);
 expect(api.getStoreAccess).not.toHaveBeenCalled();
 const card=document.querySelector<HTMLButtonElement>('[data-gamepad-key="home-gamepass:9AAAAAA00001"]');
 expect(card).not.toBeNull();
 await act(async()=>card!.click());
 await flush();
 expect(api.getStoreAccess).toHaveBeenCalledTimes(1);
 expect(document.querySelector('[data-gamepad-detail-back]')?.textContent).toContain('Back to Home');
 expect(document.body.textContent).toContain('Store page');
 expect(document.body.innerHTML).not.toContain('>Install</button>');
 const back=document.querySelector<HTMLButtonElement>('[data-gamepad-detail-back]');
 await act(async()=>back!.click());
 await flush();
 expect(document.activeElement).toBe(document.querySelector('[data-gamepad-key="home-gamepass:9AAAAAA00001"]'));
 expect(api.getRecentGamePassShelf).toHaveBeenCalledTimes(1);
});

it('does not refetch the public shelf when an unrelated snapshot rerenders Home',async()=>{
 const data=demoSnapshot();data.downloads=[];
 const api=install(data);root=createRoot(node!);
 await act(async()=>root!.render(<HomePage data={data} go={()=>{}} action={()=>{}}/>));
 await flush();
 const next=structuredClone(data);next.connectivity={state:'offline',checkedAt:'2026-11-04T11:00:00.000Z'};
 await act(async()=>root!.render(<HomePage data={next} go={()=>{}} action={()=>{}}/>));
 await flush();
 expect(api.getRecentGamePassShelf).toHaveBeenCalledTimes(1);
});

it('ignores a shelf response after Home unmounts',async()=>{
 const data=demoSnapshot();data.downloads=[];
 let resolve!: (value:RecentGamePassShelf)=>void;
 const getRecentGamePassShelf=vi.fn(()=>new Promise<RecentGamePassShelf>(done=>{resolve=done;}));
 window.launcher={getRecentGamePassShelf,getGameLaunchOptions:vi.fn(async()=>demoLaunchOptions)} as unknown as Window['launcher'];
 root=createRoot(node!);
 await act(async()=>root!.render(<HomePage data={data} go={()=>{}} action={()=>{}}/>));
 await act(async()=>root!.unmount());
 root=undefined;
 await act(async()=>resolve(shelf));
 expect(node!.textContent).toBe('');
});
