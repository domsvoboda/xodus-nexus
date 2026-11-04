import { afterEach,describe,expect,it,vi } from 'vitest';
import { CatalogService } from './catalog.js';

const image=(host:string,purpose='BoxArt')=>({ImagePurpose:purpose,Uri:`//${host}/image/${purpose.toLowerCase()}`});
const product=(titleId:string,images:unknown[],patch:Record<string,unknown>={})=>({
  ProductId:'9AAAAAAAAAAA',ProductType:'Game',
  AlternateIds:[{IdType:'XboxTitleId',Value:titleId}],
  LocalizedProperties:[{Images:images}],...patch,
});
const response=(products:unknown[])=>new Response(JSON.stringify({Products:products}),{status:200,headers:{'Content-Type':'application/json'}});
const lookupTitleId=(input:URL|RequestInfo)=>new URL(String(input)).searchParams.get('value')??'';
afterEach(()=>vi.useRealTimers());

describe('profile artwork from verified Store title IDs', () => {
  it('resolves a missing cover through the documented alternate-ID lookup', async () => {
    const fetcher=vi.fn(async (input:URL|RequestInfo)=>{
      const url=new URL(String(input));
      expect(url.origin+url.pathname).toBe('https://displaycatalog.mp.microsoft.com/v7.0/products/lookup');
      expect(url.searchParams.get('alternateId')).toBe('XboxTitleID');
      expect(url.searchParams.get('fieldsTemplate')).toBe('Details');
      return response([product(lookupTitleId(input),[
        image('store-images.s-microsoft.com','Logo'),
        image('store-images.s-microsoft.com','FeaturePromotionalSquareArt'),
        image('store-images.s-microsoft.com','BoxArt'),
      ])]);
    }) as unknown as typeof fetch;
    const artwork=await new CatalogService(fetcher).artworkForXboxTitleIds(['1842701288'],'cz');
    expect(artwork.get('1842701288')).toBe('https://store-images.s-microsoft.com/image/boxart');
    const url=new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get('market')).toBe('CZ');
  });

  it('requires the returned AlternateIds to contain exactly the requested title ID and a safe Game cover', async () => {
    const fetcher=(async (input:URL|RequestInfo)=>response([
      product('999',[image('store-images.s-microsoft.com')]),
      product(lookupTitleId(input),[image('tracker.example.test')]),
      product(lookupTitleId(input),[image('store-images.s-microsoft.com')],{ProductType:'Application'}),
      product(lookupTitleId(input),[image('store-images.s-microsoft.com','Logo')]),
    ])) as unknown as typeof fetch;
    const artwork=await new CatalogService(fetcher).artworkForXboxTitleIds(['123'],'US');
    expect(artwork.size).toBe(0);
  });

  it('accepts the Store image hosts already allowed by the launcher policy', async () => {
    for(const host of ['store-images.s-microsoft.com','store-images.microsoft.com']){
      const fetcher=(async ()=>response([product('123',[image(host)])])) as unknown as typeof fetch;
      expect((await new CatalogService(fetcher).artworkForXboxTitleIds(['123'],'US')).get('123')).toBe(`https://${host}/image/boxart`);
    }
  });

  it('coalesces concurrent and repeated snapshots and caches negative results', async () => {
    const fetcher=vi.fn(async (input:URL|RequestInfo)=>{
      const value=lookupTitleId(input);
      if(value==='404')return response([]);
      return response([product(value,[image('store-images.s-microsoft.com')])]);
    }) as unknown as typeof fetch;
    const catalog=new CatalogService(fetcher);
    const [first,second]=await Promise.all([catalog.artworkForXboxTitleIds(['123'],'US'),catalog.artworkForXboxTitleIds(['123'],'US')]);
    expect(first.get('123')).toBe('https://store-images.s-microsoft.com/image/boxart');
    expect(second.get('123')).toBe(first.get('123'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await catalog.artworkForXboxTitleIds(['123'],'US');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await catalog.artworkForXboxTitleIds(['404'],'US')).size).toBe(0);
    await catalog.artworkForXboxTitleIds(['404'],'US');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('is optional and bounded: invalid IDs make no request, offline lookup cannot reject the profile, and one call stays within its budget', async () => {
    const offline=vi.fn(async ()=>{throw Error('offline');}) as unknown as typeof fetch;
    const empty=await new CatalogService(offline).artworkForXboxTitleIds(['','0','4294967296','abc','12/../'],'US');
    expect(empty.size).toBe(0);
    expect(offline).not.toHaveBeenCalled();
    expect((await new CatalogService(offline).artworkForXboxTitleIds(['123'],'US')).size).toBe(0);
    expect(offline).toHaveBeenCalledOnce();

    const ids=Array.from({length:30},(_,index)=>String(index+1));
    const fetcher=vi.fn(async (input:URL|RequestInfo)=>response([product(lookupTitleId(input),[image('store-images.s-microsoft.com')])])) as unknown as typeof fetch;
    const artwork=await new CatalogService(fetcher).artworkForXboxTitleIds(ids,'US');
    expect(fetcher).toHaveBeenCalledTimes(24);
    expect(artwork.size).toBe(24);
    expect([...artwork.keys()]).toEqual(ids.slice(0,24));
  });

  it('keeps every coalesced joiner inside its own deadline without cancelling shared work', async () => {
    vi.useFakeTimers();vi.setSystemTime(0);
    const calls:{id:string;start:number}[]=[];
    const fetcher=vi.fn((input:URL|RequestInfo)=>{
      const id=lookupTitleId(input);
      calls.push({id,start:Date.now()});
      return new Promise<Response>(resolve=>setTimeout(()=>resolve(response([product(id,[image('store-images.s-microsoft.com')])])),Number(id)<=4?5900:5000));
    }) as unknown as typeof fetch;
    const catalog=new CatalogService(fetcher);
    let firstEnded=-1;
    const first=catalog.artworkForXboxTitleIds(['1','2','3','4','5','6','7','8'],'US').then(value=>{firstEnded=Date.now();return value;});
    await vi.advanceTimersByTimeAsync(5800);
    const second=catalog.artworkForXboxTitleIds(['5','6','7','8'],'US');
    await vi.advanceTimersByTimeAsync(5000);
    const [a,b]=await Promise.all([first,second]);
    expect(calls).toHaveLength(8);
    expect(firstEnded).toBeLessThanOrEqual(8000);
    expect([...a.keys()].sort()).toEqual(['1','2','3','4']);
    expect([...b.keys()].sort()).toEqual(['5','6','7','8']);
    await catalog.artworkForXboxTitleIds(['1','2','3','4','5','6','7','8'],'US');
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it('handles a late shared failure after the caller expired and keeps shared cleanup usable', async () => {
    vi.useFakeTimers();vi.setSystemTime(0);
    const unhandled=vi.fn();
    process.on('unhandledRejection',unhandled);
    try{
      const fetcher=vi.fn((input:URL|RequestInfo)=>{
        const id=lookupTitleId(input);
        if(fetcher.mock.calls.length===1)return new Promise<Response>((_resolve,reject)=>setTimeout(()=>reject(Error('late failure')),9000));
        return Promise.resolve(response([product(id,[image('store-images.s-microsoft.com')])]));
      }) as unknown as typeof fetch;
      const catalog=new CatalogService(fetcher);
      const first=catalog.artworkForXboxTitleIds(['5'],'US');
      await vi.advanceTimersByTimeAsync(8000);
      expect(await first).toEqual(new Map());
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.resolve();await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
      const second=await catalog.artworkForXboxTitleIds(['5'],'US');
      expect(second.get('5')).toBe('https://store-images.s-microsoft.com/image/boxart');
      expect(fetcher).toHaveBeenCalledTimes(2);
    }finally{process.off('unhandledRejection',unhandled);}
  });
});
