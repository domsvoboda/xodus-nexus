import { expect, it, vi } from 'vitest';
import { ContentCatalog } from './content-catalog.js';
const BASE='9AAAAAAAAAAA', EDITION='9BBBBBBBBBBB', PASS='9CCCCCCCCCCC', DLC='9DDDDDDDDDDD', FOREIGN='9EEEEEEEEEEE';
const base = { storeId: BASE, name: 'Example.Base', related: [] as string[] };
const sku = (children: string[] = [], packages: object[] = []) => ({ Sku: { Properties: { IsTrial: false, IsPreOrder: false, Packages: packages, BundledSkus: children.map(BigId => ({ BigId })) } } });
const pkg = (extra = {}) => ({ ContentId:'01234567-89ab-cdef-0123-456789abcdef',PackageFormat:'MSIXVC',Architectures:['x64'],PackageFamilyName:'Example.Base_hash',PlatformDependencies:[{PlatformName:'Windows.Desktop'}],...extra });
const product = (ProductId: string, type = 'Durable', children: string[] = [], packages: object[] = []) => ({ ProductId,ProductType:type,LocalizedProperties:[{ProductTitle:ProductId}],DisplaySkuAvailabilities:[sku(children,packages)] });
function fixture(records = [
  { ...product(BASE,'Game',[],[pkg()]), MarketProperties:[{RelatedProducts:[{RelationshipType:'Bundle',RelatedProductId:EDITION}]}] },
  product(EDITION,'Game',[BASE,PASS]),
  { ...product(PASS,'Durable',[DLC]), MarketProperties:[{RelatedProducts:[{RelationshipType:'addOnParent',RelatedProductId:BASE}]}] },
  product(DLC,'Durable',[],[pkg({ PackageFamilyName:'Example.Dlc_hash', MainPackageFamilyNameForDlc:'Example.Base_hash' })]),
  product(FOREIGN,'Durable',[],[pkg({ MainPackageFamilyNameForDlc:'Foreign.Base_hash' })]),
]) {
  const fetcher = vi.fn(async (url: URL | RequestInfo) => {
    const ids = new URL(String(url)).searchParams.get('bigIds')!.split(',');
    return new Response(JSON.stringify({Products:records.filter(p=>ids.includes(p.ProductId))}));
  }) as unknown as typeof fetch;
  return {fetcher,catalog:new ContentCatalog(fetcher)};
}
it('finds real scoped season-pass children without manifest declarations or inferred ownership', async () => {
  const { catalog, fetcher } = fixture();
  const result = await catalog.discover(base, { [PASS]:'owned', [FOREIGN]:'other' }, 'DE');
  expect(result.related.sort()).toEqual([PASS,DLC].sort());
  expect(result.Products.map(p=>p.ProductId)).not.toContain(FOREIGN);
  expect(fetcher).toHaveBeenCalledTimes(2);
  for(const [url,options] of vi.mocked(fetcher).mock.calls){
    expect(new URL(String(url)).searchParams.get('market')).toBe('DE');
    expect(options?.headers).toBeUndefined(); expect(options?.redirect).toBe('error');
  }
});
it('permits genuine child license verification from an active bundle without marking its children owned',async()=>{
  const {catalog}=fixture();
  const result=await catalog.discover(base,{[EDITION]:'owned'},'US');
  expect(result.verify.sort()).toEqual([PASS,DLC].sort());
  expect((await catalog.discover(base,{},'US')).verify).toEqual([]);
});
it('finds an independently owned durable by its verified parent, not title similarity', async () => {
  const owned = { ...product(DLC), MarketProperties:[{RelatedProducts:[{RelationshipType:'addOnParent',RelatedProductId:BASE}]}] };
  const { catalog } = fixture([product(BASE,'Game',[],[pkg()]),owned,{...product(FOREIGN),LocalizedProperties:[{ProductTitle:'Example.Base DLC'}]}]);
  expect((await catalog.discover(base,{[DLC]:'owned',[FOREIGN]:'owned'},'US')).related).toEqual([DLC]);
});
it('uses saved edition metadata only as a discovery hint, not a license or foreign-game relationship', async () => {
  const { catalog } = fixture([product(BASE,'Game',[],[pkg()]),product(EDITION,'Game',[DLC,FOREIGN]),
    product(DLC,'Durable',[],[pkg({MainPackageFamilyNameForDlc:'Example.Base_hash'})]),product(FOREIGN)]);
  const result=await catalog.discover(base,{},'US',EDITION);
  expect(result.related).toEqual([DLC]); expect(result.Products.find(p=>p.ProductId===DLC)).toBeTruthy();
});
it('does not starve a later owned add-on behind multiple metadata batches', async () => {
  const rows=Array.from({length:125},(_,i)=>product(String(i).padStart(12,'0'),'Game'));
  const {catalog}=fixture([product(BASE,'Game',[],[pkg()]),...rows,product(DLC,'Durable',[],[pkg({MainPackageFamilyNameForDlc:'Example.Base_hash'})])]);
  expect((await catalog.discover(base,Object.fromEntries([...rows.map(p=>[p.ProductId,'gamepass'] as const),[DLC,'owned']]),'US')).related).toEqual([DLC]);
});
it('does not cache failures as a successful empty catalog, scopes cache to market and keeps public metadata account-independent',async()=>{
  let healthy=false;
  const fetcher=vi.fn(async()=>{if(!healthy)throw Error('network');return new Response(JSON.stringify({Products:[product(BASE,'Game')]}));});
  const catalog=new ContentCatalog(fetcher);
  await expect(catalog.discover(base,{},'US')).rejects.toThrow();healthy=true;
  await catalog.discover(base,{},'US');await catalog.discover(base,{},'US');
  expect(fetcher).toHaveBeenCalledTimes(2);await catalog.discover(base,{},'DE');expect(fetcher).toHaveBeenCalledTimes(3);
});
it('rejects unrequested, duplicate, oversized, invalid UTF-8 and failed metadata',async()=>{
  for(const response of [new Response(JSON.stringify({Products:[product(FOREIGN)]})),new Response(JSON.stringify({Products:[product(BASE),product(BASE)]})),
    new Response('x'.repeat(8_000_001)),new Response(new Uint8Array([0xff])),new Response('',{status:503})]){
    await expect(new ContentCatalog(async()=>response).discover(base,{},'US')).rejects.toThrow();
  }
});
it('bounds initial input and related graph without silently losing results',async()=>{
  const {catalog,fetcher}=fixture();
  await expect(catalog.discover(base,{'../../private':'owned'},'US')).rejects.toThrow('scope');expect(fetcher).not.toHaveBeenCalled();
  const nodes=Array.from({length:257},(_,i)=>String(i).padStart(12,'0'));
  const huge=fixture([product(BASE,'Game',nodes)]);
  await expect(huge.catalog.discover(base,{},'US')).rejects.toThrow('large');
});

it('honors a caller deadline even for cached metadata and aborts public network work',async()=>{
  const {catalog,fetcher}=fixture();await catalog.discover(base,{},'US');
  const beforeAbort=vi.mocked(fetcher).mock.calls.length;
  const controller=new AbortController();controller.abort();
  await expect(catalog.discover(base,{},'US',undefined,controller.signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(beforeAbort);
  const pending=vi.fn(async(_url:URL|RequestInfo,options?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
    options!.signal!.addEventListener('abort',()=>reject(options!.signal!.reason),{once:true});
  }));
  await expect(new ContentCatalog(pending as typeof fetch).discover(base,{},'US',undefined,AbortSignal.timeout(20))).rejects.toThrow();
  expect(pending).toHaveBeenCalledTimes(1);
});
