// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {StorePage} from './App';
import {demoSnapshot} from '../shared/demo-data';
import type {CatalogProduct,CatalogSearchResult} from '../shared/types';

let root:Root;
const product=(id:string):CatalogProduct=>({productId:id,title:id,description:'',categories:[],installability:'supported',supportNote:'Supported'});
const result=(products:CatalogProduct[],cursor?:string,hasMore=false,query='Top paid games'):CatalogSearchResult=>({query,market:'US',products,cursor,hasMore,fetchedAt:new Date().toISOString(),source:'Microsoft Store'});
const featured=[product('9HERO0000001'),product('9HERO0000002'),product('9HERO0000003'),product('9FEATURED01'),product('9FEATURED02')];
const button=(label:string)=>[...document.querySelectorAll('button')].find(node=>node.textContent?.includes(label)) as HTMLButtonElement|undefined;
const cards=()=>[...document.querySelectorAll('.catalog-card')].map(node=>node.textContent);
const click=async(node:Element|undefined)=>{expect(node).toBeDefined();await act(async()=>(node as HTMLElement).click());};
const page=(initialQuery='')=><StorePage data={demoSnapshot()} toast={()=>{}} go={()=>{}} initialQuery={initialQuery}/>;
const render=async(initialQuery='',wrapped=false)=>{await act(async()=>root.render(wrapped?<div className="page-scroll">{page(initialQuery)}</div>:page(initialQuery)));};
const flush=async()=>{await act(async()=>{await Promise.resolve();});await act(async()=>{await Promise.resolve();});};
const remount=async(initialQuery='',wrapped=false)=>{await act(async()=>root.unmount());document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);await render(initialQuery,wrapped);await flush();};

