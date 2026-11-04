import {expect,it,vi} from 'vitest';
import {CatalogService} from './catalog.js';
import {RecentPcGamePass} from './gamepass-recent.js';
import {HOME_GAMEPASS_FETCH,HOME_GAMEPASS_LIMIT,HomeGamePassShelf} from './home-gamepass.js';
import type {RecentGamePassShelf} from '../shared/types.js';

const COLLECTION='06323672-b8c8-43cc-b0de-32d5a9834749';
const metadata={siglId:COLLECTION,requiresShuffling:'False',title:'Recently added'};
const id=(index:number)=>`9${String(index).padStart(11,'0')}`;
const ids=Array.from({length:4},(_,index)=>id(index+1));
const paidSku=(price=29.99)=>({Sku:{SkuType:'full',Properties:{Packages:[{PackageFormat:'MSIXVC',PlatformDependencies:[{PlatformName:'Windows.Desktop'}]}]}},Availabilities:[{OrderManagementData:{Price:{MSRP:price,ListPrice:price}}}]});
const freeSku=()=>({Sku:{SkuType:'full',Properties:{}},Availabilities:[{OrderManagementData:{Price:{MSRP:0,ListPrice:0}}}]});
const product=(productId:string,title:string,skus:unknown[]=[paidSku()],type='Game')=>({ProductId:productId,ProductType:type,
  LocalizedProperties:[{ProductTitle:title,PublisherName:'Studio'}],DisplaySkuAvailabilities:skus});

function fixture(overrides:Record<string,unknown>={}){
 const requests:string[]=[];
 const fetcher=vi.fn(async(input:URL|RequestInfo)=>{
  const url=new URL(String(input));requests.push(url.toString());
  if(`${url.origin}${url.pathname}`==='https://catalog.gamepass.com/sigls/v3'){
   expect(Object.fromEntries(url.searchParams)).toEqual({id:COLLECTION,language:'en-US',market:'US',platformContext:'pc',subscriptionContext:'cfq7ttc0kgq8'});
   return new Response(JSON.stringify([metadata,...ids.map(value=>({id:value}))]));
  }
  if(url.pathname.endsWith('/v7.0/products')){
   expect(url.searchParams.get('market')).toBe('US');
   expect(url.searchParams.get('languages')).toBe('en-us,neutral');
   const batch=(url.searchParams.get('bigIds')??'').split(',');
   // Shuffle the detail response so the shelf must keep the official order.
   return new Response(JSON.stringify({Products:[...batch].reverse().map((value,index)=>product(value,`Game ${index}`,overrides[value] as unknown[]??[paidSku()]))}));
  }
  throw Error(`Unexpected request ${url}`);
 }) as unknown as typeof fetch;
 return {fetcher,requests};
}

it('loads the official public PC recent collection and keeps its order, scope and bounded metadata',async()=>{
 const {fetcher,requests}=fixture();
 const now=()=>0;
 const shelf=await new HomeGamePassShelf(new RecentPcGamePass(fetcher,now),new CatalogService(fetcher),now).get('US');
 expect(shelf).toMatchObject({market:'US',source:'Microsoft Game Pass catalog'});
 expect(shelf.stale).toBeUndefined();
 expect(shelf.products.map(product=>product.productId)).toEqual(ids);
 expect(shelf.products.every(product=>!('access' in product))).toBe(true);
 expect(requests.filter(value=>value.includes('/sigls/v3'))).toHaveLength(1);
 const details=requests.filter(value=>value.includes('/v7.0/products'));
 expect(details).toHaveLength(1);
 expect(new URL(details[0]).searchParams.get('bigIds')).toBe(ids.join(','));
});

it('bounds the metadata window while retaining the first official order',async()=>{
 const long=Array.from({length:24},(_,index)=>id(index+1));
 const fetcher=vi.fn(async(input:URL|RequestInfo)=>{
  const url=new URL(String(input));
  if(url.pathname.includes('/sigls/v3'))return new Response(JSON.stringify([metadata,...long.map(value=>({id:value}))]));
  const batch=(url.searchParams.get('bigIds')??'').split(',');
  expect(batch).toHaveLength(HOME_GAMEPASS_FETCH);
  return new Response(JSON.stringify({Products:batch.reverse().map(value=>product(value,`Title ${value}`))}));
 }) as unknown as typeof fetch;
 const shelf=await new HomeGamePassShelf(new RecentPcGamePass(fetcher),new CatalogService(fetcher)).get('US');
 expect(shelf.products.map(product=>product.productId)).toEqual(long.slice(0,HOME_GAMEPASS_LIMIT));
});

