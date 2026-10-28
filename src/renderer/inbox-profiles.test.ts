import {expect,it,vi} from 'vitest';
import {InboxProfiles} from './inbox-profiles';
it('enriches at most twelve profiles, two at a time, without blocking the inbox',async()=>{
 let active=0,peak=0;const ready=vi.fn();
 const load=vi.fn(async(id:string)=>{active++;peak=Math.max(peak,active);await Promise.resolve();active--;return{xuid:id,gamertag:'Fixture',gamerscore:null};});
 await new InboxProfiles(load,ready).start(Array.from({length:100},(_,i)=>String(i+1)));
 expect(load).toHaveBeenCalledTimes(12);expect(peak).toBe(2);expect(ready).toHaveBeenCalledTimes(12);
});
it('discards late profiles and schedules no more after closing or changing account',async()=>{
 const pending:((value:any)=>void)[]=[];const load=vi.fn(()=>new Promise<any>(resolve=>pending.push(resolve))),ready=vi.fn();
 const profiles=new InboxProfiles(load,ready),job=profiles.start(['1','2','3']);expect(load).toHaveBeenCalledTimes(2);profiles.stop();pending[0]({xuid:'1'});pending[1]({xuid:'2'});await job;
 expect(load).toHaveBeenCalledTimes(2);expect(ready).not.toHaveBeenCalled();
});
it('optional failures or a mismatched identity cannot replace names or break the list',async()=>{
 const ready=vi.fn(),load=vi.fn(async(id:string)=>{if(id==='1')throw Error('Fixture offline');return{xuid:'other',gamertag:'Wrong',gamerscore:null};});
 await new InboxProfiles(load,ready).start(['1','2']);expect(ready).not.toHaveBeenCalled();
});
