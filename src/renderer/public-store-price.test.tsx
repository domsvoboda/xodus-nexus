// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,expect,it,vi} from 'vitest';
import {CatalogGameDetails,publicStorePrice} from './CatalogGameDetails';
import {StorePage,StoreProductCard} from './App';
import {demoSnapshot} from '../shared/demo-data';
import {i18n,ui} from './i18n';
import type {CatalogProduct} from '../shared/types';

const product:CatalogProduct={productId:'9AAAAAAAAAAA',title:'Priced game',description:'',publisher:'Studio',installability:'supported',supportNote:'Supported',categories:[],purchasePrice:'$29.99'};
const note=ui('store.us_price_context');

function snapshot(market='CZ'){
 const data=demoSnapshot();data.games=[];data.downloads=[];data.settings.market=market;
 return data;
}
function item(id:string,purchasePrice?:string):CatalogProduct{
 return {...product,productId:id,title:id,purchasePrice};
}
function installLauncher(products:CatalogProduct[]){
 window.launcher={
  getFeaturedCatalog:vi.fn(async()=>({query:'',products,hasMore:false})),
  searchCatalog:vi.fn(async(query:string)=>({query,products:[],hasMore:false})),
  getStoreAccess:vi.fn(async()=>undefined),
  getGameDetails:vi.fn(async()=>undefined),
  getGameActivity:vi.fn(async()=>({status:'unavailable'})),
  getGameAchievements:vi.fn(async()=>({status:'unavailable',items:[]})),
  getGameRuntimeReadiness:vi.fn(async()=>false),
  launchGame:vi.fn(async()=>{}),
 } as unknown as Window['launcher'];
}
async function mount(element:React.ReactElement){
 const node=document.createElement('div'),root=createRoot(node);
 await act(async()=>{root.render(element);});
 await act(async()=>{await Promise.resolve();});
 await act(async()=>{await Promise.resolve();});
 return {node,unmount:async()=>{await act(async()=>root.unmount());}};
}
afterEach(async()=>{await i18n.changeLanguage('en');vi.unstubAllGlobals();document.body.innerHTML='';});

it('labels an actual public Store price with its US market without changing the account market or weakening access gates',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=snapshot('CZ');
 installLauncher([]);
 const view=await mount(<CatalogGameDetails storeMode product={product} data={data} back={()=>{}} toast={()=>{}}/>);
 try{
  const html=view.node.innerHTML;
  expect(html).toContain('$29.99');
  expect(html).toContain(note);
  expect(html).toContain('>Store page</button>');
  expect(html).not.toContain('>Install</button>');
  expect(data.settings.market).toBe('CZ');
  expect(i18n.language).toBe('en');
 }finally{await view.unmount();}
});

it.each([undefined,'Included','Free','Free for 30 days','Included with 12 months'])('does not attach a currency claim when the public Store value is %s',async purchasePrice=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=snapshot();
 installLauncher([]);
 const view=await mount(<CatalogGameDetails storeMode product={{...product,purchasePrice}} data={data} back={()=>{}} toast={()=>{}}/>);
 try{
  const html=view.node.innerHTML;
  expect(html).not.toContain(note);
  expect(html).not.toContain('US Store, USD');
 }finally{await view.unmount();}
});

it.each([
 [undefined,undefined],
 ['Included',undefined],
 ['Free',undefined],
 ['Free for 30 days',undefined],
 ['Included with 12 months',undefined],
 ['29.99',undefined],
 ['USD 29.99',undefined],
 ['€29.99',undefined],
 ['$29.99','$29.99'],
 ['$30','$30'],
 ['$1,299.99','$1,299.99'],
])('recognises only a formatted US price, not marker or bare text: %s',(purchasePrice,expected)=>{
 expect(publicStorePrice({purchasePrice})).toBe(expected);
});

it('keeps an uninstalled Account Library detail price on the account market without a US claim',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=snapshot('DE');
 installLauncher([]);
 const view=await mount(<CatalogGameDetails product={product} data={data} back={()=>{}} toast={()=>{}}/>);
 try{
  const html=view.node.innerHTML;
  expect(html).toContain('$29.99');
  expect(html).toContain('>Install</button>');
  expect(html).toContain('Install location');
  expect(html).not.toContain(note);
  expect(data.settings.market).toBe('DE');
 }finally{await view.unmount();}
});

it('keeps an installed Store or Account Library detail free of a public price claim',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=snapshot('CZ');
 data.games=[{...demoSnapshot().games[0],storeId:product.productId,installState:'ready'}];
 installLauncher([]);
 const store=await mount(<CatalogGameDetails storeMode product={product} data={data} back={()=>{}} toast={()=>{}}/>);
 try{
  expect(store.node.innerHTML).toContain('>Play</button>');
  expect(store.node.innerHTML).not.toContain(note);
 }finally{await store.unmount();}
 const library=await mount(<CatalogGameDetails product={product} data={data} back={()=>{}} toast={()=>{}}/>);
 try{
  expect(library.node.innerHTML).toContain('>Play</button>');
  expect(library.node.innerHTML).not.toContain(note);
 }finally{await library.unmount();}
});

it('marks a priced public Store card with its US market and keeps a missing price neutral',()=>{
 const priced=renderToStaticMarkup(<StoreProductCard product={product} selected={false} disabled={false} label="Install" select={()=>{}} install={()=>{}}/>);
 expect(priced).toContain('$29.99 · US Store, USD');
 expect(priced).toContain('US Store and are shown in USD');
 const missing=renderToStaticMarkup(<StoreProductCard product={{...product,purchasePrice:undefined}} selected={false} disabled={false} label="Install" select={()=>{}} install={()=>{}}/>);
 expect(missing).toContain('Price unavailable');
 expect(missing).not.toContain('US Store, USD');
 expect(missing).not.toContain('US Store and are shown in USD');
 const free=renderToStaticMarkup(<StoreProductCard product={{...product,purchasePrice:'Free'}} selected={false} disabled={false} label="Install" select={()=>{}} install={()=>{}}/>);
 expect(free).toContain('Free');
 expect(free).not.toContain('US Store, USD');
});

it('shows the US price note only when the rendered Store grid contains a formatted price',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=snapshot('CZ');
 const page=async(products:CatalogProduct[])=>{
  installLauncher(products);
  return mount(<StorePage data={data} toast={()=>{}} go={()=>{}} initialQuery=""/>);
 };
 // The first three featured entries are artwork-only hero tiles with no price.
 const pricedHeroes=await page([item('9HERO0000001','$29.99'),item('9HERO0000002','$19.99'),item('9HERO0000003','$9.99')]);
 try{expect(pricedHeroes.node.innerHTML).not.toContain(note);}
 finally{await pricedHeroes.unmount();}
 const pricedGrid=await page([item('9HERO0000001'),item('9HERO0000002'),item('9HERO0000003'),item('9GRID0000001','$29.99')]);
 try{
  expect(pricedGrid.node.innerHTML).toContain(note);
  expect(pricedGrid.node.innerHTML).toContain('US Store, USD');
  expect(data.settings.market).toBe('CZ');
 }finally{await pricedGrid.unmount();}
 const unpricedGrid=await page([item('9HERO0000001','$29.99'),item('9HERO0000002'),item('9HERO0000003'),item('9GRID0000001')]);
 try{expect(unpricedGrid.node.innerHTML).not.toContain(note);}
 finally{await unpricedGrid.unmount();}
});
