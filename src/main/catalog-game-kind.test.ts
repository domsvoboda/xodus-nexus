import {expect,it} from 'vitest';
import {CatalogService,parseCatalogProducts} from './catalog.js';
const GAME='9AAAAAAAAAAA',BUNDLE='9BBBBBBBBBBB',DLC='9CCCCCCCCCCC',APP='9DDDDDDDDDDD';
const row=(productId=GAME,extra={})=>({productId,title:'Synthetic product',isGame:true,...extra});
const game=(ProductId=GAME,extra={})=>({ProductId,ProductType:'Game',LocalizedProperties:[{ProductTitle:'Synthetic game'}],...extra});
it('accepts only authoritative root Games and never title, category, endpoint or positive isGame hints',()=>{
 for(const ProductType of ['Application','Durable','GameAddOn','Consumable','AvatarItem','Pass','game','Unknown',null,undefined,42]){
  expect(parseCatalogProducts({productsList:[row(GAME,{categories:['Games']})]},{Products:[{ProductId:GAME,ProductType}]},'store')).toEqual([]);
 }
 expect(parseCatalogProducts({productsList:[row()]},{Products:[]},'store')).toEqual([]);
 expect(parseCatalogProducts({productsList:[row(GAME,{isGame:false})]},{Products:[game()]},'store')).toEqual([]);
 expect(parseCatalogProducts({productsList:[row(GAME,{isGame:undefined})]},{Products:[game()]},'store')).toHaveLength(1);
});
it('retains Game bundles and unsupported Games without deriving the root kind from a bundled child',()=>{
 const bundle=(ProductId:string,ProductType:string,child:string)=>({ProductId,ProductType,DisplaySkuAvailabilities:[{Sku:{Properties:{BundledSkus:[{BigId:child}]}}}]});
 const details={Products:[bundle(BUNDLE,'Game',DLC),bundle(DLC,'Durable',GAME),game()]};
 expect(parseCatalogProducts({productsList:[row(BUNDLE),row(DLC)]},details,'store').map(p=>p.productId)).toEqual([BUNDLE]);
 // Unknown/unsupported package metadata changes installability, not game kind.
 expect(parseCatalogProducts({productsList:[row()]},{Products:[game()]},'store')[0].installability).not.toBe('supported');
});
it('filters search and pagination with the root policy while Featured also requires standalone composition',async()=>{
 const requests:URL[]=[];
 const records=[game(),game(BUNDLE,{DisplaySkuAvailabilities:[{Sku:{Properties:{BundledSkus:[{BigId:DLC}]}}}]}),{ProductId:DLC,ProductType:'Durable'},{ProductId:APP,ProductType:'Application'}];
 const service=new CatalogService((async(input:URL|RequestInfo)=>{
  const url=new URL(String(input));requests.push(url);
  if(url.hostname==='displaycatalog.mp.microsoft.com'){
   const ids=url.searchParams.get('bigIds')!.split(',');return new Response(JSON.stringify({Products:records.filter(p=>ids.includes(p.ProductId))}));
  }
  const query=url.searchParams.get('query');
  const productsList=query===DLC?[row(DLC)]:query===GAME?[row()]:[row(),row(BUNDLE),row(DLC),row(APP)];
  return new Response(JSON.stringify({productsList,cursor:'page2',hasMorePages:true}));
 }) as typeof fetch);
 for(const result of [await service.search('Game','US'),await service.search('Game','US','page2')])expect(result.products.map(p=>p.productId)).toEqual([GAME,BUNDLE]);
 // The Bundle root is Game, but its only child is a Durable add-on.
 expect((await service.featured('US')).products.map(p=>p.productId)).toEqual([GAME]);
 expect((await service.search(DLC,'US')).products).toEqual([]);
 expect((await service.search(GAME,'US')).products.map(p=>p.productId)).toEqual([GAME]);
 expect(await service.gameDetails(DLC,'US')).toBeUndefined();
 expect(await service.gameDetails(GAME,'US')).toMatchObject({productId:GAME});
 expect(requests.some(url=>url.searchParams.get('cursor')==='page2')).toBe(true);
});
it('fails closed on unavailable type enrichment without filtering licensed-library games',async()=>{
 const service=new CatalogService((async(input:URL|RequestInfo)=>{
  if(String(input).includes('displaycatalog'))return new Response('unavailable',{status:503});
  return new Response(JSON.stringify({productsList:[row()]}));
 }) as typeof fetch);
 expect((await service.search('Game','US')).products).toEqual([]);
 expect((await service.featured('US')).products).toEqual([]);
 expect(parseCatalogProducts({productsList:[row()]},{Products:[]},'library')).toHaveLength(1);
});
