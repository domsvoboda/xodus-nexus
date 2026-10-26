import { describe,expect,it,vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { XboxSocial } from './xbox-social.js';
import type { SocialRequest } from '../shared/social.js';
const identity={account:'synthetic@example.test',binary:'/fixture/backend'};
const friend={xuid:'42',gamertag:'Example',presence:'unknown'};
const output=(result:unknown,account=identity.account)=>JSON.stringify({schema:1,account,result});
describe('explicit account-bound Xbox friends/chat',()=>{
  it('reopens from bounded memory without refetching and expires before automatic refresh',async()=>{
    vi.useFakeTimers();
    try{
      const read=vi.fn(async()=>output({friends:[friend]})),social=new XboxSocial(()=>identity,read);
      const first=await social.friends();social.close(true);first[0].gamertag='Changed by caller';
      expect((await social.friends())[0].gamertag).toBe('Example');expect(read).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(45_000);await social.friends();expect(read).toHaveBeenCalledTimes(2);
      social.close();await social.friends();expect(read).toHaveBeenCalledTimes(3);
    }finally{vi.useRealTimers();}
  });
  it('never reuses cached reads for another account or backend',async()=>{
    let current=identity;
    const read=vi.fn(async()=>output({friends:[friend]},current.account)),social=new XboxSocial(()=>current,read);
    await social.friends();current={...identity,account:'other'};await social.friends();
    current={...current,binary:'/other/backend'};await social.friends();expect(read).toHaveBeenCalledTimes(3);
  });
  it('invalidates cached conversation even when sending fails without acknowledgement',async()=>{
    const read=vi.fn(async(_binary:string,request:SocialRequest)=>{
      if(request.op==='send')throw Error('synthetic uncertain send');
      return output({xuid:'42',messages:[],hasMore:false});
    });
    const social=new XboxSocial(()=>identity,read);
    await social.conversation('42');await social.conversation('42');expect(read).toHaveBeenCalledOnce();
    await expect(social.send('42','hello')).rejects.toThrow();await social.conversation('42');expect(read).toHaveBeenCalledTimes(3);
  });
  it.each([false,true])('does not cache an older read that completes during a send (failed=%s)',async failed=>{
    const pending:{request:SocialRequest;resolve:(value:string)=>void;reject:(error:Error)=>void}[]=[];
    const read=vi.fn((_binary:string,request:SocialRequest)=>new Promise<string>((resolve,reject)=>pending.push({request,resolve,reject})));
    const social=new XboxSocial(()=>identity,read),empty={xuid:'42',messages:[],hasMore:false};
    const old=social.conversation('42'),sent=social.send('42','hello');
    const sendResult=failed?expect(sent).rejects.toThrow():expect(sent).resolves.toEqual({messageId:'receipt'});
    pending[0].resolve(output(empty));await old;
    if(failed)pending[1].reject(Error('synthetic ambiguous send'));else pending[1].resolve(output({sent:true,messageId:'receipt'}));
    await sendResult;
    const fresh=social.conversation('42');
    expect(read).toHaveBeenCalledTimes(3);
    pending[2].resolve(output(empty));await fresh;await social.settled();
    expect(pending.filter(job=>job.request.op==='send')).toHaveLength(1);
  });
  it('waits out invalidated pre-send reads instead of coalescing post-send reconciliation with them',async()=>{
    const pending:{request:SocialRequest;resolve:(value:string)=>void}[]=[];
    const read=vi.fn((_binary:string,request:SocialRequest)=>new Promise<string>(resolve=>pending.push({request,resolve})));
    const social=new XboxSocial(()=>identity,read),empty={xuid:'42',messages:[],hasMore:false};
    const old=social.conversation('42'),sent=social.send('42','hello');
    pending[1].resolve(output({sent:true,messageId:'receipt'}));await sent;
    const fresh=social.conversation('42');expect(fresh).not.toBe(old);expect(read).toHaveBeenCalledTimes(2);
    pending[0].resolve(output(empty));await old;await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(3);
    pending[2].resolve(output({...empty,messages:[{id:'receipt',sender:'43',at:'2026-10-26T00:00:00Z',text:'hello',hidden:false}]}));
    expect((await fresh).messages[0].id).toBe('receipt');await social.settled();
    expect(pending.filter(job=>job.request.op==='send')).toHaveLength(1);
  });
  it('does not start a deferred post-send read after its surface closes',async()=>{
    const pending:{request:SocialRequest;resolve:(value:string)=>void}[]=[];
    const read=vi.fn((_binary:string,request:SocialRequest)=>new Promise<string>(resolve=>pending.push({request,resolve})));
    const social=new XboxSocial(()=>identity,read),empty={xuid:'42',messages:[],hasMore:false};
    const old=social.conversation('42'),oldResult=expect(old).rejects.toThrow('cancelled'),sent=social.send('42','hello');
    pending[1].resolve(output({sent:true,messageId:'receipt'}));await sent;
    const fresh=social.conversation('42'),freshResult=expect(fresh).rejects.toThrow();social.close();
    pending[0].resolve(output(empty));await oldResult;await freshResult;await social.settled();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('invalidates reads started while a send is in flight, without evicting the friends cache',async()=>{
    const pending:{request:SocialRequest;resolve:(value:string)=>void}[]=[];
    const read=vi.fn((_binary:string,request:SocialRequest)=>new Promise<string>(resolve=>pending.push({request,resolve})));
    const social=new XboxSocial(()=>identity,read),empty={xuid:'42',messages:[],hasMore:false};
    const friends=social.friends();pending[0].resolve(output({friends:[friend]}));await friends;
    const sent=social.send('42','hello'),old=social.conversation('42');
    pending[1].resolve(output({sent:true,messageId:'receipt'}));await sent;
    const fresh=social.conversation('42');pending[2].resolve(output(empty));await old;await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(4);pending[3].resolve(output(empty));await fresh;
    expect((await social.friends())[0].xuid).toBe('42');expect(read).toHaveBeenCalledTimes(4);await social.settled();
  });
  it('does not restart a deferred old-account read after the signed-in account changes',async()=>{
    let current=identity;
    const pending:{request:SocialRequest;resolve:(value:string)=>void}[]=[];
    const read=vi.fn((_binary:string,request:SocialRequest)=>new Promise<string>(resolve=>pending.push({request,resolve})));
    const social=new XboxSocial(()=>current,read),empty={xuid:'42',messages:[],hasMore:false};
    const old=social.conversation('42'),sent=social.send('42','hello');
    pending[1].resolve(output({sent:true,messageId:'receipt'}));await sent;
    const fresh=social.conversation('42'),freshResult=expect(fresh).rejects.toThrow('changed');
    const oldResult=expect(old).rejects.toThrow('changed');current={...identity,account:'different-account'};
    pending[0].resolve(output(empty));await oldResult;await freshResult;await social.settled();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('does not call anything at construction or without a supported signed-in account',async()=>{
    const read=vi.fn();const social=new XboxSocial(()=>undefined,read);expect(read).not.toHaveBeenCalled();
    await expect(social.friends()).rejects.toThrow('Sign in');expect(read).not.toHaveBeenCalled();
  });
  it('coalesces overlapping reads and never caches friends or messages on disk',async()=>{
    let finish!:(v:string)=>void;
    const read=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));const social=new XboxSocial(()=>identity,read);
    const first=social.friends(),second=social.friends();expect(first).toBe(second);expect(read).toHaveBeenCalledOnce();
    finish(output({friends:[friend]}));expect(await first).toEqual([{...friend,activity:undefined}]);await second;expect(social.busy).toBe(false);
  });
  it('rejects stale account/backend results, including switch-away-and-back',async()=>{
    let current=identity,finish!:(v:string)=>void;const read=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));
    const social=new XboxSocial(()=>current,read);const pending=social.friends();current={...identity,account:'other'};
    finish(output({friends:[friend]}));await expect(pending).rejects.toThrow('changed');
    current=identity;const next=social.friends();social.close();current={...identity};finish(output({friends:[friend]}));await expect(next).rejects.toThrow('cancelled');await social.settled();
  });
  it.each([output({friends:[]},'wrong'),'{bad',output({friends:[{...friend,xuid:'../escape'}]}),'x'.repeat(2*1024*1024+1)])('rejects malformed data without publishing payloads',async raw=>{
    const social=new XboxSocial(()=>identity,async()=>raw);await expect(social.friends()).rejects.toThrow(/response/);
  });
  it('validates input before the backend and sends only once while awaiting acknowledgement',async()=>{
    let finish!:(v:string)=>void;const read=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));const social=new XboxSocial(()=>identity,read);
    await expect(social.send('../bad','hello')).rejects.toThrow();await expect(social.send('42','x'.repeat(257))).rejects.toThrow();expect(read).not.toHaveBeenCalled();
    const first=social.send('42','hello');await expect(social.send('42','hello')).rejects.toThrow('already');
    finish(output({sent:true,messageId:'receipt'}));expect(await first).toEqual({messageId:'receipt'});expect(read).toHaveBeenCalledOnce();expect(read.mock.calls[0][1]).toEqual({op:'send',xuid:'42',text:'hello'});
  });
  it('never exposes arbitrary transport errors or retries an ambiguous send',async()=>{
    const read=vi.fn(async()=>{throw Error('Invalid Xbox response. PRIVATE_TOKEN');});const social=new XboxSocial(()=>identity,read);
    await expect(social.send('42','hello')).rejects.toThrow('unavailable');expect(read).toHaveBeenCalledOnce();
  });
  it('does not salvage a receipt from diagnostic-prefixed stdout or fabricate send confirmation',async()=>{
    const diagnostic='Identified Title endpoint=SYNTHETIC for URL=https://fixture.invalid/';
    const read=vi.fn(async()=>diagnostic+'\n'+output({sent:true,messageId:'receipt'}));
    const social=new XboxSocial(()=>identity,read);
    await expect(social.send('42','hello')).rejects.toThrow('Invalid Xbox response.');
    expect(read).toHaveBeenCalledOnce();await social.settled();
  });
  it('does not treat an old boolean acknowledgement as confirmed history or retry it',async()=>{
    const read=vi.fn(async()=>output({sent:true})),social=new XboxSocial(()=>identity,read);
    await expect(social.send('42','hello')).rejects.toThrow('could not be confirmed');
    expect(read).toHaveBeenCalledOnce();
  });
  it('keeps a cancelled operation in shutdown draining until its child finishes',async()=>{
    let finish!:(v:string)=>void;const social=new XboxSocial(()=>identity,()=>new Promise(resolve=>{finish=resolve;}));
    const first=social.friends();social.close();expect(social.busy).toBe(true);const drained=social.settled();finish(output({friends:[]}));
    await expect(first).rejects.toThrow('cancelled');await drained;expect(social.busy).toBe(false);
  });
  it('uses a real synthetic subprocess with private stdin, no message or account in argv',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-social-cli-'));
    try{
      const binary=path.join(root,'xodus-cli'),capture=path.join(root,'request.json');
      const source=`#!${process.execPath}\nlet raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const request=JSON.parse(raw);require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),request}));console.log(JSON.stringify({schema:1,account:${JSON.stringify(identity.account)},result:{sent:true,messageId:'synthetic'}}));});\n`;
      await fs.writeFile(binary,source,{mode:0o700});const social=new XboxSocial(()=>({...identity,binary}));
      await social.send('42','TEST_ONLY_message');
      const captured=JSON.parse(await fs.readFile(capture,'utf8'));expect(captured.args).toEqual(['social','--json']);
      expect(captured.request).toEqual({op:'send',xuid:'42',text:'TEST_ONLY_message'});
      await social.settled();
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });
});
