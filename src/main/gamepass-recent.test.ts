import {expect,it,vi} from 'vitest';
import {parseRecentPcGames,RecentPcGamePass} from './gamepass-recent.js';
const metadata={siglId:'06323672-b8c8-43cc-b0de-32d5a9834749',requiresShuffling:'False',title:'Recently added'};
const ids=['9AAAAAAAAAAA','9BBBBBBBBBBB'];
const fixture=()=>[metadata,...ids.map(id=>({id}))];
it('preserves the official PC collection order without interpreting dates or granting ownership',()=>{
 expect(parseRecentPcGames(fixture())).toEqual(ids);expect(parseRecentPcGames([metadata])).toEqual([]);
 for(const value of [null,{},[],[{}],[{...metadata,siglId:'foreign'}],[{...metadata,requiresShuffling:'True'}],
   [metadata,{id:'not-a-product'}],[metadata,{id:ids[0]},{id:ids[0]}],[metadata,...Array.from({length:1001},(_,i)=>({id:`9${String(i).padStart(11,'0')}`}))]])
  expect(()=>parseRecentPcGames(value)).toThrow('recently added list');
});
it('uses only the official anonymous PC endpoint and caches/clones per market after completion',async()=>{
 let now=0;const fetcher=vi.fn(async(input:URL|RequestInfo,options?:RequestInit)=>{
  const url=new URL(String(input));expect(url.origin+url.pathname).toBe('https://catalog.gamepass.com/sigls/v3');
  expect(Object.fromEntries(url.searchParams)).toEqual({id:metadata.siglId,language:'en-US',market:fetcher.mock.calls.length===2?'CZ':'US',platformContext:'pc',subscriptionContext:'cfq7ttc0kgq8'});
  expect(options?.headers).toEqual({Accept:'application/json'});expect(options?.redirect).toBe('error');
  return new Response(JSON.stringify(fixture()));
 }) as unknown as typeof fetch;
 const recent=new RecentPcGamePass(fetcher,()=>now);
 const [a,b]=await Promise.all([recent.get('US'),recent.get('US')]);a.reverse();expect(b).toEqual(ids);expect(fetcher).toHaveBeenCalledOnce();
 expect(await recent.get('CZ')).toEqual(ids);expect(fetcher).toHaveBeenCalledTimes(2);
 now=10*60_000;expect(await recent.get('US')).toEqual(ids);expect(fetcher).toHaveBeenCalledTimes(3);
 await expect(recent.get('not a market')).rejects.toThrow('market');expect(fetcher).toHaveBeenCalledTimes(3);
});
it.each(['http','announced-size','stream-size','json','shape','network'])('does not cache or expose a failing %s response',async mode=>{
 let fail=true;const fetcher=vi.fn(async()=>{
  if(!fail)return new Response(JSON.stringify(fixture()));
  if(mode==='network')throw Error('PRIVATE_RESPONSE_TOKEN');
  if(mode==='http')return new Response('PRIVATE_RESPONSE_TOKEN',{status:403});
  if(mode==='announced-size')return new Response('PRIVATE_RESPONSE_TOKEN',{headers:{'Content-Length':'999999'}});
  if(mode==='stream-size')return new Response('x'.repeat(256*1024+1));
  if(mode==='json')return new Response('PRIVATE_RESPONSE_TOKEN');
  return new Response(JSON.stringify([{private:'PRIVATE_RESPONSE_TOKEN'}]));
 }) as unknown as typeof fetch;
 const recent=new RecentPcGamePass(fetcher);await expect(recent.get('US')).rejects.toThrow('recently added list');
 fail=false;expect(await recent.get('US')).toEqual(ids);expect(fetcher).toHaveBeenCalledTimes(2);
});
