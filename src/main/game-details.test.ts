import { expect, it, vi } from 'vitest';
import { CatalogService } from './catalog';
const ID='ABCDEFGHIJKL';
const response=()=>({ Products:[{ ProductId:ID,ProductType:'Game',LocalizedProperties:[{ProductTitle:'Sample Game',ProductDescription:'<script>literal text</script>',PublisherName:'Example',Images:[null,{ImagePurpose:'BoxArt',Uri:'//store-images.s-microsoft.com/box'},{ImagePurpose:'Hero',Uri:'https://store-images.s-microsoft.com/hero'},{ImagePurpose:'Screenshot',Uri:'//store-images.s-microsoft.com/one'},{ImagePurpose:'Screenshot',Uri:'https://store-images.s-microsoft.com/one'},{ImagePurpose:'Screenshot',Uri:'https://evil.test/image'},{ImagePurpose:'Screenshot',Uri:'file:///etc/passwd'}]}],Properties:{Categories:['Strategy','Card & board',null]},MarketProperties:[{OriginalReleaseDate:'2024-02-20T00:00:00Z'}]}] });
it('reads catalog metadata without pretending package support or ownership, filtering and deduplicating gallery images',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify(response()))); const catalog=new CatalogService(fetcher as typeof fetch);
  const details=await catalog.gameDetails(ID,'US');
  expect(details).toMatchObject({title:'Sample Game',description:'<script>literal text</script>',categories:['Strategy','Card & board'],screenshots:['https://store-images.s-microsoft.com/one'],heroUrl:'https://store-images.s-microsoft.com/hero'});
  expect(details).not.toHaveProperty('installability');
  details!.screenshots.push('changed'); expect((await catalog.gameDetails(ID,'US'))!.screenshots).toHaveLength(1); expect(fetcher).toHaveBeenCalledTimes(1);
  await catalog.gameDetails(ID,'CZ'); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('fails honestly when metadata is missing and rejects malformed IDs before a request',async()=>{
  const fetcher=vi.fn(async()=>new Response('{"Products":[]}')); const catalog=new CatalogService(fetcher as typeof fetch);
  await expect(catalog.gameDetails('../bad','US')).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  expect(await catalog.gameDetails(ID,'US')).toBeUndefined();
});

it('coalesces the metadata, activity and achievement lookup and retains the exact Xbox title mapping',async()=>{
 let release!:(value:Response)=>void;
 const fetcher=vi.fn(()=>new Promise<Response>(resolve=>release=resolve)),catalog=new CatalogService(fetcher as typeof fetch);
 const pending=[catalog.gameDetails(ID,'US'),catalog.gameDetails(ID,'US'),catalog.gameDetails(ID,'US')];
 const data=response();Object.assign(data.Products[0],{AlternateIds:[{IdType:'XboxTitleId',Value:'1877522801'}]});
 release(new Response(JSON.stringify(data)));
 const [a,b,c]=await Promise.all(pending);expect(fetcher).toHaveBeenCalledOnce();expect(a?.xboxTitleId).toBe('1877522801');expect(b).toEqual(a);expect(c).toEqual(a);
 a!.screenshots.length=0;expect(b!.screenshots).toHaveLength(1);
});

it('clears failed pending lookups so an explicit reopen can retry',async()=>{
 const fetcher=vi.fn().mockRejectedValueOnce(Error('network')).mockResolvedValueOnce(new Response(JSON.stringify(response()))),catalog=new CatalogService(fetcher as typeof fetch);
 await expect(catalog.gameDetails(ID,'US')).rejects.toThrow();expect((await catalog.gameDetails(ID,'US'))?.title).toBe('Sample Game');
});

it('reports malformed metadata honestly instead of treating a network/schema failure as a missing game',async()=>{
 const catalog=new CatalogService(vi.fn(async()=>new Response('{}')) as typeof fetch);
 await expect(catalog.gameDetails(ID,'US')).rejects.toThrow('Invalid catalog response');
});

it('bounds simultaneous product lookups and frees slots after completion',async()=>{
 const releases:((value:Response)=>void)[]=[];
 const catalog=new CatalogService(vi.fn(()=>new Promise<Response>(resolve=>releases.push(resolve))) as typeof fetch);
 const pending=Array.from({length:8},(_,i)=>catalog.gameDetails('9'+String(i).padStart(11,'0'),'US'));
 await expect(catalog.gameDetails('9AAAAAAAAAAA','US')).rejects.toThrow('Too many');
 releases.forEach(done=>done(new Response('{"Products":[]}')));await Promise.all(pending);
 const next=catalog.gameDetails('9AAAAAAAAAAA','US');releases.at(-1)!(new Response('{"Products":[]}'));expect(await next).toBeUndefined();
});