it('applies the public Store policy instead of assuming every recent game is usable or owned',async()=>{
 const all=[id(1),id(2),id(3),id(4)];
 const overrides={
  [id(1)]:[paidSku()],
  [id(2)]:[freeSku()],
  [id(3)]:[{...paidSku(),Sku:{SkuType:'full',Properties:{IsTrial:true}},Availabilities:[{OrderManagementData:{Price:{MSRP:29.99,ListPrice:29.99}}}]}],
  [id(4)]:[],
 };
 const fetcher=vi.fn(async(input:URL|RequestInfo)=>{
  const url=new URL(String(input));
  if(url.pathname.includes('/sigls/v3'))return new Response(JSON.stringify([metadata,...all.map(value=>({id:value}))]));
  const batch=(url.searchParams.get('bigIds')??'').split(',');
  return new Response(JSON.stringify({Products:batch.map(value=>value===id(4)?product(value,'Add-on',[],'Durable'):product(value,`Title ${value}`,overrides[value as keyof typeof overrides]))}));
 }) as unknown as typeof fetch;
 const shelf=await new HomeGamePassShelf(new RecentPcGamePass(fetcher),new CatalogService(fetcher)).get('US');
 expect(shelf.products.map(product=>product.productId)).toEqual([id(1)]);
});

it('reports a real empty shelf when the official collection has no games',async()=>{
 const fetcher=vi.fn(async(input:URL|RequestInfo)=>{
  const url=new URL(String(input));
  if(!url.pathname.includes('/sigls/v3'))throw Error('Metadata must not be requested for an empty collection.');
  return new Response(JSON.stringify([metadata]));
 }) as unknown as typeof fetch;
 const shelf=await new HomeGamePassShelf(new RecentPcGamePass(fetcher),new CatalogService(fetcher)).get('US');
 expect(shelf.products).toEqual([]);
 expect(shelf.source).toBe('Microsoft Game Pass catalog');
});

it('coalesces concurrent loads, caches for ten minutes and serves explicitly stale real data on failure',async()=>{
 let now=0,fail=false;
 const {fetcher}=fixture();
 const wrapped=vi.fn(async(input:URL|RequestInfo)=>{
  if(fail)throw Error('PRIVATE_NETWORK_TOKEN');
  return fetcher(input);
 }) as unknown as typeof fetch;
 const shelfService=new HomeGamePassShelf(new RecentPcGamePass(wrapped,()=>now),new CatalogService(wrapped),()=>now);
 const [first,second]=await Promise.all([shelfService.get('US'),shelfService.get('US')]);
 expect(first.products.map(product=>product.productId)).toEqual(ids);
 expect(second.products).toEqual(first.products);
 expect(wrapped).toHaveBeenCalledTimes(2); // one collection request and one details request
 now=10*60_000;expect((await shelfService.get('US')).products).toHaveLength(ids.length);expect(wrapped).toHaveBeenCalledTimes(4);
 now=20*60_000;fail=true;
 const [stale,concurrentStale]=await Promise.all([shelfService.get('US'),shelfService.get('US')]);
 expect(stale.stale).toBe(true);expect(concurrentStale.stale).toBe(true);
 expect(stale.products.map(product=>product.productId)).toEqual(ids);
 expect(concurrentStale.products).toEqual(stale.products);
 await expect(shelfService.get('not a market')).rejects.toThrow('market');
});

it('fails honestly when neither a fresh nor a previous public list exists',async()=>{
 const fetcher=vi.fn(async()=>{throw Error('PRIVATE_NETWORK_TOKEN')}) as unknown as typeof fetch;
 const shelf=new HomeGamePassShelf(new RecentPcGamePass(fetcher),new CatalogService(fetcher));
 await expect(shelf.get('US')).rejects.toThrow('recently added list');
});

it('does not turn a release date or a fetch time into an added timestamp',async()=>{
 const response:RecentGamePassShelf=await new HomeGamePassShelf(
  new RecentPcGamePass(fixture().fetcher),new CatalogService(fixture().fetcher)).get('US');
 expect(Object.keys(response).sort()).toEqual(['fetchedAt','market','products','source']);
 expect(response.products.every(product=>!('addedAt' in product))).toBe(true);
});