type Observed={root:Element|Document|null;callback:IntersectionObserverCallback};
function stubObserver():Observed[]{
 const seen:Observed[]=[];
 class FakeObserver{
  root:Element|Document|null=null;rootMargin='';thresholds:number[]=[];
  constructor(callback:IntersectionObserverCallback,options?:IntersectionObserverInit){seen.push({root:options?.root??null,callback});}
  observe(){}unobserve(){}disconnect(){}takeRecords(){return [];}
 }
 vi.stubGlobal('IntersectionObserver',FakeObserver);
 return seen;
}
const intersect=async(observed:Observed[])=>{await act(async()=>observed.at(-1)!.callback([{isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver));await flush();};

let toast:ReturnType<typeof vi.fn>;
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 toast=vi.fn();
 window.launcher={
  getFeaturedCatalog:vi.fn(async()=>result(featured,'paid-4',true)),
  browseCatalog:vi.fn(async()=>result([],undefined,false)),
  searchCatalog:vi.fn(async(query:string)=>result([],undefined,false,query)),
  getStoreAccess:vi.fn(async()=>undefined),
 } as unknown as Window['launcher'];
 document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);
 await render();await flush();
});
afterEach(async()=>{await act(async()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML='';});

it('continues from the exact cursor the featured result returned, without duplicating a card',async()=>{
 expect(cards()).toHaveLength(2);
 vi.mocked(window.launcher.browseCatalog).mockResolvedValueOnce(result([product('9FEATURED02'),product('9BROWSE0001')],'paid-5',true));
 await click(button('Load more results'));await flush();
 expect(window.launcher.browseCatalog).toHaveBeenCalledWith('paid-4');
 expect(cards()).toHaveLength(3);
 expect(document.body.textContent).toContain('9BROWSE0001');
 expect(cards().filter(text=>text?.includes('9FEATURED02'))).toHaveLength(1);
 vi.mocked(window.launcher.browseCatalog).mockResolvedValueOnce(result([product('9BROWSE0002')],'paid-6',true));
 await click(button('Load more results'));await flush();
 expect(window.launcher.browseCatalog).toHaveBeenLastCalledWith('paid-5');
 expect(cards()).toHaveLength(4);
});

it('shows no continuation when the featured read already covered the whole paid feed',async()=>{
 vi.mocked(window.launcher.getFeaturedCatalog).mockResolvedValue(result(featured,undefined,false));
 await remount();
 expect(button('Load more results')).toBeUndefined();
 expect(cards()).toHaveLength(2);
});

it('sends one request for a held page and keeps the control busy',async()=>{
 let resolve!:(value:CatalogSearchResult)=>void;
 vi.mocked(window.launcher.browseCatalog).mockReturnValueOnce(new Promise<CatalogSearchResult>(done=>resolve=done));
 await click(button('Load more results'));
 await click(button('Load more results'));
 expect(window.launcher.browseCatalog).toHaveBeenCalledTimes(1);
 expect(button('Load more results')?.getAttribute('aria-busy')).toBe('true');
 await act(async()=>resolve(result([product('9BROWSE0001')],undefined,false)));await flush();
 expect(button('Load more results')).toBeUndefined();
 expect(cards()).toHaveLength(3);
});

it('stops an A to B to A cursor cycle instead of loading the same page again',async()=>{
 vi.mocked(window.launcher.browseCatalog).mockResolvedValueOnce(result([product('9BROWSE0001')],'paid-5',true));
 await click(button('Load more results'));await flush();
 expect(button('Load more results')).toBeDefined();
 vi.mocked(window.launcher.browseCatalog).mockResolvedValueOnce(result([product('9BROWSE0002')],'paid-4',true));
 await click(button('Load more results'));await flush();
 expect(window.launcher.browseCatalog).toHaveBeenCalledTimes(2);
 expect(button('Load more results')).toBeUndefined();
 expect(document.body.textContent).toContain('The Store did not return any more games.');
 expect(cards()).toHaveLength(4);
});

it('reports a failed page in place and retries it on request without losing the loaded cards',async()=>{
 vi.mocked(window.launcher.browseCatalog).mockRejectedValueOnce(Error('Microsoft Store TopPaid collection returned HTTP 503.'));
 await click(button('Load more results'));await flush();
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('HTTP 503');
 expect(cards()).toHaveLength(2);
 expect(toast).not.toHaveBeenCalled();
 vi.mocked(window.launcher.browseCatalog).mockResolvedValueOnce(result([product('9BROWSE0001')],undefined,false));
 await click(button('Try again'));await flush();
 expect(window.launcher.browseCatalog).toHaveBeenCalledTimes(2);
 expect(cards()).toHaveLength(3);
 expect(document.querySelector('[role="alert"]')).toBeNull();
});

it('offers a featured retry and a first paid page recovery after a total featured failure',async()=>{
 vi.mocked(window.launcher.getFeaturedCatalog).mockRejectedValueOnce(Error('Microsoft Store TopTrending collection returned HTTP 503.'));
 await remount();
 expect(document.body.textContent).toContain('HTTP 503');
 expect(button('Try again')).toBeDefined();
 // Recovery: the first paid page is reachable instead of a dead end.
 vi.mocked(window.launcher.browseCatalog).mockResolvedValueOnce(result([product('9RECOVER0001')],'paid-2',true));
 await click(button('Load more results'));await flush();
 expect(window.launcher.browseCatalog).toHaveBeenCalledWith(undefined);
 expect(document.body.textContent).toContain('9RECOVER0001');
 // A featured retry must not drop the recovered paid page.
 vi.mocked(window.launcher.getFeaturedCatalog).mockResolvedValueOnce(result(featured,'paid-4',true));
 vi.mocked(window.launcher.getFeaturedCatalog).mockClear();
 await click(button('Try again'));await flush();
 expect(window.launcher.getFeaturedCatalog).toHaveBeenCalledTimes(1);
 expect(document.body.textContent).toContain('9RECOVER0001');
 expect(cards()).toHaveLength(3);
});

it('keeps only the newest search answer when an older query resolves late',async()=>{
 let resolveOld!:(value:CatalogSearchResult)=>void;
 vi.mocked(window.launcher.searchCatalog)
  .mockReturnValueOnce(new Promise<CatalogSearchResult>(done=>resolveOld=done))
  .mockResolvedValueOnce(result([product('9NEW00000001')],undefined,false,'newer'));
 await render('older');await flush();
 await render('newer');await flush();
 await act(async()=>resolveOld(result([product('9OLD00000001')],undefined,false,'older')));await flush();
 expect(document.body.textContent).toContain('9NEW00000001');
 expect(document.body.textContent).not.toContain('9OLD00000001');
 expect(document.body.textContent).toContain('Results for “newer”');
});

it('lets a new query page run and survive while an older page is still held',async()=>{
 let resolveOld!:(value:CatalogSearchResult)=>void, resolveNew!:(value:CatalogSearchResult)=>void;
 vi.mocked(window.launcher.searchCatalog)
  .mockResolvedValueOnce(result([product('9OLD00000001')],'old-page-2',true,'older'))
  .mockReturnValueOnce(new Promise<CatalogSearchResult>(done=>resolveOld=done))
  .mockResolvedValueOnce(result([product('9NEW00000001')],'new-page-2',true,'newer'))
  .mockReturnValueOnce(new Promise<CatalogSearchResult>(done=>resolveNew=done));
 await render('older');await flush();
 await click(button('Load more results'));
 await render('newer');await flush();
 expect(cards()).toHaveLength(1);
 await click(button('Load more results'));await flush();
 expect(window.launcher.searchCatalog).toHaveBeenCalledTimes(4);
 expect(button('Load more results')?.getAttribute('aria-busy')).toBe('true');
 await act(async()=>resolveOld(result([product('9OLD00000002')],'old-page-3',true,'older')));await flush();
 expect(document.body.textContent).not.toContain('9OLD00000002');
 expect(button('Load more results')?.getAttribute('aria-busy')).toBe('true');
 await act(async()=>resolveNew(result([product('9NEW00000002')],undefined,false,'newer')));await flush();
 expect(cards()).toHaveLength(2);
 expect(document.body.textContent).toContain('9NEW00000002');
});

it('ignores a late rejection and finish from an older search page',async()=>{
 let rejectOld!:(error:Error)=>void;
 vi.mocked(window.launcher.searchCatalog)
  .mockResolvedValueOnce(result([product('9OLD00000001')],'old-page-2',true,'older'))
  .mockReturnValueOnce(new Promise<CatalogSearchResult>((_done,fail)=>{rejectOld=fail;}))
  .mockResolvedValueOnce(result([product('9NEW00000001')],'new-page-2',true,'newer'))
  .mockResolvedValueOnce(result([product('9NEW00000002')],'new-page-3',true,'newer'));
 await render('older');await flush();
 await click(button('Load more results'));
 await render('newer');await flush();
 await click(button('Load more results'));await flush();
 expect(cards()).toHaveLength(2);
 await act(async()=>rejectOld(Error('Microsoft Store search returned HTTP 503.')));await flush();
 expect(document.querySelector('[role="alert"]')).toBeNull();
 expect(button('Load more results')).toBeDefined();
 expect(button('Load more results')?.getAttribute('aria-busy')).toBe('false');
});

it('resumes landing auto-load after a search page failure is cleared',async()=>{
 const observed=stubObserver();
 vi.mocked(window.launcher.searchCatalog)
  .mockResolvedValueOnce(result([product('9RESULT00001')],'next-page',true,'gears'))
  .mockRejectedValueOnce(Error('Microsoft Store search returned HTTP 503.'));
 await remount('gears',true);
 await click(button('Load more results'));await flush();
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('HTTP 503');
 vi.mocked(window.launcher.browseCatalog).mockResolvedValueOnce(result([product('9BROWSE0001')],undefined,false));
 await render('',true);await flush();
 expect(document.body.textContent).not.toContain('HTTP 503');
 await intersect(observed);
 expect(window.launcher.browseCatalog).toHaveBeenCalledTimes(1);
 expect(cards()).toHaveLength(3);
});

it('does not let a browse failure block search auto-load',async()=>{
 const observed=stubObserver();
 await remount('',true);
 vi.mocked(window.launcher.browseCatalog).mockRejectedValueOnce(Error('Microsoft Store TopPaid collection returned HTTP 503.'));
 await click(button('Load more results'));await flush();
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('HTTP 503');
 vi.mocked(window.launcher.searchCatalog)
  .mockResolvedValueOnce(result([product('9RESULT00001')],'next-page',true,'gears'))
  .mockResolvedValueOnce(result([product('9RESULT00002')],undefined,false,'gears'));
 await render('gears',true);await flush();
 await intersect(observed);
 expect(window.launcher.searchCatalog).toHaveBeenLastCalledWith('gears','next-page');
 expect(cards()).toHaveLength(2);
});

it('observes the real page scroll container and continues the list when its end comes into view',async()=>{
 const observed:Observed[]=stubObserver();
 vi.mocked(window.launcher.browseCatalog).mockResolvedValueOnce(result([product('9BROWSE0001')],undefined,false));
 await render('',true);await flush();
 expect(observed.at(-1)!.root).toBe(document.querySelector('.page-scroll'));
 await intersect(observed);
 expect(window.launcher.browseCatalog).toHaveBeenCalledTimes(1);
 expect(cards()).toHaveLength(3);
});
