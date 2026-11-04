import {expect,it} from 'vitest';
import {CatalogService} from './catalog';
import {catalogDetailMarket,PUBLIC_STORE_MARKET,publicStoreMarket} from './public-store-market';

it('selects one stable public browse market that never depends on the OS locale',()=>{
 expect(PUBLIC_STORE_MARKET).toBe('US');
 expect(publicStoreMarket()).toBe('US');
 expect(publicStoreMarket()).toMatch(/^[A-Z]{2}$/);
 // Read-only public Store metadata always uses the public browse market.
 expect(catalogDetailMarket('public-store','CZ')).toBe('US');
 expect(catalogDetailMarket('public-store','DE')).toBe('US');
 expect(catalogDetailMarket('public-store','US')).toBe('US');
 // An unscoped identity, including an uninstalled Library product, keeps the
 // actual configured/effective account region.
 expect(catalogDetailMarket(undefined,'CZ')).toBe('CZ');
 expect(catalogDetailMarket(undefined,'DE')).toBe('DE');
 expect(catalogDetailMarket(undefined,'US')).toBe('US');
});

const paid = {Sku:{SkuType:'full',Properties:{}},Availabilities:[{OrderManagementData:{Price:{MSRP:29.99,ListPrice:29.99}}}]};
const free = {Sku:{SkuType:'full',Properties:{}},Availabilities:[{OrderManagementData:{Price:{MSRP:0,ListPrice:0}}}]};
const trial = {Sku:{SkuType:'trial',Properties:{IsTrial:true}},Availabilities:[{OrderManagementData:{Price:{MSRP:0,ListPrice:0}}}]};
const row = (productId:string,title:string,price:number)=>({productId,title,isGame:true,priceInfo:{msrp:price,price,displayPrice:price>0?`$${price}`:'Free'}});
const detail = (productId:string,skus:unknown[])=>({ProductId:productId,ProductType:'Game',DisplaySkuAvailabilities:skus});

function fixture(){
 const requests:string[]=[];
 const fetcher=(async(input:URL|RequestInfo)=>{
  const url=new URL(String(input)); requests.push(url.pathname+url.search);
  const payload=url.pathname.includes('/api/products/search')
   ? {productsList:[row('9PAIDGAME001','Paid Game',29.99),row('9FREEGAME001','Free Game',0),row('9TRIALGAME01','Trial Only',0)],hasMorePages:false}
   : url.pathname.includes('GetComputedProductsList')
   ? {title:'Top paid games',hasMorePages:false,productsList:[row('9PAIDGAME001','Paid Game',29.99)]}
   : {Products:[detail('9PAIDGAME001',[paid]),detail('9FREEGAME001',[free]),detail('9TRIALGAME01',[trial])]};
  return new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}});
 }) as typeof fetch;
 return {service:new CatalogService(fetcher),requests};
}

it('requests the neutral English US Store catalog and reuses one cache entry',async()=>{
 const f=fixture();
 const [first,second,third]=await Promise.all([
  f.service.search('gears',publicStoreMarket()),f.service.search('gears',publicStoreMarket()),f.service.search('gears',publicStoreMarket()),
 ]);
 expect(first.market).toBe('US');
 expect(second).toEqual(first);expect(third).toEqual(first);
 const search=f.requests.filter(url=>url.includes('/api/products/search'));
 expect(search).toHaveLength(1);
 const params=new URL(`https://store${search[0]}`).searchParams;
 expect(params.get('gl')).toBe('US');
 expect(params.get('hl')).toBe('en-us');
 const details=f.requests.filter(url=>url.includes('/v7.0/products'));
 expect(details).toHaveLength(1);
 const detailParams=new URL(`https://store${details[0]}`).searchParams;
 expect(detailParams.get('market')).toBe('US');
 expect(detailParams.get('languages')).toBe('en-us,neutral');
});

it('keeps the paid-only public policy inside the neutral US browse path',async()=>{
 const f=fixture();
 const result=await f.service.search('games',publicStoreMarket());
 expect(result.products.map(product=>product.title)).toEqual(['Paid Game']);
 expect(result.products.some(product=>['Free Game','Trial Only'].includes(product.title))).toBe(false);
 const featured=await f.service.featured(publicStoreMarket());
 expect(featured.market).toBe('US');
 expect(featured.products.map(product=>product.title)).toEqual(['Paid Game']);
});
